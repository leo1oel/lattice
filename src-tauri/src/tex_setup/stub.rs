//! One-click TeX install helpers are macOS-only for now.

use tauri::ipc::Channel;

use super::{TexInstallMode, TexInstallProgress, TexPackageUpdates};

type Progress = Channel<TexInstallProgress>;

pub fn install_tex(
    _mode: TexInstallMode, _on_progress: &Progress,
) -> Result<Option<String>, String> {
    Err("One-click TeX install is not available on Linux yet.".into())
}

pub fn install_dependency(_missing_file: &str, _on_progress: &Progress) -> Result<(), String> {
    Err("One-click TeX package install is not available on Linux yet.".into())
}

/// Nothing to report: the doctor offers no package updates on Linux yet.
pub fn check_package_updates() -> Option<TexPackageUpdates> {
    None
}

pub fn update_packages(_on_progress: &Progress) -> Result<(), String> {
    Err("One-click TeX package update is not available on Linux yet.".into())
}
