//! Where the files the structured documents and the Agent need are: the
//! island pages (`gpui/islands/dist`, built by `script/build-islands`), the
//! Open Slide runtime the Tauri app stages (`src-tauri/presentation-runtime`,
//! with the Node the Agent's runtime bundles, `src-tauri/synara-runtime/bin`)
//! and the Agent's Synara service (`src-tauri/synara-runtime`).
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

/// The folder holding `synara-runtime/` (the Agent's Synara service and the
/// Node it runs on, staged by the Tauri app's `scripts/prepare-synara-runtime.mjs`)
/// and `src/embedded_skills/`: lattice-core's `Resources::bundle_dir` for the
/// Agent. Without a staged runtime it is the first place looked, where
/// lattice-core's supervisor says the service is missing.
pub fn agent_bundle() -> PathBuf {
    if let Some(dir) = std::env::var_os("LATTICE_GPUI_RESOURCES") {
        return PathBuf::from(dir);
    }
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join("../Resources"));
    }
    if let Some(gpui) = checkout_gpui() {
        candidates.push(gpui.join("../src-tauri"));
    }
    let fallback = candidates.first().cloned().unwrap_or_default();
    first_with(candidates, "synara-runtime/server/dist/index.mjs").unwrap_or(fallback)
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
