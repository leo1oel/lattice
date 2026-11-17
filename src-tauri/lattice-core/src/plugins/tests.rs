//! The host end to end: a test plugin written in JavaScript, run by a real
//! Node inside the real sandbox (macOS), and the store's install paths.

use super::broker::tests::MemorySecrets;
use super::*;
use crate::test_support::TempDir;
use serde_json::{json, Value};
use std::sync::Mutex;

/// A plugin whose commands each exercise one part of the host.
const PLUGIN_JS: &str = r#"
const fs = require('fs');
const net = require('net');
let nextId = 100;
const pending = new Map();
function send(m) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); }
function call(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
function reply(id, result) { send({ id, result }); }
function message(id, markdown) { reply(id, { kind: 'message', markdown }); }
async function run(id, { command, input, context }) {
  switch (command) {
    case 'echo': {
      send({ method: 'progress', params: { message: 'Reading', fraction: 0.5 } });
      const bib = await call('bibliography/entries', {});
      const keys = (bib.result?.files ?? []).flatMap((f) => f.entries.map((e) => e.key));
      return reply(id, { kind: 'items', summary: 'echo', items: [{ id: 'ctx', title: JSON.stringify({ input, context, keys }) }] });
    }
    case 'read': {
      try { fs.readFileSync(input); return message(id, 'READ'); } catch (e) { return message(id, e.code); }
    }
    case 'write': {
      try { fs.writeFileSync(input, 'x'); return message(id, 'WROTE'); } catch (e) { return message(id, e.code); }
    }
    case 'env': return message(id, Object.keys(process.env).sort().join(','));
    case 'net': {
      const socket = net.connect(Number(input), '127.0.0.1');
      socket.on('connect', () => { socket.destroy(); message(id, 'CONNECTED'); });
      socket.on('error', (e) => message(id, e.code));
      return;
    }
    case 'secret': {
      const r = await call('secrets/get', { name: input });
      return message(id, r.error ? 'DENIED ' + r.error.code + ' ' + r.error.data.permission : 'VALUE ' + r.result.value);
    }
    case 'hang': return;
    case 'crash': process.stderr.write('boom\n'); process.exit(3);
    case 'fail': return send({ id, error: { code: -32000, message: 'Zotero is not running' } });
    case 'noise': process.stdout.write('hello world\n'); return;
  }
}
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') reply(m.id, { apiLevel: 1 });
    else if (m.method === 'command/run') run(m.id, m.params);
    else if (m.method === '$/cancelRequest') send({ id: m.params.id, error: { code: -32800, message: 'cancelled' } });
    else if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
"#;

const COMMANDS: &[&str] =
    &["echo", "read", "write", "env", "net", "secret", "hang", "crash", "fail", "noise"];

fn manifest(permissions: &str) -> String {
    let commands: String = COMMANDS
        .iter()
        .map(|c| format!("\n[[commands]]\nid = \"{c}\"\ntitle = \"{c}\"\n"))
        .collect();
    format!(
        "schema = 1\nid = \"dev.lattice.test\"\nname = \"Test\"\nversion = \"1.0.0\"\napi = 1\nlicense = \"MIT\"\nruntime = \"node\"\nmain = \"main.js\"\n\n[permissions]\n{permissions}\n{commands}"
    )
}

struct Fixture {
    _root: TempDir,
    plugin_dir: PathBuf,
    project: crate::project::test_support::Fixture,
    host: PluginHost,
}

/// A Node to run the test plugin with, and the folders it needs to read. The
/// app ships a standalone Node; a developer's Homebrew Node links libraries
/// from the Homebrew prefix, which the test grants as the runtime's reads.
fn test_node() -> Option<(PathBuf, Vec<PathBuf>)> {
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../synara-runtime/bin/node");
    let found = std::env::var_os("LATTICE_PLUGIN_TEST_NODE")
        .map(PathBuf::from)
        .or_else(|| bundled.is_file().then_some(bundled))
        .or_else(|| {
            std::env::split_paths(&std::env::var_os("PATH")?)
                .map(|d| d.join("node"))
                .find(|p| p.is_file())
        })?
        .canonicalize()
        .ok()?;
    let prefix = found.parent()?.parent()?.to_path_buf();
    let reads = [prefix, PathBuf::from("/opt/homebrew"), PathBuf::from("/usr/local")]
        .into_iter()
        .filter(|p| p.exists())
        .collect();
    Some((found, reads))
}

fn fixture(permissions: &str) -> Option<Fixture> {
    let Some((node, reads)) = test_node() else {
        eprintln!("skipped: no node on PATH");
        return None;
    };
    let root = TempDir::new("plugins-host");
    let plugin_dir = root.join("plugin");
    root.write("plugin/main.js", PLUGIN_JS);
    root.write("plugin/lattice-plugin.toml", manifest(permissions));
    let project = crate::project::test_support::Fixture::project("plugins-project");
    project.write(
        "main.tex",
        "\\documentclass{article}\\begin{document}\\cite{knuth84}\\end{document}",
    );
    project.write("refs.bib", "@book{knuth84, title = {Literate Programming}}\n");
    let host =
        PluginHost::with(root.join("store"), node, reads, Box::new(MemorySecrets::default()));
    host.install_folder(&plugin_dir).unwrap();
    host.set_enabled("dev.lattice.test", true).unwrap();
    Some(Fixture { _root: root, plugin_dir, project, host })
}

fn request(f: &Fixture, command: &str, input: Option<&str>) -> RunRequest {
    RunRequest {
        plugin_id: "dev.lattice.test".into(),
        command_id: command.into(),
        input: input.map(str::to_string),
        project: Some(ProjectInput {
            root: f.project.root.clone(),
            name: "Paper".into(),
            main_document: Some("main.tex".into()),
            active_file: Some("/etc/passwd".into()),
            selection: None,
            cursor: None,
        }),
        locale: "en".into(),
    }
}

fn run(f: &Fixture, command: &str, input: Option<&str>) -> Result<CommandResult, PluginError> {
    let events = Mutex::new(Vec::new());
    let sink = |e: RunEvent| -> Result<(), crate::host::Closed> {
        events.lock().unwrap().push(e);
        Ok(())
    };
    f.host.run(request(f, command, input), &sink, &CancelToken::new())
}

fn markdown(result: Result<CommandResult, PluginError>) -> String {
    match result {
        Ok(CommandResult::Message { markdown, .. }) => markdown,
        other => panic!("expected a message, got {other:?}"),
    }
}

#[cfg(target_os = "macos")]
mod sandboxed {
    use super::*;

    const ALL: &str = "project-read = [\"context\", \"bibliography\"]";

    #[test]
    fn a_command_gets_its_context_and_the_bibliography() {
        let Some(f) = fixture(ALL) else { return };
        let Ok(CommandResult::Items { items, summary }) = run(&f, "echo", Some("knuth")) else {
            panic!("items")
        };
        assert_eq!(summary.as_deref(), Some("echo"));
        let echoed: Value = serde_json::from_str(&items[0].title).unwrap();
        assert_eq!(echoed["input"], "knuth");
        assert!(echoed["keys"].as_array().unwrap().contains(&json!("knuth84")));
        assert_eq!(echoed["context"]["project"]["mainDocument"], "main.tex");
        assert!(echoed["context"]["project"]["bibliographies"]
            .as_array()
            .unwrap()
            .contains(&json!("refs.bib")));
        assert!(
            echoed["context"]["project"].get("activeFile").is_none(),
            "an absolute path reached the plugin"
        );
    }

    #[test]
    fn without_project_read_the_plugin_sees_only_the_project_name() {
        let Some(f) = fixture("") else { return };
        let Ok(CommandResult::Items { items, .. }) = run(&f, "echo", None) else { panic!("items") };
        let echoed: Value = serde_json::from_str(&items[0].title).unwrap();
        assert_eq!(echoed["context"], json!({"project": {"name": "Paper", "bibliographies": []}}));
        assert_eq!(echoed["keys"], json!([]));
    }

    #[test]
    fn the_plugin_cannot_read_the_project_or_the_home_folder() {
        let Some(f) = fixture(ALL) else { return };
        let tex = f.project.path("main.tex");
        assert_eq!(markdown(run(&f, "read", tex.to_str())), "EPERM");
        let ssh = PathBuf::from(std::env::var("HOME").unwrap()).join(".ssh/known_hosts");
        assert!(matches!(markdown(run(&f, "read", ssh.to_str())).as_str(), "EPERM" | "ENOENT"));
        let own = f.plugin_dir.join("main.js");
        assert_eq!(markdown(run(&f, "read", own.to_str())), "READ");
    }

    #[test]
    fn the_plugin_writes_only_its_data_folder() {
        let Some(f) = fixture(ALL) else { return };
        let bib = f.project.path("refs.bib");
        assert_eq!(markdown(run(&f, "write", bib.to_str())), "EPERM");
        assert_eq!(
            std::fs::read_to_string(&bib).unwrap(),
            "@book{knuth84, title = {Literate Programming}}\n"
        );
        let data = f.host.store.data_dir("dev.lattice.test").join("cache.json");
        assert_eq!(markdown(run(&f, "write", data.to_str())), "WROTE");
    }

    #[test]
    fn only_declared_local_ports_connect() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let Some(f) = fixture(&format!("network-local = [{port}]")) else { return };
        assert_eq!(markdown(run(&f, "net", Some(&port.to_string()))), "CONNECTED");
        let blocked =
            markdown(run(&f, "net", Some(&other.local_addr().unwrap().port().to_string())));
        assert!(blocked == "EPERM" || blocked == "EACCES", "{blocked}");
    }

    #[test]
    fn the_environment_is_clean() {
        let Some(f) = fixture("") else { return };
        let keys = markdown(run(&f, "env", None));
        for key in keys.split(',') {
            assert!(
                key == "__CF_USER_TEXT_ENCODING"
                    || ["PATH", "HOME", "TMPDIR", "LANG"].contains(&key)
                    || key.starts_with("LATTICE_PLUGIN_"),
                "leaked {key}"
            );
        }
    }

    #[test]
    fn secrets_need_a_declaration() {
        let Some(f) = fixture("secrets = [\"api-key\"]") else { return };
        f.host.set_secret("dev.lattice.test", "api-key", Some("s3cret")).unwrap();
        assert_eq!(markdown(run(&f, "secret", Some("api-key"))), "VALUE s3cret");
        assert_eq!(markdown(run(&f, "secret", Some("other"))), "DENIED -32001 secrets: other");
        assert!(f.host.set_secret("dev.lattice.test", "other", Some("x")).is_err());
    }

    #[test]
    fn failures_are_typed() {
        let Some(mut f) = fixture("") else { return };
        assert_eq!(
            run(&f, "fail", None),
            Err(PluginError::Plugin { message: "Zotero is not running".into() })
        );
        assert_eq!(run(&f, "crash", None), Err(PluginError::Crashed { stderr: "boom".into() }));
        assert!(matches!(run(&f, "noise", None), Err(PluginError::Protocol { .. })));
        assert_eq!(run(&f, "missing", None), Err(PluginError::UnknownCommand));
        f.host.set_timeout(Duration::from_millis(500));
        assert_eq!(run(&f, "hang", None), Err(PluginError::Timeout));
    }

    #[test]
    fn cancelling_stops_the_run() {
        let Some(f) = fixture("") else { return };
        let cancel = CancelToken::new();
        let stopper = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            stopper.cancel();
        });
        let sink = |_: RunEvent| -> Result<(), crate::host::Closed> { Ok(()) };
        let started = std::time::Instant::now();
        assert_eq!(
            f.host.run(request(&f, "hang", None), &sink, &cancel),
            Err(PluginError::Cancelled)
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_plugin_asking_for_more_stops_until_reviewed() {
        let Some(f) = fixture("") else { return };
        assert_eq!(f.host.commands().len(), COMMANDS.len());
        std::fs::write(
            f.plugin_dir.join("lattice-plugin.toml"),
            manifest("network-local = [23119]"),
        )
        .unwrap();
        assert_eq!(run(&f, "env", None), Err(PluginError::NeedsReview));
        let info = &f.host.list().unwrap()[0];
        assert!(info.needs_review && info.enabled);
        assert!(f.host.commands().is_empty());
        f.host.set_enabled("dev.lattice.test", true).unwrap();
        assert!(run(&f, "env", None).is_ok());
    }
}

