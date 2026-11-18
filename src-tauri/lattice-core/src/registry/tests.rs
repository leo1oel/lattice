//! The registry client against a loopback server, with lists signed by a
//! throwaway key made here (never the registry's own): the same minisign
//! format the registry's CI writes, pre-hashed with BLAKE2b-512.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use blake2::{Blake2b512, Digest as _};
use ring::signature::{Ed25519KeyPair, KeyPair};

use super::*;
use lattice_theme::AccentChoice;

struct Key {
    pair: Ed25519KeyPair,
    id: [u8; 8],
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl Key {
    fn new(seed: u8) -> Self {
        Key { pair: Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap(), id: [seed; 8] }
    }

    fn public(&self) -> PublicKey {
        let bytes = [b"Ed".as_slice(), &self.id, self.pair.public_key().as_ref()].concat();
        PublicKey::from_base64(&b64(&bytes)).unwrap()
    }

    fn sign(&self, body: &[u8], comment: &str) -> String {
        let signature = self.pair.sign(&Blake2b512::digest(body));
        let line = [b"ED".as_slice(), &self.id, signature.as_ref()].concat();
        let global = self.pair.sign(&[signature.as_ref(), comment.as_bytes()].concat());
        format!(
            "untrusted comment: test\n{}\ntrusted comment: {comment}\n{}\n",
            b64(&line),
            b64(global.as_ref())
        )
    }
}

/// A Pages site on loopback whose files a test replaces as it goes.
#[derive(Clone)]
struct Site {
    url: String,
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl Site {
    fn start() -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr().to_ip().unwrap());
        let files: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
        let served = files.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let body = served.lock().unwrap().get(request.url()).cloned();
                let _ = match body {
                    Some(body) => request.respond(tiny_http::Response::from_data(body)),
                    None => request.respond(tiny_http::Response::empty(404)),
                };
            }
        });
        Site { url, files }
    }

    fn put(&self, path: &str, body: impl Into<Vec<u8>>) {
        self.files.lock().unwrap().insert(format!("/{path}"), body.into());
    }

    fn take_down(&self) {
        self.files.lock().unwrap().clear();
    }

    /// Publishes a signed index and block list at `serial`, serving each
    /// theme file (id, version) the index lists.
    fn publish(&self, key: &Key, serial: u64, themes: &[(&str, &str)], blocked: &str) {
        let entries: Vec<String> = themes
            .iter()
            .map(|(id, version)| {
                let file = theme_file(id, version);
                let path = format!("themes/{id}/{version}.lattice-theme.json");
                let entry = format!(
                    r##"{{"id":"{id}","name":"{id}","version":"{version}","author":null,"license":"MIT","description":null,"repository":"https://github.com/example/themes","tag":"v{version}","commit":"0000000000000000000000000000000000000000","path":"theme.json","url":"{}/{path}","sha256":"{:x}","size":{},"variants":[{{"id":"night","name":null,"appearance":"dark","colors":{{"chrome":"#101018"}}}}]}}"##,
                    self.url,
                    Sha256::digest(file.as_bytes()),
                    file.len()
                );
                self.put(&path, file);
                entry
            })
            .collect();
        let index = format!(
            r#"{{"format":1,"serial":{serial},"generated":"2026-11-18T12:00:00.000Z","themes":[{}],"plugins":[]}}"#,
            entries.join(",")
        );
        let blocked = format!(
            r#"{{"format":1,"serial":{serial},"generated":"2026-11-18T12:00:00.000Z","blocked":{blocked}}}"#
        );
        self.put("index.json.minisig", key.sign(index.as_bytes(), &comment("index.json", serial)));
        self.put(
            "blocked.json.minisig",
            key.sign(blocked.as_bytes(), &comment("blocked.json", serial)),
        );
        self.put("index.json", index);
        self.put("blocked.json", blocked);
    }
}

fn comment(file: &str, serial: u64) -> String {
    format!("lattice-plugins file:{file} serial:{serial}")
}

fn theme_file(id: &str, version: &str) -> String {
    format!(
        r##"{{"schema":1,"id":"{id}","name":"{id}","version":"{version}","variants":[{{"id":"night","appearance":"dark","colors":{{"chrome":"#101018"}}}}]}}"##
    )
}

