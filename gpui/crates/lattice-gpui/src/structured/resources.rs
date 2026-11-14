//! Where the files the structured documents need are: the island pages
//! (`gpui/islands/dist`, built by `script/build-islands`) and the Open Slide
//! runtime the Tauri app stages (`src-tauri/presentation-runtime`, with the
//! Node the Agent's runtime bundles, `src-tauri/synara-runtime/bin`).
//!
//! In order, each is looked for:
//!
//! 1. where an environment variable names it (`LATTICE_GPUI_ISLANDS_DIR`,
//!    `LATTICE_GPUI_RESOURCES`: the folder holding `presentation-runtime/`);
//! 2. in the app bundle, `Contents/Resources/` beside `Contents/MacOS/`;
//! 3. in the checkout the binary runs from: `gpui/target/<profile>/` is two
//!    folders under `gpui/`, where `scripts/gpui-build.mjs` copies the binary
//!    it builds in the shared tree back to.

use std::path::{Path, PathBuf};

/// The folder of the running binary.
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .canonicalize()
        .ok()?
        .parent()
        .map(Path::to_path_buf)
}

/// The checkout's `gpui/` folder, when the binary runs from
/// `gpui/target/<profile>/`.
fn checkout_gpui() -> Option<PathBuf> {
    let dir = exe_dir()?;
    let gpui = dir.parent()?.parent()?;
    gpui.join("Cargo.toml")
        .is_file()
        .then(|| gpui.to_path_buf())
}

fn first_with(candidates: impl IntoIterator<Item = PathBuf>, marker: &str) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|candidate| candidate.join(marker).is_file())
}

/// The built island pages.
pub fn islands_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("LATTICE_GPUI_ISLANDS_DIR") {
        return Some(PathBuf::from(dir));
    }
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join("../Resources/islands"));
    }
    if let Some(gpui) = checkout_gpui() {
        candidates.push(gpui.join("islands/dist"));
    }
    first_with(candidates, "sheet/index.html")
}

/// The folder holding `presentation-runtime/server.mjs` and the bundled
/// Node (`synara-runtime/bin/node`): lattice-core's `Resources::bundle_dir`.
pub fn presentation_bundle() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("LATTICE_GPUI_RESOURCES") {
        return Some(PathBuf::from(dir));
    }
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join("../Resources"));
    }
    if let Some(gpui) = checkout_gpui() {
        candidates.push(gpui.join("../src-tauri"));
    }
    first_with(candidates, "presentation-runtime/server.mjs")
}

/// The app's data and cache folders, for the runtime's shadow copy and Vite
/// cache: the GPUI app's own, never the Tauri app's.
pub struct AppDirs {
    pub data: PathBuf,
    pub cache: PathBuf,
}

pub fn app_dirs() -> AppDirs {
    let base = |dir: Option<PathBuf>| dir.unwrap_or_else(std::env::temp_dir).join("lattice-gpui");
    AppDirs {
        data: base(dirs::data_dir()),
        cache: base(dirs::cache_dir()),
    }
}
