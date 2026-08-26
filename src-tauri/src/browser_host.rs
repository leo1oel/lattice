use super::AppState;
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::mpsc;

const PREFERRED_PORT: u16 = 18452;
const MAX_BRIDGE_MESSAGE_SIZE: usize = 256 * 1024 * 1024;
const SESSION_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DESKTOP_RETURN_COMPLETE: &str = r#"{"type":"desktop-return-complete"}"#;
pub(crate) const SERVICE_WINDOW_LABEL: &str = "browser-service";

#[cfg(target_os = "macos")]
const CS_OPS_CDHASH: libc::c_uint = 5;

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn csops(
        pid: libc::pid_t,
        ops: libc::c_uint,
        useraddr: *mut libc::c_void,
        usersize: libc::size_t,
    ) -> libc::c_int;
}

type Sessions = Arc<Mutex<HashMap<String, BrowserSession>>>;

#[derive(Default)]
pub(crate) struct BrowserHost {
    running: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    port: u16,
    sessions: Sessions,
}

struct BrowserSession {
    source_label: Option<String>,
    host_label: String,
    project_root: Option<PathBuf>,
    browser_origin: String,
    entry_session: bool,
    created_at: Instant,
    active: bool,
    host: Option<Peer>,
    browser: Option<Peer>,
    desktop: Option<Peer>,
    bundled_chromium: bool,
    visible_epoch: u64,
    desktop_return: Option<DesktopReturnRequest>,
}

struct PeerRegistration {
    host_label: String,
    hide_desktop: bool,
    complete_desktop_return: bool,
}

enum SessionSettlement {
    Unchanged,
    ResumeDesktop(String),
    Expire(String),
}

enum DesktopReturn {
    PendingBundled,
    Bundled(String),
    Native(BrowserSession),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DesktopReturnTarget {
    Bundled,
    Native,
}

struct DesktopReturnRequest {
    target: DesktopReturnTarget,
    acknowledged: bool,
}

#[derive(Clone)]
struct Peer {
    id: String,
    sender: mpsc::UnboundedSender<Message>,
}

#[derive(Clone)]
struct ServerState {
    app: tauri::AppHandle,
    port: u16,
    sessions: Sessions,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq)]
struct ProcessIdentity {
    pid: libc::pid_t,
    start_seconds: u64,
    start_microseconds: u64,
}

#[derive(Deserialize)]
struct BridgeQuery {
    token: String,
    role: BridgeRole,
}

#[derive(Default, Deserialize)]
struct SessionQuery {
    token: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum BridgeRole {
    Browser,
    Desktop,
    Host,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostBridgeConfig<'a> {
    token: &'a str,
    port: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSessionConfig {
    token: String,
    bridge_port: u16,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserDialogOptions {
    title: Option<String>,
    #[serde(default)]
    filters: Vec<BrowserDialogFilter>,
    default_path: Option<PathBuf>,
    #[serde(default)]
    multiple: bool,
    #[serde(default)]
    directory: bool,
    can_create_directories: Option<bool>,
}

#[derive(Deserialize)]
struct BrowserDialogFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum BrowserDialogSelection {
    One(Option<String>),
    Many(Option<Vec<String>>),
}

fn browser_dialog_builder(options: &BrowserDialogOptions) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(default_path) = &options.default_path {
        if default_path.is_file() || !default_path.exists() {
            if let (Some(parent), Some(file_name)) =
                (default_path.parent(), default_path.file_name())
            {
                if parent.components().count() > 0 {
                    dialog = dialog.set_directory(parent);
                }
                dialog = dialog.set_file_name(file_name.to_string_lossy());
            } else {
                dialog = dialog.set_directory(default_path);
            }
        } else {
            dialog = dialog.set_directory(default_path);
        }
    }
    if let Some(can_create_directories) = options.can_create_directories {
        dialog = dialog.set_can_create_directories(can_create_directories);
    }
    for filter in &options.filters {
        dialog = dialog.add_filter(&filter.name, &filter.extensions);
    }
    dialog
}

fn browser_dialog_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label().starts_with("browser-") && window.label() != SERVICE_WINDOW_LABEL {
        Ok(())
    } else {
        Err("Browser dialogs are only available to a browser workspace.".to_string())
    }
}

fn browser_dialog_path(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn bind_browser_listener(take_over_background_host: bool) -> io::Result<TcpListener> {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, PREFERRED_PORT);
    match TcpListener::bind(address) {
        Ok(listener) => Ok(listener),
        #[cfg(target_os = "macos")]
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            replace_stale_browser_host(address, take_over_background_host).ok_or(error)
        }
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
fn replace_stale_browser_host(
    address: SocketAddrV4,
    take_over_background_host: bool,
) -> Option<TcpListener> {
    let current_exe = std::env::current_exe().ok()?;
    let candidate = stale_browser_host(&current_exe, take_over_background_host)?;
    // Re-read every authorization input immediately before signaling. A PID
    // can be recycled and the fixed port can change owners between `lsof` and
    // this point; either change must fail closed instead of killing the new
    // listener.
    if stale_browser_host(&current_exe, take_over_background_host)? != candidate {
        return None;
    }
    if unsafe { libc::kill(candidate.pid, libc::SIGTERM) } != 0 {
        return None;
    }
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(50));
        match TcpListener::bind(address) {
            Ok(listener) => {
                log::info!(
                    target: "lattice::browser",
                    "replaced browser host from an older installed build"
                );
                return Some(listener);
            }
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {}
            Err(_) => return None,
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn stale_browser_host(
    current_exe: &std::path::Path,
    take_over_background_host: bool,
) -> Option<ProcessIdentity> {
    let pid = browser_listener_pid()?;
    let identity = process_identity(pid)?;
    let arguments = process_arguments(pid)?;
    if identity.pid == std::process::id() as libc::pid_t
        || !process_executable_matches(pid, current_exe)
        || !browser_host_arguments_match(&arguments, current_exe)
    {
        return None;
    }
    let running_hash = process_code_hash(pid)?;
    let current_hash = process_code_hash(std::process::id() as libc::pid_t)?;
    (take_over_background_host || running_hash != current_hash).then_some(identity)
}

#[cfg(target_os = "macos")]
fn browser_host_arguments_match(arguments: &[Vec<u8>], current_exe: &std::path::Path) -> bool {
    arguments.len() == 2
        && arguments[0].as_slice() == current_exe.as_os_str().as_encoded_bytes()
        && arguments[1].as_slice() == b"--browser-host"
}

#[cfg(target_os = "macos")]
fn process_executable_matches(pid: libc::pid_t, current_exe: &std::path::Path) -> bool {
    let mut path = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let read = unsafe {
        libc::proc_pidpath(
            pid,
            path.as_mut_ptr().cast(),
            path.len().try_into().unwrap_or(u32::MAX),
        )
    };
    if read <= 0 {
        return false;
    }
    let read = read as usize;
    let length = path[..read]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(read);
    path[..length] == *current_exe.as_os_str().as_encoded_bytes()
}

#[cfg(target_os = "macos")]
fn browser_listener_pid() -> Option<libc::pid_t> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-t", "-a", "-iTCP@127.0.0.1:18452", "-sTCP:LISTEN"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut pids = String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .filter_map(|line| line.trim().parse::<libc::pid_t>().ok())
        .collect::<Vec<_>>();
    pids.sort_unstable();
    pids.dedup();
    (pids.len() == 1 && pids[0] > 0).then_some(pids[0])
}

#[cfg(target_os = "macos")]
fn process_identity(pid: libc::pid_t) -> Option<ProcessIdentity> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as libc::c_int,
        )
    };
    if read != size as libc::c_int {
        return None;
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_uid != unsafe { libc::geteuid() } {
        return None;
    }
    Some(ProcessIdentity {
        pid,
        start_seconds: info.pbi_start_tvsec,
        start_microseconds: info.pbi_start_tvusec,
    })
}

