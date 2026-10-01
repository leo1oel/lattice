//! The connection: handshake, the read and write tasks, ack bookkeeping, and
//! the calls the app makes on an open channel.

use super::codec::*;
use super::events::*;
use super::tree::{parse_project, NodeKind, Tree};
use super::{NOT_CONNECTED, SESSION_EXPIRED, USER_AGENT};
use crate::util::url_encode;
use futures_util::sink::{Sink, SinkExt};
use futures_util::stream::{Stream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime as rt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

/// How long we wait for a `6:::{id}+…` ack before giving up on a request.
const ACK_TIMEOUT: Duration = Duration::from_secs(10);
/// Granularity of the ack timeout helper thread; also how fast it notices that
/// the waiter is gone and exits early.
const ACK_TIMER_TICK: Duration = Duration::from_millis(100);
/// How often the heartbeat watchdog looks at the clock.
const WATCHDOG_TICK: Duration = Duration::from_millis(500);
/// Outgoing frame queue depth. Deep enough that `try_send` from non-async
/// contexts (heartbeat echo, shutdown) never realistically fails.
const OUT_QUEUE: usize = 256;
/// Ack slot reserved for "the server accepted the connection" (`1::`). Real ack
/// ids start at 1, so 0 can never collide.
const CONNECT_SLOT: u32 = 0;
/// Ack slot for "we are in the project", at the end of the range real ack ids
/// count up from 1 towards.
const JOIN_SLOT: u32 = u32::MAX;
/// Said when this account may read the project but not change it.
const READ_ONLY: &str =
    "You have read-only access to this Overleaf project, so edits stay on this machine.";
const CLOSED_BEFORE_ANSWER: &str =
    "The Overleaf realtime connection closed before the server answered.";

pub struct RealtimeConfig {
    /// Our own Overleaf account id, when the app knows it. Only used to read
    /// the per-user track-changes setting out of the project.
    pub user_id: Option<String>,
    pub host: String,
    pub cookie: String,
    pub project_id: String,
}

fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

// ---- Handshake ------------------------------------------------------------

/// What the handshake settled: the session id, the heartbeat timeout in
/// seconds (0 = none), and the cookies to carry into the websocket upgrade. Runs on a blocking thread because the crate only has
/// `reqwest`'s blocking client.
fn handshake_blocking(
    origin: &str, cookie: &str, project_id: &str,
) -> Result<(String, u64, String), String> {
    let url =
        format!("{origin}/socket.io/1/?projectId={}&t={}", url_encode(project_id), now_millis());
    let client = crate::http::blocking_as(USER_AGENT, Duration::from_secs(20))
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
    let handed_back: Vec<String> = (response.headers().get_all(reqwest::header::SET_COOKIE).iter())
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
        return Err(format!("Overleaf refused the realtime handshake (HTTP {}).", status.as_u16()));
    }
    let login_page = body.trim_start().starts_with('<');
    let (sid, heartbeat) =
        parse_handshake(&body)
            .map_err(|e| if login_page { SESSION_EXPIRED.to_string() } else { e })?;
    Ok((sid, heartbeat, merge_cookies(cookie, &handed_back)))
}

/// Fold any cookies the handshake set into the ones we already had.
///
/// Overleaf runs several realtime instances behind a load balancer, and the
/// handshake answers with a cookie that pins the session to the instance
/// holding it. Leaving that cookie behind means the websocket upgrade reaches
/// a different instance, which has never heard of the id we were just given
/// and answers 502 — a failure that looks like the server being down.
///
/// Later values win, but a cookie keeps the position it first appeared in, so
/// the header stays stable and readable across reconnects.
pub(super) fn merge_cookies(base: &str, set_cookies: &[String]) -> String {
    let mut order: Vec<String> = Vec::new();
    let mut values: HashMap<String, String> = HashMap::new();
    let handed_back = set_cookies.iter().filter_map(|header| header.split(';').next());
    for pair in base.split(';').chain(handed_back).map(str::trim) {
        let Some(name) = pair.split_once('=').map(|(name, _)| name.trim()) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        if !values.contains_key(name) {
            order.push(name.to_string());
        }
        values.insert(name.to_string(), pair.to_string());
    }
    order.iter().filter_map(|name| values.get(name)).cloned().collect::<Vec<_>>().join("; ")
}

