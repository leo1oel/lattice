//! Notifications, as the Tauri app's toast stack shows them
//! (`src/telemetry/toast-stack.tsx`, `toast-stack.css`, and the store behind
//! them, `app-notify.ts` and `app-log-store.ts`).
//!
//! What is on screen:
//!
//! - at most four cards, the newest in front: a fifth pushes the oldest out
//!   (`visibleToastIds.slice(0, 4)`);
//! - a repeat of a notice still showing, under its key or, without one, its
//!   source and title, updates that card in place and restarts its clock,
//!   rather than stacking a copy (four identical build failures would fill
//!   the stack);
//! - an error stays 9 s and anything else 6 s, or what the notice asks
//!   ([`Notice::timeout`], at least a second; [`Notice::persistent`] stays
//!   until dismissed); a running operation ([`Notice::running`],
//!   [`Notice::progress`]) has no clock at all until the notice that says
//!   how it ended replaces it;
//! - every clock holds while the stack is hovered or focused, and while no
//!   Lattice window is in front, and runs on from where it held;
//! - an error carries a Copy button with its title and detail unless it
//!   says what to copy.
//!
//! How it moves is `notices/stack.rs`. Any code reaches the stack through
//! the window-independent global the shell installs ([`install`]).

use std::{
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    App, AppContext as _, Context, Entity, FocusHandle, Global, SharedString, Subscription, Task,
    Window, WindowId,
};
use lattice_ui::components::{ToastLevel, ToastProgress};

mod stack;

const ERROR_TIMEOUT: Duration = Duration::from_secs(9);
const TIMEOUT: Duration = Duration::from_secs(6);
/// The shortest clock a notice may ask for (`Math.max(1_000, timeoutMs)`).
const MIN_TIMEOUT: Duration = Duration::from_secs(1);
/// "It's on the clipboard" stays this long (`notifyCopied`).
const COPIED_TIMEOUT: Duration = Duration::from_millis(1800);
/// The most cards on screen; the store keeps no more.
const STACK_LIMIT: usize = 4;

type Run = Rc<dyn Fn(&mut Window, &mut App)>;
type Dismissed = Rc<dyn Fn(&mut App)>;

pub struct NoticeAction {
    label: SharedString,
    run: Run,
    /// The card stays up after the action runs, since it still has a choice
    /// left to offer (`keepOpen`).
    keep_open: bool,
}

impl NoticeAction {
    pub fn new(
        label: impl Into<SharedString>,
        run: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            run: Rc::new(run),
            keep_open: false,
        }
    }

    /// Leave the card up once the action has run.
    #[allow(
        dead_code,
        reason = "the Tauri app's `keepOpen`, for an action that leaves a choice"
    )]
    pub fn keep_open(mut self) -> Self {
        self.keep_open = true;
        self
    }
}

pub struct Notice {
    level: ToastLevel,
    /// What the log names as its source (`addAppLog`'s `source`).
    source: Option<SharedString>,
    title: SharedString,
    detail: Option<SharedString>,
    actions: Vec<NoticeAction>,
    /// Replaces a notice showing under the same key.
    key: Option<SharedString>,
    /// How long it stays; `Some(ZERO)` until dismissed or answered, `None`
    /// its level's default.
    timeout: Option<Duration>,
    /// An operation under way, which a notice under the same key replaces
    /// when it ends: its bar, `None` for none.
    progress: Option<ToastProgress>,
    /// What its Copy button copies.
    copy: Option<SharedString>,
    /// Run when the writer (or the clock) takes it down, not when an action
    /// answers it or its owner retracts it (`onDismiss`).
    on_dismiss: Option<Dismissed>,
}

impl Notice {
    pub fn new(level: ToastLevel, title: impl Into<SharedString>) -> Self {
        Self {
            level,
            source: None,
            title: title.into(),
            detail: None,
            actions: Vec::new(),
            key: None,
            timeout: None,
            progress: None,
            copy: None,
            on_dismiss: None,
        }
    }

    /// The part of the app it comes from, which the log shows beside it.
    pub fn source(mut self, source: impl Into<SharedString>) -> Self {
        self.source = Some(source.into());
        self
    }

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn action(mut self, action: NoticeAction) -> Self {
        self.actions.push(action);
        self
    }

    pub fn key(mut self, key: impl Into<SharedString>) -> Self {
        self.key = Some(key.into());
        self
    }

