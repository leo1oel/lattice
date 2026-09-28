//! The session table behind the browser bridge.
//!
//! Each session pairs one hidden native *host* WebView with the surface that
//! shows it: a system-browser tab (*browser*) or the bundled-Chromium window
//! (*desktop*). The host relays IPC with the visible peer. While a browser tab
//! is attached, the desktop window is parked (suspended and hidden) and it
//! resumes once the tab is gone. `visible_epoch` counts visible-peer
//! generations so a delayed grace timer can tell whether anything reconnected
//! in the meantime.
//!
//! Functions here only update the table and message peers; the caller applies
//! the returned app-level effects (windows, Chromium, Synara).

use axum::extract::ws::Message;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
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
    pub(super) source_label: Option<String>,
    pub(super) host_label: String,
    pub(super) project_root: Option<PathBuf>,
    pub(super) browser_origin: String,
    /// Reusable by later loads of the fixed browser entry.
    pub(super) entry_session: bool,
    pub(super) created_at: Instant,
    /// A handoff stays inactive (nothing is relayed) until its source window closed.
    pub(super) active: bool,
    pub(super) host: Option<Peer>,
    pub(super) browser: Option<Peer>,
    pub(super) desktop: Option<Peer>,
    pub(super) bundled_chromium: bool,
    pub(super) visible_epoch: u64,
    pub(super) desktop_return: Option<DesktopReturnRequest>,
}

