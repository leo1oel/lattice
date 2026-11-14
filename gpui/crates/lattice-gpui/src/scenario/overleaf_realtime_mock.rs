//! The stand-in Overleaf's live channel (`overleaf_mock`, once
//! `MockOverleaf::enable_realtime`): Socket.IO 0.9 over a websocket on the
//! same 127.0.0.1 server, as lattice-core's own realtime mock speaks it
//! (`src-tauri/lattice-core/src/overleaf_rt/mock_server.rs`).
//!
//! - The handshake (`GET /socket.io/1/`) names a session; the upgrade
//!   (`/socket.io/1/websocket/{sid}`) opens the socket, which says
//!   `connectionAccepted` with a public id of its own.
//! - `joinProject` answers the project's tree; `joinDoc` a document's
//!   lines (each UTF-8 byte packed as a character, as Overleaf packs them)
//!   and version; `leaveDoc` is acknowledged.
//! - `applyOtUpdate` is transformed against what landed since the version
//!   it was built on (ShareJS's left side, as Overleaf's document updater
//!   does) and applied; its sender hears `{doc, v}`, everyone else the
//!   operation. The document's text is the project's file, so the REST
//!   download serves it, and its version moves on.
//! - `clientTracking.getConnectedUsers` lists the other sockets and the
//!   scripted collaborators; `clientTracking.updatePosition` is broadcast as
//!   `clientUpdated`.
//!
//! The scenario plays a collaborator through [`super::overleaf_mock::MockOverleaf`]:
//! arriving at a line, typing, leaving.

use std::{
    collections::BTreeMap,
    io::ErrorKind,
    net::TcpStream,
    sync::{Arc, mpsc},
    time::Duration,
};

use lattice_core::overleaf_rt::{OtOp, ot};
use serde_json::{Value, json};
use tungstenite::{Message, protocol::Role};

/// A collaborator the scenario plays.
pub const PEER_ID: &str = "peer-1";
pub const PEER_NAME: &str = "Ada Lovelace";
const PEER_USER: &str = "u-ada";

/// One document as Overleaf keeps it: every operation it accepted, in order,
/// each at the version it applied at.
#[derive(Default)]
struct Doc {
    history: Vec<Vec<OtOp>>,
}

#[derive(Default)]
pub(super) struct Live {
    docs: BTreeMap<String, Doc>,
    /// Each open socket: its public id and its outgoing frames.
    sockets: Vec<(String, mpsc::Sender<String>)>,
    next_socket: u32,
    /// The scripted collaborator, while they are in the project.
    peer: Option<Value>,
    /// Every position the app said its caret is at, as sent.
    pub(super) positions: Vec<Value>,
    /// Every update the app sent, as sent.
    pub(super) updates: Vec<Value>,
    /// Every update refused, with the text it met.
    pub(super) rejected: Vec<Value>,
}

/// The id a project path's document goes by.
pub fn doc_id(path: &str) -> String {
    format!("doc-{}", path.replace(['/', '.'], "-"))
}

/// Whether Overleaf edits `path` as text.
pub(super) fn is_doc(path: &str) -> bool {
    [".tex", ".bib", ".md", ".txt", ".cls", ".sty"]
        .iter()
        .any(|extension| path.ends_with(extension))
}

fn event(name: &str, args: Value) -> String {
    format!("5:::{}", json!({ "name": name, "args": args }))
}

fn ack(id: &str, args: Value) -> String {
    format!("6:::{id}+{args}")
}

/// Packed the way Overleaf sends lines: each UTF-8 byte as a character.
fn packed(line: &str) -> String {
    line.bytes().map(char::from).collect()
}

/// The handshake's answer: a session id, the heartbeat and close timeouts,
/// and the transports.
pub(super) fn handshake() -> Vec<u8> {
    b"mock-sid:60:60:websocket".to_vec()
}

/// What the stand-in's realtime side shares with its REST side: the
/// project's files and its version, and the live state.
pub(super) trait Store: Send + Sync + 'static {
    fn with<R>(&self, work: impl FnOnce(&mut BTreeMap<String, Vec<u8>>, &mut Live) -> R) -> R;
    /// A file changed through the live channel: the project's version moves
    /// on, by `author`.
    fn bump(&self, path: &str, author: &str);
}

