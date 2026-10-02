//! A TexLab language server per project, for editor diagnostics, completion,
//! hover and go-to-definition.
//!
//! One live session serves the open project; it is (re)started on demand and
//! keeps a single document open, the one the editor last synced.

use crate::commands;
use crate::models::Diagnostic;
use crate::project;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const FEATURE_TIMEOUT: Duration = Duration::from_millis(1200);

/// LSP `CompletionItemKind` names, in kind order (kind 1 is `text`).
const COMPLETION_KINDS: &str = "text method function constructor field variable class interface \
    module property unit value enum keyword snippet color file reference folder enumMember \
    constant struct event operator type";

struct DiagnosticSubscription {
    uri: String,
    relative: String,
    publish: Box<dyn Fn(Vec<Diagnostic>) + Send>,
}

type Subscription = Arc<Mutex<Option<DiagnosticSubscription>>>;

#[derive(Default)]
pub struct TexlabPool {
    live: Option<Session>,
}

/// A project-relative `.tex` path, or `None` for anything TexLab should not see.
fn tex_path(relative_path: &str) -> Option<String> {
    let relative = relative_path.trim().replace('\\', "/");
    (!relative.is_empty() && relative.ends_with(".tex")).then_some(relative)
}

impl TexlabPool {
    pub fn reset(&mut self) {
        if let Some(mut live) = self.live.take() {
            live.shutdown();
        }
    }

    pub fn diagnostics(
        &mut self, root: &Path, relative_path: &str, text: &str,
        publish: impl Fn(Vec<Diagnostic>) + Send + 'static,
    ) -> Result<(), String> {
        let Some(relative) = tex_path(relative_path).filter(|_| commands::available("texlab"))
        else {
            publish(Vec::new());
            return Ok(());
        };
        let absolute = project::safe_path(root, &relative)?;
        let uri = path_to_uri(&absolute);
        let subscription =
            DiagnosticSubscription { uri, relative: relative.clone(), publish: Box::new(publish) };
        let live = self.live_for(root)?;
        live.subscribe(Some(subscription))?;
        if live.sync_document(&absolute, &relative, text).is_ok() {
            return Ok(());
        }
        // Recover from a dead process once, retaining the subscription so
        // subsequent background diagnostics still reach the editor.
        let subscription = live.subscribe(None)?;
        self.reset();
        let live = self.live_for(root)?;
        live.subscribe(subscription)?;
        let synced = live.sync_document(&absolute, &relative, text);
        if synced.is_err() {
            self.live = None;
        }
        synced.map(|_| ())
    }

    pub fn completion(
        &mut self, root: &Path, path: &str, text: &str, line: u32, character: u32,
    ) -> Result<Vec<TexlabCompletionItem>, String> {
        let result =
            self.request_at(root, path, text, "textDocument/completion", line, character)?;
        Ok(map_completions(result.as_ref()))
    }

    pub fn hover(
        &mut self, root: &Path, path: &str, text: &str, line: u32, character: u32,
    ) -> Result<Option<TexlabHover>, String> {
        let result = self.request_at(root, path, text, "textDocument/hover", line, character)?;
        Ok(map_hover(result.as_ref()))
    }

    pub fn definition(
        &mut self, root: &Path, path: &str, text: &str, line: u32, character: u32,
    ) -> Result<Option<TexlabLocation>, String> {
        let result =
            self.request_at(root, path, text, "textDocument/definition", line, character)?;
        Ok(map_definition(result.as_ref(), &canonical(root)))
    }

    /// Sync the document, then ask `method` about the 1-based
    /// `line`/`character` in it; the response's `result`.
    fn request_at(
        &mut self, root: &Path, relative_path: &str, text: &str, method: &str, line: u32,
        character: u32,
    ) -> Result<Option<Value>, String> {
        if !commands::available("texlab") {
            return Err("texlab is not installed.".to_string());
        }
        let relative = tex_path(relative_path)
            .ok_or_else(|| "TexLab features require a .tex file.".to_string())?;
        let absolute = project::safe_path(root, &relative)?;
        let live = self.live_for(root)?;
        let uri = live.sync_document(&absolute, &relative, text)?;
        let position =
            json!({ "line": line.saturating_sub(1), "character": character.saturating_sub(1) });
        let id =
            live.request(method, json!({ "textDocument": { "uri": uri }, "position": position }))?;
        Ok(live.wait_for_response(id, FEATURE_TIMEOUT)?.get_mut("result").map(Value::take))
    }

