//! Supervisor for the embedded Open Slide presentation runtime.
//!
//! Open Slide runs as a loopback Node service over a *shadow* copy of the
//! project's native deck files (`NATIVE_ROOTS`). Editors hold leases on the
//! running project; the service stops `IDLE_TIMEOUT` after the last lease is
//! released, and only one project can hold leases at a time.
//!
//! Everything here is per process: the leases live in memory, the service
//! listens on an ephemeral port, and the shadow lives under the app cache
//! directory, which macOS keys by bundle identifier. A second build of
//! Lattice (Beta, a lab build) therefore never sees this one's leases.
//!
//! A lease is released by the page that took it, from a React cleanup. A
//! page that is closed, reloaded or replaced never runs that cleanup, so each
//! lease records its owning page, and a lease whose page is gone is stale: it
//! must never keep another project's deck from opening.

use crate::ipc::run_blocking;
use crate::sidecar::{terminate_process_group, NodeRuntime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::Manager;
use walkdir::{DirEntry, WalkDir};

const VERSION: &str = "2.3.1";
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

impl PresentationInfo {
    /// A live page of another window holds `holder`'s deck open. No lease is
    /// granted; the page offers to switch to that project's window instead.
    fn busy(holder: &Path) -> Self {
        Self {
            state: "busy".into(),
            origin: None,
            session_url: None,
            control_token: None,
            version: VERSION.into(),
            project_root: Some(holder.to_string_lossy().into_owned()),
            leases: 0,
            lease_id: None,
        }
    }
}

/// The page holding a lease: a window label (a browser tab's is its host's)
/// and the page instance loaded in it, which the frontend names once per
/// page load.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseOwner {
    window: String,
    page: String,
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
    leases: BTreeMap<String, LeaseOwner>,
    idle_generation: u64,
}

impl Running {
    fn stop(mut self) {
        terminate_process_group(&mut self.child);
        let _ = fs::remove_dir_all(self.shadow_root);
    }

    /// Grant a new lease, which also cancels any pending idle shutdown.
    fn lease(&mut self, owner: LeaseOwner) -> PresentationInfo {
        let lease_id = uuid::Uuid::new_v4().to_string();
        self.leases.insert(lease_id.clone(), owner);
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

    /// Withdraw a lease from the service as well as from the supervisor.
    fn revoke(&mut self, lease_id: &str) -> bool {
        if self.leases.remove(lease_id).is_none() {
            return false;
        }
        remove_access_lease(self.origin.clone(), self.control_token.clone(), lease_id.to_string());
        true
    }

    /// Stop the service `IDLE_TIMEOUT` from now unless a lease arrives first.
    fn schedule_idle_stop(&mut self, state: &Arc<Mutex<Option<Running>>>) {
        if !self.leases.is_empty() {
            return;
        }
        self.idle_generation = self.idle_generation.wrapping_add(1);
        let generation = self.idle_generation;
        let state = Arc::clone(state);
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
    }
}

/// The ids of the leases on `project` that no live page can release.
///
/// A lease is live only while its window still shows `project` (`shows`
/// answers which project a window label is bound to; a closed window is bound
/// to none) and its page is the one that window last presented. Anything else
/// was left by a closed window, a window that moved to another project, a
/// reload, or a browser tab another tab replaced: none of those pages will
/// ever release it.
fn stale_leases(
    leases: &BTreeMap<String, LeaseOwner>, project: &Path, pages: &HashMap<String, String>,
    shows: &dyn Fn(&str) -> Option<PathBuf>,
) -> Vec<String> {
    leases
        .iter()
        .filter(|(_, owner)| {
            pages.get(&owner.window) != Some(&owner.page)
                || shows(&owner.window).as_deref() != Some(project)
        })
        .map(|(id, _)| id.clone())
        .collect()
}

#[derive(Clone)]
pub struct PresentationRuntime {
    node: NodeRuntime,
    entry_path: PathBuf,
    shadow_parent: PathBuf,
    running: Arc<Mutex<Option<Running>>>,
    /// The page each window last presented itself as. Its own lock, never
    /// held for long: `running` is held through a whole startup, and window
    /// events must record a page change without waiting on that.
    pages: Arc<Mutex<HashMap<String, String>>>,
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
            node: NodeRuntime::resolve(&resources.join("synara-runtime/bin")),
            entry_path: resources.join("presentation-runtime/server.mjs"),
            shadow_parent,
            running: Arc::default(),
            pages: Arc::default(),
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
        let client = crate::http::loopback(Duration::from_secs(300))
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

