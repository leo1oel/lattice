//! One running terminal: its output streamed to the window, its input
//! written to the shell, and its end.

use super::pty::{self, Shell};
use std::io::Write;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

/// Output is gathered for up to this long after the first byte, so a burst
/// (a build's log) reaches the window as a few messages instead of one per
/// line, while a keystroke's echo still lands within a frame.
const BATCH_WINDOW: Duration = Duration::from_millis(4);
/// The most output one message carries.
const BATCH_LIMIT: usize = 256 * 1024;
/// Flow control: output the window has not yet drawn. Past the high mark the
/// shell is no longer read, so a runaway `yes` waits in the kernel's buffer
/// (and then blocks) instead of piling up in the webview.
const HIGH_WATER: usize = 2 * 1024 * 1024;
const LOW_WATER: usize = 512 * 1024;
/// How often a waiting reader looks for a stop.
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// How long output may still arrive after the shell exited (a job it left
/// behind holding the terminal) before the terminal is hung up anyway.
const DRAIN_AFTER_EXIT: Duration = Duration::from_millis(300);

/// The shell's exit, once it is known: Some(code), with None for a signal.
#[derive(Default)]
struct Exit {
    status: Mutex<Option<Option<i32>>>,
    known: Condvar,
}

impl Exit {
    fn set(&self, code: Option<i32>) {
        *self.status.lock().unwrap_or_else(PoisonError::into_inner) = Some(code);
        self.known.notify_all();
    }

    /// The exit, waiting up to `timeout` for it; None while the shell runs.
    fn wait(&self, timeout: Duration) -> Option<Option<i32>> {
        let status = self.status.lock().unwrap_or_else(PoisonError::into_inner);
        let (status, _) = self
            .known
            .wait_timeout_while(status, timeout, |status| status.is_none())
            .unwrap_or_else(PoisonError::into_inner);
        *status
    }
}

pub(crate) struct Session {
    window: String,
    root: PathBuf,
    shell: u32,
    name: String,
    master: Arc<OwnedFd>,
    input: mpsc::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    unread: Arc<AtomicUsize>,
    exit: Arc<Exit>,
}

/// A session being ended: hung up, and killed if it outlasts its grace.
pub(crate) struct Hangup {
    shell: u32,
    foreground: Option<i32>,
    exit: Arc<Exit>,
}

impl Session {
    /// Start the login shell in `root` for window `window`. Its output goes to
    /// `output` as raw bytes, in order; when it ends, one JSON message
    /// `{"exit": code}` follows (`code` null when a signal ended it).
    pub(crate) fn spawn(
        window: String, root: PathBuf, cols: u16, rows: u16, output: Channel<InvokeResponseBody>,
    ) -> Result<Self, String> {
        Self::spawn_shell(&pty::login_shell(), window, root, cols, rows, output)
    }

