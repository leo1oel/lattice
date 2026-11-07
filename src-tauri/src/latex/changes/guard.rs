//! latexdiff and the build after it, run so that neither can outlive the
//! export that started it.
//!
//! latexdiff has no limits of its own: on a document whose `\input` files
//! include each other, or a huge generated one, it ran for half an hour and
//! took 30 GB until the writer killed it by hand (#658). Each child here runs
//! in its own process group with a wall-clock limit and a memory ceiling, and
//! the whole group is killed the moment either is passed, the writer cancels,
//! the project closes or Lattice quits.
//!
//! macOS enforces no `RLIMIT_AS`, so the ceiling is a poll: the group's
//! physical footprint (what Activity Monitor shows as Memory, swapped and
//! compressed pages included), summed over every process in it.

use crate::commands;
use std::fs;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How long a child may run and how much memory its group may hold.
#[derive(Debug, Clone, Copy)]
pub(super) struct Limits {
    pub time: Duration,
    pub memory: u64,
}

const GIB: u64 = 1024 * 1024 * 1024;

/// latexdiff on a long thesis takes a minute or two; past five it is stuck.
pub(super) const LATEXDIFF_LIMITS: Limits =
    Limits { time: Duration::from_secs(5 * 60), memory: 4 * GIB };

/// The marked document is built at most twice by latexmk, like the paper.
pub(super) const BUILD_LIMITS: Limits =
    Limits { time: Duration::from_secs(10 * 60), memory: 4 * GIB };

/// How often a running child is checked on.
const POLL: Duration = Duration::from_millis(50);
/// Reading the footprint walks the group, so it is read less often.
const MEMORY_POLL: Duration = Duration::from_millis(250);

/// Why a child was stopped before it finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Stop {
    /// The writer cancelled, the project closed, Lattice quit, or a newer
    /// export in the same project took over.
    Cancelled,
    TimedOut(Duration),
    /// The group's footprint passed the ceiling; the footprint last read.
    OutOfMemory(u64),
}

pub(super) enum Ran {
    Finished(Output),
    Stopped(Stop),
}

/// The export with changes marked under way in one project, and the child it
/// is waiting on. Each export is numbered; starting one, cancelling, or the
/// project closing stops the one before it.
#[derive(Debug, Default)]
pub struct ChangesExports {
    state: Mutex<Exports>,
}

#[derive(Debug, Default)]
struct Exports {
    latest: u64,
    /// The running child's export and process group.
    child: Option<(u64, u32)>,
}

impl ChangesExports {
    /// Stop the export under way, if any, killing its child's whole group at
    /// once: on quit there is no later moment to do it in.
    pub fn cancel(&self) {
        Self::supersede(&mut self.lock());
    }

    /// Stop any export under way and number a new one.
    pub fn begin(&self) -> u64 {
        Self::supersede(&mut self.lock())
    }

    fn supersede(state: &mut Exports) -> u64 {
        state.latest += 1;
        if let Some((_, group)) = state.child.take() {
            commands::signal_process_group(group, libc::SIGKILL);
        }
        state.latest
    }

