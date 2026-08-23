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
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
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
    sessions: Sessions,
}

#[derive(Deserialize)]
struct BridgeQuery {
    token: String,
    role: BridgeRole,
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
        match self.open_session(app, None, host_label.clone(), Some(project_root), true) {
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

    fn open_session(
        &self,
        app: &tauri::AppHandle,
        source_label: Option<String>,
        host_label: String,
        project_root: Option<PathBuf>,
        active: bool,
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
                    active,
                    host: None,
                    browser: None,
                    browser_epoch: 0,
                },
            );
        }

        let config = serde_json::to_string(&HostBridgeConfig {
            token: &token,
            port,
        })
        .map_err(|error| format!("Could not configure browser access: {error}"))?;
        let built = tauri::WebviewWindowBuilder::new(
            app,
            &host_label,
            WebviewUrl::App("index.html".into()),
        )
        .title("Lattice browser host")
        .visible(false)
        .skip_taskbar(true)
        // This WebView is the native half of the browser bridge. WebKit's
        // default hidden-view policy suspends its JavaScript, which would
        // leave later browser invokes waiting forever.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(format!(
            "window.__LATTICE_BROWSER_HOST_CONFIG__ = {config};"
        ))
        .build();
        if let Err(error) = built {
            remove_session(&sessions, &token);
            return Err(format!("Could not start the browser bridge: {error}"));
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

    fn ensure_server(&self, app: &tauri::AppHandle) -> Result<(u16, Sessions), String> {
        let mut running = self
            .running
            .lock()
            .map_err(|_| "Browser server state is unavailable.".to_string())?;
        if let Some(server) = running.as_ref() {
            return Ok((server.port, Arc::clone(&server.sessions)));
        }

        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, PREFERRED_PORT))
            .or_else(|_| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
            .map_err(|error| format!("Could not start local browser access: {error}"))?;
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

async fn upgrade_bridge(
    State(state): State<ServerState>,
    Query(query): Query<BridgeQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let allowed = state.sessions.lock().ok().is_some_and(|sessions| {
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
        .on_upgrade(move |socket| bridge_socket(state.sessions, query, socket))
        .into_response()
}

async fn bridge_socket(sessions: Sessions, query: BridgeQuery, socket: WebSocket) {
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
                if sink.send(message).await.is_err() { break; }
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
    unregister_peer(sessions, query, peer_id);
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

fn unregister_peer(sessions: Sessions, query: BridgeQuery, peer_id: String) {
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

    if let Some(epoch) = browser_epoch {
        tauri::async_runtime::spawn(async move {
            // A reload briefly replaces the browser socket. Preserve the host
            // across that gap, but retire it when the tab is actually gone.
            tokio::time::sleep(Duration::from_secs(5)).await;
            if let Ok(sessions) = sessions.lock() {
                if let Some(session) = sessions.get(&query.token) {
                    if session.browser.is_none() && session.browser_epoch == epoch {
                        if let Some(host) = &session.host {
                            let _ = host
                                .sender
                                .send(Message::Text(r#"{"type":"peer-disconnected"}"#.into()));
                        }
                    }
                }
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
    let requested = request.uri().path().trim_start_matches('/');
    if requested.starts_with("__lattice_") || requested.contains("..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
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
}