    /// Stays until dismissed or answered (`timeoutMs: 0`).
    pub fn persistent(mut self) -> Self {
        self.timeout = Some(Duration::ZERO);
        self
    }

    /// Stays `timeout` rather than its level's default (`timeoutMs`).
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// An operation under way: it stays until the notice under its key that
    /// says how it ended replaces it, and that ending, a success or an
    /// error, is heard (`app-log-store.ts`: the one moment a toast speaks).
    /// Its bar sweeps until [`update_progress`] says how far it is.
    pub fn running(mut self) -> Self {
        self.progress.get_or_insert(ToastProgress::Indeterminate);
        self
    }

    /// [`Notice::running`], already this far along.
    pub fn progress(mut self, progress: ToastProgress) -> Self {
        self.progress = Some(progress);
        self
    }

    /// A Copy button that puts `text` on the clipboard (an error copies its
    /// title and detail without asking).
    pub fn copy(mut self, text: impl Into<SharedString>) -> Self {
        self.copy = Some(text.into());
        self
    }

    pub fn on_dismiss(mut self, on_dismiss: impl Fn(&mut App) + 'static) -> Self {
        self.on_dismiss = Some(Rc::new(on_dismiss));
        self
    }

    fn is_running(&self) -> bool {
        self.progress.is_some()
    }

    /// The key it collapses under: its own, or its source and title
    /// (`toastKey(source, title)`).
    fn dedupe_key(&self) -> SharedString {
        self.key.clone().unwrap_or_else(|| {
            format!(
                "{}\u{0}{}",
                self.source.as_deref().unwrap_or_default(),
                self.title
            )
            .into()
        })
    }

    /// How long its clock runs, `None` for no clock (`toastTimeout`).
    fn clock(&self) -> Option<Duration> {
        if self.is_running() {
            return None;
        }
        let timeout = self.timeout.unwrap_or(if self.level == ToastLevel::Error {
            ERROR_TIMEOUT
        } else {
            TIMEOUT
        });
        (!timeout.is_zero()).then(|| timeout.max(MIN_TIMEOUT))
    }

    /// What Copy copies: an error's title and detail unless it says
    /// otherwise.
    fn copy_text(&self) -> Option<SharedString> {
        self.copy.clone().or_else(|| {
            (self.level == ToastLevel::Error).then(|| {
                match self
                    .detail
                    .as_deref()
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                {
                    Some(detail) => format!("{}\n{detail}", self.title).into(),
                    None => self.title.clone(),
                }
            })
        })
    }
}

/// A card's clock: how long it may still show, counted only while it runs.
#[derive(Clone, Copy, Debug)]
struct Clock {
    left: Duration,
    /// Since when it has been running; `None` while it holds.
    since: Option<Instant>,
}

impl Clock {
    fn new(budget: Duration, running: bool, now: Instant) -> Self {
        Self {
            left: budget,
            since: running.then_some(now),
        }
    }

    fn left(&self, now: Instant) -> Duration {
        match self.since {
            Some(since) => self
                .left
                .saturating_sub(now.saturating_duration_since(since)),
            None => self.left,
        }
    }

    fn hold(&mut self, now: Instant) {
        self.left = self.left(now);
        self.since = None;
    }

    fn run(&mut self, now: Instant) {
        if self.since.is_none() {
            self.since = Some(now);
        }
    }
}

struct Shown {
    id: usize,
    notice: Notice,
    key: SharedString,
    clock: Option<Clock>,
    look: stack::Look,
}

pub struct NoticeStack {
    /// Newest first: the front card is `shown[0]`.
    shown: Vec<Shown>,
    leaving: Vec<stack::Leaving>,
    next_id: usize,
    hovered: bool,
    /// The pointer left while a card was leaving: the stack folds up once
    /// it has gone.
    leave_pending: bool,
    /// The stack holds keyboard focus (F6), and what held it before.
    focus: FocusHandle,
    focus_before: Option<(WindowId, FocusHandle)>,
    focused: bool,
    /// Whether each window drawing the stack is in front.
    windows: HashMap<WindowId, bool>,
    _activation: Vec<Subscription>,
    swipe: Option<stack::Swipe>,
    _clock: Option<Task<()>>,
}

struct NoticeCenter(Entity<NoticeStack>);

impl Global for NoticeCenter {}