#[cfg(target_os = "macos")]
fn process_arguments(pid: libc::pid_t) -> Option<Vec<Vec<u8>>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = 0;
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || size < std::mem::size_of::<libc::c_int>()
        || size > 1024 * 1024
    {
        return None;
    }
    let mut buffer = vec![0_u8; size];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    buffer.truncate(size);
    parse_process_arguments(&buffer)
        .map(|arguments| arguments.into_iter().map(<[u8]>::to_vec).collect())
}

#[cfg(target_os = "macos")]
fn parse_process_arguments(buffer: &[u8]) -> Option<Vec<&[u8]>> {
    let argc_size = std::mem::size_of::<libc::c_int>();
    let argc = libc::c_int::from_ne_bytes(buffer.get(..argc_size)?.try_into().ok()?);
    if !(0..=64).contains(&argc) {
        return None;
    }
    let mut cursor = argc_size;
    cursor += buffer.get(cursor..)?.iter().position(|byte| *byte == 0)? + 1;
    while buffer.get(cursor) == Some(&0) {
        cursor += 1;
    }
    let mut arguments = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        let rest = buffer.get(cursor..)?;
        let length = rest.iter().position(|byte| *byte == 0)?;
        arguments.push(&rest[..length]);
        cursor += length + 1;
        while buffer.get(cursor) == Some(&0) {
            cursor += 1;
        }
    }
    Some(arguments)
}

#[cfg(target_os = "macos")]
fn process_code_hash(pid: libc::pid_t) -> Option<[u8; 20]> {
    let mut hash = [0_u8; 20];
    let result = unsafe { csops(pid, CS_OPS_CDHASH, hash.as_mut_ptr().cast(), hash.len()) };
    (result == 0).then_some(hash)
}

/// The dialog plugin always parents its panels to the invoking WebView. In a
/// browser workspace that WebView is deliberately hidden, so AppKit puts the
/// panel behind the real browser. A synchronous, unparented rfd panel runs as
/// its own modal window and therefore appears in front without exposing the
/// bridge WebView itself.
#[tauri::command]
pub(crate) async fn browser_dialog_open(
    window: tauri::WebviewWindow,
    options: BrowserDialogOptions,
) -> Result<BrowserDialogSelection, String> {
    browser_dialog_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let directory = options.directory;
        let multiple = options.multiple;
        let dialog = browser_dialog_builder(&options);
        if multiple {
            let paths = if directory {
                dialog.pick_folders()
            } else {
                dialog.pick_files()
            };
            BrowserDialogSelection::Many(
                paths.map(|paths| paths.into_iter().map(browser_dialog_path).collect()),
            )
        } else {
            let path = if directory {
                dialog.pick_folder()
            } else {
                dialog.pick_file()
            };
            BrowserDialogSelection::One(path.map(browser_dialog_path))
        }
    })
    .await
    .map_err(|error| format!("Browser open dialog stopped unexpectedly: {error}"))
}

#[tauri::command]
pub(crate) async fn browser_dialog_save(
    window: tauri::WebviewWindow,
    options: BrowserDialogOptions,
) -> Result<Option<String>, String> {
    browser_dialog_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        browser_dialog_builder(&options)
            .save_file()
            .map(browser_dialog_path)
    })
    .await
    .map_err(|error| format!("Browser save dialog stopped unexpectedly: {error}"))
}

impl BrowserHost {
    pub(crate) fn open(
        &self,
        app: &tauri::AppHandle,
        source_label: &str,
        project_root: Option<PathBuf>,
    ) -> Result<String, String> {
        let host_label = format!("browser-{}", uuid::Uuid::new_v4().simple());
        self.open_session(
            app,
            Some(source_label.to_string()),
            host_label,
            project_root,
            false,
            true,
        )
    }

    pub(crate) fn open_project(
        &self,
        app: &tauri::AppHandle,
        state: &AppState,
        project_root: PathBuf,
        pending: Option<String>,
    ) -> Result<String, String> {
        let host_label = format!("browser-{}", uuid::Uuid::new_v4().simple());
        state.bind_window(&host_label, project_root.clone())?;
        if let Some(pending) = pending {
            state.set_pending_action(&host_label, pending);
        }
        match self.open_session(
            app,
            None,
            host_label.clone(),
            Some(project_root),
            true,
            false,
        ) {
            Ok(_) => Ok(host_label),
            Err(reason) => {
                state.release_window(&host_label);
                state.retire_unused_projects();
                Err(reason)
            }
        }
    }

    /// Bring a project that is already browser-hosted back through the system
    /// browser. Opening the authenticated URL may focus the existing tab or
    /// replace it with a fresh tab, depending on the browser; either outcome
    /// is usable, unlike focusing the deliberately hidden native host window.
    pub(crate) fn reopen_window(
        &self,
        app: &tauri::AppHandle,
        host_label: &str,
    ) -> Result<bool, String> {
        let Some(browser_url) = self.workspace_url(host_label)? else {
            return Ok(false);
        };
        open_workspace_url(app, &browser_url)?;
        Ok(true)
    }

    /// Open the current bundled-Chromium workspace in the user's system
    /// browser. This deliberately bypasses `open_workspace_url`, whose normal
    /// packaged behavior is to route workspace URLs back into Chromium.
    pub(crate) fn open_in_system_browser(
        &self,
        app: &tauri::AppHandle,
        host_label: &str,
    ) -> Result<bool, String> {
        let Some(browser_url) = self.workspace_url(host_label)? else {
            return Ok(false);
        };
        app.opener()
            .open_url(browser_url, None::<&str>)
            .map_err(|error| format!("Could not open the browser workspace: {error}"))?;
        Ok(true)
    }

    fn workspace_url(&self, host_label: &str) -> Result<Option<String>, String> {
        let (port, sessions) = {
            let running = self
                .running
                .lock()
                .map_err(|_| "Browser server state is unavailable.".to_string())?;
            let Some(server) = running.as_ref() else {
                return Ok(None);
            };
            (server.port, Arc::clone(&server.sessions))
        };
        let browser_url = sessions
            .lock()
            .map_err(|_| "Browser session state is unavailable.".to_string())?
            .iter()
            .find_map(|(token, session)| {
                (session.host_label == host_label).then(|| {
                    format!(
                        "{}/#token={token}&bridgePort={port}&label={host_label}",
                        session.browser_origin
                    )
                })
            });
        Ok(browser_url)
    }

    pub(crate) fn has_bundled_chromium(&self, host_label: &str) -> Result<bool, String> {
        let sessions = self
            .sessions()
            .ok_or_else(|| "Browser server state is unavailable.".to_string())?;
        let sessions = sessions
            .lock()
            .map_err(|_| "Browser session state is unavailable.".to_string())?;
        Ok(sessions
            .values()
            .any(|session| session.host_label == host_label && session.bundled_chromium))
    }

