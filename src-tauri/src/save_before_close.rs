//! Saving a window's open edits before the window closes or Lattice quits.
//!
//! Autosave is a timer in the page (about a second after typing stops), so a
//! window that simply closed took the last second of typing with it. A page
//! that can save on request says so (`enable_save_before_close`); closing its
//! window, or quitting, then first asks it to save (`SAVE_BEFORE_CLOSE_EVENT`)
//! and waits for its answer (`finish_save_before_close`), or at most
//! `SAVE_WAIT`, before going ahead. A page that never said so (a presenter
//! popup, the browser bridge, a page still booting) closes at once.
//!
//! Every way out goes through here. Lattice ▸ Quit is a menu item of its own
//! (see `native_locale::build_menu`); AppKit's `terminate:` (Dock ▸ Quit,
//! logging out, restarting or shutting down the Mac) asks first through
//! `app_terminate`; and restarting Lattice, after an update or from the crash
//! page, is `restart_lattice` rather than Tauri's own restart, which replaces
//! the process without any event a window could save on.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// The event a page saves on; its payload is the request id to answer with.
pub const SAVE_BEFORE_CLOSE_EVENT: &str = "save-before-close";

/// The longest a close or quit waits for the pages' answers. A local save
/// takes milliseconds; this only bounds a page that hung or went away.
const SAVE_WAIT: Duration = Duration::from_secs(3);

/// What a request does once every page it asked has saved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Close(String),
    Quit,
    Restart,
}

impl Action {
    /// Quitting and restarting both end every window.
    fn ends_lattice(&self) -> bool {
        matches!(self, Action::Quit | Action::Restart)
    }
}

/// How a request ended once every page asked has answered (or the wait ran out).
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Every page saved: do it.
    Proceed(Action),
    /// A page could not save: the windows stay as they are.
    Declined(Action),
}

/// What to do with a close or quit just requested.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing there to save: go ahead now.
    Proceed,
    /// A request covering it is already waiting: keep waiting for that one.
    Wait,
    /// Ask these windows to save, answering with this request id.
    Ask(u64, Vec<String>),
}

#[derive(Default)]
struct Requests {
    /// Windows whose page saves when asked.
    guarded: HashSet<String>,
    pending: HashMap<u64, Pending>,
    next_id: u64,
    /// AppKit is waiting to hear whether it may terminate (it was answered
    /// `NSTerminateLater`); the quit or restart under way owes it the reply.
    terminate_reply_owed: bool,
    /// The `restart_lattice` calls waiting to hear that a restart was declined.
    restart_waiters: Vec<tokio::sync::oneshot::Sender<()>>,
}

struct Pending {
    action: Action,
    waiting: HashSet<String>,
}

/// Which windows save before closing, and the closes and quits waiting on them.
#[derive(Default)]
pub struct SaveBeforeClose {
    requests: Mutex<Requests>,
}