    fn lock(&self) -> MutexGuard<'_, Exports> {
        // Two plain scalars: a panic cannot have left them half-written.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Run `command` for `export` under `limits`, its output captured in
    /// files under `capture` (a pipe would stall a child that writes more
    /// than it holds while nothing reads).
    pub(super) fn run(
        &self, export: u64, mut command: Command, limits: Limits, capture: &Path, name: &str,
    ) -> std::io::Result<Ran> {
        let (out, err) = (capture.join(format!("{name}.out")), capture.join(format!("{name}.err")));
        command
            .stdin(Stdio::null())
            .stdout(fs::File::create(&out)?)
            .stderr(fs::File::create(&err)?);
        commands::in_new_process_group(&mut command);
        // Paths and options only, never a file's contents: where the writer
        // looks to see what ran (docs/logging.md).
        log::info!(target: "lattice::changes_pdf", "{name} starting: {}", shown(&command));
        let mut child = command.spawn()?;
        {
            let mut state = self.lock();
            if state.latest != export {
                drop(state);
                kill(&mut child);
                return Ok(Ran::Stopped(Stop::Cancelled));
            }
            state.child = Some((export, child.id()));
        }
        let started = Instant::now();
        let mut memory_read = started;
        loop {
            // Reaped under the lock, so `cancel` never signals a group whose
            // leader is gone and whose number may already be another's.
            let status = {
                let mut state = self.lock();
                if state.latest != export {
                    drop(state);
                    kill(&mut child);
                    log::info!(target: "lattice::changes_pdf", "{name} cancelled after {:.1} s", started.elapsed().as_secs_f64());
                    return Ok(Ran::Stopped(Stop::Cancelled));
                }
                let status = child.try_wait();
                if !matches!(status, Ok(None)) {
                    state.child = None;
                }
                status
            };
            let status = status.inspect_err(|_| kill(&mut child))?;
            if let Some(status) = status {
                log::info!(target: "lattice::changes_pdf", "{name} exited with {status} after {:.1} s", started.elapsed().as_secs_f64());
                return Ok(Ran::Finished(Output {
                    status,
                    stdout: fs::read(&out)?,
                    stderr: fs::read(&err)?,
                }));
            }
            let stop = if started.elapsed() >= limits.time {
                Some(Stop::TimedOut(limits.time))
            } else if memory_read.elapsed() >= MEMORY_POLL {
                memory_read = Instant::now();
                let footprint = group_footprint(child.id());
                (footprint > limits.memory).then_some(Stop::OutOfMemory(footprint))
            } else {
                None
            };
            if let Some(stop) = stop {
                log::warn!(target: "lattice::changes_pdf", "{name} stopped after {:.1} s: {stop:?}", started.elapsed().as_secs_f64());
                self.forget(export);
                kill(&mut child);
                return Ok(Ran::Stopped(stop));
            }
            std::thread::sleep(POLL);
        }
    }

    fn forget(&self, export: u64) {
        let mut state = self.lock();
        if state.child.is_some_and(|(running, _)| running == export) {
            state.child = None;
        }
    }
}

#[cfg(test)]
impl ChangesExports {
    fn is_current(&self, export: u64) -> bool {
        self.lock().latest == export
    }

    /// A stand-in latexdiff for this export set: a shell that writes its pid
    /// to `pid_file` and sleeps. The thread answers whether it was cancelled.
    pub(crate) fn sleep_for_test(
        self: &std::sync::Arc<Self>, folder: &Path,
    ) -> std::thread::JoinHandle<bool> {
        let (exports, folder) = (std::sync::Arc::clone(self), folder.to_path_buf());
        let export = exports.begin();
        std::thread::spawn(move || {
            let mut command = Command::new("/bin/sh");
            let pid_file = folder.join("pid");
            command.args(["-c", &format!("echo $$ > '{}'; sleep 30", pid_file.display())]);
            let limits = Limits { time: Duration::from_secs(30), memory: 4 * GIB };
            matches!(
                exports.run(export, command, limits, &folder, "t"),
                Ok(Ran::Stopped(Stop::Cancelled))
            )
        })
    }
}

/// `cd <folder> && <program> <arguments>`, as a person would type it, with
/// the home folder written `~` as the log keeps it.
fn shown(command: &Command) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(folder) = command.get_current_dir() {
        parts.push(format!("cd {} &&", folder.display()));
    }
    parts.push(command.get_program().to_string_lossy().into_owned());
    parts.extend(command.get_args().map(|argument| argument.to_string_lossy().into_owned()));
    let line = parts.join(" ");
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => line.replace(&home, "~"),
        _ => line,
    }
}

/// Kill the child's whole group, then reap the leader.
fn kill(child: &mut Child) {
    commands::signal_process_group(child.id(), libc::SIGKILL);
    let _ = child.kill();
    let _ = child.wait();
}