// ---- Shared connection state ----------------------------------------------

enum Outgoing {
    Frame(String),
    Close,
}

/// What an ack waiter is handed: the answer's arguments, or why none came.
type Ack = Result<Vec<Value>, String>;

/// A panic while holding one of these little locks must not poison the whole
/// connection.
pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Shared {
    /// Our own account id, so the per-account track-changes setting can be
    /// read when the project announces a change to it.
    user_id: Option<String>,
    /// The project's entities. Rebuilt at join, then kept current from the
    /// tree events, which is what lets a file created in the browser become
    /// editable here without re-reading the project.
    tree: Mutex<Tree>,
    out_tx: rt::Sender<Outgoing>,
    pending: Mutex<HashMap<u32, rt::Sender<Ack>>>,
    next_ack: AtomicU32,
    public_id: Mutex<String>,
    /// When the server last sent anything at all; see `watch_heartbeat`.
    last_heard: Mutex<Instant>,
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

    fn resolve(&self, id: u32, msg: Ack) {
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
        let waiters: Vec<rt::Sender<Ack>> = lock(&self.pending).drain().map(|(_, tx)| tx).collect();
        for waiter in waiters {
            let _ = waiter.try_send(Err(CLOSED_BEFORE_ANSWER.to_string()));
        }
        let _ = self.out_tx.try_send(Outgoing::Close);
        self.emit(RealtimeEvent::Disconnected { reason });
    }

    /// Apply one tree event and, when it changed anything, announce the tree.
    fn edit_tree(&self, edit: impl FnOnce(&mut Tree) -> bool) {
        let mut tree = lock(&self.tree);
        if edit(&mut tree) {
            let (docs, entities) = (tree.docs(), tree.entities());
            drop(tree);
            self.emit(RealtimeEvent::TreeChanged { docs, entities });
        }
    }
}

struct AckSlot {
    id: u32,
    rx: rt::Receiver<Ack>,
}

/// Registers an ack waiter and arms its timeout. The timer lives on a parked
/// helper thread (this crate cannot reach `tokio::time`) and exits early — well
/// before the full timeout — as soon as the waiter goes away.
fn open_slot(shared: &Arc<Shared>, id: u32, label: &str) -> AckSlot {
    let (tx, rx) = rt::channel::<Ack>(2);
    let timer_tx = tx.clone();
    lock(&shared.pending).insert(id, tx);
    let timed_out = format!("{label} timed out after {}s.", ACK_TIMEOUT.as_secs());
    std::thread::spawn(move || {
        let deadline = Instant::now() + ACK_TIMEOUT;
        while Instant::now() < deadline {
            if timer_tx.is_closed() {
                return;
            }
            std::thread::sleep(ACK_TIMER_TICK);
        }
        let _ = timer_tx.try_send(Err(timed_out));
    });
    AckSlot { id, rx }
}

async fn await_slot(shared: &Arc<Shared>, mut slot: AckSlot) -> Ack {
    let msg = slot.rx.recv().await;
    lock(&shared.pending).remove(&slot.id);
    msg.unwrap_or_else(|| Err(CLOSED_BEFORE_ANSWER.into()))
}

/// Emits `5:{id}+::{"name":…,"args":…}` and waits for the matching ack.
async fn emit_with_ack<A: Serialize>(shared: &Arc<Shared>, name: &str, args: A) -> Ack {
    let payload = encode_event(name, args)?;
    let id = shared.next_ack.fetch_add(1, Ordering::SeqCst);
    let slot = open_slot(shared, id, &format!("Overleaf's answer to {name}"));
    let frame = encode_frame(FRAME_EVENT, &format!("{id}+"), "", &payload);
    if let Err(e) = shared.send_frame(frame).await {
        lock(&shared.pending).remove(&id);
        return Err(e);
    }
    await_slot(shared, slot).await
}

