use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const VERSION: &str = "1.19.1";
const IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationInfo {
    state: String,
    origin: Option<String>,
    session_url: Option<String>,
    control_token: Option<String>,
    version: String,
    project_root: Option<String>,
    leases: usize,
    lease_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyLine {
    ready: bool,
    port: u16,
    session_token: String,
    control_token: String,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncOperation {
    path: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    base64: Option<String>,
}

#[derive(Serialize)]
struct SyncRequest {
    operations: Vec<SyncOperation>,
}

struct NativeFile {
    absolute: PathBuf,
    size: u64,
    digest: [u8; 32],
}

struct Running {
    child: Child,
    project_root: PathBuf,
    shadow_root: PathBuf,
    origin: String,
    session_url: String,
    control_token: String,
    leases: BTreeSet<String>,
    idle_generation: u64,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
}

#[derive(Clone)]
pub struct PresentationRuntime {
    node_path: PathBuf,
    entry_path: PathBuf,
    shadow_parent: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl PresentationRuntime {
    pub fn new(app: &tauri::App) -> Result<Self, Box<dyn std::error::Error>> {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let resources = if cfg!(debug_assertions) {
            manifest.clone()
        } else {
            app.path().resource_dir()?
        };
        let node = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };
        let shadow_parent = app.path().app_cache_dir()?.join("presentation-shadows");
        std::fs::create_dir_all(&shadow_parent)?;
        for entry in std::fs::read_dir(&shadow_parent)?.flatten() {
            if entry.file_name() != "vite-cache-1.19.1" {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
        Ok(Self {
            node_path: resources.join("synara-runtime/bin").join(node),
            entry_path: resources.join("presentation-runtime/server.mjs"),
            shadow_parent,
            inner: Arc::new(Mutex::new(Inner::default())),
        })
    }

    fn info(running: Option<&Running>, lease_id: Option<String>) -> PresentationInfo {
        PresentationInfo {
            state: if running.is_some() {
                "ready"
            } else {
                "stopped"
            }
            .into(),
            origin: running.map(|value| value.origin.clone()),
            session_url: running.map(|value| value.session_url.clone()),
            control_token: running.map(|value| value.control_token.clone()),
            version: VERSION.into(),
            project_root: running.map(|value| value.project_root.to_string_lossy().into_owned()),
            leases: running.map_or(0, |value| value.leases.len()),
            lease_id,
        }
    }

    fn scoped_root(value: &str) -> Result<PathBuf, String> {
        let root = std::fs::canonicalize(value)
            .map_err(|error| format!("Could not resolve the presentation project: {error}"))?;
        if !root.is_dir() {
            return Err("The presentation project must be a directory.".into());
        }
        Ok(root)
    }

    fn synchronize(source: &Path, destination: &Path) -> Result<(), String> {
        let staging = destination.with_extension(format!("staging-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
        let result = (|| {
            for native_root in ["slides", "assets", "themes", "open-slide.config.ts"] {
                let scoped = source.join(native_root);
                if !scoped.exists() || scoped.is_symlink() {
                    continue;
                }
                // Do not walk the project root and filter afterward. Research
                // projects often contain large Git histories and paper caches;
                // traversing those unrelated trees made the first deck open
                // take tens of seconds even though none of their files were
                // copied into the managed Open Slide workspace.
                for entry in walkdir::WalkDir::new(scoped)
                    .follow_links(false)
                    .into_iter()
                {
                    let entry = entry.map_err(|error| error.to_string())?;
                    let relative = entry
                        .path()
                        .strip_prefix(source)
                        .map_err(|error| error.to_string())?;
                    if !Self::is_native_path(relative) || entry.file_type().is_symlink() {
                        continue;
                    }
                    let target = staging.join(relative);
                    if entry.file_type().is_dir() {
                        std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
                    } else {
                        if let Some(parent) = target.parent() {
                            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                        }
                        std::fs::copy(entry.path(), target).map_err(|error| error.to_string())?;
                    }
                }
            }
            let _ = std::fs::remove_dir_all(destination);
            std::fs::rename(&staging, destination).map_err(|error| error.to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(staging);
        }
        result
    }

    fn is_native_path(relative: &Path) -> bool {
        relative == Path::new("open-slide.config.ts")
            || relative.starts_with("slides")
            || relative.starts_with("assets")
            || relative.starts_with("themes")
    }

    fn native_file(path: &Path) -> Result<NativeFile, String> {
        let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let size = file.metadata().map_err(|error| error.to_string())?.len();
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        Ok(NativeFile {
            absolute: path.to_path_buf(),
            size,
            digest: digest.finalize().into(),
        })
    }

    fn native_files(root: &Path) -> Result<BTreeMap<String, NativeFile>, String> {
        let mut files = BTreeMap::new();
        let roots = [
            root.join("slides"),
            root.join("assets"),
            root.join("themes"),
            root.join("open-slide.config.ts"),
        ];
        for scoped in roots {
            if !scoped.exists() || scoped.is_symlink() {
                continue;
            }
            if scoped.is_file() {
                let relative = scoped
                    .strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                files.insert(relative, Self::native_file(&scoped)?);
                continue;
            }
            for entry in walkdir::WalkDir::new(&scoped)
                .follow_links(false)
                .into_iter()
            {
                let entry = entry.map_err(|error| error.to_string())?;
                if !entry.file_type().is_file() || entry.path_is_symlink() {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                files.insert(relative, Self::native_file(entry.path())?);
            }
        }
        Ok(files)
    }

    pub fn refresh(&self, project_root: &str) -> Result<(), String> {
        let root = Self::scoped_root(project_root)?;
        let (shadow, origin, token) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Presentation runtime lock failed")?;
            let Some(running) = inner.running.as_mut() else {
                return Ok(());
            };
            if running.project_root != root {
                return Ok(());
            }
            if running
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                let stopped = inner.running.take().unwrap();
                let _ = std::fs::remove_dir_all(stopped.shadow_root);
                return Ok(());
            }
            (
                running.shadow_root.clone(),
                running.origin.clone(),
                running.control_token.clone(),
            )
        };
        let source = Self::native_files(&root)?;
        let mirrored = Self::native_files(&shadow)?;
        let mut operations = Vec::new();
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(300))
            .no_proxy()
            .build()
            .map_err(|error| error.to_string())?;
        for (path, file) in &source {
            if mirrored
                .get(path)
                .is_some_and(|other| other.size == file.size && other.digest == file.digest)
            {
                continue;
            }
            let body = std::fs::File::open(&file.absolute).map_err(|error| error.to_string())?;
            let response = client
                .put(format!("{origin}/__lattice/file"))
                .bearer_auth(&token)
                .query(&[("path", path)])
                .body(body)
                .send()
                .map_err(|error| format!("Could not refresh {path} in Open Slide: {error}"))?;
            if !response.status().is_success() {
                return Err(format!(
                    "Open Slide refresh failed for {path} ({}): {}",
                    response.status(),
                    response.text().unwrap_or_default()
                ));
            }
        }
        for path in mirrored.keys() {
            if !source.contains_key(path) {
                operations.push(SyncOperation {
                    path: path.clone(),
                    kind: "delete".into(),
                    base64: None,
                });
            }
        }
        if operations.is_empty() {
            return Ok(());
        }
        let response = client
            .post(format!("{origin}/__lattice/sync"))
            .bearer_auth(token)
            .json(&SyncRequest { operations })
            .send()
            .map_err(|error| format!("Could not refresh Open Slide: {error}"))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!(
                "Open Slide refresh failed ({}): {}",
                response.status(),
                response.text().unwrap_or_default()
            ))
        }
    }

    pub fn ensure(&self, project_root: &str) -> Result<PresentationInfo, String> {
        let root = Self::scoped_root(project_root)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Presentation runtime lock failed")?;
        if inner.running.as_mut().is_some_and(|running| {
            running.project_root == root && running.child.try_wait().ok().flatten().is_none()
        }) {
            let running = inner.running.as_mut().unwrap();
            let lease_id = uuid::Uuid::new_v4().to_string();
            running.leases.insert(lease_id.clone());
            running.idle_generation = running.idle_generation.wrapping_add(1);
            return Ok(Self::info(Some(running), Some(lease_id)));
        }
        if inner.running.as_mut().is_some_and(|running| {
            running.project_root != root
                && running.child.try_wait().ok().flatten().is_none()
                && !running.leases.is_empty()
        }) {
            return Err(
                "Another project's presentation is open. Close it before opening this deck.".into(),
            );
        }
        if let Some(mut previous) = inner.running.take() {
            stop_child(&mut previous.child);
            let _ = std::fs::remove_dir_all(previous.shadow_root);
        }
        // The workspace contents are replaced transactionally for every
        // runtime, but its path stays stable so Vite can reuse its dependency
        // cache after the 15-second idle shutdown.
        let shadow = self.shadow_parent.join("workspace");
        if let Err(error) = Self::synchronize(&root, &shadow) {
            let _ = std::fs::remove_dir_all(&shadow);
            return Err(error);
        }
        let control_token = uuid::Uuid::new_v4().simple().to_string();
        let mut command = Command::new(&self.node_path);
        command
            .arg(&self.entry_path)
            .current_dir(&shadow)
            .env("OPEN_SLIDE_SHADOW_ROOT", &shadow)
            .env(
                "OPEN_SLIDE_CACHE_ROOT",
                self.shadow_parent.join("vite-cache-1.19.1"),
            )
            .env("OPEN_SLIDE_CONTROL_TOKEN", &control_token)
            // The pipe is a zero-polling parent-liveness signal. In dev mode
            // Tauri may replace this process without running normal shutdown;
            // EOF then stops the old Node runtime instead of leaving one
            // orphan behind after every Rust rebuild.
            .env("OPEN_SLIDE_PARENT_PIPE", "1")
            // Vite's dependency optimizer can otherwise retain several
            // hundred MiB during its first Open Slide compile.
            .env("GOMEMLIMIT", "64MiB")
            .env("NODE_OPTIONS", "--max-old-space-size=128 --expose-gc")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&shadow);
                return Err(format!("Could not start Open Slide: {error}"));
            }
        };
        let Some(stdout) = child.stdout.take() else {
            stop_child(&mut child);
            let _ = std::fs::remove_dir_all(&shadow);
            return Err("Open Slide did not expose readiness output".into());
        };
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log::warn!(target: "lattice::presentation", "{line}");
                }
            });
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout)
                .read_line(&mut line)
                .map(|_| line)
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        });
        let line = match receiver.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => {
                stop_child(&mut child);
                let _ = std::fs::remove_dir_all(&shadow);
                return Err(format!("Open Slide startup failed: {error}"));
            }
            Err(_) => {
                stop_child(&mut child);
                let _ = std::fs::remove_dir_all(&shadow);
                return Err("Open Slide did not become ready within 30 seconds.".into());
            }
        };
        let ready: ReadyLine = match serde_json::from_str(line.trim()) {
            Ok(ready) => ready,
            Err(error) => {
                stop_child(&mut child);
                let _ = std::fs::remove_dir_all(&shadow);
                return Err(format!("Open Slide startup failed: {error}"));
            }
        };
        if !ready.ready || ready.control_token != control_token || ready.version != VERSION {
            stop_child(&mut child);
            let _ = std::fs::remove_dir_all(&shadow);
            return Err("Open Slide returned invalid readiness data.".into());
        }
        let origin = format!("http://127.0.0.1:{}", ready.port);
        let lease_id = uuid::Uuid::new_v4().to_string();
        inner.running = Some(Running {
            child,
            project_root: root,
            shadow_root: shadow,
            session_url: format!("{origin}/__lattice/bootstrap?token={}", ready.session_token),
            origin,
            control_token,
            leases: BTreeSet::from([lease_id.clone()]),
            idle_generation: 0,
        });
        Ok(Self::info(inner.running.as_ref(), Some(lease_id)))
    }

    pub fn release(&self, project_root: &str, lease_id: &str) -> Result<(), String> {
        let root = Self::scoped_root(project_root)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Presentation runtime lock failed")?;
        let Some(running) = inner
            .running
            .as_mut()
            .filter(|running| running.project_root == root)
        else {
            return Ok(());
        };
        if !running.leases.remove(lease_id) {
            return Ok(());
        }
        remove_access_lease(
            running.origin.clone(),
            running.control_token.clone(),
            lease_id.to_string(),
        );
        if !running.leases.is_empty() {
            return Ok(());
        }
        running.idle_generation = running.idle_generation.wrapping_add(1);
        let generation = running.idle_generation;
        let state = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            std::thread::sleep(IDLE_TIMEOUT);
            if let Ok(mut inner) = state.lock() {
                if inner
                    .running
                    .as_ref()
                    .is_some_and(|r| r.leases.is_empty() && r.idle_generation == generation)
                {
                    if let Some(mut running) = inner.running.take() {
                        stop_child(&mut running.child);
                        let _ = std::fs::remove_dir_all(running.shadow_root);
                    }
                }
            }
        });
        Ok(())
    }

    pub fn status(&self) -> PresentationInfo {
        self.inner
            .lock()
            .map(|inner| Self::info(inner.running.as_ref(), None))
            .unwrap_or_else(|_| Self::info(None, None))
    }
    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(mut running) = inner.running.take() {
                stop_child(&mut running.child);
                let _ = std::fs::remove_dir_all(running.shadow_root);
            }
        }
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}
#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}
fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .status();
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
}

