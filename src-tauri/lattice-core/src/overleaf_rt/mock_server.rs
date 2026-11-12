//! A mock Overleaf for the realtime tests: a local HTTP server, and on it a
//! socket.io 0.9 endpoint that joins one project and one document, answers
//! updates, and records every frame it is sent.
//!
//! [`start_mock_serving`] goes further and keeps every document as Overleaf
//! does (see `mock_ot`): updates are transformed against what landed first,
//! applied, and confirmed or refused the way the real server does it.

use super::client::lock;
use super::codec::*;
use super::mock_ot::{MockDoc, Refused};
use super::tests::project_tree;
use super::{OtOp, RealtimeConfig};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tiny_http::Response;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocket};
use tokio_tungstenite::tungstenite::Message;

/// A local HTTP server handing each request to `handle`, by its base URL.
pub(crate) fn serve_http(mut handle: impl FnMut(tiny_http::Request) + Send + 'static) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("bind the mock server");
    let port = server.server_addr().to_ip().expect("an IP listener").port();
    std::thread::spawn(move || server.incoming_requests().for_each(&mut handle));
    format!("http://127.0.0.1:{port}")
}

fn header(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.to_string())
}

/// `line` is a whole `Name: value` header line.
pub(crate) fn with_header<R: Read>(response: Response<R>, line: &str) -> Response<R> {
    response.with_header(line.parse::<tiny_http::Header>().expect("a header line"))
}

/// One HTTP request the mock saw: its URL, `Cookie` and `Origin`.
pub(crate) type Seen = (String, Option<String>, Option<String>);

#[derive(Default)]
pub(crate) struct MockState {
    /// The handshake, then the websocket upgrade.
    pub(crate) requests: Vec<Seen>,
    pub(crate) frames: Vec<String>,
    /// Newer Overleaf: join from the handshake query and push the project
    /// down, never answering a `joinProject` ask.
    push_join: bool,
    /// The project and the lines of every document in it, when not the
    /// default ones.
    project: Option<Value>,
    lines: Option<Value>,
    /// Every document by id, kept as Overleaf keeps it; empty for the
    /// canned answers.
    docs: HashMap<String, MockDoc>,
    /// Edits a collaborator makes to a document just after we join it,
    /// before anything we send can land.
    typed_after_join: Vec<(String, Vec<OtOp>)>,
    /// Every update is refused once queued, as a document updater that
    /// failed to apply it would.
    refuse_updates: bool,
}

/// A mock serving `project`, where every document starts out reading
/// `lines`, at version 42.
pub(crate) fn start_mock_serving(
    project: Value, lines: &[&str],
) -> (String, Arc<Mutex<MockState>>) {
    let state = realtime_state(project, lines);
    let seen = state.clone();
    let host = serve_http(move |request| answer_realtime(request, &seen, 60));
    (host, state)
}

/// What [`start_mock_serving`] serves, for a mock of the rest of Overleaf to
/// hand its realtime requests to [`answer_realtime`].
pub(crate) fn realtime_state(project: Value, lines: &[&str]) -> Arc<Mutex<MockState>> {
    fn doc_ids(folder: &Value, into: &mut Vec<String>) {
        let ids = folder["docs"].as_array().into_iter().flatten();
        into.extend(ids.filter_map(|doc| Some(doc["_id"].as_str()?.to_string())));
        (folder["folders"].as_array().into_iter().flatten()).for_each(|sub| doc_ids(sub, into));
    }
    let mut ids = Vec::new();
    doc_ids(&project["rootFolder"][0], &mut ids);
    let docs = (ids.into_iter()).map(|id| (id, MockDoc::new(&lines.join("\n"), 42))).collect();
    let state = MockState {
        project: Some(project),
        lines: Some(json!(lines)),
        docs,
        ..MockState::default()
    };
    Arc::new(Mutex::new(state))
}

/// The project now is `project`, its documents reading `texts` by id, each
/// at version 42: what a collaborator left it as since the last connection.
pub(crate) fn set_project(
    state: &Arc<Mutex<MockState>>, project: Value, texts: &[(String, String)],
) {
    let mut state = lock(state);
    state.project = Some(project);
    state.docs = (texts.iter()).map(|(id, text)| (id.clone(), MockDoc::new(text, 42))).collect();
}

/// Document `id` now reads `text`, at version 42.
pub(crate) fn set_doc(state: &Arc<Mutex<MockState>>, id: &str, text: &str) {
    lock(state).docs.insert(id.to_string(), MockDoc::new(text, 42));
}

/// What document `id` reads now, and its version.
pub(crate) fn doc_text(state: &Arc<Mutex<MockState>>, id: &str) -> (String, i64) {
    let doc = &lock(state).docs[id];
    (doc.text(), doc.version())
}

/// Refuse every update from now on, after acknowledging it was queued.
pub(crate) fn refuse_updates(state: &Arc<Mutex<MockState>>) {
    lock(state).refuse_updates = true;
}

