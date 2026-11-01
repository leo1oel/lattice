//! What the writer's login shell exports, read the way a terminal would see
//! it: `<shell> -ilc`, so both the login profile and the interactive rc
//! (`~/.zshrc`, where most proxy and API settings live) run.
//!
//! Only names `keep` accepts leave this module; the rest of the environment,
//! and every value, stay out of logs.

use crate::commands::{in_new_process_group, signal_process_group};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// A heavy rc (oh-my-zsh, conda, nvm) takes a second or two; one that waits
/// on a prompt or starts a multiplexer would never return.
pub(super) const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long output may keep arriving after the shell exits: a background
/// job the rc started can hold the pipe open forever.
const DRAIN_GRACE: Duration = Duration::from_millis(300);
/// How long after launch the first read starts, so the rc files' own work
/// stays out of Lattice's startup.
const PREFETCH_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ShellError {
    /// No answer within [`SHELL_TIMEOUT`].
    Timeout,
    /// It could not start, or printed no environment.
    Failed,
}

impl ShellError {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Failed => "failed",
        }
    }
}

pub(super) type ShellRead = Result<BTreeMap<String, String>, ShellError>;

/// Run `shell` as an interactive login shell and return the variables `keep`
/// accepts.
pub(super) fn read(shell: &Path, timeout: Duration, keep: fn(&str) -> bool) -> ShellRead {
    // A marker the rc's own output (banners, `neofetch`) cannot contain, then
    // the environment NUL-separated, so values with newlines survive.
    let marker = format!("__LATTICE_ENV_{}__", uuid::Uuid::new_v4().simple());
    let mut command = Command::new(shell);
    command
        .arg("-ilc")
        // Absolute paths and `;` read the same in sh, zsh, bash and fish.
        .arg(format!("/usr/bin/printf %s {marker}; /usr/bin/env -0"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    in_new_process_group(&mut command);
    let mut child = command.spawn().map_err(|_| ShellError::Failed)?;
    let mut stdout = child.stdout.take().ok_or(ShellError::Failed)?;
    let output = Arc::new(Mutex::new(Vec::new()));
    let (done, drained) = mpsc::channel();
    {
        let output = Arc::clone(&output);
        thread::spawn(move || {
            let mut buffer = [0; 8192];
            while let Ok(read @ 1..) = stdout.read(&mut buffer) {
                if let Ok(mut output) = output.lock() {
                    output.extend_from_slice(&buffer[..read]);
                }
            }
            let _ = done.send(());
        });
    }
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            result => {
                // The group reaches whatever the rc started too.
                signal_process_group(child.id(), libc::SIGKILL);
                let _ = child.kill();
                let _ = child.wait();
                return Err(if result.is_err() { ShellError::Failed } else { ShellError::Timeout });
            }
        }
    }
    let _ = drained.recv_timeout(DRAIN_GRACE);
    let output = output.lock().map(|output| output.clone()).unwrap_or_default();
    parse(&output, &marker, keep).ok_or(ShellError::Failed)
}

/// The variables after `marker` in `env -0` output; `None` without it.
fn parse(output: &[u8], marker: &str, keep: fn(&str) -> bool) -> Option<BTreeMap<String, String>> {
    let start = output.windows(marker.len()).position(|window| window == marker.as_bytes())?;
    let environment = &output[start + marker.len()..];
    Some(
        environment
            .split(|byte| *byte == 0)
            .filter_map(|entry| {
                let entry = std::str::from_utf8(entry).ok()?;
                let (name, value) = entry.split_once('=')?;
                keep(name).then(|| (name.to_string(), value.to_string()))
            })
            .collect(),
    )
}

#[derive(Default)]
enum Slot {
    #[default]
    Idle,
    Reading,
    Done(ShellRead),
    /// The first start has had its read; every later one reads afresh.
    Spent,
}

/// One read begun shortly after launch, which the agent's first start takes,
/// so opening the agent does not wait on the rc files.
#[derive(Default)]
pub(super) struct Prefetch {
    slot: Mutex<Slot>,
    finished: Condvar,
}

