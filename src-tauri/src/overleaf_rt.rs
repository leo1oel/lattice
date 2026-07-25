//! Overleaf real-time editing bridge — a Socket.IO **0.9** protocol client.
//!
//! Overleaf ships `socket.io-client 0.9.17-overleaf-5`, so the wire protocol is
//! the legacy one, not the modern Engine.IO/Socket.IO v4 framing. Everything
//! below is pinned against the reference client used by the Overleaf-Workshop
//! VS Code extension (`src/api/base.ts::_initSocketV0` + `src/api/socketio.ts`)
//! and Overleaf's own real-time server:
//!
//! - **Handshake.** `GET {origin}/socket.io/1/?projectId={id}&t={unix_millis}`
//!   carrying the browser session `Cookie` and a matching `Origin` header. The
//!   answer is plain text `{sid}:{heartbeat}:{close}:{transports}`, e.g.
//!   `d4Xk…:60:60:websocket,xhr-polling`. A redirect to `/login` (or an HTML
//!   body) means the cookie is dead.
//! - **Upgrade.** `{ws_origin}/socket.io/1/websocket/{sid}?projectId={id}&t={ms}`
//!   with `https`→`wss` / `http`→`ws`, again carrying `Cookie` and `Origin`.
//! - **Framing.** `{type}:{id}:{endpoint}:{data}` where type is one of
//!   0 disconnect, 1 connect, 2 heartbeat, 3 message, 4 json, 5 event, 6 ack,
//!   7 error, 8 noop. The trailing `:{data}` is omitted when there is no
//!   payload, which is why a heartbeat is the three-byte string `2::`. The
//!   server drops clients that do not echo `2::` promptly.
//! - **Events.** `5:::{"name":…,"args":[…]}`; adding an ack id turns it into
//!   `5:{id}+::{"name":…}` and the server answers `6:::{id}+[…args…]`.
//!
//! Concretely, this module emits exactly these frames (ack ids increase from 1;
//! id 0 is reserved internally for the `1::` connect gate):
//!
//! ```text
//! 5:1+::{"name":"joinProject","args":[{"project_id":"<id>"}]}
//! 5:2+::{"name":"joinDoc","args":["<docId>",{"encodeRanges":true}]}
//! 5:3+::{"name":"applyOtUpdate","args":["<docId>",{"doc":"<docId>","op":[{"p":5,"i":"hello"}],"v":42}]}
//! 5:4+::{"name":"leaveDoc","args":["<docId>"]}
//! 2::
//! ```
//!
//! Threading: one task pumps the websocket sink from an mpsc queue, one task
//! reads frames and dispatches them. Every runtime primitive comes from
//! `tauri::async_runtime` (which re-exports tokio's mpsc channel plus
//! `spawn`/`spawn_blocking`/`block_on`), so this module needs no direct `tokio`
//! dependency; the one thing that re-export does not cover — a timer for ack
//! timeouts — rides on a small parked helper thread that exits as soon as its
//! waiter is served.

// Only the tests reach into this module so far; drop this once the app wires it
// up, so genuinely unused code starts warning again.
#![allow(dead_code)]

use futures_util::sink::{Sink, SinkExt};
use futures_util::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime as rt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SESSION_EXPIRED: &str = "Overleaf session expired. Reconnect in Settings → Overleaf.";

/// How long we wait for a `6:::{id}+…` ack before giving up on a request.
const ACK_TIMEOUT: Duration = Duration::from_secs(10);
/// Granularity of the ack timeout helper thread; also how fast it notices that
/// the waiter is gone and exits early.
const ACK_TIMER_TICK: Duration = Duration::from_millis(100);
/// Outgoing frame queue depth. Deep enough that `try_send` from non-async
/// contexts (heartbeat echo, shutdown) never realistically fails.
const OUT_QUEUE: usize = 256;
/// Ack slot reserved for "the server accepted the connection" (`1::`). Real ack
/// ids start at 1, so 0 can never collide.
const CONNECT_SLOT: u32 = 0;
/// Ack slot for "we are in the project". Real ack ids count up from 1, so this
/// end of the range cannot collide with one.
const JOIN_SLOT: u32 = u32::MAX;
/// Said when this account may read the project but not change it.
pub const READ_ONLY: &str =
    "You have read-only access to this Overleaf project, so edits stay on this machine.";
/// Guard against a pathological (or hostile) folder tree.
const MAX_FOLDER_DEPTH: usize = 64;

pub const FRAME_DISCONNECT: u8 = 0;
pub const FRAME_CONNECT: u8 = 1;
pub const FRAME_HEARTBEAT: u8 = 2;
pub const FRAME_MESSAGE: u8 = 3;
pub const FRAME_JSON: u8 = 4;
pub const FRAME_EVENT: u8 = 5;
pub const FRAME_ACK: u8 = 6;
pub const FRAME_ERROR: u8 = 7;
pub const FRAME_NOOP: u8 = 8;

// ---- Public shapes --------------------------------------------------------

pub struct RealtimeConfig {
    pub host: String,
    pub cookie: String,
    pub project_id: String,
}

/// Events pushed to the app as they arrive.
#[derive(Debug, Clone, Serialize)]
// `rename_all` renames the variants; the fields inside them need their own
// rule, or the app receives `root_folder_id` where it expects `rootFolderId`.
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum RealtimeEvent {
    Connected {
        public_id: String,
    },
    ProjectJoined {
        root_folder_id: String,
        docs: Vec<DocEntry>,
        permission: Permission,
    },
    DocUpdate {
        doc_id: String,
        version: i64,
        ops: Vec<OtOp>,
        /// Who authored it. The server echoes our own updates back, and the
        /// app has to tell its own acknowledgement apart from someone else's
        /// edit — applying your own work twice would duplicate what you typed.
        source: Option<String>,
    },
    OtError {
        doc_id: String,
        message: String,
    },
    /// Overleaf accepted the operation we sent.
    ///
    /// The server does not echo an operation back to whoever sent it — the
    /// originating client gets `{doc, v}` with no `op` at all, and everyone
    /// else gets the operation. Treating that bare answer as an acknowledgement
    /// is the whole of the client's send loop: miss it and the operation stays
    /// in flight forever, and every later edit queues behind it unsent.
    DocAck {
        doc_id: String,
        /// The version the operation applied at; the document moves to v + 1.
        version: i64,
    },
    /// A comment thread was anchored to a span of an open document. Arrives
    /// when someone comments while we have the file open, so the marker can
    /// appear without re-opening it.
    CommentAnchored {
        doc_id: String,
        range: CommentRange,
    },
    /// The project's files changed: something was created, renamed, moved or
    /// deleted, by anyone.
    ///
    /// Carries the whole document list rather than the delta. The events
    /// Overleaf sends are id-keyed deltas against a tree the client has to
    /// maintain itself, and having done that work once here there is nothing
    /// to gain by making every listener repeat it.
    TreeChanged { docs: Vec<DocEntry> },
    /// Someone in the project moved, or appeared for the first time.
    ///
    /// Overleaf announces nothing when a client joins — the only thing that
    /// makes anyone visible is a position broadcast, so this doubles as
    /// "someone is here".
    PresenceUpdated { user: PresenceUser },
    /// Someone left the project. Carries only their connection id.
    PresenceLeft { id: String },
    /// A comment thread changed: a reply, an edit, a resolve, a delete.
    ///
    /// This carries no detail on purpose. Overleaf spreads thread state across
    /// six socket events and a REST endpoint, and rebuilding it from partial
    /// events is how panels drift out of step with the browser; re-reading the
    /// threads is both simpler and always right.
    ThreadsChanged,
    /// Someone posted in the project chat. Overleaf sends this to everyone in
    /// the room, the author included.
    ChatMessage {
        id: String,
        content: String,
        author_name: String,
        author_email: Option<String>,
        /// Milliseconds since the epoch, as Overleaf reports it.
        timestamp: i64,
    },
    Disconnected {
        reason: String,
    },
}

/// Someone else in the project, and where they are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUser {
    /// Their connection id — the same shape as our own public id. One person
    /// with two tabs open is two of these.
    pub id: String,
    /// Their account. Two tabs share this, which is why colour keys on it.
    pub user_id: Option<String>,
    pub name: String,
    pub email: Option<String>,
    /// The document they are in, when they have said.
    pub doc_id: Option<String>,
    /// Zero-based line and column, as Overleaf counts them.
    pub row: Option<i64>,
    pub column: Option<i64>,
    /// The hue Overleaf's own editor would give them, so the same person is
    /// the same colour in both apps.
    pub hue: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEntry {
    pub id: String,
    /// Path relative to the project root, forward slashes, no leading slash.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OtOp {
    /// Position in the document (character offset).
    pub p: usize,
    /// Inserted text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub i: Option<String>,
    /// Deleted text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub d: Option<String>,
}

// ---- Frame codec (pure) ---------------------------------------------------

/// One decoded Socket.IO 0.9 frame. `id` is kept verbatim because an event that
/// requests an ack carries `"{id}+"` there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub id: String,
    pub endpoint: String,
    pub data: String,
}

/// `{type}:{id}:{endpoint}:{data}`, with the last separator dropped when there
/// is no payload so heartbeats encode as `2::` exactly like the JS client.
pub fn encode_frame(kind: u8, id: &str, endpoint: &str, data: &str) -> String {
    if data.is_empty() {
        format!("{kind}:{id}:{endpoint}")
    } else {
        format!("{kind}:{id}:{endpoint}:{data}")
    }
}

/// Inverse of [`encode_frame`]. Everything after the third colon is payload, so
/// JSON containing colons survives untouched. Never panics: malformed input
/// comes back as `Err`.
pub fn parse_frame(raw: &str) -> Result<Frame, String> {
    let mut parts = raw.splitn(4, ':');
    let kind_text = parts.next().unwrap_or("");
    let id = parts
        .next()
        .ok_or_else(|| format!("socket.io frame is missing its id field: {raw:?}"))?;
    let endpoint = parts
        .next()
        .ok_or_else(|| format!("socket.io frame is missing its endpoint field: {raw:?}"))?;
    let data = parts.next().unwrap_or("");
    let kind: u8 = kind_text
        .parse()
        .map_err(|_| format!("socket.io frame has a non-numeric type: {raw:?}"))?;
    if kind > FRAME_NOOP {
        return Err(format!("unknown socket.io frame type {kind}: {raw:?}"));
    }
    Ok(Frame {
        kind,
        id: id.to_string(),
        endpoint: endpoint.to_string(),
        data: data.to_string(),
    })
}

/// Splits an ack payload (`"{id}+{json_array}"`, or a bare `"{id}"`) into the
/// ack id and its arguments.
pub fn parse_ack(data: &str) -> Result<(u32, Vec<Value>), String> {
    let (id_text, args_text) = match data.find('+') {
        Some(idx) => (&data[..idx], &data[idx + 1..]),
        None => (data, ""),
    };
    let id: u32 = id_text
        .trim()
        .parse()
        .map_err(|_| format!("socket.io ack has a non-numeric id: {data:?}"))?;
    let args_text = args_text.trim();
    if args_text.is_empty() {
        return Ok((id, Vec::new()));
    }
    let parsed: Value = serde_json::from_str(args_text)
        .map_err(|e| format!("socket.io ack payload is not JSON ({e}): {args_text:?}"))?;
    match parsed {
        Value::Array(args) => Ok((id, args)),
        other => Ok((id, vec![other])),
    }
}

/// Reads the `{"name":…,"args":[…]}` envelope of a type-5 event frame.
pub fn parse_event(data: &str) -> Result<(String, Vec<Value>), String> {
    let parsed: Value = serde_json::from_str(data)
        .map_err(|e| format!("socket.io event payload is not JSON ({e}): {data:?}"))?;
    let name = parsed
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("socket.io event has no name: {data:?}"))?
        .to_string();
    let args = parsed
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok((name, args))
}

/// Parses the plain-text handshake body `{sid}:{heartbeat}:{close}:{transports}`
/// into the session id and the heartbeat timeout in seconds (0 = none).
pub fn parse_handshake(body: &str) -> Result<(String, u64), String> {
    let line = body.trim();
    let fields: Vec<&str> = line.split(':').collect();
    if fields.len() < 3 {
        return Err(format!(
            "Overleaf returned an unexpected socket.io handshake: {:?}",
            truncate(line, 120)
        ));
    }
    let sid = fields[0].trim();
    let looks_like_a_sid = !sid.is_empty()
        && sid.len() <= 128
        && sid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
    if !looks_like_a_sid {
        return Err(format!(
            "Overleaf returned an unexpected socket.io handshake: {:?}",
            truncate(line, 120)
        ));
    }
    let heartbeat = match fields[1].trim() {
        "" => 0,
        text => text.parse::<u64>().map_err(|_| {
            format!("socket.io handshake has a non-numeric heartbeat timeout: {line:?}")
        })?,
    };
    if let Some(transports) = fields.get(3) {
        if !transports.split(',').any(|t| t.trim() == "websocket") {
            return Err(format!(
                "Overleaf does not offer the websocket transport (offers {transports:?})"
            ));
        }
    }
    Ok((sid.to_string(), heartbeat))
}

fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((idx, _)) => &text[..idx],
        None => text,
    }
}

// ---- URLs -----------------------------------------------------------------

fn normalize_origin(host: &str) -> Result<String, String> {
    let trimmed = host.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("No Overleaf host configured.".to_string());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(format!(
            "The Overleaf host must start with http:// or https:// (got {host:?})"
        ));
    }
    Ok(trimmed.to_string())
}

fn ws_origin(origin: &str) -> String {
    if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        origin.to_string()
    }
}

/// Percent-encodes anything that is not an unreserved URL character. Project
/// ids and session ids are opaque strings we splice into a URL.
fn url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ---- Handshake ------------------------------------------------------------

