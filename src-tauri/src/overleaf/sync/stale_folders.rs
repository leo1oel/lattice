//! Folders Overleaf no longer has, cleared here after a sync (issue #840).
//!
//! A sync compares files, so a folder deleted or renamed on Overleaf only
//! loses the synced files inside it. What Lattice itself left there stayed:
//! the outputs a build wrote beside the sources, the subfolders the deletions
//! emptied, and the same skeleton of folders in the merge-base tree. The file
//! tree kept showing folders co-authors no longer see, a few more after every
//! reorganisation on Overleaf.
//!
//! So after each sync, every folder here that holds no file the sync agrees
//! on, none Overleaf has, and none it holds or left for the next sync is
//! weighed. Only one that held synced files once (the agreed table this sync
//! started from named a file in it, or the merge-base tree still has the
//! folder) is Overleaf's to clear; any other, empty or not, is the writer's
//! (a folder just made, an external build's output folder) and stays.
//!
//! In a folder that is cleared, only what a build of its documents wrote
//! goes: a file a build record there lists as written (a TeX recorder's
//! `.fls`, latexmk's `.fdb_latexmk`), or one named for a `.tex` that synced
//! beside it (`main.aux` for `main.tex`). A name alone proves nothing: the
//! writer's `train.log` or `slurm-4821.out` is no build's. Then every folder
//! left empty goes, deepest first, with a Finder `.DS_Store` that is all one
//! still holds. Anything else in it is the writer's (a conflict copy, a file
//! too large to sync) and stays, with its folders, and the result names it
//! once.

use crate::overleaf::files::{
    disk_path, is_build_output_of, is_transient_pdf_render_path, BuildPdf, APP_FOLDERS, BASE_DIR,
};
use crate::{latex, wide_event};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// A folder Overleaf no longer has that stays here for the files in it that
/// never sync, which a sync must not delete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptFolder {
    pub folder: String,
    pub files: Vec<String>,
}

/// Every folder above each of `paths`, folded to lower case: the disk may
/// ignore case, so a folder spelled otherwise here is still the same one.
fn folders_above<'a>(paths: impl IntoIterator<Item = &'a String>) -> BTreeSet<String> {
    let mut folders = BTreeSet::new();
    for path in paths {
        let lower = path.to_lowercase();
        let mut at = lower.as_str();
        while let Some((folder, _)) = at.rsplit_once('/') {
            if !folders.insert(folder.to_string()) {
                break;
            }
            at = folder;
        }
    }
    folders
}

/// Each folder of the merge-base tree, folded to lower case, relative to it.
fn base_folders(root: &Path) -> BTreeSet<String> {
    let base = disk_path(root, BASE_DIR);
    let walker = walkdir::WalkDir::new(&base).min_depth(1).into_iter().filter_map(Result::ok);
    (walker.filter(|entry| entry.file_type().is_dir()))
        .filter_map(|entry| relative(&base, entry.path()))
        .map(|path| path.to_lowercase())
        .collect()
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let parts: Vec<String> = (path.strip_prefix(root).ok()?.components())
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Whether the sync never looks inside the folder at `rel`, `name`: Lattice's
/// own state and version folders, and the agent's PDF renders.
fn never_synced_folder(rel: &str, name: &str) -> bool {
    APP_FOLDERS.contains(&name) || is_transient_pdf_render_path(rel)
}

/// What a folder holds, everything under it included, Finder's `.DS_Store`
/// aside.
#[derive(Default)]
struct Contents {
    /// Files a build wrote, which Lattice may delete.
    disposable: Vec<String>,
    /// Everything else: the writer's.
    kept: Vec<String>,
    /// Its folders, deepest first.
    folders: Vec<String>,
}

/// Who wrote what: `synced` holds the agreed table's paths, lower-cased.
struct Evidence<'a> {
    build_pdf: BuildPdf,
    synced: &'a BTreeSet<String>,
}

fn contents(root: &Path, folder: &str, evidence: &Evidence) -> Contents {
    let mut found = Contents::default();
    let mut files = Vec::new();
    // Nothing inside an app folder is weighed: it is never Lattice's to drop.
    let mut app_folders = Vec::new();
    let walker = walkdir::WalkDir::new(disk_path(root, folder)).contents_first(true);
    let walker = walker.into_iter().filter_entry(|entry| {
        let rel = relative(root, entry.path()).unwrap_or_default();
        let name = entry.file_name().to_string_lossy();
        let app = entry.file_type().is_dir() && never_synced_folder(&rel, &name);
        if app {
            app_folders.push(rel);
        }
        !app
    });
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            // Unreadable: the folder cannot be known empty, so it stays.
            Err(error) => {
                let at = error.path().and_then(|path| relative(root, path));
                found.kept.push(at.unwrap_or_else(|| folder.to_string()));
                continue;
            }
        };
        let Some(rel) = relative(root, entry.path()) else { continue };
        let kind = entry.file_type();
        if kind.is_dir() {
            found.folders.push(rel);
        } else if kind.is_file() && entry.file_name() == ".DS_Store" {
            // Finder's: it goes only with a folder otherwise emptied.
        } else if kind.is_file() {
            files.push(rel);
        } else {
            found.kept.push(rel);
        }
    }
    let written = written_by_records(root, &files);
    let synced_source = |source: &str| evidence.synced.contains(&source.to_lowercase());
    for file in files {
        if written.contains(&file.to_lowercase())
            || evidence.build_pdf.is(&file)
            || is_build_output_of(&file, synced_source)
        {
            found.disposable.push(file);
        } else {
            found.kept.push(file);
        }
    }
    found.kept.extend(app_folders);
    found.kept.sort();
    found
}

