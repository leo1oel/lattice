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
//!   server drops clients that do not echo `2::` promptly, and in turn the
//!   client gives the connection up when nothing at all arrives within the
//!   handshake's heartbeat timeout — a socket can stay open long after the
//!   network under it is gone.
//! - **Events.** `5:::{"name":…,"args":[…]}`; adding an ack id turns it into
//!   `5:{id}+::{"name":…}` and the server answers `6:::{id}+[…args…]`.
//!
//! Concretely, this module emits exactly these frames (ack ids increase from 1;
//! id 0 is reserved internally for the `1::` connect gate):
//!
//! ```text
//! 5:1+::{"name":"joinProject","args":[{"project_id":"<id>"}]}
//! 5:2+::{"name":"joinDoc","args":["<docId>",{"encodeRanges":true}]}
//! 5:3+::{"name":"applyOtUpdate","args":["<docId>",{"doc":"<docId>","op":[{"p":5,"i":"hello"}],"v":42}]}
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
//!
//! Layout: `codec` is the pure framing and the payloads we emit, `events` what
//! the channel reports and the parsers that read it, `tree` the live file tree,
//! and `client` the connection itself.

mod client;
mod codec;
mod events;
#[cfg(test)]
pub(crate) mod tests;
mod tree;

pub use client::{RealtimeClient, RealtimeConfig};
pub use codec::Submission;
pub(crate) use events::parse_comment_ranges;
pub use events::{EntityEntry, JoinedDoc, OtOp, PresenceUser, RealtimeEvent, TrackedChange};

/// Both halves of the bridge present themselves as the same desktop browser.
pub(crate) const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
pub(crate) const SESSION_EXPIRED: &str =
    "Overleaf session expired. Reconnect in Settings → Overleaf.";
pub(crate) const NOT_CONNECTED: &str = "Not connected to Overleaf. Connect in Settings → Overleaf.";
