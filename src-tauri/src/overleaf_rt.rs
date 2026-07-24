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
//! 5:3+::{"name":"applyOtUpdate","args":["<docId>",{"doc":"<docId>","op":[{"p":5,"i":"hello"}],"v":42,"meta":{"source":"<publicId>"}}]}
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
    Disconnected {
        reason: String,
    },
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
fn handshake_blocking(
    origin: &str,
    cookie: &str,
    project_id: &str,
) -> Result<(String, u64), String> {
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
    parse_handshake(&body).map_err(|e| {
        if body.trim_start().starts_with('<') {
            SESSION_EXPIRED.to_string()
        } else {
            e
        }
    })
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

#[derive(Serialize)]
struct JoinDocOptions {
    #[serde(rename = "encodeRanges")]
    encode_ranges: bool,
}

#[derive(Serialize)]
struct OtUpdate<'a> {
    doc: &'a str,
    op: Vec<OtOp>,
    v: i64,
    meta: OtMeta<'a>,
}

#[derive(Serialize)]
struct OtMeta<'a> {
    source: &'a str,
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

/// `joinProject` answers with `[error, project, permissions, protocolVersion]`;
/// `project.rootFolder` is an array holding the single root folder.
fn parse_project(body: &[Value]) -> Result<(String, Vec<DocEntry>), String> {
    let project = body
        .first()
        .ok_or_else(|| "Overleaf's joinProject answer carried no project.".to_string())?;
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
    let root_folder_id = root
        .get("_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Overleaf's root folder has no id.".to_string())?
        .to_string();
    let mut docs = Vec::new();
    collect_docs(root, "", &mut docs, 0);
    Ok((root_folder_id, docs))
}