    fn pages(&self) -> Result<MutexGuard<'_, HashMap<String, String>>, String> {
        self.pages.lock().map_err(|_| "Presentation page registry lock failed".to_string())
    }

    /// Lease the runtime for `project_root` to `owner`, starting it when needed.
    ///
    /// While another project's runtime is running, its stale leases are
    /// dropped first (see `stale_leases`). Only a live page of another window
    /// keeps it: the answer is then `busy`, naming that project, so the page
    /// can offer to switch to it.
    pub fn ensure(
        &self, project_root: &str, owner: LeaseOwner, shows: &dyn Fn(&str) -> Option<PathBuf>,
    ) -> Result<PresentationInfo, String> {
        let root = scoped_root(project_root)?;
        // Recorded before waiting on a startup in progress: a navigation
        // meanwhile must still find, and forget, this page.
        self.pages()?.insert(owner.window.clone(), owner.page.clone());
        let mut running = self.lock()?;
        let pages = self.pages()?.clone();
        if let Some(current) = running.as_mut() {
            if current.child.try_wait().ok().flatten().is_none() {
                if current.project_root == root {
                    return Ok(current.lease(owner));
                }
                let stale = stale_leases(&current.leases, &current.project_root, &pages, shows);
                for lease_id in &stale {
                    current.revoke(lease_id);
                }
                if !stale.is_empty() {
                    log::info!(
                        target: "lattice::presentation",
                        "dropped {} stale presentation lease(s)",
                        stale.len()
                    );
                }
                if !current.leases.is_empty() {
                    return Ok(PresentationInfo::busy(&current.project_root));
                }
            }
        }
        if let Some(previous) = running.take() {
            previous.stop();
        }
        Ok(running.insert(self.launch(root)?).lease(owner))
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
            leases: BTreeMap::new(),
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
        if current.revoke(lease_id) {
            current.schedule_idle_stop(&self.running);
        }
        Ok(())
    }

    /// The page in `window` is gone: the window closed, or a navigation
    /// replaced its page. Neither runs the React cleanup that releases a
    /// deck's lease, so release that page's leases here.
    ///
    /// Called from the window event loop. The page change is recorded at once,
    /// which already makes the old page's leases stale for `ensure`; dropping
    /// them waits on the supervisor lock, held through a startup, so it runs
    /// off this thread and keeps any lease a newer page took meanwhile.
    pub fn forget_page(&self, window: &str) {
        if let Ok(mut pages) = self.pages.lock() {
            pages.remove(window);
        }
        let runtime = self.clone();
        let window = window.to_string();
        thread::spawn(move || runtime.drop_superseded_leases(&window));
    }

