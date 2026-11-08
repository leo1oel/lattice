//! Stops a TeX run that has stopped getting anywhere. A runaway macro can loop
//! for ever, some while printing the same error again and again, so what
//! counts is progress in the output, not output: a finished page, a file
//! opened, or latexmk moving on. Waiting for terminal input prints nothing and
//! is caught the same way.

use super::build::cancelled_build;
use super::build_log::advice;
use super::BuildResult;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a run may go without progress. Long enough for a heavy page of
/// TikZ, which prints nothing until it is done.
pub(super) const STALL_LIMIT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(100);

/// Whether a line of TeX or latexmk output shows the run moving forward.
pub(super) fn is_progress(line: &[u8]) -> bool {
    let text = String::from_utf8_lossy(line);
    let text = text.trim_start();
    if text.starts_with('!') || text.starts_with("l.") || text.starts_with("./") {
        return false;
    }
    text.starts_with("Latexmk:")
        || text.starts_with("Run number")
        || opens_a_file(text)
        || shipped_a_page(text)
}

fn opens_a_file(text: &str) -> bool {
    text.contains("(./") || text.contains("(/")
}

/// TeX's `[12]`, also with what it wrote into the page: `[12{map}]`.
fn shipped_a_page(text: &str) -> bool {
    text.split('[').skip(1).any(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
}

/// The state a run's readers and its watchdog share.
pub(super) struct Progress {
    last: Mutex<Instant>,
    finished: AtomicBool,
}

impl Progress {
    pub(super) fn new() -> Self {
        Self { last: Mutex::new(Instant::now()), finished: AtomicBool::new(false) }
    }

    pub(super) fn note(&self, line: &[u8]) {
        if is_progress(line) {
            if let Ok(mut last) = self.last.lock() {
                *last = Instant::now();
            }
        }
    }

    pub(super) fn finish(&self) {
        self.finished.store(true, Ordering::Relaxed);
    }

    /// Waits for the run to finish; true if it stalled for `limit` first.
    pub(super) fn stalled_for(&self, limit: Duration) -> bool {
        while !self.finished.load(Ordering::Relaxed) {
            if self.last.lock().is_ok_and(|last| last.elapsed() >= limit) {
                return true;
            }
            std::thread::sleep(POLL);
        }
        false
    }
}

/// Where the run stood: `main.tex:77`, from the last error TeX tied to a file and line.
pub(super) fn last_position(log: &str) -> Option<String> {
    log.lines().rev().find_map(|line| {
        let rest = line.trim().strip_prefix("./")?;
        let (file, after) = rest.split_once(".tex:")?;
        let number: String = after.chars().take_while(char::is_ascii_digit).collect();
        (!number.is_empty()).then(|| format!("{file}.tex:{number}"))
    })
}

/// A build stopped because TeX stopped getting anywhere, usually a command
/// left unfinished; the log says where it was.
pub(super) fn stalled_build(
    started: Instant, partial_log: &str, root_document: &str,
) -> BuildResult {
    let place = last_position(partial_log).unwrap_or_default();
    let seconds = format!("{:.0}", started.elapsed().as_secs_f32());
    let message = format!("TeX stopped making progress, so the build was stopped after {seconds}s. Look for an unfinished command just before {place}.");
    let mut result = cancelled_build(started, partial_log, root_document);
    result.diagnostics = vec![advice(
        "error",
        "build-stalled",
        &[("seconds", &seconds), ("place", &place)],
        message,
    )];
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repeating_error_is_not_progress() {
        for line in [
            "./main.tex:83: Package chemnum Error: The property `' for compound `\\begin ' is undefined",
            "! Missing \\endcsname inserted.",
            "l.83 \\begin",
            "The control sequence marked <to be read again> should",
            "",
        ] {
            assert!(!is_progress(line.as_bytes()), "{line}");
        }
    }

    #[test]
    fn pages_files_and_latexmk_are_progress() {
        for line in [
            "[12]",
            "text [3{/usr/map}]",
            "(./chapter.tex",
            "(/usr/share/a.sty",
            "Latexmk: Run number 2",
            "Run number 1 of rule",
        ] {
            assert!(is_progress(line.as_bytes()), "{line}");
        }
    }

    #[test]
    fn stalls_only_without_progress() {
        let progress = Progress::new();
        assert!(progress.stalled_for(Duration::ZERO));
        progress.finish();
        assert!(!progress.stalled_for(Duration::from_secs(5)));
    }

    #[test]
    fn finds_where_the_run_was() {
        let tail = "./main.tex:77: Package chemnum Error: The property `'Caught a SIGTERM at /Library/TeX/texbin/latexmk line 12907.\n";
        assert_eq!(last_position(tail).as_deref(), Some("main.tex:77"));
        assert_eq!(last_position("./a/b.tex:3: x\nlater noise\n").as_deref(), Some("a/b.tex:3"));
        assert_eq!(last_position("nothing"), None);
    }
}