/// Blocking half of the handshake — runs on a blocking thread because the crate
/// only has `reqwest`'s blocking client.
/// What the handshake settled: the session id, how often to beat, and the
/// cookies to carry into the websocket upgrade.
struct Handshake {
    sid: String,
    heartbeat_secs: u64,
    cookie: String,
}

fn handshake_blocking(origin: &str, cookie: &str, project_id: &str) -> Result<Handshake, String> {
    let url = format!(
        "{origin}/socket.io/1/?projectId={}&t={}",
        url_encode(project_id),
        now_millis()
    );
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Could not build the HTTP client: {e}"))?;
    let response = client
        .get(&url)
        .header("Cookie", cookie)
        .header("Origin", origin)
        .send()
        .map_err(|e| format!("Could not reach Overleaf ({e})."))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let handed_back: Vec<String> = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(str::to_string)
        .collect();
    let body = response
        .text()
        .map_err(|e| format!("Could not read the Overleaf handshake response: {e}"))?;

    if status.as_u16() == 401 || status.as_u16() == 403 || final_url.contains("/login") {
        return Err(SESSION_EXPIRED.to_string());
    }
    if !status.is_success() {
        return Err(format!(
            "Overleaf refused the realtime handshake (HTTP {}).",
            status.as_u16()
        ));
    }
    let (sid, heartbeat_secs) = parse_handshake(&body).map_err(|e| {
        if body.trim_start().starts_with('<') {
            SESSION_EXPIRED.to_string()
        } else {
            e
        }
    })?;
    Ok(Handshake {
        sid,
        heartbeat_secs,
        cookie: merge_cookies(cookie, &handed_back),
    })
}

/// Fold any cookies the handshake set into the ones we already had.
///
/// Overleaf runs several realtime instances behind a load balancer, and the
/// handshake answers with a cookie that pins the session to the instance
/// holding it. Leaving that cookie behind means the websocket upgrade reaches
/// a different instance, which has never heard of the id we were just given
/// and answers 502 — a failure that looks like the server being down.
fn merge_cookies(base: &str, set_cookies: &[String]) -> String {
    let mut order: Vec<String> = Vec::new();
    let mut values: HashMap<String, String> = HashMap::new();
    for pair in base.split(';') {
        push_cookie(&mut order, &mut values, pair);
    }
    for header in set_cookies {
        if let Some(pair) = header.split(';').next() {
            push_cookie(&mut order, &mut values, pair);
        }
    }
    order
        .iter()
        .filter_map(|name| values.get(name))
        .cloned()
        .collect::<Vec<_>>()
        .join("; ")
}

/// Later values win, but a cookie keeps the position it first appeared in, so
/// the header stays stable and readable across reconnects.
fn push_cookie(order: &mut Vec<String>, values: &mut HashMap<String, String>, pair: &str) {
    let pair = pair.trim();
    let Some((name, _)) = pair.split_once('=') else {
        return;
    };
    let name = name.trim();
    if name.is_empty() {
        return;
    }
    if !values.contains_key(name) {
        order.push(name.to_string());
    }
    values.insert(name.to_string(), pair.to_string());
}

// ---- Emitted payloads -----------------------------------------------------
//
// These are typed structs rather than `serde_json::json!` values on purpose:
// `serde` serializes struct fields in declaration order, so the exact bytes on
// the wire are stable regardless of how `serde_json::Map` is configured.

#[derive(Serialize)]
struct EventPayload<'a, A: Serialize> {
    name: &'a str,
    args: A,
}

#[derive(Serialize)]
struct JoinProjectArg<'a> {
    project_id: &'a str,
}

/// A comment anchor on the wire: the commented text, where it starts, and the
/// thread it belongs to. Overleaf carries these alongside inserts and deletes.
#[derive(Serialize)]
struct CommentOp<'a> {
    p: i64,
    c: &'a str,
    t: &'a str,
}

#[derive(Serialize)]
struct CommentUpdate<'a> {
    doc: &'a str,
    op: Vec<CommentOp<'a>>,
    v: i64,
}

#[derive(Serialize)]
struct CursorPosition<'a> {
    doc_id: &'a str,
    row: i64,
    column: i64,
}

#[derive(Serialize)]
struct JoinDocOptions {
    #[serde(rename = "encodeRanges")]
    encode_ranges: bool,
}

/// What `applyOtUpdate` carries: the document, the operation, and the version
/// it applies to.
///
/// No `meta`. Overleaf stamps `meta.source` with our own connection id on the
/// way through — sending our own is not merely redundant, the server rejects
/// the whole update with `Unrecognized key: "source"`, which is what stopped
/// every edit we tried to make and quietly dropped us back to syncing.
#[derive(Serialize)]
struct OtUpdate<'a> {
    doc: &'a str,
    op: Vec<OtOp>,
    v: i64,
}

fn encode_event<A: Serialize>(name: &str, args: A) -> Result<String, String> {
    serde_json::to_string(&EventPayload { name, args })
        .map_err(|e| format!("Could not encode the {name} event: {e}"))
}

// ---- Client internals -----------------------------------------------------

enum Outgoing {
    Frame(String),
    Close,
}

#[derive(Debug)]
enum AckMsg {
    Ack(Vec<Value>),
    Failed(String),
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        // A panic while holding one of these little locks must not poison the
        // whole connection.
        Err(poisoned) => poisoned.into_inner(),
    }
}

struct Shared {
    /// The project's entities. Rebuilt at join, then kept current from the
    /// tree events, which is what lets a file created in the browser become
    /// editable here without re-reading the project.
    tree: Mutex<Tree>,
    out_tx: rt::Sender<Outgoing>,
    pending: Mutex<HashMap<u32, rt::Sender<AckMsg>>>,
    next_ack: AtomicU32,
    public_id: Mutex<String>,
    finished: AtomicBool,
    on_event: Box<dyn Fn(RealtimeEvent) + Send + Sync + 'static>,
}

impl Shared {
    fn emit(&self, event: RealtimeEvent) {
        (self.on_event)(event);
    }

    /// Fire-and-forget frame, for contexts that cannot await (heartbeat echo).
    fn queue(&self, frame: String) {
        let _ = self.out_tx.try_send(Outgoing::Frame(frame));
    }

    async fn send_frame(&self, frame: String) -> Result<(), String> {
        self.out_tx
            .send(Outgoing::Frame(frame))
            .await
            .map_err(|_| "The Overleaf realtime connection is closed.".to_string())
    }

    fn resolve(&self, id: u32, msg: AckMsg) {
        let waiter = lock(&self.pending).remove(&id);
        if let Some(waiter) = waiter {
            let _ = waiter.try_send(msg);
        }
    }

    /// Tears the connection down exactly once: unblocks every waiter, stops the
    /// writer task, and reports the reason to the app.
    fn finish(&self, reason: String) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let waiters: Vec<rt::Sender<AckMsg>> =
            lock(&self.pending).drain().map(|(_, tx)| tx).collect();
        for waiter in waiters {
            let _ = waiter.try_send(AckMsg::Failed(
                "The Overleaf realtime connection closed before the server answered.".to_string(),
            ));
        }
        let _ = self.out_tx.try_send(Outgoing::Close);
        self.emit(RealtimeEvent::Disconnected { reason });
    }
}

struct AckSlot {
    id: u32,
    rx: rt::Receiver<AckMsg>,
}

/// Registers an ack waiter and arms its timeout. The timer lives on a parked
/// helper thread (this crate cannot reach `tokio::time`) and exits early — well
/// before the full timeout — as soon as the waiter goes away.
fn open_slot(shared: &Arc<Shared>, id: u32, label: String) -> AckSlot {
    let (tx, rx) = rt::channel::<AckMsg>(2);
    let timer_tx = tx.clone();
    lock(&shared.pending).insert(id, tx);
    std::thread::spawn(move || {
        let deadline = Instant::now() + ACK_TIMEOUT;
        while Instant::now() < deadline {
            if timer_tx.is_closed() {
                return;
            }
            std::thread::sleep(ACK_TIMER_TICK);
        }
        let _ = timer_tx.try_send(AckMsg::Failed(format!(
            "{label} timed out after {}s.",
            ACK_TIMEOUT.as_secs()
        )));
    });
    AckSlot { id, rx }
}

async fn await_slot(shared: &Arc<Shared>, mut slot: AckSlot) -> Result<Vec<Value>, String> {
    let msg = slot.rx.recv().await;
    lock(&shared.pending).remove(&slot.id);
    match msg {
        Some(AckMsg::Ack(args)) => Ok(args),
        Some(AckMsg::Failed(message)) => Err(message),
        None => Err("The Overleaf realtime connection closed before the server answered.".into()),
    }
}

/// Emits `5:{id}+::{"name":…,"args":…}` and waits for the matching ack.
async fn emit_with_ack<A: Serialize>(
    shared: &Arc<Shared>,
    name: &str,
    args: A,
) -> Result<Vec<Value>, String> {
    let payload = encode_event(name, args)?;
    let id = shared.next_ack.fetch_add(1, Ordering::SeqCst);
    let slot = open_slot(shared, id, format!("Overleaf's answer to {name}"));
    let frame = encode_frame(FRAME_EVENT, &format!("{id}+"), "", &payload);
    if let Err(e) = shared.send_frame(frame).await {
        lock(&shared.pending).remove(&id);
        return Err(e);
    }
    await_slot(shared, slot).await
}

/// Socket.IO callbacks are `(error, …payload)`. Overleaf is not perfectly
/// consistent about the leading error slot, so treat a null first argument as
/// "no error, payload follows", a string or `{message}` object as an error, and
/// anything else as the payload itself.
fn ack_body<'a>(args: &'a [Value], what: &str) -> Result<&'a [Value], String> {
    if args.is_empty() {
        return Ok(args);
    }
    if let Some(message) = ack_error(&args[0]) {
        return Err(format!("Overleaf rejected {what}: {message}"));
    }
    if args[0].is_null() {
        Ok(&args[1..])
    } else {
        Ok(args)
    }
}

fn ack_error(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(false) => None,
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Object(map) => {
            // A payload object (a project, a doc) is not an error even though
            // some of them do carry a `message` field somewhere deeper.
            if map.contains_key("rootFolder") || map.contains_key("lines") {
                return None;
            }
            map.get("message")
                .and_then(Value::as_str)
                .map(|m| m.to_string())
                .or_else(|| {
                    map.get("code")
                        .and_then(Value::as_str)
                        .map(|c| c.to_string())
                })
        }
        _ => None,
    }
}

fn error_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(map) => map
            .get("message")
            .and_then(Value::as_str)
            .map(|m| m.to_string())
            .unwrap_or_else(|| value.to_string()),
        other => other.to_string(),
    }
}

// ---- Project tree ---------------------------------------------------------

/// A joined document: its text, its version, and where its comments sit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinedDoc {
    pub text: String,
    pub version: i64,
    pub comments: Vec<CommentRange>,
    pub changes: Vec<TrackedChange>,
}

/// One tracked change in a document: a suggested insertion or deletion that
/// nobody has accepted or rejected yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedChange {
    /// Overleaf's id for the change; what accepting one refers to.
    pub id: String,
    /// Character offset into the document as it currently reads.
    pub position: i64,
    /// The suggested text: inserted when `deletion` is false, removed when it
    /// is true. A tracked deletion is not in the document text, so it occupies
    /// no offsets.
    pub text: String,
    pub deletion: bool,
    /// Who suggested it, when Overleaf knows.
    pub user_id: Option<String>,
    /// ISO 8601, as Overleaf reports it.
    pub timestamp: Option<String>,
    /// Their colour in Overleaf's own palette.
    pub hue: u32,
}

/// Where one comment thread is anchored in a document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentRange {
    /// The thread id — what the REST endpoints and socket events key on.
    pub thread_id: String,
    /// Character offset of the commented span.
    pub position: i64,
    /// The commented text itself, as Overleaf recorded it.
    pub quote: String,
}

/// `{ comments: [{ id, op: { p, c, t } }], changes: [...] }`.
fn parse_comment_ranges(ranges: &Value) -> Vec<CommentRange> {
    ranges
        .get("comments")
        .and_then(Value::as_array)
        .map(|comments| {
            comments
                .iter()
                .filter_map(|comment| parse_comment_range(comment.get("op")?))
                .collect()
        })
        .unwrap_or_default()
}

/// Undo the packing Overleaf applies to text on its way into a `joinDoc`
/// answer.
///
/// The server sends `unescape(encodeURIComponent(text))`, which is the UTF-8
/// bytes of the text reinterpreted one-per-code-point. Left alone, every
/// document with an accent or a Chinese character in it arrives as mojibake —
/// and worse, the character offsets our operations are built on would be
/// counting bytes while Overleaf counts characters.
///
/// Text that is not packed this way (a code point above U+00FF, or bytes that
/// are not valid UTF-8) is returned untouched: some deployments do not encode,
/// and mangling their text would be the same bug in the other direction.
fn decode_packed_utf8(text: &str) -> String {
    if text.is_ascii() {
        return text.to_string();
    }
    let mut bytes = Vec::with_capacity(text.len());
    for ch in text.chars() {
        let code = ch as u32;
        if code > 0xFF {
            return text.to_string();
        }
        bytes.push(code as u8);
    }
    String::from_utf8(bytes).unwrap_or_else(|_| text.to_string())
}

