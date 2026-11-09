use super::*;
use crate::test_support::TempDir;
#[cfg(unix)]
use std::time::Duration;

/// The same limit for a loop and for silence. The stall tests run `/bin/sh`
/// scripts, so they are Unix only.
#[cfg(unix)]
fn limits(millis: u64) -> StallLimits {
    let limit = Duration::from_millis(millis);
    StallLimits { repeating: limit, silent: limit }
}

#[test]
#[cfg(unix)]
fn a_process_that_only_repeats_errors_is_stopped() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "while :; do echo './m.tex:1: Error'; sleep 0.05; done"]);
    let active = ActiveBuild::default();
    let steps = BuildSteps::silent();
    let (_, cancelled) = run_watched(command, &active, &steps, "", "", limits(400)).unwrap();
    assert!(cancelled);
    assert!(was_stalled(&active));
}

#[test]
#[cfg(unix)]
fn a_run_shipping_pages_on_one_line_is_not_stopped() {
    let mut command = Command::new("/bin/sh");
    command.args([
        "-c",
        "printf '(./main.aux)'; for page in 1 2 3 4 5 6 7 8 9 10; do sleep 0.15; printf ' [%s]' $page; done",
    ]);
    let active = ActiveBuild::default();
    let steps = BuildSteps::silent();
    let (output, cancelled) = run_watched(command, &active, &steps, "", "", limits(600)).unwrap();
    assert!(!cancelled);
    assert!(!was_stalled(&active));
    assert!(String::from_utf8_lossy(&output.stdout).ends_with("[10]"));
}

#[test]
#[cfg(unix)]
fn a_silent_process_is_stopped() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "sleep 30"]);
    let active = ActiveBuild::default();
    let steps = BuildSteps::silent();
    let (_, cancelled) = run_watched(command, &active, &steps, "", "", limits(300)).unwrap();
    assert!(cancelled);
}

#[test]
fn a_stall_nobody_reported_does_not_colour_the_next_build() {
    let active = ActiveBuild::default();
    active::stop_stalled(&active);
    drop(BuildSession::open(&active));
    assert!(!was_stalled(&active));
}

#[test]
#[cfg(unix)]
fn a_quiet_stretch_is_given_longer_than_a_loop() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "echo start; sleep 0.6; echo done"]);
    let active = ActiveBuild::default();
    let steps = BuildSteps::silent();
    let limits =
        StallLimits { repeating: Duration::from_millis(200), silent: Duration::from_secs(5) };
    let (_, cancelled) = run_watched(command, &active, &steps, "", "", limits).unwrap();
    assert!(!cancelled);
}

/// The review's reproduction: latexmk with `max_print_line=10000` keeps
/// `(./main.aux) [1] [2] …` on one line until the end of the pass, so a
/// watchdog waiting for a newline stopped a clean document that kept shipping
/// pages. Each page must count as progress as it arrives. Counted rather than
/// timed: a loaded machine slows every page, which would make a timing flaky.
#[test]
#[ignore = "requires latexmk and pdfLaTeX"]
fn real_tex_pages_on_one_line_each_count_as_progress() {
    let root = TempDir::new("latex-stall");
    let page = "\\count255=0 \\loop\\advance\\count255 by 1 \\ifnum\\count255<300000 \\repeat Page.\\newpage\n";
    root.write(
        "main.tex",
        format!(
            "\\documentclass{{article}}\n\\begin{{document}}\n{}\\end{{document}}\n",
            page.repeat(20)
        ),
    );
    let mut command = super::super::latexmk(&root);
    command.args(["-pdf", "-interaction=nonstopmode", "-file-line-error", "-g", "main.tex"]);
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let progress = Progress::new();
    let (mut tail, mut pages) = (Vec::new(), 0);
    loop {
        let chunk = reader.fill_buf().unwrap().to_vec();
        if chunk.is_empty() {
            break;
        }
        reader.consume(chunk.len());
        let before = Instant::now();
        progress.note(&mut tail, &chunk);
        let in_a_line = !tail.is_empty() && !chunk.contains(&b'\n');
        if in_a_line && chunk.starts_with(b" [") && progress.moved_since(before) {
            pages += 1;
        }
    }
    assert!(child.wait().unwrap().success());
    // Two passes of 20 pages; chunks may merge pages, so not every one is counted alone.
    assert!(pages >= 10, "{pages} pages counted as progress mid-line");
}
