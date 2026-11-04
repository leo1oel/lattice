//! Authenticated tab-owned terminals. Output is replayed until acknowledged;
//! dropped SSE connections receive a short reconnect lease before hangup.
use crate::terminal::{Output, OutputMessage, Session, Terminals};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

pub const COMMANDS: &[&str] = &[
    "terminal_open",
    "terminal_run",
    "terminal_write",
    "terminal_resize",
    "terminal_ack",
    "terminal_running_command",
    "terminal_close",
];
const MAX_TERMINALS: usize = 32;
const MAX_PER_TAB: usize = 4;
const RECONNECT_LEASE: Duration = Duration::from_secs(10);
const MAX_REPLAY_BYTES: usize = 10 * 1024 * 1024;

struct Message {
    id: u64,
    callback: u32,
    bytes: usize,
    payload: Value,
    retain_after_ack: bool,
}
struct StreamState {
    messages: VecDeque<Message>,
    next: u64,
    connected: usize,
    disconnected: Instant,
    closed: bool,
    replay_bytes: usize,
}
pub struct TabStream {
    state: Mutex<StreamState>,
    changed: watch::Sender<u64>,
}
impl TabStream {
    fn new() -> Arc<Self> {
        let (changed, _) = watch::channel(0);
        Arc::new(Self {
            state: Mutex::new(StreamState {
                messages: VecDeque::new(),
                next: 1,
                connected: 0,
                disconnected: Instant::now(),
                closed: false,
                replay_bytes: 0,
            }),
            changed,
        })
    }
    fn send(&self, callback: u32, index: u64, message: OutputMessage) -> Result<(), String> {
        let (value, bytes, exit) = match message {
            OutputMessage::Bytes(bytes) => {
                let len = bytes.len();
                (
                    json!({"__latticeBridgeBinary":base64::engine::general_purpose::STANDARD.encode(bytes)}),
                    len,
                    false,
                )
            }
            OutputMessage::Exit(code) => (json!({"exit":code}), 0, true),
        };
        let mut state = self.state.lock().unwrap();
        if state.closed
            || state.replay_bytes + bytes > MAX_REPLAY_BYTES
            || state.messages.len() > 4096
        {
            state.closed = true;
            self.changed.send_replace(state.next);
            return Err("Terminal transport closed.".into());
        }
        let id = state.next;
        state.next += 1;
        state.replay_bytes += bytes;
        state.messages.push_back(Message {
            id,
            callback,
            bytes,
            payload: json!({"callback":callback,"payload":{"message":value,"index":index}}),
            retain_after_ack: exit,
        });
        if exit {
            let id = state.next;
            state.next += 1;
            state.messages.push_back(Message {
                id,
                callback,
                bytes: 0,
                payload: json!({"callback":callback,"payload":{"index":index+1,"end":true}}),
                retain_after_ack: true,
            });
        }
        self.changed.send_replace(state.next);
        Ok(())
    }
    fn acknowledge(&self, callback: u32, mut bytes: usize) {
        let mut state = self.state.lock().unwrap();
        for message in &mut state.messages {
            if message.callback != callback {
                continue;
            }
            let drawn = bytes.min(message.bytes);
            message.bytes -= drawn;
            bytes -= drawn;
        }
        // Non-byte exit envelopes stay for reconnect; byte envelopes only
        // leave after the browser says they were drawn, never on SSE delivery.
        state.messages.retain(|message| {
            message.callback != callback || message.bytes > 0 || message.retain_after_ack
        });
        state.replay_bytes = state.messages.iter().map(|message| message.bytes).sum();
    }
    pub fn next(&self, cursor: u64) -> Option<(u64, Value)> {
        self.state
            .lock()
            .unwrap()
            .messages
            .iter()
            .find(|message| message.id > cursor)
            .map(|message| (message.id, message.payload.clone()))
    }
    pub fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }
    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.messages.clear();
        self.changed.send_replace(state.next);
    }
}
pub struct Subscription {
    pub stream: Arc<TabStream>,
    pub changed: watch::Receiver<u64>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        let mut state = self.stream.state.lock().unwrap();
        state.connected = state.connected.saturating_sub(1);
        state.disconnected = Instant::now();
    }
}
#[derive(Default)]
struct HubState {
    streams: HashMap<String, Arc<TabStream>>,
    terminals: HashMap<u32, (String, u32)>,
}
#[derive(Default)]
pub struct TerminalHub {
    registry: Terminals,
    state: Mutex<HubState>,
}
impl TerminalHub {
    pub fn owner(session: &str, client: &str) -> Result<String, String> {
        if !(16..=64).contains(&client.len())
            || !client.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("A browser tab identifier is required for a terminal.".into());
        }
        Ok(format!("{session}:{client}"))
    }
    pub fn subscribe(&self, owner: &str) -> Result<Subscription, String> {
        let mut state = self.state.lock().unwrap();
        if !state.streams.contains_key(owner) && state.streams.len() >= 128 {
            return Err("Too many terminal transports.".into());
        }
        let stream = state.streams.entry(owner.into()).or_insert_with(TabStream::new).clone();
        stream.state.lock().unwrap().connected += 1;
        let changed = stream.changed.subscribe();
        Ok(Subscription { stream, changed })
    }
    pub fn invoke(
        &self, owner: &str, root: &Path, command: &str, args: &Value,
    ) -> Result<Value, String> {
        let number = |key: &str| {
            args.get(key)
                .and_then(Value::as_u64)
                .and_then(|number| u32::try_from(number).ok())
                .ok_or_else(|| format!("Missing integer argument: {key}"))
        };
        let mut state = self.state.lock().unwrap();
        let stream = state
            .streams
            .get(owner)
            .filter(|stream| {
                let stream = stream.state.lock().unwrap();
                !stream.closed
            })
            .cloned()
            .ok_or("Connect the terminal event stream before opening a terminal.")?;
        if command == "terminal_open" || command == "terminal_run" {
            if stream.state.lock().unwrap().connected == 0 {
                return Err("Connect the terminal event stream before opening a terminal.".into());
            }
            if state.terminals.len() >= MAX_TERMINALS
                || state.terminals.values().filter(|(tab, _)| tab == owner).count() >= MAX_PER_TAB
            {
                return Err("Terminal limit reached. Close another terminal first.".into());
            }
            let callback = args
                .get("onOutput")
                .and_then(Value::as_str)
                .and_then(|value| value.strip_prefix("__CHANNEL__:"))
                .and_then(|value| value.parse::<u32>().ok())
                .ok_or("Invalid terminal output channel.")?;
            let index = std::sync::atomic::AtomicU64::new(0);
            let output = Output::new(move |message| {
                stream.send(
                    callback,
                    index.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                    message,
                )
            });
            let cols = number("cols")?.min(1000) as u16;
            let rows = number("rows")?.min(500) as u16;
            let terminal = if command == "terminal_run" {
                let program =
                    args.get("program").and_then(Value::as_str).ok_or("Choose a program.")?;
                let arguments = args
                    .get("args")
                    .and_then(Value::as_array)
                    .ok_or("Program arguments must be an array.")?
                    .iter()
                    .map(|argument| {
                        argument
                            .as_str()
                            .map(str::to_owned)
                            .ok_or("Program arguments must be strings.")
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Session::spawn_program(
                    program,
                    &arguments,
                    owner.into(),
                    root.into(),
                    cols,
                    rows,
                    output,
                )?
            } else {
                Session::spawn(owner.into(), root.into(), cols, rows, output)?
            };
            let shell = terminal.name().to_string();
            let id = self.registry.insert(terminal);
            state.terminals.insert(id, (owner.into(), callback));
            return Ok(json!({"id":id,"shell":shell}));
        }
        let id = number("id")?;
        let callback = state
            .terminals
            .get(&id)
            .filter(|(tab, _)| tab == owner)
            .map(|(_, callback)| *callback)
            .ok_or("This terminal has closed.")?;
        match command {
            "terminal_write" => {
                let data =
                    args.get("data").and_then(Value::as_str).ok_or("Missing terminal input.")?;
                if data.len() > 256 * 1024 {
                    return Err("Too much terminal input.".into());
                }
                self.registry
                    .with(owner, id, |terminal| terminal.write(data.as_bytes().to_vec()))??;
                Ok(Value::Null)
            }
            "terminal_resize" => {
                self.registry.with(owner, id, |terminal| {
                    terminal
                        .resize(number("cols")?.min(1000) as u16, number("rows")?.min(500) as u16)
                })??;
                Ok(Value::Null)
            }
            "terminal_ack" => {
                let bytes = number("bytes")? as usize;
                stream.acknowledge(callback, bytes);
                self.registry.with(owner, id, |terminal| terminal.acknowledge(bytes))?;
                Ok(Value::Null)
            }
            "terminal_running_command" => {
                Ok(json!(self.registry.with(owner, id, Session::running_command)?))
            }
            "terminal_close" => {
                state.terminals.remove(&id);
                self.registry.close(owner, id);
                Ok(Value::Null)
            }
            _ => Err("Unsupported terminal command.".into()),
        }
    }
    pub fn close_session(&self, session: &str) {
        let prefix = format!("{session}:");
        let mut state = self.state.lock().unwrap();
        let owners: Vec<_> =
            state.streams.keys().filter(|owner| owner.starts_with(&prefix)).cloned().collect();
        for owner in owners {
            if let Some(stream) = state.streams.remove(&owner) {
                stream.close();
            }
            self.registry.close_window(&owner);
            state.terminals.retain(|_, (tab, _)| tab != &owner);
        }
    }
    fn close_owner(&self, owner: &str) {
        let mut state = self.state.lock().unwrap();
        if let Some(stream) = state.streams.remove(owner) {
            stream.close();
        }
        self.registry.close_window(owner);
        state.terminals.retain(|_, (tab, _)| tab != owner);
    }
    pub fn close_client(&self, session: &str, client: &str) {
        if let Ok(owner) = Self::owner(session, client) {
            self.close_owner(&owner);
        }
    }
    pub fn reap(&self, valid: impl Fn(&str) -> bool) {
        let owners: Vec<_> = {
            let state = self.state.lock().unwrap();
            state
                .streams
                .iter()
                .filter_map(|(owner, stream)| {
                    let stream = stream.state.lock().unwrap();
                    let session = owner.split(':').next().unwrap();
                    (!valid(session)
                        || stream.closed
                        || (stream.connected == 0
                            && stream.disconnected.elapsed() > RECONNECT_LEASE))
                        .then(|| owner.to_string())
                })
                .collect()
        };
        for owner in owners {
            self.close_owner(&owner);
        }
    }
    pub fn close_all(&self) {
        self.registry.close_all_and_wait();
    }
}