/// `{ changes: [{ id, op: {p, i} | {p, d}, metadata: {user_id, ts} }] }`.
fn parse_tracked_changes(ranges: &Value) -> Vec<TrackedChange> {
    ranges
        .get("changes")
        .and_then(Value::as_array)
        .map(|changes| {
            changes
                .iter()
                .filter_map(|change| {
                    let op = change.get("op")?;
                    let (text, deletion) = match (op.get("i"), op.get("d")) {
                        (Some(inserted), _) => (inserted.as_str()?, false),
                        (_, Some(deleted)) => (deleted.as_str()?, true),
                        _ => return None,
                    };
                    let metadata = change.get("metadata");
                    let user_id = metadata.and_then(|m| json_field(m, &["user_id"]));
                    Some(TrackedChange {
                        id: json_field(change, &["id"])?,
                        position: op.get("p").and_then(Value::as_i64).unwrap_or(0),
                        // Packed the same way the document's own lines are.
                        text: decode_packed_utf8(text),
                        deletion,
                        timestamp: metadata.and_then(|m| json_field(m, &["ts"])),
                        hue: presence_hue(user_id.as_deref()),
                        user_id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `{ p, c, t }`: position, the commented text, and the thread it belongs to.
fn parse_comment_range(op: &Value) -> Option<CommentRange> {
    Some(CommentRange {
        thread_id: op.get("t").and_then(Value::as_str)?.to_string(),
        position: op.get("p").and_then(Value::as_i64).unwrap_or(0),
        quote: op
            .get("c")
            .and_then(Value::as_str)
            .map(decode_packed_utf8)
            .unwrap_or_default(),
    })
}

/// `joinProject` answers with `[error, project, permissions, protocolVersion]`;
/// `project.rootFolder` is an array holding the single root folder.
fn parse_project(body: &[Value]) -> Result<(Tree, Permission), String> {
    let first = body
        .first()
        .ok_or_else(|| "Overleaf's joinProject answer carried no project.".to_string())?;
    // Two shapes again: the plain ack puts the permission level in its own
    // slot, while `joinProjectResponse` carries it beside the project.
    let permission = Permission::parse(
        first
            .get("permissionsLevel")
            .and_then(Value::as_str)
            .or_else(|| body.get(1).and_then(Value::as_str)),
    );
    // `joinProjectResponse` wraps the project alongside the public id and the
    // permission level; the plain ack is the project itself.
    let project = first.get("project").unwrap_or(first);
    let root_field = project
        .get("rootFolder")
        .ok_or_else(|| "Overleaf's joinProject answer has no rootFolder.".to_string())?;
    let root = match root_field {
        Value::Array(folders) => folders
            .first()
            .ok_or_else(|| "Overleaf's project has an empty rootFolder.".to_string())?,
        object @ Value::Object(_) => object,
        _ => return Err("Overleaf's project has an unexpected rootFolder.".to_string()),
    };
    if root.get("_id").and_then(Value::as_str).is_none() {
        return Err("Overleaf's root folder has no id.".to_string());
    }
    Ok((Tree::from_root(root), permission))
}

/// What this account may do to the project.
///
/// Overleaf enforces this server-side, but finding out by having an edit
/// rejected is a poor way to learn it: the channel would fail, fall back to
/// syncing, and syncing would then try to upload the same edit over REST.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Owner,
    ReadAndWrite,
    /// Can comment and suggest, but not change the text directly.
    Review,
    ReadOnly,
    /// Overleaf did not say; assume the project is writable, because refusing
    /// to write a project the user can in fact edit is the worse mistake.
    Unknown,
}

impl Permission {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("owner") => Permission::Owner,
            Some("readAndWrite") => Permission::ReadAndWrite,
            Some("review") => Permission::Review,
            Some("readOnly") => Permission::ReadOnly,
            _ => Permission::Unknown,
        }
    }

    /// True when this account may change the text.
    pub fn can_write(self) -> bool {
        matches!(
            self,
            Permission::Owner | Permission::ReadAndWrite | Permission::Unknown
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Permission::Owner => "owner",
            Permission::ReadAndWrite => "readAndWrite",
            Permission::Review => "review",
            Permission::ReadOnly => "readOnly",
            Permission::Unknown => "unknown",
        }
    }
}

// ---- The live file tree ---------------------------------------------------
//
// Overleaf's tree events are deltas keyed on entity ids: a rename says only
// "this id is now called that", a delete says only "this id is gone" — one
// event for a whole folder, not one per file inside it. Nothing carries a
// path. So the only way to keep a path→document map current without
// re-reading the project is to hold the tree itself and resolve paths from it.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeKind {
    Folder,
    /// A document Overleaf tracks line by line, and the only kind that can be
    /// edited through the channel.
    Doc,
    /// A binary file: a figure, a PDF. Present so paths resolve, and so a
    /// delete prunes it, but never joinable.
    File,
}

#[derive(Debug, Clone)]
struct TreeNode {
    name: String,
    parent: Option<String>,
    kind: NodeKind,
}

/// The project's entities, indexed by id.
#[derive(Debug, Default, Clone)]
struct Tree {
    nodes: HashMap<String, TreeNode>,
    root: String,
}

impl Tree {
    fn from_root(root: &Value) -> Self {
        let mut tree = Tree {
            nodes: HashMap::new(),
            root: root
                .get("_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        };
        tree.absorb(root, None, 0);
        tree
    }

    fn absorb(&mut self, folder: &Value, parent: Option<&str>, depth: usize) {
        if depth > MAX_FOLDER_DEPTH {
            return;
        }
        let Some(id) = folder.get("_id").and_then(Value::as_str) else {
            return;
        };
        self.nodes.insert(
            id.to_string(),
            TreeNode {
                name: folder
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                parent: parent.map(str::to_string),
                kind: NodeKind::Folder,
            },
        );
        for (key, kind) in [("docs", NodeKind::Doc), ("fileRefs", NodeKind::File)] {
            for entity in folder
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                self.insert_entity(id, entity, kind);
            }
        }
        for child in folder
            .get("folders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            self.absorb(child, Some(id), depth + 1);
        }
    }

    fn insert_entity(&mut self, parent: &str, entity: &Value, kind: NodeKind) {
        let (Some(id), Some(name)) = (
            entity.get("_id").and_then(Value::as_str),
            entity.get("name").and_then(Value::as_str),
        ) else {
            return;
        };
        self.nodes.insert(
            id.to_string(),
            TreeNode {
                name: name.to_string(),
                parent: Some(parent.to_string()),
                kind,
            },
        );
    }

    /// The path of an entity, relative to the project root. The root folder's
    /// own name is not part of any path.
    fn path_of(&self, id: &str) -> Option<String> {
        let mut parts: Vec<&str> = Vec::new();
        let mut current = id;
        for _ in 0..=MAX_FOLDER_DEPTH {
            let node = self.nodes.get(current)?;
            let Some(parent) = node.parent.as_deref() else {
                // Reached the root, whose name is not part of the path.
                parts.reverse();
                return Some(parts.join("/"));
            };
            parts.push(&node.name);
            current = parent;
        }
        // A cycle, which should not happen; refusing to answer beats looping.
        None
    }

    /// Every editable document, path and id, in a stable order.
    fn docs(&self) -> Vec<DocEntry> {
        let mut docs: Vec<DocEntry> = self
            .nodes
            .iter()
            .filter(|(_, node)| node.kind == NodeKind::Doc)
            .filter_map(|(id, _)| {
                Some(DocEntry {
                    id: id.clone(),
                    path: self.path_of(id)?,
                })
            })
            .collect();
        docs.sort_by(|a, b| a.path.cmp(&b.path));
        docs
    }

    fn rename(&mut self, id: &str, name: &str) -> bool {
        match self.nodes.get_mut(id) {
            Some(node) => {
                node.name = name.to_string();
                true
            }
            None => false,
        }
    }

    fn move_to(&mut self, id: &str, parent: &str) -> bool {
        if !self.nodes.contains_key(parent) {
            return false;
        }
        match self.nodes.get_mut(id) {
            Some(node) => {
                node.parent = Some(parent.to_string());
                true
            }
            None => false,
        }
    }

    /// Remove an entity and everything under it. Overleaf sends one event for
    /// a deleted folder, so pruning the subtree is the client's job.
    fn remove(&mut self, id: &str) -> bool {
        if self.nodes.remove(id).is_none() {
            return false;
        }
        let mut doomed = vec![id.to_string()];
        while let Some(parent) = doomed.pop() {
            let children: Vec<String> = self
                .nodes
                .iter()
                .filter(|(_, node)| node.parent.as_deref() == Some(parent.as_str()))
                .map(|(id, _)| id.clone())
                .collect();
            for child in children {
                self.nodes.remove(&child);
                doomed.push(child);
            }
        }
        true
    }
}

fn join_path(prefix: &str, name: &str) -> String {
    let name = name.trim_matches('/');
    if prefix.is_empty() {
        name.to_string()
    } else if name.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

// ---- Read / write loops ---------------------------------------------------

async fn write_loop<W>(mut sink: W, mut rx: rt::Receiver<Outgoing>)
where
    W: Sink<Message> + Unpin,
{
    while let Some(item) = rx.recv().await {
        match item {
            Outgoing::Frame(frame) => {
                if sink.send(Message::text(frame)).await.is_err() {
                    break;
                }
            }
            Outgoing::Close => break,
        }
    }
    let _ = sink.close().await;
}

async fn read_loop<R>(mut source: R, shared: Arc<Shared>)
where
    R: Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let mut reason = "The Overleaf realtime connection closed.".to_string();
    while let Some(next) = source.next().await {
        match next {
            Ok(Message::Text(text)) => {
                if !handle_frame(&shared, text.as_str(), &mut reason) {
                    break;
                }
            }
            Ok(Message::Binary(bytes)) => {
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    if !handle_frame(&shared, text, &mut reason) {
                        break;
                    }
                }
            }
            Ok(Message::Close(frame)) => {
                reason = match frame {
                    Some(frame) if !frame.reason.as_str().is_empty() => format!(
                        "The Overleaf server closed the connection: {}",
                        frame.reason.as_str()
                    ),
                    _ => "The Overleaf server closed the connection.".to_string(),
                };
                break;
            }
            Ok(_) => {}
            Err(e) => {
                reason = format!("The Overleaf realtime connection failed: {e}");
                break;
            }
        }
    }
    shared.finish(reason);
}

/// Returns false when the read loop should stop.
fn handle_frame(shared: &Arc<Shared>, raw: &str, reason: &mut String) -> bool {
    let frame = match parse_frame(raw) {
        Ok(frame) => frame,
        // Junk on the wire is not fatal; the server also sends `8::` noops and
        // future frame types we do not know about.
        Err(_) => return true,
    };
    match frame.kind {
        FRAME_HEARTBEAT => shared.queue(encode_frame(FRAME_HEARTBEAT, "", "", "")),
        FRAME_CONNECT => shared.resolve(CONNECT_SLOT, AckMsg::Ack(Vec::new())),
        FRAME_DISCONNECT => {
            *reason = "The Overleaf server closed the connection.".to_string();
            return false;
        }
        FRAME_ACK => {
            if let Ok((id, args)) = parse_ack(&frame.data) {
                shared.resolve(id, AckMsg::Ack(args));
            }
        }
        FRAME_EVENT => return handle_event(shared, &frame.data, reason),
        FRAME_ERROR => {
            *reason = format!(
                "The Overleaf realtime server returned an error: {}",
                frame.data
            );
            shared.resolve(CONNECT_SLOT, AckMsg::Failed(reason.clone()));
            return false;
        }
        _ => {}
    }
    true
}

fn handle_event(shared: &Arc<Shared>, data: &str, reason: &mut String) -> bool {
    let (name, args) = match parse_event(data) {
        Ok(event) => event,
        Err(_) => return true,
    };
    match name.as_str() {
        // `[publicId]` on some deployments, `[null, publicId]` on others.
        "connectionAccepted" => {
            let public_id = args
                .iter()
                .find_map(Value::as_str)
                .unwrap_or_default()
                .to_string();
            *lock(&shared.public_id) = public_id.clone();
            shared.emit(RealtimeEvent::Connected { public_id });
        }
        "connectionRejected" => {
            let message = args
                .first()
                .map(error_text)
                .unwrap_or_else(|| "Overleaf rejected the realtime connection.".to_string());
            shared.resolve(CONNECT_SLOT, AckMsg::Failed(message.clone()));
            *reason = message;
            return false;
        }
        "otUpdateApplied" => {
            for arg in &args {
                for event in doc_update_events(arg) {
                    shared.emit(event);
                }
            }
        }
        "otUpdateError" => {
            let message = args
                .first()
                .map(error_text)
                .unwrap_or_else(|| "Overleaf rejected the edit.".to_string());
            shared.emit(RealtimeEvent::OtError {
                doc_id: doc_id_hint(&args),
                message,
            });
        }
        // Every one of these is a delta against the tree we hold; none of them
        // carries a path, and a deleted folder arrives as a single event for
        // the folder alone. `recive` is Overleaf's own spelling.
        "reciveNewDoc" | "reciveNewFile" | "reciveNewFolder" => {
            let kind = match name.as_str() {
                "reciveNewDoc" => NodeKind::Doc,
                "reciveNewFile" => NodeKind::File,
                _ => NodeKind::Folder,
            };
            if let (Some(parent), Some(entity)) = (
                args.first().and_then(Value::as_str),
                args.get(1).filter(|value| value.is_object()),
            ) {
                let mut tree = lock(&shared.tree);
                tree.insert_entity(parent, entity, kind);
                let docs = tree.docs();
                drop(tree);
                shared.emit(RealtimeEvent::TreeChanged { docs });
            }
        }
        "reciveEntityRename" => {
            if let (Some(id), Some(new_name)) = (
                args.first().and_then(Value::as_str),
                args.get(1).and_then(Value::as_str),
            ) {
                let mut tree = lock(&shared.tree);
                if tree.rename(id, new_name) {
                    let docs = tree.docs();
                    drop(tree);
                    shared.emit(RealtimeEvent::TreeChanged { docs });
                }
            }
        }
        "reciveEntityMove" => {
            if let (Some(id), Some(folder)) = (
                args.first().and_then(Value::as_str),
                args.get(1).and_then(Value::as_str),
            ) {
                let mut tree = lock(&shared.tree);
                if tree.move_to(id, folder) {
                    let docs = tree.docs();
                    drop(tree);
                    shared.emit(RealtimeEvent::TreeChanged { docs });
                }
            }
        }
        "removeEntity" => {
            if let Some(id) = args.first().and_then(Value::as_str) {
                let mut tree = lock(&shared.tree);
                if tree.remove(id) {
                    let docs = tree.docs();
                    drop(tree);
                    shared.emit(RealtimeEvent::TreeChanged { docs });
                }
            }
        }
        // Newer Overleaf joins us from the handshake query and pushes the
        // project down unprompted, instead of waiting to be asked.
        "joinProjectResponse" => {
            if let Some(body) = args.first() {
                if let Some(id) = body.get("publicId").and_then(Value::as_str) {
                    let mut current = lock(&shared.public_id);
                    if current.is_empty() {
                        *current = id.to_string();
                        drop(current);
                        shared.emit(RealtimeEvent::Connected {
                            public_id: id.to_string(),
                        });
                    }
                }
                shared.resolve(JOIN_SLOT, AckMsg::Ack(vec![body.clone()]));
            }
        }
        "new-comment"
        | "new-comment-threads"
        | "edit-message"
        | "delete-message"
        | "resolve-thread"
        | "reopen-thread"
        | "delete-thread" => {
            shared.emit(RealtimeEvent::ThreadsChanged);
        }
        // Overleaf sends this to the whole room, us included; the app drops
        // its own by comparing ids.
        "clientTracking.clientUpdated" => {
            if let Some(user) = args.first().and_then(parse_presence_broadcast) {
                shared.emit(RealtimeEvent::PresenceUpdated { user });
            }
        }
        "clientTracking.clientDisconnected" => {
            if let Some(id) = args.first().and_then(Value::as_str) {
                shared.emit(RealtimeEvent::PresenceLeft { id: id.to_string() });
            }
        }
        "new-chat-message" => {
            if let Some(event) = args.first().and_then(chat_event) {
                shared.emit(event);
            }
        }
        "disconnect" | "forceDisconnect" => {
            *reason = args
                .first()
                .map(error_text)
                .unwrap_or_else(|| "Overleaf disconnected this session.".to_string());
            return false;
        }
        _ => {}
    }
    true
}

/// `{ id, content, timestamp, user: { first_name, last_name, email } }`.
/// Overleaf has shipped both snake_case and camelCase name fields over the
/// years, so read either rather than showing a blank author.
fn chat_event(value: &Value) -> Option<RealtimeEvent> {
    let user = value.get("user");
    let first = user
        .and_then(|u| json_field(u, &["first_name", "firstName"]))
        .unwrap_or_default();
    let last = user
        .and_then(|u| json_field(u, &["last_name", "lastName"]))
        .unwrap_or_default();
    let author_email = user.and_then(|u| json_field(u, &["email"]));
    let name = format!("{first} {last}").trim().to_string();
    Some(RealtimeEvent::ChatMessage {
        id: json_field(value, &["id", "_id"])?,
        content: json_field(value, &["content"]).unwrap_or_default(),
        author_name: if name.is_empty() {
            author_email.clone().unwrap_or_else(|| "Someone".to_string())
        } else {
            name
        },
        author_email,
        timestamp: value
            .get("timestamp")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
    })
}

/// `clientTracking.clientUpdated`: `{row, column, doc_id, id, user_id, email, name}`.
///
/// The broadcast and the roster answer describe the same thing with different
/// keys — `id` here against `client_id` there, one joined `name` here against
/// `first_name`/`last_name` there — so they are parsed separately rather than
/// through one forgiving reader that would quietly accept either.
fn parse_presence_broadcast(value: &Value) -> Option<PresenceUser> {
    let id = value.get("id").and_then(Value::as_str)?.to_string();
    let user_id = json_field(value, &["user_id"]).filter(|id| id != "anonymous-user");
    let name = json_field(value, &["name"]).unwrap_or_default();
    Some(PresenceUser {
        hue: presence_hue(user_id.as_deref()),
        id,
        user_id,
        name,
        email: json_field(value, &["email"]),
        doc_id: json_field(value, &["doc_id"]),
        row: value.get("row").and_then(Value::as_i64),
        column: value.get("column").and_then(Value::as_i64),
    })
}

/// One entry from `clientTracking.getConnectedUsers`.
///
/// Redis hands these back as strings, so everything but `cursorData` arrives
/// quoted even when it is a number.
fn parse_presence_roster(value: &Value) -> Option<PresenceUser> {
    let id = value.get("client_id").and_then(Value::as_str)?.to_string();
    if value.get("connected").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let user_id = json_field(value, &["user_id"]).filter(|id| id != "anonymous-user");
    let first = json_field(value, &["first_name"]).unwrap_or_default();
    let last = json_field(value, &["last_name"]).unwrap_or_default();
    let cursor = value.get("cursorData");
    Some(PresenceUser {
        hue: presence_hue(user_id.as_deref()),
        id,
        user_id,
        name: format!("{first} {last}").trim().to_string(),
        email: json_field(value, &["email"]),
        doc_id: cursor.and_then(|c| json_field(c, &["doc_id"])),
        row: cursor.and_then(|c| c.get("row")).and_then(Value::as_i64),
        column: cursor.and_then(|c| c.get("column")).and_then(Value::as_i64),
    })
}

/// The hue Overleaf's editor gives a user: the first eight hex digits of the
/// MD5 of their account id, modulo the palette, with a gap left around the
/// blue that Overleaf reserves for "you".
///
/// Reproducing it exactly is the point — the same collaborator should be the
/// same colour whether you are looking at Lattice or at the browser.
fn presence_hue(user_id: Option<&str>) -> u32 {
    const ANONYMOUS_HUE: u32 = 100;
    const OWN_HUE: u32 = 200;
    const OWN_HUE_BLOCKED_SIZE: u32 = 20;
    const TOTAL_HUES: u32 = 360;

    let Some(user_id) = user_id else {
        return ANONYMOUS_HUE;
    };
    let digest = format!("{:x}", md5::compute(user_id.as_bytes()));
    let prefix = u32::from_str_radix(&digest[..8], 16).unwrap_or(0);
    let hue = prefix % (TOTAL_HUES - OWN_HUE_BLOCKED_SIZE * 2);
    if hue > OWN_HUE - OWN_HUE_BLOCKED_SIZE && hue < OWN_HUE + OWN_HUE_BLOCKED_SIZE {
        hue - OWN_HUE + TOTAL_HUES - OWN_HUE_BLOCKED_SIZE
    } else {
        hue
    }
}

fn json_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::to_string)
}

/// One `otUpdateApplied` payload, split into what it means for the text and
/// what it means for comments.
///
/// Overleaf sends both kinds of operation down the same channel: `{p, i}` and
/// `{p, d}` change the document, while `{p, c, t}` anchors a comment thread to
/// a span without altering a character. Keeping the comment ops out of the
/// text stream matters — transformed as if they were edits they would come
/// back as empty deletes, and the OT state machine should only ever see real
/// edits.
fn doc_update_events(value: &Value) -> Vec<RealtimeEvent> {
    let Some(doc_id) = value.get("doc").and_then(Value::as_str).map(str::to_string) else {
        return Vec::new();
    };
    let version = value.get("v").and_then(Value::as_i64).unwrap_or(-1);
    // No operation at all: this is the server telling us our own update landed.
    if value.get("op").is_none() {
        return match version {
            -1 => Vec::new(),
            version => vec![RealtimeEvent::DocAck { doc_id, version }],
        };
    }
    let mut ops: Vec<OtOp> = Vec::new();
    let mut events: Vec<RealtimeEvent> = Vec::new();
    if let Some(raw) = value.get("op").and_then(Value::as_array) {
        for op in raw {
            if op.get("t").and_then(Value::as_str).is_some() {
                if let Some(range) = parse_comment_range(op) {
                    events.push(RealtimeEvent::CommentAnchored {
                        doc_id: doc_id.clone(),
                        range,
                    });
                }
                continue;
            }
            if let Ok(parsed) = serde_json::from_value::<OtOp>(op.clone()) {
                if parsed.i.is_some() || parsed.d.is_some() {
                    ops.push(parsed);
                }
            }
        }
    }
    let source = value
        .get("meta")
        .and_then(|meta| meta.get("source"))
        .and_then(Value::as_str)
        .map(str::to_string);
    // The version moves whatever the operation was, so this goes out even when
    // nothing in the text changed.
    events.insert(
        0,
        RealtimeEvent::DocUpdate {
            doc_id,
            version,
            ops,
            source,
        },
    );
    events
}

/// `otUpdateError` does not have a documented shape; dig a doc id out of
/// whatever the server sent so the app can at least point at a file.
fn doc_id_hint(args: &[Value]) -> String {
    for arg in args {
        if let Value::Object(map) = arg {
            for key in ["doc", "doc_id", "docId"] {
                if let Some(id) = map.get(key).and_then(Value::as_str) {
                    return id.to_string();
                }
            }
        }
    }
    args.iter()
        .skip(1)
        .find_map(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

// ---- Client ---------------------------------------------------------------

pub struct RealtimeClient {
    shared: Arc<Shared>,
    sid: String,
    heartbeat_secs: u64,
    /// The project tree as `joinProject` gave it. Kept so the app can read it
    /// from the connect call itself rather than having to catch the event —
    /// an event emitted before the app's listener is up is simply lost, and
    /// without the document ids there is no live editing at all.
    project: ProjectTree,
}

/// What `joinProject` told us about the project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTree {
    pub root_folder_id: String,
    pub docs: Vec<DocEntry>,
    /// What this account may do to the project.
    pub permission: Permission,
}

// Hand-written because `Shared` holds the app's event callback. Having `Debug`
// means callers can `.expect(…)` on `connect`.
impl std::fmt::Debug for RealtimeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RealtimeClient")
            .field("sid", &self.sid)
            .field("heartbeat_secs", &self.heartbeat_secs)
            .field("public_id", &self.public_id())
            .field("live", &!self.shared.finished.load(Ordering::SeqCst))
            .finish()
    }
}

