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
pub(crate) const SERVICE_WINDOW_LABEL: &str = "browser-service";

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
    browser_epoch: u64,
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
        let Some(browser_url) = browser_url else {
            return Ok(false);
        };
        app.opener()
            .open_url(browser_url, None::<&str>)
            .map_err(|error| format!("Could not reopen the browser workspace: {error}"))?;
        Ok(true)
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
        app.opener()
            .open_url(browser_url, None::<&str>)
            .map_err(|error| format!("Could not reopen the browser workspace: {error}"))?;
        Ok(true)
    }

    /// Start the small loopback listener without creating a workspace. The
    /// listener survives browser-tab teardown and is what makes the bookmarked
    /// address a permanent entry point.
    pub(crate) fn start(&self, app: &tauri::AppHandle) -> Result<u16, String> {
        self.ensure_server(app).map(|(port, _)| port)
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
        let (port, sessions) = self.ensure_server(app)?;
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
                    browser_epoch: 0,
                },
            );
        }

        if let Err(error) = build_host_window(app, &host_label, &token, port) {
            remove_session(&sessions, &token);
            return Err(error);
        }

        if let Err(error) = app.opener().open_url(&browser_url, None::<&str>) {
            if let Some(window) = app.get_webview_window(&host_label) {
                let _ = window.destroy();
            }
            remove_session(&sessions, &token);
            return Err(format!("Could not open the browser: {error}"));
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

    fn ensure_server(&self, app: &tauri::AppHandle) -> Result<(u16, Sessions), String> {
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
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, PREFERRED_PORT))
            .map_err(|error| {
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
            browser_epoch: 0,
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
            if let Some(host_label) = expire_browser_session(&sessions, &token, 0) {
                if let Some(window) = app.get_webview_window(&host_label) {
                    let _ = window.destroy();
                }
                shutdown_synara_if_idle(&app, &sessions);
            }
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
                query.role != BridgeRole::Browser
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
    if !register_peer(&sessions, &query, &peer_id, sender) {
        return;
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

fn register_peer(
    sessions: &Sessions,
    query: &BridgeQuery,
    peer_id: &str,
    sender: mpsc::UnboundedSender<Message>,
) -> bool {
    let Ok(mut sessions) = sessions.lock() else {
        return false;
    };
    let Some(session) = sessions.get_mut(&query.token) else {
        return false;
    };
    let peer = Peer {
        id: peer_id.to_string(),
        sender,
    };
    match query.role {
        BridgeRole::Browser => {
            let replacing_browser = session.browser_epoch != 0;
            session.browser_epoch = session.browser_epoch.wrapping_add(1);
            if let Some(previous) = session.browser.replace(peer) {
                let _ = previous.sender.send(Message::Close(None));
            }
            if replacing_browser {
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
    true
}

fn notify_ready(session: &BrowserSession) {
    if !session.active || session.host.is_none() || session.browser.is_none() {
        return;
    }
    let ready =
        Message::Text(format!(r#"{{"type":"ready","label":"{}"}}"#, session.host_label).into());
    if let Some(host) = &session.host {
        let _ = host.sender.send(ready.clone());
    }
    if let Some(browser) = &session.browser {
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
        BridgeRole::Host => (session.host.as_ref(), session.browser.as_ref()),
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

/// Atomically retire an entry session after its reconnect grace period. Once
/// removed, a simultaneous fixed-address request must create a fresh session
/// rather than attaching to the host this expiry is about to destroy.
fn expire_browser_session(sessions: &Sessions, token: &str, browser_epoch: u64) -> Option<String> {
    let mut sessions = sessions.lock().ok()?;
    let expired = sessions
        .get(token)
        .is_some_and(|session| session.browser.is_none() && session.browser_epoch == browser_epoch);
    if !expired {
        return None;
    }
    sessions.remove(token).map(|session| session.host_label)
}

fn unregister_peer(app: tauri::AppHandle, sessions: Sessions, query: BridgeQuery, peer_id: String) {
    let mut browser_epoch = None;
    let mut remove_session_now = false;
    if let Ok(mut sessions_guard) = sessions.lock() {
        let Some(session) = sessions_guard.get_mut(&query.token) else {
            return;
        };
        let peer = match query.role {
            BridgeRole::Browser => &mut session.browser,
            BridgeRole::Host => &mut session.host,
        };
        if peer.as_ref().map(|peer| peer.id.as_str()) != Some(peer_id.as_str()) {
            return;
        }
        *peer = None;
        match query.role {
            BridgeRole::Browser => {
                session.browser_epoch = session.browser_epoch.wrapping_add(1);
                browser_epoch = Some(session.browser_epoch);
            }
            BridgeRole::Host => {
                if let Some(browser) = &session.browser {
                    let _ = browser.sender.send(Message::Text(
                        r#"{"type":"error","message":"The local Lattice host closed."}"#.into(),
                    ));
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

    if let Some(epoch) = browser_epoch {
        tauri::async_runtime::spawn(async move {
            // A reload briefly replaces the browser socket. Preserve the host
            // across that gap, but retire it when the tab is actually gone.
            tokio::time::sleep(Duration::from_secs(5)).await;
            if let Some(host_label) = expire_browser_session(&sessions, &query.token, epoch) {
                if let Some(window) = app.get_webview_window(&host_label) {
                    let _ = window.destroy();
                }
                shutdown_synara_if_idle(&app, &sessions);
            }
        });
    }
}

fn send_session_error(sessions: &Sessions, token: &str, reason: &str) {
    let message = serde_json::json!({ "type": "error", "message": reason }).to_string();
    if let Ok(sessions) = sessions.lock() {
        if let Some(session) = sessions.get(token) {
            for peer in [session.host.as_ref(), session.browser.as_ref()]
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
            browser_epoch: 0,
        }
    }

    fn query(role: BridgeRole) -> BridgeQuery {
        BridgeQuery {
            token: "secret".to_string(),
            role,
        }
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
        assert!(register_peer(&sessions, &host_query, "host", host_sender));
        assert!(register_peer(
            &sessions,
            &browser_query,
            "browser",
            browser_sender
        ));
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
        assert!(register_peer(&sessions, &host_query, "host", host_sender));
        assert!(register_peer(
            &sessions,
            &browser_query,
            "first",
            first_sender
        ));
        let _ = first_messages.try_recv();
        let _ = host_messages.try_recv();

        assert!(register_peer(
            &sessions,
            &browser_query,
            "second",
            second_sender
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

        assert!(expire_browser_session(&sessions, "current", 1).is_none());
        assert!(reusable_entry_config(&sessions, PREFERRED_PORT, None).is_some());

        let expired_host = expire_browser_session(&sessions, "current", 0).unwrap();
        assert_eq!(expired_host, "browser-test");
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
