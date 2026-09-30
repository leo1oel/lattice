//! The session table behind the browser bridge.
//!
//! Each session pairs one hidden native *host* WebView with the surface that
//! shows it: the bundled-Chromium window (*desktop*) or, on the development
//! and testing path, an ordinary browser tab (*browser*). The host relays IPC
//! with that visible peer. A session belongs to one kind of surface: the fixed
//! entry never hands a Chromium workspace to a browser tab or the other way
//! round. `visible_epoch` counts visible-peer generations so a delayed grace
//! timer can tell whether anything reconnected in the meantime.
//!
//! Functions here only update the table and message peers; the caller applies
//! the returned app-level effects (windows, Synara).

use axum::extract::ws::Message;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use tokio::sync::mpsc;

pub(super) type Sessions = Arc<Mutex<HashMap<String, BrowserSession>>>;

pub(super) fn lock(
    sessions: &Sessions,
) -> Result<MutexGuard<'_, HashMap<String, BrowserSession>>, String> {
    sessions.lock().map_err(|_| "Browser session state is unavailable.".to_string())
}

pub(super) struct BrowserSession {
    pub(super) host_label: String,
    pub(super) browser_origin: String,
    /// Reusable by later loads of the fixed browser entry.
    pub(super) entry_session: bool,
    pub(super) created_at: Instant,
    pub(super) host: Option<Peer>,
    pub(super) browser: Option<Peer>,
    pub(super) desktop: Option<Peer>,
    /// Shown by the bundled Chromium window rather than a browser tab.
    pub(super) bundled_chromium: bool,
    pub(super) visible_epoch: u64,
}

impl BrowserSession {
    pub(super) fn new(host_label: String, browser_origin: String) -> Self {
        Self {
            host_label,
            browser_origin,
            entry_session: false,
            created_at: Instant::now(),
            host: None,
            browser: None,
            desktop: None,
            bundled_chromium: false,
            visible_epoch: 0,
        }
    }

    fn slot(&mut self, role: BridgeRole) -> &mut Option<Peer> {
        match role {
            BridgeRole::Browser => &mut self.browser,
            BridgeRole::Desktop => &mut self.desktop,
            BridgeRole::Host => &mut self.host,
        }
    }

    fn visible(&self) -> Option<&Peer> {
        self.browser.as_ref().or(self.desktop.as_ref())
    }
}

pub(super) struct Peer {
    id: String,
    sender: mpsc::UnboundedSender<Message>,
}

impl Peer {
    fn send(&self, message: Message) {
        // A closed socket is already being torn down; nothing to report.
        let _ = self.sender.send(message);
    }

    fn close(&self) {
        self.send(Message::Close(None));
    }
}

