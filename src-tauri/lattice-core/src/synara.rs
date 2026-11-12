//! Supervisor for the bundled Synara agent sidecar.
//!
//! The sidecar is a loopback Node service started on demand by
//! [`SynaraRuntime::ensure_ready`]. It runs inside the macOS bibliography
//! sandbox with Lattice's own `ps` replacement (`process_inspector`), and
//! does not start at all where no such guard exists (`bibliography_guard`); the
//! provider CLIs it spawns inherit the writer's proxy and provider settings
//! (`environment`, from the login shell and the system proxy), which a
//! restart picks up again (`restart`), and a default-off research-writing
//! skill (`preferences`).

mod bibliography_guard;
mod environment;
mod preferences;
#[cfg(target_os = "macos")]
mod proxy;
#[cfg(not(target_os = "macos"))]
#[path = "synara/proxy_stub.rs"]
mod proxy;
mod restart;
mod shell_env;

use crate::host::{EventSink, Resources};
use crate::sidecar::{terminate_process_group, NodeRuntime};
use crate::wide_event::{self, Failure};
#[cfg(target_os = "macos")]
pub(crate) use bibliography_guard::BIBLIOGRAPHY_SANDBOX_PROFILE;
pub use environment::EnvironmentReport;
use reqwest::blocking::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(50);
const RUNTIME_STATE_RELATIVE_PATH: &str = "userdata/server-runtime.json";
const UNAVAILABLE: &str = "The built-in agent service is unavailable.";
/// Under the agent home: the sidecar's stdout and stderr, which startup
/// failures quote from and the support bundle collects.
const SIDECAR_LOG_DIR: &str = "lattice-logs";

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
    environment: environment::AgentEnvironment,
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
    /// Shared with the system proxy watcher (`restart`).
    running: Arc<Mutex<Option<RunningSynara>>>,
    /// Where restarts and environment changes are announced. None only in tests.
    events: Option<Arc<dyn EventSink>>,
    shell_prefetch: Arc<shell_env::Prefetch>,
    proxy_watch: OnceLock<()>,
}

impl SynaraRuntime {
    pub fn new(resources: &Resources, events: Arc<dyn EventSink>) -> Self {
        let external_origin = std::env::var("VITE_SYNARA_EMBED_URL")
            .ok()
            .filter(|_| cfg!(debug_assertions))
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty());
        let runtime_root = resources.bundle_dir.join("synara-runtime");
        let manifest: Option<BundledRuntimeManifest> =
            read_json(&runtime_root.join("manifest.json"));
        let home_dir = resources.app_data_dir.join("synara");
        let preferred_port =
            read_json::<PersistedServerRuntimeState>(&home_dir.join(RUNTIME_STATE_RELATIVE_PATH))
                .map(|runtime| runtime.port);
        let (version, revision) = manifest
            .map_or((None, None), |manifest| (manifest.synara_version, manifest.synara_revision));
        let shell_prefetch = Arc::<shell_env::Prefetch>::default();
        if external_origin.is_none() {
            shell_prefetch.start(restart::read_login_shell);
        }
        Self {
            node: NodeRuntime::resolve(&runtime_root.join("bin")),
            server_entry: runtime_root.join("server/dist/index.mjs"),
            bundled_skills_dir: resources.bundle_dir.join("src").join("embedded_skills"),
            home_dir,
            preferred_port,
            external_origin,
            version,
            revision,
            running: Arc::default(),
            events: Some(events),
            shell_prefetch,
            proxy_watch: OnceLock::new(),
        }
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
        // A development origin (debug builds only) is a sidecar the developer
        // started themselves, outside the guard on every platform.
        if let Some(origin) = &self.external_origin {
            return Ok(self.ready_info(origin, None, 0));
        }
        if !bibliography_guard::AVAILABLE {
            return Ok(SynaraRuntimeInfo {
                state: "unsupported".to_string(),
                origin: None,
                auth_token: None,
                message: Some(bibliography_guard::MISSING.to_string()),
                startup_ms: None,
                version: self.version.clone(),
                revision: self.revision.clone(),
            });
        }
        let mut running = self.running.lock().map_err(|_| UNAVAILABLE.to_string())?;
        let mut reason = "start";
        if let Some(current) = running.as_mut() {
            if matches!(current.child.try_wait(), Ok(None)) {
                return Ok(current.info.clone());
            }
            // The managed child exited; start a new one.
            *running = None;
            reason = "restart_after_exit";
        }

