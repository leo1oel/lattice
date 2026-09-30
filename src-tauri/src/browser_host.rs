//! Loopback browser host: serves the app to a browser on a fixed local port.
//!
//! `http://127.0.0.1:18452` is the fixed entry point. Every workspace opened
//! there is backed by a hidden native *host* WebView that owns the project and
//! relays IPC to the visible page over a WebSocket bridge (`session`). In
//! packaged builds the visible page is the bundled Chromium renderer
//! (`crate::chromium`); an ordinary browser tab can use the same entry on the
//! development and testing path (`--browser-host`).
//!
//! - `/__lattice_session` mints or resumes a session token for the fixed entry.
//! - `/__lattice_bridge` upgrades a host, browser, or desktop peer.
//! - everything else serves the bundled frontend assets.

mod session;
mod takeover;

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
use session::{BridgeQuery, BridgeRole, BrowserSession, BrowserSessionConfig, Detached, Sessions};
use std::{
    collections::HashMap,
    io,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, WebviewUrl};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::mpsc;

const PREFERRED_PORT: u16 = 18452;
const MAX_BRIDGE_MESSAGE_SIZE: usize = 256 * 1024 * 1024;
const SESSION_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a disconnected workspace waits for a reload.
const RECONNECT_GRACE: Duration = Duration::from_secs(5);
const SERVER_UNAVAILABLE: &str = "Browser server state is unavailable.";
pub(crate) const SERVICE_WINDOW_LABEL: &str = "browser-service";

#[derive(Default)]
pub(crate) struct BrowserHost {
    running: Mutex<Option<RunningServer>>,
}

#[derive(Clone)]
struct RunningServer {
    port: u16,
    sessions: Sessions,
}

#[derive(Clone)]
struct ServerState {
    app: tauri::AppHandle,
    port: u16,
    sessions: Sessions,
}