    /// The session for `root`, replacing one that serves another project.
    fn live_for(&mut self, root: &Path) -> Result<&mut Session, String> {
        let root_canon = canonical(root);
        if self.live.as_ref().is_some_and(|live| live.root != root_canon) {
            self.reset();
        }
        match self.live {
            Some(ref mut live) => Ok(live),
            None => Ok(self.live.insert(Session::start(root, root_canon)?)),
        }
    }
}

fn canonical(root: &Path) -> PathBuf {
    root.canonicalize().unwrap_or_else(|_| root.to_path_buf())
}

/// A running TexLab for one project root, and the one document it has open.
struct Session {
    root: PathBuf,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    messages: mpsc::Receiver<Result<Value, String>>,
    subscription: Subscription,
    next_id: u64,
    open_relative: String,
    open_uri: String,
    version: i32,
}

impl Session {
    fn start(root: &Path, root_canon: PathBuf) -> Result<Self, String> {
        let mut command = commands::command("texlab");
        command
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = commands::in_new_process_group(&mut command)
            .spawn()
            .map_err(|error| format!("Could not start TexLab: {error}"))?;
        let stdin = child.stdin.take().ok_or_else(|| "Could not open TexLab stdin.".to_string())?;
        let stdout =
            child.stdout.take().ok_or_else(|| "Could not open TexLab stdout.".to_string())?;
        let stdin = Arc::new(Mutex::new(stdin));
        let subscription = Subscription::default();
        let messages =
            read_messages(BufReader::new(stdout), Arc::clone(&stdin), Arc::clone(&subscription));
        let mut session = Self {
            root: root_canon,
            child,
            stdin,
            messages,
            subscription,
            next_id: 1,
            open_relative: String::new(),
            open_uri: String::new(),
            version: 0,
        };
        let init_id = session.request(
            "initialize",
            json!({
                "processId": null,
                "rootUri": path_to_uri(root),
                "capabilities": {
                    "textDocument": { "publishDiagnostics": { "relatedInformation": false } },
                    "workspace": { "workspaceFolders": false }
                },
                "clientInfo": { "name": "Lattice", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        session.wait_for_response(init_id, Duration::from_millis(1500))?;
        session.notify("initialized", json!({}))?;
        Ok(session)
    }

    /// Replace where published diagnostics go, returning the previous target.
    fn subscribe(
        &self, subscription: Option<DiagnosticSubscription>,
    ) -> Result<Option<DiagnosticSubscription>, String> {
        let mut guard = self.subscription.lock().map_err(|_| "TexLab subscription unavailable.")?;
        Ok(std::mem::replace(&mut *guard, subscription))
    }

    fn request(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;
        write_message(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )?;
        Ok(id)
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        write_message(&self.stdin, &json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn wait_for_response(&mut self, id: u64, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let message =
                self.messages.recv_timeout(remaining).map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => "TexLab read timed out.".to_string(),
                    mpsc::RecvTimeoutError::Disconnected => "TexLab closed stdout.".to_string(),
                })??;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(format!("TexLab initialize failed: {error}"));
                }
                return Ok(message);
            }
        }
        Err("TexLab timed out during initialize.".to_string())
    }

    fn sync_document(
        &mut self, absolute: &Path, relative: &str, text: &str,
    ) -> Result<String, String> {
        let file_uri = path_to_uri(absolute);
        if self.open_relative == relative && !self.open_uri.is_empty() {
            self.version += 1;
            let document = json!({ "uri": file_uri, "version": self.version });
            let change = json!({ "textDocument": document, "contentChanges": [{ "text": text }] });
            self.notify("textDocument/didChange", change)?;
            return Ok(file_uri);
        }
        if !self.open_uri.is_empty() && self.open_uri != file_uri {
            let close = json!({ "textDocument": { "uri": self.open_uri } });
            let _ = self.notify("textDocument/didClose", close);
        }
        self.version = 1;
        self.open_relative = relative.to_string();
        self.open_uri = file_uri.clone();
        let document = json!({
            "uri": file_uri, "languageId": "latex", "version": self.version, "text": text
        });
        self.notify("textDocument/didOpen", json!({ "textDocument": document }))?;
        Ok(file_uri)
    }

    fn shutdown(&mut self) {
        let _ = self.request("shutdown", Value::Null);
        let _ = self.notify("exit", Value::Null);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// TexLab publishes unversioned diagnostics, including updates long after a
// didChange (filesystem/build-log and ChkTeX results). Always consume them,
// even while idle or waiting for completion/hover responses. A single reader
// also makes request timeouts independent of partial JSON-RPC frames.
fn read_messages(
    mut stdout: impl BufRead + Send + 'static, stdin: Arc<Mutex<impl Write + Send + 'static>>,
    subscription: Subscription,
) -> mpsc::Receiver<Result<Value, String>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || loop {
        let message = read_message(&mut stdout);
        if let Ok(value) = &message {
            if value.get("method").and_then(Value::as_str)
                == Some("textDocument/publishDiagnostics")
            {
                if let Some(target) = subscription.lock().ok().as_deref().and_then(Option::as_ref) {
                    if let Some(items) =
                        publish_diagnostics_for(value, &target.uri, &target.relative)
                    {
                        (target.publish)(items);
                    }
                }
                continue;
            }
            // Unhandled notifications must not accumulate while the app is idle.
            if value.get("id").is_none() {
                continue;
            }
            if value.get("method").is_some() {
                // Answer server requests even when no feature call is waiting.
                let reply = json!({ "jsonrpc": "2.0", "id": value["id"], "result": null });
                if let Err(error) = write_message(&stdin, &reply) {
                    let _ = sender.send(Err(error));
                    break;
                }
                continue;
            }
        }
        let failed = message.is_err();
        if sender.send(message).is_err() || failed {
            break;
        }
    });
    receiver
}

fn write_message(stdin: &Mutex<impl Write>, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let mut stdin = stdin.lock().map_err(|_| "TexLab stdin unavailable.")?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len())
        .map_err(|error| format!("Could not write TexLab headers: {error}"))?;
    stdin.write_all(&body).map_err(|error| format!("Could not write TexLab body: {error}"))?;
    stdin.flush().map_err(|error| format!("Could not flush TexLab stdin: {error}"))
}

