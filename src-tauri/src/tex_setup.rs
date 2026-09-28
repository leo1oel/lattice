//! One-click TeX and required-tool install helpers for macOS.
//!
//! A full install downloads the pinned BasicTeX package, runs one privileged
//! script for it and the TeX Live packages Lattice needs, installs the
//! app-managed uv, and then verifies everything as the signed-in user. The
//! tools-only mode keeps a working TeX and installs just uv. A dependency
//! install finds the one TeX Live package that provides a missing file.
//!
//! `installer` holds the pins, scripts and output parsers; `macos` runs them.

use serde::{Deserialize, Serialize};

mod installer;
mod macos;

pub use macos::{install_dependency, install_tex};

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