/// Answer the upgrade on `stream`, then serve the socket until it closes.
pub(super) fn upgrade(
    mut stream: TcpStream,
    key: &str,
    store: Arc<impl Store>,
) -> std::io::Result<()> {
    use std::io::Write as _;
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    write!(
        stream,
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    )?;
    stream.set_read_timeout(Some(Duration::from_millis(40)))?;
    let mut socket = tungstenite::WebSocket::from_raw_socket(stream, Role::Server, None);
    let (sender, outgoing) = mpsc::channel::<String>();
    let public_id = store.with(|_, live| {
        live.next_socket += 1;
        let id = format!("pub-{}", live.next_socket);
        live.sockets.push((id.clone(), sender.clone()));
        id
    });
    sender.send("1::".into()).ok();
    sender
        .send(event("connectionAccepted", json!([null, public_id])))
        .ok();
    loop {
        while let Ok(frame) = outgoing.try_recv() {
            if socket.send(Message::text(frame)).is_err() {
                return forget(&store, &public_id);
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                for reply in answer_frame(text.as_str(), &public_id, &store) {
                    sender.send(reply).ok();
                }
            }
            Ok(Message::Close(_)) => return forget(&store, &public_id),
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return forget(&store, &public_id),
        }
    }
}

fn forget(store: &Arc<impl Store>, public_id: &str) -> std::io::Result<()> {
    store.with(|_, live| live.sockets.retain(|(id, _)| id != public_id));
    Ok(())
}

/// Tell every socket but `except` (all, when none).
fn broadcast(live: &Live, except: Option<&str>, frame: &str) {
    for (id, sender) in &live.sockets {
        if Some(id.as_str()) != except {
            sender.send(frame.to_string()).ok();
        }
    }
}

/// The replies to one frame from the app.
fn answer_frame(text: &str, public_id: &str, store: &Arc<impl Store>) -> Vec<String> {
    let mut parts = text.splitn(4, ':');
    let (kind, id, _, data) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default().trim_end_matches('+'),
        parts.next(),
        parts.next().unwrap_or_default(),
    );
    if kind != "5" {
        return Vec::new();
    }
    let Ok(message) = serde_json::from_str::<Value>(data) else {
        return Vec::new();
    };
    let name = message["name"].as_str().unwrap_or_default();
    let args = message["args"].as_array().cloned().unwrap_or_default();
    match name {
        "joinProject" => vec![ack(
            id,
            json!([null, store.with(|files, _| tree(files)), "owner", 2]),
        )],
        "joinDoc" => {
            let doc = args.first().and_then(Value::as_str).unwrap_or_default();
            store.with(|files, live| {
                let Some((path, bytes)) = files.iter().find(|(path, _)| doc_id(path) == doc) else {
                    return vec![ack(id, json!(["doc not found"]))];
                };
                let text = String::from_utf8_lossy(bytes).into_owned();
                let lines: Vec<String> = text.split('\n').map(packed).collect();
                let version = live.docs.entry(path.clone()).or_default().history.len();
                vec![ack(
                    id,
                    json!([null, lines, version, [], { "comments": [], "changes": [] }]),
                )]
            })
        }
        "leaveDoc" => vec![ack(id, json!([null]))],
        "applyOtUpdate" => apply(
            id,
            args.get(1).cloned().unwrap_or_default(),
            public_id,
            store,
        ),
        "clientTracking.getConnectedUsers" => {
            let users = store.with(|_, live| {
                let mut users: Vec<Value> = live
                    .sockets
                    .iter()
                    .filter(|(id, _)| id != public_id)
                    .map(|(id, _)| json!({ "client_id": id, "first_name": "Another", "last_name": "Tab", "user_id": "u-mock" }))
                    .collect();
                users.extend(live.peer.as_ref().map(|peer| json!({
                    "client_id": PEER_ID,
                    "first_name": "Ada",
                    "last_name": "Lovelace",
                    "user_id": PEER_USER,
                    "email": "ada@example.edu",
                    "cursorData": { "doc_id": peer["doc_id"], "row": peer["row"], "column": peer["column"] },
                })));
                users
            });
            vec![ack(id, json!([null, users]))]
        }
        "clientTracking.updatePosition" => {
            let position = args.first().cloned().unwrap_or_default();
            store.with(|_, live| {
                live.positions.push(position.clone());
                let mut said = position.clone();
                said["id"] = json!(public_id);
                said["name"] = json!("Mock Researcher");
                said["user_id"] = json!("u-mock");
                broadcast(
                    live,
                    Some(public_id),
                    &event("clientTracking.clientUpdated", json!([said])),
                );
            });
            Vec::new()
        }
        _ if !id.is_empty() => vec![ack(id, json!([null]))],
        _ => Vec::new(),
    }
}