fn read_message(stdout: &mut impl BufRead) -> Result<Value, String> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let bytes = stdout
            .read_line(&mut line)
            .map_err(|error| format!("Could not read TexLab header: {error}"))?;
        if bytes == 0 {
            return Err("TexLab closed stdout.".to_string());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            let rest = rest.trim();
            let length = rest.parse::<usize>();
            content_length =
                Some(length.map_err(|_| format!("Invalid TexLab Content-Length: {rest}"))?);
        }
    }
    let length =
        content_length.ok_or_else(|| "TexLab message missing Content-Length.".to_string())?;
    let mut body = vec![0u8; length];
    stdout.read_exact(&mut body).map_err(|error| format!("Could not read TexLab body: {error}"))?;
    serde_json::from_slice(&body).map_err(|error| format!("Invalid TexLab JSON: {error}"))
}

fn path_to_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for component in canonical(path).components() {
        if matches!(component, Component::Normal(_) | Component::Prefix(_)) {
            uri.push('/');
            uri.push_str(&crate::util::url_encode(&component.as_os_str().to_string_lossy()));
        }
    }
    if uri == "file://" {
        uri.push('/');
    }
    uri
}

fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let bytes = uri.strip_prefix("file://")?.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = |offset: usize| (bytes[index + offset] as char).to_digit(16);
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(1), hex(2)) {
                out.push(((hi << 4) | lo) as u8 as char);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    Some(PathBuf::from(out))
}