// ---- Read / write loops ---------------------------------------------------

async fn write_loop<W>(mut sink: W, mut rx: rt::Receiver<Outgoing>)
where
    W: Sink<Message> + Unpin,
{
    while let Some(Outgoing::Frame(frame)) = rx.recv().await {
        if sink.send(Message::text(frame)).await.is_err() {
            break;
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
        *lock(&shared.last_heard) = Instant::now();
        let handled = match next {
            Ok(Message::Text(text)) => handle_frame(&shared, text.as_str()),
            Ok(Message::Binary(bytes)) => {
                std::str::from_utf8(&bytes).map_or(Ok(()), |text| handle_frame(&shared, text))
            }
            Ok(Message::Close(Some(frame))) if !frame.reason.as_str().is_empty() => {
                Err(format!("The Overleaf server closed the connection: {}", frame.reason.as_str()))
            }
            Ok(Message::Close(_)) => Err("The Overleaf server closed the connection.".to_string()),
            Ok(_) => Ok(()),
            Err(e) => Err(format!("The Overleaf realtime connection failed: {e}")),
        };
        if let Err(stop) = handled {
            reason = stop;
            break;
        }
    }
    shared.finish(reason);
}

/// Ends a connection the server has gone quiet on.
///
/// A socket can stay open after the network under it is gone — the laptop
/// slept, the Wi-Fi changed — and then nothing arrives and nothing fails:
/// collaborators' edits stop, ours time out one by one, and no reconnect is
/// ever asked for, because no disconnect was ever seen. Overleaf sends a
/// heartbeat well inside the timeout it names in the handshake, and the
/// Socket.IO 0.9 client its editor uses closes the connection when that much
/// time passes without hearing anything; so does this. Finishing reports
/// `Disconnected`, which is what sets the app reconnecting.
fn watch_heartbeat(shared: Arc<Shared>, timeout: Duration) {
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCHDOG_TICK);
        if shared.finished.load(Ordering::SeqCst) {
            return;
        }
        let silent = lock(&shared.last_heard).elapsed();
        if silent > timeout {
            shared.finish(format!(
                "Overleaf has sent nothing for {}s, so the connection is presumed lost.",
                silent.as_secs()
            ));
            return;
        }
    });
}

/// `Err` carries why the read loop should stop.
fn handle_frame(shared: &Arc<Shared>, raw: &str) -> Result<(), String> {
    // Junk on the wire is not fatal; the server also sends `8::` noops and
    // future frame types we do not know about.
    let Ok(frame) = parse_frame(raw) else {
        return Ok(());
    };
    match frame.kind {
        FRAME_HEARTBEAT => shared.queue(encode_frame(FRAME_HEARTBEAT, "", "", "")),
        FRAME_CONNECT => shared.resolve(CONNECT_SLOT, Ok(Vec::new())),
        FRAME_DISCONNECT => return Err("The Overleaf server closed the connection.".to_string()),
        FRAME_ACK => {
            if let Ok((id, args)) = parse_ack(&frame.data) {
                shared.resolve(id, Ok(args));
            }
        }
        FRAME_EVENT => return handle_event(shared, &frame.data),
        FRAME_ERROR => {
            let reason = format!("The Overleaf realtime server returned an error: {}", frame.data);
            shared.resolve(CONNECT_SLOT, Err(reason.clone()));
            return Err(reason);
        }
        _ => {}
    }
    Ok(())
}

