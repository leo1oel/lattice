//! Fixtures shared by the core's unit tests and, through the `test-support`
//! feature, a shell's.

use std::fs;
use std::ops::Deref;
use std::path::{Path, PathBuf};

/// A fresh directory under the system temp dir, removed with everything in it
/// when dropped. Derefs to its path.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("lattice-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    /// Write `contents` to `relative`, creating its parent directories.
    pub fn write(&self, relative: &str, contents: impl AsRef<[u8]>) -> PathBuf {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }
}

impl Deref for TempDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TempDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Create the same file or directory link on each host. Relative targets
/// are interpreted beside the link, as the OS interprets them.
pub fn symlink(original: impl AsRef<Path>, link: impl AsRef<Path>) -> std::io::Result<()> {
    let (original, link) = (original.as_ref(), link.as_ref());
    #[cfg(unix)]
    return std::os::unix::fs::symlink(original, link);
    #[cfg(windows)]
    {
        let target = link.parent().unwrap_or(Path::new(".")).join(original);
        if target.is_dir() {
            std::os::windows::fs::symlink_dir(original, link)
        } else {
            std::os::windows::fs::symlink_file(original, link)
        }
    }
}

/// An idle process owned by a lifecycle test, without relying on a Unix shell.
pub fn sleep_command(seconds: u64) -> std::process::Command {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("powershell.exe");
        command.args(["-NoProfile", "-Command", &format!("Start-Sleep -Seconds {seconds}")]);
        command
    }
    #[cfg(unix)]
    {
        let mut command = std::process::Command::new("sleep");
        command.arg(seconds.to_string());
        command
    }
}

/// Liveness for a pid written by a child fixture, without Unix-only libc calls.
pub fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        i32::try_from(pid).is_ok_and(|pid| unsafe { libc::kill(pid, 0) } == 0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        unsafe {
            WaitForSingleObject(handle.as_raw_handle(), 0)
                == windows_sys::Win32::Foundation::WAIT_TIMEOUT
        }
    }
}
