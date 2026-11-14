//! Who else is in the Overleaf project, over the live channel, and where
//! this window's caret is, told to them: the Tauri app's
//! `use-overleaf-presence.ts`.
//!
//! The roster is seeded from `clientTracking.getConnectedUsers` once the
//! channel is up and kept by its presence events, our own connection left
//! out. When the channel drops, the people last seen stay, dimmed, for a
//! grace period, so a blip does not empty the stack and refill it.
//!
//! Our caret goes out half a second after it settles while someone else is
//! here, and only every five minutes when nobody is (nobody would see it);
//! entering another document says so at once, and a keepalive repeats the
//! last position every four minutes, as Overleaf forgets a quiet one.

use super::*;
use lattice_core::overleaf_rt::{PresenceUser, RealtimeEvent};

/// A position goes out this long after the caret settles, with company.
const SETTLE_WITH_OTHERS: Duration = Duration::from_millis(500);
/// And this long when nobody else is here.
const SETTLE_ALONE: Duration = Duration::from_secs(5 * 60);
/// The last position is repeated this often.
const KEEPALIVE: Duration = Duration::from_secs(4 * 60);
/// People last seen stay this long after the channel drops.
const GRACE: Duration = Duration::from_secs(15);

/// A caret as Overleaf counts it: a document, a zero-based line and a
/// column in UTF-16 units.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Caret {
    doc_id: String,
    row: i64,
    column: i64,
}

#[derive(Default)]
pub(super) struct PresenceState {
    /// Everyone else, by name then connection.
    peers: Vec<PresenceUser>,
    /// The channel dropped: `peers` are who was here.
    reconnecting: bool,
    grace: Option<Task<()>>,
    /// Our caret, as last told by the window.
    caret: Option<Caret>,
    /// What Overleaf last heard.
    sent: Option<Caret>,
    publish: Option<Task<()>>,
    keepalive: Option<Task<()>>,
}

impl OverleafBridge {
    /// Everyone else in the project now, by name.
    pub fn peers(&self) -> &[PresenceUser] {
        &self.presence.peers
    }

    /// The channel dropped and `peers` are who was last seen.
    pub fn peers_reconnecting(&self) -> bool {
        self.presence.reconnecting
    }

    /// The project-relative path of the document `doc_id`.
    pub fn path_of_doc(&self, doc_id: &str) -> Option<String> {
        self.entities
            .iter()
            .find(|(_, (id, kind))| id == doc_id && kind == "doc")
            .map(|(path, _)| path.clone())
    }

    /// The document id of `path`, when it is one Overleaf edits as text.
    pub fn doc_of_path(&self, path: &str) -> Option<String> {
        self.entities
            .get(path)
            .filter(|(_, kind)| kind == "doc")
            .map(|(id, _)| id.clone())
    }

    /// The channel is up: who is here, and where we are.
    pub(super) fn presence_joined(&mut self, cx: &mut Context<Self>) {
        self.presence.grace = None;
        let Some(client) = self.client.clone() else {
            return;
        };
        let asking = lattice_core::runtime::spawn(async move {
            let own = client.public_id();
            client.connected_users().await.map(|users| {
                users
                    .into_iter()
                    .filter(|user| user.id != own)
                    .collect::<Vec<_>>()
            })
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(people)) = asking.await else {
                return;
            };
            this.update(cx, |this, cx| {
                this.presence.peers = people;
                this.presence.reconnecting = false;
                this.sort_peers();
                cx.emit(OverleafBridgeEvent::PresenceChanged);
                cx.notify();
            })
            .ok();
        })
        .detach();
        // Overleaf only knows our caret from what this connection says.
        self.presence.sent = None;
        if let Some(caret) = self.presence.caret.clone() {
            self.publish(caret, cx);
        }
        self.presence.keepalive = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(KEEPALIVE).await;
                let Ok(Some(caret)) = this.update(cx, |this, _| this.presence.sent.clone()) else {
                    if this.upgrade().is_none() {
                        return;
                    }
                    continue;
                };
                if this.update(cx, |this, cx| this.publish(caret, cx)).is_err() {
                    return;
                }
            }
        }));
    }

    /// The channel dropped: keep who was here, dimmed, for the grace period.
    pub(super) fn presence_dropped(&mut self, cx: &mut Context<Self>) {
        self.presence.publish = None;
        self.presence.keepalive = None;
        if self.presence.peers.is_empty() || self.presence.reconnecting {
            return;
        }
        self.presence.reconnecting = true;
        self.presence.grace = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(GRACE).await;
            this.update(cx, |this, cx| {
                this.presence.peers.clear();
                this.presence.reconnecting = false;
                cx.emit(OverleafBridgeEvent::PresenceChanged);
                cx.notify();
            })
            .ok();
        }));
        cx.emit(OverleafBridgeEvent::PresenceChanged);
    }

    /// Someone arrived, moved or left.
    pub(super) fn presence_event(&mut self, event: RealtimeEvent, cx: &mut Context<Self>) {
        let own = self.client.as_ref().map(|client| client.public_id());
        match event {
            RealtimeEvent::PresenceUpdated { user } => {
                if own.as_deref() == Some(user.id.as_str()) {
                    return;
                }
                match self
                    .presence
                    .peers
                    .iter_mut()
                    .find(|peer| peer.id == user.id)
                {
                    Some(peer) => *peer = user,
                    None => self.presence.peers.push(user),
                }
                self.sort_peers();
            }
            RealtimeEvent::PresenceLeft { id } => self.presence.peers.retain(|peer| peer.id != id),
            _ => return,
        }
        cx.emit(OverleafBridgeEvent::PresenceChanged);
        cx.notify();
    }

    fn sort_peers(&mut self) {
        self.presence.peers.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.id.cmp(&right.id))
        });
    }

    /// The window's caret is in `path` (project-relative) at the zero-based
    /// `row` and UTF-16 `column`.
    pub fn caret_moved(&mut self, path: &str, row: u32, column: u32, cx: &mut Context<Self>) {
        let Some(doc_id) = self.doc_of_path(path) else {
            return;
        };
        let caret = Caret {
            doc_id,
            row: row.into(),
            column: column.into(),
        };
        if self.presence.caret.as_ref() == Some(&caret) {
            return;
        }
        let entered = self
            .presence
            .sent
            .as_ref()
            .is_none_or(|sent| sent.doc_id != caret.doc_id);
        self.presence.caret = Some(caret.clone());
        if self.client.is_none() {
            return;
        }
        if entered {
            self.publish(caret, cx);
            return;
        }
        let settle = if self.presence.peers.is_empty() {
            SETTLE_ALONE
        } else {
            SETTLE_WITH_OTHERS
        };
        self.presence.publish = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(settle).await;
            this.update(cx, |this, cx| {
                if let Some(caret) = this.presence.caret.clone() {
                    this.publish(caret, cx);
                }
            })
            .ok();
        }));
    }

    /// Tell Overleaf where our caret is. Best effort: a position that does
    /// not arrive is replaced by the next.
    fn publish(&mut self, caret: Caret, _: &mut Context<Self>) {
        self.presence.publish = None;
        let Some(client) = self.client.clone() else {
            return;
        };
        self.presence.sent = Some(caret.clone());
        lattice_core::runtime::spawn(async move {
            client
                .update_position(&caret.doc_id, caret.row, caret.column)
                .await
                .ok();
        });
    }
}
