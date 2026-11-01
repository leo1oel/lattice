//! A pseudo-terminal and the login shell started in it.
//!
//! `openpty` and a plain `Command` rather than a PTY crate: the shell needs a
//! new session (`setsid`) with the terminal as its controlling tty, which is
//! a few lines over `libc`, already a dependency.

use std::ffi::{CStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// The shell running in a pseudo-terminal, and the terminal's master side.
pub(super) struct Shell {
    pub(super) master: OwnedFd,
    pub(super) child: Child,
    /// The program, by name ("zsh"), for the tab.
    pub(super) name: String,
}

/// The writer's login shell, as a terminal app runs it: from the account
/// record, else `$SHELL`, else zsh (macOS's default).
pub(crate) fn login_shell() -> PathBuf {
    let usable = |path: &Path| path.is_absolute() && path.is_file();
    // SAFETY: getpwuid_r writes only into `record` and `buffer`, both sized
    // here, and the shell string it points at lives in `buffer`.
    let from_account = unsafe {
        let mut record: libc::passwd = std::mem::zeroed();
        let mut buffer = vec![0 as libc::c_char; 4096];
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        let status = libc::getpwuid_r(
            libc::getuid(),
            &mut record,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        );
        (status == 0 && !found.is_null() && !record.pw_shell.is_null())
            .then(|| PathBuf::from(CStr::from_ptr(record.pw_shell).to_string_lossy().into_owned()))
    };
    from_account
        .filter(|path| usable(path))
        .or_else(|| std::env::var_os("SHELL").map(PathBuf::from).filter(|path| usable(path)))
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"))
}

/// The search path the shell starts from: Lattice's own, then the TeX
/// locations a GUI launch rarely has, so `latexmk` is found even before the
/// login profile runs (macOS's `path_helper` keeps what it was given).
fn starting_path() -> OsString {
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_else(|| ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from).to_vec());
    for directory in crate::commands::tex_directories() {
        if directory.is_dir() && !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    std::env::join_paths(directories).unwrap_or_default()
}

fn set_cloexec(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor this module owns.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A new pseudo-terminal of `cols` × `rows`, as (master, slave).
fn open(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    let mut size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: openpty writes two descriptors, which are owned from here on.
    let status = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if status < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both were just opened and nothing else holds them.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    // Neither may leak into another child Lattice starts (a build, the
    // sidecar): a stray copy of the slave keeps the terminal from ever
    // hanging up, and one of the master would let that child type into it.
    set_cloexec(master.as_raw_fd())?;
    set_cloexec(slave.as_raw_fd())?;
    // The line discipline counts a UTF-8 character as one when it erases, so
    // Backspace over 中文 at a plain prompt removes a character, not a byte.
    // SAFETY: termios is plain data, read and written on the slave only.
    unsafe {
        let mut termios: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(slave.as_raw_fd(), &mut termios) == 0 {
            termios.c_iflag |= libc::IUTF8;
            libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &termios);
        }
    }
    Ok((master, slave))
}

/// Start `shell` as a login shell in `cwd` on a new pseudo-terminal.
pub(super) fn spawn_shell(shell: &Path, cwd: &Path, cols: u16, rows: u16) -> io::Result<Shell> {
    let (cols, rows) = bounded(cols, rows);
    let (master, slave) = open(cols, rows)?;
    let name =
        shell.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let mut command = Command::new(shell);
    // `-l`, as every terminal app starts it: the login profile sets the
    // writer's own PATH (Homebrew, TeX, pyenv), which a GUI launch lacks.
    command
        .arg("-l")
        .current_dir(cwd)
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave.try_clone()?))
        .env("PATH", starting_path())
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .env("TERM_PROGRAM", "Lattice")
        .env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"))
        // Lattice's own variables describe Lattice's process, not the shell's.
        .env_remove("LATTICE_PROJECT");
    // A Finder launch has no locale; without one zsh and vim treat CJK text
    // as single bytes. LC_CTYPE alone leaves messages in the writer's language.
    if ["LC_ALL", "LC_CTYPE", "LANG"].iter().all(|name| std::env::var_os(name).is_none()) {
        command.env("LC_CTYPE", "UTF-8");
    }
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(|| {
            // A session of its own, with this terminal controlling it: job
            // control works, and hanging up the terminal reaches every job.
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            // Dispositions Lattice ignores survive exec; a shell expects them default.
            for signal in [
                libc::SIGPIPE,
                libc::SIGHUP,
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGTERM,
                libc::SIGTSTP,
                libc::SIGTTIN,
                libc::SIGTTOU,
                libc::SIGCHLD,
            ] {
                libc::signal(signal, libc::SIG_DFL);
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    // Only the shell holds the slave now, so the master reads end of file
    // once the shell and everything it started have closed it.
    drop(slave);
    Ok(Shell { master, child, name })
}

/// A size a page asked for, held to what a screen can show.
fn bounded(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(2, 1000), rows.clamp(1, 500))
}

/// Tell the terminal its new size; its foreground job gets SIGWINCH.
pub(super) fn resize(master: &OwnedFd, cols: u16, rows: u16) -> io::Result<()> {
    let (cols, rows) = bounded(cols, rows);
    let size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: TIOCSWINSZ reads one winsize from the pointer.
    if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The terminal's foreground process group, when it is not the shell's own:
/// a command is running.
pub(super) fn foreground_job(master: &OwnedFd, shell: u32) -> Option<i32> {
    // SAFETY: tcgetpgrp only reads the descriptor's terminal.
    let group = unsafe { libc::tcgetpgrp(master.as_raw_fd()) };
    (group > 0 && u32::try_from(group).ok() != Some(shell)).then_some(group)
}

/// A process's name ("latexmk"), when it still exists.
pub(super) fn process_name(pid: i32) -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: proc_name writes at most the buffer's length.
    let length = unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    let length = usize::try_from(length).ok().filter(|length| *length > 0)?;
    Some(String::from_utf8_lossy(&buffer[..length]).into_owned())
}

/// Send `signal` to process group `group`. Lattice's own group is never one
/// of these: every shell leads a session of its own.
pub(super) fn signal_group(group: i32, signal: libc::c_int) {
    if group > 1 {
        // SAFETY: kill with a negative pid signals that group only.
        unsafe {
            libc::kill(-group, signal);
        }
    }
}

/// Whether anything in process group `group` is still alive.
pub(super) fn group_alive(group: i32) -> bool {
    // SAFETY: signal 0 only checks that the group exists.
    group > 1 && unsafe { libc::kill(-group, 0) } == 0
}