#[derive(Default, Deserialize)]
struct SessionQuery {
    token: Option<String>,
    /// Which surface asks: the bundled Chromium window or a browser tab.
    #[serde(default)]
    role: BridgeRole,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostBridgeConfig<'a> {
    token: &'a str,
    port: u16,
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
        let names_file = default_path.is_file() || !default_path.exists();
        match (default_path.parent(), default_path.file_name()) {
            (Some(parent), Some(file_name)) if names_file => {
                if parent.components().count() > 0 {
                    dialog = dialog.set_directory(parent);
                }
                dialog = dialog.set_file_name(file_name.to_string_lossy());
            }
            _ => dialog = dialog.set_directory(default_path),
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

fn dialog_path(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// The dialog plugin always parents its panels to the invoking WebView. In a
/// browser workspace that WebView is deliberately hidden, so AppKit puts the
/// panel behind the real browser. A synchronous, unparented rfd panel runs as
/// its own modal window and therefore appears in front without exposing the
/// bridge WebView itself.
async fn run_browser_dialog<T: Send + 'static>(
    window: &tauri::WebviewWindow, kind: &str, pick: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    if !window.label().starts_with("browser-") || window.label() == SERVICE_WINDOW_LABEL {
        return Err("Browser dialogs are only available to a browser workspace.".to_string());
    }
    tauri::async_runtime::spawn_blocking(pick)
        .await
        .map_err(|error| format!("Browser {kind} dialog stopped unexpectedly: {error}"))
}

#[tauri::command]
pub(crate) async fn browser_dialog_open(
    window: tauri::WebviewWindow, options: BrowserDialogOptions,
) -> Result<BrowserDialogSelection, String> {
    run_browser_dialog(&window, "open", move || {
        let dialog = browser_dialog_builder(&options);
        if options.multiple {
            let paths = if options.directory { dialog.pick_folders() } else { dialog.pick_files() };
            BrowserDialogSelection::Many(
                paths.map(|paths| paths.into_iter().map(dialog_path).collect()),
            )
        } else {
            let path = if options.directory { dialog.pick_folder() } else { dialog.pick_file() };
            BrowserDialogSelection::One(path.map(dialog_path))
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn browser_dialog_save(
    window: tauri::WebviewWindow, options: BrowserDialogOptions,
) -> Result<Option<String>, String> {
    run_browser_dialog(&window, "save", move || {
        browser_dialog_builder(&options).save_file().map(dialog_path)
    })
    .await
}

fn bind_browser_listener(take_over_background_host: bool) -> io::Result<TcpListener> {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, PREFERRED_PORT);
    match TcpListener::bind(address) {
        Ok(listener) => Ok(listener),
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            takeover::replace_stale_browser_host(address, take_over_background_host).ok_or(error)
        }
        Err(error) => Err(error),
    }
}

fn new_host_label() -> String {
    format!("browser-{}", uuid::Uuid::new_v4().simple())
}

fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl BrowserHost {
    pub(crate) fn open_project(
        &self, app: &tauri::AppHandle, state: &AppState, project_root: PathBuf,
    ) -> Result<String, String> {
        let host_label = new_host_label();
        state.bind_window(&host_label, project_root.clone())?;
        let opened =
            self.open_session(app, |origin| BrowserSession::new(host_label.clone(), origin));
        if let Err(reason) = opened {
            state.abandon_window(&host_label);
            return Err(reason);
        }
        Ok(host_label)
    }

    /// Open a browser-hosted project's authenticated URL again; false when no
    /// session backs `host_label`. The surface may focus the existing page or
    /// replace it with a fresh one; either outcome is usable, unlike focusing
    /// the deliberately hidden native host window.
    pub(crate) fn reopen_window(
        &self, app: &tauri::AppHandle, host_label: &str,
    ) -> Result<bool, String> {
        let Some(browser_url) = self.workspace_url(host_label)? else {
            return Ok(false);
        };
        open_workspace_url(app, &browser_url)?;
        Ok(true)
    }

    fn server(&self) -> Result<Option<RunningServer>, String> {
        Ok(self.running.lock().map_err(|_| SERVER_UNAVAILABLE.to_string())?.clone())
    }

    fn workspace_url(&self, host_label: &str) -> Result<Option<String>, String> {
        let Some(server) = self.server()? else {
            return Ok(None);
        };
        let sessions = session::lock(&server.sessions)?;
        Ok(sessions.iter().find(|(_, session)| session.host_label == host_label).map(
            |(token, session)| {
                BrowserSessionConfig::new(token, session, server.port).url(&session.browser_origin)
            },
        ))
    }

    /// Reopen the Chromium workspace owned by the fixed entry, if one is still
    /// alive. This is the macOS reopen behavior while its window is closed.
    pub(crate) fn reopen_entry(&self, app: &tauri::AppHandle) -> Result<bool, String> {
        let Some(server) = self.server()? else {
            return Ok(false);
        };
        let config = server.sessions.lock().ok().and_then(|sessions| {
            session::reusable_entry_config(&sessions, server.port, None, true)
        });
        let Some(config) = config else {
            return Ok(false);
        };
        open_workspace_url(app, &config.url(&browser_origin(app, server.port)))?;
        Ok(true)
    }

    /// Start the small loopback listener without creating a workspace. The
    /// listener survives browser-tab teardown and is what makes the bookmarked
    /// address a permanent entry point.
    pub(crate) fn start(
        &self, app: &tauri::AppHandle, take_over_background_host: bool,
    ) -> Result<u16, String> {
        self.ensure_server(app, take_over_background_host).map(|server| server.port)
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

    /// Register a new session, start its hidden host, and open its page.
    fn open_session(
        &self, app: &tauri::AppHandle, session: impl FnOnce(String) -> BrowserSession,
    ) -> Result<String, String> {
        let server = self.ensure_server(app, false)?;
        let token = new_token();
        let session = session(browser_origin(app, server.port));
        let host_label = session.host_label.clone();
        let browser_url =
            BrowserSessionConfig::new(&token, &session, server.port).url(&session.browser_origin);
        session::lock(&server.sessions)?.insert(token.clone(), session);

        let opened = build_host_window(app, &host_label, &token, server.port).and_then(|()| {
            open_workspace_url(app, &browser_url).inspect_err(|_| destroy_window(app, &host_label))
        });
        if let Err(error) = opened {
            session::remove(&server.sessions, &token);
            return Err(error);
        }
        Ok(browser_url)
    }

    fn ensure_server(
        &self, app: &tauri::AppHandle, take_over_background_host: bool,
    ) -> Result<RunningServer, String> {
        let mut running = self.running.lock().map_err(|_| SERVER_UNAVAILABLE.to_string())?;
        if let Some(server) = running.as_ref() {
            return Ok(server.clone());
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
        let server = RunningServer { port, sessions: Arc::new(Mutex::new(HashMap::new())) };
        let state = ServerState { app: app.clone(), port, sessions: Arc::clone(&server.sessions) };
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
                .with_state(state);
            if let Err(error) = axum::serve(listener, router).await {
                log::error!(target: "lattice::browser", "browser server stopped: {error}");
            }
        });
        *running = Some(server.clone());
        Ok(server)
    }
}

fn open_workspace_url(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    if app.state::<crate::chromium::ChromiumRuntime>().open_url(url)? {
        return Ok(());
    }
    open_in_default_browser(app, url)
}

fn open_in_default_browser(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
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
    app: &tauri::AppHandle, host_label: &str, token: &str, port: u16,
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
        .initialization_script(format!("window.__LATTICE_BROWSER_HOST_CONFIG__ = {config};"))
        .build()
        .map(|_| ())
        .map_err(|error| format!("Could not start the browser bridge: {error}"))
}

fn destroy_window(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

fn shutdown_synara_if_idle(app: &tauri::AppHandle, sessions: &Sessions) {
    // Re-read the live map instead of acting on a snapshot taken while an old
    // host disconnected. A new fixed-entry session is inserted before its
    // WebView can request Synara, so observing it here is enough to keep that
    // new session's sidecar alive.
    let no_sessions = sessions.lock().is_ok_and(|sessions| sessions.is_empty());
    if no_sessions && app.webview_windows().keys().all(|label| label.starts_with("browser-")) {
        // The listener itself is intentionally resident, but the agent sidecar
        // is not. It is recreated on demand when a later tab asks for Agent.
        app.state::<super::synara::SynaraRuntime>().shutdown();
    }
}

/// After `delay`, retire a session whose visible peer never came back.
fn settle_later(
    app: &tauri::AppHandle, sessions: &Sessions, token: String, visible_epoch: u64, delay: Duration,
) {
    let (app, sessions) = (app.clone(), Arc::clone(sessions));
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if let Some(host_label) =
            session::expire_abandoned_session(&sessions, &token, visible_epoch)
        {
            destroy_window(&app, &host_label);
            shutdown_synara_if_idle(&app, &sessions);
        }
    });
}

fn valid_loopback_host(headers: &HeaderMap, port: u16) -> bool {
    headers.get(header::HOST).and_then(|value| value.to_str().ok())
        == Some(format!("127.0.0.1:{port}").as_str())
}

fn valid_session_request(headers: &HeaderMap, browser_origin: &str, port: u16) -> bool {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    valid_loopback_host(headers, port)
        && (header("origin") == Some(browser_origin)
            || header("sec-fetch-site") == Some("same-origin"))
}

async fn open_browser_session(
    State(state): State<ServerState>, Query(query): Query<SessionQuery>, headers: HeaderMap,
) -> Response {
    let origin = browser_origin(&state.app, state.port);
    if !valid_session_request(&headers, &origin, state.port) {
        return StatusCode::FORBIDDEN.into_response();
    }

    // Select or reserve the entry under one lock so simultaneous fixed-address
    // loads converge on one privileged host.
    let bundled_chromium = query.role == BridgeRole::Desktop;
    let selected = state.sessions.lock().ok().map(|mut sessions| {
        if let Some(config) = session::reusable_entry_config(
            &sessions,
            state.port,
            query.token.as_deref(),
            bundled_chromium,
        ) {
            return (config, None);
        }
        let token = new_token();
        let session = BrowserSession {
            entry_session: true,
            bundled_chromium,
            ..BrowserSession::new(new_host_label(), origin.clone())
        };
        let config = BrowserSessionConfig::new(&token, &session, state.port);
        sessions.insert(token.clone(), session);
        (config, Some(token))
    });
    let Some((config, new_token)) = selected else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if let Some(token) = new_token {
        if let Err(reason) = build_host_window(&state.app, &config.label, &token, state.port) {
            session::remove(&state.sessions, &token);
            return (StatusCode::INTERNAL_SERVER_ERROR, reason).into_response();
        }
        // A page that requests a token but never completes its WebSocket
        // handshake must not leave a hidden WebView alive indefinitely.
        settle_later(&state.app, &state.sessions, token, 0, SESSION_CONNECT_TIMEOUT);
    }

    let mut response = Json(config).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(origin) = HeaderValue::from_str(&origin) {
        response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    response
}

async fn upgrade_bridge(
    State(state): State<ServerState>, Query(query): Query<BridgeQuery>, headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let allowed = valid_loopback_host(&headers, state.port)
        && state.sessions.lock().ok().is_some_and(|sessions| {
            sessions.get(&query.token).is_some_and(|session| {
                query.role == BridgeRole::Host
                    || headers.get(header::ORIGIN).and_then(|origin| origin.to_str().ok())
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
    app: tauri::AppHandle, sessions: Sessions, query: BridgeQuery, socket: WebSocket,
) {
    let peer_id = new_token();
    let (sender, mut outgoing) = mpsc::unbounded_channel();
    let (mut sink, mut incoming) = socket.split();
    if session::register_peer(&sessions, &query, &peer_id, sender).is_none() {
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
                        if let Some(target) = session::other_peer(&sessions, &query, &peer_id) {
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

    match session::detach_peer(&sessions, &query, &peer_id) {
        None => {}
        Some(Detached::SessionRemoved) => shutdown_synara_if_idle(&app, &sessions),
        // A reload briefly replaces the browser socket. Preserve the host
        // across that gap, but retire it when the tab is actually gone.
        Some(Detached::Grace(epoch)) => {
            settle_later(&app, &sessions, query.token, epoch, RECONNECT_GRACE);
        }
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
    let path = if requested.is_empty() { "index.html" } else { requested };
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
    let headers = response.headers_mut();
    if let Ok(content_type) = HeaderValue::from_str(&asset.mime_type) {
        headers.insert(header::CONTENT_TYPE, content_type);
    }
    if let Some(csp) = asset.csp_header.and_then(|csp| HeaderValue::from_str(&csp).ok()) {
        headers.insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    let cache =
        if path == "index.html" { "no-store" } else { "public, max-age=31536000, immutable" };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privileged_routes_require_the_exact_loopback_host_and_browser_origin() {
        let origin = "http://127.0.0.1:18452";
        for (host, request_origin, allowed) in [
            ("127.0.0.1:18452", origin, true),
            ("attacker.example", origin, false),
            ("127.0.0.1:18452", "https://attacker.example", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, host.parse().unwrap());
            headers.insert(header::ORIGIN, request_origin.parse().unwrap());
            assert_eq!(
                valid_session_request(&headers, origin, PREFERRED_PORT),
                allowed,
                "{host} {request_origin}"
            );
        }
    }
}
