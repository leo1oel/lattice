//! Socket.IO 0.9 framing, the handshake body, and the payloads Lattice emits.
//! Pure functions only; the connection itself lives in `client`.

use serde::Serialize;
use serde_json::Value;

pub(super) const FRAME_DISCONNECT: u8 = 0;
pub(super) const FRAME_CONNECT: u8 = 1;
pub(super) const FRAME_HEARTBEAT: u8 = 2;
pub(super) const FRAME_EVENT: u8 = 5;
pub(super) const FRAME_ACK: u8 = 6;
pub(super) const FRAME_ERROR: u8 = 7;
pub(super) const FRAME_NOOP: u8 = 8;

/// One decoded Socket.IO 0.9 frame. `id` is kept verbatim because an event that
/// requests an ack carries `"{id}+"` there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Frame {
    pub kind: u8,
    pub id: String,
    pub endpoint: String,
    pub data: String,
}

/// `{type}:{id}:{endpoint}:{data}`, with the last separator dropped when there
/// is no payload so heartbeats encode as `2::` exactly like the JS client.
pub(super) fn encode_frame(kind: u8, id: &str, endpoint: &str, data: &str) -> String {
    if data.is_empty() {
        format!("{kind}:{id}:{endpoint}")
    } else {
        format!("{kind}:{id}:{endpoint}:{data}")
    }
}

/// Inverse of [`encode_frame`]. Everything after the third colon is payload, so
/// JSON containing colons survives untouched. Never panics: malformed input
/// comes back as `Err`.
pub(super) fn parse_frame(raw: &str) -> Result<Frame, String> {
    let mut parts = raw.splitn(4, ':');
    let kind_text = parts.next().unwrap_or("");
    let id =
        parts.next().ok_or_else(|| format!("socket.io frame is missing its id field: {raw:?}"))?;
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
    Ok(Frame { kind, id: id.to_string(), endpoint: endpoint.to_string(), data: data.to_string() })
}

/// Splits an ack payload (`"{id}+{json_array}"`, or a bare `"{id}"`) into the
/// ack id and its arguments.
pub(super) fn parse_ack(data: &str) -> Result<(u32, Vec<Value>), String> {
    let (id_text, args_text) = data.split_once('+').unwrap_or((data, ""));
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
pub(super) fn parse_event(data: &str) -> Result<(String, Vec<Value>), String> {
    let parsed: Value = serde_json::from_str(data)
        .map_err(|e| format!("socket.io event payload is not JSON ({e}): {data:?}"))?;
    let name = parsed
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("socket.io event has no name: {data:?}"))?
        .to_string();
    let args = parsed.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok((name, args))
}

/// Parses the plain-text handshake body `{sid}:{heartbeat}:{close}:{transports}`
/// into the session id and the heartbeat timeout in seconds (0 = none).
pub(super) fn parse_handshake(body: &str) -> Result<(String, u64), String> {
    let line = body.trim();
    let unexpected = || {
        let shown: String = line.chars().take(120).collect();
        format!("Overleaf returned an unexpected socket.io handshake: {shown:?}")
    };
    let fields: Vec<&str> = line.split(':').collect();
    if fields.len() < 3 {
        return Err(unexpected());
    }
    let sid = fields[0].trim();
    let looks_like_a_sid = !sid.is_empty()
        && sid.len() <= 128
        && sid.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
    if !looks_like_a_sid {
        return Err(unexpected());
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

/// Socket.IO callbacks are `(error, …payload)`. Overleaf is not perfectly
/// consistent about the leading error slot, so treat a null first argument as
/// "no error, payload follows", a string or `{message}` object as an error, and
/// anything else as the payload itself.
pub(super) fn ack_body<'a>(args: &'a [Value], what: &str) -> Result<&'a [Value], String> {
    let Some(first) = args.first() else {
        return Ok(args);
    };
    if let Some(message) = ack_error(first) {
        return Err(format!("Overleaf rejected {what}: {message}"));
    }
    Ok(if first.is_null() { &args[1..] } else { args })
}

fn ack_error(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        // A payload object (a project, a doc) is not an error even though some
        // of them do carry a `message` field somewhere deeper.
        Value::Object(map) if !map.contains_key("rootFolder") && !map.contains_key("lines") => {
            ["message", "code"].iter().find_map(|key| map.get(*key)?.as_str()).map(str::to_string)
        }
        _ => None,
    }
}

/// The message in an error argument, whatever shape the server gave it.
pub(super) fn error_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(map) => map
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string()),
        other => other.to_string(),
    }
}

// ---- URLs -----------------------------------------------------------------

pub(super) fn normalize_origin(host: &str) -> Result<String, String> {
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

pub(super) fn ws_origin(origin: &str) -> String {
    if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        origin.to_string()
    }
}

pub(crate) use crate::util::url_encode;

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

pub(super) fn encode_event<A: Serialize>(name: &str, args: A) -> Result<String, String> {
    serde_json::to_string(&EventPayload { name, args })
        .map_err(|e| format!("Could not encode the {name} event: {e}"))
}

#[derive(Serialize)]
pub(super) struct JoinProjectArg<'a> {
    pub project_id: &'a str,
}

#[derive(Serialize)]
pub(super) struct JoinDocOptions {
    #[serde(rename = "encodeRanges")]
    pub encode_ranges: bool,
}

#[derive(Serialize)]
pub(super) struct CursorPosition<'a> {
    pub doc_id: &'a str,
    pub row: i64,
    pub column: i64,
}

/// What `applyOtUpdate` carries: the document, the operation, and the version
/// it applies to.
///
/// `meta` is only ever `tc`, which turns the update into a suggestion. Never
/// `source`: Overleaf stamps our own connection id on the way through, and
/// sending one gets the whole update rejected with `Unrecognized key:
/// "source"` — which once stopped every edit and quietly dropped us back to
/// syncing.
#[derive(Serialize)]
pub(super) struct Update<'a, Op: Serialize> {
    pub doc: &'a str,
    pub op: Vec<Op>,
    pub v: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<TrackedMeta<'a>>,
}

/// What makes an update tracked. `tc` is not a flag but the seed Overleaf mints
/// the change ids from, so it has to be fresh for every update — reusing one
/// mints duplicate ids.
#[derive(Serialize)]
pub(super) struct TrackedMeta<'a> {
    pub tc: &'a str,
}

/// A comment anchor on the wire: the commented text, where it starts, and the
/// thread it belongs to. Overleaf carries these alongside inserts and deletes.
#[derive(Serialize)]
pub(super) struct CommentOp<'a> {
    pub p: i64,
    pub c: &'a str,
    pub t: &'a str,
}
