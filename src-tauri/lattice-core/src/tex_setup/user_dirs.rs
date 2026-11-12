//! The per-user folders the Windows installer reads from the environment.

use std::path::PathBuf;

/// Said when no `%LOCALAPPDATA%` is found, so no per-user folder can be named.
pub(crate) const APP_SUPPORT_MISSING: &str = "Could not locate your Windows AppData folder.";

/// `%LOCALAPPDATA%`, when set and not empty.
pub(crate) fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// `%USERPROFILE%`, when set and not empty.
pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()).map(PathBuf::from)
}