struct Fixture {
    dir: PathBuf,
    site: Site,
    key: Key,
    registry: Registry,
    store: ThemeStore,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("lattice-registry-{}", uuid::Uuid::new_v4()));
    let site = Site::start();
    let key = Key::new(7);
    let registry = Registry::with(dir.join("registry"), &site.url, vec![key.public()]);
    let store = ThemeStore::new(&dir);
    Fixture { dir, site, key, registry, store }
}

const NO_BLOCKS: &str = "[]";

fn refused(status: &Status) -> &str {
    match status {
        Status::Refused { message } => message,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_embedded_keys_are_the_registrys() {
    let ids: Vec<String> = verify::PUBLIC_KEYS
        .iter()
        .map(|key| {
            PublicKey::from_base64(key).unwrap();
            let bytes = base64::engine::general_purpose::STANDARD.decode(key).unwrap();
            bytes[2..10].iter().rev().map(|byte| format!("{byte:02X}")).collect()
        })
        .collect();
    assert_eq!(ids, ["03272612D22DB2A5", "D520097EDBD2D0F4"]);
}

#[test]
fn a_signature_verifies_only_for_its_key_file_and_serial() {
    let (key, other) = (Key::new(1), Key::new(2));
    let keys = [other.public(), key.public()];
    let body = br#"{"serial":4}"#;
    let good = key.sign(body, &comment("index.json", 4));
    assert_eq!(verify::verify(&keys, "index.json", body, &good, 4), Ok(()));
    // Either trusted key may sign.
    assert!(verify::verify(&keys[..1], "index.json", body, &good, 4).is_err());
    let tampered = br#"{"serial":5}"#;
    let bad = verify::verify(&keys, "index.json", tampered, &good, 4).unwrap_err();
    assert!(bad.contains("no valid signature"), "{bad}");
    let untrusted = Key::new(3).sign(body, &comment("index.json", 4));
    assert!(verify::verify(&keys, "index.json", body, &untrusted, 4).is_err());
    let wrong_file = key.sign(body, &comment("blocked.json", 4));
    let moved = verify::verify(&keys, "index.json", body, &wrong_file, 4).unwrap_err();
    assert!(moved.contains("another file or serial"), "{moved}");
    assert!(verify::verify(&keys, "index.json", body, &good, 5).is_err());
    assert!(verify::verify(&keys, "index.json", body, "not a signature", 4).is_err());
}

#[test]
fn a_fetched_list_is_cached_and_served_offline() {
    let f = fixture();
    let empty = f.registry.listing(&f.store, false);
    assert!(empty.index.is_none() && empty.status == Status::Cached);
    f.site.publish(&f.key, 2, &[("dev.example.ink", "1.0.0")], NO_BLOCKS);
    let fresh = f.registry.listing(&f.store, true);
    assert_eq!(fresh.status, Status::Fresh);
    assert_eq!(fresh.index.as_ref().unwrap().themes[0].id, "dev.example.ink");
    f.site.take_down();
    let offline = f.registry.listing(&f.store, true);
    assert!(matches!(&offline.status, Status::Offline { message } if message.contains("HTTP 404")));
    assert_eq!(offline.index.unwrap().serial, 2);
    assert_eq!(offline.fetched_at, fresh.fetched_at);
}

#[test]
fn an_older_or_forged_list_is_refused_and_the_cache_kept() {
    let f = fixture();
    f.site.publish(&f.key, 3, &[], NO_BLOCKS);
    assert_eq!(f.registry.listing(&f.store, true).status, Status::Fresh);
    f.site.publish(&f.key, 2, &[], NO_BLOCKS);
    let rollback = f.registry.listing(&f.store, true);
    assert!(refused(&rollback.status).contains("older list (serial 2 after 3)"));
    assert_eq!(rollback.index.unwrap().serial, 3);
    f.site.publish(&Key::new(9), 4, &[], NO_BLOCKS);
    let forged = f.registry.listing(&f.store, true);
    assert!(refused(&forged.status).contains("no valid signature"));
    // An index and block list from two publishes do not pair up.
    f.site.publish(&f.key, 5, &[], NO_BLOCKS);
    let old_blocked =
        f.key.sign(br#"{"format":1,"serial":4,"blocked":[]}"#, &comment("blocked.json", 4));
    f.site.put("blocked.json", r#"{"format":1,"serial":4,"blocked":[]}"#);
    f.site.put("blocked.json.minisig", old_blocked);
    let torn = f.registry.listing(&f.store, true);
    assert!(refused(&torn.status).contains("updating its list"));
    assert_eq!(torn.index.unwrap().serial, 3);
}

#[test]
fn installs_record_their_version_offer_updates_and_report_blocks() {
    let f = fixture();
    let ink = "dev.example.ink";
    assert!(f.registry.install_theme(&f.store, ink).unwrap_err().contains("Load the theme list"));
    f.site.publish(&f.key, 1, &[(ink, "1.0.0")], NO_BLOCKS);
    f.registry.listing(&f.store, true);
    assert_eq!(f.registry.install_theme(&f.store, ink).unwrap().version, "1.0.0");
    let current = f.registry.listing(&f.store, false).installed;
    assert_eq!(
        current,
        [InstalledTheme { id: ink.into(), version: "1.0.0".into(), update: None, blocked: None }]
    );

    let bad = r#"[{"id":"dev.example.bad","versions":"*","action":"disable","reason":"Phishes."}]"#;
    f.site.publish(&f.key, 2, &[(ink, "1.1.0"), ("dev.example.bad", "1.0.0")], bad);
    let listing = f.registry.listing(&f.store, true);
    assert_eq!(listing.installed[0].update.as_deref(), Some("1.1.0"));
    assert_eq!(listing.blocked_offers.keys().collect::<Vec<_>>(), ["dev.example.bad"]);
    let refused = f.registry.install_theme(&f.store, "dev.example.bad").unwrap_err();
    assert_eq!(refused, "dev.example.bad 1.0.0 is blocked: Phishes.");
    assert!(f.store.get("dev.example.bad").is_none());

    let ink_blocked =
        r#"[{"id":"dev.example.ink","versions":"<=1.0.0","action":"warn","reason":"Unreadable."}]"#;
    f.site.publish(&f.key, 3, &[(ink, "1.1.0")], ink_blocked);
    let listing = f.registry.listing(&f.store, true);
    assert_eq!(listing.installed[0].blocked.as_ref().unwrap().reason, "Unreadable.");
    f.registry.install_theme(&f.store, ink).unwrap();
    let updated = &f.registry.listing(&f.store, false).installed[0];
    assert_eq!(
        (updated.version.as_str(), &updated.update, &updated.blocked),
        ("1.1.0", &None, &None)
    );
}

#[test]
fn the_kill_switch_turns_a_disabled_theme_off_and_leaves_a_warned_one_on() {
    let f = fixture();
    let ink = "dev.example.ink";
    let applied = || {
        f.registry.resolve(&f.store, Some(ink), Appearance::Dark, AccentChoice::ThemeDefault).theme
    };
    let block = || {
        let themes = f.registry.list_themes(&f.store);
        themes.into_iter().find(|theme| theme.id == ink).and_then(|theme| theme.blocked)
    };
    f.site.publish(&f.key, 1, &[(ink, "1.0.0")], NO_BLOCKS);
    f.registry.listing(&f.store, true);
    f.registry.install_theme(&f.store, ink).unwrap();
    assert_eq!((applied().as_deref(), block()), (Some(ink), None));

    let warn =
        r#"[{"id":"dev.example.ink","versions":"*","action":"warn","reason":"Low contrast."}]"#;
    f.site.publish(&f.key, 2, &[(ink, "1.0.0")], warn);
    f.registry.listing(&f.store, true);
    assert_eq!(applied().as_deref(), Some(ink));
    assert_eq!(block().unwrap().action, "warn");

    let disable = r#"[{"id":"dev.example.ink","versions":"<=1.0.0","action":"disable","reason":"Phishes.","url":"https://example.com/1"}]"#;
    f.site.publish(&f.key, 3, &[(ink, "1.0.0")], disable);
    f.registry.listing(&f.store, true);
    assert_eq!(applied(), None);
    assert_eq!(block().unwrap().url.as_deref(), Some("https://example.com/1"));
    // Offline, the cached block list still holds.
    f.site.take_down();
    f.registry.listing(&f.store, true);
    assert_eq!(applied(), None);

    // A file installed over it under another version is the writer's own.
    f.store.install_text(&theme_file(ink, "2.0.0")).unwrap();
    assert_eq!((applied().as_deref(), block()), (Some(ink), None));
}

#[test]
fn a_download_that_does_not_match_the_index_is_refused() {
    let f = fixture();
    let ink = "dev.example.ink";
    f.site.publish(&f.key, 1, &[(ink, "1.0.0")], NO_BLOCKS);
    f.registry.listing(&f.store, true);
    let path = format!("themes/{ink}/1.0.0.lattice-theme.json");
    let swapped = theme_file(ink, "1.0.0").replace("#101018", "#ff0000");
    f.site.put(&path, swapped);
    let err = f.registry.install_theme(&f.store, ink).unwrap_err();
    assert!(err.contains("checksum"), "{err}");
    let file = theme_file(ink, "1.0.0");
    f.site.put(&path, &file.as_bytes()[..file.len() - 1]);
    let err = f.registry.install_theme(&f.store, ink).unwrap_err();
    assert!(err.contains("not the size"), "{err}");
    assert!(f.store.get(ink).is_none());
    assert!(f.registry.listing(&f.store, false).installed.is_empty());
}

#[test]
fn block_ranges_match_like_npm_and_fail_closed() {
    assert!(verify::version_in("*", "9.9.9"));
    assert!(verify::version_in("<=0.3.1", "0.3.1"));
    assert!(!verify::version_in("<=0.3.1", "0.3.2"));
    assert!(verify::version_in(">=1.0.0 <1.2.0", "1.1.5"));
    assert!(!verify::version_in(">= 1.0.0 < 1.2.0", "1.2.0"));
    assert!(verify::version_in("1.0.0 || 2.0.0", "2.0.0"));
    assert!(!verify::version_in("1.0.0", "1.0.1"));
    assert!(verify::version_in("not a range", "1.0.0"));
    assert!(verify::newer("1.10.0", "1.9.0"));
    assert!(!verify::newer("1.0.0", "1.0.0"));
}

// Plugins in the same signed list (Captain plan P3).

fn plugin_manifest(id: &str, version: &str, runtime: &str, permissions: &str) -> String {
    format!(
        "schema = 1\nid = \"{id}\"\nname = \"Test\"\nversion = \"{version}\"\napi = 1\nlicense = \"MIT\"\nruntime = \"{runtime}\"\nmain = \"main.js\"\n\n[permissions]\n{permissions}\n\n[[commands]]\nid = \"echo\"\ntitle = \"Echo\"\n"
    )
}

fn plugin_zip(manifest: &str) -> Vec<u8> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, text) in [("lattice-plugin.toml", manifest), ("main.js", "// test\n")] {
        writer.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        writer.write_all(text.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// A plugin the index lists: what the index says it asks (\`listed\`, JSON)
/// and the archive the site serves for it.
struct Listed<'a> {
    id: &'a str,
    version: &'a str,
    runtime: &'a str,
    listed: &'a str,
    archive: Vec<u8>,
}

impl Listed<'_> {
    fn node<'a>(id: &'a str, version: &'a str, toml: &str, listed: &'a str) -> Listed<'a> {
        let archive = plugin_zip(&plugin_manifest(id, version, "node", toml));
        Listed { id, version, runtime: "node", listed, archive }
    }
}

impl Site {
    fn publish_plugins(&self, key: &Key, serial: u64, plugins: &[Listed], blocked: &str) {
        let entries: Vec<String> = plugins
            .iter()
            .map(|p| {
                let path = format!("plugins/{}/{}.zip", p.id, p.version);
                let entry = format!(
                    r#"{{"id":"{}","name":"Test","version":"{}","api":1,"runtime":"{}","license":"MIT","repository":"https://github.com/example/plugin","commit":"0000000000000000000000000000000000000000","permissions":{},"commands":[{{"id":"echo","title":"Echo"}}],"url":"{}/{path}","sha256":"{:x}","size":{}}}"#,
                    p.id,
                    p.version,
                    p.runtime,
                    p.listed,
                    self.url,
                    Sha256::digest(&p.archive),
                    p.archive.len()
                );
                self.put(&path, p.archive.clone());
                entry
            })
            .collect();
        let index = format!(
            r#"{{"format":1,"serial":{serial},"generated":"2026-11-18T12:00:00.000Z","themes":[],"plugins":[{}]}}"#,
            entries.join(",")
        );
        let blocked = format!(
            r#"{{"format":1,"serial":{serial},"generated":"2026-11-18T12:00:00.000Z","blocked":{blocked}}}"#
        );
        self.put("index.json.minisig", key.sign(index.as_bytes(), &comment("index.json", serial)));
        self.put(
            "blocked.json.minisig",
            key.sign(blocked.as_bytes(), &comment("blocked.json", serial)),
        );
        self.put("index.json", index);
        self.put("blocked.json", blocked);
    }
}

fn plugin_host(f: &Fixture) -> PluginHost {
    let mut host = PluginHost::with(
        f.dir.join("plugins"),
        PathBuf::from("node"),
        Vec::new(),
        Box::new(crate::plugins::broker::tests::MemorySecrets::default()),
    );
    let keys = vec![f.key.public()];
    host.set_registry(Arc::new(Registry::with(f.dir.join("registry"), &f.site.url, keys)));
    host
}

const PLUGIN: &str = "dev.example.cite";
const CROSSREF: &str = r#"network = ["https://api.crossref.org"]"#;
const CROSSREF_LISTED: &str = r#"{"network":["https://api.crossref.org"]}"#;

#[test]
fn a_listed_plugin_installs_as_reviewed_and_offers_its_update_with_what_it_adds() {
    let f = fixture();
    let host = plugin_host(&f);
    f.site.publish_plugins(&f.key, 2, &[Listed::node(PLUGIN, "1.0.0", "", "{}")], NO_BLOCKS);
    let listing = f.registry.plugin_listing(&host, true);
    assert_eq!(listing.status, Status::Fresh);
    assert!(listing.verified);
    assert_eq!(listing.plugins[0].id, PLUGIN);
    assert_eq!(listing.plugins[0].commands[0].title, "Echo");
    if !crate::plugins::AVAILABLE {
        let refused = host.install_registry(PLUGIN).unwrap_err();
        assert!(refused.contains("macOS"), "{refused}");
        return;
    }
    let info = host.install_registry(PLUGIN).unwrap();
    assert!(matches!(info.source, Source::Registry { .. }));
    assert!(!info.enabled && info.blocked.is_none());
    host.set_enabled(PLUGIN, true).unwrap();

    f.site.publish_plugins(
        &f.key,
        3,
        &[Listed::node(PLUGIN, "1.1.0", CROSSREF, CROSSREF_LISTED)],
        NO_BLOCKS,
    );
    let listing = f.registry.plugin_listing(&host, true);
    let installed = &listing.installed[0];
    assert_eq!(installed.update.as_deref(), Some("1.1.0"));
    assert_eq!(installed.update_asks.network, ["https://api.crossref.org"]);
    // An update that asks for more installs turned off, until the writer
    // grants what it adds.
    let updated = host.install_registry(PLUGIN).unwrap();
    assert_eq!(updated.version, "1.1.0");
    assert!(!updated.enabled);
    let listing = f.registry.plugin_listing(&host, false);
    assert_eq!(listing.installed[0].update, None);
}

#[test]
fn a_download_unlike_the_listing_installs_nothing() {
    if !crate::plugins::AVAILABLE {
        return;
    }
    let f = fixture();
    let host = plugin_host(&f);
    // The archive asks for the network, the index says it asks for nothing.
    let mut quiet = Listed::node(PLUGIN, "1.0.0", CROSSREF, "{}");
    f.site.publish_plugins(&f.key, 2, &[quiet], NO_BLOCKS);
    f.registry.plugin_listing(&host, true);
    let unlike = host.install_registry(PLUGIN).unwrap_err();
    assert!(unlike.contains("plugin list describes"), "{unlike}");
    // The bytes served are not the ones the index hashed.
    quiet = Listed::node(PLUGIN, "1.0.0", "", "{}");
    f.site.publish_plugins(&f.key, 3, &[quiet], NO_BLOCKS);
    f.registry.plugin_listing(&host, true);
    let path = format!("plugins/{PLUGIN}/1.0.0.zip");
    f.site.put(&path, plugin_zip(&plugin_manifest(PLUGIN, "1.0.0", "node", "# edited")));
    let swapped = host.install_registry(PLUGIN).unwrap_err();
    let refusals = ["checksum", "size", "larger than expected"];
    assert!(refusals.iter().any(|r| swapped.contains(r)), "{swapped}");
    assert!(host.list().unwrap().is_empty());
    // A native plugin is never offered for install from the list.
    let native =
        Listed { runtime: "exec", ..Listed::node("dev.example.native", "1.0.0", "", "{}") };
    f.site.publish_plugins(&f.key, 4, &[native], NO_BLOCKS);
    f.registry.plugin_listing(&host, true);
    let exec = host.install_registry("dev.example.native").unwrap_err();
    assert!(exec.contains("only node plugins"), "{exec}");
}

#[test]
fn the_kill_switch_turns_off_listed_installs_but_leaves_folders_alone() {
    if !crate::plugins::AVAILABLE {
        return;
    }
    let f = fixture();
    let host = plugin_host(&f);
    f.site.publish_plugins(&f.key, 2, &[Listed::node(PLUGIN, "1.0.0", "", "{}")], NO_BLOCKS);
    f.registry.plugin_listing(&host, true);
    host.install_registry(PLUGIN).unwrap();
    host.set_enabled(PLUGIN, true).unwrap();
    let folder = f.dir.join("dev-folder");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("lattice-plugin.toml"),
        plugin_manifest("dev.example.mine", "1.0.0", "node", ""),
    )
    .unwrap();
    std::fs::write(folder.join("main.js"), "// mine\n").unwrap();
    host.install_folder(&folder).unwrap();
    host.set_enabled("dev.example.mine", true).unwrap();
    assert_eq!(host.commands().len(), 2);

    let blocked = format!(
        r#"[{{"id":"{PLUGIN}","versions":"<=1.0.0","action":"disable","reason":"Sends text off the machine."}},{{"id":"dev.example.mine","versions":"*","action":"disable","reason":"Not yours to block."}}]"#
    );
    f.site.publish_plugins(&f.key, 3, &[Listed::node(PLUGIN, "1.0.0", "", "{}")], &blocked);
    let listing = f.registry.plugin_listing(&host, true);
    assert!(listing.blocked_offers.contains_key(PLUGIN));
    assert_eq!(listing.installed.len(), 1, "a folder install is not the registry's");
    let info = host.list().unwrap().into_iter().find(|p| p.id == PLUGIN).unwrap();
    assert_eq!(info.blocked.unwrap().reason, "Sends text off the machine.");
    let commands: Vec<_> = host.commands().into_iter().map(|c| c.plugin_id).collect();
    assert_eq!(commands, ["dev.example.mine"]);
    host.set_enabled(PLUGIN, false).unwrap();
    let on = host.set_enabled(PLUGIN, true).unwrap_err();
    assert!(on.contains("turned this plugin off"), "{on}");
    let install = host.install_registry(PLUGIN).unwrap_err();
    assert!(install.contains("is blocked"), "{install}");

    // A warning leaves it running.
    let warned =
        format!(r#"[{{"id":"{PLUGIN}","versions":"*","action":"warn","reason":"Slow."}}]"#);
    f.site.publish_plugins(&f.key, 4, &[Listed::node(PLUGIN, "1.0.0", "", "{}")], &warned);
    f.registry.plugin_listing(&host, true);
    host.set_enabled(PLUGIN, true).unwrap();
    assert_eq!(host.commands().len(), 2);
}