#[cfg(not(target_os = "macos"))]
#[test]
fn plugins_fail_closed_without_the_sandbox() {
    let root = TempDir::new("plugins-closed");
    root.write("plugin/main.js", PLUGIN_JS);
    root.write("plugin/lattice-plugin.toml", manifest(""));
    let host = PluginHost::with(
        root.join("store"),
        PathBuf::from("node"),
        Vec::new(),
        Box::new(MemorySecrets::default()),
    );
    host.install_folder(&root.join("plugin")).unwrap();
    host.set_enabled("dev.lattice.test", true).unwrap();
    assert!(host.commands().is_empty());
    let sink = |_: RunEvent| -> Result<(), crate::host::Closed> { Ok(()) };
    let request = RunRequest {
        plugin_id: "dev.lattice.test".into(),
        command_id: "env".into(),
        ..Default::default()
    };
    assert_eq!(host.run(request, &sink, &CancelToken::new()), Err(PluginError::Unavailable));
}

mod store {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    fn zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, text) in files {
            writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(text.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// Serve `body` once at a loopback URL.
    fn serve(body: Vec<u8>) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/plugin.zip", server.server_addr().to_ip().unwrap());
        std::thread::spawn(move || {
            if let Ok(request) = server.recv() {
                let _ = request.respond(tiny_http::Response::from_data(body));
            }
        });
        url
    }