/// `applyOtUpdate`: queued (the ack), then applied, transformed against what
/// landed since its version, or refused.
fn apply(id: &str, update: Value, public_id: &str, store: &Arc<impl Store>) -> Vec<String> {
    let doc = update["doc"].as_str().unwrap_or_default().to_string();
    let at = update["v"].as_i64().unwrap_or(-1);
    let ops: Vec<OtOp> = serde_json::from_value(update["op"].clone()).unwrap_or_default();
    let applied = store.with(|files, live| {
        live.updates.push(update.clone());
        let path = files.keys().find(|path| doc_id(path) == doc)?.clone();
        let history = &mut live.docs.entry(path.clone()).or_default().history;
        if at < 0 || at as usize > history.len() {
            return None;
        }
        let mut incoming = ops.clone();
        for accepted in &history[at as usize..] {
            incoming = ot::transform_both(&incoming, accepted).0;
        }
        let text = String::from_utf8_lossy(&files[&path]).into_owned();
        let Some(next) = ot::apply_ops(&text, &incoming) else {
            live.rejected.push(json!({ "update": update, "transformed": incoming, "text": text, "version": history.len() }));
            return None;
        };
        files.insert(path.clone(), next.into_bytes());
        let version = history.len();
        history.push(incoming.clone());
        let others = event(
            "otUpdateApplied",
            json!([{ "doc": doc, "v": version, "op": incoming, "meta": { "source": public_id, "user_id": "u-mock" } }]),
        );
        broadcast(live, Some(public_id), &others);
        Some((path, version))
    });
    let mut replies = vec![ack(id, json!([null]))];
    match applied {
        Some((path, version)) => {
            store.bump(&path, "u-mock");
            replies.push(event(
                "otUpdateApplied",
                json!([{ "doc": doc, "v": version }]),
            ));
        }
        None => replies.push(event(
            "otUpdateError",
            json!(["Delete component does not match", { "doc_id": doc }]),
        )),
    }
    replies
}

/// The project's tree, as `joinProject` describes it: everything at the
/// root, a document per text file and a file reference for the rest.
fn tree(files: &BTreeMap<String, Vec<u8>>) -> Value {
    let (docs, refs): (Vec<&String>, Vec<&String>) = files.keys().partition(|path| is_doc(path));
    json!({
        "_id": super::overleaf_mock::PROJECT_ID,
        "name": super::overleaf_mock::PROJECT_NAME,
        "rootDoc_id": docs.iter().find(|path| path.as_str() == "main.tex").map(|path| doc_id(path)),
        "rootFolder": [{
            "_id": "root-mock",
            "name": "rootFolder",
            "docs": docs.iter().map(|path| json!({ "_id": doc_id(path), "name": path })).collect::<Vec<_>>(),
            "fileRefs": refs.iter().map(|path| json!({ "_id": format!("file-{path}"), "name": path })).collect::<Vec<_>>(),
            "folders": [],
        }],
    })
}

/// The scripted collaborator arrives in (or moves to) `path`, at the
/// zero-based `row` and UTF-16 `column`.
pub(super) fn peer_at(live: &mut Live, path: &str, row: i64, column: i64) {
    let peer = json!({
        "id": PEER_ID, "user_id": PEER_USER, "name": PEER_NAME, "email": "ada@example.edu",
        "doc_id": doc_id(path), "row": row, "column": column,
    });
    live.peer = Some(peer.clone());
    broadcast(
        live,
        None,
        &event("clientTracking.clientUpdated", json!([peer])),
    );
}

/// The scripted collaborator leaves.
pub(super) fn peer_left(live: &mut Live) {
    if live.peer.take().is_some() {
        broadcast(
            live,
            None,
            &event("clientTracking.clientDisconnected", json!([PEER_ID])),
        );
    }
}

/// The scripted collaborator types `ops` into `path`, against its current
/// version; None when they do not fit.
pub(super) fn peer_typed(
    files: &mut BTreeMap<String, Vec<u8>>,
    live: &mut Live,
    path: &str,
    ops: Vec<OtOp>,
) -> Option<()> {
    let text = String::from_utf8_lossy(files.get(path)?).into_owned();
    let next = ot::apply_ops(&text, &ops)?;
    files.insert(path.to_string(), next.into_bytes());
    let history = &mut live.docs.entry(path.to_string()).or_default().history;
    let version = history.len();
    history.push(ops.clone());
    let update = json!([{ "doc": doc_id(path), "v": version, "op": ops, "meta": { "source": PEER_ID, "user_id": PEER_USER } }]);
    broadcast(live, None, &event("otUpdateApplied", update));
    Some(())
}
