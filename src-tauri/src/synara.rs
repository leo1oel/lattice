use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(50);
const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(2);
const RUNTIME_STATE_RELATIVE_PATH: &str = "userdata/server-runtime.json";

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

impl SynaraRuntimeInfo {
    fn ready(
        origin: String,
        auth_token: Option<String>,
        startup_ms: u64,
        version: Option<String>,
        revision: Option<String>,
    ) -> Self {
        Self {
            state: "ready".to_string(),
            origin: Some(origin),
            auth_token,
            message: None,
            startup_ms: Some(startup_ms),
            version,
            revision,
        }
    }

    fn stopped(message: Option<String>, version: Option<String>, revision: Option<String>) -> Self {
        Self {
            state: "stopped".to_string(),
            origin: None,
            auth_token: None,
            message,
            startup_ms: None,
            version,
            revision,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledRuntimeManifest {
    synara_version: Option<String>,
    synara_revision: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PersistedServerRuntimeState {
    pid: u32,
    origin: String,
}

struct RunningSynara {
    child: Child,
    origin: String,
    auth_token: String,
    startup_ms: u64,
    startup_logs: StartupLogs,
}

struct StartupLogs {
    stdout_path: PathBuf,
    stdout_offset: u64,
    stderr_path: PathBuf,
    stderr_offset: u64,
}

#[derive(Default)]
struct RuntimeState {
    running: Option<RunningSynara>,
    last_error: Option<String>,
}

pub struct SynaraRuntime {
    node_path: PathBuf,
    server_entry: PathBuf,
    bundled_skills_dir: PathBuf,
    home_dir: PathBuf,
    external_origin: Option<String>,
    version: Option<String>,
    revision: Option<String>,
    state: Mutex<RuntimeState>,
}

impl SynaraRuntime {
    pub fn new(app: &tauri::App) -> Result<Self, Box<dyn std::error::Error>> {
        let external_origin = if cfg!(debug_assertions) {
            std::env::var("VITE_SYNARA_EMBED_URL")
                .ok()
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
        } else {
            None
        };
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let (runtime_root, bundled_skills_dir) = if cfg!(debug_assertions) {
            (
                manifest_dir.join("synara-runtime"),
                manifest_dir.join("src").join("embedded_skills"),
            )
        } else {
            let resource_dir = app.path().resource_dir()?;
            (
                resource_dir.join("synara-runtime"),
                resource_dir.join("src").join("embedded_skills"),
            )
        };
        let executable_name = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };
        let manifest = read_runtime_manifest(&runtime_root.join("manifest.json"));
        let home_dir = app.path().app_data_dir()?.join("synara");

        Ok(Self {
            node_path: runtime_root.join("bin").join(executable_name),
            server_entry: runtime_root.join("server/dist/index.mjs"),
            bundled_skills_dir,
            home_dir,
            external_origin,
            version: manifest
                .as_ref()
                .and_then(|manifest| manifest.synara_version.clone()),
            revision: manifest
                .as_ref()
                .and_then(|manifest| manifest.synara_revision.clone()),
            state: Mutex::new(RuntimeState::default()),
        })
    }

    fn info_for_running(&self, running: &RunningSynara) -> SynaraRuntimeInfo {
        SynaraRuntimeInfo::ready(
            running.origin.clone(),
            Some(running.auth_token.clone()),
            running.startup_ms,
            self.version.clone(),
            self.revision.clone(),
        )
    }

    pub fn status(&self) -> SynaraRuntimeInfo {
        if let Some(origin) = &self.external_origin {
            return SynaraRuntimeInfo::ready(
                origin.clone(),
                None,
                0,
                self.version.clone(),
                self.revision.clone(),
            );
        }

        let Ok(mut state) = self.state.lock() else {
            return SynaraRuntimeInfo::stopped(
                Some("The built-in agent service is unavailable.".to_string()),
                self.version.clone(),
                self.revision.clone(),
            );
        };
        if let Some(running) = state.running.as_mut() {
            match running.child.try_wait() {
                Ok(None) => return self.info_for_running(running),
                Ok(Some(status)) => {
                    state.last_error =
                        Some(format!("The agent service stopped with status {status}."));
                    state.running = None;
                }
                Err(error) => {
                    state.last_error =
                        Some(format!("Could not inspect the agent service: {error}"));
                    state.running = None;
                }
            }
        }
        SynaraRuntimeInfo::stopped(
            state.last_error.clone(),
            self.version.clone(),
            self.revision.clone(),
        )
    }

    pub fn ensure_ready(&self) -> Result<SynaraRuntimeInfo, String> {
        if let Some(origin) = &self.external_origin {
            return Ok(SynaraRuntimeInfo::ready(
                origin.clone(),
                None,
                0,
                self.version.clone(),
                self.revision.clone(),
            ));
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| "The built-in agent service is unavailable.".to_string())?;
        if let Some(running) = state.running.as_mut() {
            match running.child.try_wait() {
                Ok(None) => return Ok(self.info_for_running(running)),
                Ok(Some(status)) => {
                    state.last_error =
                        Some(format!("The agent service stopped with status {status}."));
                    state.running = None;
                }
                Err(error) => {
                    state.last_error =
                        Some(format!("Could not inspect the agent service: {error}"));
                    state.running = None;
                }
            }
        }

        let started = Instant::now();
        let mut running = self.spawn()?;
        match wait_until_ready(&mut running, &self.home_dir, started) {
            Ok(origin) => {
                running.origin = origin;
                running.startup_ms = started.elapsed().as_millis() as u64;
                let info = self.info_for_running(&running);
                state.last_error = None;
                state.running = Some(running);
                Ok(info)
            }
            Err(error) => {
                terminate_process_tree(&mut running.child);
                state.last_error = Some(error.clone());
                Err(error)
            }
        }
    }

    fn spawn(&self) -> Result<RunningSynara, String> {
        if !self.node_path.is_file() {
            return Err(format!(
                "The bundled Synara runtime is missing at {}.",
                self.node_path.display()
            ));
        }
        if !self.server_entry.is_file() {
            return Err(format!(
                "The bundled Synara service is missing at {}.",
                self.server_entry.display()
            ));
        }

        fs::create_dir_all(&self.home_dir)
            .map_err(|error| format!("Could not create the agent data directory: {error}"))?;
        let runtime_state_path = self.home_dir.join(RUNTIME_STATE_RELATIVE_PATH);
        let _ = fs::remove_file(runtime_state_path);
        let log_dir = self.home_dir.join("lattice-logs");
        fs::create_dir_all(&log_dir)
            .map_err(|error| format!("Could not create the agent log directory: {error}"))?;
        let stdout_path = log_dir.join("sidecar.log");
        let stderr_path = log_dir.join("sidecar-error.log");
        let startup_logs = StartupLogs {
            stdout_offset: file_len(&stdout_path),
            stderr_offset: file_len(&stderr_path),
            stdout_path: stdout_path.clone(),
            stderr_path: stderr_path.clone(),
        };
        let stdout = append_log(&stdout_path)?;
        let stderr = append_log(&stderr_path)?;
        let auth_token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let shutdown_token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());

        let mut command = Command::new(&self.node_path);
        command
            .arg(&self.server_entry)
            .arg("--dynamic-port")
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
            .envs(
                std::env::current_exe()
                    .ok()
                    .map(|path| ("LATTICE_BIN", path.into_os_string())),
            )
            .env("SYNARA_AUTH_TOKEN", &auth_token)
            .env("SYNARA_DESKTOP_SHUTDOWN_TOKEN", shutdown_token)
            .env("SYNARA_DESKTOP_PARENT_PID", std::process::id().to_string())
            .env("SYNARA_TELEMETRY_ENABLED", "false")
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("Could not start the built-in agent service: {error}"))?;

        Ok(RunningSynara {
            child,
            origin: String::new(),
            auth_token,
            startup_ms: 0,
            startup_logs,
        })
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(mut running) = state.running.take() {
                terminate_process_tree(&mut running.child);
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
pub fn synara_runtime_status(state: tauri::State<'_, SynaraRuntime>) -> SynaraRuntimeInfo {
    state.status()
}

#[tauri::command]
pub fn synara_ensure_ready(
    state: tauri::State<'_, SynaraRuntime>,
) -> Result<SynaraRuntimeInfo, String> {
    state.ensure_ready()
}

#[tauri::command]
pub fn synara_open_skills_folder(app: tauri::AppHandle) -> Result<(), String> {
    let skills_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("synara")
        .join("skills");
    fs::create_dir_all(&skills_dir).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(skills_dir.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| error.to_string())
}

fn read_runtime_manifest(path: &Path) -> Option<BundledRuntimeManifest> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn append_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn wait_until_ready(
    running: &mut RunningSynara,
    home_dir: &Path,
    started: Instant,
) -> Result<String, String> {
    let runtime_state_path = home_dir.join(RUNTIME_STATE_RELATIVE_PATH);
    let client = Client::builder()
        // The bundled service only listens on loopback. Never route its health
        // check through HTTP(S)_PROXY or ALL_PROXY, which can make a healthy
        // sidecar look unavailable until the startup timeout expires.
        .no_proxy()
        .timeout(Duration::from_millis(350))
        .build()
        .map_err(|error| format!("Could not initialize the agent health check: {error}"))?;

    while started.elapsed() < STARTUP_TIMEOUT {
        if let Some(status) = running
            .child
            .try_wait()
            .map_err(|error| format!("Could not inspect agent startup: {error}"))?
        {
            return Err(startup_exit_message(status, &running.startup_logs));
        }
        if let Some(runtime) = read_server_runtime_state(&runtime_state_path) {
            if runtime.pid == running.child.id() && health_is_ready(&client, &runtime.origin) {
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

fn startup_exit_message(status: std::process::ExitStatus, logs: &StartupLogs) -> String {
    let detail = startup_log_excerpt(logs)
        .map(|excerpt| format!(" Startup log: {excerpt}"))
        .unwrap_or_default();
    format!("The built-in agent stopped during startup with status {status}.{detail}")
}

fn startup_log_excerpt(logs: &StartupLogs) -> Option<String> {
    let output = [
        read_log_since(&logs.stdout_path, logs.stdout_offset),
        read_log_since(&logs.stderr_path, logs.stderr_offset),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n");
    let lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }

    let noteworthy = lines
        .iter()
        .copied()
        .filter(|line| {
            let normalized = line.to_ascii_lowercase();
            [
                "error",
                "failed",
                "locked",
                "missing",
                "denied",
                "unrecognized",
            ]
            .iter()
            .any(|marker| normalized.contains(marker))
        })
        .collect::<Vec<_>>();
    let selected = if noteworthy.is_empty() {
        &lines[lines.len().saturating_sub(4)..]
    } else {
        &noteworthy[noteworthy.len().saturating_sub(4)..]
    };
    let excerpt = selected.join(" | ");
    let char_count = excerpt.chars().count();
    Some(if char_count > 1_200 {
        format!(
            "…{}",
            excerpt.chars().skip(char_count - 1_200).collect::<String>()
        )
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

fn read_server_runtime_state(path: &Path) -> Option<PersistedServerRuntimeState> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn health_is_ready(client: &Client, origin: &str) -> bool {
    let Ok(response) = client.get(format!("{origin}/health")).send() else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<serde_json::Value>()
        .ok()
        .and_then(|value| {
            value
                .get("startupReady")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

fn terminate_process_tree(child: &mut Child) {
    let process_id = child.id();
    #[cfg(unix)]
    unsafe {
        if let Ok(process_group) = i32::try_from(process_id) {
            libc::kill(-process_group, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &process_id.to_string(), "/T"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let deadline = Instant::now() + SHUTDOWN_GRACE_PERIOD;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }

    #[cfg(unix)]
    unsafe {
        if let Ok(process_group) = i32::try_from(process_id) {
            libc::kill(-process_group, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::{health_is_ready, read_runtime_manifest, startup_log_excerpt, StartupLogs};
    use std::fs;

    #[test]
    fn reads_the_bundled_runtime_manifest() {
        let root = std::env::temp_dir().join(format!("lattice-synara-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("manifest.json");
        fs::write(
            &path,
            r#"{"synaraVersion":"0.6.3","synaraRevision":"abc123"}"#,
        )
        .expect("write manifest");
        let manifest = read_runtime_manifest(&path).expect("read manifest");
        assert_eq!(manifest.synara_version.as_deref(), Some("0.6.3"));
        assert_eq!(manifest.synara_revision.as_deref(), Some("abc123"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn health_check_rejects_an_unreachable_server() {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(10))
            .build()
            .expect("client");
        assert!(!health_is_ready(&client, "http://127.0.0.1:1"));
    }

    #[test]
    fn startup_log_excerpt_only_reports_the_current_attempt() {
        let root = std::env::temp_dir().join(format!("lattice-synara-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp directory");
        let stdout_path = root.join("sidecar.log");
        let stderr_path = root.join("sidecar-error.log");
        let previous = "DatabaseLifecycleLockedError: previous attempt\n";
        fs::write(&stdout_path, previous).expect("write previous log");
        fs::write(&stderr_path, "").expect("write empty error log");
        let logs = StartupLogs {
            stdout_path: stdout_path.clone(),
            stdout_offset: previous.len() as u64,
            stderr_path: stderr_path.clone(),
            stderr_offset: 0,
        };
        fs::write(
            &stdout_path,
            format!("{previous}DatabaseLifecycleLockedError: owner pid 42 is live\n"),
        )
        .expect("append current log");

        let excerpt = startup_log_excerpt(&logs).expect("startup excerpt");
        assert_eq!(
            excerpt,
            "DatabaseLifecycleLockedError: owner pid 42 is live"
        );
        let _ = fs::remove_dir_all(root);
    }
}