/// Make the stack every `show` reaches, and return it for the shell to draw.
pub fn install(cx: &mut App) -> Entity<NoticeStack> {
    if let Some(center) = cx.try_global::<NoticeCenter>() {
        return center.0.clone();
    }
    let stack = cx.new(|cx| NoticeStack {
        shown: Vec::new(),
        leaving: Vec::new(),
        next_id: 0,
        hovered: false,
        leave_pending: false,
        focus: cx.focus_handle(),
        focus_before: None,
        focused: false,
        windows: HashMap::new(),
        _activation: Vec::new(),
        swipe: None,
        _clock: None,
    });
    cx.set_global(NoticeCenter(stack.clone()));
    stack::bind_keys(&stack, cx);
    stack
}

pub fn show(notice: Notice, cx: &mut App) {
    // Every notice reaches the log too, which a scripted run reads.
    let level = match notice.level {
        ToastLevel::Error => log::Level::Error,
        ToastLevel::Warning => log::Level::Warn,
        ToastLevel::Info | ToastLevel::Success => log::Level::Info,
    };
    log::log!(
        level,
        "{}{}",
        notice.title,
        notice
            .detail
            .as_ref()
            .map(|detail| format!(": {detail}"))
            .unwrap_or_default()
    );
    let stack = install(cx);
    let key = notice.dedupe_key();
    // The app's log keeps it too; a repeat of a notice still showing under
    // its key updates the entry it logged.
    let replaces = stack.read(cx).shown.iter().any(|shown| shown.key == key);
    let entry = crate::app_log::NewEntry {
        level: match notice.level {
            ToastLevel::Info => crate::app_log::Level::Info,
            ToastLevel::Success => crate::app_log::Level::Success,
            ToastLevel::Warning => crate::app_log::Level::Warning,
            ToastLevel::Error => crate::app_log::Level::Error,
        },
        source: notice.source.as_ref().map_or_else(
            || lattice_i18n::t!("Lattice").to_string(),
            ToString::to_string,
        ),
        title: notice.title.to_string(),
        detail: notice
            .detail
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default(),
        context: None,
    };
    crate::app_log::global(cx).update(cx, |log, cx| {
        log.add(entry, Some(&*key), replaces, cx);
    });
    stack.update(cx, |stack, cx| stack.push(notice, key, cx));
}

/// A brief "it's on the clipboard" for a copy with nothing else to show for
/// itself (`notifyCopied`): 1.8 s, one card however often it repeats.
pub fn copied(title: impl Into<SharedString>, cx: &mut App) {
    show(
        Notice::new(ToastLevel::Info, title)
            .source(lattice_i18n::t!("Clipboard"))
            .key("clipboard-copied")
            .timeout(COPIED_TIMEOUT),
        cx,
    );
}

/// Move the bar of the running notice showing under `key`, without a log
/// line: a download reports hundreds of chunks, each a redraw rather than
/// an event (`updateAppToastProgress`).
pub fn update_progress(key: &str, progress: ToastProgress, cx: &mut App) {
    let Some(center) = cx.try_global::<NoticeCenter>() else {
        return;
    };
    center.0.clone().update(cx, |stack, cx| {
        if let Some(shown) = stack
            .shown
            .iter_mut()
            .find(|shown| &*shown.key == key && shown.notice.progress.is_some())
            && shown.notice.progress != Some(progress)
        {
            shown.notice.progress = Some(progress);
            cx.notify();
        }
    });
}

/// Whether the notice showing under `key` is an operation still under way
/// ([`Notice::running`]).
pub fn is_running(key: &str, cx: &App) -> bool {
    cx.try_global::<NoticeCenter>().is_some_and(|center| {
        center
            .0
            .read(cx)
            .shown
            .iter()
            .any(|shown| &*shown.key == key && shown.notice.is_running())
    })
}

/// Take down the notice showing under `key`, if any: its owner retracts it,
/// so its `on_dismiss` does not run.
pub fn dismiss(key: &str, cx: &mut App) {
    let Some(center) = cx.try_global::<NoticeCenter>() else {
        return;
    };
    let stack = center.0.clone();
    stack.update(cx, |stack, cx| {
        let ids: Vec<usize> = stack
            .shown
            .iter()
            .filter(|shown| &*shown.key == key)
            .map(|shown| shown.id)
            .collect();
        for id in ids {
            stack.take_down(id, Takedown::Retracted, cx);
        }
    });
}

pub fn error(title: impl Into<SharedString>, detail: impl Into<SharedString>, cx: &mut App) {
    show(Notice::new(ToastLevel::Error, title).detail(detail), cx);
}

