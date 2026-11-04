//! All descendants retain a unique session: seccomp denies later setsid calls.
//! Process-group changes therefore do not escape shutdown.
#[cfg(target_os = "linux")]
pub fn stop(session: u32) {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    fn session_of(pid: u32) -> Option<u32> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        stat.rsplit_once(')')?.1.split_whitespace().nth(3)?.parse().ok()
    }
    fn signal(pid: u32, session: u32, signal: i32) {
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if raw < 0 {
            return;
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
        if session_of(pid) == Some(session) {
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    signal,
                    std::ptr::null::<u8>(),
                    0,
                );
            }
        }
    }
    let mut members = std::collections::BTreeSet::new();
    for _ in 0..4 {
        let Some(entries) = std::fs::read_dir("/proc").ok() else { break };
        let mut found = false;
        for entry in entries.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
                continue;
            };
            if session_of(pid) == Some(session) {
                found |= members.insert(pid);
                signal(pid, session, libc::SIGSTOP);
            }
        }
        if !found {
            break;
        }
    }
    for pid in members {
        signal(pid, session, libc::SIGKILL);
    }
}
#[cfg(not(target_os = "linux"))]
pub fn stop(_session: u32) {}
