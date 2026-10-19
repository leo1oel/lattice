use super::{Session, Terminals};
use crate::test_support::TempDir;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

/// What a terminal sent its window: the output, and the JSON messages.
#[derive(Default)]
struct Received {
    output: Vec<u8>,
    messages: Vec<String>,
}

impl Received {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output).into_owned()
    }
}

fn channel() -> (Channel<InvokeResponseBody>, Arc<Mutex<Received>>) {
    let received = Arc::new(Mutex::new(Received::default()));
    let sink = Arc::clone(&received);
    let channel = Channel::new(move |body| {
        let mut received = sink.lock().unwrap();
        match body {
            InvokeResponseBody::Raw(bytes) => received.output.extend_from_slice(&bytes),
            InvokeResponseBody::Json(json) => received.messages.push(json),
        }
        Ok(())
    });
    (channel, received)
}

/// A plain `sh` stands in for the writer's login shell, so the test does not
/// depend on anyone's zsh profile.
fn spawn(window: &str, root: &Path) -> (Session, Arc<Mutex<Received>>) {
    let (output, received) = channel();
    let session = Session::spawn_shell(
        Path::new("/bin/sh"),
        window.into(),
        root.to_path_buf(),
        80,
        24,
        output,
    )
    .expect("shell starts");
    (session, received)
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn project() -> (TempDir, PathBuf) {
    let dir = TempDir::new("terminal");
    let root = dir.canonicalize().unwrap();
    (dir, root)
}

#[test]
fn a_terminal_starts_in_the_project_folder_and_streams_what_the_shell_prints() {
    let (_dir, root) = project();
    let (session, received) = spawn("main", &root);
    session.write(b"pwd; echo done-$((40+2))\n".to_vec()).unwrap();
    wait_for("the command's output", || received.lock().unwrap().text().contains("done-42"));
    let text = received.lock().unwrap().text();
    assert!(text.contains(root.to_str().unwrap()), "{text}");
    session.end(Duration::from_secs(2));
}

#[test]
fn a_resize_reaches_the_shell() {
    let (_dir, root) = project();
    let (session, received) = spawn("main", &root);
    session.resize(101, 33).unwrap();
    session.write(b"stty size\n".to_vec()).unwrap();
    wait_for("the new size", || received.lock().unwrap().text().contains("33 101"));
    session.end(Duration::from_secs(2));
}

#[test]
fn the_shell_exiting_on_its_own_is_reported_with_its_code() {
    let (_dir, root) = project();
    let (session, received) = spawn("main", &root);
    session.write(b"exit 3\n".to_vec()).unwrap();
    wait_for("the exit", || !received.lock().unwrap().messages.is_empty());
    assert_eq!(received.lock().unwrap().messages, [r#"{"exit":3}"#]);
    assert_eq!(session.running_command(), None);
}

#[test]
fn closing_a_terminal_ends_its_shell_and_the_command_it_runs() {
    let (_dir, root) = project();
    let terminals = Terminals::default();
    let (session, _received) = spawn("main", &root);
    let shell = session.shell_pid();
    let id = terminals.insert(session);
    terminals.with("main", id, |session| session.write(b"sleep 300\n".to_vec())).unwrap().unwrap();
    let mut job = None;
    wait_for("sleep to run", || {
        job = terminals.with("main", id, Session::running_command).unwrap();
        job.is_some()
    });
    assert_eq!(job.as_deref(), Some("sleep"));
    let sleep = terminals.with("main", id, Session::foreground_group).unwrap().unwrap();
    terminals.close("main", id);
    assert_eq!(terminals.len(), 0);
    wait_for("the shell and sleep to end", || !alive(shell) && !alive(sleep));
}

#[test]
fn a_shell_that_ignores_the_hangup_is_killed_after_its_grace() {
    let (_dir, root) = project();
    let (session, received) = spawn("main", &root);
    let shell = session.shell_pid();
    session.write(b"trap '' HUP; echo ignoring-$((1))\n".to_vec()).unwrap();
    wait_for("the trap", || received.lock().unwrap().text().contains("ignoring-1"));
    let started = Instant::now();
    session.hang_up().finish(Duration::from_millis(300));
    assert!(started.elapsed() >= Duration::from_millis(300));
    wait_for("the shell to be killed", || !alive(shell));
}

#[test]
fn a_window_reaches_only_the_terminals_it_opened() {
    let (_dir, root) = project();
    let terminals = Terminals::default();
    let (session, _received) = spawn("main", &root);
    let shell = session.shell_pid();
    let id = terminals.insert(session);
    assert!(terminals.with("other", id, |_| ()).is_err());
    terminals.close("other", id);
    assert_eq!(terminals.len(), 1);
    terminals.close_window("other");
    assert_eq!(terminals.len(), 1);
    terminals.close_window("main");
    assert_eq!(terminals.len(), 0);
    wait_for("the shell to end", || !alive(shell));
}

#[test]
fn a_project_switch_ends_the_terminals_of_the_project_left() {
    let (_dir, root) = project();
    let (_other_dir, other) = project();
    let terminals = Terminals::default();
    let (kept, _) = spawn("left", &other);
    let (ended, _) = spawn("main", &root);
    let ended_shell = ended.shell_pid();
    terminals.insert(kept);
    terminals.insert(ended);
    // Window "main" now shows `other`; "left" still shows what it opened in.
    terminals
        .retain(|window, folder| folder == other.as_path() && ["main", "left"].contains(&window));
    assert_eq!(terminals.len(), 1);
    wait_for("the old project's shell to end", || !alive(ended_shell));
    terminals.close_all_and_wait();
    assert_eq!(terminals.len(), 0);
}

#[test]
fn quitting_ends_every_terminal_before_it_returns() {
    let (_dir, root) = project();
    let terminals = Terminals::default();
    let shells: Vec<i32> = (0..3)
        .map(|_| {
            let (session, _) = spawn("main", &root);
            let shell = session.shell_pid();
            terminals.insert(session);
            shell
        })
        .collect();
    terminals.close_all_and_wait();
    // Reaped by each session's own waiter a moment after the signal.
    wait_for("every shell to end", || shells.iter().all(|shell| !alive(*shell)));
}
