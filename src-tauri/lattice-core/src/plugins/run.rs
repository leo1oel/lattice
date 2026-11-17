//! One command run: start the plugin, `initialize`, `command/run`, answer
//! its host calls until it returns, then end the process group.
//!
//! v1 starts a process per command, so nothing a plugin does outlives the
//! command the writer chose. Every wait is bounded: a run that passes its
//! deadline or is cancelled gets `$/cancelRequest`, a moment to answer, and
//! then SIGTERM and SIGKILL to its whole process group
//! (`sidecar::terminate_process_group`, as the agent sidecar is stopped).
//!
//! Messages are JSON-RPC 2.0, one per line. A line longer than
//! `MAX_MESSAGE` ends the run: an unbounded line is the easiest way for a
//! broken plugin to take the app's memory.

use super::broker::{Broker, RpcError};
use super::protocol::{
    error_codes, InitializeParams, InitializeResult, LogParams, ProgressParams, RunParams,
};
use super::results;
use super::{CommandResult, PluginError, RunEvent};
use crate::host::Sink;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_MESSAGE: usize = 8 << 20;
const MAX_STDERR: usize = 64 << 10;
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const CANCEL_GRACE: Duration = Duration::from_millis(500);
const TICK: Duration = Duration::from_millis(50);

/// Set by a shell to stop a running command (the palette closed, Escape).
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

enum Incoming {
    Message(Value),
    /// The plugin's stdout closed or broke the framing.
    End(Option<String>),
}

pub(crate) struct Session<'a> {
    pub(crate) broker: &'a Broker<'a>,
    pub(crate) events: &'a dyn Sink<RunEvent>,
    pub(crate) cancel: &'a CancelToken,
    pub(crate) timeout: Duration,
    pub(crate) min_api: u32,
}

