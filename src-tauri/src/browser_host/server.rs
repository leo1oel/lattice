//! The loopback HTTP server: the session and bridge routes, the WebSocket
//! relay between a hidden host WebView and its visible page, and the bundled
//! frontend assets.

use super::session::{
    self, BridgeQuery, BrowserSession, BrowserSessionConfig, Detached, Expired, Sessions,
};
use super::{
    browser_origin, build_host_window, destroy_window, new_host_label, new_token,
    reopen_in_native_window,
};
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
use serde::Deserialize;
use std::{collections::HashMap, net::TcpListener, sync::Arc, time::Duration};
use tauri::Manager;
use tokio::sync::mpsc;

const MAX_BRIDGE_MESSAGE_SIZE: usize = 256 * 1024 * 1024;
pub(super) const SESSION_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a disconnected workspace waits for a reload before the session
/// ends.
const RECONNECT_GRACE: Duration = Duration::from_secs(5);
/// Carries the session token on project PDF range reads, so it never lands in
/// a URL, the browser's history or a request log.
const SESSION_HEADER: &str = "x-lattice-session";

#[derive(Clone)]
struct ServerState {
    app: tauri::AppHandle,
    port: u16,
    sessions: Sessions,
}

#[derive(Default, Deserialize)]
struct SessionQuery {
    token: Option<String>,
    /// The single-use nonce of a tokenless entry address.
    entry: Option<String>,
}

/// Serve the routes on `listener` (already bound and non-blocking) until the
/// app exits.
pub(super) fn spawn(app: tauri::AppHandle, port: u16, sessions: Sessions, listener: TcpListener) {
    let state = ServerState { app, port, sessions };
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
            .route("/__lattice_asset", get(read_asset_range).options(asset_preflight))
            .fallback(serve_asset)
            .with_state(state);
        if let Err(error) = axum::serve(listener, router).await {
            log::error!(target: "lattice::browser", "browser server stopped: {error}");
        }
    });
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
        app.state::<crate::synara::SynaraRuntime>().shutdown();
    }
}