/// The diagnostics a `textDocument/publishDiagnostics` notification carries
/// for `file_uri`.
fn publish_diagnostics_for(
    message: &Value, file_uri: &str, relative: &str,
) -> Option<Vec<Diagnostic>> {
    let params = message.get("params")?;
    let uri = params.get("uri").and_then(Value::as_str)?;
    if !uri.eq_ignore_ascii_case(file_uri) {
        return None;
    }
    let items = params.get("diagnostics")?.as_array()?;
    Some(items.iter().filter_map(|item| map_diagnostic(item, relative)).collect())
}

/// A string field, trimmed, when it has any text.
fn text_field(item: &Value, key: &str) -> Option<String> {
    let text = item.get(key)?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// A 0-based LSP position number at `pointer`, as the 1-based one the UI uses.
fn one_based(item: &Value, pointer: &str) -> Option<u32> {
    item.pointer(pointer)?.as_u64().map(|value| value as u32 + 1)
}

fn map_completions(result: Option<&Value>) -> Vec<TexlabCompletionItem> {
    let items =
        result.and_then(|result| result.as_array().or_else(|| result.get("items")?.as_array()));
    items.into_iter().flatten().filter_map(map_completion_item).take(80).collect()
}

fn map_completion_item(item: &Value) -> Option<TexlabCompletionItem> {
    let label = item.get("label")?.as_str()?.trim().to_string();
    if label.is_empty() {
        return None;
    }
    let kind = item.get("kind").and_then(Value::as_u64).map(|kind| {
        let name = kind.checked_sub(1).and_then(|index| {
            COMPLETION_KINDS.split_whitespace().nth(usize::try_from(index).ok()?)
        });
        name.unwrap_or("text").to_string()
    });
    Some(TexlabCompletionItem {
        label,
        detail: text_field(item, "detail"),
        kind,
        insert_text: text_field(item, "insertText"),
        documentation: markup_to_string(item.get("documentation")),
    })
}

fn map_hover(result: Option<&Value>) -> Option<TexlabHover> {
    let contents = markup_to_string(result?.get("contents"))?;
    (!contents.trim().is_empty()).then_some(TexlabHover { contents })
}

fn map_definition(result: Option<&Value>, root: &Path) -> Option<TexlabLocation> {
    let result = result?;
    let location = if let Some(array) = result.as_array() { array.first()? } else { result };
    let uri = location.get("uri").or_else(|| location.get("targetUri")).and_then(Value::as_str)?;
    // A Location has `range`; a LocationLink has `targetRange` and
    // `targetSelectionRange`. The first one present wins.
    let start = |field: &str| {
        ["/range/start/", "/targetRange/start/", "/targetSelectionRange/start/"]
            .iter()
            .find_map(|prefix| location.pointer(&format!("{prefix}{field}")))
            .and_then(Value::as_u64)
            .map(|value| value as u32 + 1)
    };
    let line = start("line")?;
    let column = start("character").unwrap_or(1);
    let path = uri_to_path(uri)?
        .strip_prefix(root)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .filter(|value| !value.is_empty())?;
    Some(TexlabLocation { path, line, column })
}

/// LSP markup: a string, a `MarkupContent`, or an array of `MarkedString`s.
fn markup_to_string(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let text =
        |item: &Value| item.as_str().or_else(|| item.get("value")?.as_str()).map(str::to_string);
    if let Some(text) = text(value) {
        return Some(text.trim().to_string());
    }
    let joined = value.as_array()?.iter().filter_map(text).collect::<Vec<_>>().join("\n\n");
    let trimmed = joined.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn map_diagnostic(item: &Value, relative: &str) -> Option<Diagnostic> {
    let message = item.get("message")?.as_str()?.trim().to_string();
    if message.is_empty() || crate::latex::is_pass_noise_warning(&message) {
        return None;
    }
    // texlab reports its lints (unused label, unused BibTeX entry, …) at
    // Information/Hint severity. Surfacing those as "info" draws CodeMirror's
    // blue-grey square in the gutter; they read as warnings to the user, so
    // keep the yellow-triangle warning marker for anything short of an error.
    let error = item.get("severity").and_then(Value::as_u64) == Some(1);
    Some(Diagnostic {
        file: Some(relative.replace('\\', "/")),
        line: one_based(item, "/range/start/line"),
        column: one_based(item, "/range/start/character"),
        end_line: one_based(item, "/range/end/line"),
        end_column: one_based(item, "/range/end/character"),
        level: if error { "error" } else { "warning" }.to_string(),
        message,
        code: None,
        params: Default::default(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexlabCompletionItem {
    pub label: String,
    pub detail: Option<String>,
    pub kind: Option<String>,
    pub insert_text: Option<String>,
    pub documentation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexlabHover {
    pub contents: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexlabLocation {
    pub path: String,
    pub line: u32,
    pub column: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_publication_clears_stale_diagnostics() {
        let uri = "file:///tmp/paper/main.tex";
        let messages = [
            json!({"method": "textDocument/publishDiagnostics", "params": {
                "uri": uri, "diagnostics": [{"message": "Undefined reference `fixed'."}]
            }}),
            json!({"id": 9, "result": {"contents": "hover text"}}),
            json!({"id": "server-request", "method": "workspace/configuration", "params": {"items": []}}),
            json!({"method": "textDocument/publishDiagnostics", "params": {
                "uri": "file:///tmp/paper/other.tex", "diagnostics": [{"message": "Other file warning"}]
            }}),
            json!({"method": "textDocument/publishDiagnostics", "params": {
                "uri": uri, "diagnostics": []
            }}),
        ];
        let wire = messages
            .iter()
            .map(|message| {
                let body = message.to_string();
                format!("Content-Length: {}\r\n\r\n{}", body.len(), body)
            })
            .collect::<String>();
        let (sender, updates) = mpsc::channel();
        let subscription = Arc::new(Mutex::new(Some(DiagnosticSubscription {
            uri: uri.to_string(),
            relative: "main.tex".to_string(),
            publish: Box::new(move |items| {
                sender.send(items).unwrap();
            }),
        })));
        let stdin = Arc::new(Mutex::new(Vec::new()));
        let responses = read_messages(
            std::io::Cursor::new(wire.into_bytes()),
            Arc::clone(&stdin),
            subscription,
        );
        let first = updates.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first[0].message, "Undefined reference `fixed'.");
        // No further client request is needed to receive the correction, and
        // an interleaved hover response must not swallow either publication.
        assert!(updates.recv_timeout(Duration::from_secs(2)).unwrap().is_empty());
        assert!(updates.try_recv().is_err());
        let reply = read_message(&mut std::io::Cursor::new(stdin.lock().unwrap().clone())).unwrap();
        assert_eq!(reply, json!({"jsonrpc": "2.0", "id": "server-request", "result": null}));
        assert_eq!(responses.recv_timeout(Duration::from_secs(2)).unwrap().unwrap()["id"], 9);
    }

    #[test]
    fn maps_publish_diagnostics_payload() {
        let item = |line: u32, end: u32, severity: u32, message: &str| {
            json!({
                "range": { "start": { "line": line, "character": 0 }, "end": { "line": line, "character": end } },
                "severity": severity,
                "message": message
            })
        };
        let message = json!({ "params": {
            "uri": "file:///tmp/paper/main.tex",
            "diagnostics": [
                item(3, 5, 1, "Undefined control sequence."),
                item(10, 1, 2, "Package natbib Warning: Citation undefined."),
                item(12, 8, 4, "Unused label 'fig:native-umm'."),
                item(0, 1, 2, "Package epstopdf Warning: Shell escape feature is not enabled."),
            ]
        }});
        let diagnostics =
            publish_diagnostics_for(&message, "file:///tmp/paper/main.tex", "main.tex").unwrap();
        assert!(diagnostics.iter().all(|item| item.file.as_deref() == Some("main.tex")));
        // Positions become 1-based; the pass-noise warning is dropped, and a
        // Hint-severity lint (unused label) surfaces as a warning, not info.
        let summary = diagnostics
            .iter()
            .map(|item| (item.level.as_str(), item.line, item.column, item.end_column))
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                ("error", Some(4), Some(1), Some(6)),
                ("warning", Some(11), Some(1), Some(2)),
                ("warning", Some(13), Some(1), Some(9)),
            ]
        );
    }

    #[test]
    fn maps_uris_completion_and_definition_payloads() {
        let uri = path_to_uri(Path::new("/tmp/my paper/main.tex"));
        assert!(uri.starts_with("file:///") && uri.ends_with("/my%20paper/main.tex"), "{uri}");

        let completions = map_completions(Some(&json!([
            {
                "label": "\\usepackage",
                "kind": 14,
                "detail": "latex",
                "insertText": "\\usepackage{$0}",
                "documentation": { "value": "Load a package" }
            }
        ])));
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].label, "\\usepackage");
        assert_eq!(completions[0].kind.as_deref(), Some("keyword"));
        assert_eq!(completions[0].documentation.as_deref(), Some("Load a package"));

        let hover = map_hover(Some(&json!({
            "contents": { "kind": "markdown", "value": "Package amsmath" }
        })));
        assert_eq!(hover.unwrap().contents, "Package amsmath");

        let location = map_definition(
            Some(&json!({
                "uri": "file:///tmp/paper/sections/intro.tex",
                "range": { "start": { "line": 4, "character": 0 }, "end": { "line": 4, "character": 1 } }
            })),
            Path::new("/tmp/paper"),
        )
        .unwrap();
        assert_eq!(location.path, "sections/intro.tex");
        assert_eq!(location.line, 5);
    }

    #[test]
    fn returns_empty_when_texlab_missing() {
        // If texlab is installed locally this still returns Ok; only asserts API shape.
        let parent = crate::test_support::TempDir::new("texlab");
        let root = crate::project::create(&parent, "paper").unwrap();
        let mut pool = TexlabPool::default();
        let result = pool.diagnostics(
            &root,
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n",
            |_| {},
        );
        assert!(result.is_ok());
        pool.reset();
    }

    #[test]
    #[ignore = "requires an installed TexLab and filesystem watcher"]
    fn real_texlab_updates_source_and_build_log_while_idle() {
        let root = crate::test_support::TempDir::new("texlab-live");
        let text =
            "\\documentclass{article}\n\\begin{document}\nSee \\ref{fixed}.\n\\end{document}\n";
        root.write("main.tex", text);
        root.write("main.log", "");
        let (sender, updates) = mpsc::channel();
        let mut pool = TexlabPool::default();
        let publish = sender.clone();
        pool.diagnostics(&root, "main.tex", text, move |items| {
            let _ = publish.send(items);
        })
        .unwrap();
        let await_diagnostics = |matches: &dyn Fn(&[Diagnostic]) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let items = updates
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("TexLab did not publish the expected update");
                eprintln!(
                    "TexLab: {:?}",
                    items.iter().map(|item| &item.message).collect::<Vec<_>>()
                );
                if matches(&items) {
                    break;
                }
            }
        };
        await_diagnostics(&|items| {
            items.iter().any(|item| item.message.to_lowercase().contains("undefined reference"))
        });
        let fixed = text.replace("See", "\\label{fixed} See");
        root.write("main.tex", &fixed);
        pool.diagnostics(&root, "main.tex", &fixed, move |items| {
            let _ = sender.send(items);
        })
        .unwrap();
        await_diagnostics(&|items| items.is_empty());
        // A build can finish long after the last edit. No IPC sync is made
        // below: both the new log error and its removal must arrive as pushes.
        root.write("main.log", "(./main.tex\n! Undefined control sequence.\nl.3 \\badcommand\n)\n");
        await_diagnostics(&|items| {
            items.iter().any(|item| item.message.contains("Undefined control sequence"))
        });
        root.write("main.log", "");
        await_diagnostics(&|items| items.is_empty());
        pool.reset();
    }
}
