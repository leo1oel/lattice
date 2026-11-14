//! The Linux guard: the sidecar inside bubblewrap, with the bibliography name
//! filter as the file system it sees.
//!
//! Lattice starts its own executable in [`FLAG`] mode, as it starts
//! `sandbox-exec` on macOS. That process stays outside the sandbox: it mounts
//! the name filter (`name_filter`) over `/`, starts the system `bwrap` with
//! that mount as the sandbox's root and the mounts of `layout` over it, and
//! waits for it. The sandbox ends with that process, and that process with
//! Lattice.

use super::layout::{home_folder, Layout};
use super::name_filter;
use crate::commands::host_environment;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

/// The mode of Lattice's executable that runs the guard around a command:
/// `lattice --lattice-agent-guard <agent home> -- <command>...`.
pub(crate) const FLAG: &str = "--lattice-agent-guard";

pub(in crate::synara) const NO_BUBBLEWRAP: &str = "The built-in agent is off because \
     bubblewrap (bwrap) is not installed. Lattice runs the agent inside it to keep it from \
     editing bibliography (.bib) files directly.";
pub(in crate::synara) const NO_FUSE: &str = "The built-in agent is off because FUSE \
     (fusermount3 and /dev/fuse) is not available. Lattice needs it to keep the agent from \
     editing bibliography (.bib) files directly.";
pub(in crate::synara) const NO_SANDBOX: &str = "The built-in agent is off because this \
     system does not let bubblewrap start a sandbox (unprivileged user namespaces are \
     restricted). Lattice runs the agent inside one to keep it from editing bibliography \
     (.bib) files directly.";
/// Not "the files here are safe": the folders the guard leaves out are
/// open to the agent whichever project it works on.
pub(in crate::synara) const UNGUARDED_FOLDER: &str = "The built-in agent is off for this \
     project: Lattice cannot keep the agent from editing bibliography (.bib) files everywhere \
     in its folder. The agent can write to /tmp and to the hidden folders in your home folder \
     directly, so a bibliography in one of those is not protected while the agent works on any \
     project. Move this project to an ordinary folder to use the agent with it.";

/// Why the agent cannot work on the project at `workspace`: its
/// bibliographies would not be behind the filter.
pub(in crate::synara) fn unguarded(workspace: &Path, agent_home: &Path) -> Option<&'static str> {
    let agent_home = fs::canonicalize(agent_home).unwrap_or_else(|_| agent_home.to_path_buf());
    let layout = Layout::new(home_folder().as_deref(), &agent_home);
    (!layout.guards(workspace)).then_some(UNGUARDED_FOLDER)
}

/// The folder the guards' mount points are in.
const MOUNTS: &str = "lattice-agent-guard";

/// Where the FUSE library looks for the mount helper before the search path.
const FUSERMOUNT_PATH: &str = "FUSERMOUNT_PATH";

/// What this system lacks to run the guard, if anything.
pub(in crate::synara) fn missing() -> Option<&'static str> {
    let Some(bubblewrap) = bubblewrap() else { return Some(NO_BUBBLEWRAP) };
    if !Path::new("/dev/fuse").exists() || fusermount().is_none() {
        return Some(NO_FUSE);
    }
    (!sandbox_starts(&bubblewrap)).then_some(NO_SANDBOX)
}

/// The sidecar's launch: `node` under the guard, in a process of Lattice's
/// own executable that stays outside the sandbox.
pub(in crate::synara) fn command(
    node: &Path, home_dir: &Path, executable: &Path,
) -> Result<Command, String> {
    if let Some(reason) = missing() {
        return Err(reason.to_string());
    }
    let mut command = Command::new(executable);
    command
        .arg(FLAG)
        .arg(home_dir)
        .arg("--")
        .arg(node)
        // Providers with a sandbox of their own for bibliographies skip it.
        .env("LATTICE_BIBLIOGRAPHY_SANDBOX", "1");
    Ok(command)
}

/// The system's bubblewrap. Never one inside Lattice's AppImage: Ubuntu's
/// AppArmor policy lets only the system's own create user namespaces.
fn bubblewrap() -> Option<PathBuf> {
    find_program("bwrap")
}

