//! Supervisor for the bundled Synara agent sidecar.
//!
//! The sidecar is a loopback Node service started on demand by
//! [`SynaraRuntime::ensure_ready`]. On macOS it runs inside the bibliography
//! sandbox with Lattice's own `ps` replacement (`process_inspector`); the
//! provider CLIs it spawns inherit the system proxy (`proxy`) and a default-off
//! research-writing skill (`preferences`).

mod preferences;
mod proxy;

use crate::chromium::{terminate_process_group, NodeRuntime};
use reqwest::blocking::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(50);
const RUNTIME_STATE_RELATIVE_PATH: &str = "userdata/server-runtime.json";
const UNAVAILABLE: &str = "The built-in agent service is unavailable.";
pub(crate) const BIBLIOGRAPHY_SANDBOX_PROFILE: &str = concat!(
    "(version 1)\n",
    "(allow default)\n",
    "(deny file-write* (regex #\".*[.][bB][iI][bB]$\"))",
);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynaraRuntimeInfo {
    state: String,
    origin: Option<String>,
    auth_token: Option<String>,
    message: Option<String>,
    startup_ms: Option<u64>,
    version: Option<String>,
    revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledRuntimeManifest {
    synara_version: Option<String>,
    synara_revision: Option<String>,
}

#[derive(Deserialize)]
struct PersistedServerRuntimeState {
    pid: u32,
    port: u16,
    origin: String,
}

struct RunningSynara {
    child: Child,
    /// What `ensure_ready` reports while the child is alive.
    info: SynaraRuntimeInfo,
}

struct LogTail {
    path: PathBuf,
    offset: u64,
}

#[derive(Default)]
pub struct SynaraRuntime {
    node: NodeRuntime,
    server_entry: PathBuf,
    bundled_skills_dir: PathBuf,
    home_dir: PathBuf,
    preferred_port: Option<u16>,
    external_origin: Option<String>,
    version: Option<String>,
    revision: Option<String>,
    running: Mutex<Option<RunningSynara>>,
}

impl SynaraRuntime {
    pub fn new(app: &tauri::App) -> Result<Self, Box<dyn std::error::Error>> {
        let external_origin = std::env::var("VITE_SYNARA_EMBED_URL")
            .ok()
            .filter(|_| cfg!(debug_assertions))
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty());
        let resource_dir = app.path().resource_dir()?;
        // `debug_assertions` is also true for `tauri build --debug`, whose app
        // must use its packaged resources rather than the build machine's
        // source tree. Tauri's development marker distinguishes that package
        // from `tauri dev` without changing which JavaScript runtime it uses.
        let resources = if tauri::is_dev() {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        } else {
            resource_dir.clone()
        };
        let runtime_root = resources.join("synara-runtime");
        let manifest: Option<BundledRuntimeManifest> =
            read_json(&runtime_root.join("manifest.json"));
        let home_dir = app.path().app_data_dir()?.join("synara");
        let preferred_port =
            read_json::<PersistedServerRuntimeState>(&home_dir.join(RUNTIME_STATE_RELATIVE_PATH))
                .map(|runtime| runtime.port);
        let (version, revision) = manifest
            .map_or((None, None), |manifest| (manifest.synara_version, manifest.synara_revision));
        Ok(Self {
            node: NodeRuntime::resolve(&resource_dir, &runtime_root.join("bin")),
            server_entry: runtime_root.join("server/dist/index.mjs"),
            bundled_skills_dir: resources.join("src").join("embedded_skills"),
            home_dir,
            preferred_port,
            external_origin,
            version,
            revision,
            running: Mutex::default(),
        })
    }

    fn ready_info(
        &self, origin: &str, auth_token: Option<&str>, startup_ms: u64,
    ) -> SynaraRuntimeInfo {
        SynaraRuntimeInfo {
            state: "ready".to_string(),
            origin: Some(origin.to_string()),
            auth_token: auth_token.map(str::to_string),
            message: None,
            startup_ms: Some(startup_ms),
            version: self.version.clone(),
            revision: self.revision.clone(),
        }
    }

    pub fn ensure_ready(&self) -> Result<SynaraRuntimeInfo, String> {
        if let Some(origin) = &self.external_origin {
            return Ok(self.ready_info(origin, None, 0));
        }
        let mut running = self.running.lock().map_err(|_| UNAVAILABLE.to_string())?;
        if let Some(current) = running.as_mut() {
            if matches!(current.child.try_wait(), Ok(None)) {
                return Ok(current.info.clone());
            }
            // The managed child exited; start a new one.
            *running = None;
        }

        let started = Instant::now();
        let (mut child, auth_token, startup_logs) = self.spawn()?;
        let origin = wait_until_ready(&mut child, &startup_logs, &self.home_dir, started)
            .inspect_err(|_| terminate_process_group(&mut child))?;
        let startup_ms = started.elapsed().as_millis() as u64;
        let info = self.ready_info(&origin, Some(&auth_token), startup_ms);
        *running = Some(RunningSynara { child, info: info.clone() });
        Ok(info)
    }

    /// Start the sidecar; returns its auth token and the stdout and stderr
    /// logs, with their lengths before this attempt started.
    fn spawn(&self) -> Result<(Child, String, [LogTail; 2]), String> {
        for (path, what) in
            [(&self.node.executable, "JavaScript runtime"), (&self.server_entry, "Synara service")]
        {
            if !path.is_file() {
                return Err(format!("The bundled {what} is missing at {}.", path.display()));
            }
        }

        fs::create_dir_all(&self.home_dir)
            .map_err(|error| format!("Could not create the agent data directory: {error}"))?;
        preferences::initialize_research_writing_preference(&self.home_dir)?;
        let _ = fs::remove_file(self.home_dir.join(RUNTIME_STATE_RELATIVE_PATH));
        let log_dir = self.home_dir.join("lattice-logs");
        fs::create_dir_all(&log_dir)
            .map_err(|error| format!("Could not create the agent log directory: {error}"))?;
        let startup_logs = ["sidecar.log", "sidecar-error.log"].map(|name| {
            let path = log_dir.join(name);
            LogTail { offset: fs::metadata(&path).map_or(0, |metadata| metadata.len()), path }
        });
        let stdout = append_log(&startup_logs[0].path)?;
        let stderr = append_log(&startup_logs[1].path)?;
        let token = || format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let (auth_token, shutdown_token) = (token(), token());

        // The prompt tells providers to use Lattice's bibliography tools, but
        // prompt text is not an authorization boundary. On macOS, put the
        // complete sidecar inside one Seatbelt profile so in-process agents,
        // provider CLIs, scripts, and delayed descendants all inherit the same
        // .bib write denial. The trusted parent app brokers the three allowed
        // bibliography mutations.
        let executable = std::env::current_exe()
            .map_err(|error| format!("Could not locate the app executable: {error}"))?;
        let inspector = crate::process_inspector::install_launcher(&self.home_dir, &executable)?;
        crate::process_inspector::verify_launcher(&inspector)?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .arg("-p")
            .arg(BIBLIOGRAPHY_SANDBOX_PROFILE)
            .arg(&self.node.executable)
            // Children inherit this profile. A second sandbox-exec can fail
            // sandbox_apply on older macOS before Codex even starts.
            .env("LATTICE_BIBLIOGRAPHY_SANDBOX", "1")
            .env("SYNARA_PROCESS_PS_PATH", inspector);
        self.node.configure(&mut command);
        command.arg(&self.server_entry);
        // Web storage is scoped to the complete iframe origin, including its
        // port. Reuse the previous sidecar port when it is free so composer
        // preferences such as the last model and effort survive app restarts;
        // retain dynamic allocation as the safe fallback for port conflicts.
        match available_preferred_server_port(self.preferred_port) {
            Some(port) => command.arg("--port").arg(port.to_string()),
            None => command.arg("--dynamic-port"),
        };
        command
            .current_dir(&self.home_dir)
            .env("NODE_ENV", "production")
            .env("SYNARA_MODE", "desktop")
            .env("SYNARA_HOST", "127.0.0.1")
            .env("SYNARA_HOME", &self.home_dir)
            .env("SYNARA_BUNDLED_SKILLS_DIR", &self.bundled_skills_dir)
            .env("SYNARA_NO_BROWSER", "true")
            // Keep the fork's upstream runtime intact while selecting Lattice's
            // model-facing prompt, MCP catalog, and bibliography boundary.
            .env("AGENT_HOST_PROFILE", "lattice")
            // Device control is a separate host-owned entitlement. It must not
            // be inferred from a provider's Full Access mode or from embedding
            // the web UI; the Lattice shell grants it only because it packages
            // and exposes the simulator pane alongside the agent runtime.
            .env("LATTICE_DEVICE_CONTROL_ENABLED", "true")
            .env("LATTICE_BIN", &executable)
            .env("SYNARA_AUTH_TOKEN", &auth_token)
            .env("SYNARA_DESKTOP_SHUTDOWN_TOKEN", shutdown_token)
            .env("SYNARA_DESKTOP_PARENT_PID", std::process::id().to_string())
            .env("SYNARA_TELEMETRY_ENABLED", "false")
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        proxy::apply_system_proxy_environment(&mut command);
        let child = command
            .spawn()
            .map_err(|error| format!("Could not start the built-in agent service: {error}"))?;

        Ok((child, auth_token, startup_logs))
    }

    pub fn shutdown(&self) {
        // Terminate under the lock, so a concurrent start waits for the old
        // sidecar to release its port.
        if let Ok(mut running) = self.running.lock() {
            if let Some(mut running) = running.take() {
                terminate_process_group(&mut running.child);
            }
        }
    }
}