        let operation = wide_event::Operation::start("synara.start", classify_start_error);
        operation.record("reason", reason);
        if let Some(version) = &self.version {
            operation.record("synara_version", version.as_str());
        }
        let info = operation.run_sync(|| {
            let started = Instant::now();
            let environment = environment::AgentEnvironment::resolve(
                self.shell_prefetch.take_or_read(restart::read_login_shell),
            );
            wide_event::record("inherited_env_vars", environment.len() as u64);
            if let Some(error) = environment.shell_error() {
                wide_event::record("login_shell_env", error.code());
            }
            let (mut child, auth_token, startup_logs) = self.spawn(&environment)?;
            let origin = wait_until_ready(&mut child, &startup_logs, &self.home_dir, started)
                .inspect_err(|_| terminate_process_group(&mut child))?;
            let startup_ms = started.elapsed().as_millis() as u64;
            let info = self.ready_info(&origin, Some(&auth_token), startup_ms);
            Ok((child, info, environment))
        });
        let (child, info, environment) = info?;
        *running = Some(RunningSynara { child, info: info.clone(), environment });
        drop(running);
        self.proxy_watch.get_or_init(|| {
            restart::watch_system_proxy(self.events.clone(), Arc::clone(&self.running))
        });
        // Windows hold the exited sidecar's token, and its tasks are gone:
        // they learn of this restart as of one asked for (`restart`).
        if reason == "restart_after_exit" {
            restart::announce(self.events.as_deref());
        }
        Ok(info)
    }

    /// Start the sidecar; returns its auth token and the stdout and stderr
    /// logs, with their lengths before this attempt started.
    fn spawn(
        &self, environment: &environment::AgentEnvironment,
    ) -> Result<(Child, String, [LogTail; 2]), String> {
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
        let log_dir = self.home_dir.join(SIDECAR_LOG_DIR);
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

        let executable = std::env::current_exe()
            .map_err(|error| format!("Could not locate the app executable: {error}"))?;
        let mut command =
            bibliography_guard::command(&self.node.executable, &self.home_dir, &executable)?;
        self.node.configure(&mut command);
        command.arg(&self.server_entry);
        // Web storage is scoped to the iframe origin, port included, so a
        // sidecar restarted within a session reuses its free port to keep the
        // storage its frames wrote. WebKit drops that storage at quit anyway,
        // so the fork keeps panel settings and drafts in its own state
        // directory (docs/synara-fork-ledger.md). Dynamic ports cover conflicts.
        let port = available_preferred_server_port(self.preferred_port);
        wide_event::record("port", if port.is_some() { "preferred" } else { "dynamic" });
        match port {
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
        environment.apply(&mut command);
        // After the shell's variables, so Lattice's Pi configuration wins.
        crate::model_endpoint::configure_sidecar(&mut command, &self.home_dir, &executable);
        let child = command
            .spawn()
            .map_err(|error| format!("Could not start the built-in agent service: {error}"))?;

        Ok((child, auth_token, startup_logs))
    }

    /// Under the agent home: the sidecar's logs, which a startup failure
    /// quotes from. A runtime that failed before writing any has none.
    pub fn sidecar_log_dir(&self) -> PathBuf {
        self.home_dir.join(SIDECAR_LOG_DIR)
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

/// The agent service's host task routes: compile repair edits the project; a
/// text task is one read-only turn whose final message is the answer
/// (proofreading).
pub const COMPILE_REPAIR_ROUTE: &str = "compile-repair";
pub const TEXT_TASK_ROUTE: &str = "text-task";
/// What a start answers when the running agent service predates the route, so
/// the renderer can say so instead of quoting an HTTP status.
pub const ROUTE_UNAVAILABLE: &str = "agent_route_unavailable";
/// What a compile repair status or cancel answers when the running agent
/// service does not know the thread. The route exists, since the task was
/// started on it: its poll and cancel answer an unknown thread with a
/// plain-text `Not Found` 404.
pub const TASK_UNKNOWN: &str = "agent_task_unknown";

/// One action on the task route `/api/lattice/<route>`: `start` posts
/// `payload`, `status` reads the task, `cancel` stops it. Keeps the desktop
/// token and loopback transport out of the renderer's CORS path.
pub fn task_relay_request(
    runtime: &SynaraRuntime, route: &str, action: &str, task_id: Option<&str>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let info = runtime.ensure_ready()?;
    // Where the agent is off (`bibliography_guard`), say why.
    let origin = info.origin.ok_or_else(|| {
        info.message.clone().unwrap_or_else(|| "The agent service is unavailable.".to_string())
    })?;
    let mut url = reqwest::Url::parse(&origin).map_err(|error| error.to_string())?;
    let mut segments = url.path_segments_mut().map_err(|_| "Invalid agent address.")?;
    segments.clear().extend(["api", "lattice", route]);
    match action {
        "start" => {}
        "status" | "cancel" => {
            let id = task_id.filter(|id| !id.is_empty()).ok_or("Missing agent task.")?;
            segments.push(id);
            if action == "cancel" {
                segments.push("cancel");
            }
        }
        _ => return Err("Invalid agent task action.".into()),
    }
    drop(segments);
    let client = crate::http::loopback(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request =
        if action == "status" { client.get(url) } else { client.post(url).json(&payload) };
    if let Some(token) = &info.auth_token {
        request = request.bearer_auth(token);
    }
    let response = request.send().map_err(|error| error.to_string())?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND
        && route == COMPILE_REPAIR_ROUTE
        && action != "start"
    {
        return Err(TASK_UNKNOWN.into());
    }
    let mut value: serde_json::Value = match response.json() {
        Ok(value) => value,
        // The start routes answer JSON, even their own 404s; a bare 404 is the
        // router's, for a path this runtime does not have.
        Err(_) if status == reqwest::StatusCode::NOT_FOUND => return Err(ROUTE_UNAVAILABLE.into()),
        Err(_) => return Err(format!("The agent service returned {status}.")),
    };
    if !status.is_success() {
        return Err(value["error"].as_str().unwrap_or("The agent request failed.").to_string());
    }
    // The service that took the repair, which can be one this request had to
    // start: its windows hear of that restart, and must not take it for the
    // loss of this task (useCompileRepair).
    if action == "start" && route == COMPILE_REPAIR_ROUTE {
        if let Some(answer) = value.as_object_mut() {
            answer.insert("runtimeSession".into(), serde_json::json!(info.auth_token));
        }
    }
    Ok(value)
}

/// What a failed agent start means for whoever reads the log. The startup
/// log excerpt in the cause is cut to its first line by the event; the full
/// text stays in sidecar.log and sidecar-error.log.
fn classify_start_error(error: &str) -> Failure {
    if error.starts_with("The bundled") {
        Failure {
            kind: "runtime_missing",
            fix: "Reinstall Lattice; the bundled agent runtime is incomplete.",
        }
    } else if error.contains("stopped during startup") {
        Failure {
            kind: "exited_during_startup",
            fix: "Click Open logs on the agent panel and read the end of sidecar-error.log.",
        }
    } else if error.contains("did not become ready") {
        Failure {
            kind: "startup_timeout",
            fix: "Quit other heavy apps or retry; the agent took too long to start.",
        }
    } else if error.starts_with("Could not create") || error.starts_with("Could not open") {
        Failure {
            kind: "data_dir_unwritable",
            fix: "Check the disk is not full and Lattice's data folder is writable.",
        }
    } else {
        Failure { kind: "start_error", fix: "Retry; if it keeps failing, report it with the log." }
    }
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
        wide_event::add("health_polls", 1);
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
    fn task_relay_preserves_payload_routes_and_server_errors() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr().to_ip().unwrap());
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in [
                (202, r#"{"threadId":"repair:one"}"#),
                (200, r#"{"status":"completed"}"#),
                (202, r#"{"status":"running"}"#),
                (409, r#"{"error":"Already repairing"}"#),
                (404, r#"{"error":"Workspace not found."}"#),
                (404, "Not Found"),
                (404, "Not Found"),
                (404, "Not Found"),
                (404, r#"{"error":"Task not found."}"#),
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
            task_relay_request(&runtime, COMPILE_REPAIR_ROUTE, action, thread_id, payload)
        };
        let null = serde_json::Value::Null;
        assert_eq!(request("start", None, payload.clone()).unwrap()["threadId"], "repair:one");
        assert_eq!(
            request("status", Some("repair:one"), null.clone()).unwrap()["status"],
            "completed"
        );
        assert_eq!(request("cancel", Some("repair:one"), null).unwrap()["status"], "running");
        assert_eq!(request("start", None, payload.clone()).unwrap_err(), "Already repairing");
        assert_eq!(request("start", None, payload.clone()).unwrap_err(), "Workspace not found.");
        // A runtime without the route answers the router's plain 404.
        let text_task = serde_json::json!({"workspaceRoot": "/paper", "prompt": "Proofread"});
        assert_eq!(
            task_relay_request(&runtime, TEXT_TASK_ROUTE, "start", None, text_task.clone())
                .unwrap_err(),
            ROUTE_UNAVAILABLE
        );
        assert_eq!(request("start", None, payload.clone()).unwrap_err(), ROUTE_UNAVAILABLE);
        // latticeCompileRepairHttpRoute's poll answers a thread it does not
        // know with `HttpServerResponse.text("Not Found", { status: 404 })`.
        let null = serde_json::Value::Null;
        assert_eq!(request("status", Some("repair:gone"), null.clone()).unwrap_err(), TASK_UNKNOWN);
        // An unknown text task is a JSON 404, whose error reaches the reader as is.
        assert_eq!(
            task_relay_request(&runtime, TEXT_TASK_ROUTE, "cancel", Some("text:gone"), null)
                .unwrap_err(),
            "Task not found."
        );

        let requests = server.join().unwrap();
        assert_eq!(requests[0].0, "POST /api/lattice/compile-repair");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&requests[0].1).unwrap(), payload);
        assert_eq!(requests[1].0, "GET /api/lattice/compile-repair/repair:one");
        assert!(requests[1].1.is_empty());
        assert_eq!(requests[2].0, "POST /api/lattice/compile-repair/repair:one/cancel");
        assert_eq!(requests[5].0, "POST /api/lattice/text-task");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&requests[5].1).unwrap(), text_task);
        assert_eq!(requests[6].0, "POST /api/lattice/compile-repair");
        assert_eq!(requests[7].0, "GET /api/lattice/compile-repair/repair:gone");
        assert_eq!(requests[8].0, "POST /api/lattice/text-task/text:gone/cancel");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn repair_start_answer_names_the_service_that_took_it() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr().to_ip().unwrap());
        let server = thread::spawn(move || {
            let request = server.recv().unwrap();
            let token = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Authorization"))
                .map(|header| header.value.to_string());
            let response = tiny_http::Response::from_string(r#"{"threadId":"repair:one"}"#)
                .with_status_code(202);
            request.respond(response).unwrap();
            token
        });
        let runtime = SynaraRuntime::default();
        let child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        *runtime.running.lock().unwrap() = Some(RunningSynara {
            child,
            info: runtime.ready_info(&origin, Some("launch-2"), 0),
            environment: environment::AgentEnvironment::default(),
        });
        let answer = task_relay_request(
            &runtime,
            COMPILE_REPAIR_ROUTE,
            "start",
            None,
            serde_json::json!({}),
        );
        let mut running = runtime.running.lock().unwrap().take().unwrap();
        let _ = running.child.kill();
        let _ = running.child.wait();
        let answer = answer.unwrap();
        assert_eq!(answer["threadId"], "repair:one");
        assert_eq!(answer["runtimeSession"], "launch-2");
        assert_eq!(server.join().unwrap().as_deref(), Some("Bearer launch-2"));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn stays_off_without_a_bibliography_guard() {
        let root = TempDir::new("synara-unguarded");
        let mut runtime = SynaraRuntime::default();
        runtime.home_dir = root.join("synara");
        let info = runtime.ensure_ready().unwrap();
        assert_eq!(info.state, "unsupported");
        assert_eq!(info.message.as_deref(), Some(bibliography_guard::MISSING));
        assert!(info.origin.is_none() && info.auth_token.is_none());
        // Nothing was started, nor its home prepared.
        assert!(runtime.running.lock().unwrap().is_none());
        assert!(!runtime.home_dir.exists());
        let error =
            task_relay_request(&runtime, TEXT_TASK_ROUTE, "start", None, serde_json::Value::Null)
                .unwrap_err();
        assert_eq!(error, bibliography_guard::MISSING);
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
        // Free once nothing else holds it, which can be a moment after the
        // drop. macOS has no atomic close-on-exec for a new socket: std sets
        // it a call after `socket()`, and a process another test spawns in
        // between inherits the listener and keeps the port until it exits.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut reused = available_preferred_server_port(Some(port));
        while reused.is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
            reused = available_preferred_server_port(Some(port));
        }
        assert_eq!(reused, Some(port));
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
