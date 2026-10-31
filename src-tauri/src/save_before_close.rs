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
//! Quitting needs its own menu item: AppKit's predefined Quit sends
//! `terminate:`, which tao turns straight into an exit without the
//! `ExitRequested` a run loop could prevent (see `native_locale::build_menu`).

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

    /// The window's page went away (a reload or the window itself): it can no
    /// longer answer, and a request waiting only on it goes ahead.
    pub fn forget(&self, label: &str) -> Vec<Action> {
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
        self.with(|requests| {
            if requests.pending.values().any(|pending| pending.action == Action::Quit) {
                return Decision::Wait;
            }
            let mut labels: Vec<String> = requests.guarded.iter().cloned().collect();
            if labels.is_empty() {
                return Decision::Proceed;
            }
            labels.sort();
            requests.ask(Action::Quit, labels)
        })
    }

    /// `label`'s page saved (`proceed`), or could not and wants its window
    /// kept open. Returns the action once the last page asked has saved.
    pub fn answer(&self, id: u64, label: &str, proceed: bool) -> Option<Action> {
        self.with(|requests| requests.answer(id, label, proceed))
    }

    /// The wait ran out: go ahead with whatever was still waiting.
    pub fn expire(&self, id: u64) -> Option<Action> {
        self.with(|requests| requests.pending.remove(&id).map(|pending| pending.action))
    }
}

impl Requests {
    fn ask(&mut self, action: Action, labels: Vec<String>) -> Decision {
        self.next_id += 1;
        let id = self.next_id;
        self.pending.insert(id, Pending { action, waiting: labels.iter().cloned().collect() });
        Decision::Ask(id, labels)
    }

    fn answer(&mut self, id: u64, label: &str, proceed: bool) -> Option<Action> {
        let pending = self.pending.get_mut(&id)?;
        if !pending.waiting.remove(label) {
            return None;
        }
        if !proceed {
            // One window's unsaved edit keeps the whole quit from happening;
            // the windows that did save stay open as they were.
            self.pending.remove(&id);
            return None;
        }
        if !pending.waiting.is_empty() {
            return None;
        }
        self.pending.remove(&id).map(|pending| pending.action)
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
        Action::Quit => app.exit(0),
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
        if let Some(action) = app.state::<SaveBeforeClose>().expire(id) {
            log::warn!(target: "lattice::app", "Closed without every window's save answer after {SAVE_WAIT:?}");
            perform(&app, action);
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

/// The page went away; a close or quit waiting on it goes ahead.
pub fn forget<R: Runtime>(app: &AppHandle<R>, label: &str) {
    // `try_state`: the first page starts loading before `setup` has run.
    let Some(state) = app.try_state::<SaveBeforeClose>() else { return };
    for action in state.forget(label) {
        perform(app, action);
    }
}

/// The window's page saves its open edits when asked, before it closes.
#[tauri::command]
pub fn enable_save_before_close(window: WebviewWindow, state: tauri::State<'_, SaveBeforeClose>) {
    state.enable(window.label());
}

/// The page's answer to a save request: `saved` is false when an edit could
/// not be written, which keeps the window (and Lattice) open. Async, so the
/// window is not destroyed from inside its own page's IPC call on the main
/// thread.
#[tauri::command]
pub async fn finish_save_before_close(app: AppHandle, window: WebviewWindow, id: u64, saved: bool) {
    let action = app.state::<SaveBeforeClose>().answer(id, window.label(), saved);
    if let Some(action) = action {
        perform(&app, action);
    }
}

#[cfg(test)]
mod tests {
    use super::{Action, Decision, SaveBeforeClose};

    #[test]
    fn a_window_whose_page_never_enabled_saving_closes_at_once() {
        let guard = SaveBeforeClose::default();
        assert_eq!(guard.request_close("main"), Decision::Proceed);
        assert_eq!(guard.request_quit(), Decision::Proceed);
    }

    #[test]
    fn closing_waits_for_the_page_to_save() {
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        let Decision::Ask(id, labels) = guard.request_close("main") else { panic!("not asked") };
        assert_eq!(labels, ["main"]);
        // A second click while the save runs does not ask again.
        assert_eq!(guard.request_close("main"), Decision::Wait);
        assert_eq!(guard.answer(id, "main", true), Some(Action::Close("main".into())));
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
        assert_eq!(guard.answer(id, "project-2", true), Some(Action::Quit));
    }

    #[test]
    fn a_failed_save_keeps_the_window_open() {
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        guard.enable("project-2");
        let Decision::Ask(id, _) = guard.request_quit() else { panic!("not asked") };
        assert_eq!(guard.answer(id, "main", false), None);
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
        assert_eq!(guard.expire(id), Some(Action::Close("main".into())));
        assert_eq!(guard.answer(id, "main", true), None);
    }

    #[test]
    fn a_page_that_goes_away_no_longer_holds_its_window() {
        let guard = SaveBeforeClose::default();
        guard.enable("main");
        guard.enable("project-2");
        let Decision::Ask(_, _) = guard.request_quit() else { panic!("not asked") };
        assert_eq!(guard.forget("main"), []);
        assert_eq!(guard.forget("project-2"), [Action::Quit]);
        assert_eq!(guard.request_close("main"), Decision::Proceed);
    }
}