impl Session<'_> {
    pub(crate) fn run(
        &self, mut command: Command, init: InitializeParams, params: RunParams,
    ) -> Result<CommandResult, PluginError> {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child =
            command.spawn().map_err(|e| PluginError::Launch { message: e.to_string() })?;
        let stderr = capture_stderr(&mut child);
        let incoming = read_messages(&mut child);
        let mut stdin = child.stdin.take();
        let outcome = self.converse(stdin.as_mut(), &incoming, init, params);
        drop(stdin);
        finish(&mut child);
        let stderr = String::from_utf8_lossy(&stderr.lock().map(|s| s.clone()).unwrap_or_default())
            .into_owned();
        if !stderr.trim().is_empty() {
            log::debug!(target: "lattice::plugins", "{} stderr: {}", self.broker.plugin_id, stderr.trim_end());
        }
        outcome.map_err(|error| match error {
            PluginError::Crashed { .. } => PluginError::Crashed { stderr: tail(&stderr) },
            other => other,
        })
    }

    fn converse(
        &self, mut stdin: Option<&mut ChildStdin>, incoming: &Receiver<Incoming>,
        init: InitializeParams, params: RunParams,
    ) -> Result<CommandResult, PluginError> {
        let mut send = |message: Value| -> Result<(), PluginError> {
            let stdin =
                stdin.as_deref_mut().ok_or(PluginError::Crashed { stderr: String::new() })?;
            let mut line = serde_json::to_vec(&message).expect("serializable");
            line.push(b'\n');
            stdin
                .write_all(&line)
                .and_then(|()| stdin.flush())
                .map_err(|_| PluginError::Crashed { stderr: String::new() })
        };

        send(request(1, "initialize", serde_json::to_value(&init).expect("serializable")))?;
        let reply =
            self.await_response(1, incoming, Instant::now() + INITIALIZE_TIMEOUT, &mut send)?;
        let initialized: InitializeResult = serde_json::from_value(reply)
            .map_err(|e| PluginError::Protocol { message: format!("initialize: {e}") })?;
        if initialized.api_level < self.min_api.max(init.host_api_compat)
            || initialized.api_level > init.host_api_level
        {
            return Err(PluginError::UnsupportedApi { level: initialized.api_level });
        }

        send(request(2, "command/run", serde_json::to_value(&params).expect("serializable")))?;
        let value = self.await_response(2, incoming, Instant::now() + self.timeout, &mut send)?;
        results::parse(value).map_err(|message| PluginError::Protocol { message })
    }

    /// Serve the plugin's calls until the response to `id` arrives.
    fn await_response(
        &self, id: i64, incoming: &Receiver<Incoming>, deadline: Instant,
        send: &mut dyn FnMut(Value) -> Result<(), PluginError>,
    ) -> Result<Value, PluginError> {
        let mut stopping: Option<(Instant, PluginError)> = None;
        loop {
            if let Some((until, _)) = &stopping {
                if Instant::now() >= *until {
                    return Err(stopping.take().expect("set").1);
                }
            } else if self.cancel.is_cancelled() || Instant::now() >= deadline {
                let why = if self.cancel.is_cancelled() {
                    PluginError::Cancelled
                } else {
                    PluginError::Timeout
                };
                let _ = send(
                    json!({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": id}}),
                );
                stopping = Some((Instant::now() + CANCEL_GRACE, why));
            }
            let message = match incoming.recv_timeout(TICK) {
                Ok(Incoming::Message(message)) => message,
                Ok(Incoming::End(Some(message))) => return Err(PluginError::Protocol { message }),
                Ok(Incoming::End(None)) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(stopping
                        .map_or(PluginError::Crashed { stderr: String::new() }, |(_, why)| why));
                }
                Err(RecvTimeoutError::Timeout) => continue,
            };
            let method = message.get("method").and_then(Value::as_str);
            match (method, message.get("id")) {
                (Some(method), Some(call)) if stopping.is_none() => {
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    let reply = match self.broker.handle(method, params) {
                        Ok(result) => json!({"jsonrpc": "2.0", "id": call, "result": result}),
                        Err(RpcError { code, message, data }) => {
                            json!({"jsonrpc": "2.0", "id": call, "error": {"code": code, "message": message, "data": data}})
                        }
                    };
                    send(reply)?;
                }
                (Some(method), None) => self.notification(method, message.get("params")),
                (None, Some(reply_id)) if reply_id.as_i64() == Some(id) => {
                    if let Some(result) = message.get("result") {
                        return Ok(result.clone());
                    }
                    let error = message.get("error").cloned().unwrap_or(Value::Null);
                    if stopping.is_some()
                        || error.get("code").and_then(Value::as_i64)
                            == Some(error_codes::REQUEST_CANCELLED)
                    {
                        return Err(stopping.map_or(PluginError::Cancelled, |(_, why)| why));
                    }
                    let text = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("The plugin failed.");
                    return Err(PluginError::Plugin { message: text.chars().take(2000).collect() });
                }
                _ => {}
            }
        }
    }

    fn notification(&self, method: &str, params: Option<&Value>) {
        let params = params.cloned().unwrap_or(Value::Null);
        let event = match method {
            "log" => serde_json::from_value::<LogParams>(params).ok().map(|p| {
                let message: String = p.message.chars().take(4000).collect();
                log::info!(target: "lattice::plugins", "{}: {message}", self.broker.plugin_id);
                RunEvent::Log { level: p.level, message }
            }),
            "progress" => {
                serde_json::from_value::<ProgressParams>(params).ok().map(|p| RunEvent::Progress {
                    message: p.message.chars().take(300).collect(),
                    fraction: p.fraction.filter(|f| f.is_finite()).map(|f| f.clamp(0.0, 1.0)),
                })
            }
            _ => None,
        };
        if let Some(event) = event {
            let _ = self.events.send(event);
        }
    }
}

fn request(id: i64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

/// Read stdout on a thread of its own, one bounded line at a time.
fn read_messages(child: &mut Child) -> Receiver<Incoming> {
    let (tx, rx) = mpsc::channel();
    let Some(stdout) = child.stdout.take() else {
        let _ = tx.send(Incoming::End(None));
        return rx;
    };
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match (&mut reader).take(MAX_MESSAGE as u64 + 1).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(Incoming::End(None));
                    return;
                }
                Ok(_) if line.len() > MAX_MESSAGE => {
                    let _ = tx.send(Incoming::End(Some(
                        "The plugin sent a message larger than 8 MiB.".into(),
                    )));
                    return;
                }
                Ok(_) => {}
            }
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let message = match serde_json::from_slice::<Value>(&line) {
                Ok(value) if value.is_object() => Incoming::Message(value),
                _ => Incoming::End(Some("The plugin wrote something other than JSON-RPC to stdout; log with the `log` notification or stderr.".into())),
            };
            let end = matches!(message, Incoming::End(_));
            if tx.send(message).is_err() || end {
                return;
            }
        }
    });
    rx
}

fn capture_stderr(child: &mut Child) -> Arc<Mutex<Vec<u8>>> {
    let kept = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let sink = kept.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(n) = stderr.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                if let Ok(mut kept) = sink.lock() {
                    let room = MAX_STDERR.saturating_sub(kept.len());
                    kept.extend_from_slice(&buffer[..n.min(room)]);
                }
            }
        });
    }
    kept
}

/// Give the plugin a moment to exit after stdin closes, then end its group.
fn finish(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_millis(300);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    crate::sidecar::terminate_process_group(child);
}

fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    lines[lines.len().saturating_sub(12)..].join("\n")
}
