//! Supervisor for the embedded Open Slide presentation runtime.
//!
//! Open Slide runs as a loopback Node service over a *shadow* copy of the
//! project's native deck files (`NATIVE_ROOTS`). Editors hold leases on the
//! running project; the service stops `IDLE_TIMEOUT` after the last lease is
//! released, and only one project can hold leases at a time.

use crate::chromium::{terminate_process_group, NodeRuntime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::Manager;
use walkdir::{DirEntry, WalkDir};

const VERSION: &str = "2.0.1";
const IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// The only project paths mirrored into the Open Slide workspace.
const NATIVE_ROOTS: [&str; 4] = ["slides", "assets", "themes", "open-slide.config.ts"];

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
struct DeleteOperation<'a> {
    path: &'a str,
    kind: &'static str,
}

/// A native file's location and the `(size, SHA-256)` that detects edits.
struct NativeFile {
    absolute: PathBuf,
    fingerprint: (u64, [u8; 32]),
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

impl Running {
    fn stop(mut self) {
        terminate_process_group(&mut self.child);
        let _ = fs::remove_dir_all(self.shadow_root);
    }

    /// Grant a new lease, which also cancels any pending idle shutdown.
    fn lease(&mut self) -> PresentationInfo {
        let lease_id = uuid::Uuid::new_v4().to_string();
        self.leases.insert(lease_id.clone());
        self.idle_generation = self.idle_generation.wrapping_add(1);
        PresentationInfo {
            state: "ready".into(),
            origin: Some(self.origin.clone()),
            session_url: Some(self.session_url.clone()),
            control_token: Some(self.control_token.clone()),
            version: VERSION.into(),
            project_root: Some(self.project_root.to_string_lossy().into_owned()),
            leases: self.leases.len(),
            lease_id: Some(lease_id),
        }
    }
}

#[derive(Clone)]
pub struct PresentationRuntime {
    node: NodeRuntime,
    entry_path: PathBuf,
    shadow_parent: PathBuf,
    running: Arc<Mutex<Option<Running>>>,
}

impl PresentationRuntime {
    pub fn new(app: &tauri::App) -> Result<Self, Box<dyn std::error::Error>> {
        // A debug package has debug assertions but still owns a copied resource
        // tree. Only `tauri dev` should resolve Open Slide from the checkout.
        let resources = if tauri::is_dev() {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        } else {
            app.path().resource_dir()?
        };
        let shadow_parent = app.path().app_cache_dir()?.join("presentation-shadows");
        fs::create_dir_all(&shadow_parent)?;
        for entry in fs::read_dir(&shadow_parent)?.flatten() {
            if entry.file_name() != format!("vite-cache-{VERSION}").as_str() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
        Ok(Self {
            node: NodeRuntime::resolve(&resources, &resources.join("synara-runtime/bin")),
            entry_path: resources.join("presentation-runtime/server.mjs"),
            shadow_parent,
            running: Arc::default(),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<Running>>, String> {
        self.running.lock().map_err(|_| "Presentation runtime lock failed".to_string())
    }

    pub fn refresh(&self, project_root: &str) -> Result<(), String> {
        let root = scoped_root(project_root)?;
        let (shadow, origin, token) = {
            let mut running = self.lock()?;
            let Some(current) = running.as_mut().filter(|running| running.project_root == root)
            else {
                return Ok(());
            };
            if current.child.try_wait().map_err(|error| error.to_string())?.is_some() {
                let _ = fs::remove_dir_all(running.take().unwrap().shadow_root);
                return Ok(());
            }
            (current.shadow_root.clone(), current.origin.clone(), current.control_token.clone())
        };
        let source = native_files(&root)?;
        let mirrored = native_files(&shadow)?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(300))
            .no_proxy()
            .build()
            .map_err(|error| error.to_string())?;
        for (path, file) in &source {
            if mirrored.get(path).is_some_and(|other| other.fingerprint == file.fingerprint) {
                continue;
            }
            let body = fs::File::open(&file.absolute).map_err(|error| error.to_string())?;
            let response = client
                .put(format!("{origin}/__lattice/file"))
                .bearer_auth(&token)
                .query(&[("path", path)])
                .body(body)
                .send()
                .map_err(|error| format!("Could not refresh {path} in Open Slide: {error}"))?;
            refreshed(response, &format!(" for {path}"))?;
        }
        let operations = mirrored
            .keys()
            .filter(|path| !source.contains_key(*path))
            .map(|path| DeleteOperation { path, kind: "delete" })
            .collect::<Vec<_>>();
        if operations.is_empty() {
            return Ok(());
        }
        let response = client
            .post(format!("{origin}/__lattice/sync"))
            .bearer_auth(token)
            .json(&serde_json::json!({ "operations": operations }))
            .send()
            .map_err(|error| format!("Could not refresh Open Slide: {error}"))?;
        refreshed(response, "")
    }

    pub fn ensure(&self, project_root: &str) -> Result<PresentationInfo, String> {
        let root = scoped_root(project_root)?;
        let mut running = self.lock()?;
        if let Some(current) = running.as_mut() {
            if current.child.try_wait().ok().flatten().is_none() {
                if current.project_root == root {
                    return Ok(current.lease());
                }
                if !current.leases.is_empty() {
                    return Err("Another project's presentation is open. Close it before opening this deck.".into());
                }
            }
        }
        if let Some(previous) = running.take() {
            previous.stop();
        }
        Ok(running.insert(self.launch(root)?).lease())
    }

    /// Mirror `root` into the shadow workspace and start Open Slide over it.
    fn launch(&self, root: PathBuf) -> Result<Running, String> {
        // The workspace contents are replaced transactionally for every
        // runtime, but its path stays stable so Vite can reuse its dependency
        // cache after the 15-second idle shutdown.
        let shadow = self.shadow_parent.join("workspace");
        let control_token = uuid::Uuid::new_v4().simple().to_string();
        let started =
            synchronize(&root, &shadow).and_then(|()| self.spawn(&shadow, &control_token));
        let (child, ready) = started.inspect_err(|_| {
            let _ = fs::remove_dir_all(&shadow);
        })?;
        let origin = format!("http://127.0.0.1:{}", ready.port);
        Ok(Running {
            child,
            project_root: root,
            shadow_root: shadow,
            session_url: format!("{origin}/__lattice/bootstrap?token={}", ready.session_token),
            origin,
            control_token,
            leases: BTreeSet::new(),
            idle_generation: 0,
        })
    }

    fn spawn(&self, shadow: &Path, control_token: &str) -> Result<(Child, ReadyLine), String> {
        let mut command = Command::new(&self.node.executable);
        self.node.configure(&mut command);
        command
            .arg(&self.entry_path)
            .current_dir(shadow)
            .env("OPEN_SLIDE_SHADOW_ROOT", shadow)
            .env("OPEN_SLIDE_CACHE_ROOT", self.shadow_parent.join(format!("vite-cache-{VERSION}")))
            .env("OPEN_SLIDE_CONTROL_TOKEN", control_token)
            // The pipe is a zero-polling parent-liveness signal. In dev mode
            // Tauri may replace this process without running normal shutdown;
            // EOF then stops the old Node runtime instead of leaving one
            // orphan behind after every Rust rebuild.
            .env("OPEN_SLIDE_PARENT_PIPE", "1")
            // Vite's dependency optimizer can otherwise retain several
            // hundred MiB during its first Open Slide compile. Keep a bounded
            // heap, but leave enough headroom for a deck transform to overlap
            // the optimizer's peak before the explicit idle collection runs.
            .env("NODE_OPTIONS", "--max-old-space-size=1024 --expose-gc")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child =
            command.spawn().map_err(|error| format!("Could not start Open Slide: {error}"))?;
        let ready = await_ready(&mut child, control_token)?;
        Ok((child, ready))
    }

    pub fn release(&self, project_root: &str, lease_id: &str) -> Result<(), String> {
        let root = scoped_root(project_root)?;
        let mut running = self.lock()?;
        let Some(current) = running.as_mut().filter(|running| running.project_root == root) else {
            return Ok(());
        };
        if !current.leases.remove(lease_id) {
            return Ok(());
        }
        remove_access_lease(
            current.origin.clone(),
            current.control_token.clone(),
            lease_id.to_string(),
        );
        if !current.leases.is_empty() {
            return Ok(());
        }
        current.idle_generation = current.idle_generation.wrapping_add(1);
        let generation = current.idle_generation;
        let state = Arc::clone(&self.running);
        thread::spawn(move || {
            thread::sleep(IDLE_TIMEOUT);
            if let Ok(mut running) = state.lock() {
                let idle = running.take_if(|running| {
                    running.leases.is_empty() && running.idle_generation == generation
                });
                if let Some(idle) = idle {
                    idle.stop();
                }
            }
        });
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(mut running) = self.running.lock() {
            if let Some(running) = running.take() {
                running.stop();
            }
        }
    }
}

/// Fail a refresh request the service rejected, naming `subject` and its reply.
fn refreshed(response: reqwest::blocking::Response, subject: &str) -> Result<(), String> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    Err(format!(
        "Open Slide refresh failed{subject} ({status}): {}",
        response.text().unwrap_or_default()
    ))
}

/// Wait for Open Slide's JSON readiness line on stdout. Any failure stops the
/// child before reporting it.
fn await_ready(child: &mut Child, control_token: &str) -> Result<ReadyLine, String> {
    let Some(stdout) = child.stdout.take() else {
        terminate_process_group(child);
        return Err("Open Slide did not expose readiness output".into());
    };
    let stderr = StartupStderr::capture(child.stderr.take());
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .read_line(&mut line)
            .map(|_| line)
            .map_err(|error| error.to_string());
        let _ = sender.send(result);
    });
    let ready = receiver
        .recv_timeout(STARTUP_TIMEOUT)
        .unwrap_or_else(|_| Err("Open Slide did not become ready within 30 seconds.".to_string()))
        .and_then(|line| {
            serde_json::from_str::<ReadyLine>(line.trim()).map_err(|error| error.to_string())
        });
    match ready {
        Ok(ready)
            if ready.ready && ready.control_token == control_token && ready.version == VERSION =>
        {
            Ok(ready)
        }
        Ok(_) => {
            terminate_process_group(child);
            Err("Open Slide returned invalid readiness data.".into())
        }
        Err(fallback) => {
            // Stop the child first: its stderr only reaches EOF once it exits.
            terminate_process_group(child);
            Err(startup_error_message(&fallback, &stderr.collect()))
        }
    }
}

/// Forwards Open Slide's stderr to the log while keeping its first 8 KiB for
/// a startup error message.
struct StartupStderr {
    reader: Option<JoinHandle<()>>,
    captured: Arc<Mutex<String>>,
}

impl StartupStderr {
    fn capture(stderr: Option<ChildStderr>) -> Self {
        let captured = Arc::new(Mutex::new(String::new()));
        let reader = stderr.map(|stderr| {
            let captured = Arc::clone(&captured);
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log::warn!(target: "lattice::presentation", "{line}");
                    if let Ok(mut output) = captured.lock() {
                        if output.len() < 8 * 1024 {
                            output.push_str(&line);
                            output.push('\n');
                        }
                    }
                }
            })
        });
        Self { reader, captured }
    }

    /// Blocks until stderr reaches EOF, so only call it once the child exited.
    fn collect(self) -> String {
        if let Some(reader) = self.reader {
            let _ = reader.join();
        }
        self.captured.lock().map(|output| output.clone()).unwrap_or_default()
    }
}