    fn host(root: &TempDir) -> PluginHost {
        PluginHost::with(
            root.join("store"),
            PathBuf::from("node"),
            Vec::new(),
            Box::new(MemorySecrets::default()),
        )
    }

    #[test]
    fn a_url_install_checks_the_hash_and_unpacks_once() {
        let root = TempDir::new("plugins-url");
        let archive = zip(&[
            ("hello-1.0.0/lattice-plugin.toml", &manifest("")),
            ("hello-1.0.0/main.js", PLUGIN_JS),
        ]);
        let sha = format!("{:x}", Sha256::digest(&archive));
        let host = host(&root);

        let wrong = host.install_url(&serve(archive.clone()), &"0".repeat(64)).unwrap_err();
        assert!(wrong.contains("Nothing was installed"), "{wrong}");
        assert!(host.list().unwrap().is_empty());

        let info = host.install_url(&serve(archive), &sha.to_uppercase()).unwrap();
        assert!(!info.enabled && info.granted.is_none() && info.error.is_none());
        assert!(matches!(info.source, Source::Url { ref sha256, .. } if *sha256 == sha));
        assert!(root.join("store/packages/dev.lattice.test/1.0.0/main.js").is_file());
        assert!(!root.join("store/staging").read_dir().unwrap().any(|_| true));
    }

