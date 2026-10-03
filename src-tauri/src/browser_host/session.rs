//! The session table behind the browser bridge.
//!
//! Each session pairs one hidden native *host* WebView with the surfaces that
//! show it: the bundled-Chromium window (*desktop*) and the writer's default
//! browser (*browser*). Both may be connected at once, but only the session's
//! *owner* relays IPC with the host. The other surface is parked (a Chromium
//! window hidden behind a standby page) or waiting to take over.
//!
//! Ownership moves by a handoff: the owner is asked to `yield`, saves, and
//! answers `yielded`; only then does the other surface take over. Two
//! surfaces therefore never edit the project at once, and an edit typed just
//! before the switch is saved rather than dropped. An owner that cannot save
//! answers `yield-failed`, or stays silent past the timeout, and keeps the
//! workspace with its unsaved buffer: the waiting surface is told
//! `handoff-refused` and can ask again. Only an owner that is gone, whose
//! edits no surface can save any more, loses the workspace without a yes.
//! `visible_epoch` counts ownership generations so a delayed grace timer can
//! tell whether anything reconnected in the meantime.
//!
//! A native WebKit window can also hand its workspace to a browser tab. That
//! session (`source_label`) relays nothing until the window has closed.
//!
//! Functions here only update the table and message peers; the caller applies
//! the returned app-level effects (windows, Chromium, Synara).

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

/// A surface that shows a workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Surface {
    Browser,
    Desktop,
}

impl Surface {
    fn other(self) -> Self {
        match self {
            Self::Browser => Self::Desktop,
            Self::Desktop => Self::Browser,
        }
    }
}

