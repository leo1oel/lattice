//! The real machine behind [`Host`](super::Host).

use super::Host;
use crate::commands;
use crate::tex_setup::tex_live::private_temp_dir;
use crate::tex_setup::user_dirs as dirs;
use crate::tex_setup::PinnedDownload;
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

pub(super) struct SystemHost;

/// The 8.3 short name of the existing folder `path`, through
/// `GetShortPathNameW`. `None` when the folder has none (short names are
/// switched off on its volume) or cannot be read.
pub(super) fn short_path_of(path: &Path) -> Option<PathBuf> {
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives both calls; the first call
    // only asks for the length (in characters, NUL included) of the result.
    let needed = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
    if needed == 0 {
        return None;
    }
    let mut buffer = vec![0_u16; needed as usize];
    // SAFETY: `buffer` holds `needed` characters, which is what is passed.
    let written =
        unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
    // A result longer than the buffer (the folder changed between the calls)
    // reports the size it now needs; fewer than that is the length written.
    if written == 0 || written as usize >= buffer.len() {
        return None;
    }
    Some(PathBuf::from(OsString::from_wide(&buffer[..written as usize])))
}

impl Host for SystemHost {
    fn local_app_data(&self) -> Option<PathBuf> {
        dirs::local_app_data()
    }

    fn short_path(&self, path: &Path) -> Option<PathBuf> {
        short_path_of(path)
    }

    fn current_year(&self) -> i32 {
        chrono::Utc::now().format("%Y").to_string().parse().unwrap_or(0)
    }

    /// The system's temp folder when it is inside the user's profile, else a
    /// `Temp` folder in their `%LOCALAPPDATA%` (created if need be).
    fn temp_dir(&self) -> PathBuf {
        let local = self.local_app_data();
        let temp =
            private_temp_dir(std::env::temp_dir(), dirs::home_dir().as_deref(), local.as_deref());
        let _ = std::fs::create_dir_all(&temp);
        temp
    }

    fn tools_dir(&self) -> Option<PathBuf> {
        commands::managed_tools_dir()
    }

    fn download(
        &self, pinned: &PinnedDownload, path: &Path, cancel: &AtomicBool,
        on_bytes: &mut dyn FnMut(u64, u64),
    ) -> Result<(), String> {
        crate::tex_setup::fetch::download_cancellable(pinned, path, cancel, on_bytes)
    }

    /// The batch file as it is: `install-tl` runs on its own Perl, takes TeX
    /// folders out of PATH itself, and must not be handed Lattice's search
    /// path. `TEXLIVE_INSTALL_ENV_NOCHECK` stops it refusing to run because
    /// some variable's name contains "tex"; `TEXLIVE_INSTALL_NO_RESUME` that it
    /// asks whether to resume an earlier run.
    fn installer_command(&self, installer: &Path, args: &[String], cwd: &Path) -> Command {
        let mut command = Command::new(installer);
        command
            .args(args)
            .current_dir(cwd)
            .env("TEXLIVE_INSTALL_ENV_NOCHECK", "1")
            .env("TEXLIVE_INSTALL_NO_RESUME", "1");
        command
    }

    fn program(&self, path: &Path) -> Command {
        commands::with_child_path(Command::new(path))
    }

    fn tool_command(&self, name: &str) -> Command {
        commands::command(name)
    }

    fn resolved_tool(&self, name: &str) -> Option<PathBuf> {
        let path = commands::resolve(name);
        path.is_file().then_some(path)
    }

    fn uv_status(&self, name: &str) -> Result<(), String> {
        commands::managed_uv_tool_status(name).map(drop)
    }

    fn uv_status_at(&self, path: &Path, name: &str) -> Result<(), String> {
        commands::uv_tool_status_at(path, name)
    }
}