/// The physical footprint of every process in `group`, in bytes.
fn group_footprint(group: u32) -> u64 {
    #[cfg(target_os = "macos")]
    {
        let Ok(group) = i32::try_from(group) else { return 0 };
        let mut pids = [0 as libc::pid_t; 256];
        let size = i32::try_from(std::mem::size_of_val(&pids)).unwrap_or(i32::MAX);
        // SAFETY: the buffer is `size` bytes long and outlives the call.
        let filled = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), size) };
        // The pids written (a byte count on some releases: the zeroed tail
        // makes either reading safe).
        let count = usize::try_from(filled).unwrap_or(0).min(pids.len());
        let members: Vec<libc::pid_t> =
            pids[..count].iter().copied().filter(|pid| *pid > 0).collect();
        // The leader is counted even when the listing comes back empty.
        let leader = (!members.contains(&group)).then_some(group);
        members.into_iter().chain(leader).map(footprint).sum()
    }
    #[cfg(target_os = "linux")]
    {
        // Approximate: sum RSS of processes whose PGID matches.
        let Ok(entries) = std::fs::read_dir("/proc") else { return 0 };
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
            .filter(|&pid| process_group(pid) == Some(group as i32))
            .map(footprint)
            .sum()
    }
}

#[cfg(target_os = "linux")]
fn process_group(pid: i32) -> Option<i32> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("NSpgid:") {
            return rest.trim().parse().ok();
        }
    }
    None
}

fn footprint(pid: libc::pid_t) -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: `RUSAGE_INFO_V2` asks for exactly a `rusage_info_v2`, which
        // `info` holds; a process that has exited leaves it untouched.
        let read =
            unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, info.as_mut_ptr().cast()) };
        if read != 0 {
            return 0;
        }
        // SAFETY: zeroed, then filled by the kernel on success.
        unsafe { info.assume_init() }.ri_phys_footprint
    }
    #[cfg(target_os = "linux")]
    {
        // /proc/<pid>/statm field 1 is resident pages.
        let Ok(statm) = std::fs::read_to_string(format!("/proc/{pid}/statm")) else { return 0 };
        let pages: u64 =
            statm.split_whitespace().nth(1).and_then(|value| value.parse().ok()).unwrap_or(0);
        pages.saturating_mul(page_size())
    }
}