    #[test]
    fn archives_that_escape_or_carry_unlisted_licences_are_refused() {
        let root = TempDir::new("plugins-url-bad");
        let host = host(&root);
        let install = |archive: Vec<u8>| {
            let sha = format!("{:x}", Sha256::digest(&archive));
            host.install_url(&serve(archive), &sha).unwrap_err()
        };
        let escape =
            zip(&[("lattice-plugin.toml", &manifest("")), ("main.js", ""), ("../evil.js", "x")]);
        assert!(install(escape).contains("Unsafe path"));
        assert!(!root.join("store/staging/evil.js").exists() && !root.join("evil.js").exists());
        let licence = zip(&[
            ("lattice-plugin.toml", &manifest("").replace("MIT", "Proprietary")),
            ("main.js", ""),
        ]);
        assert!(install(licence).contains("licence"));
        assert!(host
            .install_url("ftp://example.org/p.zip", &"0".repeat(64))
            .unwrap_err()
            .contains("https"));
    }

    #[test]
    fn an_update_that_asks_for_more_is_turned_off() {
        let root = TempDir::new("plugins-update");
        let host = host(&root);
        let v1 = zip(&[("lattice-plugin.toml", &manifest("")), ("main.js", "")]);
        host.install_url(&serve(v1.clone()), &format!("{:x}", Sha256::digest(&v1))).unwrap();
        host.set_enabled("dev.lattice.test", true).unwrap();
        let v2 = zip(&[
            ("lattice-plugin.toml", &manifest("network-local = [23119]").replace("1.0.0", "1.1.0")),
            ("main.js", ""),
        ]);
        let info =
            host.install_url(&serve(v2.clone()), &format!("{:x}", Sha256::digest(&v2))).unwrap();
        assert_eq!(info.version, "1.1.0");
        assert!(!info.enabled && info.needs_review);
    }

    #[test]
    fn removing_a_plugin_removes_its_data_and_secrets() {
        let root = TempDir::new("plugins-remove");
        root.write("plugin/main.js", "");
        root.write("plugin/lattice-plugin.toml", manifest("secrets = [\"token\"]"));
        let host = host(&root);
        host.install_folder(&root.join("plugin")).unwrap();
        let info = host.set_secret("dev.lattice.test", "token", Some("t")).unwrap();
        assert_eq!(info.secrets, [SecretState { name: "token".into(), saved: true }]);
        root.write("store/data/dev.lattice.test/cache", "x");
        host.remove("dev.lattice.test").unwrap();
        assert!(!root.join("store/data/dev.lattice.test").exists());
        assert!(host.secrets.get("dev.lattice.test", "token").unwrap().is_none());
        assert!(root.join("plugin/main.js").exists(), "a folder install's source is the author's");
    }

    #[test]
    fn a_second_folder_cannot_take_an_installed_id() {
        let root = TempDir::new("plugins-dup");
        for dir in ["a", "b"] {
            root.write(&format!("{dir}/main.js"), "");
            root.write(&format!("{dir}/lattice-plugin.toml"), manifest(""));
        }
        let host = host(&root);
        host.install_folder(&root.join("a")).unwrap();
        assert!(host.install_folder(&root.join("a")).is_ok());
        assert!(host.install_folder(&root.join("b")).unwrap_err().contains("already installed"));
    }
}