impl Drop for SynaraRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[tauri::command]
pub fn synara_ensure_ready(
    state: tauri::State<'_, SynaraRuntime>,
) -> Result<SynaraRuntimeInfo, String> {
    state.ensure_ready()
}

#[tauri::command]
pub fn synara_open_skills_folder(app: tauri::AppHandle) -> Result<(), String> {
    let skills_dir =
        app.path().app_data_dir().map_err(|error| error.to_string())?.join("synara").join("skills");
    fs::create_dir_all(&skills_dir).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(skills_dir.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| error.to_string())
}

/// Keep the desktop token and loopback transport out of the renderer's CORS path.
pub fn compile_repair_request(
    runtime: &SynaraRuntime, action: &str, thread_id: Option<&str>, payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let info = runtime.ensure_ready()?;
    let origin = info.origin.ok_or("The agent service is unavailable.")?;
    let mut url = reqwest::Url::parse(&origin).map_err(|error| error.to_string())?;
    let mut segments = url.path_segments_mut().map_err(|_| "Invalid agent address.")?;
    segments.clear().extend(["api", "lattice", "compile-repair"]);
    match action {
        "start" => {}
        "status" | "cancel" => {
            let id = thread_id.filter(|id| !id.is_empty()).ok_or("Missing repair task.")?;
            segments.push(id);
            if action == "cancel" {
                segments.push("cancel");
            }
        }
        _ => return Err("Invalid repair action.".into()),
    }
    drop(segments);
    let client = crate::http::blocking(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request =
        if action == "status" { client.get(url) } else { client.post(url).json(&payload) };
    if let Some(token) = info.auth_token {
        request = request.bearer_auth(token);
    }
    let response = request.send().map_err(|error| error.to_string())?;
    let status = response.status();
    let value: serde_json::Value =
        response.json().map_err(|_| format!("Repair service returned {status}."))?;
    if !status.is_success() {
        return Err(value["error"].as_str().unwrap_or("The repair request failed.").to_string());
    }
    Ok(value)
}

fn append_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn wait_until_ready(
    child: &mut Child, startup_logs: &[LogTail], home_dir: &Path, started: Instant,
) -> Result<String, String> {
    let runtime_state_path = home_dir.join(RUNTIME_STATE_RELATIVE_PATH);
    // The bundled service only listens on loopback; a proxied health check
    // can make a healthy sidecar look unavailable until startup times out.
    let client = crate::http::loopback(Duration::from_millis(350))
        .build()
        .map_err(|error| format!("Could not initialize the agent health check: {error}"))?;

    while started.elapsed() < STARTUP_TIMEOUT {
        if let Some(status) =
            child.try_wait().map_err(|error| format!("Could not inspect agent startup: {error}"))?
        {
            let detail = startup_log_excerpt(startup_logs)
                .map(|excerpt| format!(" Startup log: {excerpt}"))
                .unwrap_or_default();
            return Err(format!(
                "The built-in agent stopped during startup with status {status}.{detail}"
            ));
        }
        if let Some(runtime) = read_json::<PersistedServerRuntimeState>(&runtime_state_path) {
            if runtime.pid == child.id() && health_is_ready(&client, &runtime.origin) {
                return Ok(runtime.origin.trim_end_matches('/').to_string());
            }
        }
        thread::sleep(HEALTH_POLL_INTERVAL);
    }
    Err(format!(
        "The built-in agent did not become ready within {} seconds.",
        STARTUP_TIMEOUT.as_secs()
    ))
}

/// The last few noteworthy (or, failing that, last few) lines this startup
/// attempt appended to the sidecar logs.
fn startup_log_excerpt(logs: &[LogTail]) -> Option<String> {
    let output =
        logs.iter().filter_map(|log| read_log_since(&log.path, log.offset)).collect::<Vec<_>>();
    let output = output.join("\n");
    let lines = output.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    let noteworthy = lines
        .iter()
        .copied()
        .filter(|line| {
            let normalized = line.to_ascii_lowercase();
            ["error", "failed", "locked", "missing", "denied", "unrecognized"]
                .iter()
                .any(|marker| normalized.contains(marker))
        })
        .collect::<Vec<_>>();
    let selected = if noteworthy.is_empty() { &lines } else { &noteworthy };
    let excerpt = selected[selected.len().saturating_sub(4)..].join(" | ");
    let char_count = excerpt.chars().count();
    Some(if char_count > 1_200 {
        format!("…{}", excerpt.chars().skip(char_count - 1_200).collect::<String>())
    } else {
        excerpt
    })
}

fn read_log_since(path: &Path, offset: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(offset.min(length))).ok()?;
    let mut output = String::new();
    file.read_to_string(&mut output).ok()?;
    (!output.is_empty()).then_some(output)
}