fn handle_event(shared: &Arc<Shared>, data: &str) -> Result<(), String> {
    let Ok((name, args)) = parse_event(data) else {
        return Ok(());
    };
    let arg = |index: usize| args.get(index).and_then(Value::as_str);
    let error_or = |fallback: &str| args.first().map_or_else(|| fallback.to_string(), error_text);
    match name.as_str() {
        // `[publicId]` on some deployments, `[null, publicId]` on others.
        "connectionAccepted" => {
            let public_id = args.iter().find_map(Value::as_str).unwrap_or_default().to_string();
            *lock(&shared.public_id) = public_id.clone();
            shared.emit(RealtimeEvent::Connected { public_id });
        }
        "connectionRejected" => {
            let message = error_or("Overleaf rejected the realtime connection.");
            shared.resolve(CONNECT_SLOT, Err(message.clone()));
            return Err(message);
        }
        "otUpdateApplied" => {
            for event in args.iter().flat_map(doc_update_events) {
                shared.emit(event);
            }
        }
        "otUpdateError" => {
            let message = error_or("Overleaf rejected the edit.");
            shared.emit(RealtimeEvent::OtError { doc_id: doc_id_hint(&args), message });
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
            if let (Some(parent), Some(entity)) = (arg(0), args.get(1).filter(|v| v.is_object())) {
                shared.edit_tree(|tree| {
                    tree.insert_entity(parent, entity, kind);
                    true
                });
            }
        }
        "reciveEntityRename" => {
            if let (Some(id), Some(new_name)) = (arg(0), arg(1)) {
                shared.edit_tree(|tree| tree.rename(id, new_name));
            }
        }
        "reciveEntityMove" => {
            if let (Some(id), Some(folder)) = (arg(0), arg(1)) {
                shared.edit_tree(|tree| tree.move_to(id, folder));
            }
        }
        "removeEntity" => {
            if let Some(id) = arg(0) {
                shared.edit_tree(|tree| tree.remove(id));
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
                        shared.emit(RealtimeEvent::Connected { public_id: id.to_string() });
                    }
                }
                shared.resolve(JOIN_SLOT, Ok(vec![body.clone()]));
            }
        }
        "new-comment"
        | "new-comment-threads"
        | "edit-message"
        | "delete-message"
        | "resolve-thread"
        | "reopen-thread"
        | "delete-thread" => shared.emit(RealtimeEvent::ThreadsChanged),
        // Overleaf sends this to the whole room, us included; the app drops
        // its own by comparing ids.
        "clientTracking.clientUpdated" => {
            if let Some(user) = args.first().and_then(parse_presence_broadcast) {
                shared.emit(RealtimeEvent::PresenceUpdated { user });
            }
        }
        "clientTracking.clientDisconnected" => {
            if let Some(id) = arg(0) {
                shared.emit(RealtimeEvent::PresenceLeft { id: id.to_string() });
            }
        }
        "accept-changes" => {
            if let (Some(doc_id), Some(ids)) = (arg(0), args.get(1).and_then(Value::as_array)) {
                shared.emit(RealtimeEvent::ChangesAccepted {
                    doc_id: doc_id.to_string(),
                    change_ids: ids.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                });
            }
        }
        "toggle-track-changes" => {
            let on = track_changes_for(args.first(), shared.user_id.as_deref());
            shared.emit(RealtimeEvent::TrackChangesToggled { on });
        }
        "new-chat-message" => {
            if let Some(event) = args.first().and_then(chat_event) {
                shared.emit(event);
            }
        }
        "disconnect" | "forceDisconnect" => {
            return Err(error_or("Overleaf disconnected this session."))
        }
        _ => {}
    }
    Ok(())
}

/// A fresh seed for the ids Overleaf mints for tracked changes.
///
/// Eighteen hex characters: seconds since the epoch, then random "machine" and
/// "process" halves, which is the shape `RangesTracker.generateIdSeed` uses.
pub(super) fn change_id_seed() -> String {
    let seconds =
        SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0);
    let random = uuid::Uuid::new_v4();
    let bytes = random.as_bytes();
    let machine = u32::from_be_bytes([0, bytes[0], bytes[1], bytes[2]]);
    let pid = u16::from_be_bytes([bytes[3], bytes[4]]);
    format!("{:08x}{:06x}{:04x}", seconds as u32, machine, pid)
}

// ---- Client ---------------------------------------------------------------

pub struct RealtimeClient {
    shared: Arc<Shared>,
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
    /// Everything in the project, so a file can be acted on by id.
    pub entities: Vec<EntityEntry>,
    /// Our own Overleaf account id, echoed back so the app can name itself in
    /// the per-account settings Overleaf stores.
    pub user_id: Option<String>,
    /// What this account may do to the project. The connect answer carries
    /// it: without it the app read `undefined` and overwrote what the
    /// projectJoined event had established, so a reviewer's first keystroke
    /// went out as a plain edit, the server refused it, and live editing died.
    pub permission: Permission,
    /// Whether edits should be recorded as suggestions rather than applied
    /// outright, for this account.
    pub track_changes: bool,
}