fn fusermount() -> Option<PathBuf> {
    find_program("fusermount3").or_else(|| find_program("fusermount"))
}

/// A program of the system's own: the first `name` on the search path that
/// only root can replace. The agent writes to the user's own folders, some
/// of them on that path, and a `bwrap` it left there must not be what builds
/// its next sandbox.
fn find_program(name: &str) -> Option<PathBuf> {
    let system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from);
    let path = std::env::var_os("PATH").unwrap_or_default();
    let searched = crate::commands::outside_appimage(std::env::split_paths(&path).collect());
    let roots_own = |path: &Path| {
        fs::metadata(path).is_ok_and(|metadata| metadata.uid() == 0 && metadata.mode() & 0o022 == 0)
    };
    system
        .into_iter()
        .chain(searched)
        .filter(|folder| folder.is_absolute())
        .map(|folder| folder.join(name))
        .find(|candidate| {
            candidate.is_file() && roots_own(candidate) && candidate.parent().is_some_and(roots_own)
        })
}

/// Whether bubblewrap can build a sandbox at all here: user namespaces can
/// be turned off by a sysctl or by AppArmor.
fn sandbox_starts(bubblewrap: &Path) -> bool {
    let mut probe = Command::new(bubblewrap);
    probe
        .args(["--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--"])
        .arg(bubblewrap)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    host_environment(&mut probe).status().is_ok_and(|status| status.success())
}

/// Run the guard around a command and exit with its status, when Lattice
/// was started in [`FLAG`] mode. Call before anything else starts.
pub fn run_if_requested() {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() != Some(OsStr::new(FLAG)) {
        return;
    }
    let code = guard(arguments).unwrap_or_else(|error| {
        // The sidecar's error log, which a failed start quotes from.
        eprintln!("Lattice agent guard failed: {error}");
        1
    });
    std::process::exit(code);
}

fn guard(mut arguments: impl Iterator<Item = OsString>) -> Result<i32, String> {
    let agent_home = arguments.next().map(PathBuf::from).ok_or("no agent folder was given")?;
    let agent_home = fs::canonicalize(&agent_home).map_err(|error| {
        format!("the agent folder {} is missing: {error}", agent_home.display())
    })?;
    if arguments.next().as_deref() != Some(OsStr::new("--")) {
        return Err("no command was given".to_string());
    }
    let program: Vec<OsString> = arguments.collect();
    if program.is_empty() {
        return Err("no command was given".to_string());
    }
    let bubblewrap = bubblewrap().ok_or(NO_BUBBLEWRAP)?;
    // The mount helper the filter is mounted and unmounted with: this one,
    // not whichever the search path names first.
    std::env::set_var(FUSERMOUNT_PATH, fusermount().ok_or(NO_FUSE)?);
    let _only_guard = only_guard(&agent_home)?;
    clear_service_locks(&agent_home);

    // SIGTERM is for `pass_on_termination` alone. Blocked before any thread
    // exists, so every thread has it blocked.
    let termination = termination();
    // SAFETY: `termination` is a valid set; no other thread exists yet.
    unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &termination, std::ptr::null_mut()) };
    // The filter creates files with exactly the mode the sandbox asked for.
    // SAFETY: `umask` only swaps the process's file mode mask.
    let mask = unsafe { libc::umask(0) };
    let descriptors = raise_descriptor_limit();

    let mountpoint = Mountpoint::create(&agent_home)?;
    let filter = name_filter::mount(Path::new("/"), &mountpoint.0)
        .map_err(|error| format!("could not mount the bibliography filter: {error}"))?;
    let layout = Layout::new(home_folder().as_deref(), &agent_home);
    let mut command = Command::new(&bubblewrap);
    command.args(layout.arguments(&mountpoint.0)).arg("--").args(&program);
    host_environment(&mut command).env_remove(FUSERMOUNT_PATH);
    // Out of the group Lattice signals: SIGTERM reaches the sandbox only
    // through `pass_on_termination`, and bubblewrap dies with this process
    // (`--die-with-parent`) when the SIGKILL that follows it ends this one.
    command.process_group(0);
    // SAFETY: `sigprocmask`, `umask`, `setrlimit`, `syscall` and `fcntl` are
    // async-signal-safe, the only calls made between fork and exec.
    unsafe {
        command.pre_exec(move || {
            // The sandbox starts with SIGTERM as a program expects to find it.
            libc::sigprocmask(libc::SIG_UNBLOCK, &termination, std::ptr::null_mut());
            libc::umask(mask);
            if let Some(limit) = descriptors {
                libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
            }
            // The filter's connection to the kernel, and the files it holds
            // open, must not follow the sidecar into the sandbox.
            close_on_exec_from(3);
            Ok(())
        });
    }
    let mut sandbox =
        command.spawn().map_err(|error| format!("could not start bubblewrap: {error}"))?;
    pass_on_termination(termination, sandbox.id() as libc::pid_t);

    // Lattice is this process's parent only while it lives. bubblewrap dies
    // with this process, and the sandbox with bubblewrap.
    // SAFETY: `getppid` and `kill` take and return plain integers.
    let (lattice, sandbox_pid) = (unsafe { libc::getppid() }, sandbox.id() as libc::pid_t);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        // SAFETY: as above.
        if unsafe { libc::getppid() } != lattice {
            // SAFETY: as above; the sandbox has not been waited for while
            // this thread runs, so the number still names it.
            unsafe { libc::kill(sandbox_pid, libc::SIGKILL) };
            return;
        }
    });

    let status =
        sandbox.wait().map_err(|error| format!("could not wait for bubblewrap: {error}"))?;
    drop(filter);
    drop(mountpoint);
    Ok(status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0)))
}

