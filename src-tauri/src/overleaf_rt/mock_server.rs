//! A mock Overleaf for the realtime tests: a local HTTP server, and on it a
//! socket.io 0.9 endpoint that joins one project and one document, answers
//! updates, and records every frame it is sent.

use super::client::lock;
use super::codec::*;
use super::tests::project_tree;
use super::RealtimeConfig;
use serde_json::{json, Value};
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
}

/// A mock serving `project`, where every document reads `lines`.
pub(crate) fn start_mock_serving(
    project: Value, lines: &[&str],
) -> (String, Arc<Mutex<MockState>>) {
    let (host, state) = start_mock(false);
    let mut serving = lock(&state);
    (serving.project, serving.lines) = (Some(project), Some(json!(lines)));
    drop(serving);
    (host, state)
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

/// The mock's host, and what it has seen.
pub(crate) fn start_mock(push_join: bool) -> (String, Arc<Mutex<MockState>>) {
    start_mock_with(push_join, 60)
}

/// A mock that names `heartbeat` seconds as its heartbeat timeout.
pub(crate) fn start_mock_with(push_join: bool, heartbeat: u64) -> (String, Arc<Mutex<MockState>>) {
    let state = Arc::new(Mutex::new(MockState { push_join, ..MockState::default() }));
    let seen = state.clone();
    let host = serve_http(move |request| {
        let url = request.url().to_string();
        let upgrade = url.contains("/socket.io/1/websocket/");
        let (cookie, origin) = (header(&request, "Cookie"), header(&request, "Origin"));
        lock(&seen).requests.push((url, cookie, origin));
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
    });
    (host, state)
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
