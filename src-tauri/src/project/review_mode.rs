//! Review mode's bases (`.research/review/`): the text each of the paper's
//! files is reviewed against, so the writer's edits since can be shown as
//! tracked changes (src/history/review-mode-*.ts) and marked in the PDF
//! (`latex::review_changes_pdf`).
//!
//! The writer's files keep their edits, as a document in Word does with
//! Track Changes on; the bases are copies under `base/`, mirroring the
//! project's paths. Turning review mode on copies every `.tex` and `.bib` in;
//! accepting a change rewrites one copy; turning it off deletes the folder
//! and touches nothing else. `review.json` says review mode is on, and when
//! it was turned on: a base written after it was turned off (a save still on
//! its way) is refused rather than turning it back on.

use super::paths::{relative_to, validate_transaction_path};
use crate::util::err;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub const REVIEW_DIRECTORY: &str = ".research/review";
const BASE_DIRECTORY: &str = ".research/review/base";
const STATE_PATH: &str = ".research/review/review.json";
/// A file bigger than this is generated (a data table), not written; it is left out of review.
const LARGEST_REVIEWED_FILE: u64 = 4 * 1024 * 1024;

const REVIEW_OFF: &str = "Review mode is off in this project.";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewState {
    started_at: String,
}

/// Review mode as a project has it: when it was turned on, and each file's base by path.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBases {
    pub started_at: String,
    pub bases: BTreeMap<String, String>,
}

/// The files review mode tracks: the paper's LaTeX and its bibliography.
pub fn is_reviewable_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".tex") || lower.ends_with(".bib")
}

/// Where the bases are, mirroring the project's own paths.
pub fn review_base_directory(root: &Path) -> PathBuf {
    root.join(BASE_DIRECTORY)
}

fn read_state(root: &Path) -> Result<Option<ReviewState>, String> {
    match fs::read_to_string(root.join(STATE_PATH)) {
        Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(err),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(err(error)),
    }
}

/// Every reviewable file under `directory` (eight levels deep), by path
/// relative to it; `skip_research` leaves out Lattice's own folder.
fn reviewable_files(
    directory: &Path, skip_research: bool,
) -> Result<BTreeMap<String, String>, String> {
    let mut files = BTreeMap::new();
    if !directory.is_dir() {
        return Ok(files);
    }
    let entries = WalkDir::new(directory).max_depth(8).into_iter().filter_entry(|entry| {
        !(skip_research && entry.depth() == 1 && entry.file_name() == ".research")
            && !(entry.depth() > 0 && entry.file_type().is_dir() && entry.file_name() == ".git")
    });
    for entry in entries.filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = relative_to(directory, entry.path())?;
        if !is_reviewable_path(&relative)
            || entry.metadata().map_or(true, |metadata| metadata.len() > LARGEST_REVIEWED_FILE)
        {
            continue;
        }
        // A file that is not text (a stray binary named .tex) has no changes to show.
        if let Ok(text) = fs::read_to_string(entry.path()) {
            files.insert(relative, text);
        }
    }
    Ok(files)
}

/// The project's review mode, or `None` while it is off.
pub fn load_review(root: &Path) -> Result<Option<ReviewBases>, String> {
    let Some(state) = read_state(root)? else { return Ok(None) };
    let bases = reviewable_files(&review_base_directory(root), false)?;
    Ok(Some(ReviewBases { started_at: state.started_at, bases }))
}

/// Turn review mode on: every reviewable file as it is on disk becomes its base.
pub fn start_review(root: &Path) -> Result<ReviewBases, String> {
    stop_review(root)?;
    let bases = reviewable_files(root, true)?;
    let directory = review_base_directory(root);
    for (path, text) in &bases {
        write_file(&directory.join(path), text)?;
    }
    let state = ReviewState { started_at: Utc::now().to_rfc3339() };
    let raw = serde_json::to_string_pretty(&state).map_err(err)?;
    write_file(&root.join(STATE_PATH), &format!("{raw}\n"))?;
    Ok(ReviewBases { started_at: state.started_at, bases })
}

/// Keep `base` as `path`'s base: an accept, or a co-author's edit carried into it.
pub fn save_review_base(root: &Path, path: &str, base: &str) -> Result<(), String> {
    validate_transaction_path(path)?;
    if !is_reviewable_path(path) || path.starts_with(".research/") {
        return Err(format!("{path} is not a file review mode tracks."));
    }
    if read_state(root)?.is_none() {
        return Err(REVIEW_OFF.to_string());
    }
    write_file(&review_base_directory(root).join(path), base)
}

/// Turn review mode off: the bases, and the PDF with changes marked, are deleted.
pub fn stop_review(root: &Path) -> Result<(), String> {
    match fs::remove_dir_all(root.join(REVIEW_DIRECTORY)) {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(err(error)),
        _ => Ok(()),
    }
}

/// Written whole beside itself and renamed over, so a base is never half there.
fn write_file(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let temporary = path.with_extension(format!("lattice-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, text).map_err(err)?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        err(error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn turning_review_on_copies_the_paper_s_files_and_nothing_else() {
        let root = TempDir::new("review-start");
        root.write("main.tex", "Hello.\n");
        root.write("chapters/intro.tex", "Intro.\n");
        root.write("refs.bib", "@article{a}\n");
        root.write("figure.pdf", "%PDF");
        root.write(".research/annotations.json", "{}");
        assert!(load_review(&root).unwrap().is_none());

        let started = start_review(&root).unwrap();
        assert_eq!(
            started.bases.keys().collect::<Vec<_>>(),
            ["chapters/intro.tex", "main.tex", "refs.bib"]
        );
        // The writer's files are left as they were.
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "Hello.\n");

        let loaded = load_review(&root).unwrap().unwrap();
        assert_eq!(loaded.started_at, started.started_at);
        assert_eq!(loaded.bases.get("chapters/intro.tex").map(String::as_str), Some("Intro.\n"));
    }

    #[test]
    fn an_accept_rewrites_one_base_and_turning_off_deletes_them_all() {
        let root = TempDir::new("review-save");
        root.write("main.tex", "Hello.\n");
        start_review(&root).unwrap();
        save_review_base(&root, "main.tex", "Hello, world.\n").unwrap();
        assert_eq!(load_review(&root).unwrap().unwrap().bases["main.tex"], "Hello, world.\n");
        assert!(save_review_base(&root, "../outside.tex", "x").is_err());
        assert!(save_review_base(&root, "figure.pdf", "x").is_err());

        stop_review(&root).unwrap();
        assert!(!root.join(REVIEW_DIRECTORY).exists());
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "Hello.\n");
        // A save still on its way once review mode is off does not turn it back on.
        assert_eq!(save_review_base(&root, "main.tex", "late").unwrap_err(), REVIEW_OFF);
        assert!(load_review(&root).unwrap().is_none());
    }
}