/// Depth-first flatten: a folder's own docs first, then its subfolders. The
/// root folder's own name is not part of any path.
fn collect_docs(folder: &Value, prefix: &str, out: &mut Vec<DocEntry>, depth: usize) {
    if depth > MAX_FOLDER_DEPTH {
        return;
    }
    if let Some(docs) = folder.get("docs").and_then(Value::as_array) {
        for doc in docs {
            let id = doc.get("_id").and_then(Value::as_str);
            let name = doc.get("name").and_then(Value::as_str);
            if let (Some(id), Some(name)) = (id, name) {
                out.push(DocEntry {
                    id: id.to_string(),
                    path: join_path(prefix, name),
                });
            }
        }
    }
    if let Some(folders) = folder.get("folders").and_then(Value::as_array) {
        for child in folders {
            let name = child.get("name").and_then(Value::as_str).unwrap_or("");
            collect_docs(child, &join_path(prefix, name), out, depth + 1);
        }
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
                if let Some(event) = doc_update_event(arg) {
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

fn doc_update_event(value: &Value) -> Option<RealtimeEvent> {
    let doc_id = value.get("doc").and_then(Value::as_str)?.to_string();
    let version = value.get("v").and_then(Value::as_i64).unwrap_or(-1);
    let ops = value
        .get("op")
        .and_then(Value::as_array)
        .map(|ops| {
            ops.iter()
                .filter_map(|op| serde_json::from_value::<OtOp>(op.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let source = value
        .get("meta")
        .and_then(|meta| meta.get("source"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(RealtimeEvent::DocUpdate {
        doc_id,
        version,
        ops,
        source,
    })
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

        let (sid, heartbeat_secs) = {
            let (origin, cookie, project_id) = (origin.clone(), cookie.clone(), project_id.clone());
            rt::spawn_blocking(move || handshake_blocking(&origin, &cookie, &project_id))
                .await
                .map_err(|e| format!("The Overleaf handshake task failed: {e}"))??
        };

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
            out_tx,
            pending: Mutex::new(HashMap::new()),
            next_ack: AtomicU32::new(1),
            public_id: Mutex::new(String::new()),
            finished: AtomicBool::new(false),
            on_event: Box::new(on_event),
        });

        rt::spawn(write_loop(sink, out_rx));
        // Arm the `1::` waiter before the reader can possibly see it.
        let connect_slot = open_slot(
            &shared,
            CONNECT_SLOT,
            "Overleaf's realtime connect handshake".to_string(),
        );
        rt::spawn(read_loop(source, shared.clone()));
        await_slot(&shared, connect_slot).await?;

        let ack = emit_with_ack(
            &shared,
            "joinProject",
            (JoinProjectArg {
                project_id: &project_id,
            },),
        )
        .await?;
        let body = ack_body(&ack, "joinProject")?;
        let (root_folder_id, docs) = parse_project(body)?;
        shared.emit(RealtimeEvent::ProjectJoined {
            root_folder_id,
            docs,
        });

        Ok(RealtimeClient {
            shared,
            sid,
            heartbeat_secs,
        })
    }

    /// `joinDoc` → the document's current lines joined with `'\n'`, plus its
    /// version.
    pub async fn join_doc(&self, doc_id: &str) -> Result<(String, i64), String> {
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
            .map(|line| line.as_str().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        let version = body
            .get(1)
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("Overleaf sent no version for document {doc_id}."))?;
        Ok((text, version))
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
        let source = lock(&self.shared.public_id).clone();
        let update = OtUpdate {
            doc: doc_id,
            op: ops,
            v: version,
            meta: OtMeta { source: &source },
        };
        let ack = emit_with_ack(&self.shared, "applyOtUpdate", (doc_id, update)).await?;
        ack_body(&ack, "applyOtUpdate")?;
        Ok(())
    }

    /// The id Overleaf gave this session; ops we send carry it as
    /// `meta.source`, and echoes of our own edits carry it back.
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
                    meta: OtMeta { source: "pub-1" },
                },
            ),
        )
        .expect("encodes");
        assert_eq!(
            payload,
            r#"{"name":"applyOtUpdate","args":["doc-1",{"doc":"doc-1","op":[{"p":5,"i":"hello"}],"v":42,"meta":{"source":"pub-1"}}]}"#
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
        };
        assert_eq!(
            serde_json::to_string(&joined).unwrap(),
            r#"{"type":"projectJoined","rootFolderId":"root-1","docs":[{"id":"doc-1","path":"sections/intro.tex"}]}"#
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
        let (root_folder_id, docs) = parse_project(body).expect("parses");
        assert_eq!(root_folder_id, "root-1");
        assert_eq!(
            docs,
            vec![
                DocEntry {
                    id: "doc-1".into(),
                    path: "main.tex".into()
                },
                DocEntry {
                    id: "doc-2".into(),
                    path: "sections/intro.tex".into()
                },
                DocEntry {
                    id: "doc-3".into(),
                    path: "sections/deep/nested.tex".into()
                },
            ]
        );
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
    }

    fn start_mock() -> (u16, Arc<Mutex<MockState>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the mock server");
        let port = listener.local_addr().expect("mock address").port();
        let state = Arc::new(Mutex::new(MockState::default()));
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
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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
        let _ = ws.send(Message::text(encode_frame(FRAME_CONNECT, "", "", "")));
        let _ = ws.send(Message::text(event_frame(
            "connectionAccepted",
            json!([null, "pub-1"]),
        )));
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
                "joinProject" => ws.send(Message::text(ack_frame(
                    &id,
                    json!([null, project_tree(), "owner", 2]),
                ))),
                "joinDoc" => {
                    let ack = ws.send(Message::text(ack_frame(
                        &id,
                        json!([null, ["line one", "line two"], 42, [], {}]),
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
            assert_eq!(
                state.ws_cookie.as_deref(),
                Some("overleaf_session2=test-cookie")
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
                                id: "doc-2".into(),
                                path: "sections/intro.tex".into()
                            },
                            DocEntry {
                                id: "doc-3".into(),
                                path: "sections/deep/nested.tex".into()
                            },
                        ]
                    );
                }
                other => panic!("expected ProjectJoined, got {other:?}"),
            }
        }

        let (text, version) = rt::block_on(client.join_doc("doc-1")).expect("joinDoc");
        assert_eq!(text, "line one\nline two");
        assert_eq!(version, 42);

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
                &r#"5:3+::{"name":"applyOtUpdate","args":["doc-1",{"doc":"doc-1","op":[{"p":5,"i":"hello"}],"v":42,"meta":{"source":"pub-1"}}]}"#.to_string(),
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