// Hand-written because `Shared` holds the app's event callback; `Debug` is what
// lets callers `expect_err` on `connect`.
impl std::fmt::Debug for RealtimeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RealtimeClient")
            .field("public_id", &self.public_id())
            .field("live", &!self.shared.finished.load(Ordering::SeqCst))
            .finish()
    }
}

impl RealtimeClient {
    /// Connects, joins the project, and starts the read loop. `on_event` is
    /// called for every [`RealtimeEvent`] (from the client's own task).
    pub async fn connect(
        config: RealtimeConfig, on_event: impl Fn(RealtimeEvent) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let origin = normalize_origin(&config.host)?;
        let cookie = config.cookie.trim().to_string();
        if cookie.is_empty() {
            return Err(NOT_CONNECTED.to_string());
        }
        let project_id = config.project_id.trim().to_string();
        if project_id.is_empty() {
            return Err("No Overleaf project selected.".to_string());
        }

        let (sid, heartbeat, cookie) = {
            let (origin, project_id) = (origin.clone(), project_id.clone());
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
        let header = |value: &str, invalid: &str| {
            HeaderValue::from_str(value).map_err(|_| invalid.to_string())
        };
        let headers = request.headers_mut();
        headers
            .insert("Cookie", header(&cookie, "The Overleaf cookie is not a valid HTTP header.")?);
        headers
            .insert("Origin", header(&origin, "The Overleaf host is not a valid Origin header.")?);
        headers.insert("User-Agent", HeaderValue::from_static(USER_AGENT));

        let (stream, _response) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| format!("Could not open the Overleaf realtime connection: {e}"))?;
        let (sink, source) = stream.split();

        let (out_tx, out_rx) = rt::channel::<Outgoing>(OUT_QUEUE);
        let shared = Arc::new(Shared {
            user_id: config.user_id.clone(),
            tree: Mutex::new(Tree::default()),
            out_tx,
            pending: Mutex::new(HashMap::new()),
            next_ack: AtomicU32::new(1),
            public_id: Mutex::new(String::new()),
            last_heard: Mutex::new(Instant::now()),
            finished: AtomicBool::new(false),
            on_event: Box::new(on_event),
        });

        rt::spawn(write_loop(sink, out_rx));
        // Arm both waiters before the reader can possibly see what resolves
        // them. A server that joins us from the handshake query pushes
        // `joinProjectResponse` immediately after accepting the connection,
        // and an answer that arrives before anyone is waiting is simply lost.
        let connect_slot =
            open_slot(&shared, CONNECT_SLOT, "Overleaf's realtime connect handshake");
        let join_slot = open_slot(&shared, JOIN_SLOT, "Overleaf's project join");
        rt::spawn(read_loop(source, shared.clone()));
        // Zero is the handshake saying it sends no heartbeats at all.
        if heartbeat > 0 {
            watch_heartbeat(shared.clone(), Duration::from_secs(heartbeat));
        }
        await_slot(&shared, connect_slot).await?;

        // Two generations of Overleaf answer this differently: the older one
        // acks our `joinProject`, the newer one has already joined us from the
        // handshake query and pushes `joinProjectResponse` down. Ask, and take
        // whichever answer arrives first, so both work without guessing which
        // server we are talking to. Resolving is a no-op once the pushed answer
        // has been taken.
        let asker = shared.clone();
        rt::spawn(async move {
            let args = (JoinProjectArg { project_id: &project_id },);
            let asked = emit_with_ack(&asker, "joinProject", args).await;
            asker.resolve(JOIN_SLOT, asked);
        });
        let ack = await_slot(&shared, join_slot).await?;
        let (tree, permission, track_changes) = parse_project(ack_body(&ack, "joinProject")?)?;
        let project = ProjectTree {
            root_folder_id: tree.root.clone(),
            docs: tree.docs(),
            entities: tree.entities(),
            user_id: config.user_id.clone(),
            permission,
            track_changes: track_changes_for(track_changes.as_ref(), config.user_id.as_deref()),
        };
        *lock(&shared.tree) = tree;
        shared.emit(RealtimeEvent::ProjectJoined {
            root_folder_id: project.root_folder_id.clone(),
            docs: project.docs.clone(),
            permission,
        });

        Ok(RealtimeClient { shared, project })
    }

