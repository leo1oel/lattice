//! Stops a TeX run that has stopped getting anywhere. A runaway macro can loop
//! for ever printing the same error, and waiting for terminal input prints
//! nothing, so progress is any output other than text the run has printed
//! already. It is judged on chunks as they arrive: with `max_print_line` this
//! high TeX keeps `[1] [2] (./a.aux)` on one line until a warning or the end.

use super::build::cancelled_build;
use super::build_log::advice;
use super::BuildResult;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a run may go without progress. Long enough for a heavy page of
/// TikZ, which prints nothing until it is done.
pub(super) const STALL_LIMIT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(100);
/// Distinct lines remembered; past it, every line counts as new.
const MAX_SEEN_LINES: usize = 50_000;

fn trimmed(line: &[u8]) -> &[u8] {
    line.trim_ascii()
}

/// latexmk starting another step: the next pass may print the same text again.
fn starts_a_step(line: &[u8]) -> bool {
    line.starts_with(b"Latexmk:") || line.starts_with(b"Run number") || line.starts_with(b"Rule '")
}

/// The state a run's readers and its watchdog share.
pub(super) struct Progress {
    last: Mutex<Instant>,
    seen: Mutex<BTreeSet<Vec<u8>>>,
    finished: AtomicBool,
}

impl Progress {
    pub(super) fn new() -> Self {
        Self {
            last: Mutex::new(Instant::now()),
            seen: Mutex::new(BTreeSet::new()),
            finished: AtomicBool::new(false),
        }
    }

    /// Takes the next `chunk` of one stream; `tail` is that stream's unfinished line.
    pub(super) fn note(&self, tail: &mut Vec<u8>, chunk: &[u8]) {
        let Ok(mut seen) = self.seen.lock() else { return };
        let mut moved = false;
        for piece in chunk.split_inclusive(|byte| *byte == b'\n') {
            tail.extend_from_slice(piece);
            let line = trimmed(tail);
            if tail.last() == Some(&b'\n') {
                if starts_a_step(line) {
                    seen.clear();
                }
                moved |= !line.is_empty()
                    && (seen.len() >= MAX_SEEN_LINES || seen.insert(line.to_vec()));
                tail.clear();
            } else if !line.is_empty() {
                // Unfinished: new unless a line seen before begins with it.
                moved |= !seen
                    .range(line.to_vec()..)
                    .next()
                    .is_some_and(|known| known.starts_with(line));
            }
        }
        drop(seen);
        if moved {
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
    let place = last_position(partial_log);
    let seconds = format!("{:.0}", started.elapsed().as_secs_f32());
    let stopped =
        format!("TeX stopped making progress, so the build was stopped after {seconds} s.");
    let message = match &place {
        Some(place) => format!("{stopped} Look for an unfinished command just before {place}."),
        None => format!("{stopped} Look for an unfinished command."),
    };
    let place = place.unwrap_or_default();
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

    /// Whether this chunk counted, on a clock already run out.
    fn moves(progress: &Progress, tail: &mut Vec<u8>, chunk: &str) -> bool {
        *progress.last.lock().unwrap() = Instant::now() - Duration::from_secs(10);
        progress.note(tail, chunk.as_bytes());
        progress.last.lock().unwrap().elapsed() < Duration::from_secs(5)
    }

    #[test]
    fn a_repeating_error_is_not_progress_even_split_into_chunks() {
        let progress = Progress::new();
        let tail = &mut Vec::new();
        assert!(moves(&progress, tail, "./main.tex:83: Package chemnum Error\nl.83 \\begin\n"));
        assert!(!moves(&progress, tail, "./main.tex:83: Package chemnum Error\n"));
        assert!(!moves(&progress, tail, "./main.tex:83: Pack"));
        assert!(!moves(&progress, tail, "age chemnum Error\nl.83 \\begin\n"));
        assert!(!moves(&progress, tail, "\n  \n"));
    }

    #[test]
    fn any_new_output_is_progress_without_a_newline() {
        let progress = Progress::new();
        let tail = &mut Vec::new();
        for chunk in ["(./main.aux)", " [1]", " [2]", " (./c.tex"] {
            assert!(moves(&progress, tail, chunk), "{chunk}");
        }
        assert!(moves(&progress, tail, "\nINFO - Found 2000 citekeys\n"));
        assert!(moves(&progress, tail, "luaotfload | db : Reloading system fonts\n"));
    }

    #[test]
    fn a_further_pass_may_print_the_same_text() {
        let progress = Progress::new();
        let tail = &mut Vec::new();
        assert!(moves(&progress, tail, "Overfull box on page one\n"));
        assert!(!moves(&progress, tail, "Overfull box on page one\n"));
        assert!(moves(&progress, tail, "Run number 2 of rule 'pdflatex'\n"));
        assert!(moves(&progress, tail, "Overfull box on page one\n"));
    }

    #[test]
    fn says_where_only_when_it_knows() {
        let started = Instant::now();
        let known = stalled_build(started, "./main.tex:77: x\n", "main.tex");
        assert!(known.diagnostics[0].message.ends_with("just before main.tex:77."));
        let unknown = stalled_build(started, "no position", "main.tex");
        assert!(unknown.diagnostics[0].message.ends_with("Look for an unfinished command."));
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