impl RealtimeClient {
    /// Connects, joins the project, and starts the read loop. `on_event` is
    /// called for every [`RealtimeEvent`] (from the client's own task).
    pub async fn connect(
        config: RealtimeConfig,
        on_event: impl Fn(RealtimeEvent) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let origin = normalize_origin(&config.host)?;
        let cookie = config.cookie.trim().to_string();
        if cookie.is_empty() {
            return Err("Not connected to Overleaf. Connect in Settings → Overleaf.".to_string());
        }
        let project_id = config.project_id.trim().to_string();
        if project_id.is_empty() {
            return Err("No Overleaf project selected.".to_string());
        }

        let handshake = {
            let (origin, cookie, project_id) = (origin.clone(), cookie.clone(), project_id.clone());
            rt::spawn_blocking(move || handshake_blocking(&origin, &cookie, &project_id))
                .await
                .map_err(|e| format!("The Overleaf handshake task failed: {e}"))??
        };
        let Handshake {
            sid,
            heartbeat_secs,
            cookie,
        } = handshake;

        let url = format!(
            "{}/socket.io/1/websocket/{}?projectId={}&t={}",
            ws_origin(&origin),
            url_encode(&sid),
            url_encode(&project_id),
            now_millis()
        );
        // `into_client_request` fills in Host / Connection / Upgrade /
        // Sec-WebSocket-Version / Sec-WebSocket-Key (tungstenite errors out if
        // any of them is missing); we add the browser-ish headers Overleaf
        // checks on top of it.
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|e| format!("Could not build the Overleaf websocket request: {e}"))?;
        {
            let headers = request.headers_mut();
            headers.insert(
                "Cookie",
                HeaderValue::from_str(&cookie)
                    .map_err(|_| "The Overleaf cookie is not a valid HTTP header.".to_string())?,
            );
            headers.insert(
                "Origin",
                HeaderValue::from_str(&origin)
                    .map_err(|_| "The Overleaf host is not a valid Origin header.".to_string())?,
            );
            headers.insert("User-Agent", HeaderValue::from_static(USER_AGENT));
        }

