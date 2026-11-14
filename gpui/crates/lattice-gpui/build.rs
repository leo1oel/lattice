//! Bundle the release notes the Tauri app's What's new sheet reads
//! (`src/release-notes/*.json`, written by `scripts/release-notes.mjs` and
//! `scripts/bump-version.mjs`): one `include_str!` per file, so a new
//! release's notes reach the GPUI app without a list kept by hand.

use std::{env, fs, path::PathBuf};

fn main() {
    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets the manifest dir"));
    let notes = manifest.join("../../../src/release-notes");
    println!("cargo::rerun-if-changed={}", notes.display());
    let mut files: Vec<PathBuf> = fs::read_dir(&notes)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut out = String::from("&[\n");
    for file in &files {
        let path = file.canonicalize().unwrap_or_else(|_| file.clone());
        out.push_str(&format!(
            "    include_str!({:?}),\n",
            path.display().to_string()
        ));
    }
    out.push(']');
    let target =
        PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR")).join("release_notes.rs");
    fs::write(target, out).expect("the release notes list is written");
}