impl Prefetch {
    pub(super) fn start(self: &Arc<Self>, read: impl FnOnce() -> ShellRead + Send + 'static) {
        let prefetch = Arc::clone(self);
        thread::spawn(move || {
            thread::sleep(PREFETCH_DELAY);
            if prefetch.claim() {
                prefetch.finish(read());
            }
        });
    }

    /// The prefetched read, waiting for it if it is under way; after the
    /// first call, or before the prefetch began, a new read.
    pub(super) fn take_or_read(&self, read: impl FnOnce() -> ShellRead) -> ShellRead {
        let Ok(mut slot) = self.slot.lock() else { return read() };
        while matches!(*slot, Slot::Reading) {
            slot = match self.finished.wait(slot) {
                Ok(slot) => slot,
                Err(_) => return read(),
            };
        }
        match std::mem::replace(&mut *slot, Slot::Spent) {
            Slot::Done(result) => result,
            _ => {
                drop(slot);
                read()
            }
        }
    }

    fn claim(&self) -> bool {
        let Ok(mut slot) = self.slot.lock() else { return false };
        let idle = matches!(*slot, Slot::Idle);
        if idle {
            *slot = Slot::Reading;
        }
        idle
    }

    fn finish(&self, result: ShellRead) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Slot::Done(result);
        }
        self.finished.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::os::unix::fs::PermissionsExt;

    fn keep_proxy(name: &str) -> bool {
        name.ends_with("_PROXY")
    }

    fn script(directory: &TempDir, body: &str) -> std::path::PathBuf {
        // Stands in for a login shell: ignores `-ilc`, runs its rc, then the
        // command it was given, exactly as `sh -c` would.
        let path =
            directory.write("shell", format!("#!/bin/sh\n{body}\nshift\nexec /bin/sh -c \"$1\"\n"));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn reads_only_kept_variables_past_the_rc_output() {
        let directory = TempDir::new("shell-env");
        let shell = script(
            &directory,
            "echo 'banner HTTPS_PROXY=http://wrong:1'\nexport HTTPS_PROXY='http://127.0.0.1:7890'\nexport SECRET_TOKEN=hidden\nexport MULTI_PROXY=\"a\nb\"",
        );
        let variables = read(&shell, SHELL_TIMEOUT, keep_proxy).unwrap();
        assert_eq!(variables.get("HTTPS_PROXY").map(String::as_str), Some("http://127.0.0.1:7890"));
        assert_eq!(variables.get("MULTI_PROXY").map(String::as_str), Some("a\nb"));
        assert!(!variables.contains_key("SECRET_TOKEN"));
    }

    #[test]
    fn a_shell_that_never_answers_times_out() {
        let directory = TempDir::new("shell-env-hang");
        let shell = script(&directory, "sleep 30");
        let started = Instant::now();
        assert_eq!(read(&shell, Duration::from_millis(300), keep_proxy), Err(ShellError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(5));
        let broken = directory.write("broken", "#!/bin/sh\nexit 1\n");
        std::fs::set_permissions(&broken, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(read(&broken, SHELL_TIMEOUT, keep_proxy), Err(ShellError::Failed));
    }

    #[test]
    fn the_first_start_takes_the_prefetched_read_and_later_ones_read_again() {
        let prefetch = Prefetch::default();
        assert!(prefetch.claim());
        prefetch.finish(Ok(BTreeMap::from([("A".to_string(), "prefetched".to_string())])));
        let first = prefetch.take_or_read(|| Ok(BTreeMap::new())).unwrap();
        assert_eq!(first.get("A").map(String::as_str), Some("prefetched"));
        let second = prefetch
            .take_or_read(|| Ok(BTreeMap::from([("A".to_string(), "fresh".to_string())])))
            .unwrap();
        assert_eq!(second.get("A").map(String::as_str), Some("fresh"));
        // A prefetch that wakes after the first start leaves it alone.
        assert!(!prefetch.claim());
        let late = Prefetch::default();
        assert_eq!(late.take_or_read(|| Err(ShellError::Timeout)), Err(ShellError::Timeout));
        assert!(!late.claim());
    }
}
