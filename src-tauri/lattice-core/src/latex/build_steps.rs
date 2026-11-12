//! The passes a build ran, timed as they happen, for the Build button's
//! sequence (pdflatex, bibtex, pdflatex again, …).
//!
//! latexmk announces each pass it starts with `Run number N of rule 'R'` on
//! its own output, so the steps are read off that output as it streams, not
//! guessed from the document: a rerun for references, biber in place of
//! bibtex, xdvipdfmx after XeLaTeX, or no pass at all ("All targets are
//! up-to-date") are all what this build really did. A step ends when the next
//! one starts or the process exits, so latexmk's own bookkeeping between
//! passes counts towards the pass before it.

use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildStep {
    /// The program, as latexmk names its rule without the file it runs on:
    /// `pdflatex`, `xelatex`, `bibtex`, `biber`, `makeindex`, `xdvipdfmx`, …;
    /// `pdflatex -ini` makes the preamble format before latexmk starts.
    pub tool: String,
    /// Which run of this tool it is within the build, from 1.
    pub run: u32,
    /// One of the cold-build prewarm's draft passes, which write no PDF.
    pub draft: bool,
    /// When it started, after the build did.
    pub started_ms: u64,
    /// How long it took; absent while it is still running.
    pub duration_ms: Option<u64>,
}

type Report = Box<dyn Fn(u64, &[BuildStep]) + Send + Sync>;

/// One build's steps so far. `report` hears every change, with the build's
/// elapsed time, so the window can draw the sequence while it runs.
pub struct BuildSteps {
    started: Instant,
    steps: Mutex<Vec<BuildStep>>,
    report: Report,
}

impl BuildSteps {
    pub fn new(report: impl Fn(u64, &[BuildStep]) + Send + Sync + 'static) -> Self {
        Self { started: Instant::now(), steps: Mutex::new(Vec::new()), report: Box::new(report) }
    }

    /// Steps nobody watches live, for tests that build.
    #[cfg(test)]
    pub fn silent() -> Self {
        Self::new(|_, _| {})
    }

    pub fn started(&self) -> Instant {
        self.started
    }

    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// The lock only guards a list of plain records; a panic elsewhere while
    /// it was held cannot have left one half-written.
    fn lock(&self) -> MutexGuard<'_, Vec<BuildStep>> {
        self.steps.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn close_running(steps: &mut [BuildStep], now: u64) -> bool {
        match steps.last_mut() {
            Some(step) if step.duration_ms.is_none() => {
                step.duration_ms = Some(now.saturating_sub(step.started_ms));
                true
            }
            _ => false,
        }
    }

    /// A pass of `tool` starts now; the one before it, if still open, ends.
    pub fn begin(&self, tool: &str, draft: bool) {
        let now = self.elapsed_ms();
        let mut steps = self.lock();
        Self::close_running(&mut steps, now);
        let run = 1 + steps.iter().filter(|step| step.tool == tool && step.draft == draft).count();
        steps.push(BuildStep {
            tool: tool.to_string(),
            run: u32::try_from(run).unwrap_or(u32::MAX),
            draft,
            started_ms: now,
            duration_ms: None,
        });
        (self.report)(now, &steps);
    }

    /// The process running the open step exited.
    pub fn finish(&self) {
        let now = self.elapsed_ms();
        let mut steps = self.lock();
        if Self::close_running(&mut steps, now) {
            (self.report)(now, &steps);
        }
    }

    /// One line of latexmk's output, as it arrives.
    pub fn line(&self, line: &[u8]) {
        if let Some(tool) = announced_pass(&String::from_utf8_lossy(line)) {
            self.begin(&tool, false);
        }
    }

    pub fn take(&self) -> Vec<BuildStep> {
        std::mem::take(&mut *self.lock())
    }
}

/// The tool of a pass latexmk announces on `line`: `Run number 2 of rule
/// 'bibtex main'` is bibtex. A custom dependency (`cusdep glo gls main`) is
/// named by the conversion it makes.
fn announced_pass(line: &str) -> Option<String> {
    let rest = &line[line.find("Run number ")? + "Run number ".len()..];
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    let rule = rest.strip_prefix(" of rule '")?;
    let rule = &rule[..rule.find('\'')?];
    let mut words = rule.split_whitespace();
    match words.next()? {
        "cusdep" => {
            let (from, to) = (words.next()?, words.next()?);
            Some(format!("{from} → {to}"))
        }
        tool => Some(tool.to_string()),
    }
}