/// After `delay`, end a session whose tab never came back. A workspace a
/// native window had handed to the tab opens in a native window again rather
/// than vanishing.
pub(super) fn settle_later(
    app: &tauri::AppHandle, sessions: &Sessions, token: String, visible_epoch: u64, delay: Duration,
) {
    let (app, sessions) = (app.clone(), Arc::clone(sessions));
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let Some(Expired { host_label, native_return }) =
            session::settle_after_grace(&sessions, &token, visible_epoch)
        else {
            return;
        };
        let state = app.state::<crate::AppState>();
        let root = native_return.then(|| state.root_for(&host_label).ok().flatten());
        if let Some(root) = root.flatten() {
            if let Err(reason) = reopen_in_native_window(&app, &state, root) {
                log::error!(target: "lattice::browser", "could not reopen the workspace: {reason}");
            }
        }
        destroy_window(&app, &host_label);
        shutdown_synara_if_idle(&app, &sessions);
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
    let selected = state.sessions.lock().ok().map(|mut sessions| {
        let selection = session::select_entry(
            &mut sessions,
            state.port,
            query.token.as_deref(),
            query.entry.as_deref(),
        )?;
        if let Some(config) = selection {
            return Ok((config, None));
        }
        let token = new_token();
        let session = BrowserSession {
            entry_session: true,
            ..BrowserSession::new(new_host_label(), origin.clone())
        };
        let config = BrowserSessionConfig::new(&token, &session, state.port);
        sessions.insert(token.clone(), session);
        Ok::<_, session::StaleEntry>((config, Some(token)))
    });
    let Some(selected) = selected else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Ok((config, new_token)) = selected else {
        // The page reads this status to explain the stale entry address.
        let mut response = StatusCode::GONE.into_response();
        allow_origin(&mut response, &origin);
        return response;
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
    allow_origin(&mut response, &origin);
    response
}

fn allow_origin(response: &mut Response, origin: &str) {
    if let Ok(origin) = HeaderValue::from_str(origin) {
        response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
}

async fn upgrade_bridge(
    State(state): State<ServerState>, Query(query): Query<BridgeQuery>, headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let allowed = valid_loopback_host(&headers, state.port)
        && state.sessions.lock().ok().is_some_and(|sessions| {
            sessions.get(&query.token).is_some_and(|session| {
                query.role == session::BridgeRole::Host
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
    if !session::register_peer(&sessions, &query, &peer_id, sender) {
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
        // across that gap, but settle the session when the tab is actually gone.
        Some(Detached::Grace(epoch)) => {
            settle_later(&app, &sessions, query.token, epoch, RECONNECT_GRACE);
        }
    }
}

/// One range of a project PDF, as `read_project_asset_range` reads it for a
/// native window.
#[derive(Deserialize)]
struct AssetRangeQuery {
    path: String,
    version: String,
    start: u64,
    end: u64,
}

/// The hidden host window whose project a range read is for, and the page
/// origin to answer. The request must reach the exact loopback host, come from
/// the session's own page (same origin, or its development origin), and carry
/// a live session token in [`SESSION_HEADER`].
fn asset_session(
    headers: &HeaderMap, port: u16, sessions: &HashMap<String, BrowserSession>,
) -> Option<(String, String)> {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let session = sessions.get(header(SESSION_HEADER)?)?;
    let from_page = header("origin") == Some(session.browser_origin.as_str())
        || header("sec-fetch-site") == Some("same-origin");
    (valid_loopback_host(headers, port) && from_page)
        .then(|| (session.host_label.clone(), session.browser_origin.clone()))
}

/// Project PDF bytes for the browser page. The page could ask the hidden host
/// over the bridge, but binary replies cross it as base64 twice; this reads
/// the same checked range directly.
async fn read_asset_range(
    State(state): State<ServerState>, Query(query): Query<AssetRangeQuery>, headers: HeaderMap,
) -> Response {
    let session = session::lock(&state.sessions)
        .ok()
        .and_then(|sessions| asset_session(&headers, state.port, &sessions));
    let Some((host_label, browser_origin)) = session else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let Ok(Some(root)) = state.app.state::<crate::AppState>().root_for(&host_label) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let read = tauri::async_runtime::spawn_blocking(move || {
        crate::project::read_asset_range(&root, &query.path, &query.version, query.start, query.end)
    })
    .await;
    let mut response = match read {
        Ok(Ok(bytes)) => {
            let mut response = Response::new(Body::from(bytes));
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
            response
        }
        Ok(Err(reason)) => (StatusCode::UNPROCESSABLE_ENTITY, reason).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let headers_out = response.headers_mut();
    headers_out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers_out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    // Same-origin pages need no CORS; only a development page served from the
    // dev server is let read the reply.
    if headers.get(header::ORIGIN).and_then(|origin| origin.to_str().ok())
        == Some(browser_origin.as_str())
    {
        if let Ok(origin) = HeaderValue::from_str(&browser_origin) {
            headers_out.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            headers_out.insert(header::VARY, HeaderValue::from_static("Origin"));
        }
    }
    response
}

/// The CORS preflight a development page sends before its first range read;
/// a same-origin page never needs one.
async fn asset_preflight(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let origin = browser_origin(&state.app, state.port);
    if !valid_session_request(&headers, &origin, state.port) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers_out = response.headers_mut();
    if let Ok(origin) = HeaderValue::from_str(&origin) {
        headers_out.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers_out.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET"));
    headers_out
        .insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static(SESSION_HEADER));
    headers_out.insert(header::VARY, HeaderValue::from_static("Origin"));
    response
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
                valid_session_request(&headers, origin, crate::browser_host::PREFERRED_PORT),
                allowed,
                "{host} {request_origin}"
            );
        }
    }

    #[test]
    fn project_pdf_reads_need_the_session_token_in_a_header_from_the_sessions_own_page() {
        let port = crate::browser_host::PREFERRED_PORT;
        let origin = "http://127.0.0.1:18452";
        let sessions = HashMap::from([(
            "session-secret".to_string(),
            BrowserSession::new("browser-host-1".to_string(), origin.to_string()),
        )]);
        let request = |host: &str, token: Option<&str>, page: &[(&'static str, &str)]| {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, host.parse().unwrap());
            if let Some(token) = token {
                headers.insert(SESSION_HEADER, token.parse().unwrap());
            }
            for (name, value) in page {
                headers.insert(*name, value.parse().unwrap());
            }
            asset_session(&headers, port, &sessions).map(|(label, _)| label)
        };
        let same_origin = [("sec-fetch-site", "same-origin")];
        let host = "127.0.0.1:18452";
        let allowed = Some("browser-host-1".to_string());
        assert_eq!(request(host, Some("session-secret"), &same_origin), allowed);
        assert_eq!(request(host, Some("session-secret"), &[("origin", origin)]), allowed);
        // No token, a guessed one, or a token on another host or from another site.
        assert_eq!(request(host, None, &same_origin), None);
        assert_eq!(request(host, Some("session-guess"), &same_origin), None);
        assert_eq!(request("localhost:18452", Some("session-secret"), &same_origin), None);
        assert_eq!(
            request(
                host,
                Some("session-secret"),
                &[("origin", "https://attacker.example"), ("sec-fetch-site", "cross-site")]
            ),
            None
        );
    }
}