/// The files the build records among `files` list as written, lower-cased:
/// each TeX recorder's (`.fls`) outputs, and what latexmk's database
/// (`.fdb_latexmk`) lists as generated, BibTeX's too, which TeX never
/// writes. A record that lists any is a build's own, and is among them.
fn written_by_records(root: &Path, files: &[String]) -> BTreeSet<String> {
    let mut written = BTreeSet::new();
    for file in files {
        let lower = file.to_lowercase();
        let listed = if lower.ends_with(".fls") {
            latex::written_by_recorder(root, &disk_path(root, file))
        } else if lower.ends_with(".fdb_latexmk") {
            generated(file, &fs::read_to_string(disk_path(root, file)).unwrap_or_default())
        } else {
            continue;
        };
        if !listed.is_empty() {
            written.insert(lower);
        }
        written.extend(listed.iter().map(|path| path.to_lowercase()));
    }
    written
}

/// The files latexmk's database at `record`, reading `text`, lists as
/// generated. latexmk names them from the folder it ran in, the document's
/// own (`-cd`), so a name that leaves that folder is not followed.
fn generated(record: &str, text: &str) -> Vec<String> {
    let folder = record.rsplit_once('/').map_or(String::new(), |(folder, _)| format!("{folder}/"));
    let mut listing = false;
    let mut found = Vec::new();
    for line in text.lines() {
        let item = line.trim();
        if item.starts_with('(') {
            listing = item == "(generated)";
        } else if !line.starts_with(char::is_whitespace) {
            listing = false;
        } else if let Some(name) = item.strip_prefix('"').and_then(|item| item.strip_suffix('"')) {
            let parts: Vec<&str> = name.split('/').filter(|part| *part != ".").collect();
            let inside = !name.starts_with('/')
                && !parts.iter().any(|part| part.is_empty() || *part == "..");
            if listing && inside {
                found.push(format!("{folder}{}", parts.join("/")));
            }
        }
    }
    found
}

/// Remove `folder` if it is empty, or holds Finder's `.DS_Store` alone.
fn remove_emptied(folder: &Path) {
    if fs::remove_dir(folder).is_ok() {
        return;
    }
    let left: Vec<_> = fs::read_dir(folder)
        .map(|entries| entries.filter_map(|entry| Some(entry.ok()?.file_name())).collect())
        .unwrap_or_default();
    if left.len() == 1
        && left[0] == ".DS_Store"
        && fs::remove_file(folder.join(".DS_Store")).is_ok()
    {
        let _ = fs::remove_dir(folder);
    }
}

/// Clear each folder here Overleaf no longer has, as the module note says.
///
/// `kept` is every path the sync leaves in place for Overleaf's sake: the
/// agreed table it saved, Overleaf's copy, and whatever it set aside, held,
/// kept from going up, or found edited meanwhile. `synced_before` is the
/// agreed table it started from: the folders once synced, and the documents
/// whose build outputs are known by name. Read before the empty folders of the merge-base tree are pruned,
/// which this does too; best effort throughout, since a folder left behind
/// costs nothing a later sync cannot clear.
pub(super) fn clear<'a>(
    root: &Path, kept: impl IntoIterator<Item = &'a String>, synced_before: &BTreeSet<String>,
) -> Vec<KeptFolder> {
    let occupied = folders_above(kept);
    let mut once_synced = folders_above(synced_before);
    once_synced.extend(base_folders(root));
    let synced: BTreeSet<String> = synced_before.iter().map(|path| path.to_lowercase()).collect();
    let evidence = Evidence { build_pdf: BuildPdf::of(root), synced: &synced };

    let mut stale = Vec::new();
    let mut walker = walkdir::WalkDir::new(root).min_depth(1).into_iter();
    while let Some(entry) = walker.next() {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_dir() {
            continue;
        }
        let Some(rel) = relative(root, entry.path()) else { continue };
        let name = entry.file_name().to_string_lossy();
        if never_synced_folder(&rel, &name) {
            walker.skip_current_dir();
        } else if !occupied.contains(&rel.to_lowercase()) {
            if once_synced.contains(&rel.to_lowercase()) {
                stale.push(rel);
            }
            walker.skip_current_dir();
        }
    }

    let (mut cleared, mut reported) = (0, Vec::new());
    for folder in stale {
        let found = contents(root, &folder, &evidence);
        for file in &found.disposable {
            let _ = fs::remove_file(disk_path(root, file));
        }
        // A folder still holding something refuses, and stays.
        for emptied in &found.folders {
            remove_emptied(&disk_path(root, emptied));
        }
        if disk_path(root, &folder).symlink_metadata().is_err() {
            cleared += 1;
        } else if !found.kept.is_empty() {
            reported.push(KeptFolder { folder, files: found.kept });
        }
    }
    prune_empty_base_folders(root);
    if cleared > 0 {
        wide_event::record("stale_folders_cleared", cleared);
    }
    reported
}

/// The merge-base tree only ever holds files: a folder left empty there is
/// the skeleton of one deleted or renamed, and goes.
fn prune_empty_base_folders(root: &Path) {
    let base = disk_path(root, BASE_DIR);
    let walker = walkdir::WalkDir::new(&base).min_depth(1).contents_first(true);
    for entry in walker.into_iter().filter_map(Result::ok) {
        if entry.file_type().is_dir() {
            let _ = fs::remove_dir(entry.path());
        }
    }
}
