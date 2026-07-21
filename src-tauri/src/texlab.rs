use crate::commands;
use crate::models::{Diagnostic, TexlabCompletionItem, TexlabHover, TexlabLocation};
use crate::project;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::time::{Duration, Instant};

const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_millis(2500);
const CHANGE_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_millis(1800);
const FEATURE_TIMEOUT: Duration = Duration::from_millis(1200);

#[derive(Default)]
pub struct TexlabPool {
    live: Option<LiveTexlab>,
}

struct LiveTexlab {
    root: PathBuf,
    session: TexlabSession,
    open_relative: String,
    open_uri: String,
    version: i32,
}

impl TexlabPool {
    pub fn reset(&mut self) {
        if let Some(mut live) = self.live.take() {
            live.session.shutdown();
        }
    }

    pub fn diagnostics(
        &mut self,
        root: &Path,
        relative_path: &str,
        text: &str,
    ) -> Result<Vec<Diagnostic>, String> {
        if !commands::available("texlab") {
            return Ok(Vec::new());
        }
        let relative = relative_path.trim().replace('\\', "/");
        if relative.is_empty() || !relative.ends_with(".tex") {
            return Ok(Vec::new());
        }
        let absolute = project::safe_path(root, &relative)?;
        let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if self
            .live
            .as_ref()
            .is_some_and(|live| live.root != root_canon)
        {
            self.reset();
        }
        if self.live.is_none() {
            let mut session = TexlabSession::spawn(root)?;
            session.initialize(root)?;
            self.live = Some(LiveTexlab {
                root: root_canon,
                session,
                open_relative: String::new(),
                open_uri: String::new(),
                version: 0,
            });
        }
        let live = self.live.as_mut().ok_or_else(|| "TexLab session missing.".to_string())?;
        match live.publish_for(&absolute, &relative, text) {
            Ok(items) => Ok(items),
            Err(error) => {
                // Recover from a dead process by cold-starting once.
                self.reset();
                let mut session = TexlabSession::spawn(root)?;
                let result = session.collect_diagnostics(root, &absolute, &relative, text);
                session.shutdown();
                result.map_err(|_| error)
            }
        }
    }

    pub fn completion(
        &mut self,
        root: &Path,
        relative_path: &str,
        text: &str,
        line: u32,
        character: u32,
    ) -> Result<Vec<TexlabCompletionItem>, String> {
        self.with_synced_document(root, relative_path, text, |live, file_uri| {
            let id = live.session.request(
                "textDocument/completion",
                json!({
                    "textDocument": { "uri": file_uri },
                    "position": {
                        "line": line.saturating_sub(1),
                        "character": character.saturating_sub(1)
                    }
                }),
            )?;
            let response = live.session.wait_for_response(id, FEATURE_TIMEOUT)?;
            Ok(map_completions(response.get("result")))
        })
    }

    pub fn hover(
        &mut self,
        root: &Path,
        relative_path: &str,
        text: &str,
        line: u32,
        character: u32,
    ) -> Result<Option<TexlabHover>, String> {
        self.with_synced_document(root, relative_path, text, |live, file_uri| {
            let id = live.session.request(
                "textDocument/hover",
                json!({
                    "textDocument": { "uri": file_uri },
                    "position": {
                        "line": line.saturating_sub(1),
                        "character": character.saturating_sub(1)
                    }
                }),
            )?;
            let response = live.session.wait_for_response(id, FEATURE_TIMEOUT)?;
            Ok(map_hover(response.get("result")))
        })
    }

    pub fn definition(
        &mut self,
        root: &Path,
        relative_path: &str,
        text: &str,
        line: u32,
        character: u32,
    ) -> Result<Option<TexlabLocation>, String> {
        let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        self.with_synced_document(root, relative_path, text, |live, file_uri| {
            let id = live.session.request(
                "textDocument/definition",
                json!({
                    "textDocument": { "uri": file_uri },
                    "position": {
                        "line": line.saturating_sub(1),
                        "character": character.saturating_sub(1)
                    }
                }),
            )?;
            let response = live.session.wait_for_response(id, FEATURE_TIMEOUT)?;
            Ok(map_definition(response.get("result"), &root_canon))
        })
    }