/// Send a `{"type": kind}` control message, if the peer is connected.
fn notify(peer: Option<&Peer>, kind: &str) {
    if let Some(peer) = peer {
        peer.send(Message::Text(format!(r#"{{"type":"{kind}"}}"#).into()));
    }
}

#[derive(Deserialize)]
pub(super) struct BridgeQuery {
    pub(super) token: String,
    pub(super) role: BridgeRole,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum BridgeRole {
    #[default]
    Browser,
    Desktop,
    Host,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BrowserSessionConfig {
    pub(super) token: String,
    pub(super) bridge_port: u16,
    pub(super) label: String,
}

impl BrowserSessionConfig {
    pub(super) fn new(token: &str, session: &BrowserSession, port: u16) -> Self {
        Self { token: token.to_string(), bridge_port: port, label: session.host_label.clone() }
    }

    pub(super) fn url(&self, origin: &str) -> String {
        format!(
            "{origin}/#token={}&bridgePort={}&label={}",
            self.token, self.bridge_port, self.label
        )
    }
}

/// Reuse a live token on reload, and the newest fixed-entry workspace of the
/// same kind of surface (Chromium window or browser tab) for a second load.
/// The latter makes a second tab replace the first browser peer instead of
/// opening the same project in two independent native hosts.
pub(super) fn reusable_entry_config(
    sessions: &HashMap<String, BrowserSession>, port: u16, resume_token: Option<&str>,
    bundled_chromium: bool,
) -> Option<BrowserSessionConfig> {
    if let Some((token, session)) = resume_token
        .and_then(|token| sessions.get_key_value(token))
        .filter(|(_, session)| session.bundled_chromium == bundled_chromium)
    {
        return Some(BrowserSessionConfig::new(token, session, port));
    }
    sessions
        .iter()
        .filter(|(_, session)| {
            session.entry_session && session.bundled_chromium == bundled_chromium
        })
        .max_by_key(|(_, session)| session.created_at)
        .map(|(token, session)| BrowserSessionConfig::new(token, session, port))
}

/// Attach a peer and return its session's host label, or None when the token
/// is unknown or the session is shown by the other kind of surface. A
/// Chromium window claims a session for good; a browser tab never takes one.
pub(super) fn register_peer(
    sessions: &Sessions, query: &BridgeQuery, peer_id: &str, sender: mpsc::UnboundedSender<Message>,
) -> Option<String> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(&query.token)?;
    let peer = Peer { id: peer_id.to_string(), sender };
    match query.role {
        BridgeRole::Browser | BridgeRole::Desktop => {
            let claimed = match query.role {
                BridgeRole::Browser => session.bundled_chromium || session.desktop.is_some(),
                _ => session.browser.is_some(),
            };
            if claimed {
                return None;
            }
            session.bundled_chromium |= query.role == BridgeRole::Desktop;
            let reset_host = session.visible_epoch != 0;
            session.visible_epoch = session.visible_epoch.wrapping_add(1);
            if let Some(previous) = session.slot(query.role).replace(peer) {
                notify(Some(&previous), "browser-replaced");
                previous.close();
            }
            if reset_host {
                notify(session.host.as_ref(), "browser-reset");
            }
        }
        BridgeRole::Host => {
            if let Some(previous) = session.host.replace(peer) {
                previous.close();
            }
        }
    }
    notify_ready(session);
    Some(session.host_label.clone())
}

fn notify_ready(session: &BrowserSession) {
    let (Some(host), Some(visible)) = (&session.host, session.visible()) else {
        return;
    };
    let ready =
        Message::Text(format!(r#"{{"type":"ready","label":"{}"}}"#, session.host_label).into());
    host.send(ready.clone());
    visible.send(ready);
}

/// The peer that should receive a message from `peer_id`, if that peer is
/// still the current one for its role.
pub(super) fn other_peer(
    sessions: &Sessions, query: &BridgeQuery, peer_id: &str,
) -> Option<mpsc::UnboundedSender<Message>> {
    let sessions = sessions.lock().ok()?;
    let session = sessions.get(&query.token)?;
    let (source, target) = match query.role {
        BridgeRole::Browser => (&session.browser, session.host.as_ref()),
        BridgeRole::Desktop => (&session.desktop, session.host.as_ref()),
        BridgeRole::Host => (&session.host, session.visible()),
    };
    if source.as_ref()?.id != peer_id {
        return None;
    }
    target.map(|peer| peer.sender.clone())
}

pub(super) enum Detached {
    /// Settle the session after a reconnect grace period for this epoch.
    Grace(u64),
    /// The host left, which ends the whole session.
    SessionRemoved,
}

/// Forget a closed socket, unless a newer peer already replaced it.
pub(super) fn detach_peer(
    sessions: &Sessions, query: &BridgeQuery, peer_id: &str,
) -> Option<Detached> {
    let mut table = sessions.lock().ok()?;
    let session = table.get_mut(&query.token)?;
    let slot = session.slot(query.role);
    if slot.as_ref().map(|peer| peer.id.as_str()) != Some(peer_id) {
        return None;
    }
    *slot = None;
    match query.role {
        BridgeRole::Browser | BridgeRole::Desktop => Some(Detached::Grace(session.visible_epoch)),
        BridgeRole::Host => {
            notify(session.visible(), "host-disconnected");
            table.remove(&query.token);
            Some(Detached::SessionRemoved)
        }
    }
}

/// Atomically retire a session whose visible peer did not come back during
/// its reconnect grace period, returning its host label. `None` leaves the
/// session as it is: a peer reconnected, or a newer generation owns it.
pub(super) fn expire_abandoned_session(
    sessions: &Sessions, token: &str, visible_epoch: u64,
) -> Option<String> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get(token)?;
    if session.visible().is_some() || session.visible_epoch != visible_epoch {
        return None;
    }
    sessions.remove(token).map(|session| session.host_label)
}

pub(super) fn remove(sessions: &Sessions, token: &str) {
    if let Ok(mut sessions) = sessions.lock() {
        sessions.remove(token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mpsc::UnboundedReceiver;

    const TOKEN: &str = "secret";

    fn sessions(bundled_chromium: bool) -> Sessions {
        let session = BrowserSession {
            entry_session: true,
            bundled_chromium,
            ..BrowserSession::new("browser-test".into(), "http://127.0.0.1:18452".into())
        };
        Arc::new(Mutex::new(HashMap::from([(TOKEN.to_string(), session)])))
    }

    fn query(role: BridgeRole) -> BridgeQuery {
        BridgeQuery { token: TOKEN.to_string(), role }
    }

    fn try_connect(
        sessions: &Sessions, role: BridgeRole, id: &str,
    ) -> Option<UnboundedReceiver<Message>> {
        let (sender, receiver) = mpsc::unbounded_channel();
        register_peer(sessions, &query(role), id, sender).map(|_| receiver)
    }

    fn connect(sessions: &Sessions, role: BridgeRole, id: &str) -> UnboundedReceiver<Message> {
        try_connect(sessions, role, id).expect("registered")
    }

    fn relays(sessions: &Sessions, role: BridgeRole, id: &str) -> bool {
        other_peer(sessions, &query(role), id).is_some()
    }

    /// The next queued message: its text, "close", or "none".
    fn next(receiver: &mut UnboundedReceiver<Message>) -> String {
        match receiver.try_recv() {
            Ok(Message::Text(text)) => text.as_str().to_string(),
            Ok(Message::Close(None)) => "close".to_string(),
            Ok(_) => "other".to_string(),
            Err(_) => "none".to_string(),
        }
    }

    fn control(kind: &str) -> String {
        format!(r#"{{"type":"{kind}"}}"#)
    }

    /// Closes `id`'s socket, which must start a grace timer; returns its epoch.
    fn detach_with_grace(sessions: &Sessions, role: BridgeRole, id: &str) -> u64 {
        match detach_peer(sessions, &query(role), id) {
            Some(Detached::Grace(epoch)) => epoch,
            _ => panic!("closing {id} must start a grace timer"),
        }
    }

    fn drain(receivers: &mut [&mut UnboundedReceiver<Message>]) {
        for receiver in receivers {
            while receiver.try_recv().is_ok() {}
        }
    }

    #[test]
    fn host_and_visible_peer_are_told_they_are_ready_and_relay() {
        let sessions = sessions(false);
        let mut host = connect(&sessions, BridgeRole::Host, "host");
        assert_eq!(next(&mut host), "none");
        let mut browser = connect(&sessions, BridgeRole::Browser, "browser");

        let ready = r#"{"type":"ready","label":"browser-test"}"#;
        assert_eq!(next(&mut host), ready);
        assert_eq!(next(&mut browser), ready);
        assert!(relays(&sessions, BridgeRole::Browser, "browser"));
        assert!(relays(&sessions, BridgeRole::Host, "host"));
    }

    #[test]
    fn a_session_is_shown_by_one_kind_of_surface() {
        // A Chromium window keeps its session even across a reload gap.
        let chromium = sessions(true);
        assert!(try_connect(&chromium, BridgeRole::Browser, "tab").is_none());
        let _window = connect(&chromium, BridgeRole::Desktop, "window");
        detach_with_grace(&chromium, BridgeRole::Desktop, "window");
        assert!(try_connect(&chromium, BridgeRole::Browser, "tab").is_none());

        // A workspace opened for a new project claims its session when the
        // Chromium window connects; a tab already showing one keeps it.
        let fresh = sessions(false);
        let _window = connect(&fresh, BridgeRole::Desktop, "window");
        assert!(fresh.lock().unwrap()[TOKEN].bundled_chromium);
        let tab = sessions(false);
        let _tab = connect(&tab, BridgeRole::Browser, "tab");
        assert!(try_connect(&tab, BridgeRole::Desktop, "window").is_none());
    }

    #[test]
    fn replacement_peer_revokes_the_previous_socket() {
        let sessions = sessions(false);
        let mut host = connect(&sessions, BridgeRole::Host, "host");
        let mut first = connect(&sessions, BridgeRole::Browser, "first");
        drain(&mut [&mut host, &mut first]);

        let _second = connect(&sessions, BridgeRole::Browser, "second");

        assert_eq!(next(&mut first), control("browser-replaced"));
        assert_eq!(next(&mut first), "close");
        assert_eq!(next(&mut host), control("browser-reset"));
        assert!(!relays(&sessions, BridgeRole::Browser, "first"));
        assert!(relays(&sessions, BridgeRole::Browser, "second"));
    }

    #[test]
    fn desktop_reconnect_cancels_the_disconnected_desktop_grace_timer() {
        let sessions = sessions(true);
        let mut host = connect(&sessions, BridgeRole::Host, "host");
        let _desktop = connect(&sessions, BridgeRole::Desktop, "desktop");
        let epoch = detach_with_grace(&sessions, BridgeRole::Desktop, "desktop");
        let mut reconnected = connect(&sessions, BridgeRole::Desktop, "desktop-reconnected");
        drain(&mut [&mut host, &mut reconnected]);

        assert!(expire_abandoned_session(&sessions, TOKEN, epoch).is_none());
        assert!(relays(&sessions, BridgeRole::Desktop, "desktop-reconnected"));
    }

    #[test]
    fn host_disconnect_ends_the_session_and_tells_the_visible_peer() {
        let sessions = sessions(true);
        let _host = connect(&sessions, BridgeRole::Host, "host");
        let mut desktop = connect(&sessions, BridgeRole::Desktop, "desktop");
        drain(&mut [&mut desktop]);

        assert!(matches!(
            detach_peer(&sessions, &query(BridgeRole::Host), "host"),
            Some(Detached::SessionRemoved)
        ));
        assert_eq!(next(&mut desktop), control("host-disconnected"));
        assert!(sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn fixed_entry_resumes_a_live_token_and_replaces_a_stale_one() {
        let sessions = sessions(false);
        let sessions = sessions.lock().unwrap();
        for token in [TOKEN, "expired"] {
            let entry = reusable_entry_config(&sessions, 18452, Some(token), false).unwrap();
            let config = (entry.token.as_str(), entry.bridge_port, entry.label.as_str());
            assert_eq!(config, (TOKEN, 18452, "browser-test"), "{token}");
        }
    }

    #[test]
    fn fixed_entry_never_hands_a_chromium_workspace_to_a_browser_tab() {
        let sessions = sessions(true);
        let sessions = sessions.lock().unwrap();
        assert!(reusable_entry_config(&sessions, 18452, Some(TOKEN), false).is_none());
        assert!(reusable_entry_config(&sessions, 18452, None, false).is_none());
        assert!(reusable_entry_config(&sessions, 18452, None, true).is_some());
    }

    #[test]
    fn expiry_atomically_removes_only_the_disconnected_generation() {
        let sessions = sessions(false);
        let entry = |sessions: &Sessions| {
            reusable_entry_config(&sessions.lock().unwrap(), 18452, None, false)
        };

        assert!(expire_abandoned_session(&sessions, TOKEN, 1).is_none());
        assert!(entry(&sessions).is_some());

        assert_eq!(expire_abandoned_session(&sessions, TOKEN, 0).as_deref(), Some("browser-test"));
        assert!(entry(&sessions).is_none());
    }
}
