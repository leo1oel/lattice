//! The machine-wide input lock, held only around the moments a scenario needs
//! the front of the machine, so several scenario runs (two worktrees, two
//! validation runs) proceed side by side and queue only for those moments.
//!
//! What two runs at once really share is the front: macOS has one active app
//! with one key window, and one general pasteboard. The scenario's native
//! input does not go through the window server (`native.rs` hands each
//! `NSEvent` to this run's own `NSWindow` with `sendEvent:`), so a click or
//! key never lands in the other run's app. What did fail them was activation:
//! one run making its window key took the key window from the other in the
//! middle of a step, which closed its context menu, blurred its rename field
//! or stopped its overlay painting, and a copy in one run overwrote the
//! pasteboard the other was about to read.
//!
//! So a run keeps its app inactive, except inside a foreground section
//! (`Run::foreground`), which:
//!
//! 1. takes the lock, `/tmp/lattice-gpui-e2e.lock`, by the protocol
//!    `scripts/lib/gpui-lock.mjs` uses: a directory `mkdir` creates
//!    atomically, holding an `owner` file of "<pid> <label>", which a waiter
//!    takes over once that pid has died, printing "waiting for the GPUI e2e
//!    lock held by <owner>" while it waits;
//! 2. activates the app and makes this run's window key (`bring_to_front`),
//!    and waits until it is, so no other run's window holds the key window
//!    while this one sends input that needs it;
//! 3. on leaving, deactivates the app and gives the lock back.
//!
//! Steps that need the app active or the window key (hover painting, focus
//! and blur, menus and popovers that close when the window resigns key, the
//! input method, webview keyboard focus, anything that calls
//! `activate_window`) and steps that write and read the pasteboard run inside
//! one. Every other step, native clicks and keys included, runs outside one,
//! with its app inactive, so another run's foreground section changes nothing
//! it depends on. Sections nest, and only the outermost takes the lock.
//!
//! Most of those steps need only GPUI's own idea of focus: the window active,
//! so focused editors draw their carets and overlays, frames come at the full
//! rate and focus events fire. gpui-fast's lab switch `GPUI_LAB_ASSUME_KEY`
//! (patches/README.md, set by script/e2e) makes every window report itself
//! the key window of the active app and keeps activation from taking the
//! front, so those steps (`Run::focused`) take no lock under it and run beside
//! other runs. What macOS serves only the real key window of the active app
//! still takes one (`Run::foreground`): the input method, a webview's keyboard
//! focus, the menu bar's key equivalents such as ⌘, and a menu closing as
//! its window resigns key.
//!
//! The run also watches for the app becoming active outside a section (a
//! step that activates a window and is not in one): it records the step and
//! deactivates the app again, and the e2e scenario fails a step naming them,
//! because such a step would take the key window from a run in its section.

use std::{
    cell::{Cell, RefCell},
    io,
    path::{Path, PathBuf},
    rc::Rc,
    time::{Duration, Instant},
};

/// Where the lock lives: /tmp, not the per-session TMPDIR, so every session
/// on the machine shares it. `scripts/lib/gpui-lock.mjs` keeps its build lock
/// beside it, by the same protocol.
pub const LOCK_DIR: &str = "/tmp/lattice-gpui-e2e.lock";

/// How long after leaving a section the app may still read as active while
/// macOS hands activation back.
const DEACTIVATION_GRACE: Duration = Duration::from_secs(2);

/// What one attempt at the lock did.
#[derive(Debug, PartialEq, Eq)]
pub enum Attempt {
    Taken,
    /// Someone else has it; their owner line, or empty while they are still
    /// writing it.
    HeldBy(String),
    /// Its holder had died; the lock was removed, so the next attempt can
    /// take it.
    TookOver(u32),
}