        let (stream, _response) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| format!("Could not open the Overleaf realtime connection: {e}"))?;
        let (sink, source) = stream.split();

        let (out_tx, out_rx) = rt::channel::<Outgoing>(OUT_QUEUE);
        let shared = Arc::new(Shared {
            tree: Mutex::new(Tree::default()),
            out_tx,
            pending: Mutex::new(HashMap::new()),
            next_ack: AtomicU32::new(1),
            public_id: Mutex::new(String::new()),
            finished: AtomicBool::new(false),
            on_event: Box::new(on_event),
        });

        rt::spawn(write_loop(sink, out_rx));
        // Arm both waiters before the reader can possibly see what resolves
        // them. A server that joins us from the handshake query pushes
        // `joinProjectResponse` immediately after accepting the connection,
        // and an answer that arrives before anyone is waiting is simply lost.
        let connect_slot = open_slot(
            &shared,
            CONNECT_SLOT,
            "Overleaf's realtime connect handshake".to_string(),
        );
        let join_slot = open_slot(&shared, JOIN_SLOT, "Overleaf's project join".to_string());
        rt::spawn(read_loop(source, shared.clone()));
        await_slot(&shared, connect_slot).await?;

        // Two generations of Overleaf answer this differently: the older one
        // acks our `joinProject`, the newer one has already joined us from the
        // handshake query and pushes `joinProjectResponse` down. Ask, and take
        // whichever answer arrives first, so both work without guessing which
        // server we are talking to.
        {
            let shared = shared.clone();
            let project_id = project_id.clone();
            rt::spawn(async move {
                let asked = emit_with_ack(
                    &shared,
                    "joinProject",
                    (JoinProjectArg {
                        project_id: &project_id,
                    },),
                )
                .await;
                // Resolving is a no-op once the pushed answer has been taken.
                shared.resolve(
                    JOIN_SLOT,
                    match asked {
                        Ok(args) => AckMsg::Ack(args),
                        Err(message) => AckMsg::Failed(message),
                    },
                );
            });
        }
        let ack = await_slot(&shared, join_slot).await?;
        let body = ack_body(&ack, "joinProject")?;
        let (tree, permission) = parse_project(body)?;
        let project = ProjectTree {
            root_folder_id: tree.root.clone(),
            docs: tree.docs(),
            permission,
        };
        *lock(&shared.tree) = tree;
        shared.emit(RealtimeEvent::ProjectJoined {
            root_folder_id: project.root_folder_id.clone(),
            docs: project.docs.clone(),
            permission,
        });

        Ok(RealtimeClient {
            shared,
            sid,
            heartbeat_secs,
            project,
        })
    }

    /// `joinDoc` → the document's current lines joined with `'\n'`, plus its
    /// version.
    pub async fn join_doc(&self, doc_id: &str) -> Result<JoinedDoc, String> {
        let ack = emit_with_ack(
            &self.shared,
            "joinDoc",
            (
                doc_id,
                JoinDocOptions {
                    encode_ranges: true,
                },
            ),
        )
        .await?;
        let body = ack_body(&ack, "joinDoc")?;
        let lines = body
            .first()
            .and_then(Value::as_array)
            .ok_or_else(|| format!("Overleaf sent no content for document {doc_id}."))?;
        let text = lines
            .iter()
            .map(|line| decode_packed_utf8(line.as_str().unwrap_or_default()))
            .collect::<Vec<_>>()
            .join("\n");
        let version = body
            .get(1)
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("Overleaf sent no version for document {doc_id}."))?;
        // The fourth slot holds the document's ranges: tracked changes, and
        // the spans that comment threads are anchored to. Only the comments
        // matter here — they are what ties a conversation to a piece of text.
        let ranges = body.get(3);
        let comments = ranges.map(parse_comment_ranges).unwrap_or_default();
        let changes = ranges.map(parse_tracked_changes).unwrap_or_default();
        Ok(JoinedDoc {
            text,
            version,
            comments,
            changes,
        })
    }

    /// Anchor a comment thread to a span of a document.
    ///
    /// The thread's messages live behind the REST endpoints; this is the half
    /// that makes the span show as commented for everyone with the file open.
    /// It travels as an operation like any edit, so it takes a version and is
    /// acknowledged the same way.
    pub async fn send_comment(
        &self,
        doc_id: &str,
        version: i64,
        position: i64,
        quote: &str,
        thread_id: &str,
    ) -> Result<(), String> {
        let update = CommentUpdate {
            doc: doc_id,
            op: vec![CommentOp {
                p: position,
                c: quote,
                t: thread_id,
            }],
            v: version,
        };
        let ack = emit_with_ack(&self.shared, "applyOtUpdate", (doc_id, update)).await?;
        ack_body(&ack, "applyOtUpdate")?;
        Ok(())
    }

    /// Everyone currently in the project, ourselves included.
    ///
    /// Overleaf answers no faster than a second: it broadcasts a refresh to
    /// every instance first and reads the roster back afterwards.
    pub async fn connected_users(&self) -> Result<Vec<PresenceUser>, String> {
        // The argument list must be empty. Socket.IO 0.9 appends the ack
        // callback as the last argument, and the handler takes exactly one —
        // anything sent binds to it and the call is rejected as malformed.
        let ack = emit_with_ack(&self.shared, "clientTracking.getConnectedUsers", ()).await?;
        let body = ack_body(&ack, "clientTracking.getConnectedUsers")?;
        Ok(body
            .first()
            .and_then(Value::as_array)
            .map(|users| users.iter().filter_map(parse_presence_roster).collect())
            .unwrap_or_default())
    }

    /// Say where our caret is.
    ///
    /// This is also what makes us visible at all: joining a project announces
    /// nothing to anyone already connected, and their editors only read the
    /// roster once. Row and column are zero-based, the way Overleaf counts.
    pub async fn update_position(&self, doc_id: &str, row: i64, column: i64) -> Result<(), String> {
        // No ack: Overleaf's own editor sends this and does not wait, and the
        // server answers nothing on failure either — a position for a document
        // we have not joined is dropped silently.
        let payload = encode_event(
            "clientTracking.updatePosition",
            (CursorPosition {
                doc_id,
                row,
                column,
            },),
        )?;
        self.shared
            .send_frame(encode_frame(FRAME_EVENT, "", "", &payload))
            .await
    }

    pub async fn leave_doc(&self, doc_id: &str) -> Result<(), String> {
        let ack = emit_with_ack(&self.shared, "leaveDoc", (doc_id,)).await?;
        ack_body(&ack, "leaveDoc")?;
        Ok(())
    }

    /// `applyOtUpdate` with the given ops at version `version`.
    pub async fn send_ops(&self, doc_id: &str, version: i64, ops: Vec<OtOp>) -> Result<(), String> {
        if ops.is_empty() {
            return Ok(());
        }
        if !self.project.permission.can_write() {
            return Err(READ_ONLY.to_string());
        }
        let update = OtUpdate {
            doc: doc_id,
            op: ops,
            v: version,
        };
        let ack = emit_with_ack(&self.shared, "applyOtUpdate", (doc_id, update)).await?;
        ack_body(&ack, "applyOtUpdate")?;
        Ok(())
    }

    /// The id Overleaf gave this session. The server stamps it onto every
    /// update we send, so an echo carrying it is our own work coming back.
    pub fn public_id(&self) -> String {
        lock(&self.shared.public_id).clone()
    }

    pub fn sid(&self) -> &str {
        &self.sid
    }

    pub fn heartbeat_secs(&self) -> u64 {
        self.heartbeat_secs
    }

    /// Closes the socket; the read loop exits and reports `Disconnected`.
    /// The project tree from the join, for callers that connected themselves.
    pub fn project(&self) -> &ProjectTree {
        &self.project
    }

    pub fn shutdown(&self) {
        let _ = self.shared.out_tx.try_send(Outgoing::Close);
    }
}

