//! The session table behind the browser bridge.
//!
//! Each session pairs one hidden native *host* WebView with the browser tab
//! that shows it. Only the newest tab relays IPC with the host: a second tab
//! on the same workspace replaces the first. `visible_epoch` counts tab
//! generations so a delayed grace timer can tell whether a tab reconnected in
//! the meantime.
//!
//! A native window can also hand its workspace to a browser tab. That session
//! (`source_label`) relays nothing until the window has closed, so the two
//! never edit the project at once.
//!
//! Functions here only update the table and message peers; the caller applies
//! the app-level consequences (windows, Synara).

use crate::wide_event::{self, Failure};
use axum::extract::ws::Message;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
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
    /// Tab generations; nonzero once a tab has shown the workspace. Visible
    /// for struct-update construction only; change it through this module.
    pub(super) visible_epoch: u64,
    /// The native window handing this workspace to a browser tab.
    pub(super) source_label: Option<String>,
    pub(super) project_root: Option<PathBuf>,
    /// A handoff from a native window stays inactive (nothing is relayed)
    /// until that window has closed.
    pub(super) active: bool,
    /// The single-use nonce of the last default-browser entry address.
    pub(super) entry_nonce: Option<(String, Instant)>,
    /// The session's wide event, written when it leaves the table.
    pub(super) event: SessionEvent,
}

/// One `browser.session` wide event per session, opened with it and written
/// when it is dropped. [`retire`] says how it ended; a session dropped
/// without that (at quit) is logged as `abandoned`.
pub(super) struct SessionEvent {
    operation: Option<wide_event::Operation>,
    ended: Option<&'static str>,
    failure: Option<String>,
    relayed: u64,
}

impl SessionEvent {
    fn new() -> Self {
        let operation = wide_event::Operation::start("browser.session", classify_session_failure);
        Self { operation: Some(operation), ended: None, failure: None, relayed: 0 }
    }
}

impl Drop for SessionEvent {
    fn drop(&mut self) {
        let (Some(operation), Some(ended)) = (self.operation.take(), self.ended) else {
            return;
        };
        operation.record("relayed_messages", self.relayed);
        let failure = self.failure.as_deref().map(|cause| (classify_session_failure(ended), cause));
        operation.end(failure);
    }
}

/// What a session that ended badly means for whoever reads the log.
fn classify_session_failure(ended: &str) -> Failure {
    match ended {
        "tab_never_connected" => Failure {
            kind: "tab_never_connected",
            fix: "Keep the tab Lattice opened; if the browser blocked it, open the address again from Lattice.",
        },
        _ => Failure {
            kind: "open_failed",
            fix: "Set a default browser in System Settings, then use Open in browser again.",
        },
    }
}