    fn with_synced_document<T>(
        &mut self,
        root: &Path,
        relative_path: &str,
        text: &str,
        work: impl FnOnce(&mut LiveTexlab, &str) -> Result<T, String>,
    ) -> Result<T, String> {
        if !commands::available("texlab") {
            return Err("texlab is not installed.".to_string());
        }
        let relative = relative_path.trim().replace('\\', "/");
        if relative.is_empty() || !relative.ends_with(".tex") {
            return Err("TexLab features require a .tex file.".to_string());
        }
        let absolute = project::safe_path(root, &relative)?;
        let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if self
            .live
            .as_ref()
            .is_some_and(|live| live.root != root_canon)
        {
            self.reset();
        }
        if self.live.is_none() {
            let mut session = TexlabSession::spawn(root)?;
            session.initialize(root)?;
            self.live = Some(LiveTexlab {
                root: root_canon,
                session,
                open_relative: String::new(),
                open_uri: String::new(),
                version: 0,
            });
        }
        let live = self.live.as_mut().ok_or_else(|| "TexLab session missing.".to_string())?;
        let file_uri = live.sync_document(&absolute, &relative, text)?;
        work(live, &file_uri)
    }
}

/// One-shot diagnostics used by tests when a pooled session is unnecessary.
#[cfg(test)]
pub fn diagnostics(root: &Path, relative_path: &str, text: &str) -> Result<Vec<Diagnostic>, String> {
    let mut pool = TexlabPool::default();
    pool.diagnostics(root, relative_path, text)
}

