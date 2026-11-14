//! One window's link to Overleaf (`use-overleaf-workspace.ts`,
//! `overleaf-live-poll.ts`): whether the open project is linked and may sync
//! with the signed-in account, its syncs (asked for, and in live mode on
//! their own), the channel that joins the project, manual mode's badge, and
//! what a finished sync leaves the writer to know or do.
//!
//! - Live mode asks Overleaf every 3 s whether its history moved (a small
//!   JSON probe) and syncs only on a yes, no more than once per 12 s; without
//!   a version to compare it syncs every two minutes; a 429 backs it off
//!   sharply. A change here (a save, an outside edit) syncs after 2.5 s of
//!   quiet, once a probe that also reads the files here says something
//!   differs, so a build's outputs or a sync's own writes never cost a
//!   project download.
//! - Manual mode never syncs on its own: it probes every 30 s and badges the
//!   toolbar's button when Overleaf has work this project has not pulled.
//! - A sync's files changed on disk reach the editors, the tree and the PDF
//!   through the project's watcher, as any outside edit does; the bridge
//!   tells the window to build, opens the conflict resolver on a file left
//!   marked up, and records a version when something moved.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use futures::channel::oneshot;
use gpui::{App, AppContext as _, Context, EventEmitter, SharedString, Subscription, Task};
use lattice_core::overleaf::{OverleafLink, OverleafStatus, OverleafSyncResult};
use lattice_i18n::t;
use lattice_settings::OverleafSyncMode;
use lattice_ui::components::ToastLevel;

pub use super::channel::ChannelStatus;
use super::{
    channel::{self, ChannelNews},
    outcome, remote_deletes, sync,
};
use crate::notices::{self, Notice, NoticeAction};

mod live;

/// How often live mode asks Overleaf whether anything changed.
const LIVE_POLL: Duration = Duration::from_secs(3);
/// Cadence when Overleaf gives no cheap way to detect a change.
const BLIND_POLL: Duration = Duration::from_secs(120);
/// Floor between automatic syncs: Overleaf answers 429 past ten project
/// downloads a minute, and a collaborator typing moves the version on every
/// poll.
const MIN_SYNC_GAP: Duration = Duration::from_secs(12);
/// Quiet time after a change here before it is pushed up.
const PUSH_DEBOUNCE: Duration = Duration::from_millis(2_500);
/// How often manual mode checks for work on Overleaf.
const BADGE_POLL: Duration = Duration::from_secs(30);
/// The notice a sync's outcome replaces, one per window's project.
const SYNC_KEY: &str = "overleaf-sync";

/// The project's link, and whether the signed-in session may use it.
#[derive(Clone, Debug)]
pub struct LinkFor {
    pub link: OverleafLink,
    /// Signed in to the link's host, and not paused.
    pub active: bool,
}

/// Whether two Overleaf hosts are the same server (`overleafHostsMatch`).
pub fn hosts_match(left: &str, right: &str) -> bool {
    let canonical = |value: &str| {
        let trimmed = value.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            return String::new();
        }
        let lower = trimmed.to_lowercase();
        let rest = lower
            .strip_prefix("https://")
            .map(|rest| ("https:", rest))
            .or_else(|| lower.strip_prefix("http://").map(|rest| ("http:", rest)))
            .unwrap_or(("https:", lower.as_str()));
        let host = rest.1.split(['/', '?', '#']).next().unwrap_or_default();
        format!("{}//{host}", rest.0)
    };
    canonical(left) == canonical(right)
}

/// A link with no host of its own uses the session's
/// (`overleafLinkMatchesSession`).
pub fn link_matches_session(session_host: &str, link_host: &str) -> bool {
    link_host.trim().is_empty() || hosts_match(session_host, link_host)
}

/// The project's page on Overleaf, in the browser.
pub fn open_on_overleaf(link: &OverleafLink, cx: &mut App) {
    let host = link.host.trim().trim_end_matches('/');
    if host.is_empty() {
        notices::error(
            t!("Could not open the project because its Overleaf host is invalid."),
            "",
            cx,
        );
        return;
    }
    let id: String = link
        .project_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    cx.open_url(&format!("{host}/project/{id}"));
}

/// What the bridge tells the window.
pub enum OverleafBridgeEvent {
    /// A sync brought files in (or deleted some): the PDF should follow.
    Incoming,
    /// A file a sync left marked up: open the resolver on it.
    OpenConflict(String),
    /// The session ended: Settings › Overleaf is where to sign in again.
    OpenSettings,
}

