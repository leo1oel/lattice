//! The bridge between an island's page and the host.
//!
//! The page side is `assets/bridge.js`, injected into the main frame before
//! the page's own scripts. Messages from the page arrive through Wry's IPC
//! as JSON ([`Inbound`]); the host answers by evaluating
//! `__latticeIsland.deliver(<json>)` in the page ([`Outbound::script`]).
//!
//! Only the island's own page may speak. WebKit gives every frame the IPC
//! handler, and a frame's URL proves nothing (an authored page's sandboxed
//! frame can navigate to an island URL), so each webview gets a random token
//! ([`new_token`]) that only the main frame's bootstrap knows ([`script`]):
//! the bootstrap keeps it in its closure and sends it with every message, and
//! a message without it, or from a frame not served by the island protocol,
//! is dropped ([`parse`]).

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{keys::PageKey, protocol};

/// A fresh token for one webview's bridge.
pub fn new_token() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| anyhow!("the bridge token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The bootstrap script, with the platform and the webview's token filled in.
pub fn script(token: &str) -> String {
    include_str!("../assets/bridge.js")
        .replace(
            "__LATTICE_PRIMARY_IS_META__",
            if cfg!(target_os = "macos") {
                "true"
            } else {
                "false"
            },
        )
        .replace(
            "__LATTICE_BRIDGE_TOKEN__",
            &serde_json::to_string(token).unwrap_or_default(),
        )
}

/// One message from the page.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Inbound {
    /// The page is listening.
    Ready,
    /// An event for the island's owner.
    Event {
        #[serde(rename = "type")]
        kind: String,
        #[serde(default)]
        payload: Value,
    },
    /// A request the owner (or the file bridge) answers with [`Outbound::Response`].
    Request {
        id: u64,
        #[serde(rename = "type")]
        kind: String,
        #[serde(default)]
        payload: Value,
    },
    /// Keyboard focus entered or left the page.
    Focus { focused: bool },
    /// One of the app's shortcuts, pressed in the page.
    Shortcut(PageKey),
    /// A press anywhere in the page.
    Pointerdown,
}

