//! Test connection: one streamed request offering one tool, sent the way Pi
//! sends it, so a pass means the agent can work through this endpoint. Each
//! step the request reaches is a check the pane ticks; the first failure is
//! named as a `Problem` the pane words itself, with the server's own message
//! (key removed) as detail.

use super::Protocol;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::time::Duration;

/// A reasoning model may think before it calls the tool.
const TIMEOUT: Duration = Duration::from_secs(45);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// Generous enough for a long reasoning preamble before the tool call.
const MAX_STREAM: u64 = 4 * 1024 * 1024;
const MAX_ERROR_BODY: u64 = 64 * 1024;
const MAX_DETAIL: usize = 300;
const TOOL: &str = "report_status";
const PROMPT: &str =
    "This is a connection test. Call the report_status tool with ok set to true. Do not write any text.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Check {
    Reach,
    Key,
    Model,
    Stream,
    Tools,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    Unreachable,
    Timeout,
    WrongAddress,
    KeyRejected,
    ModelNotFound,
    RateLimited,
    ServerError,
    Refused,
    ToolsRejected,
    NoStream,
    NoToolCall,
    BadResponse,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    passed: Vec<Check>,
    problem: Option<Problem>,
    status: Option<u16>,
    detail: Option<String>,
}

impl ProbeReport {
    fn failed(
        passed: &[Check], problem: Problem, status: Option<u16>, detail: Option<String>,
    ) -> Self {
        Self { passed: passed.to_vec(), problem: Some(problem), status, detail }
    }
}

fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": { "ok": { "type": "boolean", "description": "Always true." } },
        "required": ["ok"],
    })
}

/// The request URL and body Pi's SDK for `protocol` would send.
fn request(protocol: Protocol, base_url: &str, model: &str) -> (String, Value) {
    let description = "Report that the connection works.";
    match protocol {
        Protocol::OpenAiCompletions => (
            format!("{base_url}/chat/completions"),
            json!({
                "model": model,
                "stream": true,
                "messages": [{ "role": "user", "content": PROMPT }],
                "tools": [{ "type": "function", "function": {
                    "name": TOOL, "description": description, "parameters": parameters(),
                }}],
            }),
        ),
        Protocol::OpenAiResponses => (
            format!("{base_url}/responses"),
            json!({
                "model": model,
                "stream": true,
                "input": PROMPT,
                "tools": [{
                    "type": "function", "name": TOOL, "description": description,
                    "parameters": parameters(),
                }],
            }),
        ),
        Protocol::AnthropicMessages => (
            format!("{base_url}/v1/messages"),
            json!({
                "model": model,
                "stream": true,
                "max_tokens": 1024,
                "messages": [{ "role": "user", "content": PROMPT }],
                "tools": [{ "name": TOOL, "description": description, "input_schema": parameters() }],
            }),
        ),
        Protocol::Google => (
            format!("{base_url}/models/{model}:streamGenerateContent?alt=sse"),
            json!({
                "contents": [{ "role": "user", "parts": [{ "text": PROMPT }] }],
                "tools": [{ "functionDeclarations": [{
                    "name": TOOL, "description": description, "parameters": parameters(),
                }]}],
            }),
        ),
    }
}

pub(super) fn run(
    protocol: Protocol, base_url: &str, model: &str, key: Option<&str>,
) -> ProbeReport {
    let mut client = crate::http::blocking(TIMEOUT).connect_timeout(CONNECT_TIMEOUT);
    if is_loopback(base_url) {
        // A local server (Ollama, LM Studio) is never reached through the
        // system proxy, which may not list it as an exception.
        client = client.no_proxy();
    }
    let client = match client.build() {
        Ok(client) => client,
        Err(_) => return ProbeReport::failed(&[], Problem::Unreachable, None, None),
    };
    let (url, body) = request(protocol, base_url, model);
    let mut builder = client.post(&url).header("accept", "text/event-stream").json(&body);
    if let Some(key) = key {
        builder = match protocol {
            Protocol::OpenAiCompletions | Protocol::OpenAiResponses => builder.bearer_auth(key),
            Protocol::AnthropicMessages => {
                builder.header("x-api-key", key).header("anthropic-version", "2023-06-01")
            }
            Protocol::Google => builder.header("x-goog-api-key", key),
        };
    } else if protocol == Protocol::AnthropicMessages {
        builder = builder.header("anthropic-version", "2023-06-01");
    }
    let response = match builder.send() {
        Ok(response) => response,
        Err(error) => {
            let problem = if error.is_timeout() { Problem::Timeout } else { Problem::Unreachable };
            return ProbeReport::failed(&[], problem, None, None);
        }
    };
    let status = response.status();
    if !status.is_success() {
        let mut text = String::new();
        let _ = response.take(MAX_ERROR_BODY).read_to_string(&mut text);
        return refused(status.as_u16(), &redacted(&error_message(&text), key));
    }
    let reached = [Check::Reach, Check::Key, Check::Model];
    let json_reply = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("json"));
    if json_reply {
        return ProbeReport::failed(&reached, Problem::NoStream, Some(status.as_u16()), None);
    }
    match read_stream(protocol, response) {
        Stream::ToolCall => ProbeReport {
            passed: vec![Check::Reach, Check::Key, Check::Model, Check::Stream, Check::Tools],
            problem: None,
            status: None,
            detail: None,
        },
        Stream::TextOnly => ProbeReport::failed(
            &[Check::Reach, Check::Key, Check::Model, Check::Stream],
            Problem::NoToolCall,
            None,
            None,
        ),
        Stream::Error(message) => {
            let detail = Some(redacted(&message, key)).filter(|detail| !detail.is_empty());
            let lower = message.to_lowercase();
            let problem = if lower.contains("tool") || lower.contains("function") {
                Problem::ToolsRejected
            } else {
                Problem::Refused
            };
            ProbeReport::failed(&reached, problem, None, detail)
        }
        Stream::Empty => ProbeReport::failed(&reached, Problem::BadResponse, None, None),
        Stream::TimedOut => ProbeReport::failed(&reached, Problem::Timeout, None, None),
    }
}