impl SaveBeforeClose {
    fn with<T>(&self, change: impl FnOnce(&mut Requests) -> T) -> T {
        change(&mut self.requests.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    pub fn enable(&self, label: &str) {
        self.with(|requests| requests.guarded.insert(label.to_string()));
    }

    /// The window's page went away (a reload, the window itself, or the part
    /// of the page that answered unmounting): it can no longer answer, and a
    /// request waiting only on it goes ahead.
    pub fn forget(&self, label: &str) -> Vec<Outcome> {
        self.with(|requests| {
            requests.guarded.remove(label);
            let ids: Vec<u64> = requests
                .pending
                .iter()
                .filter(|(_, pending)| pending.waiting.contains(label))
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter().filter_map(|id| requests.answer(id, label, true)).collect()
        })
    }

    pub fn request_close(&self, label: &str) -> Decision {
        self.with(|requests| {
            if !requests.guarded.contains(label) {
                return Decision::Proceed;
            }
            // A quit, or an earlier click on the close button, is already
            // waiting for this page; asking again would only save twice.
            if requests.pending.values().any(|pending| pending.waiting.contains(label)) {
                return Decision::Wait;
            }
            requests.ask(Action::Close(label.to_string()), vec![label.to_string()])
        })
    }

    pub fn request_quit(&self) -> Decision {
        self.with(|requests| requests.end_lattice(Action::Quit))
    }

    /// Restart Lattice once every window has saved. `waiter` hears if a page
    /// could not save and the restart was called off.
    pub fn request_restart(&self, waiter: tokio::sync::oneshot::Sender<()>) -> Decision {
        self.with(|requests| {
            let decision = requests.end_lattice(Action::Restart);
            if decision != Decision::Proceed {
                requests.restart_waiters.push(waiter);
            }
            decision
        })
    }

    /// AppKit asks whether Lattice may terminate. Unless it can go at once,
    /// it waits for the reply this records as owed.
    pub fn request_terminate(&self) -> Decision {
        self.with(|requests| {
            let decision = requests.end_lattice(Action::Quit);
            if decision != Decision::Proceed {
                requests.terminate_reply_owed = true;
            }
            decision
        })
    }

    /// Whether AppKit is still waiting for its reply, which the caller now gives.
    pub fn take_terminate_reply(&self) -> bool {
        self.with(|requests| std::mem::take(&mut requests.terminate_reply_owed))
    }

    /// The restart was called off: every `restart_lattice` call returns.
    fn restart_declined(&self) {
        for waiter in self.with(|requests| std::mem::take(&mut requests.restart_waiters)) {
            let _ = waiter.send(());
        }
    }

    /// `label`'s page saved (`proceed`), or could not and wants its window
    /// kept open. Returns how the request ended once the last page asked has
    /// saved, or as soon as one could not.
    pub fn answer(&self, id: u64, label: &str, proceed: bool) -> Option<Outcome> {
        self.with(|requests| requests.answer(id, label, proceed))
    }

    /// The wait ran out: go ahead with whatever was still waiting.
    pub fn expire(&self, id: u64) -> Option<Outcome> {
        self.with(|requests| {
            requests.pending.remove(&id).map(|pending| Outcome::Proceed(pending.action))
        })
    }
}

impl Requests {
    /// Quit or restart: every window that saves on request is asked.
    fn end_lattice(&mut self, action: Action) -> Decision {
        // A quit or restart is already waiting for the windows; asking again
        // would only save twice, and whichever ends Lattice first ends it.
        if self.pending.values().any(|pending| pending.action.ends_lattice()) {
            return Decision::Wait;
        }
        let mut labels: Vec<String> = self.guarded.iter().cloned().collect();
        if labels.is_empty() {
            return Decision::Proceed;
        }
        labels.sort();
        self.ask(action, labels)
    }

    fn ask(&mut self, action: Action, labels: Vec<String>) -> Decision {
        self.next_id += 1;
        let id = self.next_id;
        self.pending.insert(id, Pending { action, waiting: labels.iter().cloned().collect() });
        Decision::Ask(id, labels)
    }

    fn answer(&mut self, id: u64, label: &str, proceed: bool) -> Option<Outcome> {
        let pending = self.pending.get_mut(&id)?;
        if !pending.waiting.remove(label) {
            return None;
        }
        if !proceed {
            // One window's unsaved edit keeps the whole quit from happening;
            // the windows that did save stay open as they were.
            return self.pending.remove(&id).map(|pending| Outcome::Declined(pending.action));
        }
        if !pending.waiting.is_empty() {
            return None;
        }
        self.pending.remove(&id).map(|pending| Outcome::Proceed(pending.action))
    }
}

fn settle<R: Runtime>(app: &AppHandle<R>, outcome: Outcome) {
    match outcome {
        Outcome::Proceed(action) => perform(app, action),
        Outcome::Declined(action) => {
            if !action.ends_lattice() {
                return;
            }
            let state = app.state::<SaveBeforeClose>();
            // Logging out or shutting down stops here too: AppKit names
            // Lattice as the app that interrupted it.
            if state.take_terminate_reply() {
                crate::app_terminate::reply(app, false);
            }
            // A restart asked for while this quit was waiting is off too.
            state.restart_declined();
        }
    }
}

fn perform<R: Runtime>(app: &AppHandle<R>, action: Action) {
    match action {
        // Destroy, not close: closing would ask the page to save again.
        Action::Close(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.destroy();
            }
        }
        // AppKit, waiting to terminate, ends Lattice itself once told it may
        // (and a restart asked for meanwhile gives way to the Mac logging out).
        _ if app.state::<SaveBeforeClose>().take_terminate_reply() => {
            crate::app_terminate::reply(app, true);
        }
        Action::Quit => app.exit(0),
        // Tauri's direct restart, on the main thread: `request_restart` goes
        // through the event loop, which a request forwarded from a browser
        // tab's bridge could leave stalled with the new app already on disk.
        Action::Restart => {
            let restarting = app.clone();
            let scheduled = app.run_on_main_thread(move || {
                crate::shutdown_child_runtimes(&restarting);
                restarting.restart();
            });
            if let Err(error) = scheduled {
                log::error!(target: "lattice::app", "Could not schedule the restart: {error}");
                app.state::<SaveBeforeClose>().restart_declined();
            }
        }
    }
}

/// Send each window its save request, and go ahead after `SAVE_WAIT` whatever
/// the answers.
fn ask<R: Runtime>(app: &AppHandle<R>, id: u64, labels: &[String]) {
    for label in labels {
        let _ = app.emit_to(tauri::EventTarget::webview_window(label), SAVE_BEFORE_CLOSE_EVENT, id);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_WAIT);
        if let Some(outcome) = app.state::<SaveBeforeClose>().expire(id) {
            log::warn!(target: "lattice::app", "Closed without every window's save answer after {SAVE_WAIT:?}");
            settle(&app, outcome);
        }
    });
}