#[derive(Clone, Copy, Default)]
pub struct SyncOptions {
    /// Live mode's own sync, rather than one the writer asked for.
    pub automatic: bool,
    /// The version a probe just saw, so the sync can skip the download when
    /// nothing moved past it.
    pub observed_remote_version: Option<i64>,
}

pub struct OverleafBridge {
    root: Option<PathBuf>,
    /// The project's link, read for `root`.
    link: Option<LinkFor>,
    /// The account's session as last read.
    status: Option<OverleafStatus>,
    /// Bumped by every read of the link, so a late answer is dropped.
    link_generation: u64,
    session_seen: u64,
    mode: OverleafSyncMode,
    syncing: bool,
    /// Manual mode's badge: Overleaf has work this project has not pulled.
    remote_changes: bool,
    channel: ChannelStatus,
    channel_detail: Option<SharedString>,
    /// The channel failure last toasted, until the channel joins again.
    toasted_failure: Option<String>,
    /// A sync already rejoined the failed channel once since it last joined.
    rejoined: bool,
    /// Every file's Overleaf id and kind by path, from the channel.
    entities: HashMap<String, (String, String)>,
    entity_list: Option<Vec<lattice_core::overleaf_rt::EntityEntry>>,
    /// A change here waits to be pushed.
    local_pending: bool,
    /// A sync failed in transit and is owed again.
    transport_retry: bool,
    /// Syncs Overleaf refused in a row while the session stayed valid.
    refusals: u32,
    last_auto_sync: Option<Instant>,
    /// Files the writer chose to keep on Overleaf when asked, for the
    /// session: the safe side of forgetting is a file left on Overleaf.
    declined_deletes: HashSet<(PathBuf, String)>,
    sync_task: Option<Task<()>>,
    /// Told how the running sync went (Review's Apply).
    sync_waiters: Vec<oneshot::Sender<Result<(), String>>>,
    /// Asked to hear how a sync went while another was running: told by the
    /// sync that starts once it ends, which carries what was saved since.
    queued_waiters: Vec<oneshot::Sender<Result<(), String>>>,
    poll_task: Option<Task<()>>,
    push_task: Option<Task<()>>,
    badge_task: Option<Task<()>>,
    channel_task: Option<Task<()>>,
    link_task: Option<Task<()>>,
    /// Staged by a scenario (`scenario_stage`): shown as linked and live,
    /// but nothing reads the link again or asks Overleaf anything.
    staged: bool,
    _settings: Subscription,
}

impl EventEmitter<OverleafBridgeEvent> for OverleafBridge {}

