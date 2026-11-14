//! Automatic builds while the live preview is live
//! (`src/live-preview/quiet-builds.ts`).
//!
//! rtex already redraws the paragraph being typed, so the full latexmk build
//! a save asks for only brings page breaks, references, SyncTeX and the
//! exported PDF up to date. While the live preview is live on a .tex file,
//! that build waits for a pause in typing and runs quietly: no spinner on
//! the Build button, the live preview's dot pulsing instead. Its errors and
//! warnings show as any build's do. Build, export and SyncTeX jumps never
//! wait and are never quiet, and without a live preview an automatic build
//! runs as it always has. The shell runs the schedule
//! (`shell/build.rs`); this is its clock.

use std::time::{Duration, Instant};

use gpui::Task;

/// How long typing must pause before the full build runs (the editor itself
/// saves after its own pause).
pub const IDLE: Duration = Duration::from_millis(4_000);
/// However long the typing runs, the full PDF is never further behind the
/// saved text than this.
pub const MAX_WAIT: Duration = Duration::from_millis(30_000);

#[derive(Default)]
pub struct QuietBuilds {
    /// When the oldest save no build has compiled yet was made.
    since: Option<Instant>,
    timer: Option<Task<()>>,
}

impl QuietBuilds {
    /// A save asked for a build at `now`: start counting from it, unless an
    /// earlier one is still waiting.
    pub fn saved(&mut self, now: Instant) {
        self.since.get_or_insert(now);
    }

    /// The waiting build has waited as long as it may.
    pub fn due(&self, now: Instant) -> bool {
        self.since
            .is_some_and(|since| now.duration_since(since) >= MAX_WAIT)
    }

    pub fn waiting(&self) -> bool {
        self.since.is_some()
    }

    /// The wait's timer: dropping the old one cancels it.
    pub fn set_timer(&mut self, timer: Task<()>) {
        self.timer = Some(timer);
    }

    /// Another build compiles what the waiting one would have.
    pub fn cancel(&mut self) {
        self.timer = None;
        self.since = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_build_waits_at_most_the_longest_wait_from_the_first_save() {
        let mut quiet = QuietBuilds::default();
        let start = Instant::now();
        assert!(!quiet.due(start));
        quiet.saved(start);
        quiet.saved(start + Duration::from_secs(20));
        assert!(!quiet.due(start + Duration::from_secs(29)));
        assert!(quiet.due(start + MAX_WAIT));
        quiet.cancel();
        assert!(!quiet.waiting());
        assert!(!quiet.due(start + Duration::from_secs(60)));
    }
}
