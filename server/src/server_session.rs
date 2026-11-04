use crate::dispatch;
use crate::transport::{Server, Session};
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Instant};
pub(crate) fn equal(a: &str, b: &str) -> bool {
    let mut difference = a.len() ^ b.len();
    for (i, byte) in a.bytes().enumerate() {
        difference |= usize::from(byte ^ b.as_bytes().get(i).copied().unwrap_or(0));
    }
    difference == 0
}
pub(crate) fn authenticated(state: &Server, headers: &HeaderMap) -> bool {
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        if equal(token, &state.token) {
            return true;
        }
    }
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let Some(id) =
        cookie.split(';').map(str::trim).find_map(|v| v.strip_prefix("lattice_session="))
    else {
        return false;
    };
    state.sessions.lock().unwrap().get(id).is_some_and(|session| session.expires > Instant::now())
}
pub(crate) fn same_origin(state: &Server, headers: &HeaderMap) -> bool {
    match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(origin) => origin == state.public_origin,
        None => !headers
            .get("sec-fetch-site")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|site| matches!(site, "same-site" | "cross-site")),
    }
}
pub(crate) fn failure(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({"error":{"code":code,"message":message}}))).into_response()
}
pub(crate) fn authorize(state: &Server, headers: &HeaderMap) -> Result<(), Response> {
    if !same_origin(state, headers) {
        return Err(failure(
            StatusCode::FORBIDDEN,
            "origin_forbidden",
            "Cross-origin requests are not accepted.",
        ));
    }
    if !authenticated(state, headers) {
        return Err(failure(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Sign in using the server token.",
        ));
    }
    Ok(())
}
pub(crate) fn web_capabilities(state: &Server) -> Value {
    let mut value = dispatch::capabilities();
    value["agent"] = json!({"configured":state.agents.available(),"sandbox":"Linux Landlock ABI>=6","workspaceMode":"staged-explicit-writeback","writeback":"text edits/creations only; explicit headless_agent_apply; conflicts/bib/deletions/binary retained","gitWriteback":false,"bidirectionalLiveSync":false,"hostEditingTools":false,"minimumLandlockAbi":6});
    if state.agents.available() {
        value["commands"]
            .as_array_mut()
            .unwrap()
            .extend(crate::agent_runtime::COMMANDS.iter().map(|command| json!(command)));
        value["unavailable"]
            .as_array_mut()
            .unwrap()
            .retain(|item| item != "agent_sidecar" && item != "synara");
    }
    if let Some(commands) = value["commands"].as_array_mut() {
        commands.extend(crate::terminal_transport::COMMANDS.iter().map(|command| json!(command)));
    }
    if let Some(unavailable) = value["unavailable"].as_array_mut() {
        unavailable.retain(|item| item != "terminal");
    }
    value["terminalLimits"] =
        json!({"perTab":4,"global":32,"reconnectLeaseSeconds":10,"requiresBrowserSession":true});
    value["projectModel"] =
        json!("Independent project per authenticated browser tab; Bearer clients pin projectRoot.");
    if let Some(events) = value["events"].as_array_mut() {
        events.push(json!("server-ready"));
    }
    value
}
pub(crate) fn client_id(headers: &HeaderMap) -> Option<&str> {
    headers.get("x-lattice-client").and_then(|value| value.to_str().ok()).filter(|client| {
        (16..=64).contains(&client.len())
            && client.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}
pub(crate) fn selected_project(
    state: &Server, headers: &HeaderMap, client: Option<&str>,
) -> Option<PathBuf> {
    let id = session_id(headers)?;
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id)?;
    Some(client.and_then(|client| session.projects.get(client)).unwrap_or(&session.project).clone())
}
pub(crate) fn session_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|v| v.strip_prefix("lattice_session=").map(str::to_owned))
}