    pub(super) fn spawn_shell(
        shell: &Path, window: String, root: PathBuf, cols: u16, rows: u16,
        output: Channel<InvokeResponseBody>,
    ) -> Result<Self, String> {
        let Shell { master, mut child, name } = pty::spawn_shell(shell, &root, cols, rows)
            .map_err(|error| format!("Could not start a shell: {error}"))?;
        let shell = child.id();
        let master = Arc::new(master);
        let writer = master
            .try_clone()
            .map(std::fs::File::from)
            .map_err(|error| format!("Could not open the terminal: {error}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let unread = Arc::new(AtomicUsize::new(0));
        let exit = Arc::new(Exit::default());
        let (input, keys) = mpsc::channel::<Vec<u8>>();
        // Writes go through a thread of their own, so a large paste into a
        // shell that is not reading never holds up a command handler.
        std::thread::spawn(move || write_input(writer, &keys));
        {
            let (exit, stop) = (Arc::clone(&exit), Arc::clone(&stop));
            std::thread::spawn(move || {
                let status = child.wait().ok();
                exit.set(status.and_then(|status| status.code()));
                std::thread::sleep(DRAIN_AFTER_EXIT);
                stop.store(true, Ordering::Release);
            });
        }
        {
            let (master, stop, unread, exit) =
                (Arc::clone(&master), Arc::clone(&stop), Arc::clone(&unread), Arc::clone(&exit));
            std::thread::spawn(move || forward_output(&master, &output, &stop, &unread, &exit));
        }
        log::info!(target: "lattice::terminal", "Started {name} (pid {shell}) in {}", root.display());
        Ok(Self { window, root, shell, name, master, input, stop, unread, exit })
    }

    pub(crate) fn window(&self) -> &str {
        &self.window
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// The shell's name ("zsh").
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    /// Type `bytes` into the terminal, after whatever was typed before.
    pub(crate) fn write(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.input.send(bytes).map_err(|_| "This terminal has closed.".to_string())
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        pty::resize(&self.master, cols, rows)
            .map_err(|error| format!("Could not resize the terminal: {error}"))
    }

    /// The window has drawn `bytes` more of the output.
    pub(crate) fn acknowledge(&self, bytes: usize) {
        let _ = self.unread.try_update(Ordering::AcqRel, Ordering::Acquire, |unread| {
            Some(unread.saturating_sub(bytes))
        });
    }

    /// The command running in the terminal ("latexmk"), when the shell is
    /// not simply waiting at its prompt.
    pub(crate) fn running_command(&self) -> Option<String> {
        if self.exit.wait(Duration::ZERO).is_some() {
            return None;
        }
        pty::foreground_job(&self.master, self.shell)
            .map(|group| pty::process_name(group).unwrap_or_default())
    }

    #[cfg(test)]
    pub(crate) fn shell_pid(&self) -> i32 {
        i32::try_from(self.shell).unwrap()
    }

    #[cfg(test)]
    pub(crate) fn foreground_group(&self) -> Option<i32> {
        pty::foreground_job(&self.master, self.shell)
    }

    /// Hang up the terminal, as closing a terminal window does: the shell
    /// and its foreground job get SIGHUP (and SIGCONT, so a stopped job sees
    /// it), and the output stops.
    pub(crate) fn hang_up(self) -> Hangup {
        let foreground = pty::foreground_job(&self.master, self.shell);
        // A shell that already exited is not signalled: its pid may be reused.
        let shell = self
            .exit
            .wait(Duration::ZERO)
            .is_none()
            .then_some(i32::try_from(self.shell).unwrap_or(0));
        for group in shell.into_iter().chain(foreground) {
            pty::signal_group(group, libc::SIGHUP);
            pty::signal_group(group, libc::SIGCONT);
        }
        self.stop.store(true, Ordering::Release);
        log::info!(target: "lattice::terminal", "Closed {} (pid {})", self.name, self.shell);
        Hangup { shell: self.shell, foreground, exit: Arc::clone(&self.exit) }
    }

    /// [`Self::hang_up`], then the grace period on a thread of its own.
    pub(crate) fn end(self, grace: Duration) {
        let hangup = self.hang_up();
        std::thread::spawn(move || hangup.finish(grace));
    }
}

impl Hangup {
    /// Wait up to `grace` for the shell to exit, then SIGKILL whatever of the
    /// shell and its foreground job is left.
    pub(crate) fn finish(self, grace: Duration) {
        let shell = i32::try_from(self.shell).unwrap_or(0);
        let exited = self.exit.wait(grace).is_some();
        if !exited {
            log::warn!(target: "lattice::terminal", "Shell {shell} ignored the hangup; killing it");
            pty::signal_group(shell, libc::SIGKILL);
        }
        if let Some(group) = self.foreground.filter(|group| pty::group_alive(*group)) {
            pty::signal_group(group, libc::SIGKILL);
        }
    }
}

fn write_input(mut writer: std::fs::File, keys: &mpsc::Receiver<Vec<u8>>) {
    while let Ok(bytes) = keys.recv() {
        if writer.write_all(&bytes).is_err() {
            return;
        }
    }
}

/// Wait until the terminal has output (true) or `timeout` passes (false).
fn readable(master: &OwnedFd, timeout: Duration) -> bool {
    let mut poll = libc::pollfd { fd: master.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    let millis = libc::c_int::try_from(timeout.as_millis()).unwrap_or(libc::c_int::MAX);
    // SAFETY: one pollfd, owned here.
    let ready = unsafe { libc::poll(&mut poll, 1, millis) };
    // A hangup or error counts: the read that follows reports it.
    ready > 0 && poll.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0
}

/// Read up to `buffer`'s room; 0 at the end (the terminal hung up).
fn read_some(master: &OwnedFd, buffer: &mut [u8]) -> usize {
    loop {
        // SAFETY: read writes at most buffer.len() bytes into it.
        let read =
            unsafe { libc::read(master.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
        if read >= 0 {
            return read as usize;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return 0;
        }
    }
}

/// Stream the terminal's output to the window until it ends, is stopped, or
/// the window is gone, then report how the shell exited.
fn forward_output(
    master: &OwnedFd, output: &Channel<InvokeResponseBody>, stop: &AtomicBool,
    unread: &AtomicUsize, exit: &Exit,
) {
    let mut chunk = vec![0u8; 64 * 1024];
    'stream: while !stop.load(Ordering::Acquire) {
        if unread.load(Ordering::Acquire) > HIGH_WATER {
            while unread.load(Ordering::Acquire) > LOW_WATER {
                if stop.load(Ordering::Acquire) {
                    break 'stream;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        if !readable(master, POLL_INTERVAL) {
            continue;
        }
        let read = read_some(master, &mut chunk);
        if read == 0 {
            break;
        }
        let mut batch = chunk[..read].to_vec();
        let deadline = Instant::now() + BATCH_WINDOW;
        let mut ended = false;
        while batch.len() < BATCH_LIMIT {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || !readable(master, left) {
                break;
            }
            let room = (BATCH_LIMIT - batch.len()).min(chunk.len());
            let more = read_some(master, &mut chunk[..room]);
            if more == 0 {
                ended = true;
                break;
            }
            batch.extend_from_slice(&chunk[..more]);
        }
        unread.fetch_add(batch.len(), Ordering::AcqRel);
        // A window that reloaded or closed has no one to draw this.
        if output.send(InvokeResponseBody::Raw(batch)).is_err() || ended {
            break;
        }
    }
    let code = exit.wait(Duration::from_secs(1)).flatten();
    let message = serde_json::json!({ "exit": code });
    let _ = output.send(InvokeResponseBody::Json(message.to_string()));
}