/// One attempt to take the lock at `dir` as `pid`, labelled `label`.
pub fn try_acquire(dir: &Path, pid: u32, label: &str) -> io::Result<Attempt> {
    match std::fs::create_dir(dir) {
        Ok(()) => {
            std::fs::write(dir.join("owner"), format!("{pid} {label}\n"))?;
            return Ok(Attempt::Taken);
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    // Created but not yet written reads as empty; the next poll reads it.
    let owner = std::fs::read_to_string(dir.join("owner"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let holder = owner
        .split(' ')
        .next()
        .and_then(|pid| pid.parse::<u32>().ok());
    if let Some(holder) = holder
        && holder != 0
        && !alive(holder)
    {
        std::fs::remove_dir_all(dir).or_else(|error| {
            // Another waiter took it over first.
            if error.kind() == io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            }
        })?;
        return Ok(Attempt::TookOver(holder));
    }
    Ok(Attempt::HeldBy(owner))
}

/// Give the lock at `dir` back.
pub fn release(dir: &Path) {
    if let Err(error) = std::fs::remove_dir_all(dir)
        && error.kind() != io::ErrorKind::NotFound
    {
        log::warn!("could not release {}: {error}", dir.display());
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // Signal 0 checks the pid without sending anything; EPERM means it is
    // alive under another user.
    let signalled = unsafe { libc::kill(pid, 0) } == 0;
    signalled || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    true
}

/// The run's side of the lock: how deep in foreground sections it is, and
/// what it saw activate outside one. Shared by every `Run` of the process
/// (a second window's), so a section in one is a section in all.
pub struct InputLock {
    dir: PathBuf,
    label: String,
    depth: Cell<usize>,
    /// Whether the outermost section took the lock (a platform without the
    /// lock only fronts the window).
    holding: Cell<bool>,
    left_at: Cell<Option<Instant>>,
    /// The last step a scenario recorded, to name where an activation
    /// outside a section happened.
    last_step: Rc<RefCell<String>>,
    outside: RefCell<Vec<String>>,
    /// The outermost section under way: what it is for, when it was asked
    /// for, and when it got the lock.
    current: RefCell<Option<(&'static str, Instant, Option<Instant>)>>,
    /// Each section: what for, seconds waited for the lock, seconds held.
    sections: RefCell<Vec<(&'static str, f32, f32)>>,
    /// The sections that needed only GPUI's focus and, with the lab's
    /// assumed key window (`assume_key`), ran without the lock.
    unlocked: RefCell<Vec<&'static str>>,
}

/// Whether gpui-fast's lab switch `GPUI_LAB_ASSUME_KEY` is on
/// (patches/README.md): every window of the run acts as the key window of
/// the active app, and neither activating a window nor the app takes the
/// machine's front. Sections that need only that (`Run::focused`) then run
/// without the lock.
pub fn assume_key() -> bool {
    cfg!(target_os = "macos") && std::env::var_os("GPUI_LAB_ASSUME_KEY").is_some()
}

impl InputLock {
    pub fn new() -> Self {
        // The label is shown to whoever waits: the worktree, as script/e2e
        // passes it.
        let label = std::env::var("LATTICE_GPUI_E2E_LOCK_LABEL").unwrap_or_else(|_| {
            std::env::current_dir()
                .map(|dir| dir.display().to_string())
                .unwrap_or_default()
        });
        Self {
            dir: PathBuf::from(LOCK_DIR),
            label: format!("{label} (lattice-gpui scenario)"),
            depth: Cell::new(0),
            holding: Cell::new(false),
            left_at: Cell::new(None),
            last_step: Rc::new(RefCell::new(String::new())),
            outside: RefCell::new(Vec::new()),
            current: RefCell::new(None),
            sections: RefCell::new(Vec::new()),
            unlocked: RefCell::new(Vec::new()),
        }
    }

    /// A section that needed only GPUI's focus ran without the lock.
    pub fn without_lock(&self, what: &'static str) {
        // Inside a section that holds the lock it is part of that one.
        if !self.in_section() {
            self.unlocked.borrow_mut().push(what);
        }
    }

    pub fn last_step(&self) -> Rc<RefCell<String>> {
        self.last_step.clone()
    }

    pub fn in_section(&self) -> bool {
        self.depth.get() > 0
    }

    /// Enter a section for `what`; true when it is the outermost, which has
    /// to take the lock and front the window.
    pub fn enter(&self, what: &'static str) -> bool {
        let depth = self.depth.get();
        self.depth.set(depth + 1);
        if depth == 0 {
            *self.current.borrow_mut() = Some((what, Instant::now(), None));
        }
        depth == 0
    }

    /// The outermost section got the lock.
    pub fn taken(&self) {
        if let Some((_, _, taken)) = self.current.borrow_mut().as_mut() {
            *taken = Some(Instant::now());
        }
    }

    /// One attempt at the lock, for the outermost section.
    pub fn try_take(&self) -> io::Result<Attempt> {
        if !cfg!(target_os = "macos") {
            // Elsewhere the scenario has the machine to itself (CI's
            // Windows runner), and no pid check guards a stale lock.
            return Ok(Attempt::Taken);
        }
        let attempt = try_acquire(&self.dir, std::process::id(), &self.label)?;
        if attempt == Attempt::Taken {
            self.holding.set(true);
        }
        Ok(attempt)
    }

    /// Leave a section; the outermost deactivates the app and gives the lock
    /// back.
    pub fn leave(&self) {
        let depth = self.depth.get().saturating_sub(1);
        self.depth.set(depth);
        if depth > 0 {
            return;
        }
        crate::native::deactivate_app();
        self.left_at.set(Some(Instant::now()));
        if self.holding.replace(false) {
            release(&self.dir);
        }
        if let Some((what, asked, taken)) = self.current.borrow_mut().take() {
            let taken = taken.unwrap_or(asked);
            let (waited, held) = ((taken - asked).as_secs_f32(), taken.elapsed().as_secs_f32());
            eprintln!(
                "  (held the GPUI e2e lock {held:.1} s, after waiting {waited:.1} s, for {what})"
            );
            self.sections.borrow_mut().push((what, waited, held));
        }
    }

    /// The sections the run held the lock for, for its result.
    pub fn summary(&self) -> serde_json::Value {
        let sections = self.sections.borrow();
        let total =
            |pick: fn(&(&'static str, f32, f32)) -> f32| sections.iter().map(pick).sum::<f32>();
        serde_json::json!({
            "held_seconds": total(|section| section.2),
            "waited_seconds": total(|section| section.1),
            "sections": sections
                .iter()
                .map(|(what, waited, held)| serde_json::json!({ "for": what, "waited": waited, "held": held }))
                .collect::<Vec<_>>(),
            "assume_key": assume_key(),
            "without_lock": *self.unlocked.borrow(),
        })
    }

    /// Called as the scenario draws frames: if the app became active outside
    /// a section, note the step and put it back in the background.
    pub fn observe(&self) {
        if self.in_section()
            || self
                .left_at
                .get()
                .is_some_and(|left| left.elapsed() < DEACTIVATION_GRACE)
            || !crate::native::app_is_active()
        {
            return;
        }
        let step = self.last_step.borrow().clone();
        let mut outside = self.outside.borrow_mut();
        if outside.last() != Some(&step) {
            log::warn!("the app became active outside a foreground section, after step {step:?}");
            outside.push(step);
        }
        crate::native::deactivate_app();
        self.left_at.set(Some(Instant::now()));
    }

    /// The steps after which the app became active outside a section.
    pub fn activations_outside(&self) -> Vec<String> {
        self.outside.borrow().clone()
    }

    /// Give the lock back whatever the depth, as the scenario ends.
    pub fn release_all(&self) {
        if self.depth.get() > 0 {
            self.depth.set(1);
            self.leave();
        }
    }
}

impl Drop for InputLock {
    fn drop(&mut self) {
        if self.holding.get() {
            release(&self.dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_free_lock_and_names_its_owner() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = scratch.path().join("lock");
        assert_eq!(
            try_acquire(&dir, std::process::id(), "here").unwrap(),
            Attempt::Taken
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("owner")).unwrap(),
            format!("{} here\n", std::process::id())
        );
        release(&dir);
        assert!(!dir.exists());
    }

    #[test]
    fn waits_for_a_live_holder() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = scratch.path().join("lock");
        try_acquire(&dir, std::process::id(), "first").unwrap();
        assert_eq!(
            try_acquire(&dir, std::process::id() + 1, "second").unwrap(),
            Attempt::HeldBy(format!("{} first", std::process::id()))
        );
        // A holder still writing its owner file is waited for too.
        std::fs::remove_file(dir.join("owner")).unwrap();
        assert_eq!(
            try_acquire(&dir, 1, "second").unwrap(),
            Attempt::HeldBy(String::new())
        );
    }

    #[test]
    fn lists_sections_run_without_the_lock_outside_any_section() {
        let lock = InputLock::new();
        lock.without_lock("editor_adapter");
        // Inside a section that takes the lock, one that needs only GPUI's
        // focus is part of it, so it is not listed as run without it.
        lock.enter("settings");
        lock.without_lock("nested");
        let summary = lock.summary();
        assert_eq!(
            summary["without_lock"],
            serde_json::json!(["editor_adapter"])
        );
        assert_eq!(summary["held_seconds"], serde_json::json!(0.0));
    }

    #[cfg(unix)]
    #[test]
    fn takes_over_from_a_dead_holder() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = scratch.path().join("lock");
        // A pid that has exited: a child that was waited for.
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("owner"), format!("{dead} gone\n")).unwrap();
        assert_eq!(
            try_acquire(&dir, std::process::id(), "next").unwrap(),
            Attempt::TookOver(dead)
        );
        assert_eq!(
            try_acquire(&dir, std::process::id(), "next").unwrap(),
            Attempt::Taken
        );
    }
}