struct TexlabSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl TexlabSession {
    fn spawn(root: &Path) -> Result<Self, String> {
        let mut command = commands::command("texlab");
        command
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start TexLab: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Could not open TexLab stdin.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Could not open TexLab stdout.".to_string())?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    fn initialize(&mut self, root: &Path) -> Result<(), String> {
        let root_uri = path_to_uri(root);
        let init_id = self.request(
            "initialize",
            json!({
                "processId": null,
                "rootUri": root_uri,
                "capabilities": {
                    "textDocument": {
                        "publishDiagnostics": {
                            "relatedInformation": false
                        }
                    },
                    "workspace": {
                        "workspaceFolders": false
                    }
                },
                "clientInfo": {
                    "name": "Lattice",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )?;
        self.wait_for_response(init_id, Duration::from_millis(1500))?;
        self.notify("initialized", json!({}))
    }

    fn collect_diagnostics(
        &mut self,
        root: &Path,
        absolute: &Path,
        relative: &str,
        text: &str,
    ) -> Result<Vec<Diagnostic>, String> {
        self.initialize(root)?;
        let file_uri = path_to_uri(absolute);
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": file_uri,
                    "languageId": "latex",
                    "version": 1,
                    "text": text
                }
            }),
        )?;
        self.wait_for_diagnostics(&file_uri, relative, DIAGNOSTIC_TIMEOUT)
    }

    fn wait_for_diagnostics(
        &mut self,
        file_uri: &str,
        relative: &str,
        timeout: Duration,
    ) -> Result<Vec<Diagnostic>, String> {
        let deadline = Instant::now() + timeout;
        let mut diagnostics = Vec::new();
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self.read_message_deadline(remaining) {
                Ok(message) => {
                    if let Some(items) = publish_diagnostics_for(&message, file_uri, relative) {
                        diagnostics = items;
                        break;
                    }
                    self.answer_server_request(&message)?;
                }
                Err(error) if error.contains("timed out") => break,
                Err(error) => return Err(error),
            }
        }
        Ok(diagnostics)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))?;
        Ok(id)
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
    }

    fn write_message(&mut self, value: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        write!(
            self.stdin,
            "Content-Length: {}\r\n\r\n",
            body.len()
        )
        .map_err(|error| format!("Could not write TexLab headers: {error}"))?;
        self.stdin
            .write_all(&body)
            .map_err(|error| format!("Could not write TexLab body: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("Could not flush TexLab stdin: {error}"))
    }

    fn wait_for_response(&mut self, id: u64, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let message = self.read_message_deadline(remaining)?;
            if message.get("id").and_then(|value| value.as_u64()) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(format!("TexLab initialize failed: {error}"));
                }
                return Ok(message);
            }
            self.answer_server_request(&message)?;
        }
        Err("TexLab timed out during initialize.".to_string())
    }

    fn answer_server_request(&mut self, message: &Value) -> Result<(), String> {
        let Some(id) = message.get("id") else {
            return Ok(());
        };
        if message.get("method").is_none() {
            return Ok(());
        }
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": null
        }))
    }

    fn read_message_deadline(&mut self, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err("TexLab read timed out.".to_string());
            }
            // BufReader doesn't support true timeouts; poll with short sleeps when buffer empty.
            if self.stdout.buffer().is_empty() {
                // Peek by attempting non-blocking isn't available on BufReader easily.
                // Use a short sleep then try reading headers; read_line blocks.
                // Prefer setting read timeout on the underlying file descriptor on Unix.
                #[cfg(unix)]
                {
                    use std::os::unix::io::AsRawFd;
                    let fd = self.stdout.get_ref().as_raw_fd();
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let mut timeval = libc::timeval {
                        tv_sec: remaining.as_secs() as libc::time_t,
                        tv_usec: remaining.subsec_micros() as libc::suseconds_t,
                    };
                    unsafe {
                        let mut set: libc::fd_set = std::mem::zeroed();
                        libc::FD_ZERO(&mut set);
                        libc::FD_SET(fd, &mut set);
                        let ready = libc::select(
                            fd + 1,
                            &mut set,
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                            &mut timeval,
                        );
                        if ready == 0 {
                            return Err("TexLab read timed out.".to_string());
                        }
                        if ready < 0 {
                            return Err("TexLab select failed.".to_string());
                        }
                    }
                }
                #[cfg(not(unix))]
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            return self.read_message();
        }
    }

    fn read_message(&mut self) -> Result<Value, String> {
        let mut content_length = None;
        loop {
            let mut line = String::new();
            let bytes = self
                .stdout
                .read_line(&mut line)
                .map_err(|error| format!("Could not read TexLab header: {error}"))?;
            if bytes == 0 {
                return Err("TexLab closed stdout.".to_string());
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            let lower = line.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("content-length:") {
                content_length = Some(
                    rest.trim()
                        .parse::<usize>()
                        .map_err(|_| format!("Invalid TexLab Content-Length: {}", rest.trim()))?,
                );
            }
        }
        let length = content_length.ok_or_else(|| "TexLab message missing Content-Length.".to_string())?;
        let mut body = vec![0u8; length];
        self.stdout
            .read_exact(&mut body)
            .map_err(|error| format!("Could not read TexLab body: {error}"))?;
        serde_json::from_slice(&body).map_err(|error| format!("Invalid TexLab JSON: {error}"))
    }

    fn shutdown(&mut self) {
        let _ = self.request("shutdown", Value::Null);
        let _ = self.notify("exit", Value::Null);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for TexlabSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl LiveTexlab {
    fn sync_document(
        &mut self,
        absolute: &Path,
        relative: &str,
        text: &str,
    ) -> Result<String, String> {
        let file_uri = path_to_uri(absolute);
        if self.open_relative == relative && !self.open_uri.is_empty() {
            self.version += 1;
            self.session.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": {
                        "uri": file_uri,
                        "version": self.version
                    },
                    "contentChanges": [{ "text": text }]
                }),
            )?;
            return Ok(file_uri);
        }
        if !self.open_uri.is_empty() && self.open_uri != file_uri {
            let _ = self.session.notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": self.open_uri } }),
            );
        }
        self.version = 1;
        self.open_relative = relative.to_string();
        self.open_uri = file_uri.clone();
        self.session.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": file_uri,
                    "languageId": "latex",
                    "version": self.version,
                    "text": text
                }
            }),
        )?;
        Ok(file_uri)
    }

    fn publish_for(
        &mut self,
        absolute: &Path,
        relative: &str,
        text: &str,
    ) -> Result<Vec<Diagnostic>, String> {
        let file_uri = self.sync_document(absolute, relative, text)?;
        let timeout = if self.version > 1 {
            CHANGE_DIAGNOSTIC_TIMEOUT
        } else {
            DIAGNOSTIC_TIMEOUT
        };
        self.session
            .wait_for_diagnostics(&file_uri, relative, timeout)
    }
}