impl OverleafBridge {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let settings = cx.observe_global::<crate::settings::AppSettings>(|this, cx| {
            let mode = crate::settings::get(cx).overleaf_sync_mode;
            if mode != this.mode {
                this.mode = mode;
                this.apply(cx);
            }
        });
        Self {
            root: None,
            link: None,
            status: None,
            link_generation: 0,
            session_seen: super::session_generation(cx),
            mode: crate::settings::get(cx).overleaf_sync_mode,
            syncing: false,
            remote_changes: false,
            channel: ChannelStatus::Off,
            channel_detail: None,
            toasted_failure: None,
            rejoined: false,
            entities: HashMap::new(),
            entity_list: None,
            local_pending: false,
            transport_retry: false,
            refusals: 0,
            last_auto_sync: None,
            declined_deletes: HashSet::new(),
            sync_task: None,
            sync_waiters: Vec::new(),
            queued_waiters: Vec::new(),
            poll_task: None,
            push_task: None,
            badge_task: None,
            channel_task: None,
            link_task: None,
            staged: false,
            _settings: settings,
        }
    }

    /// The project's link, while the signed-in session may sync it.
    pub fn link(&self) -> Option<&OverleafLink> {
        self.link
            .as_ref()
            .filter(|link| link.active)
            .map(|link| &link.link)
    }

    /// The project has a link, active or not: a paused one is not offered
    /// for upload as a second Overleaf project.
    pub fn linked(&self) -> bool {
        self.link.is_some()
    }

    pub fn syncing(&self) -> bool {
        self.syncing
    }

    pub fn remote_changes(&self) -> bool {
        self.remote_changes
    }

    pub fn mode(&self) -> OverleafSyncMode {
        self.mode
    }

    /// The channel's state as the toolbar shows it: off in manual mode,
    /// where it carries no documents.
    pub fn channel(&self) -> ChannelStatus {
        if self.mode == OverleafSyncMode::Live {
            self.channel
        } else {
            ChannelStatus::Off
        }
    }

    pub fn channel_detail(&self) -> Option<&SharedString> {
        self.channel_detail.as_ref()
    }

    /// The window's project changed: nothing queued for one carries over.
    pub fn set_project(&mut self, root: Option<PathBuf>, cx: &mut Context<Self>) {
        if self.root == root {
            return;
        }
        self.root = root;
        self.link = None;
        self.remote_changes = false;
        self.local_pending = false;
        self.transport_retry = false;
        self.refusals = 0;
        self.entities.clear();
        self.entity_list = None;
        self.sync_task = None;
        self.sync_waiters.clear();
        self.queued_waiters.clear();
        self.syncing = false;
        self.toasted_failure = None;
        self.rejoined = false;
        self.stop(cx);
        self.reload_link(cx);
    }

    /// Stop the loops and the channel.
    fn stop(&mut self, cx: &mut Context<Self>) {
        self.poll_task = None;
        self.push_task = None;
        self.badge_task = None;
        self.channel_task = None;
        self.channel = ChannelStatus::Off;
        self.channel_detail = None;
        cx.notify();
    }

    /// Linked to `link`, signed in as `status`, the live channel up, with
    /// nothing asked of the network: the parity harness's linked project.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn scenario_stage(
        &mut self,
        status: OverleafStatus,
        link: OverleafLink,
        cx: &mut Context<Self>,
    ) {
        self.stop(cx);
        self.staged = true;
        self.sync_task = None;
        self.link_task = None;
        self.link_generation += 1;
        self.session_seen = super::session_generation(cx);
        self.status = Some(status);
        self.link = Some(LinkFor { link, active: true });
        self.channel = ChannelStatus::Live;
        cx.notify();
    }

    /// Read the project's link and the session again (after a sync, a
    /// change in Settings, a sign-in or out), then run what it calls for.
    pub fn reload_link(&mut self, cx: &mut Context<Self>) {
        if self.staged {
            return;
        }
        self.link_generation += 1;
        let generation = self.link_generation;
        let session = super::session_generation(cx);
        if session != self.session_seen && self.channel == ChannelStatus::Error {
            self.channel_task = None;
        }
        self.session_seen = session;
        let Some(root) = self.root.clone() else {
            self.link = None;
            self.stop(cx);
            return;
        };
        let read = cx.background_spawn(async move {
            let status = super::account::status().ok();
            let link = sync::link(&root).ok().flatten();
            (status, link)
        });
        self.link_task = Some(cx.spawn(async move |this, cx| {
            let (status, link) = read.await;
            this.update(cx, |this, cx| {
                if this.link_generation != generation {
                    return;
                }
                let session_host = status.as_ref().map(|s| s.host.clone()).unwrap_or_default();
                this.link = link.map(|mut link| {
                    if link.host.trim().is_empty() {
                        link.host = session_host.clone();
                    }
                    let active = status.as_ref().is_some_and(|status| status.connected)
                        && !link.paused
                        && link_matches_session(&session_host, &link.host);
                    LinkFor { link, active }
                });
                this.status = status;
                this.apply(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// The session changed somewhere (another window signed in or out, a
    /// request found it expired): read the link again.
    pub fn check_session(&mut self, cx: &mut Context<Self>) {
        if self.staged {
            return;
        }
        if super::session_generation(cx) != self.session_seen {
            self.reload_link(cx);
        }
    }

    /// Start what the link and the mode call for, and stop the rest.
    fn apply(&mut self, cx: &mut Context<Self>) {
        if self.staged {
            return;
        }
        let (Some(root), true) = (self.root.clone(), self.link().is_some()) else {
            self.stop(cx);
            self.remote_changes = false;
            return;
        };
        // The channel joins in either mode: it is what uploads need.
        if self.channel_task.is_none() {
            self.channel = ChannelStatus::Connecting;
            self.channel_detail = None;
            let this = cx.entity().downgrade();
            self.channel_task = Some(channel::hold(root.clone(), this, &cx.to_async()));
        }
        match self.mode {
            OverleafSyncMode::Live => {
                self.badge_task = None;
                self.remote_changes = false;
                if self.poll_task.is_none() {
                    self.poll_task = Some(self.live_poll(cx));
                }
            }
            OverleafSyncMode::Manual => {
                self.poll_task = None;
                self.push_task = None;
                if self.badge_task.is_none() {
                    self.badge_task = Some(self.badge_poll(root, cx));
                }
            }
        }
        cx.notify();
    }

    pub(super) fn channel_news(&mut self, news: ChannelNews, cx: &mut Context<Self>) {
        match news {
            ChannelNews::Joined { entities } => {
                self.note_entities(entities);
                self.channel = ChannelStatus::Live;
                self.channel_detail = None;
                self.toasted_failure = None;
                self.rejoined = false;
            }
            ChannelNews::Tree(entities) => self.note_entities(entities),
            ChannelNews::Reconnecting(detail) => {
                self.channel = ChannelStatus::Connecting;
                self.channel_detail = Some(detail.into());
            }
            ChannelNews::Failed(detail) => {
                let said = self.toasted_failure.as_deref() == Some(detail.as_str());
                self.channel = ChannelStatus::Error;
                self.channel_detail = Some(detail.clone().into());
                // A channel that could not start is otherwise invisible.
                if !said && self.mode == OverleafSyncMode::Live {
                    self.toasted_failure = Some(detail.clone());
                    notices::show(
                        Notice::new(
                            ToastLevel::Info,
                            t!(
                                "Live editing with Overleaf could not start ({detail}). Your project still syncs every few seconds.",
                                detail = &detail
                            ),
                        )
                        .key("overleaf-channel"),
                        cx,
                    );
                }
                self.check_session(cx);
            }
        }
        cx.notify();
    }

    fn note_entities(&mut self, entities: Vec<lattice_core::overleaf_rt::EntityEntry>) {
        self.entities = entities
            .iter()
            .map(|entity| {
                (
                    entity.path.clone(),
                    (entity.id.clone(), entity.kind.clone()),
                )
            })
            .collect();
        self.entity_list = Some(entities);
    }

    /// Sync now, or join the sync already running, and hear how it went:
    /// `Err` says why it failed or could not start.
    pub fn sync_reporting(
        &mut self,
        cx: &mut Context<Self>,
    ) -> oneshot::Receiver<Result<(), String>> {
        let (sender, receiver) = oneshot::channel();
        if self.staged {
            sender.send(Ok(())).ok();
            return receiver;
        }
        if self.syncing {
            self.queued_waiters.push(sender);
            return receiver;
        }
        self.sync(SyncOptions::default(), cx);
        self.attach_waiter(sender);
        receiver
    }

    fn attach_waiter(&mut self, sender: oneshot::Sender<Result<(), String>>) {
        if self.syncing {
            self.sync_waiters.push(sender);
        } else {
            sender
                .send(Err(t!("{action} failed", action = t!("Sync")).to_string()))
                .ok();
        }
    }

    /// The sync the queued waiters asked for, once the one before it ended.
    fn run_queued(&mut self, cx: &mut Context<Self>) {
        let queued = std::mem::take(&mut self.queued_waiters);
        if queued.is_empty() {
            return;
        }
        self.sync(SyncOptions::default(), cx);
        for sender in queued {
            self.attach_waiter(sender);
        }
    }

    /// Sync now (the toolbar's button, the palette, Review's Apply), or as
    /// live mode's own. The window saves its editors first.
    pub fn sync(&mut self, options: SyncOptions, cx: &mut Context<Self>) {
        if self.staged {
            return;
        }
        let (Some(root), Some(_)) = (self.root.clone(), self.link()) else {
            return;
        };
        if self.syncing {
            return;
        }
        if options.automatic {
            self.last_auto_sync = Some(Instant::now());
        }
        self.syncing = true;
        self.local_pending = false;
        cx.notify();
        let entities = self.entity_list.clone();
        let run_root = root.clone();
        let run = cx.background_spawn(async move {
            sync::sync(
                &run_root,
                &BTreeSet::new(),
                options.observed_remote_version,
                entities,
            )
        });
        self.sync_task = Some(cx.spawn(async move |this, cx| {
            let (result, expired) = run.await;
            this.update(cx, |this, cx| {
                this.syncing = false;
                let outcome = result.as_ref().map(|_| ()).map_err(Clone::clone);
                for waiter in this.sync_waiters.drain(..) {
                    waiter.send(outcome.clone()).ok();
                }
                if expired {
                    super::session_changed(cx);
                }
                if this.root.as_deref() != Some(root.as_path()) {
                    return;
                }
                match result {
                    Ok(result) => this.synced(root, result, options, cx),
                    Err(error) => this.failed(error, options, cx),
                }
                this.run_queued(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// A sync finished: say what it left, and settle what it asks of the
    /// writer.
    fn synced(
        &mut self,
        root: PathBuf,
        result: OverleafSyncResult,
        options: SyncOptions,
        cx: &mut Context<Self>,
    ) {
        self.transport_retry = false;
        self.refusals = 0;
        self.remote_changes = false;
        // Edited here while the sync ran: left as they were, so they still
        // need to go up.
        if !result.edited_during_sync.is_empty() {
            self.local_pending = true;
            if self.mode == OverleafSyncMode::Live {
                self.schedule_push(cx);
            }
        }
        // Old versions uploaded PDF-inspection renders from an app-owned
        // folder: removed silently, outside the writer's preference.
        if !result.automatic_remote_deletes.is_empty() && !result.read_only {
            remote_deletes::settle(
                self,
                &root,
                result.automatic_remote_deletes.clone(),
                true,
                cx,
            );
        }
        // What happens to a file deleted here is the writer's call.
        if !result.skipped_remote_deletes.is_empty() {
            remote_deletes::settle(
                self,
                &root,
                result.skipped_remote_deletes.clone(),
                false,
                cx,
            );
        }
        let this = cx.entity().downgrade();
        for warning in outcome::warnings(&result) {
            let mut notice = Notice::new(ToastLevel::Warning, warning.message);
            if let Some(file) = warning.resolve {
                let this = this.clone();
                notice = notice.action(NoticeAction::new(t!("Resolve"), move |_, cx| {
                    this.update(cx, |_, cx| {
                        cx.emit(OverleafBridgeEvent::OpenConflict(file.clone()))
                    })
                    .ok();
                }));
            }
            notices::show(notice, cx);
        }
        self.report_conflicts(&root, &result, cx);
        let incoming = outcome::incoming(&result);
        if incoming {
            cx.emit(OverleafBridgeEvent::Incoming);
        }
        let moved =
            !result.pulled.is_empty() || !result.pushed.is_empty() || !result.merged.is_empty();
        // A quiet background no-op is only logged.
        if !options.automatic || moved {
            notices::show(
                Notice::new(ToastLevel::Success, outcome::summary(&result)).key(SYNC_KEY),
                cx,
            );
        } else {
            log::info!("{}", outcome::summary(&result));
        }
        // Only a real content change becomes a version.
        if incoming || !result.pushed.is_empty() {
            let version_root = root.clone();
            cx.background_spawn(async move {
                let _ = lattice_core::git::auto_commit(
                    &version_root,
                    crate::history::messages::OVERLEAF_SYNC,
                    None,
                );
            })
            .detach();
        }
        if self.channel == ChannelStatus::Error && !self.rejoined {
            self.rejoined = true;
            self.channel_task = None;
        }
        self.reload_link(cx);
    }

    /// Say which files a sync left in conflict, and open the resolver on the
    /// first that has markers in it (`reportSyncOutcome`). A later write can
    /// have settled one already, so each is read back first.
    fn report_conflicts(
        &mut self,
        root: &Path,
        result: &OverleafSyncResult,
        cx: &mut Context<Self>,
    ) {
        if result.conflicts.is_empty() {
            return;
        }
        let marked: Vec<_> = result
            .conflicts
            .iter()
            .filter(|conflict| conflict.markers)
            .filter(|conflict| {
                lattice_core::project::read_file(root, &conflict.path)
                    .map(|text| crate::history::conflicts::has_conflict_markers(&text))
                    .unwrap_or(true)
            })
            .collect();
        let whole: Vec<_> = result
            .conflicts
            .iter()
            .filter(|conflict| !conflict.markers)
            .collect();
        let message = outcome::conflict_message(&marked, &whole);
        if !message.is_empty() {
            notices::show(Notice::new(ToastLevel::Error, message), cx);
        }
        if let Some(first) = marked.first() {
            cx.emit(OverleafBridgeEvent::OpenConflict(first.path.clone()));
        }
    }

    /// A sync failed: say so in the words that fit, or quietly owe it again
    /// for a brief outage in live mode.
    fn failed(&mut self, error: String, options: SyncOptions, cx: &mut Context<Self>) {
        let refused = outcome::is_project_refusal(&error);
        if refused {
            self.refusals += 1;
        }
        let retryable = outcome::is_transient_transport_failure(&error)
            || (refused && self.refusals < outcome::REFUSAL_RETRIES);
        let this = cx.entity().downgrade();
        let sync_again = || {
            let this = this.clone();
            NoticeAction::new(t!("Sync again"), move |_, cx| {
                this.update(cx, |this, cx| this.sync(SyncOptions::default(), cx))
                    .ok();
            })
        };
        if options.automatic && retryable {
            // The live loop retries on its rate-limited cadence: retrying
            // now risks another 429, and a toast for a brief outage
            // interrupts work.
            self.transport_retry = true;
            log::warn!("Overleaf sync will be retried: {error}");
            return;
        }
        let notice = if outcome::is_signed_out(&error) {
            let this = this.clone();
            Notice::new(ToastLevel::Error, t!("Overleaf sync paused"))
                .detail(t!(
                    "Your Overleaf session ended. Your edits stay on this Mac until you sign in"
                ))
                .action(NoticeAction::new(
                    t!("Sign in to Overleaf"),
                    move |_, cx| {
                        this.update(cx, |_, cx| cx.emit(OverleafBridgeEvent::OpenSettings))
                            .ok();
                    },
                ))
        } else if refused {
            // Signed in, yet this project's requests keep being turned away:
            // most often a share that was removed.
            self.transport_retry = false;
            Notice::new(ToastLevel::Error, t!("Overleaf refused this project"))
                .detail(t!("You are still signed in. Check that the project still opens on Overleaf; your edits stay on this Mac"))
                .action(sync_again())
        } else if outcome::is_transient_transport_failure(&error) {
            Notice::new(ToastLevel::Error, t!("Couldn’t reach Overleaf"))
                .detail(t!("Your edits stay on this Mac until the next sync"))
                .action(sync_again())
        } else {
            Notice::new(
                ToastLevel::Error,
                t!("{action} failed", action = t!("Sync")),
            )
            .detail(error)
        };
        notices::show(notice.key(SYNC_KEY), cx);
    }

    /// Pause or resume syncing this project. Pausing keeps the link and
    /// everything it needs, so resuming is an ordinary sync that merges
    /// whatever changed on either side meanwhile.
    pub fn set_paused(&mut self, paused: bool, cx: &mut Context<Self>) {
        if self.staged {
            return;
        }
        let Some(root) = self.root.clone() else {
            notices::error(
                t!("Open the linked Overleaf project before changing its sync setting."),
                "",
                cx,
            );
            return;
        };
        let task = cx.background_spawn(async move { sync::set_paused(&root, paused) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| match result {
                Ok(()) => {
                    this.reload_link(cx);
                    if paused {
                        let weak = cx.entity().downgrade();
                        notices::show(
                            Notice::new(ToastLevel::Info, t!("Overleaf sync paused"))
                                .detail(t!("Edits on both sides merge when you resume"))
                                .key("overleaf-sync-paused")
                                .action(NoticeAction::new(t!("Resume"), move |_, cx| {
                                    weak.update(cx, |this, cx| this.set_paused(false, cx)).ok();
                                })),
                            cx,
                        );
                    } else {
                        notices::dismiss("overleaf-sync-paused", cx);
                    }
                }
                Err(error) => notices::error(t!("Could not change Overleaf sync"), error, cx),
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn entity(&self, path: &str) -> Option<&(String, String)> {
        self.entities.get(path)
    }

    pub(super) fn declined(&self, root: &Path, path: &str) -> bool {
        self.declined_deletes
            .contains(&(root.to_path_buf(), path.to_string()))
    }

    pub(super) fn decline(&mut self, root: &Path, path: &str) {
        self.declined_deletes
            .insert((root.to_path_buf(), path.to_string()));
    }

    /// Whether `root` is still the project this window shows.
    pub(super) fn is_current(&self, root: &Path) -> bool {
        self.root.as_deref() == Some(root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_match_by_scheme_and_host_alone() {
        assert!(hosts_match("https://www.overleaf.com", "www.overleaf.com/"));
        assert!(hosts_match(
            "HTTPS://WWW.Overleaf.com/project",
            "https://www.overleaf.com"
        ));
        assert!(!hosts_match(
            "https://www.overleaf.com",
            "https://overleaf.example.edu"
        ));
        assert!(link_matches_session("https://www.overleaf.com", ""));
    }
}
