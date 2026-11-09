//! One-click TeX and required-tool install helpers.
//!
//! A full install downloads the pinned BasicTeX package, runs one privileged
//! script for it and the TeX Live packages Lattice needs, installs the
//! app-managed uv, and then verifies everything as the signed-in user. The
//! tools-only mode keeps a working TeX and installs just uv. A dependency
//! install finds the one TeX Live package that provides a missing file. A
//! package update brings an installed BasicTeX's packages current, after the
//! doctor's `check_package_updates` finds them out of date.
//!
//! `installer` holds the pins, scripts and output parsers, and
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
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod package_updates;
#[cfg(not(target_os = "macos"))]
mod stub;

pub(crate) use fetch::download as download_pinned;
pub(crate) use installer::{create_private_file, PinnedDownload};
#[cfg(target_os = "macos")]
pub use macos::{check_package_updates, install_dependency, install_tex, update_packages};
pub use package_updates::TexPackageUpdates;
#[cfg(not(target_os = "macos"))]
pub use stub::{check_package_updates, install_dependency, install_tex, update_packages};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexInstallProgress {
    stage: String,
    progress: f64,
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
}