/// A window's close button, ⌘W or File ▸ Close Window. Returns whether the
/// close must wait (the caller prevents it).
pub fn on_close_requested<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    let Some(state) = app.try_state::<SaveBeforeClose>() else { return false };
    match state.request_close(label) {
        Decision::Proceed => false,
        Decision::Wait => true,
        Decision::Ask(id, labels) => {
            ask(app, id, &labels);
            true
        }
    }
}

/// Lattice ▸ Quit and ⌘Q: every window saves first.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    match app.state::<SaveBeforeClose>().request_quit() {
        Decision::Proceed => app.exit(0),
        Decision::Wait => {}
        Decision::Ask(id, labels) => ask(app, id, &labels),
    }
}

/// AppKit's `terminate:` (Dock ▸ Quit, logging out, shutting down): returns
/// whether Lattice may end now; otherwise every window saves first and
/// `app_terminate::reply` answers AppKit once they have.
pub fn terminate<R: Runtime>(app: &AppHandle<R>) -> bool {
    match app.state::<SaveBeforeClose>().request_terminate() {
        Decision::Proceed => true,
        Decision::Wait => false,
        Decision::Ask(id, labels) => {
            ask(app, id, &labels);
            false
        }
    }
}

/// The page went away; a close or quit waiting on it goes ahead.
pub fn forget<R: Runtime>(app: &AppHandle<R>, label: &str) {
    // `try_state`: the first page starts loading before `setup` has run.
    let Some(state) = app.try_state::<SaveBeforeClose>() else { return };
    for outcome in state.forget(label) {
        settle(app, outcome);
    }
}

/// The window's page saves its open edits when asked, before it closes.
#[tauri::command]
pub fn enable_save_before_close(window: WebviewWindow, state: tauri::State<'_, SaveBeforeClose>) {
    state.enable(window.label());
}

/// The part of the page that saved on request is gone (the crash page took
/// its place): closes and quits stop waiting for it.
#[tauri::command]
pub fn disable_save_before_close(app: AppHandle, window: WebviewWindow) {
    forget(&app, window.label());
}

/// The page's answer to a save request: `saved` is false when an edit could
/// not be written, which keeps the window (and Lattice) open. Async, so the
/// window is not destroyed from inside its own page's IPC call on the main
/// thread.
#[tauri::command]
pub async fn finish_save_before_close(app: AppHandle, window: WebviewWindow, id: u64, saved: bool) {
    let outcome = app.state::<SaveBeforeClose>().answer(id, window.label(), saved);
    if let Some(outcome) = outcome {
        settle(&app, outcome);
    }
}

