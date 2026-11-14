//! The stalled-build hold, as the Tauri app's `stalled-build.ts` keeps it.
//!
//! A build stopped because TeX made no progress (`build-stalled`) would only
//! stall again on the same inputs, so automatic builds wait for any input to
//! change: a save, or the Agent, Overleaf or another editor through the
//! watcher, in whichever file. Keyed on the project's input revision, which
//! moves on each of those and on a project switch, not on the open file's
//! text. Build still runs on request.

use lattice_core::models::Diagnostic;

#[derive(Default)]
pub(crate) struct StallHold {
    stalled_on: Option<u64>,
}

impl StallHold {
    /// Remember the input revision a finished build stalled on, or forget it
    /// after any other result.
    pub(crate) fn note(&mut self, diagnostics: &[Diagnostic], revision: u64) {
        self.stalled_on = diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == Some("build-stalled"))
            .then_some(revision);
    }

    /// Whether an automatic build of the inputs at `revision` is held.
    pub(crate) fn holds(&self, revision: u64) -> bool {
        self.stalled_on == Some(revision)
    }

    pub(crate) fn reset(&mut self) {
        self.stalled_on = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coded(code: Option<&'static str>) -> Diagnostic {
        Diagnostic {
            file: None,
            line: None,
            column: None,
            end_line: None,
            end_column: None,
            level: "error".into(),
            message: "TeX stopped making progress.".into(),
            code,
            params: Default::default(),
        }
    }

    #[test]
    fn a_stall_holds_automatic_builds_until_an_input_changes() {
        let mut hold = StallHold::default();
        hold.note(&[coded(Some("build-stalled"))], 4);
        assert!(hold.holds(4));
        assert!(!hold.holds(5));
        hold.note(&[coded(None)], 5);
        assert!(!hold.holds(4));
    }
}