/// A switch of owner, waiting for the current owner to save.
pub(super) struct Handoff {
    to: Surface,
    id: u64,
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
    /// A bundled Chromium window shows (or showed) this workspace.
    pub(super) bundled_chromium: bool,
    // Ownership state: visible for struct-update construction only; change it
    // through the functions in this module.
    pub(super) owner: Option<Surface>,
    pub(super) handoff: Option<Handoff>,
    pub(super) handoff_serial: u64,
    /// When the browser asked to go back to a Chromium window that is still
    /// opening.
    pub(super) return_requested: Option<Instant>,
    pub(super) visible_epoch: u64,
    /// The native window handing this workspace to a browser tab.
    pub(super) source_label: Option<String>,
    pub(super) project_root: Option<PathBuf>,
    /// A handoff from a native window stays inactive (nothing is relayed)
    /// until that window has closed.
    pub(super) active: bool,
    /// The single-use nonce of the last default-browser entry address.
    pub(super) entry_nonce: Option<(String, Instant)>,
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
            owner: None,
            handoff: None,
            handoff_serial: 0,
            return_requested: None,
            visible_epoch: 0,
            source_label: None,
            project_root: None,
            active: true,
            entry_nonce: None,
        }
    }

    fn slot(&mut self, role: BridgeRole) -> &mut Option<Peer> {
        match role {
            BridgeRole::Browser => &mut self.browser,
            BridgeRole::Desktop => &mut self.desktop,
            BridgeRole::Host => &mut self.host,
        }
    }

    fn peer(&self, surface: Surface) -> Option<&Peer> {
        match surface {
            Surface::Browser => self.browser.as_ref(),
            Surface::Desktop => self.desktop.as_ref(),
        }
    }

    fn owner_peer(&self) -> Option<&Peer> {
        self.owner.and_then(|owner| self.peer(owner))
    }

    fn take_ownership(&mut self, surface: Surface) {
        let reset_host = self.visible_epoch != 0;
        self.visible_epoch = self.visible_epoch.wrapping_add(1);
        self.owner = Some(surface);
        if reset_host {
            notify(self.host.as_ref(), "browser-reset");
        }
    }

    /// Ask the owner to save and yield to `to`; returns the handoff's id.
    fn start_handoff(&mut self, to: Surface) -> u64 {
        if let Some(handoff) = self.handoff.as_ref().filter(|handoff| handoff.to == to) {
            return handoff.id;
        }
        self.handoff_serial += 1;
        let id = self.handoff_serial;
        self.handoff = Some(Handoff { to, id });
        notify(self.peer(to.other()), "yield");
        id
    }

    /// Give up the pending handoff: the owner keeps the workspace, and the
    /// surface that waited for it is told so it can ask again.
    fn refuse_handoff(&mut self) {
        if let Some(handoff) = self.handoff.take() {
            notify(self.peer(handoff.to), "handoff-refused");
        }
    }

    /// Hand the workspace to the surface handoff `id` is for, if it is still
    /// pending and that surface is still connected.
    fn complete_handoff(&mut self, id: u64) -> Option<Effect> {
        if self.handoff.as_ref().is_none_or(|handoff| handoff.id != id) {
            return None;
        }
        let to = self.handoff.take()?.to;
        self.peer(to)?;
        Some(self.switch_to(to))
    }

    fn switch_to(&mut self, to: Surface) -> Effect {
        self.take_ownership(to);
        match to {
            Surface::Browser => {
                // The Chromium page reloads into its standby screen.
                notify(self.desktop.as_ref(), "desktop-suspended");
                notify_ready(self);
                Effect::Parked
            }
            Surface::Desktop => {
                if let Some(browser) = self.browser.take() {
                    notify(Some(&browser), "desktop-returned");
                    browser.close();
                }
                // The Chromium page reloads into the full workspace, which
                // registers again and is then told it is ready.
                notify(self.desktop.as_ref(), "desktop-resumed");
                Effect::Resumed
            }
        }
    }

    /// Attach a visible peer: take over a workspace nobody else is showing,
    /// or wait behind the surface that is.
    fn attach(&mut self, surface: Surface, peer: Peer) -> Option<Effect> {
        if surface == Surface::Desktop {
            self.bundled_chromium = true;
        }
        let role = match surface {
            Surface::Browser => BridgeRole::Browser,
            Surface::Desktop => BridgeRole::Desktop,
        };
        if let Some(previous) = self.slot(role).replace(peer) {
            if surface == Surface::Browser {
                notify(Some(&previous), "browser-replaced");
            }
            previous.close();
        }
        let other = surface.other();
        let other_holds =
            self.owner == Some(other) && (self.peer(other).is_some() || other == Surface::Browser);
        if !other_holds {
            self.take_ownership(surface);
            // A reloaded owner page was not the one asked to yield.
            if self.handoff.as_ref().is_some_and(|handoff| handoff.to == other) {
                notify(self.peer(surface), "yield");
            }
            return None;
        }
        let return_requested = self
            .return_requested
            .take()
            .is_some_and(|requested_at| requested_at.elapsed() < RETURN_REQUEST_TTL);
        match surface {
            Surface::Browser => Some(Effect::HandoffStarted(self.start_handoff(Surface::Browser))),
            Surface::Desktop if return_requested => {
                Some(Effect::HandoffStarted(self.start_handoff(Surface::Desktop)))
            }
            Surface::Desktop => {
                notify(self.desktop.as_ref(), "desktop-suspended");
                None
            }
        }
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

impl BridgeRole {
    fn surface(self) -> Option<Surface> {
        match self {
            Self::Browser => Some(Surface::Browser),
            Self::Desktop => Some(Surface::Desktop),
            Self::Host => None,
        }
    }
}

/// What the caller must do after a session change.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Effect {
    /// The owner was asked to yield: settle handoff `id` after a timeout if
    /// it never answers (see [`finish_handoff`]).
    HandoffStarted(u64),
    /// A browser tab took over: hide the Chromium window.
    Parked,
    /// The Chromium window took over again: show it.
    Resumed,
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

/// How long a "Return to desktop" waits for the Chromium window it opened.
const RETURN_REQUEST_TTL: Duration = Duration::from_secs(30);

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

/// Reuse a live token on reload, the workspace an unexpired entry nonce was
/// issued for (consuming it), and the newest fixed-entry workspace otherwise. The latter is what makes the bookmarked address open the
/// workspace the Lattice window shows, and makes a second tab replace the
/// first instead of opening the same project in two independent hosts.
pub(super) fn reusable_entry_config(
    sessions: &mut HashMap<String, BrowserSession>, port: u16, resume_token: Option<&str>,
    entry_nonce: Option<&str>,
) -> Option<BrowserSessionConfig> {
    if let Some((token, session)) = resume_token.and_then(|token| sessions.get_key_value(token)) {
        return Some(BrowserSessionConfig::new(token, session, port));
    }
    if let Some((token, session)) = entry_nonce.and_then(|nonce| {
        sessions.iter_mut().find(|(_, session)| {
            session.entry_nonce.as_ref().is_some_and(|(issued, _)| issued == nonce)
        })
    }) {
        let (_, issued_at) = session.entry_nonce.take()?;
        if issued_at.elapsed() < ENTRY_NONCE_TTL {
            return Some(BrowserSessionConfig::new(token, session, port));
        }
    }
    sessions
        .iter()
        .filter(|(_, session)| session.entry_session)
        .max_by_key(|(_, session)| session.created_at)
        .map(|(token, session)| BrowserSessionConfig::new(token, session, port))
}

/// Attach a peer, or None when the token is unknown. The inner value is what
/// the caller must apply.
pub(super) fn register_peer(
    sessions: &Sessions, query: &BridgeQuery, peer_id: &str, sender: mpsc::UnboundedSender<Message>,
) -> Option<Option<Effect>> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(&query.token)?;
    let peer = Peer { id: peer_id.to_string(), sender };
    let effect = match query.role.surface() {
        Some(surface) => session.attach(surface, peer),
        None => {
            if let Some(previous) = session.host.replace(peer) {
                previous.close();
            }
            None
        }
    };
    // A peer that only waits or stays parked changes nothing for the pair
    // that relays, and a repeated ready would re-send the host's storage.
    if query.role == BridgeRole::Host || session.owner_peer().is_some_and(|peer| peer.id == peer_id)
    {
        notify_ready(session);
    }
    Some(effect)
}

