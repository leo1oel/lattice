//! Same-origin, session/tab/project-owned HTTP and WebSocket relay.
use crate::{agent_runtime, server_session::*, transport::Server};
use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocketUpgrade},
        FromRequestParts, Path, Request, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
const MAX: usize = 16 * 1024 * 1024;
pub fn routes() -> Router<Server> {
    Router::new()
        .route("/api/agent/{client}/", any(root))
        .route("/api/agent/{client}/{*path}", any(proxy))
}
fn owner(state: &Server, headers: &HeaderMap, client: &str) -> Result<(String, PathBuf), Response> {
    if !(16..=64).contains(&client.len())
        || !client.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "invalid_client",
            "A browser tab identity is required.",
        ));
    }
    let session = session_id(headers)
        .filter(|id| {
            state.sessions.lock().unwrap().get(id).is_some_and(|s| s.expires > Instant::now())
        })
        .ok_or_else(|| {
            failure(
                StatusCode::FORBIDDEN,
                "agent_forbidden",
                "An agent requires a browser session.",
            )
        })?;
    let root = selected_project(state, headers, Some(client)).ok_or_else(|| {
        failure(StatusCode::FORBIDDEN, "agent_forbidden", "The session has expired.")
    })?;
    Ok((format!("{session}:{client}"), root))
}
pub async fn invoke(
    state: &Server, headers: &HeaderMap, root: &std::path::Path, command: &str, args: &Value,
) -> Response {
    let client = client_id(headers).unwrap_or("");
    let (owner, selected) = match owner(state, headers, client) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if selected != root
        || args
            .get("projectRoot")
            .and_then(Value::as_str)
            .is_some_and(|pin| state.core.confined(pin).ok().as_deref() != Some(root))
    {
        return failure(StatusCode::CONFLICT, "project_changed", "The agent project changed.");
    }
    let hub = state.agents.clone();
    let root = root.to_path_buf();
    let command = command.to_string();
    let client = client.to_string();
    match tokio::task::spawn_blocking(move || hub.invoke(&owner, &client, &root, &command)).await {
        Ok(Ok(mut value)) => {
            if let Some(origin) = value.get_mut("origin") {
                if let Some(path) = origin.as_str() {
                    *origin = json!(format!("{}{path}", state.agent_origin));
                }
            }
            Json(json!({"result":value})).into_response()
        }
        Ok(Err(error)) => failure(StatusCode::BAD_REQUEST, "agent_unavailable", &error),
        Err(_) => {
            failure(StatusCode::INTERNAL_SERVER_ERROR, "agent_failed", "Agent operation failed.")
        }
    }
}
async fn root(
    State(state): State<Server>, Path(client): Path<String>, request: Request,
) -> Response {
    entry(state, client, String::new(), request).await
}
async fn proxy(
    State(state): State<Server>, Path((client, path)): Path<(String, String)>, request: Request,
) -> Response {
    entry(state, client, path, request).await
}
async fn entry(state: Server, client: String, path: String, request: Request) -> Response {
    let (mut parts, body) = request.into_parts();
    let ws = WebSocketUpgrade::from_request_parts(&mut parts, &state).await.ok();
    relay(state, client, path, ws, Request::from_parts(parts, body)).await
}
async fn relay(
    state: Server, client: String, path: String, ws: Option<WebSocketUpgrade>, request: Request,
) -> Response {
    let headers = request.headers().clone();
    if let Err(error) = crate::agent_listener::authorize(&state, &headers) {
        return error;
    }
    let (owner_key, root) = match owner(&state, &headers, &client) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let agent = match state.agents.get(&owner_key, &root) {
        Ok(agent) => agent,
        Err(_) => {
            return failure(
                StatusCode::CONFLICT,
                "agent_stopped",
                "Open the agent panel for this project first.",
            )
        }
    };
    if path.len() > 2048 || path.split('/').any(|v| v == "..") || path.starts_with('/') {
        return failure(StatusCode::BAD_REQUEST, "invalid_path", "Invalid agent resource path.");
    }
    let (port, token) = {
        let agent = agent.lock().unwrap();
        (agent.port, agent.token.clone())
    };
    let mut url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}/{path}")).unwrap();
    if let Some(query) = request.uri().query() {
        let pairs = reqwest::Url::parse(&format!("http://localhost/?{query}")).unwrap();
        for (key, value) in pairs.query_pairs() {
            if key != "token" {
                let mut value = json!(value);
                agent.lock().unwrap().map(&mut value, true);
                url.query_pairs_mut().append_pair(&key, value.as_str().unwrap_or(""));
            }
        }
    }
    url.query_pairs_mut().append_pair("token", &token);
    if let Some(ws) = ws {
        url.set_scheme("ws").unwrap();
        let mut upstream = match url.as_str().into_client_request() {
            Ok(r) => r,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
        upstream
            .headers_mut()
            .insert("Origin", format!("http://127.0.0.1:{port}").parse().unwrap());
        let upstream = match tokio_tungstenite::connect_async_with_config(
            upstream,
            Some({
                let mut config = tungstenite::protocol::WebSocketConfig::default();
                config.max_message_size = Some(MAX);
                config.max_frame_size = Some(MAX);
                config
            }),
            false,
        )
        .await
        {
            Ok((stream, _)) => stream,
            Err(_) => {
                return failure(
                    StatusCode::BAD_GATEWAY,
                    "agent_connection_failed",
                    "Could not connect to the agent.",
                )
            }
        };
        return ws.max_message_size(MAX).on_upgrade(move|socket|async move{
            let (mut browser_tx,mut browser_rx)=socket.split();let (mut upstream_tx,mut upstream_rx)=upstream.split();let mut check=tokio::time::interval(Duration::from_secs(1));
            loop {tokio::select!{
                _=check.tick()=>{if owner(&state,&headers,&client).ok().as_ref()!=Some(&(owner_key.clone(),root.clone()))||state.agents.get(&owner_key,&root).is_err(){break;}},
                value=browser_rx.next()=>{let Some(Ok(message))=value else{break};let message=match message{Message::Text(text)=>tungstenite::Message::Text(map_text(&agent,&text,true).into()),Message::Binary(bytes)=>tungstenite::Message::Binary(bytes),Message::Ping(v)=>{let _=tokio::time::timeout(Duration::from_secs(2),browser_tx.send(Message::Pong(v))).await;continue;},Message::Pong(_)=>continue,Message::Close(_)=>break};if !matches!(tokio::time::timeout(Duration::from_secs(2),upstream_tx.send(message)).await,Ok(Ok(()))){break;}},
                value=upstream_rx.next()=>{let Some(Ok(message))=value else{break};let message=match message{tungstenite::Message::Text(text)=>Message::Text(map_text(&agent,&text,false).into()),tungstenite::Message::Binary(bytes)=>{if agent.lock().unwrap().contains_private(&bytes){break;}Message::Binary(bytes)},tungstenite::Message::Ping(v)=>{let _=tokio::time::timeout(Duration::from_secs(2),upstream_tx.send(tungstenite::Message::Pong(v))).await;continue;},tungstenite::Message::Pong(_)=>continue,_=>break};if !matches!(tokio::time::timeout(Duration::from_secs(2),browser_tx.send(message)).await,Ok(Ok(()))){break;}},
            }}let _=tokio::time::timeout(Duration::from_secs(2),upstream_tx.close()).await;let _=tokio::time::timeout(Duration::from_secs(2),browser_tx.close()).await;
        }).into_response();
    }
    let method = request.method().clone();
    let content_type = request.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = match to_bytes(request.into_body(), MAX).await {
        Ok(v) => v,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let body =
        if content_type.as_ref().is_some_and(|v| v.as_bytes().starts_with(b"application/json")) {
            map_text(&agent, &String::from_utf8_lossy(&bytes), true).into_bytes()
        } else {
            bytes.to_vec()
        };
    let client_http = match crate::http::async_builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .timeout(Duration::from_secs(60))
        .build()
    {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut upstream = client_http
        .request(method, url)
        .header(header::ORIGIN, format!("http://127.0.0.1:{port}"))
        .body(body);
    if let Some(value) = content_type {
        upstream = upstream.header(header::CONTENT_TYPE, value);
    }
    let response = match upstream.send().await {
        Ok(v) => v,
        Err(_) => {
            return failure(
                StatusCode::BAD_GATEWAY,
                "agent_connection_failed",
                "The agent did not answer.",
            )
        }
    };
    let status = response.status();
    let kind = response.headers().get(header::CONTENT_TYPE).cloned();
    if response.content_length().is_some_and(|size| size > MAX as u64) {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
        if chunk.len() > MAX.saturating_sub(bytes.len()) {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        bytes.extend_from_slice(&chunk);
    }
    if owner(&state, &headers, &client).ok().as_ref() != Some(&(owner_key.clone(), root.clone())) {
        return failure(StatusCode::FORBIDDEN, "agent_revoked", "The agent session changed.");
    }
    let text_kind = kind.as_ref().and_then(|v| v.to_str().ok()).unwrap_or("");
    let body = if text_kind.contains("text/html") {
        let prefix = format!("/api/agent/{client}/");
        let html = String::from_utf8_lossy(&bytes)
            .replace("src=\"/", &format!("src=\"{prefix}"))
            .replace("href=\"/", &format!("href=\"{prefix}"));
        html.replacen("<head>", &format!("<head><script>{}</script>", bootstrap(&prefix)), 1)
            .into_bytes()
    } else if text_kind.contains("application/json") {
        map_text(&agent, &String::from_utf8_lossy(&bytes), false).into_bytes()
    } else {
        if agent.lock().unwrap().contains_private(&bytes) {
            return StatusCode::BAD_GATEWAY.into_response();
        }
        bytes.to_vec()
    };
    let body = match std::str::from_utf8(&body) {
        Ok(text) => agent.lock().unwrap().redact(text).into_bytes(),
        Err(_) => {
            let guard = agent.lock().unwrap();
            if guard.contains_private(&body) {
                return StatusCode::BAD_GATEWAY.into_response();
            }
            body
        }
    };
    let mut result = (status, Body::from(body)).into_response();
    if let Some(kind) = kind {
        if agent.lock().unwrap().contains_private(kind.as_bytes()) {
            return StatusCode::BAD_GATEWAY.into_response();
        }
        result.headers_mut().insert(header::CONTENT_TYPE, kind);
    }
    result.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    result
}
fn map_text(agent: &Arc<Mutex<agent_runtime::Running>>, text: &str, to_stage: bool) -> String {
    let agent = agent.lock().unwrap();
    if let Ok(mut value) = serde_json::from_str::<Value>(text) {
        agent.map(&mut value, to_stage);
        agent.redact(&value.to_string())
    } else {
        agent.redact(text)
    }
}
fn bootstrap(prefix: &str) -> String {
    // Public sentinel selects the existing embedded legacy transport. It grants no access;
    // Rust replaces it with the private token only after cookie/tab/project validation.
    format!(
        r#"(()=>{{const base={base};globalThis.__LATTICE_AGENT_BASE__=base;const map=(input)=>{{const u=new URL(String(input),location.href);if(u.host===location.host&&/^(https?|wss?):$/.test(u.protocol)&&!u.pathname.startsWith(base))u.pathname=base+u.pathname.replace(/^\//,'');return u.href;}};const attribute=Element.prototype.setAttribute;Element.prototype.setAttribute=function(key,value){{return attribute.call(this,key,/^(src|href|poster|action)$/i.test(key)?map(value):value);}};const fetch0=window.fetch;window.fetch=(input,options)=>fetch0(input instanceof Request?new Request(map(input.url),input):map(input),options);const WS=window.WebSocket;window.WebSocket=class extends WS{{constructor(url,protocols){{super(map(url),protocols);}}}};const X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){{return X.call(this,method,map(url),...rest);}};for(const [type,key] of [[HTMLImageElement,'src'],[HTMLAnchorElement,'href'],[HTMLLinkElement,'href'],[HTMLScriptElement,'src']]){{const d=Object.getOwnPropertyDescriptor(type.prototype,key);if(d?.set)Object.defineProperty(type.prototype,key,{{...d,set(value){{d.set.call(this,map(value));}}}});}}const W=window.Worker;if(W)window.Worker=class extends W{{constructor(url,options){{const mapped=map(url);super(new URL(String(url),location.href).href===mapped?url:mapped,options);}}}};const h=new URLSearchParams(location.hash.slice(1));h.set('lattice-auth','headless-proxy');history.replaceState(history.state,'',location.pathname+location.search+'#'+h.toString());}})();"#,
        base = serde_json::to_string(prefix).unwrap()
    )
}