/// A collaborator makes `ops` to document `id` right after we next join it.
pub(crate) fn type_after_join(state: &Arc<Mutex<MockState>>, id: &str, ops: Vec<OtOp>) {
    lock(state).typed_after_join.push((id.to_string(), ops));
}

/// The updates the mock was sent (`applyOtUpdate`'s payloads), in order.
pub(crate) fn sent_updates(state: &Arc<Mutex<MockState>>) -> Vec<Value> {
    let frames = lock(state).frames.clone();
    (frames.iter())
        .filter_map(|text| parse_event(&parse_frame(text).ok()?.data).ok())
        .filter(|(name, _)| name == "applyOtUpdate")
        .map(|(_, args)| args[1].clone())
        .collect()
}

/// The name of every socket event the mock was sent, in order.
pub(crate) fn sent_event_names(state: &Arc<Mutex<MockState>>) -> Vec<String> {
    let frames = lock(state).frames.clone();
    (frames.iter())
        .filter_map(|text| parse_event(&parse_frame(text).ok()?.data).ok())
        .map(|(name, _)| name)
        .collect()
}

/// The account the mock's dashboard says is signed in.
pub(crate) const MOCK_USER_ID: &str = "user-1";

/// The mock's host, and what it has seen.
pub(crate) fn start_mock(push_join: bool) -> (String, Arc<Mutex<MockState>>) {
    start_mock_with(push_join, 60)
}

/// A mock that names `heartbeat` seconds as its heartbeat timeout.
pub(crate) fn start_mock_with(push_join: bool, heartbeat: u64) -> (String, Arc<Mutex<MockState>>) {
    let state = Arc::new(Mutex::new(MockState { push_join, ..MockState::default() }));
    let seen = state.clone();
    let host = serve_http(move |request| answer_realtime(request, &seen, heartbeat));
    (host, state)
}

/// Answer one request the way the mock's realtime server does: the account
/// page, the socket.io handshake, and the websocket upgrade.
pub(crate) fn answer_realtime(
    request: tiny_http::Request, seen: &Arc<Mutex<MockState>>, heartbeat: u64,
) {
    let url = request.url().to_string();
    let upgrade = url.contains("/socket.io/1/websocket/");
    let (cookie, origin) = (header(&request, "Cookie"), header(&request, "Origin"));
    lock(seen).requests.push((url.clone(), cookie, origin));
    if url == "/project" {
        // The dashboard, where a session stored before the account id
        // was recorded looks it up.
        let page =
            Response::from_string(format!("<meta name=\"ol-user_id\" content=\"{MOCK_USER_ID}\">"));
        let _ = request.respond(with_header(page, "Content-Type: text/html"));
        return;
    }
    if !upgrade {
        // Load balancers pin the realtime session with a cookie of their
        // own; the upgrade has to carry it back or it lands on another
        // instance.
        let body = Response::from_string(format!("testsid:{heartbeat}:60:websocket"));
        let body = with_header(body, "Set-Cookie: ol-affinity=instance-7; Path=/; HttpOnly");
        let _ = request.respond(with_header(body, "Content-Type: text/plain"));
        return;
    }
    let Some(key) = header(&request, "Sec-WebSocket-Key") else { return };
    let accept = format!("Sec-WebSocket-Accept: {}", derive_accept_key(key.as_bytes()));
    let stream = request.upgrade("websocket", with_header(Response::empty(101), &accept));
    let seen = seen.clone();
    std::thread::spawn(move || {
        serve_websocket(WebSocket::from_raw_socket(stream, Role::Server, None), seen)
    });
}

pub(crate) fn mock_config(host: &str, cookie: &str) -> RealtimeConfig {
    let (host, cookie) = (host.to_string(), cookie.to_string());
    RealtimeConfig { user_id: None, host, cookie, project_id: "proj-1".to_string() }
}

fn event_frame(name: &str, args: Value) -> String {
    encode_frame(FRAME_EVENT, "", "", &json!({"name": name, "args": args}).to_string())
}

fn ack_frame(id: &str, args: Value) -> String {
    encode_frame(FRAME_ACK, "", "", &format!("{id}+{args}"))
}