fn path_to_uri(path: &Path) -> String {
    let absolute = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut uri = String::from("file://");
    for component in absolute.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(part) => {
                uri.push('/');
                uri.push_str(&encode_uri_component(&part.to_string_lossy()));
            }
            std::path::Component::Prefix(prefix) => {
                uri.push('/');
                uri.push_str(&encode_uri_component(&prefix.as_os_str().to_string_lossy()));
            }
            _ => {}
        }
    }
    if uri == "file://" {
        uri.push('/');
    }
    uri
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn publish_diagnostics_for(message: &Value, file_uri: &str, relative: &str) -> Option<Vec<Diagnostic>> {
    if message.get("method").and_then(|value| value.as_str()) != Some("textDocument/publishDiagnostics")
    {
        return None;
    }
    let params = message.get("params")?;
    let uri = params.get("uri").and_then(|value| value.as_str())?;
    if !uri_matches(uri, file_uri) {
        return None;
    }
    let items = params.get("diagnostics")?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| map_diagnostic(item, relative))
            .collect(),
    )
}

fn uri_matches(left: &str, right: &str) -> bool {
    left == right || left.eq_ignore_ascii_case(right)
}

fn map_completions(result: Option<&Value>) -> Vec<TexlabCompletionItem> {
    let Some(result) = result else {
        return Vec::new();
    };
    let items = if let Some(array) = result.as_array() {
        array.as_slice()
    } else if let Some(array) = result.get("items").and_then(|value| value.as_array()) {
        array.as_slice()
    } else {
        return Vec::new();
    };
    items.iter().filter_map(map_completion_item).take(80).collect()
}

fn map_completion_item(item: &Value) -> Option<TexlabCompletionItem> {
    let label = item.get("label")?.as_str()?.trim().to_string();
    if label.is_empty() {
        return None;
    }
    let insert_text = item
        .get("insertText")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let detail = item
        .get("detail")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let documentation = markup_to_string(item.get("documentation"));
    let kind = item
        .get("kind")
        .and_then(|value| value.as_u64())
        .map(completion_kind_name);
    Some(TexlabCompletionItem {
        label,
        detail,
        kind,
        insert_text,
        documentation,
    })
}

fn completion_kind_name(kind: u64) -> String {
    match kind {
        1 => "text",
        2 => "method",
        3 => "function",
        4 => "constructor",
        5 => "field",
        6 => "variable",
        7 => "class",
        8 => "interface",
        9 => "module",
        10 => "property",
        11 => "unit",
        12 => "value",
        13 => "enum",
        14 => "keyword",
        15 => "snippet",
        16 => "color",
        17 => "file",
        18 => "reference",
        19 => "folder",
        20 => "enumMember",
        21 => "constant",
        22 => "struct",
        23 => "event",
        24 => "operator",
        25 => "type",
        _ => "text",
    }
    .to_string()
}

fn map_hover(result: Option<&Value>) -> Option<TexlabHover> {
    let contents = markup_to_string(result?.get("contents"))?;
    if contents.trim().is_empty() {
        None
    } else {
        Some(TexlabHover { contents })
    }
}

