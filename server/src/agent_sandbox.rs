//! Fail-closed Landlock policy for all descendants of a headless agent.
//! No user namespace or system policy changes are required.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
#[derive(Serialize, Deserialize)]
pub struct Policy {
    pub read: Vec<PathBuf>,
    pub write: Vec<PathBuf>,
}

#[cfg(target_os = "linux")]
pub fn apply(policy: &Policy) -> Result<(), String> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::fs::OpenOptionsExt;
    #[repr(C)]
    struct Ruleset {
        access_fs: u64,
        access_net: u64,
        scoped: u64,
    }
    #[repr(C, packed)]
    struct PathRule {
        access: u64,
        parent_fd: i32,
    }
    const CREATE: libc::c_long = 444;
    const ADD: libc::c_long = 445;
    const RESTRICT: libc::c_long = 446;
    const ALL: u64 = (1 << 15) - 1;
    const READ: u64 = 1 | 4 | 8;
    let abi = unsafe { libc::syscall(CREATE, std::ptr::null::<u8>(), 0, 1) };
    if abi < 6 {
        return Err("Linux Landlock ABI 6 or newer is required; agent remains stopped.".into());
    }
    let attributes = Ruleset { access_fs: ALL, access_net: 0, scoped: 3 };
    let fd = unsafe { libc::syscall(CREATE, &attributes, std::mem::size_of::<Ruleset>(), 0) };
    if fd < 0 {
        return Err(format!(
            "Cannot create agent Landlock ruleset: {}",
            std::io::Error::last_os_error()
        ));
    }
    let ruleset = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    for (paths, access) in [(&policy.read, READ), (&policy.write, ALL & !(64 | 2048))] {
        for path in paths {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_PATH | libc::O_CLOEXEC)
                .open(path)
                .map_err(|_| format!("Cannot open sandbox path {}", path.display()))?;
            let allowed = if file.metadata().map_err(|e| e.to_string())?.is_dir() {
                access
            } else {
                access & (1 | 2 | 4 | 16384)
            };
            let rule = PathRule { access: allowed, parent_fd: file.as_raw_fd() };
            if unsafe { libc::syscall(ADD, ruleset.as_raw_fd(), 1, &rule, 0) } < 0 {
                return Err(format!(
                    "Cannot add sandbox rule: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0
        || unsafe { libc::syscall(RESTRICT, ruleset.as_raw_fd(), 0) } < 0
    {
        return Err(format!("Cannot restrict agent: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
pub fn apply(_policy: &Policy) -> Result<(), String> {
    Err("The standalone agent sandbox requires Linux Landlock.".into())
}

pub fn execute(policy: PathBuf, program: PathBuf, args: Vec<String>) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let policy: Policy = serde_json::from_slice(&std::fs::read(policy).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    {
        if unsafe { libc::setsid() } < 0 {
            return Err("Cannot establish an isolated agent process session".into());
        }
        unsafe {
            libc::umask(0o077);
        }
    }
    apply(&policy)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let listener = crate::agent_seccomp::install()?;
        crate::agent_seccomp::send(3, listener.as_raw_fd())?;
        unsafe {
            libc::close(3);
        }
        if unsafe { libc::syscall(436, 3u32, u32::MAX, 4u32) } < 0 {
            return Err("Cannot close inherited agent descriptors".into());
        }
    }
    Err(format!(
        "Could not execute agent runtime: {}",
        std::process::Command::new(program).args(args).exec()
    ))
}