fn startup_error_message(fallback: &str, stderr: &str) -> String {
    let detail = stderr
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("Error ") || line.contains("ERR_"))
        .or_else(|| stderr.lines().map(str::trim).find(|line| !line.is_empty()));
    format!("Open Slide startup failed: {}", detail.unwrap_or(fallback))
}

fn scoped_root(value: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(value)
        .map_err(|error| format!("Could not resolve the presentation project: {error}"))?;
    if !root.is_dir() {
        return Err("The presentation project must be a directory.".into());
    }
    Ok(root)
}

fn is_native_path(relative: &Path) -> bool {
    relative == Path::new("open-slide.config.ts")
        || ["slides", "assets", "themes"].iter().any(|root| relative.starts_with(root))
}

/// Visit every entry under the native roots of `root`, never following links.
///
/// Do not walk the project root and filter afterward. Research projects often
/// contain large Git histories and paper caches; traversing those unrelated
/// trees made the first deck open take tens of seconds even though none of
/// their files were copied into the managed Open Slide workspace.
fn walk_native(
    root: &Path, mut visit: impl FnMut(&DirEntry, &Path) -> Result<(), String>,
) -> Result<(), String> {
    for name in NATIVE_ROOTS {
        let scoped = root.join(name);
        if !scoped.exists() || scoped.is_symlink() {
            continue;
        }
        for entry in WalkDir::new(scoped).follow_links(false) {
            let entry = entry.map_err(|error| error.to_string())?;
            let relative = entry.path().strip_prefix(root).map_err(|error| error.to_string())?;
            visit(&entry, relative)?;
        }
    }
    Ok(())
}

