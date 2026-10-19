//! The Terminal panel's shells: one login shell per terminal tab, on a
//! pseudo-terminal of its own, owned by the window that opened it.
//!
//! Lifetime is the point of this module. A shell lives exactly as long as its
//! tab: closing the tab, the window's project changing, the window closing or
//! reloading, and Lattice quitting each end it (`terminal_close`,
//! `AppState::retire_unused_projects`, `on_page_load` and
//! `shutdown_child_runtimes`). Ending one hangs up its session, the shell and
//! whatever runs in its foreground, and kills what is still there after a
//! grace period, so a build or a watcher started from a terminal never
//! outlives it. Opening the panel starts nothing but the shell: the Synara
//! sidecar stays down.
//!
//! The parts: `caller` decides which pages may reach a shell at all; `pty` opens the pseudo-terminal and starts the shell in it;
//! `session` streams its output to the window in batches, writes the
//! writer's keys to it, and ends it.

pub(crate) mod caller;
mod pty;
mod session;

pub(crate) use session::Session;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

/// How long a hung-up shell may take to exit before it is killed.
const GRACE: Duration = Duration::from_secs(2);
/// When Lattice quits, every shell shares one shorter grace period.
const QUIT_GRACE: Duration = Duration::from_millis(1500);

/// Every open terminal of every window, by id.
#[derive(Default)]
pub(crate) struct Terminals {
    sessions: Mutex<HashMap<u32, Session>>,
    next: AtomicU32,
}

impl Terminals {
    /// Register a started session and return the id the window names it by.
    pub(crate) fn insert(&self, session: Session) -> u32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner).insert(id, session);
        id
    }

    /// Run `action` on terminal `id`, provided window `label` opened it: one
    /// window can never type into, resize or close another's shell.
    pub(crate) fn with<T>(
        &self, label: &str, id: u32, action: impl FnOnce(&Session) -> T,
    ) -> Result<T, String> {
        let sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        match sessions.get(&id) {
            Some(session) if session.window() == label => Ok(action(session)),
            _ => Err("This terminal has closed.".to_string()),
        }
    }

    /// End terminal `id` of window `label`. Returns at once; the grace period
    /// runs on its own thread.
    pub(crate) fn close(&self, label: &str, id: u32) {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        if sessions.get(&id).is_some_and(|session| session.window() == label) {
            if let Some(session) = sessions.remove(&id) {
                session.end(GRACE);
            }
        }
    }

    /// End every terminal `keep` refuses, given its window and the project it
    /// was opened in.
    pub(crate) fn retain(&self, keep: impl Fn(&str, &Path) -> bool) {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        let ended: Vec<u32> = sessions
            .iter()
            .filter(|(_, session)| !keep(session.window(), session.root()))
            .map(|(id, _)| *id)
            .collect();
        for id in ended {
            if let Some(session) = sessions.remove(&id) {
                session.end(GRACE);
            }
        }
    }

    /// End every terminal window `label` opened: its page reloaded or closed.
    pub(crate) fn close_window(&self, label: &str) {
        self.retain(|window, _| window != label);
    }

    /// End every terminal and wait for them: Lattice is quitting, and a
    /// thread left to finish the grace period would die with it.
    pub(crate) fn close_all_and_wait(&self) {
        let sessions: Vec<Session> = self
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain()
            .map(|(_, session)| session)
            .collect();
        let hangups: Vec<_> = sessions.into_iter().map(Session::hang_up).collect();
        let deadline = std::time::Instant::now() + QUIT_GRACE;
        for hangup in hangups {
            hangup.finish(deadline.saturating_duration_since(std::time::Instant::now()));
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner).len()
    }
}

#[cfg(test)]
mod tests;
