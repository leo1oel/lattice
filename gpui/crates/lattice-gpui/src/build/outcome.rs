//! How the last build ended, as the Build button and the diagnostics card
//! report it (`src/app/build-outcome.ts`, `src/build/build-result-text.ts`):
//! its time when it succeeded, what its diagnostics counted, the document it
//! compiled, the passes it ran, and the one sentence both surfaces use.

use std::time::{Duration, Instant};

use lattice_core::{
    latex::{BuildResult, BuildStep},
    models::Diagnostic,
};

use lattice_i18n::{join_phrases, t, tc};

use super::diagnostics::{self, Counts};

#[derive(Clone, Debug)]
pub struct BuildOutcome {
    pub succeeded: bool,
    /// A failed build whose PDF on screen is its own: TeX carried on past
    /// its errors.
    pub wrote_pdf: bool,
    pub duration: Duration,
    pub counts: Counts,
    pub root_document: Option<String>,
    pub finished_at: Instant,
    /// The passes it ran, how many pages it wrote and whether SyncTeX came
    /// with them.
    pub steps: Vec<BuildStep>,
    pub pages: Option<u32>,
    pub synctex: Option<bool>,
    /// The problem the writer meets first (an error before a warning), for
    /// the Build button's sequence.
    pub issue: Option<Diagnostic>,
    /// Nothing changed since the failed build before it, and nobody asked:
    /// it restates that build's errors (lattice-core `build::unchanged`).
    pub unchanged: bool,
}

impl BuildOutcome {
    /// The outcome a finished pass reports; `None` for one the writer
    /// stopped, which reports nothing.
    pub fn of(result: &BuildResult, wrote_pdf: bool) -> Option<Self> {
        let cancelled = result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == Some("build-cancelled"));
        if cancelled && !result.success {
            return None;
        }
        let issue = diagnostics::sort(&result.diagnostics)
            .into_iter()
            .find(|diagnostic| matches!(diagnostic.level.as_str(), "error" | "warning"));
        Some(Self {
            succeeded: result.success,
            wrote_pdf,
            duration: Duration::from_millis(u64::try_from(result.duration_ms).unwrap_or(u64::MAX)),
            counts: diagnostics::summarize(&result.diagnostics),
            root_document: (!result.root_document.is_empty()).then(|| result.root_document.clone()),
            finished_at: Instant::now(),
            steps: result.steps.clone(),
            pages: result.pages,
            synctex: result.synctex,
            issue,
            unchanged: result.unchanged,
        })
    }

    /// The outcome of a build that could not start at all: no passes, no
    /// diagnostics.
    pub fn rejected() -> Self {
        Self {
            succeeded: false,
            wrote_pdf: false,
            duration: Duration::ZERO,
            counts: Counts::default(),
            root_document: None,
            finished_at: Instant::now(),
            steps: Vec::new(),
            pages: None,
            synctex: None,
            issue: None,
            unchanged: false,
        }
    }
}

/// "1 error, 2 warnings, 1 note", leaving out what the build did not
/// report. A capped list reads "40+ errors": the build reported more than
/// it listed.
pub fn counts_text(counts: &Counts) -> String {
    // The cap counts errors and warnings together; the "+" goes on errors when there are any.
    let more_errors = counts.capped && counts.error > 0;
    let more_warnings = counts.capped && counts.error == 0;
    let errors = counts.error;
    let warnings = counts.warning;
    let notes = counts.info;
    let error_text = match (errors, more_errors) {
        (0, _) => String::new(),
        (_, true) => t!("{errors}+ errors", errors = errors),
        (1, false) => t!("{errors} error", errors = errors),
        (_, false) => t!("{errors} errors", errors = errors),
    };
    let warning_text = match (warnings, more_warnings) {
        (0, _) => String::new(),
        (_, true) => t!("{warnings}+ warnings", warnings = warnings),
        (1, false) => t!("{warnings} warning", warnings = warnings),
        (_, false) => t!("{warnings} warnings", warnings = warnings),
    };
    let note_text = match notes {
        0 => String::new(),
        1 => t!("{notes} note", notes = notes),
        _ => t!("{notes} notes", notes = notes),
    };
    join_phrases(&[error_text, warning_text, note_text])
}

/// How a build ended, in the one sentence the Build button and the
/// diagnostics bar above the PDF both use: "Built", "Built with 2
/// warnings", "Build failed: 1 error". A build with warnings still built,
/// and says so first. So does a failed one whose PDF is on screen (TeX
/// carries on past errors unless the project stops on the first): "Built
/// with 2 errors" is what that PDF is.
pub fn headline(succeeded: bool, counts: &Counts, wrote_pdf: bool) -> String {
    let issues = counts_text(counts);
    match (succeeded, issues.is_empty()) {
        (true, true) => t!("Built").into(),
        (true, false) => t!("Built with {issues}", issues = issues),
        // Its own message: zh-CN's success sentence says the build succeeded.
        (false, false) if wrote_pdf && counts.error > 0 => tc!(
            "a failed build whose PDF was still written",
            "Built with {issues}",
            issues = issues
        ),
        (false, false) => t!("Build failed: {issues}", issues = issues),
        (false, true) => t!("Build failed").into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(error: usize, warning: usize, info: usize, capped: bool) -> Counts {
        Counts {
            error,
            warning,
            info,
            capped,
        }
    }

    #[test]
    fn counts_read_as_phrases() {
        assert_eq!(
            counts_text(&counts(1, 2, 1, false)),
            "1 error, 2 warnings, 1 note"
        );
        assert_eq!(counts_text(&counts(0, 1, 0, false)), "1 warning");
        assert_eq!(
            counts_text(&counts(40, 3, 0, true)),
            "40+ errors, 3 warnings"
        );
        assert_eq!(counts_text(&counts(0, 40, 0, true)), "40+ warnings");
        assert_eq!(counts_text(&Counts::default()), "");
    }

    #[test]
    fn the_headline_says_what_the_pdf_is() {
        assert_eq!(headline(true, &Counts::default(), false), "Built");
        assert_eq!(
            headline(true, &counts(0, 2, 0, false), false),
            "Built with 2 warnings"
        );
        assert_eq!(
            headline(false, &counts(1, 0, 0, false), false),
            "Build failed: 1 error"
        );
        assert_eq!(
            headline(false, &counts(2, 0, 0, false), true),
            "Built with 2 errors"
        );
        assert_eq!(headline(false, &Counts::default(), true), "Build failed");
    }
}