/// The URL of the frame that sent a message must be the island's own.
pub fn accepts_sender(uri: &str) -> bool {
    let origin = protocol::origin();
    uri.strip_prefix(&origin)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// Parse one IPC message, or say why it was dropped: it must come from a
/// frame served by the island protocol and carry the webview's `token`.
pub fn parse(sender: &str, token: &str, body: &str) -> Result<Inbound, String> {
    if !accepts_sender(sender) {
        return Err(format!("a message from {sender:?}, not the island's page"));
    }
    let mut message: Value =
        serde_json::from_str(body).map_err(|error| format!("{error}: {body:.200}"))?;
    let carried = message
        .as_object_mut()
        .and_then(|fields| fields.remove("token"));
    if carried.as_ref().and_then(Value::as_str) != Some(token) {
        return Err(format!(
            "a message from {sender:?} without the page's token"
        ));
    }
    serde_json::from_value(message).map_err(|error| format!("{error}: {body:.200}"))
}

/// One message to the page.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Outbound {
    Event {
        #[serde(rename = "type")]
        kind: String,
        payload: Value,
    },
    Response {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Value::is_null")]
        payload: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

impl Outbound {
    pub fn event(kind: impl Into<String>, payload: Value) -> Self {
        Self::Event {
            kind: kind.into(),
            payload,
        }
    }

    pub fn response(id: u64, result: Result<Value, String>) -> Self {
        match result {
            Ok(payload) => Self::Response {
                id,
                ok: true,
                payload,
                error: None,
            },
            Err(error) => Self::Response {
                id,
                ok: false,
                payload: Value::Null,
                error: Some(error),
            },
        }
    }

    /// The script that delivers this message in the page. JSON is a valid
    /// JavaScript expression, so the payload needs no further escaping (the
    /// line separators U+2028 and U+2029 that `serde_json` leaves raw are
    /// legal in string literals since ES2019).
    pub fn script(&self) -> String {
        let json = serde_json::to_string(self).unwrap_or_else(|_| "null".into());
        format!("window.__latticeIsland && window.__latticeIsland.deliver({json});")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn signed(body: Value) -> String {
        let mut body = body;
        body["token"] = json!(TOKEN);
        body.to_string()
    }

    #[test]
    fn only_the_island_page_may_speak() {
        let page = protocol::url("bundle/html-preview/index.html");
        assert!(accepts_sender(&page));
        assert!(!accepts_sender("about:srcdoc"));
        assert!(!accepts_sender("https://example.com/"));
        assert!(!accepts_sender(&format!("{}.evil/x", protocol::origin())));
        let ready = signed(json!({ "kind": "ready" }));
        assert!(parse("about:srcdoc", TOKEN, &ready).is_err());
        assert_eq!(parse(&page, TOKEN, &ready), Ok(Inbound::Ready));
    }

    #[test]
    fn a_frame_on_an_island_url_without_the_token_is_dropped() {
        // An authored frame that navigated to a granted asset has an island
        // URL, but not the main frame's token.
        let frame = protocol::asset_url("x.svg");
        let shortcut = json!({ "kind": "shortcut", "code": "KeyK", "meta": true });
        assert!(parse(&frame, TOKEN, &shortcut.to_string()).is_err());
        let mut forged = shortcut.clone();
        forged["token"] = json!("ffffffffffffffffffffffffffffffff");
        assert!(parse(&frame, TOKEN, &forged.to_string()).is_err());
        forged["token"] = json!(7);
        assert!(parse(&frame, TOKEN, &forged.to_string()).is_err());
        assert!(parse(&frame, TOKEN, "[]").is_err());
    }

    #[test]
    fn tokens_are_fresh_per_webview() {
        let first = new_token().unwrap();
        let second = new_token().unwrap();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn parses_each_message() {
        let page = protocol::url("bundle/x/index.html");
        let parse = |body: Value| parse(&page, TOKEN, &signed(body));
        assert_eq!(parse(json!({ "kind": "ready" })), Ok(Inbound::Ready));
        assert_eq!(
            parse(json!({ "kind": "event", "type": "html:scroll", "payload": { "scrollTop": 4 } })),
            Ok(Inbound::Event {
                kind: "html:scroll".into(),
                payload: json!({ "scrollTop": 4 })
            })
        );
        assert_eq!(
            parse(json!({ "kind": "request", "id": 7, "type": "files:read" })),
            Ok(Inbound::Request {
                id: 7,
                kind: "files:read".into(),
                payload: Value::Null
            })
        );
        assert_eq!(
            parse(json!({ "kind": "focus", "focused": true })),
            Ok(Inbound::Focus { focused: true })
        );
        let Ok(Inbound::Shortcut(key)) = parse(json!({
            "kind": "shortcut", "code": "KeyK", "key": "k",
            "meta": true, "ctrl": false, "alt": false, "shift": false
        })) else {
            panic!("not a shortcut");
        };
        assert_eq!(key.combo(), "meta+KeyK");
        assert!(parse(json!({ "kind": "unknown" })).is_err());
    }

    #[test]
    fn delivers_as_one_script_call() {
        let script = Outbound::response(3, Err("no \"file\"".into())).script();
        assert_eq!(
            script,
            r#"window.__latticeIsland && window.__latticeIsland.deliver({"kind":"response","id":3,"ok":false,"error":"no \"file\""});"#
        );
        let script = Outbound::event("host:theme", json!({ "a": "</script>" })).script();
        assert!(script.contains(r#""type":"host:theme""#));
    }

    #[test]
    fn the_bootstrap_carries_the_platform_and_the_token() {
        let script = script(TOKEN);
        assert!(!script.contains("__LATTICE_PRIMARY_IS_META__"));
        assert!(!script.contains("__LATTICE_BRIDGE_TOKEN__"));
        assert!(script.contains(&format!("\"{TOKEN}\"")));
    }
}