/// Replace `destination` with a fresh copy of the native paths of `source`.
fn synchronize(source: &Path, destination: &Path) -> Result<(), String> {
    let staging = destination.with_extension(format!("staging-{}", uuid::Uuid::new_v4()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let result = walk_native(source, |entry, relative| {
        if !is_native_path(relative) || entry.file_type().is_symlink() {
            return Ok(());
        }
        let io = |error: std::io::Error| error.to_string();
        let target = staging.join(relative);
        if entry.file_type().is_dir() {
            return fs::create_dir_all(target).map_err(io);
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        fs::copy(entry.path(), target).map(|_| ()).map_err(io)
    })
    .and_then(|()| {
        let _ = fs::remove_dir_all(destination);
        fs::rename(&staging, destination).map_err(|error| error.to_string())
    });
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

fn native_files(root: &Path) -> Result<BTreeMap<String, NativeFile>, String> {
    let mut files = BTreeMap::new();
    walk_native(root, |entry, relative| {
        if !entry.file_type().is_file() || entry.path_is_symlink() {
            return Ok(());
        }
        let mut file = fs::File::open(entry.path()).map_err(|error| error.to_string())?;
        let size = file.metadata().map_err(|error| error.to_string())?.len();
        let mut digest = Sha256::new();
        std::io::copy(&mut file, &mut digest).map_err(|error| error.to_string())?;
        files.insert(
            relative.to_string_lossy().replace('\\', "/"),
            NativeFile {
                absolute: entry.path().to_path_buf(),
                fingerprint: (size, digest.finalize().into()),
            },
        );
        Ok(())
    })?;
    Ok(files)
}

fn remove_access_lease(origin: String, control_token: String, lease_id: String) {
    thread::spawn(move || {
        let Ok(client) =
            reqwest::blocking::Client::builder().timeout(Duration::from_secs(2)).no_proxy().build()
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

async fn run_blocking<T: Send + 'static>(
    runtime: &PresentationRuntime, stage: &str,
    work: impl FnOnce(PresentationRuntime) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let runtime = runtime.clone();
    tauri::async_runtime::spawn_blocking(move || work(runtime))
        .await
        .map_err(|error| format!("Open Slide {stage} stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn presentation_ensure_ready(
    runtime: tauri::State<'_, PresentationRuntime>, project_root: String,
) -> Result<PresentationInfo, String> {
    run_blocking(&runtime, "startup", move |runtime| runtime.ensure(&project_root)).await
}

#[tauri::command]
pub fn presentation_release(
    runtime: tauri::State<'_, PresentationRuntime>, project_root: String, lease_id: String,
) -> Result<(), String> {
    runtime.release(&project_root, &lease_id)
}

#[tauri::command]
pub async fn presentation_refresh_native_workspace(
    runtime: tauri::State<'_, PresentationRuntime>, project_root: String,
) -> Result<(), String> {
    run_blocking(&runtime, "refresh", move |runtime| runtime.refresh(&project_root)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_errors_prefer_the_child_process_cause() {
        let stderr = "node:internal/modules/package_json_reader:301\n\
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@open-slide/core'\n\
Node.js v24.20.0\n";
        assert_eq!(
            startup_error_message("EOF while parsing a value", stderr),
            "Open Slide startup failed: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@open-slide/core'"
        );
        assert_eq!(
            startup_error_message("EOF while parsing a value", ""),
            "Open Slide startup failed: EOF while parsing a value"
        );
    }

    #[test]
    fn shadows_only_native_open_slide_workspace_paths() {
        for (path, native) in [
            ("slides/research-update/index.tsx", true),
            ("assets/chart.png", true),
            ("open-slide.config.ts", true),
            ("main.tex", false),
            ("slides-backup/index.tsx", false),
        ] {
            assert_eq!(is_native_path(Path::new(path)), native, "{path}");
        }
    }

    #[test]
    fn shadow_sync_does_not_walk_unrelated_project_directories() {
        use std::os::unix::fs::PermissionsExt;

        let parent = crate::test_support::TempDir::new("presentation-shadow");
        let source = parent.join("project");
        let shadow = parent.join("shadow");
        let unrelated = source.join("large-paper-cache");
        parent.write("project/slides/talk/index.tsx", "export default [];\n");
        fs::create_dir_all(&unrelated).unwrap();
        fs::set_permissions(&unrelated, fs::Permissions::from_mode(0o000)).unwrap();

        let result = synchronize(&source, &shadow);
        fs::set_permissions(&unrelated, fs::Permissions::from_mode(0o700)).unwrap();
        // Only an existing directory is a presentation project.
        assert!(scoped_root(source.join("slides/talk/index.tsx").to_str().unwrap()).is_err());
        assert!(scoped_root(parent.join("missing").to_str().unwrap()).is_err());

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            fs::read_to_string(shadow.join("slides/talk/index.tsx")).unwrap(),
            "export default [];\n"
        );
        assert!(!shadow.join("large-paper-cache").exists());
    }
}
