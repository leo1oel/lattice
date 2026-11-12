//! One-click TeX and required-tool install helpers.
//!
//! A full install downloads the pinned BasicTeX package, runs one privileged
//! script for it and the TeX Live packages Lattice needs, installs the
//! app-managed uv, and then verifies everything as the signed-in user. The
//! tools-only mode keeps a working TeX and installs just uv. A dependency
//! install finds the TeX Live package that provides a missing file, or asks
//! the writer to pick when several are equally likely. A
//! package update brings an installed BasicTeX's packages current, after the
//! doctor's `check_package_updates` finds them out of date.
//!
//! `installer` holds the pins, scripts and output parsers,
//! `package_providers` which package provides a missing file, and
//! `package_updates` what `tlmgr update --list` says; `macos` runs them
//! on macOS. Other platforms expose the same commands but refuse one-click
//! install until a Linux path exists. Downloads stay in `fetch`.

use serde::{Deserialize, Serialize};

mod fetch;
// Only `macos` runs the installers, but their scripts and parsers are plain
// functions tested on every platform.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod installer;
#[cfg(target_os = "macos")]
mod macos;
// The Windows installer's parts are plain functions tested on every platform;
// only `windows` uses them.
#[cfg_attr(not(windows), allow(dead_code))]
mod miktex;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod package_providers;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod package_updates;
#[cfg_attr(not(windows), allow(dead_code))]
mod run;
mod safe_zip;
#[cfg(not(target_os = "macos"))]
mod stub;
#[cfg_attr(not(windows), allow(dead_code))]
mod tex_live;
#[cfg_attr(not(windows), allow(dead_code))]
mod user_dirs;
#[cfg_attr(not(windows), allow(dead_code))]
mod uv_zip;
#[cfg(windows)]
mod windows;
#[cfg_attr(not(windows), allow(dead_code))]
mod windows_pins;

pub(crate) use fetch::download as download_pinned;
pub(crate) use installer::{create_private_file, PinnedDownload};
#[cfg(target_os = "macos")]
pub use macos::{check_package_updates, install_dependency, install_tex, update_packages};
pub use package_updates::{TexPackageUpdate, TexPackageUpdates};
#[cfg(not(any(target_os = "macos", windows)))]
pub use stub::{check_package_updates, install_dependency, install_tex, update_packages};
// Windows installs TeX itself; it has no package-update step yet.
#[cfg(windows)]
pub use stub::{check_package_updates, update_packages};
#[cfg(windows)]
pub use windows::{cancel_install, install_dependency, install_tex};

/// Stop the install that is running, if one is: its processes end and the
/// install returns an error that says it was cancelled. Only the Windows
/// installer can be cancelled (macOS hands the install to its administrator
/// prompt); `false` means there was nothing to cancel.
#[cfg(not(windows))]
pub fn cancel_install() -> bool {
    false
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexInstallProgress {
    stage: String,
    progress: f64,
}

impl TexInstallProgress {
    pub fn new(stage: impl Into<String>, progress: f64) -> Self {
        Self { stage: stage.into(), progress }
    }

    /// What the install is doing: `downloading`, `authorizing`,
    /// `installing-base`, … `complete` (src/build/tex-setup.ts lists them).
    pub fn stage(&self) -> &str {
        &self.stage
    }

    /// How far along it is, from 0 to 1.
    pub fn progress(&self) -> f64 {
        self.progress
    }
}

/// How a missing-package install ended without an error.
// Only `macos` installs packages; the other platforms' stub always refuses.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TexDependencyInstall {
    Installed,
    /// Nothing was installed: these packages all provide the file, and the
    /// writer picks one to install.
    ChoosePackage {
        packages: Vec<String>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TexInstallMode {
    Full,
    ToolsOnly,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_modes_are_explicit_ipc_values() {
        let modes: Vec<TexInstallMode> = serde_json::from_str(r#"["toolsOnly", "full"]"#).unwrap();
        assert_eq!(modes, [TexInstallMode::ToolsOnly, TexInstallMode::Full]);
    }

    #[test]
    fn dependency_install_outcomes_are_tagged_ipc_values() {
        let outcomes = [
            TexDependencyInstall::Installed,
            TexDependencyInstall::ChoosePackage {
                packages: vec!["arabtex".into(), "ledmac".into()],
            },
        ];
        assert_eq!(
            serde_json::to_string(&outcomes).unwrap(),
            r#"[{"kind":"installed"},{"kind":"choosePackage","packages":["arabtex","ledmac"]}]"#
        );
    }
}