/// Record how `session` ended on its wide event, before it is dropped.
fn retire(session: &mut BrowserSession, ended: &'static str, failure: Option<&str>) {
    let event = &mut session.event;
    if let Some(operation) = &event.operation {
        operation.record("native_handoff", session.source_label.is_some());
        operation.record("entry_session", session.entry_session);
        operation.record("tabs", session.visible_epoch);
        operation.record("ended", ended);
    }
    event.ended = Some(ended);
    event.failure = failure.map(str::to_string);
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
            visible_epoch: 0,
            source_label: None,
            project_root: None,
            active: true,
            entry_nonce: None,
            event: SessionEvent::new(),
        }
    }

    /// A browser tab shows this workspace, or did until a moment ago and may
    /// still come back within its grace period.
    pub(super) fn shown_in_browser(&self) -> bool {
        self.visible_epoch != 0
    }

    /// Attach a tab, replacing any earlier one: the newest tab owns the
    /// workspace, and the host starts over with it.
    fn attach_browser(&mut self, peer: Peer) {
        if let Some(previous) = self.browser.replace(peer) {
            notify(Some(&previous), "browser-replaced");
            previous.close();
        }
        if self.shown_in_browser() {
            notify(self.host.as_ref(), "browser-reset");
        }
        self.visible_epoch = self.visible_epoch.wrapping_add(1);
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

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum BridgeRole {
    Browser,
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
}

/// How long a default-browser entry address can claim its workspace.
const ENTRY_NONCE_TTL: Duration = Duration::from_secs(60);

/// The tokenless entry address whose page asks `/__lattice_session` for the
/// workspace `nonce` was issued for.
pub(super) fn entry_url(origin: &str, nonce: &str) -> String {
    format!("{origin}/?entry={nonce}")
}

/// Issue a fresh entry nonce for `token`, replacing any earlier one.
pub(super) fn issue_entry_nonce(sessions: &Sessions, token: &str) -> Result<String, String> {
    let mut sessions = lock(sessions)?;
    let session = sessions
        .get_mut(token)
        .ok_or_else(|| "This Lattice workspace is no longer available.".to_string())?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    session.entry_nonce = Some((nonce.clone(), Instant::now()));
    Ok(nonce)
}

/// A native window's handoff to `source_label` that has not activated yet.
pub(super) fn handoff_pending(
    sessions: &HashMap<String, BrowserSession>, source_label: &str,
) -> bool {
    sessions
        .values()
        .any(|session| !session.active && session.source_label.as_deref() == Some(source_label))
}

/// A browser tab holds a workspace a native window handed to it, so the app
/// reappears when that workspace returns to a native window.
pub(super) fn holds_native_handoff(sessions: &HashMap<String, BrowserSession>) -> bool {
    sessions.values().any(|session| session.source_label.is_some())
}

/// An explicit entry address selects no workspace: it is unknown, used or
/// expired.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct StaleEntry;

/// The workspace `/__lattice_session` serves a page; `Ok(None)` asks for a new
/// fixed-entry workspace. An explicit entry is the only selector its page
/// asked for, so it decides alone: the tab's stored session must not override
/// it, and one that selects nothing reaches the page as an error rather than
/// open whichever workspace is newest, which may be another project.
pub(super) fn select_entry(
    sessions: &mut HashMap<String, BrowserSession>, port: u16, resume_token: Option<&str>,
    entry_nonce: Option<&str>,
) -> Result<Option<BrowserSessionConfig>, StaleEntry> {
    match entry_nonce {
        Some(nonce) => claim_entry(sessions, port, nonce).map(Some).ok_or(StaleEntry),
        None => Ok(reusable_entry_config(sessions, port, resume_token)),
    }
}

/// The workspace an unexpired entry nonce was issued for, consuming the nonce.
fn claim_entry(
    sessions: &mut HashMap<String, BrowserSession>, port: u16, entry_nonce: &str,
) -> Option<BrowserSessionConfig> {
    let (token, session) = sessions.iter_mut().find(|(_, session)| {
        session.entry_nonce.as_ref().is_some_and(|(issued, _)| issued == entry_nonce)
    })?;
    let (_, issued_at) = session.entry_nonce.take()?;
    (issued_at.elapsed() < ENTRY_NONCE_TTL).then(|| BrowserSessionConfig::new(token, session, port))
}

/// Without an explicit entry: reuse a live token on reload, and the newest
/// fixed-entry workspace otherwise. The latter is what makes the bookmarked
/// address open the workspace the Lattice window shows, and makes a second
/// tab replace the first instead of opening the same project in two
/// independent hosts.
pub(super) fn reusable_entry_config(
    sessions: &HashMap<String, BrowserSession>, port: u16, resume_token: Option<&str>,
) -> Option<BrowserSessionConfig> {
    if let Some((token, session)) = resume_token.and_then(|token| sessions.get_key_value(token)) {
        return Some(BrowserSessionConfig::new(token, session, port));
    }
    sessions
        .iter()
        .filter(|(_, session)| session.entry_session)
        .max_by_key(|(_, session)| session.created_at)
        .map(|(token, session)| BrowserSessionConfig::new(token, session, port))
}

/// Attach a peer; false when the token is unknown.
pub(super) fn register_peer(
    sessions: &Sessions, query: &BridgeQuery, peer_id: &str, sender: mpsc::UnboundedSender<Message>,
) -> bool {
    let Ok(mut sessions) = sessions.lock() else {
        return false;
    };
    let Some(session) = sessions.get_mut(&query.token) else {
        return false;
    };
    let peer = Peer { id: peer_id.to_string(), sender };
    match query.role {
        BridgeRole::Browser => session.attach_browser(peer),
        BridgeRole::Host => {
            if let Some(previous) = session.host.replace(peer) {
                previous.close();
            }
        }
    }
    notify_ready(session);
    true
}

fn notify_ready(session: &BrowserSession) {
    if !session.active {
        return;
    }
    let (Some(host), Some(browser)) = (&session.host, &session.browser) else {
        return;
    };
    let ready =
        Message::Text(format!(r#"{{"type":"ready","label":"{}"}}"#, session.host_label).into());
    host.send(ready.clone());
    browser.send(ready);
}

/// Start relaying a native window's handoff once that window has closed.
pub(super) fn activate(session: &mut BrowserSession) {
    session.active = true;
    notify_ready(session);
}

/// The peer that should receive a message from `peer_id`, if that peer is
/// still the current one for its role.
pub(super) fn other_peer(
    sessions: &Sessions, query: &BridgeQuery, peer_id: &str,
) -> Option<mpsc::UnboundedSender<Message>> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(&query.token).filter(|session| session.active)?;
    let (source, target) = match query.role {
        BridgeRole::Browser => (session.browser.as_ref(), session.host.as_ref()),
        BridgeRole::Host => (session.host.as_ref(), session.browser.as_ref()),
    };
    if source?.id != peer_id {
        return None;
    }
    let target = target.map(|peer| peer.sender.clone());
    session.event.relayed += u64::from(target.is_some());
    target
}

/// End a session whose workspace now shows in a native window.
pub(super) fn finish_native_return(sessions: &Sessions, token: &str) -> Option<String> {
    let mut session = sessions.lock().ok()?.remove(token)?;
    retire(&mut session, "returned_to_desktop", None);
    if let Some(browser) = &session.browser {
        notify(Some(browser), "desktop-returned");
        browser.close();
    }
    Some(session.host_label)
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
    let slot = match query.role {
        BridgeRole::Browser => &mut session.browser,
        BridgeRole::Host => &mut session.host,
    };
    if slot.as_ref().map(|peer| peer.id.as_str()) != Some(peer_id) {
        return None;
    }
    *slot = None;
    match query.role {
        BridgeRole::Browser => Some(Detached::Grace(session.visible_epoch)),
        BridgeRole::Host => {
            notify(session.browser.as_ref(), "host-disconnected");
            if let Some(mut session) = table.remove(&query.token) {
                retire(&mut session, "host_disconnected", None);
            }
            Some(Detached::SessionRemoved)
        }
    }
}

/// A session nobody came back to: retire its hidden host.
pub(super) struct Expired {
    pub(super) host_label: String,
    /// The workspace a native window handed to the tab, which reopens there.
    pub(super) native_return: bool,
}

/// End a session whose tab did not come back during its grace period.
/// `None` leaves it as it is: a tab reconnected, or a newer generation owns
/// it.
pub(super) fn settle_after_grace(
    sessions: &Sessions, token: &str, visible_epoch: u64,
) -> Option<Expired> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get(token)?;
    if session.browser.is_some() || session.visible_epoch != visible_epoch {
        return None;
    }
    let mut session = sessions.remove(token)?;
    if session.shown_in_browser() {
        retire(&mut session, "tab_closed", None);
    } else {
        retire(&mut session, "tab_never_connected", Some("The browser tab never connected."));
    }
    let native_return = session.source_label.is_some();
    Some(Expired { native_return, host_label: std::mem::take(&mut session.host_label) })
}

pub(super) fn send_error(sessions: &Sessions, token: &str, reason: &str) {
    let message = serde_json::json!({ "type": "error", "message": reason }).to_string();
    if let Some(session) = sessions.lock().ok().as_ref().and_then(|sessions| sessions.get(token)) {
        for peer in [&session.host, &session.browser].into_iter().flatten() {
            peer.send(Message::Text(message.clone().into()));
        }
    }
}

/// Drop a session that failed to open, for `reason`.
pub(super) fn remove(sessions: &Sessions, token: &str, reason: &str) {
    let removed = sessions.lock().ok().and_then(|mut sessions| sessions.remove(token));
    if let Some(mut session) = removed {
        retire(&mut session, "open_failed", Some(reason));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mpsc::UnboundedReceiver;

    const TOKEN: &str = "secret";
    const READY: &str = r#"{"type":"ready","label":"browser-test"}"#;

    fn sessions() -> Sessions {
        let session = BrowserSession {
            entry_session: true,
            ..BrowserSession::new("browser-test".into(), "http://127.0.0.1:18452".into())
        };
        Arc::new(Mutex::new(HashMap::from([(TOKEN.to_string(), session)])))
    }

    fn query(role: BridgeRole) -> BridgeQuery {
        BridgeQuery { token: TOKEN.to_string(), role }
    }

    fn connect(sessions: &Sessions, role: BridgeRole, id: &str) -> UnboundedReceiver<Message> {
        let (sender, receiver) = mpsc::unbounded_channel();
        assert!(register_peer(sessions, &query(role), id, sender), "registered");
        receiver
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

    /// Everything queued, in order.
    fn all(receiver: &mut UnboundedReceiver<Message>) -> Vec<String> {
        std::iter::from_fn(|| Some(next(receiver)).filter(|message| message != "none")).collect()
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
    fn host_and_tab_are_told_they_are_ready_and_relay() {
        let sessions = sessions();
        let mut host = connect(&sessions, BridgeRole::Host, "host");
        assert_eq!(next(&mut host), "none");
        let mut browser = connect(&sessions, BridgeRole::Browser, "browser");

        assert_eq!(next(&mut host), READY);
        assert_eq!(next(&mut browser), READY);
        assert!(relays(&sessions, BridgeRole::Browser, "browser"));
        assert!(relays(&sessions, BridgeRole::Host, "host"));
        assert!(!relays(&sessions, BridgeRole::Browser, "stale"));
    }

    #[test]
    fn reloading_the_tab_keeps_the_workspace_in_the_browser() {
        let sessions = sessions();
        let mut host = connect(&sessions, BridgeRole::Host, "host");
        let _tab = connect(&sessions, BridgeRole::Browser, "tab");
        drain(&mut [&mut host]);

        let epoch = detach_with_grace(&sessions, BridgeRole::Browser, "tab");
        assert!(sessions.lock().unwrap()[TOKEN].shown_in_browser(), "still the tab's");
        let mut reloaded = connect(&sessions, BridgeRole::Browser, "reloaded");
        assert_eq!(all(&mut reloaded), [READY]);
        assert_eq!(all(&mut host), [control("browser-reset"), READY.to_string()]);
        assert!(settle_after_grace(&sessions, TOKEN, epoch).is_none());
        assert!(relays(&sessions, BridgeRole::Browser, "reloaded"));
    }

    #[test]
    fn closing_the_tab_ends_the_session_after_the_grace_period() {
        let sessions = sessions();
        let _host = connect(&sessions, BridgeRole::Host, "host");
        let _tab = connect(&sessions, BridgeRole::Browser, "tab");

        let epoch = detach_with_grace(&sessions, BridgeRole::Browser, "tab");
        assert!(matches!(
            settle_after_grace(&sessions, TOKEN, epoch),
            Some(Expired { native_return: false, .. })
        ));
        assert!(sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn a_native_window_handoff_relays_only_after_the_window_closed_and_returns_natively() {
        let sessions = sessions();
        sessions.lock().unwrap().get_mut(TOKEN).unwrap().source_label = Some("main".into());
        sessions.lock().unwrap().get_mut(TOKEN).unwrap().active = false;
        let mut host = connect(&sessions, BridgeRole::Host, "host");
        let mut browser = connect(&sessions, BridgeRole::Browser, "tab");
        assert!(!relays(&sessions, BridgeRole::Browser, "tab"));
        assert_eq!(next(&mut host), "none");

        activate(sessions.lock().unwrap().get_mut(TOKEN).unwrap());
        assert_eq!(next(&mut host), READY);
        assert_eq!(next(&mut browser), READY);
        assert!(relays(&sessions, BridgeRole::Browser, "tab"));

        assert_eq!(finish_native_return(&sessions, TOKEN).as_deref(), Some("browser-test"));
        assert_eq!(all(&mut browser), [control("desktop-returned"), "close".to_string()]);
        assert!(sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn closing_the_tab_of_a_native_handoff_reopens_it_natively() {
        let sessions = sessions();
        sessions.lock().unwrap().get_mut(TOKEN).unwrap().source_label = Some("main".into());
        let _host = connect(&sessions, BridgeRole::Host, "host");
        let _browser = connect(&sessions, BridgeRole::Browser, "tab");

        let epoch = detach_with_grace(&sessions, BridgeRole::Browser, "tab");
        assert!(matches!(
            settle_after_grace(&sessions, TOKEN, epoch),
            Some(Expired { native_return: true, .. })
        ));
    }

    #[test]
    fn replacement_peer_revokes_the_previous_socket() {
        let sessions = sessions();
        let mut host = connect(&sessions, BridgeRole::Host, "host");
        let mut first = connect(&sessions, BridgeRole::Browser, "first");
        drain(&mut [&mut host, &mut first]);

        let _second = connect(&sessions, BridgeRole::Browser, "second");

        assert_eq!(next(&mut first), control("browser-replaced"));
        assert_eq!(next(&mut first), "close");
        assert_eq!(next(&mut host), control("browser-reset"));
        assert!(!relays(&sessions, BridgeRole::Browser, "first"));
        assert!(relays(&sessions, BridgeRole::Browser, "second"));
        // The revoked socket's own close must not start a grace timer.
        assert!(detach_peer(&sessions, &query(BridgeRole::Browser), "first").is_none());
    }

    #[test]
    fn host_disconnect_ends_the_session_and_tells_the_tab() {
        let sessions = sessions();
        let _host = connect(&sessions, BridgeRole::Host, "host");
        let mut browser = connect(&sessions, BridgeRole::Browser, "tab");
        drain(&mut [&mut browser]);

        assert!(matches!(
            detach_peer(&sessions, &query(BridgeRole::Host), "host"),
            Some(Detached::SessionRemoved)
        ));
        assert_eq!(next(&mut browser), control("host-disconnected"));
        assert!(sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn each_session_is_one_wide_event_saying_how_it_ended() {
        let (_, capture) = crate::wide_event::tests::capture(|| {
            let closed = sessions();
            let _host = connect(&closed, BridgeRole::Host, "host");
            let _tab = connect(&closed, BridgeRole::Browser, "tab");
            assert!(relays(&closed, BridgeRole::Browser, "tab"));
            assert!(relays(&closed, BridgeRole::Host, "host"));
            let epoch = detach_with_grace(&closed, BridgeRole::Browser, "tab");
            settle_after_grace(&closed, TOKEN, epoch);

            // A tab that never connects is the failure worth a fix.
            settle_after_grace(&sessions(), TOKEN, 0);
        });
        let events = capture.events();
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0]["event"], "browser.session");
        assert_eq!(events[0]["outcome"], "success");
        assert_eq!(events[0]["ended"], "tab_closed");
        assert_eq!(events[0]["relayed_messages"], 2);
        assert_eq!(events[0]["tabs"], 1);
        assert_eq!(events[0]["entry_session"], true);
        assert_eq!(events[1]["outcome"], "error");
        assert_eq!(events[1]["error_kind"], "tab_never_connected");
        // The session token is a credential for the workspace.
        assert!(!format!("{events:?}").contains(TOKEN));
    }

    #[test]
    fn fixed_entry_resumes_a_live_token_and_replaces_a_stale_one() {
        let sessions = sessions();
        let sessions = sessions.lock().unwrap();
        for token in [TOKEN, "expired"] {
            let entry = reusable_entry_config(&sessions, 18452, Some(token)).unwrap();
            let config = (entry.token.as_str(), entry.bridge_port, entry.label.as_str());
            assert_eq!(config, (TOKEN, 18452, "browser-test"), "{token}");
        }
    }

    #[test]
    fn default_browser_entry_carries_only_a_single_use_nonce() {
        let sessions = sessions();
        sessions.lock().unwrap().insert(
            "project-tab".into(),
            BrowserSession::new("browser-project".into(), "http://127.0.0.1:18452".into()),
        );
        let claim = |entry: &str| {
            select_entry(&mut sessions.lock().unwrap(), 18452, None, Some(entry))
                .map(|config| config.map(|config| config.token))
        };

        let nonce = issue_entry_nonce(&sessions, "project-tab").unwrap();
        let url = entry_url("http://127.0.0.1:18452", &nonce);
        assert_eq!(url, format!("http://127.0.0.1:18452/?entry={nonce}"));
        assert!(!url.contains("project-tab") && !url.contains("browser-project"), "{url}");

        // An entry that selects nothing never falls back to the newest
        // fixed-entry workspace (TOKEN here), which may be another project.
        assert_eq!(claim("browser-project"), Err(StaleEntry), "a label is no selector");
        assert_eq!(claim(&nonce), Ok(Some("project-tab".into())));
        assert_eq!(claim(&nonce), Err(StaleEntry), "a nonce claims only once");

        let reissued = issue_entry_nonce(&sessions, "project-tab").unwrap();
        assert_ne!(reissued, nonce);
        assert_eq!(claim(&nonce), Err(StaleEntry), "a used nonce is not revived");

        let stale = issue_entry_nonce(&sessions, "project-tab").unwrap();
        let issued_at = Instant::now().checked_sub(ENTRY_NONCE_TTL).unwrap();
        sessions.lock().unwrap().get_mut("project-tab").unwrap().entry_nonce =
            Some((stale.clone(), issued_at));
        assert_eq!(claim(&stale), Err(StaleEntry), "an expired nonce selects nothing");
        assert!(issue_entry_nonce(&sessions, "gone").is_err());

        // Without an entry, the bookmark still opens the newest workspace.
        let bookmark = select_entry(&mut sessions.lock().unwrap(), 18452, None, None);
        assert_eq!(
            bookmark.map(|config| config.map(|config| config.token)),
            Ok(Some(TOKEN.into()))
        );
    }

    #[test]
    fn a_fresh_entry_selects_its_workspace_over_the_tabs_stored_session() {
        // A tab holding project A (TOKEN) navigates to a fresh entry for B.
        let sessions = sessions();
        sessions.lock().unwrap().insert(
            "project-b".into(),
            BrowserSession::new("browser-b".into(), "http://127.0.0.1:18452".into()),
        );
        let nonce = issue_entry_nonce(&sessions, "project-b").unwrap();
        let mut table = sessions.lock().unwrap();

        let selected = select_entry(&mut table, 18452, Some(TOKEN), Some(&nonce)).unwrap().unwrap();
        assert_eq!(selected.label, "browser-b");
        assert!(table["project-b"].entry_nonce.is_none(), "the entry is consumed");
        // Replayed, the entry is refused rather than resuming A.
        assert_eq!(
            select_entry(&mut table, 18452, Some(TOKEN), Some(&nonce)).map(|_| ()),
            Err(StaleEntry)
        );
        // So is an entry address whose nonce is empty.
        assert_eq!(
            select_entry(&mut table, 18452, Some(TOKEN), Some("")).map(|_| ()),
            Err(StaleEntry)
        );
        // An ordinary reload, without the entry, resumes the stored session.
        let reload = select_entry(&mut table, 18452, Some(TOKEN), None).unwrap().unwrap();
        assert_eq!(reload.label, "browser-test");
    }

    #[test]
    fn only_a_pending_native_handoff_blocks_its_window_label() {
        let sessions = sessions();
        let mut sessions = sessions.lock().unwrap();
        assert!(!holds_native_handoff(&sessions), "a fixed-entry tab keeps the app visible");
        sessions.insert(
            "handoff".into(),
            BrowserSession {
                source_label: Some("project-1".into()),
                active: false,
                ..BrowserSession::new("browser-handoff".into(), "http://127.0.0.1:18452".into())
            },
        );
        assert!(holds_native_handoff(&sessions));
        assert!(handoff_pending(&sessions, "project-1"));
        assert!(!handoff_pending(&sessions, "project-2"));

        activate(sessions.get_mut("handoff").unwrap());
        assert!(!handoff_pending(&sessions, "project-1"), "a reused label may hand off again");
        assert!(holds_native_handoff(&sessions));
    }

    #[test]
    fn expiry_atomically_removes_only_the_disconnected_generation() {
        let sessions = sessions();
        let entry =
            |sessions: &Sessions| reusable_entry_config(&sessions.lock().unwrap(), 18452, None);

        assert!(settle_after_grace(&sessions, TOKEN, 1).is_none());
        assert!(entry(&sessions).is_some());

        assert!(matches!(
            settle_after_grace(&sessions, TOKEN, 0),
            Some(Expired { host_label, native_return: false }) if host_label == "browser-test"
        ));
        assert!(entry(&sessions).is_none());
    }
}