fn remove_access_lease(origin: String, control_token: String, lease_id: String) {
    std::thread::spawn(move || {
        let Ok(client) = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .no_proxy()
            .build()
        else {
            return;
        };
        let _ = client
            .post(format!("{origin}/__lattice/access"))
            .bearer_auth(control_token)
            .json(&serde_json::json!({ "leaseId": lease_id, "remove": true }))
            .send();
    });
}

#[tauri::command]
pub async fn presentation_ensure_ready(
    runtime: tauri::State<'_, PresentationRuntime>,
    project_root: String,
) -> Result<PresentationInfo, String> {
    let runtime = (*runtime).clone();
    tauri::async_runtime::spawn_blocking(move || runtime.ensure(&project_root))
        .await
        .map_err(|error| format!("Open Slide startup stopped unexpectedly: {error}"))?
}
#[tauri::command]
pub fn presentation_release(
    runtime: tauri::State<'_, PresentationRuntime>,
    project_root: String,
    lease_id: String,
) -> Result<(), String> {
    runtime.release(&project_root, &lease_id)
}
#[tauri::command]
pub fn presentation_runtime_status(
    runtime: tauri::State<'_, PresentationRuntime>,
) -> PresentationInfo {
    runtime.status()
}

#[tauri::command]
pub async fn presentation_refresh_native_workspace(
    runtime: tauri::State<'_, PresentationRuntime>,
    project_root: String,
) -> Result<(), String> {
    let runtime = (*runtime).clone();
    tauri::async_runtime::spawn_blocking(move || runtime.refresh(&project_root))
        .await
        .map_err(|error| format!("Open Slide refresh stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::PresentationRuntime;
    use std::path::Path;

    #[test]
    fn only_canonical_directories_are_projects() {
        assert!(PresentationRuntime::scoped_root("definitely-missing").is_err());
    }

    #[test]
    fn shadows_only_native_open_slide_workspace_paths() {
        assert!(PresentationRuntime::is_native_path(Path::new(
            "slides/research-update/index.tsx"
        )));
        assert!(PresentationRuntime::is_native_path(Path::new(
            "assets/chart.png"
        )));
        assert!(PresentationRuntime::is_native_path(Path::new(
            "open-slide.config.ts"
        )));
        assert!(!PresentationRuntime::is_native_path(Path::new("main.tex")));
        assert!(!PresentationRuntime::is_native_path(Path::new(
            "slides-backup/index.tsx"
        )));
    }

    #[cfg(unix)]
    #[test]
    fn shadow_sync_does_not_walk_unrelated_project_directories() {
        use std::os::unix::fs::PermissionsExt;

        let parent = std::env::temp_dir().join(format!(
            "lattice-presentation-shadow-{}",
            uuid::Uuid::new_v4()
        ));
        let source = parent.join("project");
        let shadow = parent.join("shadow");
        let unrelated = source.join("large-paper-cache");
        std::fs::create_dir_all(source.join("slides/talk")).unwrap();
        std::fs::write(source.join("slides/talk/index.tsx"), "export default [];\n").unwrap();
        std::fs::create_dir_all(&unrelated).unwrap();
        std::fs::set_permissions(&unrelated, std::fs::Permissions::from_mode(0o000)).unwrap();

        let result = PresentationRuntime::synchronize(&source, &shadow);
        std::fs::set_permissions(&unrelated, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            std::fs::read_to_string(shadow.join("slides/talk/index.tsx")).unwrap(),
            "export default [];\n"
        );
        assert!(!shadow.join("large-paper-cache").exists());
        std::fs::remove_dir_all(parent).unwrap();
    }
}
