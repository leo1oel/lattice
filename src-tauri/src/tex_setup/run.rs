//! Running an installer or package manager as a supervised child: its output
//! line by line as it arrives, its whole process tree ended when the user
//! cancels, and the last lines kept for the error a failure reports.

use std::collections::VecDeque;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// How many trailing output lines a finished run keeps.
const TAIL_LINES: usize = 60;
/// Longer lines are cut: installers print progress bars as one endless line.
const MAX_LINE_BYTES: usize = 2000;
/// End the run's whole process tree: on Windows the job object
/// `track_group` put the installer in (so a batch file's Perl goes too),
/// elsewhere the child itself.
fn stop_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    crate::platform_windows::terminate_tree(child.id());
    #[cfg(not(windows))]
    let _ = child.kill();
    let _ = child.wait();
}

/// How a supervised run ended.
#[derive(Debug)]
pub(super) enum Ended {
    /// The program ran to its end; `success` is its exit status.
    Finished {
        success: bool,
        // Only the tests read it: the runners go by `success`.
        #[cfg_attr(not(test), allow(dead_code))]
        code: Option<i32>,
        tail: Vec<String>,
    },
    /// `cancel` was set and the whole process tree was ended.
    Cancelled,
}

/// Run `command` with stdin closed and stdout and stderr read together.
/// `on_line` sees every non-empty line (progress bars that redraw with `\r`
/// count as one line per redraw) on the calling thread.
pub(super) fn run(
    mut command: Command, cancel: &AtomicBool, mut on_line: impl FnMut(&str),
) -> Result<Ended, String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    crate::platform_windows::configure(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", program_name(&command)))?;
    // Held until the run ends, so a cancel can reach the installer's children.
    #[cfg(windows)]
    let _group = crate::platform_windows::track_group(child.id()).ok();
    let (sender, lines) = mpsc::channel::<String>();
    let readers: Vec<_> = [
        child.stdout.take().map(|pipe| spawn_reader(pipe, sender.clone())),
        child.stderr.take().map(|pipe| spawn_reader(pipe, sender.clone())),
    ]
    .into_iter()
    .flatten()
    .collect();
    drop(sender);

    let mut tail: VecDeque<String> = VecDeque::new();
    let mut keep = |line: String, on_line: &mut dyn FnMut(&str)| {
        on_line(&line);
        if tail.len() == TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    };
    let mut pipes_open = true;
    let status = loop {
        if cancel.load(Ordering::Acquire) {
            stop_tree(&mut child);
            // The reader threads end when the pipes close with the tree.
            for reader in readers {
                let _ = reader.join();
            }
            return Ok(Ended::Cancelled);
        }
        if pipes_open {
            match lines.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    keep(line, &mut on_line);
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                // Both pipes are closed: the program, and whatever it started
                // holding them, has finished writing.
                Err(mpsc::RecvTimeoutError::Disconnected) => pipes_open = false,
            }
        } else {
            std::thread::sleep(Duration::from_millis(25));
        }
        if !pipes_open {
            let exit = child.try_wait().map_err(|error| {
                format!("Could not wait for {}: {error}", program_name(&command))
            })?;
            if let Some(status) = exit {
                break status;
            }
        }
    };
    for reader in readers {
        let _ = reader.join();
    }
    // A cancel that arrived while the last lines were being read still counts.
    if cancel.load(Ordering::Acquire) {
        return Ok(Ended::Cancelled);
    }
    Ok(Ended::Finished {
        success: status.success(),
        code: status.code(),
        tail: tail.into_iter().collect(),
    })
}

fn program_name(command: &Command) -> String {
    command.get_program().to_string_lossy().into_owned()
}