fn serve_websocket<S: Read + Write>(mut ws: WebSocket<S>, state: Arc<Mutex<MockState>>) {
    let (push_join, project, lines) = {
        let state = lock(&state);
        let project = state.project.clone().unwrap_or_else(project_tree);
        (state.push_join, project, state.lines.clone().unwrap_or(json!(["line one", "line two"])))
    };
    let send = |ws: &mut WebSocket<S>, frame: String| ws.send(Message::text(frame));
    let _ = send(&mut ws, encode_frame(FRAME_CONNECT, "", "", ""));
    let _ = if push_join {
        let join = json!([{"publicId": "pub-1", "project": project, "permissionsLevel": "owner"}]);
        send(&mut ws, event_frame("joinProjectResponse", join))
    } else {
        send(&mut ws, event_frame("connectionAccepted", json!([null, "pub-1"])))
    };
    while let Ok(message) = ws.read() {
        let text = match message {
            Message::Text(text) => text.as_str().to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        lock(&state).frames.push(text.clone());
        let Ok(frame) = parse_frame(&text) else { continue };
        if frame.kind != FRAME_EVENT {
            continue;
        }
        let Ok((name, _)) = parse_event(&frame.data) else { continue };
        let id = frame.id.trim_end_matches('+').to_string();
        let sent = match name.as_str() {
            // A server that pushed the project ignores the ask entirely,
            // which is exactly the case the client has to survive.
            "joinProject" if push_join => Ok(()),
            "joinProject" => send(&mut ws, ack_frame(&id, json!([null, project, "owner", 2]))),
            "joinDoc" if !lock(&state).docs.is_empty() => {
                join_kept_doc(&mut ws, &state, &id, &frame.data)
            }
            "applyOtUpdate" if !lock(&state).docs.is_empty() => {
                apply_to_kept_doc(&mut ws, &state, &id, &frame.data)
            }
            "joinDoc" => {
                let ranges = json!({"comments": [{"id": "change-1", "op": {"p": 4, "c": "one", "t": "thread-1"}}],
                                    "changes": []});
                let ack = send(&mut ws, ack_frame(&id, json!([null, lines, 42, [], ranges])));
                // Unsolicited update from another collaborator...
                let update = json!([{"doc": "doc-1", "v": 43, "op": [{"p": 9, "i": "!"}],
                                     "meta": {"source": "someone-else"}}]);
                let _ = send(&mut ws, event_frame("otUpdateApplied", update));
                // ...and a heartbeat the client has to echo.
                let _ = send(&mut ws, encode_frame(FRAME_HEARTBEAT, "", "", ""));
                ack
            }
            "applyOtUpdate" | "leaveDoc" => send(&mut ws, ack_frame(&id, json!([null]))),
            _ => Ok(()),
        };
        if sent.is_err() {
            break;
        }
    }
}

/// `joinDoc` on a document the mock keeps: its text and version, then
/// whatever a collaborator was set to type straight after.
fn join_kept_doc<S: Read + Write>(
    ws: &mut WebSocket<S>, state: &Arc<Mutex<MockState>>, ack: &str, data: &str,
) -> tokio_tungstenite::tungstenite::Result<()> {
    let args = parse_event(data).map(|(_, args)| args).unwrap_or_default();
    let doc_id = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
    let mut state = lock(state);
    let Some(doc) = state.docs.get(&doc_id) else {
        return ws.send(Message::text(ack_frame(ack, json!(["doc not found"]))));
    };
    // Packed the way Overleaf sends lines: each UTF-8 byte as a character.
    let pack = |line: &str| line.bytes().map(char::from).collect::<String>();
    let lines: Vec<String> = doc.text().split('\n').map(pack).collect();
    let answer = json!([null, lines, doc.version(), [], {"comments": [], "changes": []}]);
    ws.send(Message::text(ack_frame(ack, answer)))?;
    let typed: Vec<Vec<OtOp>> = (state.typed_after_join.iter())
        .filter(|(id, _)| *id == doc_id)
        .map(|(_, ops)| ops.clone())
        .collect();
    state.typed_after_join.retain(|(id, _)| *id != doc_id);
    for ops in typed {
        let doc = state.docs.get_mut(&doc_id).expect("looked up above");
        let version = doc.submit(doc.version(), &ops, None).expect("a collaborator's edit fits");
        let update =
            json!([{"doc": doc_id, "v": version, "op": ops, "meta": {"source": "someone-else"}}]);
        ws.send(Message::text(event_frame("otUpdateApplied", update)))?;
    }
    Ok(())
}

/// `applyOtUpdate` on a document the mock keeps, answered as Overleaf does:
/// the ack says only that the update was queued, and then the sender alone
/// hears `{doc, v}` once it applied, or `otUpdateError` if it was refused.
fn apply_to_kept_doc<S: Read + Write>(
    ws: &mut WebSocket<S>, state: &Arc<Mutex<MockState>>, ack: &str, data: &str,
) -> tokio_tungstenite::tungstenite::Result<()> {
    let args = parse_event(data).map(|(_, args)| args).unwrap_or_default();
    let update = args.get(1).cloned().unwrap_or_default();
    let doc_id = update["doc"].as_str().unwrap_or_default().to_string();
    let ops: Vec<OtOp> = serde_json::from_value(update["op"].clone()).unwrap_or_default();
    let at = update["v"].as_i64().unwrap_or(-1);
    let mut state = lock(state);
    let refuse = state.refuse_updates;
    let outcome = match state.docs.get_mut(&doc_id) {
        Some(_) if refuse => Err(Refused::Mismatch),
        Some(doc) => doc.submit(at, &ops, update["hash"].as_str()),
        None => Err(Refused::Version),
    };
    drop(state);
    ws.send(Message::text(ack_frame(ack, json!([null]))))?;
    let answer = match outcome {
        Ok(version) => event_frame("otUpdateApplied", json!([{"doc": doc_id, "v": version}])),
        Err(refused) => {
            event_frame("otUpdateError", json!([format!("{refused:?}"), {"doc_id": doc_id}]))
        }
    };
    ws.send(Message::text(answer))
}