    /// Reopen the workspace owned by the fixed local browser entry, if one is
    /// still alive. This is also the macOS reopen behavior while Lattice is
    /// running as a background login item.
    pub(crate) fn reopen_entry(&self, app: &tauri::AppHandle) -> Result<bool, String> {
        let (port, sessions) = {
            let running = self
                .running
                .lock()
                .map_err(|_| "Browser server state is unavailable.".to_string())?;
            let Some(server) = running.as_ref() else {
                return Ok(false);
            };
            (server.port, Arc::clone(&server.sessions))
        };
        let config = reusable_entry_config(&sessions, port, None);
        let Some(config) = config else {
            return Ok(false);
        };
        let origin = browser_origin(app, port);
        let browser_url = format!(
            "{origin}/#token={}&bridgePort={}&label={}",
            config.token, config.bridge_port, config.label
        );
        open_workspace_url(app, &browser_url)?;
        Ok(true)
    }

    /// Mark a session for retirement once the hidden host confirms that the
    /// command response is already queued for the browser. A fallback retires
    /// it if the host bridge fails between returning the command and sending
    /// that acknowledgement.
    pub(crate) fn return_to_desktop(
        &self,
        app: &tauri::AppHandle,
        host_label: &str,
        bundled_chromium: bool,
    ) -> Result<(), String> {
        let sessions = self
            .sessions()
            .ok_or_else(|| "Browser server state is unavailable.".to_string())?;
        let token = {
            let mut sessions = sessions
                .lock()
                .map_err(|_| "Browser session state is unavailable.".to_string())?;
            let (token, session) = sessions
                .iter_mut()
                .find(|(_, session)| session.host_label == host_label)
                .ok_or_else(|| "This browser workspace is no longer active.".to_string())?;
            session.desktop_return = Some(DesktopReturnRequest {
                target: if bundled_chromium {
                    DesktopReturnTarget::Bundled
                } else {
                    DesktopReturnTarget::Native
                },
                acknowledged: false,
            });
            token.clone()
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = complete_desktop_return(&app, &sessions, &token, None);
        });
        Ok(())
    }

    /// Start the small loopback listener without creating a workspace. The
    /// listener survives browser-tab teardown and is what makes the bookmarked
    /// address a permanent entry point.
    pub(crate) fn start(
        &self,
        app: &tauri::AppHandle,
        take_over_background_host: bool,
    ) -> Result<u16, String> {
        self.ensure_server(app, take_over_background_host)
            .map(|(port, _)| port)
    }

    /// A native window with no WebView keeps Tauri's event loop alive after the
    /// last browser workspace is torn down. Unlike retaining the bridge, this
    /// costs no renderer and owns no project; an explicit app Quit still exits
    /// normally because the window is only hidden, not an exit interceptor.
    pub(crate) fn keep_resident(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if app.get_window(SERVICE_WINDOW_LABEL).is_some() {
            return Ok(());
        }
        tauri::window::WindowBuilder::new(app, SERVICE_WINDOW_LABEL)
            .title("")
            .inner_size(1.0, 1.0)
            .visible(false)
            .focused(false)
            .focusable(false)
            .skip_taskbar(true)
            .build()
            .map(|_| ())
            .map_err(|error| format!("Could not keep local browser access ready: {error}"))
    }

    pub(crate) fn stop_resident(&self, app: &tauri::AppHandle) {
        if let Some(window) = app.get_window(SERVICE_WINDOW_LABEL) {
            let _ = window.destroy();
        }
    }

    fn open_session(
        &self,
        app: &tauri::AppHandle,
        source_label: Option<String>,
        host_label: String,
        project_root: Option<PathBuf>,
        active: bool,
        entry_session: bool,
    ) -> Result<String, String> {
        let (port, sessions) = self.ensure_server(app, false)?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let browser_origin = browser_origin(app, port);
        let browser_url =
            format!("{browser_origin}/#token={token}&bridgePort={port}&label={host_label}");

        {
            let mut sessions = sessions
                .lock()
                .map_err(|_| "Browser session state is unavailable.".to_string())?;
            if sessions.values().any(|session| {
                source_label.is_some() && session.source_label.as_ref() == source_label.as_ref()
            }) {
                return Err("This Lattice window is already opening in a browser.".to_string());
            }
            sessions.insert(
                token.clone(),
                BrowserSession {
                    source_label,
                    host_label: host_label.clone(),
                    project_root,
                    browser_origin,
                    entry_session,
                    created_at: Instant::now(),
                    active,
                    host: None,
                    browser: None,
                    desktop: None,
                    bundled_chromium: false,
                    visible_epoch: 0,
                    desktop_return: None,
                },
            );
        }

        if let Err(error) = build_host_window(app, &host_label, &token, port) {
            remove_session(&sessions, &token);
            return Err(error);
        }

        if let Err(error) = open_workspace_url(app, &browser_url) {
            if let Some(window) = app.get_webview_window(&host_label) {
                let _ = window.destroy();
            }
            remove_session(&sessions, &token);
            return Err(error);
        }
        Ok(browser_url)
    }

    /// Complete a handoff only after the source window has run its normal
    /// close-request cleanup. Until then the browser's IPC calls remain queued,
    /// so two interfaces can never operate on the same project concurrently.
    pub(crate) fn activate_source(&self, source_label: &str, state: &AppState) {
        let Some(sessions) = self.sessions() else {
            return;
        };
        let handoffs = match sessions.lock() {
            Ok(sessions) => sessions
                .iter()
                .filter(|(_, session)| {
                    !session.active && session.source_label.as_deref() == Some(source_label)
                })
                .map(|(token, session)| {
                    (
                        token.clone(),
                        session.host_label.clone(),
                        session.project_root.clone(),
                    )
                })
                .collect::<Vec<_>>(),
            Err(_) => return,
        };

        for (token, host_label, project_root) in handoffs {
            if let Some(project_root) = project_root {
                if let Err(reason) = state.bind_window(&host_label, project_root) {
                    send_session_error(&sessions, &token, &reason);
                    continue;
                }
            }
            if let Ok(mut sessions) = sessions.lock() {
                if let Some(session) = sessions.get_mut(&token) {
                    session.active = true;
                    notify_ready(session);
                }
            }
        }
    }

    fn sessions(&self) -> Option<Sessions> {
        self.running
            .lock()
            .ok()?
            .as_ref()
            .map(|server| Arc::clone(&server.sessions))
    }

    /// Once the last native workspace has completed its browser handoff, the
    /// app is only a local service for the tab. Keep that hidden bridge out of
    /// the Dock, Command-Tab, and the Window menu instead of exposing its
    /// implementation title as though it were another document window.
    pub(crate) fn hide_desktop_shell_if_browser_only(&self, app: &tauri::AppHandle) {
        #[cfg(target_os = "macos")]
        {
            let Some(sessions) = self.sessions() else {
                return;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // The Destroyed callback can run before Tauri removes the
                // source from its window map. Let that lifecycle settle before
                // deciding whether any native workspace remains.
                tokio::time::sleep(Duration::from_millis(100)).await;
                let has_session = sessions.lock().is_ok_and(|sessions| !sessions.is_empty());
                let windows = app.webview_windows();
                let browser_only = !windows.is_empty()
                    && windows.keys().all(|label| label.starts_with("browser-"));
                if has_session && browser_only {
                    if let Err(error) =
                        app.set_activation_policy(tauri::ActivationPolicy::Accessory)
                    {
                        log::warn!(
                            target: "lattice::browser",
                            "could not hide browser host from the desktop: {error}"
                        );
                    }
                }
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = app;
    }

    fn ensure_server(
        &self,
        app: &tauri::AppHandle,
        take_over_background_host: bool,
    ) -> Result<(u16, Sessions), String> {
        let mut running = self
            .running
            .lock()
            .map_err(|_| "Browser server state is unavailable.".to_string())?;
        if let Some(server) = running.as_ref() {
            return Ok((server.port, Arc::clone(&server.sessions)));
        }

        // A bookmark can only be permanent if its port is permanent. Do not
        // silently fall back to a random port: that would make the setting look
        // enabled while the saved address opens some other process or nothing.
        let listener = bind_browser_listener(take_over_background_host).map_err(|error| {
                format!(
                    "Could not start local browser access at http://127.0.0.1:{PREFERRED_PORT}: {error}"
                )
            })?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not configure local browser access: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Could not read the local browser address: {error}"))?
            .port();
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let server_state = ServerState {
            app: app.clone(),
            port,
            sessions: Arc::clone(&sessions),
        };
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    log::error!(target: "lattice::browser", "browser listener failed: {error}");
                    return;
                }
            };
            let router = Router::new()
                .route("/__lattice_bridge", get(upgrade_bridge))
                .route("/__lattice_session", get(open_browser_session))
                .fallback(serve_asset)
                .with_state(server_state);
            if let Err(error) = axum::serve(listener, router).await {
                log::error!(target: "lattice::browser", "browser server stopped: {error}");
            }
        });
        *running = Some(RunningServer {
            port,
            sessions: Arc::clone(&sessions),
        });
        Ok((port, sessions))
    }
}