// ---- Tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read as _, Write as _};
    use std::net::{TcpListener, TcpStream};
    use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
    use tokio_tungstenite::tungstenite::protocol::{Role, WebSocket};

    // -- frame codec --------------------------------------------------------

    #[test]
    fn encode_frame_drops_the_separator_when_there_is_no_payload() {
        assert_eq!(encode_frame(FRAME_HEARTBEAT, "", "", ""), "2::");
        assert_eq!(encode_frame(FRAME_CONNECT, "", "", ""), "1::");
        assert_eq!(encode_frame(FRAME_DISCONNECT, "", "", ""), "0::");
    }

    #[test]
    fn encode_frame_marks_events_that_want_an_ack() {
        let payload = r#"{"name":"joinDoc","args":["doc-1",{"encodeRanges":true}]}"#;
        assert_eq!(
            encode_frame(FRAME_EVENT, "", "", payload),
            r#"5:::{"name":"joinDoc","args":["doc-1",{"encodeRanges":true}]}"#
        );
        assert_eq!(
            encode_frame(FRAME_EVENT, "7+", "", payload),
            r#"5:7+::{"name":"joinDoc","args":["doc-1",{"encodeRanges":true}]}"#
        );
        assert_eq!(
            encode_frame(FRAME_EVENT, "12+", "/chat", payload),
            format!("5:12+:/chat:{payload}")
        );
    }

    #[test]
    fn parse_frame_reads_every_field() {
        let frame = parse_frame(r#"5:3+::{"name":"joinProject"}"#).expect("parses");
        assert_eq!(frame.kind, FRAME_EVENT);
        assert_eq!(frame.id, "3+");
        assert_eq!(frame.endpoint, "");
        assert_eq!(frame.data, r#"{"name":"joinProject"}"#);
    }

    #[test]
    fn parse_frame_handles_payloadless_frames() {
        for (raw, kind) in [
            ("2::", FRAME_HEARTBEAT),
            ("1::", FRAME_CONNECT),
            ("0::", FRAME_DISCONNECT),
            ("8::", FRAME_NOOP),
        ] {
            let frame = parse_frame(raw).expect("parses");
            assert_eq!(frame.kind, kind);
            assert_eq!(frame.data, "");
            assert_eq!(
                encode_frame(frame.kind, &frame.id, &frame.endpoint, &frame.data),
                raw
            );
        }
    }

    #[test]
    fn parse_frame_keeps_colons_inside_the_payload() {
        let payload =
            r#"{"name":"otUpdateApplied","args":[{"doc":"a:b","op":[{"p":0,"i":"12:34"}]}]}"#;
        let raw = format!("5:::{payload}");
        let frame = parse_frame(&raw).expect("parses");
        assert_eq!(frame.data, payload);
        // ...and a URL-shaped payload, which is the classic colon trap.
        let frame = parse_frame("3:1::https://example.com:8080/x").expect("parses");
        assert_eq!(frame.data, "https://example.com:8080/x");
    }

    #[test]
    fn parse_frame_rejects_malformed_input_without_panicking() {
        for raw in [
            "", "5", "5:1", "::", ":::", "x::", "9::", "255::", "300::", "-1::", "5 ::", "🙂::",
        ] {
            assert!(
                parse_frame(raw).is_err(),
                "expected {raw:?} to be rejected, got {:?}",
                parse_frame(raw)
            );
        }
    }

    #[test]
    fn parse_ack_reads_ids_and_arguments() {
        let (id, args) = parse_ack(r#"1+[null,["line1","line2"],42,[],{}]"#).expect("parses");
        assert_eq!(id, 1);
        assert_eq!(args.len(), 5);
        assert!(args[0].is_null());
        assert_eq!(args[1], json!(["line1", "line2"]));
        assert_eq!(args[2], json!(42));
    }

    #[test]
    fn parse_ack_reads_multi_digit_ids() {
        let (id, args) = parse_ack("10+[null]").expect("parses");
        assert_eq!(id, 10);
        assert_eq!(args, vec![Value::Null]);
        let (id, _) = parse_ack("1234+[]").expect("parses");
        assert_eq!(id, 1234);
    }

    #[test]
    fn parse_ack_accepts_acks_without_arguments() {
        assert_eq!(parse_ack("7").expect("parses"), (7, Vec::new()));
        assert_eq!(parse_ack("7+").expect("parses"), (7, Vec::new()));
    }

    #[test]
    fn parse_ack_rejects_garbage_without_panicking() {
        assert!(parse_ack("").is_err());
        assert!(parse_ack("+[]").is_err());
        assert!(parse_ack("abc+[]").is_err());
        assert!(parse_ack("1+[not json").is_err());
    }

    #[test]
    fn parse_event_reads_name_and_args() {
        let (name, args) =
            parse_event(r#"{"name":"otUpdateApplied","args":[{"doc":"d"}]}"#).expect("parses");
        assert_eq!(name, "otUpdateApplied");
        assert_eq!(args, vec![json!({"doc":"d"})]);
        let (name, args) = parse_event(r#"{"name":"connect"}"#).expect("parses");
        assert_eq!(name, "connect");
        assert!(args.is_empty());
        assert!(parse_event("not json").is_err());
        assert!(parse_event(r#"{"args":[]}"#).is_err());
    }

    // -- handshake ----------------------------------------------------------

    #[test]
    fn parse_handshake_reads_the_sid_and_heartbeat() {
        let (sid, heartbeat) =
            parse_handshake("d4Xk3hQ2sJ0aBcDe:60:60:websocket,xhr-polling").expect("parses");
        assert_eq!(sid, "d4Xk3hQ2sJ0aBcDe");
        assert_eq!(heartbeat, 60);
        let (sid, heartbeat) = parse_handshake("testsid:25:60:websocket\n").expect("parses");
        assert_eq!(sid, "testsid");
        assert_eq!(heartbeat, 25);
        // Heartbeat may legitimately be blank ("no heartbeat").
        assert_eq!(
            parse_handshake("abc::60:websocket").expect("parses"),
            ("abc".into(), 0)
        );
    }

    #[test]
    fn parse_handshake_rejects_non_handshake_bodies() {
        assert!(parse_handshake("").is_err());
        assert!(parse_handshake("<!DOCTYPE html><html>login</html>").is_err());
        assert!(parse_handshake("sid:60").is_err());
        assert!(parse_handshake("sid:soon:60:websocket").is_err());
        // The websocket transport must actually be on offer.
        assert!(parse_handshake("sid:60:60:xhr-polling").is_err());
    }

    #[test]
    fn origins_switch_scheme_for_websockets() {
        assert_eq!(
            normalize_origin("https://www.overleaf.com/").unwrap(),
            "https://www.overleaf.com"
        );
        assert_eq!(
            ws_origin("https://www.overleaf.com"),
            "wss://www.overleaf.com"
        );
        assert_eq!(ws_origin("http://127.0.0.1:8080"), "ws://127.0.0.1:8080");
        assert!(normalize_origin("overleaf.com").is_err());
        assert!(normalize_origin("  ").is_err());
    }

    // -- payload shapes -----------------------------------------------------

    #[test]
    fn ot_ops_serialize_without_their_empty_halves() {
        let insert = OtOp {
            p: 5,
            i: Some("hello".into()),
            d: None,
        };
        assert_eq!(
            serde_json::to_string(&insert).unwrap(),
            r#"{"p":5,"i":"hello"}"#
        );
        let delete = OtOp {
            p: 0,
            i: None,
            d: Some("x".into()),
        };
        assert_eq!(
            serde_json::to_string(&delete).unwrap(),
            r#"{"p":0,"d":"x"}"#
        );
    }

    #[test]
    fn emitted_event_payloads_have_a_stable_field_order() {
        let payload = encode_event(
            "applyOtUpdate",
            (
                "doc-1",
                OtUpdate {
                    doc: "doc-1",
                    op: vec![OtOp {
                        p: 5,
                        i: Some("hello".into()),
                        d: None,
                    }],
                    v: 42,
                },
            ),
        )
        .expect("encodes");
        // No `meta`: Overleaf fills it in, and rejects the update if we do.
        assert_eq!(
            payload,
            r#"{"name":"applyOtUpdate","args":["doc-1",{"doc":"doc-1","op":[{"p":5,"i":"hello"}],"v":42}]}"#
        );
    }

    /// Pins the JSON the app will actually see, fields included: an enum's
    /// `rename_all` covers only the variant names, so the payload fields need
    /// `rename_all_fields` too or the app receives snake_case keys.
    #[test]
    fn realtime_events_serialize_with_a_type_tag() {
        let joined = RealtimeEvent::ProjectJoined {
            root_folder_id: "root-1".into(),
            docs: vec![DocEntry {
                id: "doc-1".into(),
                path: "sections/intro.tex".into(),
            }],
            permission: Permission::ReadAndWrite,
        };
        assert_eq!(
            serde_json::to_string(&joined).unwrap(),
            r#"{"type":"projectJoined","rootFolderId":"root-1","docs":[{"id":"doc-1","path":"sections/intro.tex"}],"permission":"readAndWrite"}"#
        );
        let update = RealtimeEvent::DocUpdate {
            doc_id: "doc-1".into(),
            version: 43,
            ops: vec![OtOp {
                p: 9,
                i: Some("!".into()),
                d: None,
            }],
            source: Some("pub-2".into()),
        };
        assert_eq!(
            serde_json::to_string(&update).unwrap(),
            r#"{"type":"docUpdate","docId":"doc-1","version":43,"ops":[{"p":9,"i":"!"}],"source":"pub-2"}"#
        );
        let connected = RealtimeEvent::Connected {
            public_id: "pub-1".into(),
        };
        assert_eq!(
            serde_json::to_string(&connected).unwrap(),
            r#"{"type":"connected","publicId":"pub-1"}"#
        );
        assert_eq!(
            serde_json::to_string(&RealtimeEvent::ThreadsChanged).unwrap(),
            r#"{"type":"threadsChanged"}"#
        );
        let chat = RealtimeEvent::ChatMessage {
            id: "msg-1".into(),
            content: "ready for review".into(),
            author_name: "Ada Lovelace".into(),
            author_email: Some("ada@example.edu".into()),
            timestamp: 1_700_000_000_000,
        };
        assert_eq!(
            serde_json::to_string(&chat).unwrap(),
            r#"{"type":"chatMessage","id":"msg-1","content":"ready for review","authorName":"Ada Lovelace","authorEmail":"ada@example.edu","timestamp":1700000000000}"#
        );
    }

    #[test]
    fn chat_messages_read_either_name_spelling() {
        let snake = chat_event(&json!({
            "id": "msg-1",
            "content": "hello",
            "timestamp": 1_700_000_000_000i64,
            "user": {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.edu"},
        }))
        .expect("parses");
        let camel = chat_event(&json!({
            "_id": "msg-1",
            "content": "hello",
            "timestamp": 1_700_000_000_000i64,
            "user": {"firstName": "Ada", "lastName": "Lovelace", "email": "ada@example.edu"},
        }))
        .expect("parses");
        for event in [snake, camel] {
            match event {
                RealtimeEvent::ChatMessage {
                    id,
                    content,
                    author_name,
                    author_email,
                    timestamp,
                } => {
                    assert_eq!(id, "msg-1");
                    assert_eq!(content, "hello");
                    assert_eq!(author_name, "Ada Lovelace");
                    assert_eq!(author_email.as_deref(), Some("ada@example.edu"));
                    assert_eq!(timestamp, 1_700_000_000_000);
                }
                other => panic!("expected a chat message, got {other:?}"),
            }
        }
        // No name at all falls back to the address rather than showing blank.
        let anonymous = chat_event(&json!({
            "id": "msg-2",
            "content": "hi",
            "user": {"email": "someone@example.edu"},
        }))
        .expect("parses");
        match anonymous {
            RealtimeEvent::ChatMessage { author_name, .. } => {
                assert_eq!(author_name, "someone@example.edu");
            }
            other => panic!("expected a chat message, got {other:?}"),
        }
    }

    #[test]
    fn ack_bodies_separate_errors_from_payloads() {
        let ok = vec![Value::Null, json!(["a"]), json!(3)];
        assert_eq!(ack_body(&ok, "joinDoc").unwrap(), &ok[1..]);
        // Server omitted the error slot entirely.
        let shifted = vec![json!(["a"]), json!(3)];
        assert_eq!(ack_body(&shifted, "joinDoc").unwrap(), &shifted[..]);
        // String and {message} errors both surface.
        assert!(ack_body(&[json!("boom")], "joinDoc")
            .unwrap_err()
            .contains("boom"));
        assert!(ack_body(&[json!({"message":"nope"})], "joinDoc")
            .unwrap_err()
            .contains("nope"));
        // A project payload is not an error even though it is an object.
        assert!(ack_body(&[json!({"rootFolder":[]})], "joinProject").is_ok());
    }

    // -- project tree -------------------------------------------------------

    fn project_tree() -> Value {
        json!({
            "_id": "proj-1",
            "name": "Paper",
            "rootFolder": [{
                "_id": "root-1",
                "name": "rootFolder",
                "docs": [{"_id": "doc-1", "name": "main.tex"}],
                "fileRefs": [{"_id": "file-1", "name": "figure.png"}],
                "folders": [{
                    "_id": "folder-1",
                    "name": "sections",
                    "docs": [{"_id": "doc-2", "name": "intro.tex"}],
                    "fileRefs": [],
                    "folders": [{
                        "_id": "folder-2",
                        "name": "deep",
                        "docs": [{"_id": "doc-3", "name": "nested.tex"}],
                        "fileRefs": [],
                        "folders": []
                    }]
                }]
            }]
        })
    }

    #[test]
    fn parse_project_flattens_nested_folders() {
        let ack = vec![Value::Null, project_tree(), json!("owner"), json!(2)];
        let body = ack_body(&ack, "joinProject").expect("no error slot");
        let (tree, _permission) = parse_project(body).expect("parses");
        assert_eq!(tree.root, "root-1");
        // Path order, so the list is stable however the tree is walked.
        assert_eq!(
            tree.docs(),
            vec![
                DocEntry {
                    id: "doc-1".into(),
                    path: "main.tex".into()
                },
                DocEntry {
                    id: "doc-3".into(),
                    path: "sections/deep/nested.tex".into()
                },
                DocEntry {
                    id: "doc-2".into(),
                    path: "sections/intro.tex".into()
                },
            ]
        );
    }

    #[test]
    fn the_tree_follows_renames_moves_and_deletes_by_id_alone() {
        // Overleaf's tree events carry ids and nothing else: a rename does not
        // say where the entity is, and a deleted folder arrives as one event
        // for the folder rather than one per file inside it. Resolving that
        // against a tree we hold is the whole point of keeping one.
        let ack = vec![Value::Null, project_tree(), json!("owner"), json!(2)];
        let body = ack_body(&ack, "joinProject").expect("no error slot");
        let (mut tree, _) = parse_project(body).expect("parses");

        // A file created in the browser becomes editable here immediately.
        tree.insert_entity(
            "folder-1",
            &json!({"_id": "doc-4", "name": "results.tex"}),
            NodeKind::Doc,
        );
        assert!(tree
            .docs()
            .iter()
            .any(|doc| doc.id == "doc-4" && doc.path == "sections/results.tex"));

        // Renaming a folder reindexes everything beneath it.
        assert!(tree.rename("folder-1", "chapters"));
        assert_eq!(tree.path_of("doc-2").as_deref(), Some("chapters/intro.tex"));
        assert_eq!(
            tree.path_of("doc-3").as_deref(),
            Some("chapters/deep/nested.tex")
        );

        // Moving one does too, and to the root means no folder in the path.
        assert!(tree.move_to("folder-2", tree.root.clone().as_str()));
        assert_eq!(tree.path_of("doc-3").as_deref(), Some("deep/nested.tex"));

        // Moving into a folder we have never heard of is refused rather than
        // silently orphaning the entity.
        assert!(!tree.move_to("doc-2", "folder-unknown"));
        assert_eq!(tree.path_of("doc-2").as_deref(), Some("chapters/intro.tex"));

        // Deleting a folder takes its contents with it.
        assert!(tree.remove("folder-1"));
        assert_eq!(tree.path_of("doc-2"), None);
        assert!(tree.docs().iter().all(|doc| doc.id != "doc-4"));
        // …and the file that had been moved out of it survives.
        assert_eq!(tree.path_of("doc-3").as_deref(), Some("deep/nested.tex"));

        // Deleting something already gone is not an event worth reporting.
        assert!(!tree.remove("folder-1"));
        assert!(!tree.rename("doc-2", "whatever.tex"));
    }

    #[test]
    fn parse_project_reports_missing_pieces() {
        assert!(parse_project(&[]).is_err());
        assert!(parse_project(&[json!({})]).is_err());
        assert!(parse_project(&[json!({"rootFolder": []})]).is_err());
        assert!(parse_project(&[json!({"rootFolder": [{"name": "x"}]})]).is_err());
    }

    // -- end to end against a mock socket.io 0.9 server ---------------------

    #[derive(Default)]
    struct MockState {
        handshake_line: Option<String>,
        handshake_cookie: Option<String>,
        ws_line: Option<String>,
        ws_cookie: Option<String>,
        ws_origin: Option<String>,
        frames: Vec<String>,
        /// Newer Overleaf: join from the handshake query and push the project
        /// down, never answering a `joinProject` ask.
        push_join: bool,
    }

    fn start_mock() -> (u16, Arc<Mutex<MockState>>) {
        start_mock_with(false)
    }

    fn start_mock_with(push_join: bool) -> (u16, Arc<Mutex<MockState>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the mock server");
        let port = listener.local_addr().expect("mock address").port();
        let state = Arc::new(Mutex::new(MockState {
            push_join,
            ..MockState::default()
        }));
        let server_state = state.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let state = server_state.clone();
                std::thread::spawn(move || serve(stream, state));
            }
        });
        (port, state)
    }

    /// Reads an HTTP request head one byte at a time so nothing is buffered
    /// past `\r\n\r\n` — the same socket is handed to the websocket afterwards.
    fn read_head(stream: &mut TcpStream) -> Option<String> {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match stream.read(&mut byte) {
                Ok(0) | Err(_) => return None,
                Ok(_) => head.push(byte[0]),
            }
            if head.ends_with(b"\r\n\r\n") {
                return String::from_utf8(head).ok();
            }
            if head.len() > 64 * 1024 {
                return None;
            }
        }
    }

    fn header(head: &str, name: &str) -> Option<String> {
        head.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key.trim().eq_ignore_ascii_case(name) {
                Some(value.trim().to_string())
            } else {
                None
            }
        })
    }

    fn serve(mut stream: TcpStream, state: Arc<Mutex<MockState>>) {
        let head = match read_head(&mut stream) {
            Some(head) => head,
            None => return,
        };
        let request_line = head.lines().next().unwrap_or_default().to_string();

        if request_line.contains("/socket.io/1/websocket/") {
            let key = match header(&head, "Sec-WebSocket-Key") {
                Some(key) => key,
                None => return,
            };
            {
                let mut state = lock(&state);
                state.ws_line = Some(request_line);
                state.ws_cookie = header(&head, "Cookie");
                state.ws_origin = header(&head, "Origin");
            }
            let accept = derive_accept_key(key.as_bytes());
            let response = format!(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            if stream.write_all(response.as_bytes()).is_err() {
                return;
            }
            let _ = stream.flush();
            serve_websocket(
                WebSocket::from_raw_socket(stream, Role::Server, None),
                state,
            );
            return;
        }

        {
            let mut state = lock(&state);
            state.handshake_line = Some(request_line);
            state.handshake_cookie = header(&head, "Cookie");
        }
        let body = "testsid:60:60:websocket";
        // Load balancers pin the realtime session with a cookie of their own;
        // the upgrade has to carry it back or it lands on another instance.
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: ol-affinity=instance-7; Path=/; HttpOnly\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    }

    fn event_frame(name: &str, args: Value) -> String {
        encode_frame(
            FRAME_EVENT,
            "",
            "",
            &json!({"name": name, "args": args}).to_string(),
        )
    }

    fn ack_frame(id: &str, args: Value) -> String {
        encode_frame(FRAME_ACK, "", "", &format!("{id}+{args}"))
    }

    fn serve_websocket(mut ws: WebSocket<TcpStream>, state: Arc<Mutex<MockState>>) {
        let push_join = lock(&state).push_join;
        let _ = ws.send(Message::text(encode_frame(FRAME_CONNECT, "", "", "")));
        if push_join {
            let _ = ws.send(Message::text(event_frame(
                "joinProjectResponse",
                json!([{"publicId": "pub-1", "project": project_tree(), "permissionsLevel": "owner"}]),
            )));
        } else {
            let _ = ws.send(Message::text(event_frame(
                "connectionAccepted",
                json!([null, "pub-1"]),
            )));
        }
        loop {
            let message = match ws.read() {
                Ok(message) => message,
                Err(_) => break,
            };
            let text = match message {
                Message::Text(text) => text.as_str().to_string(),
                Message::Close(_) => break,
                _ => continue,
            };
            lock(&state).frames.push(text.clone());
            let frame = match parse_frame(&text) {
                Ok(frame) => frame,
                Err(_) => continue,
            };
            if frame.kind != FRAME_EVENT {
                continue;
            }
            let name = match parse_event(&frame.data) {
                Ok((name, _)) => name,
                Err(_) => continue,
            };
            let id = frame.id.trim_end_matches('+').to_string();
            let sent = match name.as_str() {
                // A server that pushed the project ignores the ask entirely,
                // which is exactly the case the client has to survive.
                "joinProject" if push_join => Ok(()),
                "joinProject" => ws.send(Message::text(ack_frame(
                    &id,
                    json!([null, project_tree(), "owner", 2]),
                ))),
                "joinDoc" => {
                    let ack = ws.send(Message::text(ack_frame(
                        &id,
                        json!([
                            null,
                            ["line one", "line two"],
                            42,
                            [],
                            {"comments": [{"id": "change-1",
                                            "op": {"p": 4, "c": "one", "t": "thread-1"}}],
                              "changes": []}
                        ]),
                    )));
                    // Unsolicited update from another collaborator...
                    let _ = ws.send(Message::text(event_frame(
                        "otUpdateApplied",
                        json!([{"doc": "doc-1", "v": 43, "op": [{"p": 9, "i": "!"}],
                                 "meta": {"source": "someone-else"}}]),
                    )));
                    // ...and a heartbeat the client has to echo.
                    let _ = ws.send(Message::text(encode_frame(FRAME_HEARTBEAT, "", "", "")));
                    ack
                }
                "applyOtUpdate" | "leaveDoc" => {
                    ws.send(Message::text(ack_frame(&id, json!([null]))))
                }
                _ => Ok(()),
            };
            if sent.is_err() {
                break;
            }
        }
    }

    fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if ready() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {what}");
    }

    /// Talks to the real Overleaf, using the session the app already stored.
    ///
    /// The mock server proves the protocol is implemented; only this proves it
    /// is the protocol Overleaf actually speaks. Run it by hand:
    ///
    /// ```text
    /// OVERLEAF_E2E_PROJECT=<project root> \
    ///   cargo test --manifest-path src-tauri/Cargo.toml \
    ///   overleaf_rt::tests::connects_to_the_real_overleaf -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "talks to overleaf.com with the signed-in session"]
    fn connects_to_the_real_overleaf() {
        let root = std::path::PathBuf::from(
            std::env::var("OVERLEAF_E2E_PROJECT").expect("set OVERLEAF_E2E_PROJECT"),
        );
        let config = std::env::var("OVERLEAF_E2E_CONFIG")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                std::path::PathBuf::from(std::env::var("HOME").expect("HOME"))
                    .join("Library/Application Support/app.leo1oel.researchwriter")
            });
        let (host, cookie, project_id) =
            crate::overleaf::realtime_config(&config, &root).expect("a linked project");
        println!("host={host} project={project_id}");

        let events: Arc<Mutex<Vec<RealtimeEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let client = rt::block_on(RealtimeClient::connect(
            RealtimeConfig {
                host,
                cookie,
                project_id,
            },
            move |event| lock(&sink).push(event),
        ))
        .expect("connect to Overleaf");

        println!("public id: {:?}", client.public_id());
        println!("root folder: {}", client.project().root_folder_id);
        for doc in &client.project().docs {
            println!("  doc {} -> {}", doc.id, doc.path);
        }
        assert!(
            !client.project().docs.is_empty(),
            "Overleaf reported no documents"
        );

        let first = client.project().docs[0].clone();
        let joined = rt::block_on(client.join_doc(&first.id)).expect("joinDoc");
        println!(
            "joined {} at v{} ({} chars, {} comments)",
            first.path,
            joined.version,
            joined.text.len(),
            joined.comments.len()
        );
        assert!(joined.version >= 0);
        client.shutdown();
    }

    /// Sends a real operation to a real document and checks it comes back.
    ///
    /// This is the part the mock cannot prove: that the ops we build are the
    /// ops Overleaf accepts, that it echoes them with our own id, and that the
    /// version advances the way the state machine assumes. It edits the
    /// document named by `OVERLEAF_E2E_DOC` (an inserted character, then the
    /// same character deleted), leaving the text exactly as it found it.
    #[test]
    #[ignore = "edits a document on overleaf.com with the signed-in session"]
    fn edits_a_document_through_the_real_overleaf() {
        let root = std::path::PathBuf::from(
            std::env::var("OVERLEAF_E2E_PROJECT").expect("set OVERLEAF_E2E_PROJECT"),
        );
        let target = std::env::var("OVERLEAF_E2E_DOC").expect("set OVERLEAF_E2E_DOC");
        let config = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"))
            .join("Library/Application Support/app.leo1oel.researchwriter");
        let (host, cookie, project_id) =
            crate::overleaf::realtime_config(&config, &root).expect("a linked project");

        let events: Arc<Mutex<Vec<RealtimeEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let client = rt::block_on(RealtimeClient::connect(
            RealtimeConfig {
                host,
                cookie,
                project_id,
            },
            move |event| lock(&sink).push(event),
        ))
        .expect("connect to Overleaf");

        let doc = client
            .project()
            .docs
            .iter()
            .find(|doc| doc.path == target)
            .unwrap_or_else(|| panic!("no document named {target}"))
            .clone();
        let joined = rt::block_on(client.join_doc(&doc.id)).expect("joinDoc");
        let before = joined.text.clone();
        println!("editing {} at v{}", doc.path, joined.version);

        /// Waits for the server to acknowledge an operation at `at`, and
        /// answers with the version the document has moved to.
        fn acked(events: &Arc<Mutex<Vec<RealtimeEvent>>>, doc_id: &str, at: i64) -> i64 {
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                let seen = lock(events).iter().any(|event| {
                    matches!(
                        event,
                        RealtimeEvent::DocAck { doc_id: id, version } if id == doc_id && *version == at
                    )
                });
                if seen {
                    return at + 1;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            panic!("Overleaf never acknowledged our update on {doc_id}");
        }

        // Non-ASCII on purpose: Overleaf packs its snapshots as UTF-8 bytes
        // reinterpreted per code point, and a client that does not unpack them
        // writes mojibake to disk and counts offsets in bytes.
        let probe = "café第三节";
        rt::block_on(client.send_ops(
            &doc.id,
            joined.version,
            vec![OtOp {
                p: 0,
                i: Some(probe.into()),
                d: None,
            }],
        ))
        .expect("send the insert");
        let after_insert = acked(&events, &doc.id, joined.version);
        println!("insert accepted, now at v{after_insert}");

        // Read it back before removing it: this is the assertion that the
        // snapshot decoding is right, not just that the round trip completes.
        rt::block_on(client.leave_doc(&doc.id)).expect("leaveDoc");
        let midway = rt::block_on(client.join_doc(&doc.id)).expect("re-joinDoc");
        assert!(
            midway.text.starts_with(probe),
            "expected {probe:?} at the start, got {:?}",
            midway.text.chars().take(20).collect::<String>()
        );

        rt::block_on(client.send_ops(
            &doc.id,
            midway.version,
            vec![OtOp {
                p: 0,
                i: None,
                d: Some(probe.into()),
            }],
        ))
        .expect("send the delete");
        let after_delete = acked(&events, &doc.id, midway.version);
        println!("delete accepted, now at v{after_delete}");

        // Read it back from the server rather than trusting our own bookkeeping.
        rt::block_on(client.leave_doc(&doc.id)).expect("leaveDoc");
        let again = rt::block_on(client.join_doc(&doc.id)).expect("re-joinDoc");
        assert_eq!(again.text, before, "the document did not come back unchanged");
        println!("document unchanged at v{}", again.version);
        client.shutdown();
    }

    /// Creates a comment thread on a real document, then resolves, reopens and
    /// deletes it — the whole path a reviewer takes, against the real service.
    ///
    /// Overleaf splits a comment in two: the conversation behind REST, the
    /// anchor on the editing channel. Only doing both makes the span show as
    /// commented, and only the real service reveals things like the 411 a
    /// bodyless POST earns.
    #[test]
    #[ignore = "creates and deletes a comment on overleaf.com"]
    fn comments_on_a_real_document() {
        let root = std::path::PathBuf::from(
            std::env::var("OVERLEAF_E2E_PROJECT").expect("set OVERLEAF_E2E_PROJECT"),
        );
        let target = std::env::var("OVERLEAF_E2E_DOC").expect("set OVERLEAF_E2E_DOC");
        let config = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"))
            .join("Library/Application Support/app.leo1oel.researchwriter");
        let (host, cookie, project_id) =
            crate::overleaf::realtime_config(&config, &root).expect("a linked project");

        let client = rt::block_on(RealtimeClient::connect(
            RealtimeConfig {
                host,
                cookie,
                project_id,
            },
            move |_| {},
        ))
        .expect("connect to Overleaf");
        let doc = client
            .project()
            .docs
            .iter()
            .find(|doc| doc.path == target)
            .unwrap_or_else(|| panic!("no document named {target}"))
            .clone();
        let joined = rt::block_on(client.join_doc(&doc.id)).expect("joinDoc");

        // A thread id is minted by the client, not the server; both halves of
        // the call have to agree on it.
        let thread_id = format!("{:08x}{:016x}", 1_780_000_000u32, 0x5eedc0ffee1234u64);
        let quote: String = joined.text.chars().take(12).collect();
        crate::overleaf::reply_to_thread(&config, &root, &thread_id, "Lattice check: please ignore")
            .expect("post the first message");
        rt::block_on(client.send_comment(&doc.id, joined.version, 0, &quote, &thread_id))
            .expect("anchor the comment");
        println!("created thread {thread_id} on {:?}", quote);

        let found = crate::overleaf::threads(&config, &root).expect("read threads");
        let made = found
            .iter()
            .find(|thread| thread.id == thread_id)
            .expect("the thread we just made");
        assert_eq!(made.messages.len(), 1);
        assert_eq!(made.messages[0].content, "Lattice check: please ignore");
        assert!(made.messages[0].mine, "our own message should read as ours");
        assert!(!made.resolved);

        crate::overleaf::reply_to_thread(&config, &root, &thread_id, "and a reply")
            .expect("reply");
        crate::overleaf::resolve_thread(&config, &root, &doc.id, &thread_id, true)
            .expect("resolve");
        let resolved = crate::overleaf::threads(&config, &root)
            .expect("read threads")
            .into_iter()
            .find(|thread| thread.id == thread_id)
            .expect("still there");
        assert!(resolved.resolved, "the thread should read as resolved");
        assert_eq!(resolved.messages.len(), 2);
        println!("resolved by {:?}", resolved.resolved_by);

        crate::overleaf::resolve_thread(&config, &root, &doc.id, &thread_id, false)
            .expect("reopen");
        crate::overleaf::delete_thread(&config, &root, &doc.id, &thread_id).expect("delete");
        assert!(
            !crate::overleaf::threads(&config, &root)
                .expect("read threads")
                .iter()
                .any(|thread| thread.id == thread_id),
            "the thread should be gone"
        );
        println!("reopened and deleted cleanly");
        client.shutdown();
    }

    #[test]
    fn document_text_is_unpacked_from_overleafs_transport_encoding() {
        // Overleaf sends `unescape(encodeURIComponent(text))`: the UTF-8 bytes
        // reinterpreted one per code point. Reading that as-is gives mojibake,
        // and makes our character offsets count bytes while Overleaf counts
        // characters — which puts every later operation in the wrong place.
        let packed = |text: &str| -> String {
            text.as_bytes().iter().map(|b| *b as char).collect()
        };
        for original in [
            "第三节需要引用",
            "café — naïve",
            "\\section{Résultats}",
            "emoji: \u{1F600}",
        ] {
            assert_eq!(decode_packed_utf8(&packed(original)), original);
        }

        // ASCII is its own packing, and must survive untouched.
        assert_eq!(decode_packed_utf8("\\documentclass{article}"), "\\documentclass{article}");

        // Text that was never packed is left alone rather than mangled: not
        // every deployment encodes, and decoding twice is the same bug in
        // reverse.
        assert_eq!(decode_packed_utf8("已经是正常文本"), "已经是正常文本");
        // Bytes that are not valid UTF-8 are not a packing either.
        assert_eq!(decode_packed_utf8("\u{00ff}\u{00fe}"), "\u{00ff}\u{00fe}");
    }

    #[test]
    fn presence_reads_both_shapes_and_colours_by_account() {
        // The broadcast and the roster describe the same person with different
        // keys; getting either wrong shows a nameless ghost with no cursor.
        let broadcast = parse_presence_broadcast(&json!({
            "row": 42, "column": 36, "doc_id": "doc-1",
            "id": "P.abc", "user_id": "user-1",
            "email": "ada@example.edu", "name": "Ada Lovelace",
        }))
        .expect("parses");
        assert_eq!(broadcast.id, "P.abc");
        assert_eq!(broadcast.name, "Ada Lovelace");
        assert_eq!(broadcast.doc_id.as_deref(), Some("doc-1"));
        assert_eq!((broadcast.row, broadcast.column), (Some(42), Some(36)));

        let roster = parse_presence_roster(&json!({
            "client_id": "P.abc", "connected": true, "client_age": 1.02,
            "user_id": "user-1", "first_name": "Ada", "last_name": "Lovelace",
            "email": "ada@example.edu", "last_updated_at": "1753300000000",
            "cursorData": {"row": 42, "column": 36, "doc_id": "doc-1"},
        }))
        .expect("parses");
        // Same person, same colour, whichever way we heard about them.
        assert_eq!(roster.id, broadcast.id);
        assert_eq!(roster.name, broadcast.name);
        assert_eq!(roster.doc_id, broadcast.doc_id);
        assert_eq!(roster.hue, broadcast.hue);

        // Someone who has never moved has no cursor at all.
        let idle = parse_presence_roster(&json!({
            "client_id": "P.def", "connected": true,
            "user_id": "user-2", "first_name": "Sam",
        }))
        .expect("parses");
        assert_eq!(idle.name, "Sam");
        assert_eq!(idle.doc_id, None);
        assert_eq!(idle.row, None);

        // A hash whose entry has expired is not a person to show.
        assert!(parse_presence_roster(&json!({
            "client_id": "P.ghi", "connected": false,
        }))
        .is_none());

        // Anonymous users share one hue and carry no account.
        let anonymous = parse_presence_broadcast(&json!({
            "id": "P.jkl", "user_id": "anonymous-user", "name": "",
        }))
        .expect("parses");
        assert_eq!(anonymous.user_id, None);
        assert_eq!(anonymous.hue, 100);
    }

    #[test]
    fn presence_hues_match_overleafs_own_palette() {
        // Reproduces `getHueForUserId`: md5 of the account id, first eight hex
        // digits, modulo 320, with the band Overleaf keeps for "you" skipped.
        // Anything else and the same collaborator is two colours across the
        // two apps.
        assert_eq!(presence_hue(None), 100);
        assert_eq!(presence_hue(Some("anonymous-user")), {
            let digest = format!("{:x}", md5::compute(b"anonymous-user"));
            u32::from_str_radix(&digest[..8], 16).unwrap() % 320
        });
        for id in ["user-1", "5f2c1b3a4d5e6f7a8b9c0d1e", "ada@example.edu"] {
            let hue = presence_hue(Some(id));
            assert!(hue < 360, "{id} produced {hue}");
            // The reserved band is 180..220 exclusive; nothing may land there.
            assert!(!(180..=219).contains(&hue) || hue == 180, "{id} landed on {hue}");
        }
    }

    /// Reads the real project's roster and publishes a position, which is the
    /// only thing that makes us visible to a browser already looking at it.
    #[test]
    #[ignore = "talks to overleaf.com with the signed-in session"]
    fn appears_present_on_the_real_overleaf() {
        let root = std::path::PathBuf::from(
            std::env::var("OVERLEAF_E2E_PROJECT").expect("set OVERLEAF_E2E_PROJECT"),
        );
        let target = std::env::var("OVERLEAF_E2E_DOC").expect("set OVERLEAF_E2E_DOC");
        let config = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"))
            .join("Library/Application Support/app.leo1oel.researchwriter");
        let (host, cookie, project_id) =
            crate::overleaf::realtime_config(&config, &root).expect("a linked project");

        let events: Arc<Mutex<Vec<RealtimeEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let client = rt::block_on(RealtimeClient::connect(
            RealtimeConfig {
                host,
                cookie,
                project_id,
            },
            move |event| lock(&sink).push(event),
        ))
        .expect("connect to Overleaf");
        println!("permission: {:?}", client.project().permission);

        let doc = client
            .project()
            .docs
            .iter()
            .find(|doc| doc.path == target)
            .unwrap_or_else(|| panic!("no document named {target}"))
            .clone();
        rt::block_on(client.join_doc(&doc.id)).expect("joinDoc");

        // Publishing a position is what puts us on everyone else's screen.
        rt::block_on(client.update_position(&doc.id, 0, 0)).expect("updatePosition");

        let users = rt::block_on(client.connected_users()).expect("the roster");
        for user in &users {
            println!(
                "  {} {:?} hue {} doc {:?} at {:?}:{:?}",
                user.id, user.name, user.hue, user.doc_id, user.row, user.column
            );
        }
        let me = client.public_id();
        let mine = users.iter().find(|user| user.id == me);
        assert!(mine.is_some(), "we should be in the roster as {me}");
        // Our own broadcast comes back to us, which is how the app learns to
        // filter itself out.
        let echoed = lock(&events).iter().any(|event| {
            matches!(event, RealtimeEvent::PresenceUpdated { user } if user.id == me)
        });
        println!("our own position echoed back: {echoed}");
        client.shutdown();
    }

    #[test]
    fn comment_operations_never_reach_the_text_stream() {
        let events = doc_update_events(&json!({
            "doc": "doc-1",
            "v": 44,
            "op": [
                {"p": 5, "i": "hello"},
                {"p": 12, "c": "quoted span", "t": "thread-9"},
                {"p": 20, "d": "gone"},
            ],
            "meta": {"source": "pub-2"},
        }));
        match &events[0] {
            RealtimeEvent::DocUpdate {
                doc_id,
                version,
                ops,
                source,
            } => {
                assert_eq!(doc_id, "doc-1");
                assert_eq!(*version, 44);
                assert_eq!(source.as_deref(), Some("pub-2"));
                // The comment op is gone; transformed as an edit it would come
                // back as an empty delete.
                assert_eq!(
                    ops,
                    &vec![
                        OtOp {
                            p: 5,
                            i: Some("hello".into()),
                            d: None
                        },
                        OtOp {
                            p: 20,
                            i: None,
                            d: Some("gone".into())
                        },
                    ]
                );
            }
            other => panic!("expected DocUpdate first, got {other:?}"),
        }
        match &events[1] {
            RealtimeEvent::CommentAnchored { doc_id, range } => {
                assert_eq!(doc_id, "doc-1");
                assert_eq!(range.thread_id, "thread-9");
                assert_eq!(range.position, 12);
                assert_eq!(range.quote, "quoted span");
            }
            other => panic!("expected CommentAnchored, got {other:?}"),
        }
        assert_eq!(events.len(), 2);

        // Our own update coming back carries no operation at all. That is the
        // acknowledgement, and it must not be mistaken for an empty edit.
        let ack = doc_update_events(&json!({"doc": "doc-1", "v": 46}));
        assert_eq!(ack.len(), 1);
        match &ack[0] {
            RealtimeEvent::DocAck { doc_id, version } => {
                assert_eq!(doc_id, "doc-1");
                assert_eq!(*version, 46);
            }
            other => panic!("expected DocAck, got {other:?}"),
        }

        // A comment on its own still moves the version, so the update goes out
        // with no ops rather than not at all.
        let only_comment = doc_update_events(&json!({
            "doc": "doc-1", "v": 45,
            "op": [{"p": 0, "c": "x", "t": "thread-10"}],
        }));
        assert_eq!(only_comment.len(), 2);
        match &only_comment[0] {
            RealtimeEvent::DocUpdate { version, ops, .. } => {
                assert_eq!(*version, 45);
                assert!(ops.is_empty());
            }
            other => panic!("expected DocUpdate, got {other:?}"),
        }
    }

    #[test]
    fn cookies_from_the_handshake_join_the_ones_we_had() {
        // A new cookie is appended, an existing one is replaced in place, and
        // anything without a name is ignored.
        assert_eq!(
            merge_cookies(
                "overleaf_session2=abc; other=1",
                &[
                    "ol-affinity=instance-7; Path=/; HttpOnly".to_string(),
                    "other=2; Path=/".to_string(),
                    "; Path=/".to_string(),
                ],
            ),
            "overleaf_session2=abc; other=2; ol-affinity=instance-7"
        );
        assert_eq!(merge_cookies("session=x", &[]), "session=x");
    }

    #[test]
    fn joins_a_project_the_server_pushes_without_being_asked() {
        let (port, _state) = start_mock_with(true);
        let events: Arc<Mutex<Vec<RealtimeEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let client = rt::block_on(RealtimeClient::connect(
            RealtimeConfig {
                host: format!("http://127.0.0.1:{port}"),
                cookie: "overleaf_session2=test-cookie".to_string(),
                project_id: "proj-1".to_string(),
            },
            move |event| lock(&sink).push(event),
        ))
        .expect("connect to a server that joins us itself");

        // Same result as the ask-and-wait path: the tree, and our own id.
        assert_eq!(client.project().root_folder_id, "root-1");
        assert_eq!(client.project().docs.len(), 3);
        assert_eq!(client.project().docs[0].path, "main.tex");
        assert_eq!(client.public_id(), "pub-1");
        match lock(&events).first().expect("a Connected event") {
            RealtimeEvent::Connected { public_id } => assert_eq!(public_id, "pub-1"),
            other => panic!("expected Connected, got {other:?}"),
        }
        client.shutdown();
    }

    #[test]
    fn talks_the_whole_protocol_to_a_mock_server() {
        let (port, state) = start_mock();
        let events: Arc<Mutex<Vec<RealtimeEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let host = format!("http://127.0.0.1:{port}");
        let config = RealtimeConfig {
            host: host.clone(),
            cookie: "overleaf_session2=test-cookie".to_string(),
            project_id: "proj-1".to_string(),
        };

        let client = rt::block_on(RealtimeClient::connect(config, move |event| {
            lock(&sink).push(event);
        }))
        .expect("connect to the mock server");

        // The session cookie rides on both the handshake and the upgrade.
        {
            let state = lock(&state);
            let handshake_line = state.handshake_line.clone().expect("handshake request");
            assert!(
                handshake_line.contains("/socket.io/1/?projectId=proj-1&t="),
                "unexpected handshake request line: {handshake_line}"
            );
            assert_eq!(
                state.handshake_cookie.as_deref(),
                Some("overleaf_session2=test-cookie")
            );
            let ws_line = state.ws_line.clone().expect("websocket request");
            assert!(
                ws_line.contains("/socket.io/1/websocket/testsid?projectId=proj-1&t="),
                "unexpected websocket request line: {ws_line}"
            );
            // The handshake's own cookie rides along, or the upgrade would
            // reach an instance that never issued this session id.
            assert_eq!(
                state.ws_cookie.as_deref(),
                Some("overleaf_session2=test-cookie; ol-affinity=instance-7")
            );
            assert_eq!(state.ws_origin.as_deref(), Some(host.as_str()));
        }
        assert_eq!(client.sid(), "testsid");
        assert_eq!(client.heartbeat_secs(), 60);
        assert_eq!(client.public_id(), "pub-1");

        // connectionAccepted arrives before the joinProject ack, so the event
        // order is Connected → ProjectJoined.
        {
            let events = lock(&events);
            match events.first().expect("a Connected event") {
                RealtimeEvent::Connected { public_id } => assert_eq!(public_id, "pub-1"),
                other => panic!("expected Connected, got {other:?}"),
            }
            match events.get(1).expect("a ProjectJoined event") {
                RealtimeEvent::ProjectJoined {
                    root_folder_id,
                    docs,
                    ..
                } => {
                    assert_eq!(root_folder_id, "root-1");
                    assert_eq!(
                        docs,
                        &vec![
                            DocEntry {
                                id: "doc-1".into(),
                                path: "main.tex".into()
                            },
                            DocEntry {
                                id: "doc-3".into(),
                                path: "sections/deep/nested.tex".into()
                            },
                            DocEntry {
                                id: "doc-2".into(),
                                path: "sections/intro.tex".into()
                            },
                        ]
                    );
                }
                other => panic!("expected ProjectJoined, got {other:?}"),
            }
        }

        let joined = rt::block_on(client.join_doc("doc-1")).expect("joinDoc");
        assert_eq!(joined.text, "line one\nline two");
        assert_eq!(joined.version, 42);
        // Comment anchors ride in with the document, keyed by thread id.
        assert_eq!(
            joined.comments,
            vec![CommentRange {
                thread_id: "thread-1".into(),
                position: 4,
                quote: "one".into(),
            }]
        );

        rt::block_on(client.send_ops(
            "doc-1",
            42,
            vec![OtOp {
                p: 5,
                i: Some("hello".into()),
                d: None,
            }],
        ))
        .expect("applyOtUpdate");
        rt::block_on(client.leave_doc("doc-1")).expect("leaveDoc");

        // The unsolicited otUpdateApplied reaches the callback.
        wait_until("the DocUpdate event", || {
            lock(&events)
                .iter()
                .any(|event| matches!(event, RealtimeEvent::DocUpdate { .. }))
        });
        {
            let events = lock(&events);
            let update = events
                .iter()
                .find(|event| matches!(event, RealtimeEvent::DocUpdate { .. }))
                .expect("a DocUpdate event");
            match update {
                RealtimeEvent::DocUpdate {
                    doc_id,
                    version,
                    ops,
                    source,
                } => {
                    assert_eq!(doc_id, "doc-1");
                    assert_eq!(*version, 43);
                    // Carried through so the app can recognise its own echo.
                    assert_eq!(source.as_deref(), Some("someone-else"));
                    assert_eq!(
                        ops,
                        &vec![OtOp {
                            p: 9,
                            i: Some("!".into()),
                            d: None
                        }]
                    );
                }
                other => panic!("expected DocUpdate, got {other:?}"),
            }
        }

        // The server's `2::` gets echoed back.
        wait_until("the heartbeat echo", || {
            lock(&state).frames.iter().any(|frame| frame == "2::")
        });

        // Exact wire bytes, in order, for everything we emit.
        let frames = lock(&state).frames.clone();
        let events_only: Vec<&String> = frames.iter().filter(|f| f.starts_with("5:")).collect();
        assert_eq!(
            events_only,
            vec![
                &r#"5:1+::{"name":"joinProject","args":[{"project_id":"proj-1"}]}"#.to_string(),
                &r#"5:2+::{"name":"joinDoc","args":["doc-1",{"encodeRanges":true}]}"#.to_string(),
                &r#"5:3+::{"name":"applyOtUpdate","args":["doc-1",{"doc":"doc-1","op":[{"p":5,"i":"hello"}],"v":42}]}"#.to_string(),
                &r#"5:4+::{"name":"leaveDoc","args":["doc-1"]}"#.to_string(),
            ]
        );

        client.shutdown();
        wait_until("the Disconnected event", || {
            lock(&events)
                .iter()
                .any(|event| matches!(event, RealtimeEvent::Disconnected { .. }))
        });
    }

    #[test]
    fn connect_reports_a_dead_session_instead_of_hanging() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                if read_head(&mut stream).is_none() {
                    continue;
                }
                let body = "<!DOCTYPE html><html>login</html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        let config = RealtimeConfig {
            host: format!("http://127.0.0.1:{port}"),
            cookie: "overleaf_session2=stale".to_string(),
            project_id: "proj-1".to_string(),
        };
        let error = rt::block_on(RealtimeClient::connect(config, |_| {}))
            .expect_err("a stale cookie must not connect");
        assert_eq!(error, SESSION_EXPIRED);
    }

    #[test]
    fn connect_validates_its_configuration() {
        let bad_host = RealtimeConfig {
            host: "overleaf.com".to_string(),
            cookie: "c=1".to_string(),
            project_id: "p".to_string(),
        };
        assert!(rt::block_on(RealtimeClient::connect(bad_host, |_| {}))
            .unwrap_err()
            .contains("http://"));

        let no_cookie = RealtimeConfig {
            host: "https://www.overleaf.com".to_string(),
            cookie: "  ".to_string(),
            project_id: "p".to_string(),
        };
        assert!(rt::block_on(RealtimeClient::connect(no_cookie, |_| {}))
            .unwrap_err()
            .contains("Not connected to Overleaf"));
    }
}