fn map_definition(result: Option<&Value>, root: &Path) -> Option<TexlabLocation> {
    let result = result?;
    let location = if let Some(array) = result.as_array() {
        array.first()?
    } else {
        result
    };
    let uri = location
        .get("uri")
        .or_else(|| location.pointer("/targetUri"))
        .and_then(|value| value.as_str())?;
    let line = location
        .pointer("/range/start/line")
        .or_else(|| location.pointer("/targetRange/start/line"))
        .or_else(|| location.pointer("/targetSelectionRange/start/line"))
        .and_then(|value| value.as_u64())
        .map(|value| value as u32 + 1)?;
    let column = location
        .pointer("/range/start/character")
        .or_else(|| location.pointer("/targetRange/start/character"))
        .or_else(|| location.pointer("/targetSelectionRange/start/character"))
        .and_then(|value| value.as_u64())
        .map(|value| value as u32 + 1)
        .unwrap_or(1);
    let absolute = uri_to_path(uri)?;
    let path = absolute
        .strip_prefix(root)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .filter(|value| !value.is_empty())?;
    Some(TexlabLocation { path, line, column })
}

fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let stripped = uri.strip_prefix("file://")?;
    let decoded = percent_decode(stripped);
    Some(PathBuf::from(decoded))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            ) {
                out.push(((hi << 4) | lo) as u8 as char);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    out
}

fn markup_to_string(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return Some(text.trim().to_string());
    }
    if let Some(text) = value.get("value").and_then(|item| item.as_str()) {
        return Some(text.trim().to_string());
    }
    if let Some(array) = value.as_array() {
        let joined = array
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .or_else(|| item.get("value").and_then(|inner| inner.as_str()).map(str::to_string))
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let trimmed = joined.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    } else {
        None
    }
}

fn map_diagnostic(item: &Value, relative: &str) -> Option<Diagnostic> {
    let message = item.get("message")?.as_str()?.trim().to_string();
    if message.is_empty() {
        return None;
    }
    let severity = match item.get("severity").and_then(|value| value.as_u64()) {
        Some(1) => "error",
        Some(2) => "warning",
        Some(3) => "info",
        Some(4) => "info",
        _ => "warning",
    };
    let line = item
        .pointer("/range/start/line")
        .and_then(|value| value.as_u64())
        .map(|value| value as u32 + 1);
    let column = item
        .pointer("/range/start/character")
        .and_then(|value| value.as_u64())
        .map(|value| value as u32 + 1);
    let end_line = item
        .pointer("/range/end/line")
        .and_then(|value| value.as_u64())
        .map(|value| value as u32 + 1);
    let end_column = item
        .pointer("/range/end/character")
        .and_then(|value| value.as_u64())
        .map(|value| value as u32 + 1);
    Some(Diagnostic {
        file: Some(relative.replace('\\', "/")),
        line,
        column,
        end_line,
        end_column,
        level: severity.to_string(),
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_publish_diagnostics_payload() {
        let message = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": "file:///tmp/paper/main.tex",
                "diagnostics": [
                    {
                        "range": { "start": { "line": 3, "character": 0 }, "end": { "line": 3, "character": 5 } },
                        "severity": 1,
                        "message": "Undefined control sequence."
                    },
                    {
                        "range": { "start": { "line": 10, "character": 0 }, "end": { "line": 10, "character": 1 } },
                        "severity": 2,
                        "message": "Package natbib Warning: Citation undefined."
                    }
                ]
            }
        });
        let diagnostics = publish_diagnostics_for(&message, "file:///tmp/paper/main.tex", "main.tex").unwrap();
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].level, "error");
        assert_eq!(diagnostics[0].line, Some(4));
        assert_eq!(diagnostics[0].column, Some(1));
        assert_eq!(diagnostics[0].end_column, Some(6));
        assert_eq!(diagnostics[0].file.as_deref(), Some("main.tex"));
        assert_eq!(diagnostics[1].level, "warning");
    }

    #[test]
    fn encodes_file_uris() {
        let uri = path_to_uri(Path::new("/tmp/my paper/main.tex"));
        assert!(uri.starts_with("file:///"));
        assert!(uri.contains("my%20paper"));
        assert!(uri.ends_with("/main.tex"));
    }

    #[test]
    fn maps_completion_and_definition_payloads() {
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
        let parent = std::env::temp_dir().join(format!("lattice-texlab-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&parent);
        let root = crate::project::create(&parent, "paper").unwrap();
        let result = diagnostics(&root, "main.tex", "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n");
        assert!(result.is_ok());
        let _ = std::fs::remove_dir_all(parent);
    }
}