    /// Emit `name` and wait for Overleaf's answer; its error slot becomes an
    /// `Err`, and what follows it is returned.
    async fn call<A: Serialize>(&self, name: &str, args: A) -> Ack {
        let ack = emit_with_ack(&self.shared, name, args).await?;
        Ok(ack_body(&ack, name)?.to_vec())
    }

    /// `joinDoc` → the document's current lines joined with `'\n'`, plus its
    /// version.
    ///
    /// `from_version` asks the server to replay what we missed rather than
    /// only handing back the current text: coming back to a document we were
    /// editing, that replay is what lets unsent work survive instead of being
    /// overwritten by the server's copy. `None` — and a version the server can
    /// no longer reach back to — means starting over from the text.
    ///
    /// The version is a positional argument, `joinDoc(docId, fromVersion,
    /// options)`, and -1 is how the server is told to send the whole document.
    /// Passing it inside the options object silently gets you a full join.
    pub async fn join_doc(
        &self, doc_id: &str, from_version: Option<i64>,
    ) -> Result<JoinedDoc, String> {
        let options = JoinDocOptions { encode_ranges: true };
        let body = self.call("joinDoc", (doc_id, from_version.unwrap_or(-1), options)).await?;
        let lines = body
            .first()
            .and_then(Value::as_array)
            .ok_or_else(|| format!("Overleaf sent no content for document {doc_id}."))?;
        let text = (lines.iter())
            .map(|line| decode_packed_utf8(line.as_str().unwrap_or_default()))
            .collect::<Vec<_>>()
            .join("\n");
        let version = body
            .get(1)
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("Overleaf sent no version for document {doc_id}."))?;
        // `callback(null, lines, version, ops, ranges, type)`: the third slot
        // is what we missed, the fourth the document's ranges — tracked
        // changes, and the spans comment threads are anchored to.
        let caught_up = body.get(2).map(parse_catch_up).unwrap_or_default();
        let ranges = body.get(3);
        let comments = ranges.map(parse_comment_ranges).unwrap_or_default();
        let changes = ranges.map(parse_tracked_changes).unwrap_or_default();
        // Asking to resume and being handed nothing is ambiguous on its own —
        // it means either "nothing happened while you were away" or "that
        // version is too far back to replay". The version settles it: an empty
        // replay is only trustworthy when the document has not moved.
        let resumed = from_version.is_some_and(|from| !caught_up.is_empty() || from == version);
        Ok(JoinedDoc { text, version, comments, changes, caught_up, resumed })
    }

    /// `applyOtUpdate` with the given ops at version `version`, as a suggestion
    /// when `tracked`.
    ///
    /// A reviewer has no choice about tracking — the server checks for
    /// `meta.tc` and disconnects an account without edit rights that sends a
    /// plain update — and someone with write access uses it when track changes
    /// is on.
    ///
    /// `submission` carries what a resend or a hash check adds; see
    /// [`Submission`].
    pub async fn send_ops(
        &self, doc_id: &str, version: i64, ops: Vec<OtOp>, tracked: bool,
        submission: Submission<'_>,
    ) -> Result<(), String> {
        if ops.is_empty() {
            return Ok(());
        }
        let permission = self.project.permission;
        if !(if tracked { permission.can_suggest() } else { permission.can_write() }) {
            return Err(READ_ONLY.to_string());
        }
        let seed = tracked.then(change_id_seed);
        let meta = seed.as_deref().map(|tc| TrackedMeta { tc });
        let Submission { dup_if_source, hash } = submission;
        let update = Update { doc: doc_id, op: ops, v: version, meta, dup_if_source, hash };
        self.call("applyOtUpdate", (doc_id, update)).await.map(drop)
    }

    /// Reject suggestions by undoing them.
    ///
    /// There is no endpoint for this: rejecting a suggested insertion means
    /// deleting its text and rejecting a suggested deletion means putting the
    /// text back, both marked `u` so Overleaf consumes the change rather than
    /// recording the undo as a new suggestion. They travel as one update,
    /// ordered from the end of the document backwards so that applying one
    /// does not move the next.
    pub async fn reject_changes(
        &self, doc_id: &str, version: i64, changes: &[TrackedChange],
    ) -> Result<(), String> {
        if changes.is_empty() {
            return Ok(());
        }
        let mut ordered: Vec<&TrackedChange> = changes.iter().collect();
        ordered.sort_by_key(|change| std::cmp::Reverse(change.position));
        let ops: Vec<OtOp> = (ordered.iter())
            .map(|change| OtOp {
                p: change.position.max(0) as usize,
                i: change.deletion.then(|| change.text.clone()),
                d: (!change.deletion).then(|| change.text.clone()),
                u: Some(true),
            })
            .collect();
        // A reviewer may only ever write suggestions, so their rejection has
        // to travel as one too; the `u` flag works either way.
        let tracked = self.project.permission == Permission::Review;
        self.send_ops(doc_id, version, ops, tracked, Submission::default()).await
    }

    /// Anchor a comment thread to a span of a document.
    ///
    /// The thread's messages live behind the REST endpoints; this is the half
    /// that makes the span show as commented for everyone with the file open.
    /// It travels as an operation like any edit, so it takes a version and is
    /// acknowledged the same way.
    pub async fn send_comment(
        &self, doc_id: &str, version: i64, position: i64, quote: &str, thread_id: &str,
    ) -> Result<(), String> {
        let op = vec![CommentOp { p: position, c: quote, t: thread_id }];
        let update =
            Update { doc: doc_id, op, v: version, meta: None, dup_if_source: &[], hash: None };
        self.call("applyOtUpdate", (doc_id, update)).await.map(drop)
    }

    /// Everyone currently in the project, ourselves included.
    ///
    /// Overleaf answers no faster than a second: it broadcasts a refresh to
    /// every instance first and reads the roster back afterwards.
    pub async fn connected_users(&self) -> Result<Vec<PresenceUser>, String> {
        // The argument list must be empty. Socket.IO 0.9 appends the ack
        // callback as the last argument, and the handler takes exactly one —
        // anything sent binds to it and the call is rejected as malformed.
        let body = self.call("clientTracking.getConnectedUsers", ()).await?;
        let users = body.first().and_then(Value::as_array).into_iter().flatten();
        Ok(users.filter_map(parse_presence_roster).collect())
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
        let position = (CursorPosition { doc_id, row, column },);
        let payload = encode_event("clientTracking.updatePosition", position)?;
        self.shared.send_frame(encode_frame(FRAME_EVENT, "", "", &payload)).await
    }

    pub async fn leave_doc(&self, doc_id: &str) -> Result<(), String> {
        self.call("leaveDoc", (doc_id,)).await.map(drop)
    }

    /// The id Overleaf gave this session. The server stamps it onto every
    /// update we send, so an echo carrying it is our own work coming back.
    pub fn public_id(&self) -> String {
        lock(&self.shared.public_id).clone()
    }

    /// The project tree from the join, for callers that connected themselves.
    pub fn project(&self) -> &ProjectTree {
        &self.project
    }

    /// Unlike `project()`, this includes subsequent move/rename events and
    /// cannot be used after disconnection to resolve pending local moves.
    pub fn current_entities(&self) -> Option<Vec<EntityEntry>> {
        if self.shared.finished.load(Ordering::SeqCst) {
            return None;
        }
        Some(lock(&self.shared.tree).entities())
    }

    /// Closes the socket; the read loop exits and reports `Disconnected`.
    pub fn shutdown(&self) {
        let _ = self.shared.out_tx.try_send(Outgoing::Close);
    }
}