pub fn warning(title: impl Into<SharedString>, cx: &mut App) {
    show(Notice::new(ToastLevel::Warning, title), cx);
}

pub fn info(title: impl Into<SharedString>, detail: impl Into<SharedString>, cx: &mut App) {
    show(Notice::new(ToastLevel::Info, title).detail(detail), cx);
}

/// Why a card leaves.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Takedown {
    /// Its X, Escape, a swipe or its clock: the dismissal its `on_dismiss`
    /// hears.
    Dismissed,
    /// One of its actions answered it.
    Answered,
    /// Its owner took it down, or a newer card pushed it out.
    Retracted,
}

impl NoticeStack {
    fn push(&mut self, notice: Notice, key: SharedString, cx: &mut Context<Self>) {
        let now = Instant::now();
        let holding = self.holding();
        if let Some(shown) = self.shown.iter_mut().find(|shown| shown.key == key) {
            // A repeat: the card shows the newer notice where it stands, with
            // a full clock from now.
            let was_running = shown.notice.is_running();
            if was_running && !notice.is_running() {
                match notice.level {
                    ToastLevel::Success => crate::sounds::play(crate::sounds::Cue::Success, cx),
                    ToastLevel::Error => crate::sounds::play(crate::sounds::Cue::Error, cx),
                    ToastLevel::Info | ToastLevel::Warning => {}
                }
            }
            shown.clock = notice
                .clock()
                .map(|budget| Clock::new(budget, !holding, now));
            shown.notice = notice;
        } else {
            let id = self.next_id;
            self.next_id += 1;
            let clock = notice
                .clock()
                .map(|budget| Clock::new(budget, !holding, now));
            self.shown.insert(
                0,
                Shown {
                    id,
                    notice,
                    key,
                    clock,
                    look: stack::Look::arriving(now),
                },
            );
            // Past four the oldest goes, as the store slices it off.
            while self.shown.len() > STACK_LIMIT {
                let oldest = self.shown.len() - 1;
                let id = self.shown[oldest].id;
                self.take_down(id, Takedown::Retracted, cx);
            }
        }
        self.schedule(cx);
        cx.notify();
    }

    /// Take the card `id` down, playing its exit.
    fn take_down(&mut self, id: usize, why: Takedown, cx: &mut Context<Self>) {
        let Some(index) = self.shown.iter().position(|shown| shown.id == id) else {
            return;
        };
        let shown = self.shown.remove(index);
        let swipe = self
            .swipe
            .take_if(|swipe| swipe.id == id)
            .and_then(|swipe| swipe.dismissed);
        if why == Takedown::Dismissed
            && let Some(on_dismiss) = shown.notice.on_dismiss.clone()
        {
            cx.defer(move |cx| on_dismiss(cx));
        }
        self.leaving.push(stack::Leaving::new(
            shown,
            index,
            swipe,
            Instant::now(),
            cx.reduce_motion(),
        ));
        self.schedule(cx);
        cx.notify();
    }

    /// Whether the clocks hold: the stack is hovered or focused, or no
    /// window drawing it is in front.
    fn holding(&self) -> bool {
        self.hovered || self.focused || !self.windows.values().any(|active| *active)
    }