fn is_loopback(base_url: &str) -> bool {
    let url = reqwest::Url::parse(base_url).ok();
    let host = url.as_ref().and_then(reqwest::Url::host_str).unwrap_or_default();
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Names what a non-2xx reply means for the writer.
fn refused(status: u16, detail: &str) -> ProbeReport {
    let lower = detail.to_lowercase();
    let names_model = lower.contains("model");
    let names_tools = lower.contains("tool") || lower.contains("function");
    let (passed, problem): (&[Check], Problem) = match status {
        401 | 403 => (&[Check::Reach], Problem::KeyRejected),
        404 if names_model => (&[Check::Reach, Check::Key], Problem::ModelNotFound),
        404 | 405 => (&[Check::Reach], Problem::WrongAddress),
        400 | 422 if names_tools => {
            (&[Check::Reach, Check::Key, Check::Model], Problem::ToolsRejected)
        }
        400 | 422 if names_model => (&[Check::Reach, Check::Key], Problem::ModelNotFound),
        429 => (&[Check::Reach, Check::Key], Problem::RateLimited),
        500..=599 => (&[Check::Reach], Problem::ServerError),
        _ => (&[Check::Reach], Problem::Refused),
    };
    ProbeReport::failed(
        passed,
        problem,
        Some(status),
        Some(detail.to_string()).filter(|d| !d.is_empty()),
    )
}

#[derive(Debug, PartialEq, Eq)]
enum Stream {
    ToolCall,
    TextOnly,
    Error(String),
    Empty,
    TimedOut,
}

/// Reads server-sent events until a tool call, an error or the end.
fn read_stream(protocol: Protocol, body: impl Read) -> Stream {
    let mut event = String::new();
    let mut saw_data = false;
    for line in BufReader::new(body.take(MAX_STREAM)).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => return Stream::TimedOut,
            Err(_) if saw_data => return Stream::TextOnly,
            Err(_) => return Stream::Empty,
        };
        if let Some(name) = line.strip_prefix("event:") {
            event = name.trim().to_string();
            continue;
        }
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else { continue };
        saw_data = true;
        if event == "error" || value.get("error").is_some_and(|error| !error.is_null()) {
            return Stream::Error(error_message(data));
        }
        if calls_tool(protocol, &event, &value) {
            return Stream::ToolCall;
        }
        if value.get("type").and_then(Value::as_str) == Some("response.failed") {
            let message = value.pointer("/response/error/message").and_then(Value::as_str);
            return Stream::Error(message.unwrap_or_default().to_string());
        }
    }
    if saw_data {
        Stream::TextOnly
    } else {
        Stream::Empty
    }
}

fn calls_tool(protocol: Protocol, event: &str, value: &Value) -> bool {
    match protocol {
        Protocol::OpenAiCompletions => value
            .pointer("/choices/0/delta/tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty()),
        Protocol::OpenAiResponses => {
            value.pointer("/item/type").and_then(Value::as_str) == Some("function_call")
        }
        Protocol::AnthropicMessages => {
            (event.is_empty() || event == "content_block_start")
                && value.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use")
        }
        Protocol::Google => value
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
            .is_some_and(|parts| parts.iter().any(|part| part.get("functionCall").is_some())),
    }
}

/// The message in an error reply, in the shapes the common servers use.
fn error_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        for pointer in ["/error/message", "/message", "/error", "/detail", "/0/error/message"] {
            if let Some(text) = value.pointer(pointer).and_then(Value::as_str) {
                return text.to_string();
            }
        }
    }
    body.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default().to_string()
}

/// `text` without the key, short enough to show.
fn redacted(text: &str, key: Option<&str>) -> String {
    let text = match key.filter(|key| key.len() >= 4) {
        Some(key) => text.replace(key, "••••"),
        None => text.to_string(),
    };
    let mut short: String = text.chars().take(MAX_DETAIL).collect();
    if short.len() < text.len() {
        short.push('…');
    }
    short
}

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;
