//! Builds for the edits that reach the project without passing through an
//! editor, as the Tauri app's `watched-builds.ts` runs them.
//!
//! The Agent writes the project's files itself, and so do a terminal,
//! another editor and a sync. Autosave never sees those writes, so the PDF
//! stayed as it was until the writer pressed Build. The project watcher sees
//! every one of them, and its reports drive this: each change to a build
//! input makes the compiled PDF older at once, and with automatic builds on,
//! a burst of them builds once the writes pause.
//!
//! The same reports carry what the window's own documents write (an editor's
//! save builds itself, and an outside edit of an open file reaches its
//! editor as a disk edit, which builds too) and everything a build writes.
//! The Tauri app tells its own writes apart by their echo; here the paths of
//! the open documents are left to them. Build output is told apart by name
//! (`inputs`) and by the build's own recorder, which names a package's
//! scratch file no list of extensions knows: a pass rewriting one must never
//! start the next pass.

use std::{collections::HashSet, time::Duration};

use super::inputs;

/// How long the writes must pause before they build: an Agent's edits come
/// in quick runs of tool calls.
pub(crate) const IDLE: Duration = Duration::from_millis(1_500);

/// What the pause decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fire {
    /// Nothing reported since the last pass is an input.
    Nothing,
    /// A build runs, which may be the one writing these files: decide once
    /// it has finished and its recorder has said what it wrote.
    Wait,
    /// Build.
    Build,
}

/// The watcher's reports since the last pass, for one project.
#[derive(Default)]
pub(crate) struct WatchedBuilds {
    /// What the last build wrote, by its recorder.
    written: HashSet<String>,
    /// Inputs changed since the last pass started.
    pending: HashSet<String>,
    /// The watcher could not say which files changed.
    unknown: bool,
    /// The pause came while a build ran.
    waiting: bool,
}

impl WatchedBuilds {
    /// The watcher reported `paths` (`None`: it lost track and rescanned).
    /// True when one of them is a build input, which makes the compiled PDF
    /// older than the project; `left_to_documents` names the paths the
    /// window's open documents answer for themselves.
    pub(crate) fn report(
        &mut self,
        paths: Option<&[String]>,
        root_documents: &[String],
        left_to_documents: impl Fn(&str) -> bool,
    ) -> bool {
        let Some(paths) = paths else {
            self.unknown = true;
            return true;
        };
        let mut changed = false;
        for path in paths {
            let Some(file) = inputs::normalize(path) else {
                continue;
            };
            if self.written.contains(&file)
                || inputs::is_build_output(&file, root_documents)
                || left_to_documents(&file)
            {
                continue;
            }
            changed = true;
            self.pending.insert(file);
        }
        changed
    }

    /// An open editor took in an outside edit of `path`, which its own
    /// report left out. True when it is a build input, as `report` tells.
    pub(crate) fn noted(&mut self, path: &str, root_documents: &[String]) -> bool {
        self.report(Some(&[path.to_string()]), root_documents, |_| false)
    }

    /// The writes paused (`IDLE` after the last report): build or not.
    pub(crate) fn fire(&mut self, building: bool) -> Fire {
        if building {
            self.waiting = true;
            return Fire::Wait;
        }
        for path in &self.written {
            self.pending.remove(path);
        }
        if self.pending.is_empty() && !self.unknown {
            Fire::Nothing
        } else {
            Fire::Build
        }
    }

    /// A pause is being waited for again: an earlier wait is over.
    pub(crate) fn scheduled(&mut self) {
        self.waiting = false;
    }

    /// A build pass is about to read the project: it compiles every change
    /// reported so far.
    pub(crate) fn pass_started(&mut self) {
        self.pending.clear();
        self.unknown = false;
    }

    /// A pass finished and its recorder named the project files it wrote.
    pub(crate) fn pass_wrote(&mut self, outputs: &[String]) {
        self.written = outputs
            .iter()
            .filter_map(|path| inputs::normalize(path))
            .collect();
    }

    /// The builds are over: whether a pause that came during one is to be
    /// waited for again. Not decided at once: the watcher reports the
    /// build's own writes a moment after it ends, and those must not count
    /// as the pause being over.
    pub(crate) fn idle(&self) -> bool {
        self.waiting
    }

    /// Another project, or this one entered again.
    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| path.to_string()).collect()
    }

    fn roots() -> Vec<String> {
        vec!["main.tex".into()]
    }

    #[test]
    fn an_outside_write_to_an_input_builds_once_the_writes_pause() {
        let mut watched = WatchedBuilds::default();
        assert!(watched.report(Some(&paths(&["chapters/intro.tex"])), &roots(), |_| false));
        assert_eq!(watched.fire(false), Fire::Build);
        watched.pass_started();
        assert_eq!(watched.fire(false), Fire::Nothing);
    }

    #[test]
    fn build_output_and_open_documents_are_not_reported_changes() {
        let mut watched = WatchedBuilds::default();
        let open = |path: &str| path == "main.tex";
        assert!(!watched.report(
            Some(&paths(&[
                "main.aux",
                "main.pdf",
                "./main.tex",
                ".git/index"
            ])),
            &roots(),
            open
        ));
        assert_eq!(watched.fire(false), Fire::Nothing);
    }

    #[test]
    fn what_the_last_pass_wrote_never_starts_the_next() {
        let mut watched = WatchedBuilds::default();
        watched.pass_wrote(&paths(&["figures/plot-cache.dat"]));
        assert!(
            !watched.report(Some(&paths(&["figures/plot-cache.dat"])), &roots(), |_| {
                false
            })
        );
        assert_eq!(watched.fire(false), Fire::Nothing);
    }

    #[test]
    fn a_pause_during_a_build_is_decided_after_it() {
        let mut watched = WatchedBuilds::default();
        assert!(watched.report(Some(&paths(&["refs.bib"])), &roots(), |_| false));
        assert_eq!(watched.fire(true), Fire::Wait);
        assert!(watched.idle());
        watched.scheduled();
        assert!(!watched.idle());
        // The running pass started before the write: it is still pending.
        assert_eq!(watched.fire(false), Fire::Build);
    }

    #[test]
    fn an_open_editors_outside_edit_builds_unless_a_build_wrote_it() {
        let mut watched = WatchedBuilds::default();
        watched.pass_wrote(&paths(&["figures/plot-cache.dat"]));
        assert!(!watched.noted("main.bbl", &roots()));
        assert!(!watched.noted("./main.log", &roots()));
        assert!(!watched.noted("figures/plot-cache.dat", &roots()));
        assert_eq!(watched.fire(false), Fire::Nothing);
        assert!(watched.noted("chapters/intro.tex", &roots()));
        assert_eq!(watched.fire(false), Fire::Build);
    }

    #[test]
    fn a_lost_report_builds() {
        let mut watched = WatchedBuilds::default();
        assert!(watched.report(None, &roots(), |_| false));
        assert_eq!(watched.fire(false), Fire::Build);
        watched.reset();
        assert_eq!(watched.fire(false), Fire::Nothing);
    }
}