    /// Hold or run every clock as [`NoticeStack::holding`] says, and wake
    /// when the next one runs out.
    fn schedule(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        let holding = self.holding();
        let mut next: Option<Duration> = None;
        for shown in &mut self.shown {
            let Some(clock) = shown.clock.as_mut() else {
                continue;
            };
            if holding {
                clock.hold(now);
            } else {
                clock.run(now);
                let left = clock.left(now);
                next = Some(next.map_or(left, |next| next.min(left)));
            }
        }
        self._clock = next.map(|wait| {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(wait).await;
                this.update(cx, |this, cx| this.expire(cx)).ok();
            })
        });
    }

    /// Take down every card whose clock has run out.
    fn expire(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        let due: Vec<usize> = self
            .shown
            .iter()
            .filter(|shown| {
                shown
                    .clock
                    .is_some_and(|clock| clock.since.is_some() && clock.left(now).is_zero())
            })
            .map(|shown| shown.id)
            .collect();
        for id in due {
            self.take_down(id, Takedown::Dismissed, cx);
        }
        self.schedule(cx);
    }

    fn set_hovered(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if self.hovered != hovered {
            self.hovered = hovered;
            self.schedule(cx);
            cx.notify();
        }
    }

    fn set_window_active(&mut self, window: WindowId, active: bool, cx: &mut Context<Self>) {
        if self.windows.insert(window, active) != Some(active) {
            self.schedule(cx);
        }
    }

    /// The titles of the notices showing, newest last, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn titles(&self) -> Vec<SharedString> {
        self.shown
            .iter()
            .rev()
            .map(|shown| shown.notice.title.clone())
            .collect()
    }

    /// Every showing card as it is drawn now, front first, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn cards(&self) -> Vec<stack::CardState> {
        let now = Instant::now();
        self.shown
            .iter()
            .map(|shown| shown.look.state(&shown.notice, now))
            .collect()
    }

    /// Whether the stack is fanned out.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn expanded(&self) -> bool {
        self.hovered || self.focused
    }

    /// How many cards are on their way out.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn leaving(&self) -> usize {
        self.leaving.len()
    }

    /// Answer the notice titled `title` with its action `label`, as a click
    /// on that button would, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn answer(
        &mut self,
        title: &str,
        label: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(shown) = self
            .shown
            .iter()
            .find(|shown| &*shown.notice.title == title)
        else {
            return false;
        };
        let Some(action) = shown
            .notice
            .actions
            .iter()
            .find(|action| &*action.label == label)
        else {
            return false;
        };
        let (id, run, keep_open) = (shown.id, action.run.clone(), action.keep_open);
        run(window, cx);
        if !keep_open {
            self.take_down(id, Takedown::Answered, cx);
        }
        true
    }

    /// Take every notice down at once, without their exits, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.shown.clear();
        self.leaving.clear();
        self.swipe = None;
        self.schedule(cx);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notice_without_a_key_collapses_under_its_source_and_title() {
        let a = Notice::new(ToastLevel::Error, "Build failed").source("Build");
        let b = Notice::new(ToastLevel::Error, "Build failed").source("Build");
        let c = Notice::new(ToastLevel::Error, "Build failed").source("Overleaf");
        assert_eq!(a.dedupe_key(), b.dedupe_key());
        assert_ne!(a.dedupe_key(), c.dedupe_key());
        assert_eq!(
            &*Notice::new(ToastLevel::Info, "x").key("k").dedupe_key(),
            "k"
        );
    }

    #[test]
    fn clocks_follow_the_tauri_apps_timeouts() {
        assert_eq!(
            Notice::new(ToastLevel::Error, "e").clock(),
            Some(ERROR_TIMEOUT)
        );
        assert_eq!(Notice::new(ToastLevel::Info, "i").clock(), Some(TIMEOUT));
        // An action no longer keeps a card up by itself; `persistent` does.
        let answered =
            Notice::new(ToastLevel::Info, "i").action(NoticeAction::new("Undo", |_, _| {}));
        assert_eq!(answered.clock(), Some(TIMEOUT));
        assert_eq!(
            Notice::new(ToastLevel::Info, "i").persistent().clock(),
            None
        );
        assert_eq!(Notice::new(ToastLevel::Info, "i").running().clock(), None);
        assert_eq!(
            Notice::new(ToastLevel::Info, "i")
                .timeout(Duration::from_millis(200))
                .clock(),
            Some(MIN_TIMEOUT)
        );
        assert_eq!(
            Notice::new(ToastLevel::Info, "i")
                .timeout(COPIED_TIMEOUT)
                .clock(),
            Some(COPIED_TIMEOUT)
        );
    }

    #[test]
    fn an_error_copies_its_title_and_detail() {
        let error = Notice::new(ToastLevel::Error, "Could not save").detail("Disk full");
        assert_eq!(
            error.copy_text().as_deref(),
            Some("Could not save\nDisk full")
        );
        assert_eq!(Notice::new(ToastLevel::Info, "i").copy_text(), None);
        let chosen = Notice::new(ToastLevel::Error, "x").copy("the whole log");
        assert_eq!(chosen.copy_text().as_deref(), Some("the whole log"));
    }

    #[test]
    fn a_held_clock_runs_on_from_where_it_held() {
        let start = Instant::now();
        let mut clock = Clock::new(Duration::from_secs(6), true, start);
        let later = start + Duration::from_secs(2);
        clock.hold(later);
        assert_eq!(
            clock.left(later + Duration::from_secs(10)),
            Duration::from_secs(4)
        );
        let resumed = later + Duration::from_secs(10);
        clock.run(resumed);
        assert_eq!(
            clock.left(resumed + Duration::from_secs(1)),
            Duration::from_secs(3)
        );
    }
}
