//! Taking the fixed browser port back from a stale Lattice browser host.
//!
//! An older installed build (or, when explicitly requested, this build's own
//! background login item) may still own the fixed port. It is terminated only
//! when every authorization input identifies it as this user's
//! `<this executable> --browser-host` process.

use std::net::{SocketAddrV4, TcpListener};
use std::path::Path;
use std::time::Duration;

const CS_OPS_CDHASH: libc::c_uint = 5;

unsafe extern "C" {
    fn csops(
        pid: libc::pid_t, ops: libc::c_uint, useraddr: *mut libc::c_void, usersize: libc::size_t,
    ) -> libc::c_int;
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ProcessIdentity {
    pid: libc::pid_t,
    start_seconds: u64,
    start_microseconds: u64,
}

pub(super) fn replace_stale_browser_host(
    address: SocketAddrV4, take_over_background_host: bool,
) -> Option<TcpListener> {
    let current_exe = std::env::current_exe().ok()?;
    let candidate = stale_browser_host(&current_exe, take_over_background_host)?;
    // Re-read every authorization input immediately before signaling. A PID
    // can be recycled and the fixed port can change owners between `lsof` and
    // this point; either change must fail closed instead of killing the new
    // listener.
    if stale_browser_host(&current_exe, take_over_background_host)? != candidate {
        return None;
    }
    if unsafe { libc::kill(candidate.pid, libc::SIGTERM) } != 0 {
        return None;
    }
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(50));
        match TcpListener::bind(address) {
            Ok(listener) => {
                log::info!(
                    target: "lattice::browser",
                    "replaced browser host from an older installed build"
                );
                return Some(listener);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
            Err(_) => return None,
        }
    }
    None
}

fn stale_browser_host(
    current_exe: &Path, take_over_background_host: bool,
) -> Option<ProcessIdentity> {
    let pid = browser_listener_pid()?;
    let identity = process_identity(pid)?;
    let arguments = process_arguments(pid)?;
    let own_pid = std::process::id() as libc::pid_t;
    if identity.pid == own_pid
        || !process_executable_matches(pid, current_exe)
        || !browser_host_arguments_match(&arguments, current_exe)
    {
        return None;
    }
    let running_hash = process_code_hash(pid)?;
    let current_hash = process_code_hash(own_pid)?;
    (take_over_background_host || running_hash != current_hash).then_some(identity)
}

fn browser_host_arguments_match(arguments: &[impl AsRef<[u8]>], current_exe: &Path) -> bool {
    matches!(arguments, [executable, flag]
        if executable.as_ref() == current_exe.as_os_str().as_encoded_bytes()
            && flag.as_ref() == b"--browser-host")
}

fn process_executable_matches(pid: libc::pid_t, current_exe: &Path) -> bool {
    let mut path = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let read = unsafe {
        libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len().try_into().unwrap_or(u32::MAX))
    };
    if read <= 0 {
        return false;
    }
    let read = read as usize;
    let length = path[..read].iter().position(|byte| *byte == 0).unwrap_or(read);
    path[..length] == *current_exe.as_os_str().as_encoded_bytes()
}

fn browser_listener_pid() -> Option<libc::pid_t> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-t", "-a", "-iTCP@127.0.0.1:18452", "-sTCP:LISTEN"])
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let mut pids = String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .filter_map(|line| line.trim().parse::<libc::pid_t>().ok())
        .collect::<Vec<_>>();
    pids.sort_unstable();
    pids.dedup();
    (pids.len() == 1 && pids[0] > 0).then_some(pids[0])
}

fn process_identity(pid: libc::pid_t) -> Option<ProcessIdentity> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size)
    };
    if read != size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_uid != unsafe { libc::geteuid() } {
        return None;
    }
    Some(ProcessIdentity {
        pid,
        start_seconds: info.pbi_start_tvsec,
        start_microseconds: info.pbi_start_tvusec,
    })
}

fn process_arguments(pid: libc::pid_t) -> Option<Vec<Vec<u8>>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut sysctl = |buffer: *mut libc::c_void, size: &mut usize| {
        let length = mib.len() as libc::c_uint;
        let result = unsafe {
            libc::sysctl(mib.as_mut_ptr(), length, buffer, size, std::ptr::null_mut(), 0)
        };
        result == 0
    };
    let mut size = 0;
    if !sysctl(std::ptr::null_mut(), &mut size)
        || size < std::mem::size_of::<libc::c_int>()
        || size > 1024 * 1024
    {
        return None;
    }
    let mut buffer = vec![0_u8; size];
    if !sysctl(buffer.as_mut_ptr().cast(), &mut size) {
        return None;
    }
    buffer.truncate(size);
    parse_process_arguments(&buffer)
        .map(|arguments| arguments.into_iter().map(<[u8]>::to_vec).collect())
}

/// Split a `KERN_PROCARGS2` buffer (argc, executable path, padding, then argv)
/// into argv.
fn parse_process_arguments(buffer: &[u8]) -> Option<Vec<&[u8]>> {
    let argc_size = std::mem::size_of::<libc::c_int>();
    let argc = libc::c_int::from_ne_bytes(buffer.get(..argc_size)?.try_into().ok()?);
    if !(0..=64).contains(&argc) {
        return None;
    }
    let skip_padding = |mut cursor: usize| {
        while buffer.get(cursor) == Some(&0) {
            cursor += 1;
        }
        cursor
    };
    let mut cursor = argc_size;
    cursor = skip_padding(cursor + buffer.get(cursor..)?.iter().position(|byte| *byte == 0)? + 1);
    let mut arguments = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        let rest = buffer.get(cursor..)?;
        let length = rest.iter().position(|byte| *byte == 0)?;
        arguments.push(&rest[..length]);
        cursor = skip_padding(cursor + length + 1);
    }
    Some(arguments)
}

fn process_code_hash(pid: libc::pid_t) -> Option<[u8; 20]> {
    let mut hash = [0_u8; 20];
    let result = unsafe { csops(pid, CS_OPS_CDHASH, hash.as_mut_ptr().cast(), hash.len()) };
    (result == 0).then_some(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_host_authorization_requires_the_exact_executable_and_single_host_argument() {
        let executable = Path::new("/Applications/Lattice.app/Contents/MacOS/research-writer");
        let executable_bytes = executable.as_os_str().as_encoded_bytes();
        let mut raw = 2_i32.to_ne_bytes().to_vec();
        for part in [executable_bytes, &[0, 0, 0], executable_bytes, b"\0--browser-host\0"] {
            raw.extend_from_slice(part);
        }
        raw.extend_from_slice(b"HOME=/tmp\0");
        let arguments = parse_process_arguments(&raw).unwrap();

        assert!(browser_host_arguments_match(&arguments, executable));
        let mut extra_argument = arguments.clone();
        extra_argument.push(b"--unexpected");
        assert!(!browser_host_arguments_match(&extra_argument, executable));
        assert!(!browser_host_arguments_match(&arguments, Path::new("/tmp/research-writer")));
    }
}
