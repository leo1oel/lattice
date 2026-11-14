//! Bundle the release notes the Tauri app's What's new sheet reads
//! (`src/release-notes/*.json`, written by `scripts/release-notes.mjs` and
//! `scripts/bump-version.mjs`): one `include_str!` per file, so a new
//! release's notes reach the GPUI app without a list kept by hand.
//!
//! And the same for the e2e scenario's modules ([`e2e_modules`]) and the
//! window's parts (`src/shell/parts.rs`, [`window_parts`]): each is a file
//! that registers itself, so features landing side by side do not all edit
//! one list.

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
    e2e_modules(&manifest);
    window_parts(&manifest);
}

/// Declare every module of the e2e scenario (`src/scenario/e2e/*.rs` and
/// `*/mod.rs`) and list the feature modules among them, the files holding a
/// `const MODULE` (`scenario/e2e/registry.rs`), so a new module is a new
/// file and nothing else. A file that opens with `#![cfg(...)]` is listed
/// under that condition, and by name only elsewhere.
fn e2e_modules(manifest: &std::path::Path) {
    let dir = manifest.join("src/scenario/e2e");
    println!("cargo::rerun-if-changed={}", dir.display());
    let mut files: Vec<(String, PathBuf)> = fs::read_dir(&dir)
        .expect("src/scenario/e2e holds the e2e scenario")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter_map(|path| {
            let name = path.file_stem()?.to_str()?.to_string();
            if path.is_dir() {
                let module = path.join("mod.rs");
                return module.is_file().then_some((name, module));
            }
            if path.extension().is_some_and(|ext| ext == "rs") {
                // A module with files of its own keeps them beside a
                // `mod.rs`: declared by path, `<name>.rs` would look for them
                // in this directory.
                assert!(
                    !dir.join(&name).is_dir(),
                    "move scenario/e2e/{name}.rs to scenario/e2e/{name}/mod.rs"
                );
                return Some((name, path));
            }
            None
        })
        .collect();
    files.sort();
    let mut mods = String::new();
    let mut entries = String::new();
    let mut list = Vec::new();
    for (name, path) in &files {
        let source = fs::read_to_string(path).expect("an e2e module reads");
        let path = path.canonicalize().unwrap_or_else(|_| path.clone());
        mods.push_str(&format!(
            "#[path = {:?}]\nmod {name};\n",
            path.display().to_string()
        ));
        if !source
            .lines()
            .any(|line| line.trim_start().starts_with("pub(super) const MODULE:"))
        {
            continue;
        }
        let condition = source.lines().find_map(|line| {
            line.trim()
                .strip_prefix("#![cfg(")
                .and_then(|rest| rest.strip_suffix(")]"))
                .map(str::to_string)
        });
        let constant = format!("REGISTERED_{}", name.to_uppercase());
        let entry = |module: &str| {
            format!(
                "const {constant}: registry::Registered = registry::Registered {{ name: {name:?}, module: {module} }};\n"
            )
        };
        match condition {
            Some(condition) => {
                entries.push_str(&format!("#[cfg({condition})]\n"));
                entries.push_str(&entry(&format!("Some(&{name}::MODULE)")));
                entries.push_str(&format!("#[cfg(not({condition}))]\n"));
                entries.push_str(&entry("None"));
            }
            None => entries.push_str(&entry(&format!("Some(&{name}::MODULE)"))),
        }
        list.push(constant);
    }
    let out = format!(
        "{mods}\n{entries}\n/// Every feature module of the scenario, by file name.\nconst REGISTERED: &[registry::Registered] = &[{}];\n",
        list.join(", ")
    );
    let target =
        PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR")).join("e2e_modules.rs");
    if fs::read_to_string(&target).ok().as_deref() != Some(out.as_str()) {
        fs::write(target, out).expect("the e2e module list is written");
    }
}

/// List the window's parts (`src/shell/parts.rs`): every module directly
/// under `src/shell/` that holds a `pub(super) const PART`, by file name.
/// The modules themselves are `shell.rs`'s, declared there as any other.
fn window_parts(manifest: &std::path::Path) {
    let dir = manifest.join("src/shell");
    println!("cargo::rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = fs::read_dir(&dir)
        .expect("src/shell holds the window")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .filter(|path| {
            fs::read_to_string(path).is_ok_and(|source| {
                source
                    .lines()
                    .any(|line| line.starts_with("pub(super) const PART:"))
            })
        })
        .filter_map(|path| Some(path.file_stem()?.to_str()?.to_string()))
        .collect();
    names.sort();
    let list: Vec<String> = names
        .iter()
        .map(|name| format!("&super::{name}::PART"))
        .collect();
    let out = format!(
        "/// Every window part, by file name.\npub(crate) const PARTS: &[&Part] = &[{}];\n",
        list.join(", ")
    );
    let target =
        PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR")).join("window_parts.rs");
    if fs::read_to_string(&target).ok().as_deref() != Some(out.as_str()) {
        fs::write(target, out).expect("the window parts list is written");
    }
}
