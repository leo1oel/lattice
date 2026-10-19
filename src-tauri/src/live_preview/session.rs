//! One `rtex serve` child per project, and the window it reports to.

use super::home;
use super::install::installed_executable;
use crate::commands::{in_new_process_group, with_child_path};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// The commands a window may send. `export_pdf` writes wherever it is told and
/// `quit` belongs to [`Session::stop`], so neither passes.
const ALLOWED_COMMANDS: [&str; 5] = ["edit", "set_document", "request_layout", "status", "spans"];

/// `line` as rtex should receive it, when it is one JSON object naming an
/// allowed command.
pub(crate) fn allowed_command(line: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|error| format!("Not a live preview command: {error}"))?;
    let command = value.get("cmd").and_then(serde_json::Value::as_str).unwrap_or_default();
    if !value.is_object() || !ALLOWED_COMMANDS.contains(&command) {
        return Err(format!("Live preview does not accept the command {command:?}."));
    }
    // Re-serialized, so the line holds no raw newline that would split it.
    Ok(value.to_string())
}

/// rtex's build folder for `main` in `root`: outside the project, so neither
/// latexmk's artifacts, the file watcher nor an Overleaf sync ever sees it.
/// Another main document, or another project at the same path, gets a folder
/// of its own rather than the passes of the last one.
pub(super) fn build_dir(root: &Path, main: &Path) -> Option<PathBuf> {
    let key = crate::util::sha256_hex(root.join(main).to_string_lossy().as_bytes());
    home().map(|home| home.join("builds").join(&key[..16]))
}

/// A running `rtex serve` for one project.
pub(crate) struct Session {
    id: u64,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    build_dir: PathBuf,
}

impl Session {
    /// Start rtex on `main_file` (relative to `root`). Every line it prints is
    /// sent to `events` as it arrives, and a final
    /// `{"event":"SessionExited",…}` when it stops on its own.
    pub(crate) fn start(
        root: &Path, main_file: &str, events: Channel<InvokeResponseBody>,
    ) -> Result<Self, String> {
        let executable = installed_executable()
            .ok_or("The live preview engine is not installed. Turn live preview on again.")?;
        let main = safe_relative(main_file)
            .filter(|main| root.join(main).is_file())
            .ok_or_else(|| format!("The main file {main_file:?} is not in the project."))?;
        let build_dir = build_dir(root, &main).ok_or("Could not locate the live preview folder.")?;
        std::fs::create_dir_all(&build_dir)
            .map_err(|error| format!("Could not create the live preview folder: {error}"))?;
        let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
        // The TeX locations a GUI launch would not inherit, so rtex finds
        // the user's own lualatex and kpsewhich.
        let mut command = with_child_path(Command::new(&executable));
        command
            .arg("serve")
            .arg("--project")
            .arg(root)
            .arg("--main")
            .arg(main.to_string_lossy().as_ref())
            .arg("--build")
            .arg(&build_dir)
            .current_dir(&build_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = in_new_process_group(&mut command)
            .spawn()
            .map_err(|error| format!("Could not start the live preview engine: {error}"))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("Could not read the live preview engine.")?;
        let stderr = child.stderr.take().ok_or("Could not read the live preview engine.")?;
        let tail = Arc::new(Mutex::new(StderrTail::default()));
        let tail_reader = Arc::clone(&tail);
        std::thread::spawn(move || read_stderr(stderr, &tail_reader));
        std::thread::spawn(move || forward_events(stdout, &events, id, &tail));
        log::info!(target: "lattice::live-preview", "Started rtex session {id} for {}", root.display());
        Ok(Self { id, child: Some(child), stdin, build_dir })
    }

    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    pub(crate) fn build_dir(&self) -> &Path {
        &self.build_dir
    }

    /// Write one command line. Commands reach rtex in the order they are sent,
    /// which is what keeps a late edit from landing before an earlier one.
    pub(crate) fn send(&mut self, line: &str) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("The live preview engine has stopped.")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .map_err(|_| "The live preview engine has stopped.".to_string())
    }

    /// Ask rtex to close its engines, and end the whole process group if it
    /// has not within a second. Returns at once; the wait runs on its own
    /// thread.
    pub(crate) fn stop(mut self) {
        if let Some(finish) = self.shutdown() {
            std::thread::spawn(finish);
        }
    }

    /// [`Session::stop`], returning only once the processes are gone: before
    /// the app exits or rtex's files are deleted.
    pub(crate) fn stop_and_wait(mut self) {
        if let Some(finish) = self.shutdown() {
            finish();
        }
    }

