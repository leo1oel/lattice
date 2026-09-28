//! ZIP source packs: exporting for Overleaf/arXiv and importing an Overleaf
//! download as a new project.

use super::err;
use super::manifest::open;
use super::paths::available_path;
use crate::models::ProjectSnapshot;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

/// `zip -x` patterns left out of an export: app state, VCS, and build output.
const EXPORT_EXCLUDES: &[&str] = &[
    ".git/*",
    ".research/history/*",
    ".research/sessions/*",
    ".research/omp-sessions/*",
    ".research/omp-session-map/*",
    ".research/omp-runtime/*",
    ".research/checkpoints/*",
    ".research/cache/*",
    "*.aux",
    "*.log",
    "*.bbl",
    "*.blg",
    "*.fdb_latexmk",
    "*.fls",
    "*.out",
    "*.bcf",
    "*.run.xml",
    "*-SAVE-ERROR",
    "*.synctex.gz",
    "*.pdf",
];

/// Export the project as a ZIP suitable for Overleaf / arXiv source packs.
pub fn export_project_zip(root: &Path, zip_path: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(err)?;
    if !root.is_dir() {
        return Err("Open a project before exporting.".to_string());
    }
    if let Some(parent) = zip_path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    if zip_path.exists() {
        fs::remove_file(zip_path).map_err(err)?;
    }
    let mut command = Command::new("zip");
    command.current_dir(&root).args(["-r", "-q"]).arg(zip_path).arg(".");
    for pattern in EXPORT_EXCLUDES {
        command.args(["-x", pattern]);
    }
    let status = command.status().map_err(|error| format!("Could not run zip: {error}"))?;
    if !status.success() {
        let _ = fs::remove_file(zip_path);
        return Err("Could not create the ZIP archive.".to_string());
    }
    Ok(())
}

/// Extract an Overleaf (or similar) ZIP into `parent` and open it as a Lattice project.
pub fn import_project_zip(zip_path: &Path, parent: &Path) -> Result<ProjectSnapshot, String> {
    if !zip_path.is_file() {
        return Err("Choose a ZIP file to import.".to_string());
    }
    let parent = parent.canonicalize().map_err(err)?;
    if !parent.is_dir() {
        return Err("Choose a folder to extract the project into.".to_string());
    }
    let stem = zip_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("overleaf-project")
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>();
    let stem = if stem.is_empty() { "overleaf-project".to_string() } else { stem };
    let dest = available_path(&parent, &stem, false, &Default::default());
    fs::create_dir_all(&dest).map_err(err)?;
    let status = Command::new("unzip")
        .arg("-q")
        .arg(zip_path)
        .arg("-d")
        .arg(&dest)
        .status()
        .map_err(|error| format!("Could not run unzip: {error}"))?;
    if !status.success() {
        let _ = fs::remove_dir_all(&dest);
        return Err("Could not extract the ZIP archive.".to_string());
    }
    open(&unwrap_single_nested_folder(&dest)?)
}

/// Overleaf downloads often wrap everything in one top-level folder; open
/// that folder instead when nothing `.tex` sits beside it.
fn unwrap_single_nested_folder(root: &Path) -> Result<PathBuf, String> {
    let mut children = fs::read_dir(root)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && name != "__MACOSX"
        })
        .map(|entry| entry.path());
    if let (Some(only), None) = (children.next(), children.next()) {
        let has_tex_here = WalkDir::new(root)
            .max_depth(1)
            .into_iter()
            .filter_map(Result::ok)
            .any(|entry| entry.path().extension().is_some_and(|ext| ext == "tex"));
        if only.is_dir() && !has_tex_here {
            return Ok(only);
        }
    }
    Ok(root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    #[test]
    fn exports_project_zip_without_aux_files() {
        let fixture = Fixture::empty("export-zip");
        fixture.write("main.tex", "\\documentclass{article}\n");
        fixture.write("main.log", "noise\n");
        let exports = Fixture::empty("export-zip-destination");
        let zip_path = exports.path("nested/paper.zip");
        export_project_zip(&fixture.root, &zip_path).unwrap();
        let listing = Command::new("unzip").args(["-Z1"]).arg(&zip_path).output().unwrap();
        let names = String::from_utf8_lossy(&listing.stdout);
        assert!(names.contains("main.tex"));
        assert!(!names.contains("main.log"));
    }
}