fn notify_ready(session: &BrowserSession) {
    if !session.active {
        return;
    }
    let (Some(host), Some(visible)) = (&session.host, session.owner_peer()) else {
        return;
    };
    let ready =
        Message::Text(format!(r#"{{"type":"ready","label":"{}"}}"#, session.host_label).into());
    host.send(ready.clone());
    visible.send(ready);
}

/// Start relaying a native window's handoff once that window has closed.
pub(super) fn activate(session: &mut BrowserSession) {
    session.active = true;
    notify_ready(session);
}

/// The peer that should receive a message from `peer_id`, if that peer is
/// the current one for its role and its surface owns the session.
pub(super) fn other_peer(
    sessions: &Sessions, query: &BridgeQuery, peer_id: &str,
) -> Option<mpsc::UnboundedSender<Message>> {
    let sessions = sessions.lock().ok()?;
    let session = sessions.get(&query.token).filter(|session| session.active)?;
    let (source, target) = match query.role.surface() {
        Some(surface) if session.owner == Some(surface) => {
            (session.peer(surface), session.host.as_ref())
        }
        // A parked or waiting surface stays silent.
        Some(_) => return None,
        None => (session.host.as_ref(), session.owner_peer()),
    };
    if source?.id != peer_id {
        return None;
    }
    target.map(|peer| peer.sender.clone())
}

/// The owner answered `yield`: it has saved, so the waiting surface takes over.
pub(super) fn yielded(sessions: &Sessions, query: &BridgeQuery, peer_id: &str) -> Option<Effect> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(&query.token)?;
    let surface = query.role.surface()?;
    if session.owner != Some(surface) || session.peer(surface)?.id != peer_id {
        return None;
    }
    let id = session.handoff.as_ref()?.id;
    session.complete_handoff(id)
}

/// The owner answered `yield` with `yield-failed`: some edit is still unsaved,
/// so it keeps the workspace.
pub(super) fn yield_failed(sessions: &Sessions, query: &BridgeQuery, peer_id: &str) {
    let Ok(mut sessions) = sessions.lock() else {
        return;
    };
    let Some(session) = sessions.get_mut(&query.token) else {
        return;
    };
    let owner_answered = query.role.surface().is_some_and(|surface| {
        session.owner == Some(surface) && session.peer(surface).is_some_and(|peer| peer.id == peer_id)
    });
    if owner_answered {
        session.refuse_handoff();
    }
}

/// How a handoff the owner never answered ends.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum HandoffTimeout {
    /// The owner is still connected, so its edits may still be unsaved: it
    /// keeps the workspace and the waiting surface is told.
    Kept,
    /// The owner is gone, and its edits with it: the waiting surface takes over.
    Switched(Effect),
}

/// The yield timeout passed for handoff `id`; None when it is no longer pending.
pub(super) fn finish_handoff(sessions: &Sessions, token: &str, id: u64) -> Option<HandoffTimeout> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(token)?;
    if session.handoff.as_ref()?.id != id {
        return None;
    }
    // A slow or wedged save is not a lost one: switching now would close or
    // reload a page that may hold the only copy of an edit.
    if session.owner_peer().is_some() {
        session.refuse_handoff();
        return Some(HandoffTimeout::Kept);
    }
    session.complete_handoff(id).map(HandoffTimeout::Switched)
}

/// The parked Chromium window asked to show the workspace again.
pub(super) fn reclaim(sessions: &Sessions, query: &BridgeQuery, peer_id: &str) -> Option<Effect> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(&query.token)?;
    if query.role != BridgeRole::Desktop
        || session.desktop.as_ref()?.id != peer_id
        || session.owner == Some(Surface::Desktop)
    {
        return None;
    }
    if session.browser.is_some() {
        return Some(Effect::HandoffStarted(session.start_handoff(Surface::Desktop)));
    }
    Some(session.switch_to(Surface::Desktop))
}

/// How a browser tab goes back to the desktop.
pub(super) enum ReturnPlan {
    /// The parked Chromium window takes over once the tab yields.
    Handoff(String, u64),
    /// Reopen the Chromium window, which takes over once it connects.
    OpenChromium,
    /// Open a native window, then end this session.
    Native(String),
}