/// SIGTERM, as a signal set.
fn termination() -> libc::sigset_t {
    // SAFETY: an all-zero sigset_t is valid storage for `sigemptyset` to
    // initialize, and both calls only write the set.
    unsafe {
        let mut set = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        set
    }
}

/// Pass each SIGTERM this process gets on to the sandbox's processes.
///
/// Lattice stops the sidecar by sending its process group SIGTERM, then
/// SIGKILL two seconds later. That group is this process alone, and the
/// sandbox has a session of its own (bubblewrap's `--new-session`). Its
/// leader is bubblewrap's process 1 in the sandbox, the child of the
/// `bubblewrap` process outside, and the signal goes to its group: the
/// service handles it while this process keeps its file system up, and
/// process 1, which has no handler, is not sent it.
fn pass_on_termination(termination: libc::sigset_t, bubblewrap: libc::pid_t) {
    thread::spawn(move || loop {
        let mut signal = 0;
        // SAFETY: `termination` is a valid set and `signal` an integer the
        // call writes into.
        if unsafe { libc::sigwait(&termination, &mut signal) } != 0 {
            return;
        }
        // Just after the start, process 1 may not exist yet.
        for _ in 0..40 {
            if let Some(leader) = child_of(bubblewrap) {
                // SAFETY: `kill` takes and returns plain integers.
                unsafe { libc::kill(-leader, libc::SIGTERM) };
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
    });
}

/// A process whose parent is `parent`, found in `/proc`.
fn child_of(parent: libc::pid_t) -> Option<libc::pid_t> {
    fs::read_dir("/proc").ok()?.flatten().find_map(|entry| {
        let pid = entry.file_name().to_str()?.parse::<libc::pid_t>().ok()?;
        let status = fs::read(entry.path().join("stat")).ok()?;
        // `pid (name) state ppid ...`, where the name may hold anything.
        let after_name = &status[status.iter().rposition(|byte| *byte == b')')? + 1..];
        let ppid = std::str::from_utf8(after_name).ok()?.split_whitespace().nth(1)?;
        (ppid.parse::<libc::pid_t>().ok()? == parent).then_some(pid)
    })
}

/// Lock the agent's folder for as long as this process lives, or fail when
/// another guard holds it: two services must not share one folder. The
/// kernel drops the lock with the process, however it ends.
fn only_guard(agent_home: &Path) -> Result<fs::File, String> {
    let folder = fs::File::open(agent_home)
        .map_err(|error| format!("could not open {}: {error}", agent_home.display()))?;
    folder.try_lock().map_err(|_| {
        "another Lattice is already running the agent service on this data folder".to_string()
    })?;
    Ok(folder)
}

/// Where the service keeps its database, under its folder, and what the
/// locks it guards that database with have in their names.
const SERVICE_LOCKS: (&str, &str) = ("userdata", ".lifecycle-lock");

/// Remove the database locks a killed service left behind. The service
/// names a lock's owner by process ID and takes over a lock whose owner is
/// gone. In the sandbox's own process table it is always process 2, so the
/// owner of a leftover lock looks alive to the next service: it is that
/// service itself. Holding [`only_guard`] is the proof no owner is running.
fn clear_service_locks(agent_home: &Path) {
    let (folder, marker) = SERVICE_LOCKS;
    for entry in fs::read_dir(agent_home.join(folder)).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().contains(marker) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// The folder the name filter is mounted on, removed when dropped. The
/// sandbox gets the folder it is in covered with an empty one
/// ([`Layout::arguments`]).
struct Mountpoint(PathBuf);

impl Mountpoint {
    /// A fresh folder only this user can enter, in `XDG_RUNTIME_DIR` or,
    /// without one, in the agent's own folder.
    fn create(agent_home: &Path) -> Result<Self, String> {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .filter(|folder| folder.is_absolute() && folder.is_dir());
        Self::create_in(&runtime.unwrap_or_else(|| agent_home.to_path_buf()).join(MOUNTS))
    }

    /// A fresh folder in `base`, which only this user can enter either.
    fn create_in(base: &Path) -> Result<Self, String> {
        let failed = |error: io::Error| format!("could not create the filter's folder: {error}");
        fs::DirBuilder::new().recursive(true).mode(0o700).create(base).map_err(failed)?;
        clear_stale(base);
        let path = base.join(std::process::id().to_string());
        fs::DirBuilder::new().mode(0o700).create(&path).map_err(failed)?;
        Ok(Self(path))
    }
}

impl Drop for Mountpoint {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

/// Unmount what guards that were killed left behind in `base`: a dead mount
/// answers every access with an error until someone unmounts it.
fn clear_stale(base: &Path) {
    for entry in fs::read_dir(base).into_iter().flatten().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<i32>().ok()) else {
            continue;
        };
        // SAFETY: signal 0 only asks whether the process exists.
        if unsafe { libc::kill(pid, 0) } == 0 {
            continue;
        }
        if let Some(fusermount) = fusermount() {
            let mut unmount = Command::new(fusermount);
            unmount.args(["-u", "-z"]).arg(entry.path()).stdout(Stdio::null());
            let _ = host_environment(&mut unmount).stderr(Stdio::null()).status();
        }
        let _ = fs::remove_dir(entry.path());
    }
}

/// Let the filter hold a descriptor for every file the sandbox has looked
/// up. Answers the limit to give back to the sandbox.
fn raise_descriptor_limit() -> Option<libc::rlimit> {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: `limit` is an rlimit the call writes into.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return None;
    }
    let raised = libc::rlimit { rlim_cur: limit.rlim_max, rlim_max: limit.rlim_max };
    // SAFETY: `raised` is a valid rlimit that only moves the soft limit.
    (unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) } == 0).then_some(limit)
}

/// Mark every descriptor from `first` up close-on-exec. Async-signal-safe.
fn close_on_exec_from(first: libc::c_uint) {
    // SAFETY: `close_range` takes three integers and touches no memory.
    let marked = unsafe {
        libc::syscall(libc::SYS_close_range, first, libc::c_uint::MAX, libc::CLOSE_RANGE_CLOEXEC)
    };
    if marked == 0 {
        return;
    }
    // Before Linux 5.11: one by one, up to the limit a descriptor can have.
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: `limit` is an rlimit the call writes into.
    unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) };
    let last = limit.rlim_max.min(1 << 20) as libc::c_int;
    for descriptor in first as libc::c_int..last {
        // SAFETY: `fcntl` on a number that is not open fails with EBADF.
        unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
}

#[cfg(test)]
mod tests;
