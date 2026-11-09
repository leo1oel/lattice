//! The handle a project's build is stopped through: the process running now,
//! and whether the writer asked to stop.

use crate::commands;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Debug, Default)]
pub struct ActiveBuildState {
    pid: Option<u32>,
    cancelled: bool,
    /// `build` calls under way. One build runs several processes (prewarm,
    /// format, latexmk, reruns), so between two of them `pid` is None: a Stop
    /// there must still stop the build, and stays set until it ends.
    builds: u32,
}

/// Shared handle for the in-flight latexmk process group. Each project owns
/// one, from `ProjectResources`'s derived `Default`.
pub type ActiveBuild = Arc<Mutex<ActiveBuildState>>;

/// Take the lock, recovering from poisoning.
///
/// The guarded state is three plain scalars, so a thread that panicked while
/// holding the lock cannot have left them half-written. `panic = "abort"` is
/// deliberately off, which makes a poisoned mutex reachable, and refusing it
/// made every later build answer "cancelled" for the rest of the session. The
/// warning is the only trace of whatever panicked, so it is not optional.
fn state(active: &ActiveBuild) -> MutexGuard<'_, ActiveBuildState> {
    active.lock().unwrap_or_else(|poisoned| {
        log::warn!("Build state lock was poisoned by an earlier panic; recovering it");
        poisoned.into_inner()
    })
}

pub fn abort(active: &ActiveBuild) -> Result<bool, String> {
    let mut guard = state(active);
    if guard.pid.is_none() && !guard.cancelled && guard.builds == 0 {
        return Ok(false);
    }
    guard.cancelled = true;
    if let Some(pid) = guard.pid.take() {
        terminate(pid);
    }
    Ok(true)
}

/// Whether a build is under way for this project, between its processes
/// included: a restart would stop it.
pub fn is_running(active: &ActiveBuild) -> bool {
    let guard = state(active);
    guard.pid.is_some() || guard.builds > 0
}

/// latexmk and every pass it starts share the process group made at spawn.
pub(super) fn terminate(pid: u32) {
    commands::signal_process_group(pid, commands::TERM_SIGNAL);
}

/// Register an already-running process as this project's build. True when
/// its build was already stopped, so the caller ends the process at once.
pub(crate) fn begin_active(active: &ActiveBuild, pid: u32) -> Result<bool, String> {
    let mut guard = state(active);
    if guard.pid.is_some() {
        return Err(super::ALREADY_RUNNING.to_string());
    }
    guard.pid = Some(pid);
    if guard.builds == 0 {
        guard.cancelled = false;
    }
    Ok(guard.cancelled)
}

/// Returns whether this build was cancelled — never anything else. Reporting a
/// build the user never stopped as cancelled hides its real outcome, log and
/// all, which is what an unavailable lock used to do here.
pub(super) fn finish_active(active: &ActiveBuild) -> bool {
    let mut guard = state(active);
    guard.pid = None;
    if guard.builds > 0 {
        guard.cancelled
    } else {
        std::mem::take(&mut guard.cancelled)
    }
}

/// Holds a build open across its processes; a Stop made meanwhile ends with it.
pub(super) struct BuildSession<'a>(&'a ActiveBuild);

impl<'a> BuildSession<'a> {
    pub(super) fn open(active: &'a ActiveBuild) -> Self {
        let mut guard = state(active);
        if guard.builds == 0 {
            guard.cancelled = false;
        }
        guard.builds += 1;
        Self(active)
    }
}

impl Drop for BuildSession<'_> {
    fn drop(&mut self) {
        let mut guard = state(self.0);
        guard.builds -= 1;
        if guard.builds == 0 {
            guard.cancelled = false;
        }
    }
}