/// Restart Lattice (after an update, or from the crash page) once every
/// window has saved. Returns only when a window could not save and the
/// restart was called off; otherwise this process ends first.
#[tauri::command]
pub async fn restart_lattice(app: AppHandle) -> Result<(), String> {
    let (waiter, declined) = tokio::sync::oneshot::channel();
    match app.state::<SaveBeforeClose>().request_restart(waiter) {
        Decision::Proceed => perform(&app, Action::Restart),
        Decision::Wait => {}
        Decision::Ask(id, labels) => ask(&app, id, &labels),
    }
    match declined.await {
        Ok(()) => Err("A window could not save its edits, so Lattice did not restart.".to_string()),
        // Nobody will call it off: the restart is under way.
        Err(_) => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::{Action, Decision, Outcome, SaveBeforeClose};

    #[test]
    fn a_window_whose_page_never_enabled_saving_closes_at_once() {
        let guard = SaveBeforeClose::default();
        assert_eq!(guard.request_close("main"), Decision::Proceed);
        assert_eq!(guard.request_quit(), Decision::Proceed);
        assert_eq!(guard.request_terminate(), Decision::Proceed);
        assert!(!guard.take_terminate_reply());
    }

    #[test]
    fn closing_waits_for_the_page_to_save() {
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        let Decision::Ask(id, labels) = guard.request_close("main") else { panic!("not asked") };
        assert_eq!(labels, ["main"]);
        // A second click while the save runs does not ask again.
        assert_eq!(guard.request_close("main"), Decision::Wait);
        assert_eq!(
            guard.answer(id, "main", true),
            Some(Outcome::Proceed(Action::Close("main".into())))
        );
        // Answered once: a late timeout does nothing.
        assert_eq!(guard.expire(id), None);
    }

    #[test]
    fn quitting_waits_for_every_window() {
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        guard.enable("project-2");
        let Decision::Ask(id, labels) = guard.request_quit() else { panic!("not asked") };
        assert_eq!(labels, ["main", "project-2"]);
        assert_eq!(guard.request_quit(), Decision::Wait);
        assert_eq!(guard.request_close("main"), Decision::Wait);
        assert_eq!(guard.answer(id, "main", true), None);
        // Another window's answer cannot stand in for one asked.
        assert_eq!(guard.answer(id, "presenter", true), None);
        assert_eq!(guard.answer(id, "project-2", true), Some(Outcome::Proceed(Action::Quit)));
    }

    #[test]
    fn restarting_waits_for_every_window_and_hears_when_one_could_not_save() {
        // Before, an installed update restarted at once (`AppHandle::restart`),
        // and no window was asked to save its last edits.
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        guard.enable("project-2");
        let (waiter, mut declined) = tokio::sync::oneshot::channel();
        let Decision::Ask(id, labels) = guard.request_restart(waiter) else { panic!("not asked") };
        assert_eq!(labels, ["main", "project-2"]);
        // ⌘Q while the windows save does not ask them again.
        assert_eq!(guard.request_quit(), Decision::Wait);
        assert_eq!(guard.answer(id, "main", true), None);
        assert_eq!(guard.answer(id, "project-2", false), Some(Outcome::Declined(Action::Restart)));
        assert!(declined.try_recv().is_err());
        guard.restart_declined();
        assert_eq!(declined.try_recv(), Ok(()));

        let (waiter, _) = tokio::sync::oneshot::channel();
        let Decision::Ask(id, _) = guard.request_restart(waiter) else { panic!("not asked") };
        assert_eq!(guard.expire(id), Some(Outcome::Proceed(Action::Restart)));
    }

    #[test]
    fn appkit_terminating_waits_for_every_window_and_is_answered_once() {
        // Dock ▸ Quit, logging out and shutting down: before, AppKit ended
        // Lattice without asking, and the last second of typing went with it.
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        let Decision::Ask(id, labels) = guard.request_terminate() else { panic!("not asked") };
        assert_eq!(labels, ["main"]);
        // Logging out while ⌘Q's saves run: one reply covers both.
        assert_eq!(guard.request_terminate(), Decision::Wait);
        assert_eq!(guard.answer(id, "main", true), Some(Outcome::Proceed(Action::Quit)));
        assert!(guard.take_terminate_reply());
        assert!(!guard.take_terminate_reply());
    }

    #[test]
    fn a_failed_save_keeps_the_window_open() {
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        guard.enable("project-2");
        let Decision::Ask(id, _) = guard.request_quit() else { panic!("not asked") };
        assert_eq!(guard.answer(id, "main", false), Some(Outcome::Declined(Action::Quit)));
        assert_eq!(guard.answer(id, "project-2", true), None);
        assert_eq!(guard.expire(id), None);
        // Closing again asks again.
        assert!(matches!(guard.request_close("main"), Decision::Ask(..)));
    }

    #[test]
    fn a_page_that_hangs_is_waited_out() {
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        let Decision::Ask(id, _) = guard.request_close("main") else { panic!("not asked") };
        assert_eq!(guard.expire(id), Some(Outcome::Proceed(Action::Close("main".into()))));
        assert_eq!(guard.answer(id, "main", true), None);
    }

    #[test]
    fn a_page_that_goes_away_no_longer_holds_its_window() {
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        guard.enable("project-2");
        let Decision::Ask(_, _) = guard.request_quit() else { panic!("not asked") };
        assert_eq!(guard.forget("main"), []);
        assert_eq!(guard.forget("project-2"), [Outcome::Proceed(Action::Quit)]);
        assert_eq!(guard.request_close("main"), Decision::Proceed);
    }
}