pub(super) fn request_return(
    sessions: &Sessions, host_label: &str, chromium_running: bool,
) -> Result<ReturnPlan, String> {
    let mut sessions = lock(sessions)?;
    let (token, session) = sessions
        .iter_mut()
        .find(|(_, session)| session.host_label == host_label)
        .ok_or_else(|| "This browser workspace is no longer active.".to_string())?;
    if session.owner != Some(Surface::Browser) {
        return Err("This workspace is already open in the Lattice app.".to_string());
    }
    if session.desktop.is_some() {
        let id = session.start_handoff(Surface::Desktop);
        return Ok(ReturnPlan::Handoff(token.clone(), id));
    }
    if chromium_running {
        session.return_requested = Some(Instant::now());
        return Ok(ReturnPlan::OpenChromium);
    }
    Ok(ReturnPlan::Native(token.clone()))
}

/// End a session whose workspace now shows in a native window.
pub(super) fn finish_native_return(sessions: &Sessions, token: &str) -> Option<String> {
    let session = sessions.lock().ok()?.remove(token)?;
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
    let slot = session.slot(query.role);
    if slot.as_ref().map(|peer| peer.id.as_str()) != Some(peer_id) {
        return None;
    }
    *slot = None;
    match query.role.surface() {
        Some(surface) => {
            // A surface waiting to take over left: the owner keeps the workspace.
            if session.handoff.as_ref().is_some_and(|handoff| handoff.to == surface) {
                session.handoff = None;
            }
            (session.owner == Some(surface)).then_some(Detached::Grace(session.visible_epoch))
        }
        None => {
            notify(session.browser.as_ref(), "host-disconnected");
            notify(session.desktop.as_ref(), "host-disconnected");
            table.remove(&query.token);
            Some(Detached::SessionRemoved)
        }
    }
}

pub(super) enum Settlement {
    /// The owner is gone for good and the other surface took over: usually
    /// the tab closed and the parked Chromium window shows the workspace again.
    Switched(Effect),
    /// Nobody came back: retire the hidden host. `native_return` marks a
    /// workspace a native window handed to the tab, which reopens there.
    Expired { host_label: String, native_return: bool },
}