    fn drop_superseded_leases(&self, window: &str) {
        let Ok(mut running) = self.lock() else {
            return;
        };
        let Some(current) = running.as_mut() else {
            return;
        };
        let page = self.pages.lock().ok().and_then(|pages| pages.get(window).cloned());
        let superseded = current
            .leases
            .iter()
            .filter(|(_, owner)| owner.window == window && Some(&owner.page) != page.as_ref())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for lease_id in &superseded {
            current.revoke(lease_id);
        }
        if !superseded.is_empty() {
            current.schedule_idle_stop(&self.running);
        }
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
        let Ok(client) = crate::http::loopback(Duration::from_secs(2)).build() else {
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
    app: tauri::AppHandle, window: tauri::Window, runtime: tauri::State<'_, PresentationRuntime>,
    project_root: String, page_id: String,
) -> Result<PresentationInfo, String> {
    let owner = LeaseOwner { window: window.label().to_string(), page: page_id };
    let runtime = runtime.inner().clone();
    run_blocking("Open Slide startup", move || {
        let state = app.state::<crate::app_state::AppState>();
        // Bindings and lease roots are both canonical paths in practice;
        // canonicalizing again keeps a spelling difference from making a
        // live lease look stale.
        let shows = |window: &str| {
            state.root_for(window).ok().flatten().and_then(|root| fs::canonicalize(root).ok())
        };
        runtime.ensure(&project_root, owner, &shows)
    })
    .await
}

/// Async so it runs off the main thread: releasing waits on the supervisor
/// lock, which `ensure` holds through a startup of up to `STARTUP_TIMEOUT`.
#[tauri::command]
pub async fn presentation_release(
    runtime: tauri::State<'_, PresentationRuntime>, project_root: String, lease_id: String,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    run_blocking("Open Slide release", move || runtime.release(&project_root, &lease_id)).await
}

#[tauri::command]
pub async fn presentation_refresh_native_workspace(
    runtime: tauri::State<'_, PresentationRuntime>, project_root: String,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    run_blocking("Open Slide refresh", move || runtime.refresh(&project_root)).await
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
    fn only_a_live_page_still_showing_the_project_keeps_its_lease() {
        let project = Path::new("/projects/talk");
        let owner =
            |window: &str, page: &str| LeaseOwner { window: window.into(), page: page.into() };
        let leases = BTreeMap::from([
            ("open-deck".to_string(), owner("project-1", "page-a")),
            ("closed-window".to_string(), owner("main", "page-b")),
            ("moved-on".to_string(), owner("project-2", "page-c")),
            ("reloaded".to_string(), owner("project-3", "page-old")),
            ("replaced-tab".to_string(), owner("browser-1", "page-d")),
        ]);
        let pages = HashMap::from([
            ("project-1".to_string(), "page-a".to_string()),
            ("main".to_string(), "page-b".to_string()),
            ("project-2".to_string(), "page-c".to_string()),
            ("project-3".to_string(), "page-new".to_string()),
            // A navigation already removed `browser-1`'s page.
        ]);
        let shows = |window: &str| match window {
            "project-1" | "project-3" | "browser-1" => Some(project.to_path_buf()),
            "project-2" => Some(PathBuf::from("/projects/paper")),
            // `main` closed, so nothing binds it.
            _ => None,
        };

        let mut stale = stale_leases(&leases, project, &pages, &shows);
        stale.sort();
        assert_eq!(stale, ["closed-window", "moved-on", "reloaded", "replaced-tab"]);
    }

    /// A runtime for project `talk` whose single lease belongs to the page
    /// `page-1` of window `main`, with a `sleep` standing in for Open Slide.
    /// Its Node executable does not exist, so any new launch fails at once.
    fn runtime_held_by_main(
        parent: &crate::test_support::TempDir,
    ) -> (PresentationRuntime, PathBuf) {
        let talk = fs::canonicalize(parent.join("talk")).unwrap();
        let mut command = Command::new("sleep");
        command.arg("60");
        crate::commands::in_new_process_group(&mut command);
        let runtime = PresentationRuntime {
            node: NodeRuntime { executable: parent.join("missing/node") },
            entry_path: parent.join("missing/server.mjs"),
            shadow_parent: parent.join("shadows"),
            running: Arc::default(),
            pages: Arc::default(),
        };
        let mut running = Running {
            child: command.spawn().unwrap(),
            project_root: talk.clone(),
            shadow_root: parent.join("shadows/workspace"),
            origin: "http://127.0.0.1:9".into(),
            session_url: String::new(),
            control_token: String::new(),
            leases: BTreeMap::new(),
            idle_generation: 0,
        };
        running.lease(LeaseOwner { window: "main".into(), page: "page-1".into() });
        *runtime.running.lock().unwrap() = Some(running);
        runtime.pages.lock().unwrap().insert("main".into(), "page-1".into());
        (runtime, talk)
    }

    #[test]
    fn another_projects_deck_waits_only_for_a_live_holder() {
        let parent = crate::test_support::TempDir::new("presentation-leases");
        parent.write("talk/slides/talk/index.tsx", "export default [];\n");
        parent.write("paper/slides/paper/index.tsx", "export default [];\n");
        let (runtime, talk) = runtime_held_by_main(&parent);
        let paper = parent.join("paper");
        let other = LeaseOwner { window: "project-1".into(), page: "page-2".into() };

        // `main` still shows `talk`: offer to switch rather than fail.
        let showing_talk = |window: &str| (window == "main").then(|| talk.clone());
        let busy = runtime.ensure(paper.to_str().unwrap(), other.clone(), &showing_talk).unwrap();
        assert_eq!(busy.state, "busy");
        assert_eq!(busy.project_root.as_deref(), Some(talk.to_str().unwrap()));
        assert!(busy.lease_id.is_none());

        // `main` closed without releasing: its lease no longer blocks, the
        // old runtime stops, and `paper` gets its own (here failing) launch.
        let error = runtime.ensure(paper.to_str().unwrap(), other, &|_| None).unwrap_err();
        assert!(error.starts_with("Could not start Open Slide"), "{error}");
        assert!(runtime.running.lock().unwrap().is_none());
    }

    #[test]
    fn a_replaced_page_releases_its_leases_but_not_its_successors() {
        let parent = crate::test_support::TempDir::new("presentation-reload");
        parent.write("talk/slides/talk/index.tsx", "export default [];\n");
        let (runtime, _) = runtime_held_by_main(&parent);
        // The reloaded page leased the same deck before the old lease went.
        runtime.running.lock().unwrap().as_mut().unwrap().leases.insert(
            "successor".into(),
            LeaseOwner { window: "main".into(), page: "page-2".into() },
        );
        runtime.pages.lock().unwrap().insert("main".into(), "page-2".into());

        runtime.drop_superseded_leases("main");

        let leases = runtime.running.lock().unwrap().as_ref().unwrap().leases.clone();
        runtime.shutdown();
        assert_eq!(leases.keys().collect::<Vec<_>>(), ["successor"]);
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
    fn shadow_mirrors_every_file_a_deck_can_import_and_sees_later_ones() {
        let parent = crate::test_support::TempDir::new("presentation-deck-files");
        let source = parent.join("project");
        let shadow = parent.join("shadow");
        for path in [
            "slides/talk/index.tsx",
            "slides/talk/assets/chart.png",
            "slides/talk/assets/fonts/display.woff2",
            "slides/talk/data/results.json",
            "slides/talk/embed.html",
            "assets/logo.svg",
        ] {
            parent.write(&format!("project/{path}"), path);
        }

        synchronize(&source, &shadow).unwrap();
        let mirrored = native_files(&shadow).unwrap();
        assert_eq!(
            mirrored.keys().map(String::as_str).collect::<Vec<_>>(),
            native_files(&source).unwrap().keys().map(String::as_str).collect::<Vec<_>>()
        );
        assert!(mirrored.contains_key("slides/talk/assets/fonts/display.woff2"));

        // An asset written after the runtime started is one that `refresh`
        // must upload: it is in the project's listing but not the shadow's.
        parent.write("project/slides/talk/assets/late.png", "late");
        let source_files = native_files(&source).unwrap();
        let pending =
            source_files.keys().filter(|path| !mirrored.contains_key(*path)).collect::<Vec<_>>();
        assert_eq!(pending, ["slides/talk/assets/late.png"]);
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