/// Read `pipe` to its end, sending each non-empty line (split at `\n` or
/// `\r`, lossily decoded, cut at [`MAX_LINE_BYTES`]).
fn spawn_reader(
    mut pipe: impl Read + Send + 'static, sender: mpsc::Sender<String>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut line: Vec<u8> = Vec::new();
        let mut buffer = [0_u8; 4096];
        let flush = |line: &mut Vec<u8>| {
            if !line.is_empty() {
                let text = String::from_utf8_lossy(line).trim().to_string();
                if !text.is_empty() {
                    let _ = sender.send(text);
                }
                line.clear();
            }
        };
        while let Ok(read) = pipe.read(&mut buffer) {
            if read == 0 {
                break;
            }
            for &byte in &buffer[..read] {
                if byte == b'\n' || byte == b'\r' {
                    flush(&mut line);
                } else if line.len() < MAX_LINE_BYTES {
                    line.push(byte);
                }
            }
        }
        flush(&mut line);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODE: &str = "LATTICE_TEX_RUN_MODE";

    /// This test binary as the fake tool in `mode`.
    fn fake(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "tex_setup::run::tests::fake_tool_entry", "--nocapture"])
            .env(MODE, mode);
        command
    }

    /// Runs only when started by [`fake`]; a plain `cargo test` passes it.
    #[test]
    fn fake_tool_entry() {
        let Ok(mode) = std::env::var(MODE) else { return };
        match mode.as_str() {
            "installs" => {
                println!("Installing [001/003, time/total: ??:??/??:??]: one [8k]");
                eprintln!("Installing [002/003, time/total: ??:??/??:??]: two [8k]");
                // A redrawn progress bar: carriage returns, one line each.
                print!("[3/3, 00:01/00:01] install: three\r[3/3, 00:02/00:02] install: done\r\n");
            }
            "fails" => {
                eprintln!("tlmgr: package newtx not present in repository.");
                println!("some output");
                std::process::exit(7);
            }
            "long-line" => println!("{}", "x".repeat(50_000)),
            "flood" => {
                for n in 0..500 {
                    println!("line {n}");
                }
            }
            other => panic!("unknown fake mode {other}"),
        }
    }

    fn not_cancelled() -> AtomicBool {
        AtomicBool::new(false)
    }

    #[test]
    fn output_of_both_pipes_arrives_line_by_line() {
        let mut seen = Vec::new();
        let ended =
            run(fake("installs"), &not_cancelled(), |line| seen.push(line.to_string())).unwrap();
        let Ended::Finished { success, tail, .. } = ended else { panic!("{ended:?}") };
        assert!(success);
        for expected in [
            "Installing [001/003, time/total: ??:??/??:??]: one [8k]",
            "Installing [002/003, time/total: ??:??/??:??]: two [8k]",
            "[3/3, 00:01/00:01] install: three",
            "[3/3, 00:02/00:02] install: done",
        ] {
            assert!(seen.iter().any(|line| line == expected), "{expected} in {seen:?}");
        }
        assert_eq!(seen.len(), tail.len());
        assert!(seen.iter().all(|line| !line.is_empty()));
    }

    #[test]
    fn a_failing_program_reports_its_exit_code_and_last_lines() {
        let ended = run(fake("fails"), &not_cancelled(), |_| {}).unwrap();
        let Ended::Finished { success, code, tail } = ended else { panic!("{ended:?}") };
        assert!(!success);
        assert_eq!(code, Some(7));
        assert!(tail.iter().any(|line| line.contains("not present in repository")), "{tail:?}");
    }

    #[test]
    fn only_the_last_lines_are_kept_and_long_lines_are_cut() {
        let Ended::Finished { tail, .. } = run(fake("flood"), &not_cancelled(), |_| {}).unwrap()
        else {
            panic!("not finished")
        };
        assert_eq!(tail.len(), TAIL_LINES);
        assert!(tail.contains(&"line 499".to_string()), "{tail:?}");
        let Ended::Finished { tail, .. } =
            run(fake("long-line"), &not_cancelled(), |_| {}).unwrap()
        else {
            panic!("not finished")
        };
        assert!(tail.iter().all(|line| line.len() <= MAX_LINE_BYTES), "{}", tail[0].len());
    }

    #[test]
    fn a_missing_program_is_a_start_error_naming_it() {
        let error =
            run(Command::new("lattice-no-such-installer"), &not_cancelled(), |_| {}).unwrap_err();
        assert!(error.starts_with("Could not start lattice-no-such-installer"), "{error}");
    }
}