fn open_workspace_url(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    if app
        .state::<crate::chromium::ChromiumRuntime>()
        .open_url(url)?
    {
        return Ok(());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("Could not open the browser workspace: {error}"))
}

fn browser_origin(app: &tauri::AppHandle, port: u16) -> String {
    #[cfg(debug_assertions)]
    if let Some(url) = app.config().build.dev_url.as_ref() {
        return url.origin().ascii_serialization();
    }
    let _ = app;
    format!("http://127.0.0.1:{port}")
}

fn build_host_window(
    app: &tauri::AppHandle,
    host_label: &str,
    token: &str,
    port: u16,
) -> Result<(), String> {
    let config = serde_json::to_string(&HostBridgeConfig { token, port })
        .map_err(|error| format!("Could not configure browser access: {error}"))?;
    tauri::WebviewWindowBuilder::new(app, host_label, WebviewUrl::App("index.html".into()))
        .title("")
        .visible(false)
        .skip_taskbar(true)
        // This WebView is the native half of the browser bridge. WebKit's default
        // hidden-view policy suspends its JavaScript, which would leave later
        // browser invokes waiting forever.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(format!(
            "window.__LATTICE_BROWSER_HOST_CONFIG__ = {config};"
        ))
        .build()
        .map(|_| ())
        .map_err(|error| format!("Could not start the browser bridge: {error}"))
}

fn session_config(token: &str, session: &BrowserSession, port: u16) -> BrowserSessionConfig {
    BrowserSessionConfig {
        token: token.to_string(),
        bridge_port: port,
        label: session.host_label.clone(),
    }
}

/// Reuse a live token on reload and reuse the newest fixed-entry workspace for
/// a second tab. The latter makes the second tab replace the first browser peer
/// instead of opening the same project in two independent native hosts.
fn reusable_entry_config(
    sessions: &Sessions,
    port: u16,
    resume_token: Option<&str>,
) -> Option<BrowserSessionConfig> {
    let sessions = sessions.lock().ok()?;
    reusable_entry_config_from(&sessions, port, resume_token)
}

fn reusable_entry_config_from(
    sessions: &HashMap<String, BrowserSession>,
    port: u16,
    resume_token: Option<&str>,
) -> Option<BrowserSessionConfig> {
    if let Some(token) = resume_token {
        if let Some(session) = sessions.get(token) {
            return Some(session_config(token, session, port));
        }
    }
    sessions
        .iter()
        .filter(|(_, session)| session.entry_session)
        .max_by_key(|(_, session)| session.created_at)
        .map(|(token, session)| session_config(token, session, port))
}

fn valid_loopback_host(headers: &HeaderMap, port: u16) -> bool {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        == Some(format!("127.0.0.1:{port}").as_str())
}

fn valid_session_request(headers: &HeaderMap, browser_origin: &str, port: u16) -> bool {
    if !valid_loopback_host(headers, port) {
        return false;
    }
    let origin_matches = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        == Some(browser_origin);
    let same_origin_fetch = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        == Some("same-origin");
    origin_matches || same_origin_fetch
}

