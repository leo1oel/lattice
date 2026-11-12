//! One-click TeX install helpers are macOS-only for now.

use crate::host::Sink;

#[cfg(not(windows))]
use super::{TexDependencyInstall, TexInstallMode};
use super::{TexInstallProgress, TexPackageUpdates};

type Progress = dyn Sink<TexInstallProgress>;

#[cfg(not(windows))]
pub fn install_tex(
    _mode: TexInstallMode, _on_progress: &Progress,
) -> Result<Option<String>, String> {
    Err("One-click TeX install is not available on Linux yet.".into())
}

#[cfg(not(windows))]
pub fn install_dependency(
    _missing_file: &str, _package: Option<&str>, _on_progress: &Progress,
) -> Result<TexDependencyInstall, String> {
    Err("One-click TeX package install is not available on Linux yet.".into())
}

/// Nothing to report: the doctor offers no package updates on Linux yet.
pub fn check_package_updates() -> Option<TexPackageUpdates> {
    None
}

pub fn update_packages(_on_progress: &Progress) -> Result<(), String> {
    Err("One-click TeX package update is not available on Linux yet.".into())
}