impl BrowserSession {
    pub(super) fn new(host_label: String, browser_origin: String) -> Self {
        Self {
            source_label: None,
            host_label,
            project_root: None,
            browser_origin,
            entry_session: false,
            created_at: Instant::now(),
            active: true,
            host: None,
            browser: None,
            desktop: None,
            bundled_chromium: false,
            visible_epoch: 0,
            desktop_return: None,
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DesktopReturnTarget {
    Bundled,
    Native,
}

pub(super) struct DesktopReturnRequest {
    target: DesktopReturnTarget,
    acknowledged: bool,
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

/// Reuse a live token on reload and reuse the newest fixed-entry workspace for
/// a second tab. The latter makes the second tab replace the first browser peer
/// instead of opening the same project in two independent native hosts.
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

pub(super) struct PeerRegistration {
    pub(super) host_label: String,
    pub(super) hide_desktop: bool,
    pub(super) complete_desktop_return: bool,
}

pub(super) fn register_peer(
    sessions: &Sessions, query: &BridgeQuery, peer_id: &str, sender: mpsc::UnboundedSender<Message>,
) -> Option<PeerRegistration> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(&query.token)?;
    let mut registration = PeerRegistration {
        host_label: session.host_label.clone(),
        hide_desktop: false,
        complete_desktop_return: false,
    };
    let peer = Peer { id: peer_id.to_string(), sender };
    match query.role {
        BridgeRole::Browser => {
            registration.hide_desktop = session.bundled_chromium;
            let reset_host = session.visible_epoch != 0;
            session.visible_epoch = session.visible_epoch.wrapping_add(1);
            if let Some(previous) = session.browser.replace(peer) {
                notify(Some(&previous), "browser-replaced");
                previous.close();
            }
            notify(session.desktop.as_ref(), "desktop-suspended");
            if reset_host {
                notify(session.host.as_ref(), "browser-reset");
            }
        }
        BridgeRole::Desktop => {
            registration.hide_desktop = session.browser.is_some();
            session.bundled_chromium = true;
            registration.complete_desktop_return =
                session.desktop_return.as_ref().is_some_and(|request| request.acknowledged);
            let reset_host = session.browser.is_none() && session.visible_epoch != 0;
            // Mark the initial fixed-Chromium connection so the session-create
            // timeout cannot retire it. Later standby reloads must preserve
            // the browser generation: otherwise a desktop reconnect during
            // the browser-close grace period cancels the pending resume.
            if session.visible_epoch == 0 {
                session.visible_epoch = 1;
            }
            if let Some(previous) = session.desktop.replace(peer) {
                previous.close();
            }
            if session.browser.is_some() {
                notify(session.desktop.as_ref(), "desktop-suspended");
            } else if reset_host {
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
    Some(registration)
}

pub(super) fn notify_ready(session: &BrowserSession) {
    if !session.active {
        return;
    }
    let (Some(host), Some(visible)) = (&session.host, session.visible()) else {
        return;
    };
    let ready =
        Message::Text(format!(r#"{{"type":"ready","label":"{}"}}"#, session.host_label).into());
    host.send(ready.clone());
    visible.send(ready);
}

/// The peer that should receive a message from `peer_id`, if that peer is
/// still the current one for its role and the session relays at all.
pub(super) fn other_peer(
    sessions: &Sessions, query: &BridgeQuery, peer_id: &str,
) -> Option<mpsc::UnboundedSender<Message>> {
    let sessions = sessions.lock().ok()?;
    let session = sessions.get(&query.token).filter(|session| session.active)?;
    let (source, target) = match query.role {
        BridgeRole::Browser => (&session.browser, session.host.as_ref()),
        // A parked desktop stays silent while a browser tab owns the host.
        BridgeRole::Desktop if session.browser.is_some() => return None,
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
        BridgeRole::Browser => {
            session.visible_epoch = session.visible_epoch.wrapping_add(1);
            Some(Detached::Grace(session.visible_epoch))
        }
        // A parked Chromium renderer reloads after browser takeover. Its
        // socket replacement must not invalidate the browser's grace timer,
        // but a real desktop close still needs a timer that expires the
        // hidden host when no browser replaces it.
        BridgeRole::Desktop => {
            session.browser.is_none().then_some(Detached::Grace(session.visible_epoch))
        }
        BridgeRole::Host => {
            let kind = if session.desktop_return.is_some() {
                "desktop-returned"
            } else {
                "host-disconnected"
            };
            notify(session.browser.as_ref(), kind);
            notify(session.desktop.as_ref(), kind);
            table.remove(&query.token);
            Some(Detached::SessionRemoved)
        }
    }
}

pub(super) enum SessionSettlement {
    ResumeDesktop(String),
    Expire(String),
}

/// Resume a parked bundled-Chromium surface, or atomically retire an entry
/// session when no visible peer returned during its reconnect grace period.
/// `None` leaves the session as it is.
pub(super) fn settle_browser_session(
    sessions: &Sessions, token: &str, visible_epoch: u64, resume_parked_desktop: bool,
) -> Option<SessionSettlement> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(token)?;
    if session.browser.is_some() || session.visible_epoch != visible_epoch {
        return None;
    }
    if session.desktop.is_some() {
        // A replacement Desktop peer makes the disconnected Desktop's grace
        // timer stale. Only a Browser disconnect may resume a parked Desktop;
        // otherwise every Desktop reload would schedule another reload five
        // seconds later and loop forever.
        if !resume_parked_desktop {
            return None;
        }
        notify(session.host.as_ref(), "browser-reset");
        notify(session.desktop.as_ref(), "desktop-resumed");
        return Some(SessionSettlement::ResumeDesktop(session.host_label.clone()));
    }
    sessions.remove(token).map(|session| SessionSettlement::Expire(session.host_label))
}

/// Mark a session to return to the desktop once its host acknowledges.
pub(super) fn request_desktop_return(
    sessions: &Sessions, host_label: &str, target: DesktopReturnTarget,
) -> Result<String, String> {
    let mut sessions = lock(sessions)?;
    let (token, session) = sessions
        .iter_mut()
        .find(|(_, session)| session.host_label == host_label)
        .ok_or_else(|| "This browser workspace is no longer active.".to_string())?;
    session.desktop_return = Some(DesktopReturnRequest { target, acknowledged: false });
    Ok(token.clone())
}

pub(super) enum DesktopReturn {
    /// The parked renderer is reconnecting; finish when it registers.
    PendingBundled,
    /// Reveal the bundled-Chromium window again; the session lives on.
    Bundled(String),
    /// The session ended; retire its hidden host window.
    Native(String),
}

pub(super) fn take_returning_session(
    sessions: &Sessions, token: &str, host_peer_id: Option<&str>,
) -> Option<DesktopReturn> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(token)?;
    let current_host = session.host.as_ref().map(|host| host.id.as_str());
    if host_peer_id.is_some_and(|peer_id| current_host != Some(peer_id)) {
        return None;
    }
    let request = session.desktop_return.as_mut()?;
    request.acknowledged = true;
    if request.target == DesktopReturnTarget::Native {
        let session = sessions.remove(token)?;
        notify(session.browser.as_ref(), "desktop-returned");
        return Some(DesktopReturn::Native(session.host_label));
    }
    if session.desktop.is_none() {
        // The parked renderer reloads when takeover starts, so its socket can
        // be briefly absent when the host acknowledges the command response.
        // Keep the browser and host alive until that renderer reconnects.
        return Some(DesktopReturn::PendingBundled);
    }
    session.desktop_return = None;
    session.visible_epoch = session.visible_epoch.wrapping_add(1);
    if let Some(browser) = session.browser.take() {
        notify(Some(&browser), "desktop-returned");
        browser.close();
    }
    notify(session.host.as_ref(), "browser-reset");
    notify(session.desktop.as_ref(), "desktop-resumed");
    Some(DesktopReturn::Bundled(session.host_label.clone()))
}

pub(super) fn send_error(sessions: &Sessions, token: &str, reason: &str) {
    let message = serde_json::json!({ "type": "error", "message": reason }).to_string();
    if let Some(session) = sessions.lock().ok().as_ref().and_then(|sessions| sessions.get(token)) {
        for peer in [&session.host, &session.browser, &session.desktop].into_iter().flatten() {
            peer.send(Message::Text(message.clone().into()));
        }
    }
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

    fn sessions(active: bool) -> Sessions {
        let session = BrowserSession {
            source_label: Some("main".to_string()),
            entry_session: true,
            active,
            ..BrowserSession::new("browser-test".into(), "http://127.0.0.1:18452".into())
        };
        Arc::new(Mutex::new(HashMap::from([(TOKEN.to_string(), session)])))
    }

    fn query(role: BridgeRole) -> BridgeQuery {
        BridgeQuery { token: TOKEN.to_string(), role }
    }

    fn connect(
        sessions: &Sessions, role: BridgeRole, id: &str,
    ) -> (PeerRegistration, UnboundedReceiver<Message>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (register_peer(sessions, &query(role), id, sender).expect("registered"), receiver)
    }

    fn relays(sessions: &Sessions, role: BridgeRole, id: &str) -> bool {
        other_peer(sessions, &query(role), id).is_some()
    }

    fn with_session<T>(sessions: &Sessions, update: impl FnOnce(&mut BrowserSession) -> T) -> T {
        update(sessions.lock().unwrap().get_mut(TOKEN).expect("session"))
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
    fn inactive_handoff_does_not_relay_until_activated() {
        let sessions = sessions(false);
        let (_, mut host) = connect(&sessions, BridgeRole::Host, "host");
        let (_, _browser) = connect(&sessions, BridgeRole::Browser, "browser");
        assert!(!relays(&sessions, BridgeRole::Browser, "browser"));
        assert_eq!(next(&mut host), "none");

        with_session(&sessions, |session| {
            session.active = true;
            notify_ready(session);
        });

        assert_eq!(next(&mut host), r#"{"type":"ready","label":"browser-test"}"#);
        assert!(relays(&sessions, BridgeRole::Browser, "browser"));
    }

    #[test]
    fn desktop_return_requires_the_marked_session_and_current_host() {
        let sessions = sessions(true);
        let (_, _host) = connect(&sessions, BridgeRole::Host, "current-host");

        assert!(take_returning_session(&sessions, TOKEN, Some("current-host")).is_none());
        request_desktop_return(&sessions, "browser-test", DesktopReturnTarget::Native).unwrap();
        assert!(take_returning_session(&sessions, TOKEN, Some("stale-host")).is_none());
        assert!(take_returning_session(&sessions, TOKEN, Some("current-host")).is_some());
        assert!(sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn replacement_peer_revokes_the_previous_socket() {
        let sessions = sessions(true);
        let (_, mut host) = connect(&sessions, BridgeRole::Host, "host");
        let (_, mut first) = connect(&sessions, BridgeRole::Browser, "first");
        drain(&mut [&mut host, &mut first]);

        let (_, _second) = connect(&sessions, BridgeRole::Browser, "second");

        assert_eq!(next(&mut first), control("browser-replaced"));
        assert_eq!(next(&mut first), "close");
        assert_eq!(next(&mut host), control("browser-reset"));
        assert!(!relays(&sessions, BridgeRole::Browser, "first"));
        assert!(relays(&sessions, BridgeRole::Browser, "second"));
    }

    #[test]
    fn desktop_reconnect_cancels_the_disconnected_desktop_grace_timer() {
        let sessions = sessions(true);
        let (_, mut host) = connect(&sessions, BridgeRole::Host, "host");
        let (_, _desktop) = connect(&sessions, BridgeRole::Desktop, "desktop");
        let epoch = detach_with_grace(&sessions, BridgeRole::Desktop, "desktop");
        let (_, mut reconnected) = connect(&sessions, BridgeRole::Desktop, "desktop-reconnected");
        drain(&mut [&mut host, &mut reconnected]);

        assert!(settle_browser_session(&sessions, TOKEN, epoch, false).is_none());
        assert_eq!(next(&mut host), "none");
        assert_eq!(next(&mut reconnected), "none");
    }

    #[test]
    fn external_browser_parks_and_then_resumes_bundled_chromium() {
        let sessions = sessions(true);
        let (_, mut host) = connect(&sessions, BridgeRole::Host, "host");
        let (_, mut desktop) = connect(&sessions, BridgeRole::Desktop, "desktop");
        drain(&mut [&mut host, &mut desktop]);

        let (registration, _browser) = connect(&sessions, BridgeRole::Browser, "browser");
        assert!(registration.hide_desktop);
        assert_eq!(next(&mut desktop), control("desktop-suspended"));
        assert!(!relays(&sessions, BridgeRole::Desktop, "desktop"));

        let epoch = detach_with_grace(&sessions, BridgeRole::Browser, "browser");
        let (_, mut reconnected) = connect(&sessions, BridgeRole::Desktop, "desktop-reconnected");
        assert_eq!(
            with_session(&sessions, |session| session.visible_epoch),
            epoch,
            "a parked desktop reload must not cancel browser-close recovery"
        );
        drain(&mut [&mut host, &mut reconnected]);
        assert!(matches!(
            settle_browser_session(&sessions, TOKEN, epoch, true),
            Some(SessionSettlement::ResumeDesktop(label)) if label == "browser-test"
        ));
        assert_eq!(next(&mut host), control("browser-reset"));
        assert_eq!(next(&mut reconnected), control("desktop-resumed"));
        assert!(relays(&sessions, BridgeRole::Desktop, "desktop-reconnected"));
    }

    #[test]
    fn explicit_desktop_return_restores_bundled_chromium_without_retiring_its_session() {
        let sessions = sessions(true);
        let (_, mut host) = connect(&sessions, BridgeRole::Host, "host");
        let (_, mut desktop) = connect(&sessions, BridgeRole::Desktop, "desktop");
        let (_, mut browser) = connect(&sessions, BridgeRole::Browser, "browser");
        drain(&mut [&mut host, &mut desktop, &mut browser]);
        // Browser takeover asks the parked Chromium page to reload. The
        // explicit return can arrive during the resulting socket gap.
        with_session(&sessions, |session| session.desktop = None);
        request_desktop_return(&sessions, "browser-test", DesktopReturnTarget::Bundled).unwrap();

        assert!(matches!(
            take_returning_session(&sessions, TOKEN, Some("host")),
            Some(DesktopReturn::PendingBundled)
        ));
        with_session(&sessions, |session| {
            assert!(session.browser.is_some());
            assert!(session.desktop_return.as_ref().unwrap().acknowledged);
        });

        let (registration, mut reconnected) =
            connect(&sessions, BridgeRole::Desktop, "desktop-reconnected");
        assert!(registration.complete_desktop_return);
        drain(&mut [&mut host, &mut browser, &mut reconnected]);
        assert!(matches!(
            take_returning_session(&sessions, TOKEN, None),
            Some(DesktopReturn::Bundled(label)) if label == "browser-test"
        ));

        with_session(&sessions, |session| {
            assert!(session.browser.is_none());
            assert!(session.desktop.is_some());
            assert!(session.desktop_return.is_none());
        });
        assert_eq!(next(&mut browser), control("desktop-returned"));
        assert_eq!(next(&mut browser), "close");
        assert_eq!(next(&mut host), control("browser-reset"));
        assert_eq!(next(&mut reconnected), control("desktop-resumed"));
    }

    #[test]
    fn fixed_entry_resumes_a_live_token_and_replaces_a_stale_one() {
        let sessions = sessions(true);
        let sessions = sessions.lock().unwrap();
        for token in [TOKEN, "expired"] {
            let entry = reusable_entry_config(&sessions, 18452, Some(token)).unwrap();
            let config = (entry.token.as_str(), entry.bridge_port, entry.label.as_str());
            assert_eq!(config, (TOKEN, 18452, "browser-test"), "{token}");
        }
    }

    #[test]
    fn expiry_atomically_removes_only_the_disconnected_generation() {
        let sessions = sessions(true);
        let entry =
            |sessions: &Sessions| reusable_entry_config(&sessions.lock().unwrap(), 18452, None);

        assert!(settle_browser_session(&sessions, TOKEN, 1, false).is_none());
        assert!(entry(&sessions).is_some());

        assert!(matches!(
            settle_browser_session(&sessions, TOKEN, 0, false),
            Some(SessionSettlement::Expire(label)) if label == "browser-test"
        ));
        assert!(entry(&sessions).is_none());
    }
}