async fn open_browser_session(
    State(state): State<ServerState>,
    Query(query): Query<SessionQuery>,
    headers: HeaderMap,
) -> Response {
    let origin = browser_origin(&state.app, state.port);
    if !valid_session_request(&headers, &origin, state.port) {
        return StatusCode::FORBIDDEN.into_response();
    }

    // Select or reserve the entry under one lock so simultaneous fixed-address
    // loads converge on one privileged host.
    let selected = state.sessions.lock().ok().map(|mut sessions| {
        if let Some(config) =
            reusable_entry_config_from(&sessions, state.port, query.token.as_deref())
        {
            return (config, None);
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let host_label = format!("browser-{}", uuid::Uuid::new_v4().simple());
        let session = BrowserSession {
            source_label: None,
            host_label: host_label.clone(),
            project_root: None,
            browser_origin: origin.clone(),
            entry_session: true,
            created_at: Instant::now(),
            active: true,
            host: None,
            browser: None,
            desktop: None,
            bundled_chromium: false,
            visible_epoch: 0,
            desktop_return: None,
        };
        let config = session_config(&token, &session, state.port);
        sessions.insert(token.clone(), session);
        (config, Some((token, host_label)))
    });
    let Some((config, new_host)) = selected else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if let Some((token, host_label)) = new_host {
        if let Err(reason) = build_host_window(&state.app, &host_label, &token, state.port) {
            remove_session(&state.sessions, &token);
            return (StatusCode::INTERNAL_SERVER_ERROR, reason).into_response();
        }
        let app = state.app.clone();
        let sessions = Arc::clone(&state.sessions);
        tauri::async_runtime::spawn(async move {
            // A page that requests a token but never completes its WebSocket
            // handshake must not leave a hidden WebView alive indefinitely.
            tokio::time::sleep(SESSION_CONNECT_TIMEOUT).await;
            let settlement = settle_browser_session(&sessions, &token, 0, false);
            apply_session_settlement(&app, &sessions, settlement);
        });
    }

    let mut response = Json(config).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(origin) = HeaderValue::from_str(&origin) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    response
}

async fn upgrade_bridge(
    State(state): State<ServerState>,
    Query(query): Query<BridgeQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let allowed = valid_loopback_host(&headers, state.port)
        && state.sessions.lock().ok().is_some_and(|sessions| {
            sessions.get(&query.token).is_some_and(|session| {
                query.role == BridgeRole::Host
                    || headers
                        .get(header::ORIGIN)
                        .and_then(|origin| origin.to_str().ok())
                        == Some(session.browser_origin.as_str())
            })
        });
    if !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(MAX_BRIDGE_MESSAGE_SIZE)
        .max_frame_size(MAX_BRIDGE_MESSAGE_SIZE)
        .on_upgrade(move |socket| bridge_socket(state.app, state.sessions, query, socket))
        .into_response()
}

async fn bridge_socket(
    app: tauri::AppHandle,
    sessions: Sessions,
    query: BridgeQuery,
    socket: WebSocket,
) {
    let peer_id = uuid::Uuid::new_v4().simple().to_string();
    let (sender, mut outgoing) = mpsc::unbounded_channel();
    let (mut sink, mut incoming) = socket.split();
    let Some(registration) = register_peer(&sessions, &query, &peer_id, sender) else {
        return;
    };
    if registration.hide_desktop {
        if let Err(reason) = app
            .state::<crate::chromium::ChromiumRuntime>()
            .set_window_visibility(&registration.host_label, false)
        {
            log::warn!(target: "lattice::chromium", "could not hide Chromium workspace: {reason}");
        }
    }
    if registration.complete_desktop_return {
        let _ = complete_desktop_return(&app, &sessions, &query.token, None);
    }

    loop {
        tokio::select! {
            message = outgoing.recv() => {
                let Some(message) = message else { break };
                let closing = matches!(message, Message::Close(_));
                if sink.send(message).await.is_err() || closing { break; }
            }
            message = incoming.next() => {
                let Some(Ok(message)) = message else { break };
                match message {
                    Message::Text(message)
                        if query.role == BridgeRole::Host
                            && message.as_str() == DESKTOP_RETURN_COMPLETE =>
                    {
                        if !complete_desktop_return(
                            &app,
                            &sessions,
                            &query.token,
                            Some(&peer_id),
                        ) {
                            break;
                        }
                    }
                    Message::Text(_) | Message::Binary(_) => {
                        if let Some(target) = other_peer(&sessions, &query, &peer_id) {
                            let _ = target.send(message);
                        }
                    }
                    Message::Ping(payload) => {
                        let _ = sink.send(Message::Pong(payload)).await;
                    }
                    Message::Close(_) => break,
                    Message::Pong(_) => {}
                }
            }
        }
    }
    unregister_peer(app, sessions, query, peer_id);
}

fn take_returning_session(
    sessions: &Sessions,
    token: &str,
    host_peer_id: Option<&str>,
) -> Option<DesktopReturn> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get(token)?;
    let matches_host = host_peer_id
        .is_none_or(|peer_id| session.host.as_ref().map(|host| host.id.as_str()) == Some(peer_id));
    if session.desktop_return.is_none() || !matches_host {
        return None;
    }
    let session = sessions.get_mut(token)?;
    let request = session.desktop_return.as_mut()?;
    request.acknowledged = true;
    if request.target == DesktopReturnTarget::Bundled && session.desktop.is_none() {
        // The parked renderer reloads when takeover starts, so its socket can
        // be briefly absent when the host acknowledges the command response.
        // Keep the browser and host alive until that renderer reconnects.
        return Some(DesktopReturn::PendingBundled);
    }
    if request.target == DesktopReturnTarget::Native {
        return sessions.remove(token).map(DesktopReturn::Native);
    }
    session.desktop_return = None;
    session.visible_epoch = session.visible_epoch.wrapping_add(1);
    if let Some(browser) = session.browser.take() {
        let _ = browser
            .sender
            .send(Message::Text(r#"{"type":"desktop-returned"}"#.into()));
        let _ = browser.sender.send(Message::Close(None));
    }
    if let Some(host) = &session.host {
        let _ = host
            .sender
            .send(Message::Text(r#"{"type":"browser-reset"}"#.into()));
    }
    if let Some(desktop) = &session.desktop {
        let _ = desktop
            .sender
            .send(Message::Text(r#"{"type":"desktop-resumed"}"#.into()));
    }
    Some(DesktopReturn::Bundled(session.host_label.clone()))
}

fn complete_desktop_return(
    app: &tauri::AppHandle,
    sessions: &Sessions,
    token: &str,
    host_peer_id: Option<&str>,
) -> bool {
    let Some(returned) = take_returning_session(sessions, token, host_peer_id) else {
        return false;
    };
    let session = match returned {
        DesktopReturn::PendingBundled => return true,
        DesktopReturn::Bundled(host_label) => {
            show_chromium_workspace(app, &host_label);
            return true;
        }
        DesktopReturn::Native(session) => session,
    };
    let host_label = session.host_label;
    if let Some(browser) = session.browser {
        let _ = browser
            .sender
            .send(Message::Text(r#"{"type":"desktop-returned"}"#.into()));
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if let Some(window) = app.get_webview_window(&host_label) {
            let _ = window.destroy();
        }
    });
    false
}

fn register_peer(
    sessions: &Sessions,
    query: &BridgeQuery,
    peer_id: &str,
    sender: mpsc::UnboundedSender<Message>,
) -> Option<PeerRegistration> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(&query.token)?;
    let mut registration = PeerRegistration {
        host_label: session.host_label.clone(),
        hide_desktop: match query.role {
            BridgeRole::Browser => session.bundled_chromium,
            BridgeRole::Desktop => session.browser.is_some(),
            BridgeRole::Host => false,
        },
        complete_desktop_return: false,
    };
    let peer = Peer {
        id: peer_id.to_string(),
        sender,
    };
    match query.role {
        BridgeRole::Browser => {
            let reset_host = session.visible_epoch != 0;
            session.visible_epoch = session.visible_epoch.wrapping_add(1);
            if let Some(previous) = session.browser.replace(peer) {
                let _ = previous
                    .sender
                    .send(Message::Text(r#"{"type":"browser-replaced"}"#.into()));
                let _ = previous.sender.send(Message::Close(None));
            }
            if let Some(desktop) = &session.desktop {
                let _ = desktop
                    .sender
                    .send(Message::Text(r#"{"type":"desktop-suspended"}"#.into()));
            }
            if reset_host {
                if let Some(host) = &session.host {
                    let _ = host
                        .sender
                        .send(Message::Text(r#"{"type":"browser-reset"}"#.into()));
                }
            }
        }
        BridgeRole::Desktop => {
            session.bundled_chromium = true;
            registration.complete_desktop_return = session
                .desktop_return
                .as_ref()
                .is_some_and(|request| request.acknowledged);
            let reset_host = session.browser.is_none() && session.visible_epoch != 0;
            // Mark the initial fixed-Chromium connection so the session-create
            // timeout cannot retire it. Later standby reloads must preserve
            // the browser generation: otherwise a desktop reconnect during
            // the browser-close grace period cancels the pending resume.
            if session.visible_epoch == 0 {
                session.visible_epoch = 1;
            }
            if let Some(previous) = session.desktop.replace(peer) {
                let _ = previous.sender.send(Message::Close(None));
            }
            if session.browser.is_some() {
                if let Some(desktop) = &session.desktop {
                    let _ = desktop
                        .sender
                        .send(Message::Text(r#"{"type":"desktop-suspended"}"#.into()));
                }
            } else if reset_host {
                if let Some(host) = &session.host {
                    let _ = host
                        .sender
                        .send(Message::Text(r#"{"type":"browser-reset"}"#.into()));
                }
            }
        }
        BridgeRole::Host => {
            if let Some(previous) = session.host.replace(peer) {
                let _ = previous.sender.send(Message::Close(None));
            }
        }
    }
    notify_ready(session);
    Some(registration)
}

fn notify_ready(session: &BrowserSession) {
    let visible = session.browser.as_ref().or(session.desktop.as_ref());
    if !session.active || session.host.is_none() || visible.is_none() {
        return;
    }
    let ready =
        Message::Text(format!(r#"{{"type":"ready","label":"{}"}}"#, session.host_label).into());
    if let Some(host) = &session.host {
        let _ = host.sender.send(ready.clone());
    }
    if let Some(browser) = visible {
        let _ = browser.sender.send(ready);
    }
}

fn other_peer(
    sessions: &Sessions,
    query: &BridgeQuery,
    peer_id: &str,
) -> Option<mpsc::UnboundedSender<Message>> {
    let sessions = sessions.lock().ok()?;
    let session = sessions.get(&query.token)?;
    if !session.active {
        return None;
    }
    let (source, target) = match query.role {
        BridgeRole::Browser => (session.browser.as_ref(), session.host.as_ref()),
        BridgeRole::Desktop => {
            if session.browser.is_some() {
                return None;
            }
            (session.desktop.as_ref(), session.host.as_ref())
        }
        BridgeRole::Host => (
            session.host.as_ref(),
            session.browser.as_ref().or(session.desktop.as_ref()),
        ),
    };
    if source?.id != peer_id {
        return None;
    }
    target.map(|peer| peer.sender.clone())
}

fn shutdown_synara_if_idle(app: &tauri::AppHandle, sessions: &Sessions) {
    // Re-read the live map instead of acting on a snapshot taken while an old
    // host disconnected. A new fixed-entry session is inserted before its
    // WebView can request Synara, so observing it here is enough to keep that
    // new session's sidecar alive.
    let no_sessions = sessions.lock().is_ok_and(|sessions| sessions.is_empty());
    if no_sessions
        && app
            .webview_windows()
            .keys()
            .all(|label| label.starts_with("browser-"))
    {
        // The listener itself is intentionally resident, but the agent sidecar
        // is not. It is recreated on demand when a later tab asks for Agent.
        app.state::<super::synara::SynaraRuntime>().shutdown();
    }
}

fn show_chromium_workspace(app: &tauri::AppHandle, host_label: &str) {
    if let Err(reason) = app
        .state::<crate::chromium::ChromiumRuntime>()
        .set_window_visibility(host_label, true)
    {
        log::warn!(target: "lattice::chromium", "could not restore Chromium workspace: {reason}");
    }
}

/// Resume a parked bundled-Chromium surface, or atomically retire an entry
/// session when no visible peer returned during its reconnect grace period.
fn settle_browser_session(
    sessions: &Sessions,
    token: &str,
    visible_epoch: u64,
    resume_parked_desktop: bool,
) -> SessionSettlement {
    let Ok(mut sessions) = sessions.lock() else {
        return SessionSettlement::Unchanged;
    };
    let Some(session) = sessions.get_mut(token) else {
        return SessionSettlement::Unchanged;
    };
    if session.browser.is_some() || session.visible_epoch != visible_epoch {
        return SessionSettlement::Unchanged;
    }
    if let Some(desktop) = &session.desktop {
        // A replacement Desktop peer makes the disconnected Desktop's grace
        // timer stale. Only a Browser disconnect may resume a parked Desktop;
        // otherwise every Desktop reload would schedule another reload five
        // seconds later and loop forever.
        if !resume_parked_desktop {
            return SessionSettlement::Unchanged;
        }
        if let Some(host) = &session.host {
            let _ = host
                .sender
                .send(Message::Text(r#"{"type":"browser-reset"}"#.into()));
        }
        let _ = desktop
            .sender
            .send(Message::Text(r#"{"type":"desktop-resumed"}"#.into()));
        return SessionSettlement::ResumeDesktop(session.host_label.clone());
    }
    sessions
        .remove(token)
        .map(|session| SessionSettlement::Expire(session.host_label))
        .unwrap_or(SessionSettlement::Unchanged)
}

fn apply_session_settlement(
    app: &tauri::AppHandle,
    sessions: &Sessions,
    settlement: SessionSettlement,
) {
    match settlement {
        SessionSettlement::Unchanged => {}
        SessionSettlement::ResumeDesktop(host_label) => {
            show_chromium_workspace(app, &host_label);
        }
        SessionSettlement::Expire(host_label) => {
            if let Some(window) = app.get_webview_window(&host_label) {
                let _ = window.destroy();
            }
            shutdown_synara_if_idle(app, sessions);
        }
    }
}

fn unregister_peer(app: tauri::AppHandle, sessions: Sessions, query: BridgeQuery, peer_id: String) {
    let mut visible_epoch = None;
    let mut remove_session_now = false;
    if let Ok(mut sessions_guard) = sessions.lock() {
        let Some(session) = sessions_guard.get_mut(&query.token) else {
            return;
        };
        let peer = match query.role {
            BridgeRole::Browser => &mut session.browser,
            BridgeRole::Desktop => &mut session.desktop,
            BridgeRole::Host => &mut session.host,
        };
        if peer.as_ref().map(|peer| peer.id.as_str()) != Some(peer_id.as_str()) {
            return;
        }
        *peer = None;
        match query.role {
            BridgeRole::Browser => {
                session.visible_epoch = session.visible_epoch.wrapping_add(1);
                if session.browser.is_none() {
                    visible_epoch = Some(session.visible_epoch);
                }
            }
            BridgeRole::Desktop => {
                // A parked Chromium renderer reloads after browser takeover.
                // Its socket replacement must not invalidate the browser's
                // grace timer, but a real desktop close still needs a timer
                // that expires the hidden host when no browser replaces it.
                if session.browser.is_none() {
                    visible_epoch = Some(session.visible_epoch);
                }
            }
            BridgeRole::Host => {
                let message = if session.desktop_return.is_some() {
                    r#"{"type":"desktop-returned"}"#
                } else {
                    r#"{"type":"host-disconnected"}"#
                };
                for browser in [session.browser.as_ref(), session.desktop.as_ref()]
                    .into_iter()
                    .flatten()
                {
                    let _ = browser.sender.send(Message::Text(message.into()));
                }
                remove_session_now = true;
            }
        }
        if remove_session_now {
            sessions_guard.remove(&query.token);
        }
    }

    if remove_session_now {
        shutdown_synara_if_idle(&app, &sessions);
    }

    if let Some(epoch) = visible_epoch {
        tauri::async_runtime::spawn(async move {
            // A reload briefly replaces the browser socket. Preserve the host
            // across that gap, but retire it when the tab is actually gone.
            tokio::time::sleep(Duration::from_secs(5)).await;
            let settlement = settle_browser_session(
                &sessions,
                &query.token,
                epoch,
                query.role == BridgeRole::Browser,
            );
            apply_session_settlement(&app, &sessions, settlement);
        });
    }
}

fn send_session_error(sessions: &Sessions, token: &str, reason: &str) {
    let message = serde_json::json!({ "type": "error", "message": reason }).to_string();
    if let Ok(sessions) = sessions.lock() {
        if let Some(session) = sessions.get(token) {
            for peer in [
                session.host.as_ref(),
                session.browser.as_ref(),
                session.desktop.as_ref(),
            ]
            .into_iter()
            .flatten()
            {
                let _ = peer.sender.send(Message::Text(message.clone().into()));
            }
        }
    }
}

fn remove_session(sessions: &Sessions, token: &str) {
    if let Ok(mut sessions) = sessions.lock() {
        sessions.remove(token);
    }
}

async fn serve_asset(State(state): State<ServerState>, request: Request<Body>) -> Response {
    if !valid_loopback_host(request.headers(), state.port) {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    let requested = request.uri().path().trim_start_matches('/');
    if requested.starts_with("__lattice_") || requested.contains("..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    #[cfg(debug_assertions)]
    if path == "index.html" {
        let origin = browser_origin(&state.app, state.port);
        return axum::response::Redirect::temporary(&format!("{origin}/?latticeBrowser=1"))
            .into_response();
    }
    let Some(asset) = state.app.asset_resolver().get(path.to_string()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::new(Body::from(asset.bytes));
    *response.status_mut() = StatusCode::OK;
    if let Ok(content_type) = HeaderValue::from_str(&asset.mime_type) {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    if let Some(csp) = asset.csp_header {
        if let Ok(csp) = HeaderValue::from_str(&csp) {
            response
                .headers_mut()
                .insert(header::CONTENT_SECURITY_POLICY, csp);
        }
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        if path == "index.html" {
            HeaderValue::from_static("no-store")
        } else {
            HeaderValue::from_static("public, max-age=31536000, immutable")
        },
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    fn encoded_process_arguments(executable: &[u8], arguments: &[&[u8]]) -> Vec<u8> {
        let mut encoded = (arguments.len() as libc::c_int).to_ne_bytes().to_vec();
        encoded.extend_from_slice(executable);
        encoded.extend_from_slice(&[0, 0, 0]);
        for argument in arguments {
            encoded.extend_from_slice(argument);
            encoded.push(0);
        }
        encoded.extend_from_slice(b"HOME=/tmp\0");
        encoded
    }

    fn session(active: bool) -> BrowserSession {
        BrowserSession {
            source_label: Some("main".to_string()),
            host_label: "browser-test".to_string(),
            project_root: None,
            browser_origin: "http://127.0.0.1:18452".to_string(),
            entry_session: true,
            created_at: Instant::now(),
            active,
            host: None,
            browser: None,
            desktop: None,
            bundled_chromium: false,
            visible_epoch: 0,
            desktop_return: None,
        }
    }

    fn query(role: BridgeRole) -> BridgeQuery {
        BridgeQuery {
            token: "secret".to_string(),
            role,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stale_host_authorization_requires_the_exact_executable_and_single_host_argument() {
        let executable =
            std::path::Path::new("/Applications/Lattice.app/Contents/MacOS/research-writer");
        let raw = encoded_process_arguments(
            executable.as_os_str().as_encoded_bytes(),
            &[executable.as_os_str().as_encoded_bytes(), b"--browser-host"],
        );
        let arguments = parse_process_arguments(&raw)
            .unwrap()
            .into_iter()
            .map(<[u8]>::to_vec)
            .collect::<Vec<_>>();

        assert!(browser_host_arguments_match(&arguments, executable));

        let mut extra_argument = arguments.clone();
        extra_argument.push(b"--unexpected".to_vec());
        assert!(!browser_host_arguments_match(&extra_argument, executable));
        assert!(!browser_host_arguments_match(
            &arguments,
            std::path::Path::new("/tmp/research-writer")
        ));
    }

    #[test]
    fn inactive_handoff_does_not_relay_until_activated() {
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            "secret".to_string(),
            session(false),
        )])));
        let (host_sender, mut host_messages) = mpsc::unbounded_channel();
        let (browser_sender, _browser_messages) = mpsc::unbounded_channel();
        let host_query = query(BridgeRole::Host);
        let browser_query = query(BridgeRole::Browser);
        assert!(register_peer(&sessions, &host_query, "host", host_sender).is_some());
        assert!(register_peer(&sessions, &browser_query, "browser", browser_sender).is_some());
        assert!(other_peer(&sessions, &browser_query, "browser").is_none());
        assert!(host_messages.try_recv().is_err());

        let mut sessions_guard = sessions.lock().unwrap();
        let session = sessions_guard.get_mut("secret").unwrap();
        session.active = true;
        notify_ready(session);
        drop(sessions_guard);

        assert!(matches!(host_messages.try_recv(), Ok(Message::Text(_))));
        assert!(other_peer(&sessions, &browser_query, "browser").is_some());
    }

    #[test]
    fn desktop_return_requires_the_marked_session_and_current_host() {
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            "secret".to_string(),
            session(true),
        )])));
        let (host_sender, _host_messages) = mpsc::unbounded_channel();
        let host_query = query(BridgeRole::Host);
        assert!(register_peer(&sessions, &host_query, "current-host", host_sender,).is_some());

        assert!(take_returning_session(&sessions, "secret", Some("current-host")).is_none());
        {
            let mut sessions = sessions.lock().unwrap();
            sessions.get_mut("secret").unwrap().desktop_return = Some(DesktopReturnRequest {
                target: DesktopReturnTarget::Native,
                acknowledged: false,
            });
        }
        assert!(take_returning_session(&sessions, "secret", Some("stale-host")).is_none());
        assert!(take_returning_session(&sessions, "secret", Some("current-host")).is_some());
        assert!(sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn replacement_peer_revokes_the_previous_socket() {
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            "secret".to_string(),
            session(true),
        )])));
        let (host_sender, mut host_messages) = mpsc::unbounded_channel();
        let (first_sender, mut first_messages) = mpsc::unbounded_channel();
        let (second_sender, _second_messages) = mpsc::unbounded_channel();
        let host_query = query(BridgeRole::Host);
        let browser_query = query(BridgeRole::Browser);
        assert!(register_peer(&sessions, &host_query, "host", host_sender).is_some());
        assert!(register_peer(&sessions, &browser_query, "first", first_sender).is_some());
        let _ = first_messages.try_recv();
        let _ = host_messages.try_recv();

        assert!(register_peer(&sessions, &browser_query, "second", second_sender).is_some());

        assert!(matches!(
            first_messages.try_recv(),
            Ok(Message::Text(message)) if message.as_str().contains("browser-replaced")
        ));
        assert!(matches!(
            first_messages.try_recv(),
            Ok(Message::Close(None))
        ));
        assert!(matches!(
            host_messages.try_recv(),
            Ok(Message::Text(message)) if message.as_str().contains("browser-reset")
        ));
        assert!(other_peer(&sessions, &browser_query, "first").is_none());
        assert!(other_peer(&sessions, &browser_query, "second").is_some());
    }

    #[test]
    fn desktop_reconnect_cancels_the_disconnected_desktop_grace_timer() {
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            "secret".to_string(),
            session(true),
        )])));
        let (host_sender, mut host_messages) = mpsc::unbounded_channel();
        let (desktop_sender, _desktop_messages) = mpsc::unbounded_channel();
        let host_query = query(BridgeRole::Host);
        let desktop_query = query(BridgeRole::Desktop);
        assert!(register_peer(&sessions, &host_query, "host", host_sender).is_some());
        assert!(register_peer(&sessions, &desktop_query, "desktop", desktop_sender).is_some());

        let epoch = {
            let mut sessions = sessions.lock().unwrap();
            let session = sessions.get_mut("secret").unwrap();
            session.desktop = None;
            session.visible_epoch
        };
        let (reconnected_sender, mut reconnected_messages) = mpsc::unbounded_channel();
        assert!(register_peer(
            &sessions,
            &desktop_query,
            "desktop-reconnected",
            reconnected_sender,
        )
        .is_some());
        while host_messages.try_recv().is_ok() {}
        while reconnected_messages.try_recv().is_ok() {}

        assert!(matches!(
            settle_browser_session(&sessions, "secret", epoch, false),
            SessionSettlement::Unchanged
        ));
        assert!(host_messages.try_recv().is_err());
        assert!(reconnected_messages.try_recv().is_err());
    }

    #[test]
    fn external_browser_parks_and_then_resumes_bundled_chromium() {
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            "secret".to_string(),
            session(true),
        )])));
        let (host_sender, mut host_messages) = mpsc::unbounded_channel();
        let (desktop_sender, mut desktop_messages) = mpsc::unbounded_channel();
        let (browser_sender, _browser_messages) = mpsc::unbounded_channel();
        let host_query = query(BridgeRole::Host);
        let desktop_query = query(BridgeRole::Desktop);
        let browser_query = query(BridgeRole::Browser);
        assert!(register_peer(&sessions, &host_query, "host", host_sender).is_some());
        assert!(register_peer(&sessions, &desktop_query, "desktop", desktop_sender,).is_some());
        while host_messages.try_recv().is_ok() {}
        while desktop_messages.try_recv().is_ok() {}

        let registration =
            register_peer(&sessions, &browser_query, "browser", browser_sender).unwrap();
        assert!(registration.hide_desktop);
        assert!(matches!(
            desktop_messages.try_recv(),
            Ok(Message::Text(message)) if message.as_str().contains("desktop-suspended")
        ));
        assert!(other_peer(&sessions, &desktop_query, "desktop").is_none());
        while host_messages.try_recv().is_ok() {}

        let epoch = {
            let mut sessions = sessions.lock().unwrap();
            let session = sessions.get_mut("secret").unwrap();
            session.browser = None;
            session.visible_epoch = session.visible_epoch.wrapping_add(1);
            session.visible_epoch
        };
        let (reconnected_sender, mut reconnected_messages) = mpsc::unbounded_channel();
        assert!(register_peer(
            &sessions,
            &desktop_query,
            "desktop-reconnected",
            reconnected_sender,
        )
        .is_some());
        assert_eq!(
            sessions
                .lock()
                .unwrap()
                .get("secret")
                .unwrap()
                .visible_epoch,
            epoch,
            "a parked desktop reload must not cancel browser-close recovery"
        );
        while host_messages.try_recv().is_ok() {}
        while reconnected_messages.try_recv().is_ok() {}
        assert!(matches!(
            settle_browser_session(&sessions, "secret", epoch, true),
            SessionSettlement::ResumeDesktop(label) if label == "browser-test"
        ));
        assert!(matches!(
            host_messages.try_recv(),
            Ok(Message::Text(message)) if message.as_str().contains("browser-reset")
        ));
        assert!(matches!(
            reconnected_messages.try_recv(),
            Ok(Message::Text(message)) if message.as_str().contains("desktop-resumed")
        ));
        assert!(other_peer(&sessions, &desktop_query, "desktop-reconnected").is_some());
    }

    #[test]
    fn explicit_desktop_return_restores_bundled_chromium_without_retiring_its_session() {
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            "secret".to_string(),
            session(true),
        )])));
        let (host_sender, mut host_messages) = mpsc::unbounded_channel();
        let (desktop_sender, mut desktop_messages) = mpsc::unbounded_channel();
        let (browser_sender, mut browser_messages) = mpsc::unbounded_channel();
        assert!(register_peer(&sessions, &query(BridgeRole::Host), "host", host_sender,).is_some());
        assert!(register_peer(
            &sessions,
            &query(BridgeRole::Desktop),
            "desktop",
            desktop_sender,
        )
        .is_some());
        assert!(register_peer(
            &sessions,
            &query(BridgeRole::Browser),
            "browser",
            browser_sender,
        )
        .is_some());
        while host_messages.try_recv().is_ok() {}
        while desktop_messages.try_recv().is_ok() {}
        while browser_messages.try_recv().is_ok() {}
        {
            let mut sessions = sessions.lock().unwrap();
            let session = sessions.get_mut("secret").unwrap();
            // Browser takeover asks the parked Chromium page to reload. The
            // explicit return can arrive during the resulting socket gap.
            session.desktop = None;
            session.desktop_return = Some(DesktopReturnRequest {
                target: DesktopReturnTarget::Bundled,
                acknowledged: false,
            });
        }

        assert!(matches!(
            take_returning_session(&sessions, "secret", Some("host")),
            Some(DesktopReturn::PendingBundled)
        ));
        {
            let sessions = sessions.lock().unwrap();
            let session = sessions.get("secret").unwrap();
            assert!(session.browser.is_some());
            assert!(session.desktop_return.as_ref().unwrap().acknowledged);
        }

        let (reconnected_sender, mut reconnected_messages) = mpsc::unbounded_channel();
        let registration = register_peer(
            &sessions,
            &query(BridgeRole::Desktop),
            "desktop-reconnected",
            reconnected_sender,
        )
        .unwrap();
        assert!(registration.complete_desktop_return);
        while host_messages.try_recv().is_ok() {}
        while browser_messages.try_recv().is_ok() {}
        while reconnected_messages.try_recv().is_ok() {}
        assert!(matches!(
            take_returning_session(&sessions, "secret", None),
            Some(DesktopReturn::Bundled(label)) if label == "browser-test"
        ));

        let session = sessions.lock().unwrap();
        let session = session.get("secret").unwrap();
        assert!(session.browser.is_none());
        assert!(session.desktop.is_some());
        assert!(session.desktop_return.is_none());
        assert!(matches!(
            browser_messages.try_recv(),
            Ok(Message::Text(message)) if message.as_str().contains("desktop-returned")
        ));
        assert!(matches!(
            browser_messages.try_recv(),
            Ok(Message::Close(None))
        ));
        assert!(matches!(
            host_messages.try_recv(),
            Ok(Message::Text(message)) if message.as_str().contains("browser-reset")
        ));
        assert!(matches!(
            reconnected_messages.try_recv(),
            Ok(Message::Text(message)) if message.as_str().contains("desktop-resumed")
        ));
    }

    #[test]
    fn fixed_entry_resumes_a_live_token_and_replaces_a_stale_one() {
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            "current".to_string(),
            session(true),
        )])));

        let resumed = reusable_entry_config(&sessions, PREFERRED_PORT, Some("current")).unwrap();
        let replaced = reusable_entry_config(&sessions, PREFERRED_PORT, Some("expired")).unwrap();

        assert_eq!(resumed.token, "current");
        assert_eq!(replaced.token, "current");
        assert_eq!(replaced.bridge_port, PREFERRED_PORT);
        assert_eq!(replaced.label, "browser-test");
    }

    #[test]
    fn expiry_atomically_removes_only_the_disconnected_generation() {
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            "current".to_string(),
            session(true),
        )])));

        assert!(matches!(
            settle_browser_session(&sessions, "current", 1, false),
            SessionSettlement::Unchanged
        ));
        assert!(reusable_entry_config(&sessions, PREFERRED_PORT, None).is_some());

        assert!(matches!(
            settle_browser_session(&sessions, "current", 0, false),
            SessionSettlement::Expire(label) if label == "browser-test"
        ));
        assert!(reusable_entry_config(&sessions, PREFERRED_PORT, None).is_none());
    }

    #[test]
    fn privileged_routes_require_the_exact_loopback_host_and_browser_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:18452".parse().unwrap());
        headers.insert(header::ORIGIN, "http://127.0.0.1:18452".parse().unwrap());
        assert!(valid_session_request(
            &headers,
            "http://127.0.0.1:18452",
            PREFERRED_PORT
        ));

        headers.insert(header::HOST, "attacker.example".parse().unwrap());
        assert!(!valid_session_request(
            &headers,
            "http://127.0.0.1:18452",
            PREFERRED_PORT
        ));
        headers.insert(header::HOST, "127.0.0.1:18452".parse().unwrap());
        headers.insert(header::ORIGIN, "https://attacker.example".parse().unwrap());
        assert!(!valid_session_request(
            &headers,
            "http://127.0.0.1:18452",
            PREFERRED_PORT
        ));
    }
}
