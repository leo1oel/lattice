//! Gather the catalog of the strings only the GPUI app shows from
//! `locales/zh-CN/*.po`, one file per area of the app (`shell.po`,
//! `overleaf.po`, ...), so features adding their strings in the same week
//! write to different files, or to different places in one: each file keeps
//! its entries sorted by source string (`src/lib.rs` tests it). A new area's
//! file is picked up without a list kept by hand.

use std::{env, fs, path::PathBuf};

fn main() {
    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets the manifest dir"));
    let dir = manifest.join("locales/zh-CN");
    println!("cargo::rerun-if-changed={}", dir.display());
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("locales/zh-CN holds the GPUI app's catalogs")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "po"))
        .collect();
    files.sort();
    let mut catalog = String::from("pub const GPUI_CATALOG: &str = concat!(\n");
    let mut list = String::from("pub const GPUI_CATALOG_FILES: &[(&str, &str)] = &[\n");
    for file in &files {
        let path = file.canonicalize().unwrap_or_else(|_| file.clone());
        let path = path.display().to_string();
        let name = file.file_name().unwrap_or_default().to_string_lossy();
        // A blank line between files, so one's last entry never runs into
        // the next one's first.
        catalog.push_str(&format!("    include_str!({path:?}),\n    \"\\n\",\n"));
        list.push_str(&format!("    ({name:?}, include_str!({path:?})),\n"));
    }
    catalog.push_str(");\n");
    list.push_str("];\n");
    let target =
        PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR")).join("gpui_catalog.rs");
    fs::write(target, catalog + &list).expect("the GPUI catalog is written");
}
