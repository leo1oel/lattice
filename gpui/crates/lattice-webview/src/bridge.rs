//! The bridge between an island's page and the host.
//!
//! The page side is `assets/bridge.js`, injected into the main frame before
//! the page's own scripts. Messages from the page arrive through Wry's IPC
//! as JSON ([`Inbound`]); the host answers by evaluating
//! `__latticeIsland.deliver(<json>)` in the page ([`Outbound::script`]).
//!
//! Only the island's own page may speak: Wry passes each IPC message with the
//! URL of the frame that sent it, and a message from any frame not served by
//! the island protocol (an authored page in a sandboxed child frame, or a page
//! the island navigated to by mistake) is dropped ([`accepts_sender`]).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{keys::PageKey, protocol};

/// The bootstrap script, with the platform filled in.
pub fn script() -> String {
    include_str!("../assets/bridge.js").replace(
        "__LATTICE_PRIMARY_IS_META__",
        if cfg!(target_os = "macos") {
            "true"
        } else {
            "false"
        },
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

/// Parse one IPC message, or say why it was dropped.
pub fn parse(sender: &str, body: &str) -> Result<Inbound, String> {
    if !accepts_sender(sender) {
        return Err(format!("a message from {sender:?}, not the island's page"));
    }
    serde_json::from_str(body).map_err(|error| format!("{error}: {body:.200}"))
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

    #[test]
    fn only_the_island_page_may_speak() {
        let page = protocol::url("bundle/html-preview/index.html");
        assert!(accepts_sender(&page));
        assert!(!accepts_sender("about:srcdoc"));
        assert!(!accepts_sender("https://example.com/"));
        assert!(!accepts_sender(&format!("{}.evil/x", protocol::origin())));
        assert!(parse("about:srcdoc", r#"{"kind":"ready"}"#).is_err());
    }

    #[test]
    fn parses_each_message() {
        let page = protocol::url("bundle/x/index.html");
        assert_eq!(parse(&page, r#"{"kind":"ready"}"#), Ok(Inbound::Ready));
        assert_eq!(
            parse(
                &page,
                r#"{"kind":"event","type":"html:scroll","payload":{"scrollTop":4}}"#
            ),
            Ok(Inbound::Event {
                kind: "html:scroll".into(),
                payload: json!({ "scrollTop": 4 })
            })
        );
        assert_eq!(
            parse(&page, r#"{"kind":"request","id":7,"type":"files:read"}"#),
            Ok(Inbound::Request {
                id: 7,
                kind: "files:read".into(),
                payload: Value::Null
            })
        );
        assert_eq!(
            parse(&page, r#"{"kind":"focus","focused":true}"#),
            Ok(Inbound::Focus { focused: true })
        );
        let Ok(Inbound::Shortcut(key)) = parse(
            &page,
            r#"{"kind":"shortcut","code":"KeyK","key":"k","meta":true,"ctrl":false,"alt":false,"shift":false}"#,
        ) else {
            panic!("not a shortcut");
        };
        assert_eq!(key.combo(), "meta+KeyK");
        assert!(parse(&page, r#"{"kind":"unknown"}"#).is_err());
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
    fn the_bootstrap_names_the_primary_modifier() {
        let script = script();
        assert!(!script.contains("__LATTICE_PRIMARY_IS_META__"));
        assert!(script.contains("const PRIMARY_IS_META = "));
    }
}