fn available_preferred_server_port(port: Option<u16>) -> Option<u16> {
    let port = port.filter(|port| *port != 0)?;
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok().map(|_listener| port)
}

fn health_is_ready(client: &Client, origin: &str) -> bool {
    client
        .get(format!("{origin}/health"))
        .send()
        .ok()
        .filter(|response| response.status().is_success())
        .and_then(|response| response.json::<serde_json::Value>().ok())
        .and_then(|value| value.get("startupReady").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn compile_repair_relay_preserves_payload_routes_and_server_errors() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr().to_ip().unwrap());
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in [
                (202, r#"{"threadId":"repair:one"}"#),
                (200, r#"{"status":"completed"}"#),
                (202, r#"{"status":"running"}"#),
                (409, r#"{"error":"Already repairing"}"#),
            ] {
                let mut request = server.recv().unwrap();
                let mut received = Vec::new();
                request.as_reader().read_to_end(&mut received).unwrap();
                requests.push((format!("{} {}", request.method(), request.url()), received));
                let response = tiny_http::Response::from_string(body).with_status_code(status);
                request.respond(response).unwrap();
            }
            requests
        });
        let mut runtime = SynaraRuntime::default();
        runtime.external_origin = Some(origin);
        let payload = serde_json::json!({
            "workspaceRoot": "/paper", "runtimeMode": "full-access", "rootDocument": "main.tex",
            "diagnostics": [
                {"level": "warning", "message": "Undefined reference", "file": "results.tex", "line": 17},
                {"level": "error", "message": "Undefined control sequence", "file": "main.tex", "line": 42}
            ]
        });
        let request = |action, thread_id, payload| {
            compile_repair_request(&runtime, action, thread_id, payload)
        };
        let null = serde_json::Value::Null;
        assert_eq!(request("start", None, payload.clone()).unwrap()["threadId"], "repair:one");
        assert_eq!(
            request("status", Some("repair:one"), null.clone()).unwrap()["status"],
            "completed"
        );
        assert_eq!(request("cancel", Some("repair:one"), null).unwrap()["status"], "running");
        assert_eq!(request("start", None, payload.clone()).unwrap_err(), "Already repairing");

        let requests = server.join().unwrap();
        assert_eq!(requests[0].0, "POST /api/lattice/compile-repair");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&requests[0].1).unwrap(), payload);
        assert_eq!(requests[1].0, "GET /api/lattice/compile-repair/repair:one");
        assert!(requests[1].1.is_empty());
        assert_eq!(requests[2].0, "POST /api/lattice/compile-repair/repair:one/cancel");
    }

    fn run_bibliography_sandbox(script: &str, args: &[&PathBuf]) -> bool {
        Command::new("/usr/bin/sandbox-exec")
            .args(["-p", BIBLIOGRAPHY_SANDBOX_PROFILE, "/bin/sh", "-c", script, "sandbox-test"])
            .args(args)
            .status()
            .expect("run sandboxed command")
            .success()
    }

    #[test]
    fn bibliography_sandbox_blocks_direct_and_indirect_bib_writes() {
        let root = TempDir::new("bib-sandbox");
        let path = |name: &str| root.join(name);
        let (bibliography, uppercase, ordinary) = (
            root.write("references.bib", "original"),
            root.write("OTHER.BIB", "uppercase"),
            root.write("ordinary.txt", "ordinary"),
        );
        let (replacement, renamed, alias) =
            (path("replacement.tmp"), path("renamed.tmp"), path("alias.txt"));
        let (bib_alias, hardlink_alias) = (path("alias.bib"), path("hardlink.txt"));
        std::os::unix::fs::symlink(&bibliography, &alias).expect("symlink to bibliography");

        let attempts: [(&str, &[&PathBuf]); 9] = [
            ("printf changed >> \"$1\"", &[&bibliography]),
            ("printf changed > \"$1\"", &[&bibliography]),
            ("rm \"$1\"", &[&bibliography]),
            ("printf replacement > \"$1\" && mv -f \"$1\" \"$2\"", &[&replacement, &bibliography]),
            (
                "mv \"$1\" \"$2\" && printf changed > \"$2\" && mv \"$2\" \"$1\"",
                &[&bibliography, &renamed],
            ),
            ("printf changed > \"$1\"", &[&uppercase]),
            ("ln \"$1\" \"$2\" && printf changed > \"$2\"", &[&bibliography, &hardlink_alias]),
            ("printf changed > \"$1\"", &[&alias]),
            ("ln -s \"$1\" \"$2\" && printf changed > \"$2\"", &[&ordinary, &bib_alias]),
        ];
        for (script, args) in attempts {
            assert!(!run_bibliography_sandbox(script, args), "sandbox allowed: {script}");
        }

        assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
        assert_eq!(fs::read_to_string(&uppercase).unwrap(), "uppercase");
        assert!(run_bibliography_sandbox("printf changed > \"$1\"", &[&ordinary]));
        assert_eq!(fs::read_to_string(&ordinary).unwrap(), "changed");

        // Background descendants that outlive the sandboxed shell inherit it.
        assert!(run_bibliography_sandbox(
            "(sleep 0.05; printf changed > \"$1\") >/dev/null 2>&1 &",
            &[&bibliography],
        ));
        thread::sleep(Duration::from_millis(150));
        assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
    }

    #[test]
    fn reads_the_bundled_runtime_manifest() {
        let root = TempDir::new("synara");
        let manifest = r#"{"synaraVersion":"0.6.3","synaraRevision":"abc123"}"#;
        let manifest: BundledRuntimeManifest =
            read_json(&root.write("manifest.json", manifest)).expect("read manifest");
        assert_eq!(manifest.synara_version.as_deref(), Some("0.6.3"));
        assert_eq!(manifest.synara_revision.as_deref(), Some("abc123"));
    }

    #[test]
    fn reuses_the_preferred_port_only_while_it_is_free() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("reserve port");
        let port = listener.local_addr().expect("local address").port();
        assert_eq!(available_preferred_server_port(Some(port)), None);
        drop(listener);
        assert_eq!(available_preferred_server_port(Some(port)), Some(port));
    }

    #[test]
    fn startup_log_excerpt_only_reports_the_current_attempt() {
        let root = TempDir::new("synara");
        let previous = "DatabaseLifecycleLockedError: previous attempt\n";
        let logs = [("sidecar.log", previous), ("sidecar-error.log", "")].map(|(name, content)| {
            LogTail { offset: content.len() as u64, path: root.write(name, content) }
        });
        fs::write(
            &logs[0].path,
            format!("{previous}DatabaseLifecycleLockedError: owner pid 42 is live\n"),
        )
        .expect("append current log");

        let excerpt = startup_log_excerpt(&logs).expect("startup excerpt");
        assert_eq!(excerpt, "DatabaseLifecycleLockedError: owner pid 42 is live");
    }
}