#[cfg(target_os = "linux")]
fn page_size() -> u64 {
    // SAFETY: sysconf(_SC_PAGESIZE) is always available on Linux.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    u64::try_from(size).unwrap_or(4096)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::sync::Arc;

    const ROOMY: Limits = Limits { time: Duration::from_secs(30), memory: 4 * GIB };

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    /// Whether a process with this pid still exists.
    fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    /// The pid a script wrote to `pid` in `dir` once it started.
    fn written_pid(dir: &Path, name: &str) -> u32 {
        let path = dir.join(name);
        for _ in 0..200 {
            if let Some(pid) = fs::read_to_string(&path).ok().and_then(|s| s.trim().parse().ok()) {
                return pid;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("{name} was never written");
    }

    fn gone(pid: u32) -> bool {
        (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            !alive(pid)
        })
    }

    #[test]
    fn a_child_that_finishes_hands_back_its_output() {
        let dir = TempDir::new("guard-output");
        let exports = ChangesExports::default();
        let export = exports.begin();
        let ran = exports.run(export, shell("echo marked; echo warned >&2"), ROOMY, &dir, "t");
        let Ok(Ran::Finished(output)) = ran else { panic!("did not finish") };
        assert!(output.status.success());
        assert_eq!(
            (output.stdout.as_slice(), output.stderr.as_slice()),
            (&b"marked\n"[..], &b"warned\n"[..])
        );
    }

    /// The runaway in #658, by time: the child and what it started are killed.
    #[test]
    fn a_child_past_its_time_is_killed_with_everything_it_started() {
        let dir = TempDir::new("guard-timeout");
        let script = format!("sleep 30 & echo $! > '{}'; wait", dir.join("grandchild").display());
        let exports = ChangesExports::default();
        let export = exports.begin();
        let limits = Limits { time: Duration::from_millis(300), ..ROOMY };
        let started = Instant::now();
        let ran = exports.run(export, shell(&script), limits, &dir, "t").unwrap();
        assert!(matches!(ran, Ran::Stopped(Stop::TimedOut(_))));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(gone(written_pid(&dir, "grandchild")), "the grandchild outlived the timeout");
    }

    /// The runaway in #658, by memory: perl holding far more than allowed.
    #[test]
    fn a_child_past_its_memory_ceiling_is_killed() {
        let dir = TempDir::new("guard-memory");
        let mut command = Command::new("/usr/bin/perl");
        command.args(["-e", "my $x = 'a' x (400 * 1024 * 1024); sleep 30"]);
        let exports = ChangesExports::default();
        let export = exports.begin();
        let limits = Limits { memory: 64 * 1024 * 1024, ..ROOMY };
        let started = Instant::now();
        let ran = exports.run(export, command, limits, &dir, "t").unwrap();
        let Ran::Stopped(Stop::OutOfMemory(used)) = ran else {
            panic!("was not stopped for memory")
        };
        assert!(used > 64 * 1024 * 1024);
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    /// Cancel in the sheet, closing the comparison or the project, and quitting
    /// all end here.
    #[test]
    fn cancelling_kills_the_running_child_at_once() {
        let dir = TempDir::new("guard-cancel");
        let script = format!("echo $$ > '{}'; sleep 30", dir.join("leader").display());
        let exports = Arc::new(ChangesExports::default());
        let export = exports.begin();
        let running = {
            let (exports, dir) = (Arc::clone(&exports), dir.to_path_buf());
            std::thread::spawn(move || exports.run(export, shell(&script), ROOMY, &dir, "t"))
        };
        let leader = written_pid(&dir, "leader");
        exports.cancel();
        assert!(gone(leader), "the cancelled child is still running");
        assert!(matches!(running.join().unwrap(), Ok(Ran::Stopped(Stop::Cancelled))));
        assert!(!exports.is_current(export));
    }

    #[test]
    fn a_newer_export_stops_the_older_one() {
        let dir = TempDir::new("guard-newer");
        let exports = ChangesExports::default();
        let older = exports.begin();
        let newer = exports.begin();
        assert!(!exports.is_current(older) && exports.is_current(newer));
        // The older one never gets to start its child.
        let ran = exports.run(older, shell("sleep 30"), ROOMY, &dir, "t").unwrap();
        assert!(matches!(ran, Ran::Stopped(Stop::Cancelled)));
    }

    /// The real runaway: latexdiff flattening `\input` files that read each
    /// other grows by about 100 MB a second until it is stopped.
    #[test]
    #[ignore = "requires latexdiff"]
    fn the_runaway_latexdiff_from_658_is_stopped_at_its_memory_ceiling() {
        let dir = TempDir::new("guard-latexdiff");
        for version in ["old", "new"] {
            dir.write(
                &format!("{version}/main.tex"),
                "\\documentclass{article}\n\\begin{document}\n\\input{a}\n\\end{document}\n",
            );
            dir.write(&format!("{version}/a.tex"), format!("A {version}\n\\input{{b}}\n"));
            dir.write(&format!("{version}/b.tex"), "B\n\\input{a}\n");
        }
        let mut command = commands::command("latexdiff");
        command.current_dir(dir.join("new")).arg("--flatten");
        command.arg(dir.join("old/main.tex")).arg(dir.join("new/main.tex"));
        let exports = ChangesExports::default();
        let export = exports.begin();
        let limits = Limits { time: Duration::from_secs(120), memory: 512 * 1024 * 1024 };
        let ran = exports.run(export, command, limits, &dir, "latexdiff").unwrap();
        assert!(matches!(ran, Ran::Stopped(Stop::OutOfMemory(_))));
    }

    #[test]
    fn a_group_s_footprint_counts_every_member() {
        let dir = TempDir::new("guard-footprint");
        let mut command =
            shell("/usr/bin/perl -e 'my $x = q(a) x (96 * 1024 * 1024); sleep 30' & wait");
        commands::in_new_process_group(&mut command);
        let mut child = command.stdout(Stdio::null()).spawn().unwrap();
        let measured = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(30));
            group_footprint(child.id()) > 96 * 1024 * 1024
        });
        kill(&mut child);
        drop(dir);
        assert!(measured, "the perl grandchild's memory was not counted");
    }
}