    fn shutdown(&mut self) -> Option<impl FnOnce() + Send + 'static> {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"{\"cmd\":\"quit\"}\n").and_then(|()| stdin.flush());
        }
        let mut child = self.child.take()?;
        let id = self.id;
        Some(move || {
            let deadline = Instant::now() + Duration::from_secs(1);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            // rtex's LuaLaTeX engines share its group: end them even when
            // rtex itself has already gone.
            crate::sidecar::terminate_process_group(&mut child);
            log::info!(target: "lattice::live-preview", "Stopped rtex session {id}");
        })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(finish) = self.shutdown() {
            std::thread::spawn(finish);
        }
    }
}

/// `path` when it is relative and stays inside the folder it is joined to.
fn safe_relative(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    (!path.as_os_str().is_empty()
        && path.components().all(|part| matches!(part, Component::Normal(_))))
    .then(|| path.to_path_buf())
}

/// The last lines rtex wrote to stderr, for the error the window shows when
/// it exits.
#[derive(Default)]
struct StderrTail(VecDeque<String>);

impl StderrTail {
    const LINES: usize = 20;

    fn push(&mut self, line: String) {
        if self.0.len() == Self::LINES {
            self.0.pop_front();
        }
        self.0.push_back(line);
    }

    fn text(&self) -> String {
        self.0.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

fn read_stderr(stderr: impl Read, tail: &Mutex<StderrTail>) {
    for line in BufReader::new(stderr).lines() {
        let Ok(line) = line else { break };
        log::debug!(target: "lattice::live-preview", "rtex: {line}");
        if let Ok(mut tail) = tail.lock() {
            tail.push(line);
        }
    }
}

/// Pass each stdout line to the window as JSON it parses itself. A window that
/// has gone (reloaded or closed) ends the forwarding; the session is stopped
/// by whoever owns it.
fn forward_events(
    stdout: impl Read, events: &Channel<InvokeResponseBody>, id: u64, tail: &Mutex<StderrTail>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let trimmed = line.trim_end();
        // rtex prints one JSON object per line; anything else is not for the
        // window, and a malformed line must not break its parser.
        if !trimmed.starts_with('{')
            || serde_json::from_str::<serde::de::IgnoredAny>(trimmed).is_err()
        {
            log::debug!(target: "lattice::live-preview", "rtex printed: {trimmed}");
            continue;
        }
        if events.send(InvokeResponseBody::Json(trimmed.to_string())).is_err() {
            return;
        }
    }
    // Give stderr a moment to deliver the reason rtex stopped.
    std::thread::sleep(Duration::from_millis(100));
    let stderr = tail.lock().map(|tail| tail.text()).unwrap_or_default();
    let exited = serde_json::json!({ "event": "SessionExited", "session": id, "stderr": stderr });
    let _ = events.send(InvokeResponseBody::Json(exited.to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_editing_and_status_commands_reach_rtex() {
        let edit = r#"{"cmd":"edit","path":"main.tex","start":3,"end":3,"text":"a\nb"}"#;
        let sent = allowed_command(edit).unwrap();
        assert!(!sent.contains('\n'), "{sent}");
        assert!(sent.contains(r#""text":"a\nb""#), "{sent}");
        for refused in [
            r#"{"cmd":"export_pdf","out":"/tmp/x.pdf"}"#,
            r#"{"cmd":"quit"}"#,
            r#"["edit"]"#,
            "not json",
        ] {
            assert!(allowed_command(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn main_files_must_stay_inside_the_project() {
        assert_eq!(safe_relative("main.tex"), Some(PathBuf::from("main.tex")));
        assert_eq!(safe_relative("paper/ms.tex"), Some(PathBuf::from("paper/ms.tex")));
        for refused in ["", "/etc/passwd", "../x.tex", "a/../../x.tex", "./main.tex"] {
            assert_eq!(safe_relative(refused), None, "{refused}");
        }
    }

    #[test]
    fn each_project_gets_its_own_build_folder_outside_it() {
        let main = Path::new("main.tex");
        let (Some(a), Some(b), Some(other_main)) = (
            build_dir(Path::new("/projects/a"), main),
            build_dir(Path::new("/projects/b"), main),
            build_dir(Path::new("/projects/a"), Path::new("thesis.tex")),
        ) else {
            return;
        };
        assert_ne!(a, b);
        assert_ne!(a, other_main);
        assert!(!a.starts_with("/projects/a"));
        assert_eq!(build_dir(Path::new("/projects/a"), main), Some(a));
    }

    #[test]
    fn the_stderr_tail_keeps_the_last_lines() {
        let mut tail = StderrTail::default();
        for n in 0..30 {
            tail.push(format!("line {n}"));
        }
        let text = tail.text();
        assert!(text.starts_with("line 10\n"), "{text}");
        assert!(text.ends_with("line 29"), "{text}");
    }
}