/// Settle a session whose owner did not come back during its grace period.
/// `None` leaves it as it is: the owner reconnected, or a newer generation
/// owns it.
pub(super) fn settle_after_grace(
    sessions: &Sessions, token: &str, visible_epoch: u64,
) -> Option<Settlement> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(token)?;
    if session.owner_peer().is_some() || session.visible_epoch != visible_epoch {
        return None;
    }
    if let Some(other) =
        session.owner.map(Surface::other).filter(|other| session.peer(*other).is_some())
    {
        // The surface that showed the workspace is gone for good, so the
        // other one takes over without waiting for a yield.
        session.handoff = None;
        return Some(Settlement::Switched(session.switch_to(other)));
    }
    let session = sessions.remove(token)?;
    Some(Settlement::Expired {
        native_return: session.source_label.is_some(),
        host_label: session.host_label,
    })
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

    /// Connects `id`, returning its socket and the effect the caller must apply.
    fn connect_with(
        sessions: &Sessions, role: BridgeRole, id: &str,
    ) -> (UnboundedReceiver<Message>, Option<Effect>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let effect = register_peer(sessions, &query(role), id, sender).expect("registered");
        (receiver, effect)
    }

    fn connect(sessions: &Sessions, role: BridgeRole, id: &str) -> UnboundedReceiver<Message> {
        connect_with(sessions, role, id).0
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

    /// A Chromium window showing the workspace, as after launch.
    fn chromium_workspace(
        sessions: &Sessions,
    ) -> (UnboundedReceiver<Message>, UnboundedReceiver<Message>) {
        let mut host = connect(sessions, BridgeRole::Host, "host");
        let mut desktop = connect(sessions, BridgeRole::Desktop, "window");
        drain(&mut [&mut host, &mut desktop]);
        (host, desktop)
    }

    /// The tab opened by "Open in browser" has taken over from the window.
    fn handed_to_browser(
        sessions: &Sessions,
    ) -> (UnboundedReceiver<Message>, UnboundedReceiver<Message>, UnboundedReceiver<Message>) {
        let (mut host, mut desktop) = chromium_workspace(sessions);
        let (mut browser, _) = connect_with(sessions, BridgeRole::Browser, "tab");
        assert_eq!(yielded(sessions, &query(BridgeRole::Desktop), "window"), Some(Effect::Parked));
        drain(&mut [&mut host, &mut desktop, &mut browser]);
        (host, desktop, browser)
    }

    #[test]
    fn host_and_visible_peer_are_told_they_are_ready_and_relay() {
        let sessions = sessions();
        let mut host = connect(&sessions, BridgeRole::Host, "host");
        assert_eq!(next(&mut host), "none");
        let mut browser = connect(&sessions, BridgeRole::Browser, "browser");

        assert_eq!(next(&mut host), READY);
        assert_eq!(next(&mut browser), READY);
        assert!(relays(&sessions, BridgeRole::Browser, "browser"));
        assert!(relays(&sessions, BridgeRole::Host, "host"));
    }

    #[test]
    fn opening_in_the_browser_waits_for_the_window_to_save_then_parks_it() {
        let sessions = sessions();
        let (mut host, mut desktop) = chromium_workspace(&sessions);

        let (mut browser, effect) = connect_with(&sessions, BridgeRole::Browser, "tab");
        assert!(matches!(effect, Some(Effect::HandoffStarted(_))));
        // Until the window has saved, it keeps the workspace and the tab waits.
        assert_eq!(all(&mut desktop), [control("yield")]);
        assert_eq!(next(&mut browser), "none");
        assert!(relays(&sessions, BridgeRole::Desktop, "window"));
        assert!(!relays(&sessions, BridgeRole::Browser, "tab"));

        assert_eq!(yielded(&sessions, &query(BridgeRole::Desktop), "window"), Some(Effect::Parked));
        assert_eq!(all(&mut desktop), [control("desktop-suspended")]);
        assert_eq!(all(&mut host), [control("browser-reset"), READY.to_string()]);
        assert_eq!(all(&mut browser), [READY]);
        assert!(relays(&sessions, BridgeRole::Browser, "tab"));
        assert!(!relays(&sessions, BridgeRole::Desktop, "window"));
        assert!(relays(&sessions, BridgeRole::Host, "host"));

        // The parked page reloads into its standby screen without a grace
        // timer and without disturbing the pair that relays.
        assert!(detach_peer(&sessions, &query(BridgeRole::Desktop), "window").is_none());
        let mut standby = connect(&sessions, BridgeRole::Desktop, "standby");
        assert_eq!(all(&mut standby), [control("desktop-suspended")]);
        assert_eq!(next(&mut host), "none");
        assert_eq!(next(&mut browser), "none");
    }

    #[test]
    fn returning_to_the_desktop_waits_for_the_tab_to_save_then_shows_the_window() {
        let sessions = sessions();
        let (mut host, mut desktop, mut browser) = handed_to_browser(&sessions);

        let Ok(ReturnPlan::Handoff(token, id)) = request_return(&sessions, "browser-test", true)
        else {
            panic!("a parked window takes the workspace back by a handoff");
        };
        assert_eq!((token.as_str(), next(&mut browser)), (TOKEN, control("yield")));
        assert!(relays(&sessions, BridgeRole::Browser, "tab"));

        assert_eq!(yielded(&sessions, &query(BridgeRole::Browser), "tab"), Some(Effect::Resumed));
        assert_eq!(all(&mut browser), [control("desktop-returned"), "close".to_string()]);
        assert_eq!(all(&mut desktop), [control("desktop-resumed")]);
        assert_eq!(next(&mut host), control("browser-reset"));
        assert!(finish_handoff(&sessions, TOKEN, id).is_none(), "the timeout is stale now");

        // The window reloads into the full workspace and relays again.
        let mut workspace = connect(&sessions, BridgeRole::Desktop, "workspace");
        assert_eq!(all(&mut workspace), [READY]);
        assert!(relays(&sessions, BridgeRole::Desktop, "workspace"));
        assert!(request_return(&sessions, "browser-test", true).is_err());
    }

    #[test]
    fn closing_the_tab_brings_the_parked_window_back_after_the_grace_period() {
        let sessions = sessions();
        let (_host, mut desktop, _browser) = handed_to_browser(&sessions);

        let epoch = detach_with_grace(&sessions, BridgeRole::Browser, "tab");
        assert!(matches!(
            settle_after_grace(&sessions, TOKEN, epoch),
            Some(Settlement::Switched(Effect::Resumed))
        ));
        assert_eq!(all(&mut desktop), [control("desktop-resumed")]);
    }

    #[test]
    fn reloading_the_tab_keeps_the_workspace_in_the_browser() {
        let sessions = sessions();
        let (_host, mut desktop, _browser) = handed_to_browser(&sessions);

        let epoch = detach_with_grace(&sessions, BridgeRole::Browser, "tab");
        let (mut reloaded, effect) = connect_with(&sessions, BridgeRole::Browser, "reloaded");
        assert_eq!(effect, None);
        assert_eq!(all(&mut reloaded), [READY]);
        assert!(settle_after_grace(&sessions, TOKEN, epoch).is_none());
        assert_eq!(next(&mut desktop), "none");
    }

    #[test]
    fn a_connected_window_that_never_answers_keeps_the_workspace() {
        let sessions = sessions();
        let (_host, mut desktop) = chromium_workspace(&sessions);
        let (mut browser, effect) = connect_with(&sessions, BridgeRole::Browser, "tab");
        let Some(Effect::HandoffStarted(id)) = effect else { panic!("handoff expected") };
        drain(&mut [&mut desktop]);

        assert!(finish_handoff(&sessions, TOKEN, id + 1).is_none());
        // Its save may still be running: closing it now could drop an edit.
        assert_eq!(finish_handoff(&sessions, TOKEN, id), Some(HandoffTimeout::Kept));
        assert_eq!(next(&mut desktop), "none");
        assert_eq!(all(&mut browser), [control("handoff-refused")]);
        assert!(relays(&sessions, BridgeRole::Desktop, "window"));
        assert!(!relays(&sessions, BridgeRole::Browser, "tab"));

        // A save that finishes after the timeout no longer switches anything.
        assert!(yielded(&sessions, &query(BridgeRole::Desktop), "window").is_none());
        assert!(relays(&sessions, BridgeRole::Desktop, "window"));
    }

    #[test]
    fn a_window_gone_before_the_timeout_is_switched() {
        let sessions = sessions();
        let (_host, _desktop) = chromium_workspace(&sessions);
        let (_browser, effect) = connect_with(&sessions, BridgeRole::Browser, "tab");
        let Some(Effect::HandoffStarted(id)) = effect else { panic!("handoff expected") };

        detach_with_grace(&sessions, BridgeRole::Desktop, "window");
        assert_eq!(
            finish_handoff(&sessions, TOKEN, id),
            Some(HandoffTimeout::Switched(Effect::Parked))
        );
        assert!(relays(&sessions, BridgeRole::Browser, "tab"));
    }

    #[test]
    fn a_window_that_cannot_save_keeps_the_workspace_and_the_tab_may_ask_again() {
        let sessions = sessions();
        let (_host, mut desktop) = chromium_workspace(&sessions);
        let (mut browser, effect) = connect_with(&sessions, BridgeRole::Browser, "tab");
        let Some(Effect::HandoffStarted(id)) = effect else { panic!("handoff expected") };
        drain(&mut [&mut desktop]);

        // Only the owner's current page can refuse.
        yield_failed(&sessions, &query(BridgeRole::Browser), "tab");
        yield_failed(&sessions, &query(BridgeRole::Desktop), "stale");
        assert_eq!(next(&mut browser), "none");

        yield_failed(&sessions, &query(BridgeRole::Desktop), "window");
        assert_eq!(all(&mut browser), [control("handoff-refused")]);
        assert_eq!(next(&mut desktop), "none");
        assert!(relays(&sessions, BridgeRole::Desktop, "window"));
        assert!(!relays(&sessions, BridgeRole::Browser, "tab"));
        assert!(finish_handoff(&sessions, TOKEN, id).is_none(), "the timeout is stale now");
        assert!(yielded(&sessions, &query(BridgeRole::Desktop), "window").is_none());

        // Trying again (the tab reloads) starts a new handoff.
        let (mut retry, effect) = connect_with(&sessions, BridgeRole::Browser, "tab-2");
        assert!(matches!(effect, Some(Effect::HandoffStarted(next_id)) if next_id != id));
        assert_eq!(all(&mut desktop), [control("yield")]);
        assert_eq!(yielded(&sessions, &query(BridgeRole::Desktop), "window"), Some(Effect::Parked));
        assert_eq!(all(&mut retry), [READY]);
    }

    #[test]
    fn a_tab_that_cannot_save_keeps_the_workspace_from_the_window() {
        let sessions = sessions();
        let (_host, mut desktop, mut browser) = handed_to_browser(&sessions);

        let Ok(ReturnPlan::Handoff(_, id)) = request_return(&sessions, "browser-test", true) else {
            panic!("a parked window takes the workspace back by a handoff");
        };
        assert_eq!(next(&mut browser), control("yield"));
        yield_failed(&sessions, &query(BridgeRole::Browser), "tab");
        assert_eq!(all(&mut desktop), [control("handoff-refused")]);
        assert_eq!(next(&mut browser), "none");
        assert!(relays(&sessions, BridgeRole::Browser, "tab"));
        assert!(finish_handoff(&sessions, TOKEN, id).is_none());

        // The same holds when the tab stays silent past the timeout.
        assert!(matches!(
            reclaim(&sessions, &query(BridgeRole::Desktop), "window"),
            Some(Effect::HandoffStarted(_))
        ));
        let Some(id) = sessions.lock().unwrap()[TOKEN].handoff.as_ref().map(|handoff| handoff.id)
        else {
            panic!("reclaim starts a handoff");
        };
        assert_eq!(next(&mut browser), control("yield"));
        assert_eq!(finish_handoff(&sessions, TOKEN, id), Some(HandoffTimeout::Kept));
        assert_eq!(all(&mut desktop), [control("handoff-refused")]);
        assert!(relays(&sessions, BridgeRole::Browser, "tab"));
    }

    #[test]
    fn a_tab_that_leaves_before_the_switch_leaves_the_window_in_charge() {
        let sessions = sessions();
        let (_host, _desktop) = chromium_workspace(&sessions);
        let (_browser, effect) = connect_with(&sessions, BridgeRole::Browser, "tab");
        let Some(Effect::HandoffStarted(id)) = effect else { panic!("handoff expected") };

        assert!(detach_peer(&sessions, &query(BridgeRole::Browser), "tab").is_none());
        assert!(yielded(&sessions, &query(BridgeRole::Desktop), "window").is_none());
        assert!(finish_handoff(&sessions, TOKEN, id).is_none());
        assert!(relays(&sessions, BridgeRole::Desktop, "window"));
    }

    #[test]
    fn the_parked_window_can_take_the_workspace_back() {
        let sessions = sessions();
        let (_host, mut desktop, mut browser) = handed_to_browser(&sessions);
        // Only the parked window may ask, and it must be the current page.
        assert!(reclaim(&sessions, &query(BridgeRole::Browser), "tab").is_none());
        assert!(reclaim(&sessions, &query(BridgeRole::Desktop), "stale").is_none());

        assert!(matches!(
            reclaim(&sessions, &query(BridgeRole::Desktop), "window"),
            Some(Effect::HandoffStarted(_))
        ));
        assert_eq!(next(&mut browser), control("yield"));
        assert_eq!(yielded(&sessions, &query(BridgeRole::Browser), "tab"), Some(Effect::Resumed));
        assert_eq!(all(&mut desktop), [control("desktop-resumed")]);

        // With the tab already gone, the window takes it back at once.
        let sessions = self::sessions();
        let (_host, mut desktop, _browser) = handed_to_browser(&sessions);
        detach_with_grace(&sessions, BridgeRole::Browser, "tab");
        assert_eq!(
            reclaim(&sessions, &query(BridgeRole::Desktop), "window"),
            Some(Effect::Resumed)
        );
        assert_eq!(all(&mut desktop), [control("desktop-resumed")]);
    }

    #[test]
    fn returning_reopens_a_closed_chromium_window_which_then_takes_over() {
        let sessions = sessions();
        let _host = connect(&sessions, BridgeRole::Host, "host");
        let mut browser = connect(&sessions, BridgeRole::Browser, "bookmark");
        drain(&mut [&mut browser]);

        assert!(matches!(
            request_return(&sessions, "browser-test", true),
            Ok(ReturnPlan::OpenChromium)
        ));
        let (mut window, effect) = connect_with(&sessions, BridgeRole::Desktop, "window");
        assert!(matches!(effect, Some(Effect::HandoffStarted(_))));
        assert_eq!(next(&mut browser), control("yield"));
        assert_eq!(next(&mut window), "none");
        assert_eq!(
            yielded(&sessions, &query(BridgeRole::Browser), "bookmark"),
            Some(Effect::Resumed)
        );
        assert_eq!(all(&mut window), [control("desktop-resumed")]);
    }

    #[test]
    fn opening_the_window_while_a_tab_holds_the_workspace_shows_its_standby_screen() {
        let sessions = sessions();
        let _host = connect(&sessions, BridgeRole::Host, "host");
        let _browser = connect(&sessions, BridgeRole::Browser, "bookmark");

        let (mut window, effect) = connect_with(&sessions, BridgeRole::Desktop, "window");
        assert_eq!(effect, None);
        assert_eq!(all(&mut window), [control("desktop-suspended")]);
        assert!(relays(&sessions, BridgeRole::Browser, "bookmark"));
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

        let Ok(ReturnPlan::Native(token)) = request_return(&sessions, "browser-test", false) else {
            panic!("without Chromium the workspace returns to a native window");
        };
        assert_eq!(finish_native_return(&sessions, &token).as_deref(), Some("browser-test"));
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
            Some(Settlement::Expired { native_return: true, .. })
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
    }

    #[test]
    fn desktop_reconnect_cancels_the_disconnected_desktop_grace_timer() {
        let sessions = sessions();
        let (mut host, _desktop) = chromium_workspace(&sessions);
        let epoch = detach_with_grace(&sessions, BridgeRole::Desktop, "window");
        let mut reconnected = connect(&sessions, BridgeRole::Desktop, "window-reconnected");
        drain(&mut [&mut host, &mut reconnected]);

        assert!(settle_after_grace(&sessions, TOKEN, epoch).is_none());
        assert!(relays(&sessions, BridgeRole::Desktop, "window-reconnected"));
    }

    #[test]
    fn host_disconnect_ends_the_session_and_tells_every_visible_peer() {
        let sessions = sessions();
        let (_host, mut desktop, mut browser) = handed_to_browser(&sessions);

        assert!(matches!(
            detach_peer(&sessions, &query(BridgeRole::Host), "host"),
            Some(Detached::SessionRemoved)
        ));
        assert_eq!(next(&mut browser), control("host-disconnected"));
        assert_eq!(next(&mut desktop), control("host-disconnected"));
        assert!(sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn fixed_entry_resumes_a_live_token_and_replaces_a_stale_one() {
        let sessions = sessions();
        let mut sessions = sessions.lock().unwrap();
        for token in [TOKEN, "expired"] {
            let entry = reusable_entry_config(&mut sessions, 18452, Some(token), None).unwrap();
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
            reusable_entry_config(&mut sessions.lock().unwrap(), 18452, None, Some(entry))
                .map(|config| config.token)
        };

        let nonce = issue_entry_nonce(&sessions, "project-tab").unwrap();
        let url = entry_url("http://127.0.0.1:18452", &nonce);
        assert_eq!(url, format!("http://127.0.0.1:18452/?entry={nonce}"));
        assert!(!url.contains("project-tab") && !url.contains("browser-project"), "{url}");

        assert_eq!(claim("browser-project").as_deref(), Some(TOKEN), "a label is no selector");
        assert_eq!(claim(&nonce).as_deref(), Some("project-tab"));
        assert_eq!(claim(&nonce).as_deref(), Some(TOKEN), "a nonce claims only once");

        let reissued = issue_entry_nonce(&sessions, "project-tab").unwrap();
        assert_ne!(reissued, nonce);
        assert_eq!(claim(&nonce).as_deref(), Some(TOKEN), "a used nonce is not revived");

        let stale = issue_entry_nonce(&sessions, "project-tab").unwrap();
        let issued_at = Instant::now().checked_sub(ENTRY_NONCE_TTL).unwrap();
        sessions.lock().unwrap().get_mut("project-tab").unwrap().entry_nonce =
            Some((stale.clone(), issued_at));
        assert_eq!(claim(&stale).as_deref(), Some(TOKEN), "an expired nonce selects nothing");
        assert!(issue_entry_nonce(&sessions, "gone").is_err());
    }

    #[test]
    fn a_window_reconnecting_while_the_tab_is_away_stays_parked_until_the_grace_settles() {
        let sessions = sessions();
        let (_host, _desktop, _browser) = handed_to_browser(&sessions);
        let epoch = detach_with_grace(&sessions, BridgeRole::Browser, "tab");
        assert!(detach_peer(&sessions, &query(BridgeRole::Desktop), "window").is_none());

        let (mut desktop, effect) = connect_with(&sessions, BridgeRole::Desktop, "window-2");
        assert_eq!(effect, None);
        assert_eq!(all(&mut desktop), vec![control("desktop-suspended")]);
        assert!(!relays(&sessions, BridgeRole::Desktop, "window-2"));

        assert!(matches!(
            settle_after_grace(&sessions, TOKEN, epoch),
            Some(Settlement::Switched(Effect::Resumed))
        ));
        assert_eq!(next(&mut desktop), control("desktop-resumed"));
    }

    #[test]
    fn a_stale_return_request_does_not_take_the_workspace_from_the_tab() {
        let sessions = sessions();
        let (_host, _desktop, mut browser) = handed_to_browser(&sessions);
        assert!(detach_peer(&sessions, &query(BridgeRole::Desktop), "window").is_none());
        assert!(matches!(
            request_return(&sessions, "browser-test", true),
            Ok(ReturnPlan::OpenChromium)
        ));
        sessions.lock().unwrap().get_mut(TOKEN).unwrap().return_requested =
            Instant::now().checked_sub(RETURN_REQUEST_TTL);

        let (mut desktop, effect) = connect_with(&sessions, BridgeRole::Desktop, "window-2");
        assert_eq!(effect, None);
        assert_eq!(all(&mut desktop), vec![control("desktop-suspended")]);
        assert_eq!(next(&mut browser), "none");
        assert!(sessions.lock().unwrap()[TOKEN].return_requested.is_none());
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
        let entry = |sessions: &Sessions| {
            reusable_entry_config(&mut sessions.lock().unwrap(), 18452, None, None)
        };

        assert!(settle_after_grace(&sessions, TOKEN, 1).is_none());
        assert!(entry(&sessions).is_some());

        assert!(matches!(
            settle_after_grace(&sessions, TOKEN, 0),
            Some(Settlement::Expired { host_label, native_return: false }) if host_label == "browser-test"
        ));
        assert!(entry(&sessions).is_none());
    }
}
