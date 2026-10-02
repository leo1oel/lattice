//! The local side of sync: which files take part, reading them, and the base
//! copies that serve as the common ancestor of a three-way merge.
//!
//! Hashes alone can only tell us *that* both sides changed a file, never how to
//! combine them. So alongside the hashes we keep a pristine copy of every text
//! file as it stood at the last sync; that copy is the common ancestor a real
//! line-level merge needs, which is what lets edits to different parts of the
//! same file land together instead of one side being pushed aside.

use super::link::{load_state, SyncState, STATE_DIR, STATE_FILE};
use super::review::HistoryFrom;
use crate::project_fs::ProjectDir;
use crate::util::err;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Above this, a file is left where it is and reported instead of synced.
///
/// Overleaf's own upload limit is 50 MB, and a sync holds every file in memory
/// at once, so a project someone dropped a dataset into would otherwise fail
/// slowly and opaquely — or exhaust memory before it got as far as failing.
pub(super) const MAX_SYNC_FILE_BYTES: u64 = 45 * 1024 * 1024;

/// LaTeX build artifacts that never sync in either direction.
const ARTIFACT_SUFFIXES: &[&str] = &[
    ".aux",
    ".bbl",
    ".bcf",
    ".blg",
    ".brf",
    ".dvi",
    ".fdb_latexmk",
    ".fls",
    ".idx",
    ".ilg",
    ".ind",
    ".log",
    ".out",
    ".run.xml",
    ".synctex",
    ".synctex.gz",
    ".toc",
    ".lof",
    ".lot",
    ".nav",
    ".snm",
    ".vrb",
    ".xdv",
];

/// Agent PDF rendering uses this local workspace for contact sheets and page
/// images: reproducible intermediates, not project assets.
pub(super) const TRANSIENT_PDF_RENDER_DIRECTORY: &str = "tmp/pdfs";

const BASE_DIR: &str = ".research/overleaf-base";

/// Lattice's own folders (state, versions, legacy agent config), never synced.
const APP_FOLDERS: [&str; 3] = [".research", ".git", ".omp"];

/// Marks the start of an unresolved conflict; also the guard that stops a file
/// full of markers from being uploaded to Overleaf.
pub(super) const CONFLICT_MARKER: &str = "<<<<<<<";

pub(super) use crate::util::sha256_hex;

// ---- What takes part ----------------------------------------------------------

pub(super) fn is_transient_pdf_render_path(path: &str) -> bool {
    path.strip_prefix(TRANSIENT_PDF_RENDER_DIRECTORY)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// The file name, lower-cased, without the `(busy)` suffix a compile that is
/// still running gives its half-written artifacts (`main.synctex(busy)`).
fn build_output_name(path: &str) -> String {
    let lower = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    lower.strip_suffix("(busy)").map(str::to_string).unwrap_or(lower)
}

fn is_build_artifact(name: &str) -> bool {
    ARTIFACT_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

/// latexmk saves a generated file under this suffix when it cannot trust the
/// result of a failed Biber or engine run. It is the same disposable artifact
/// as the underlying `.bbl`, `.bcf`, etc., not project source.
pub(super) fn is_latex_save_error_path(path: &str) -> bool {
    build_output_name(path).strip_suffix("-save-error").is_some_and(is_build_artifact)
}

/// Paths (forward-slash relative) that never participate in sync.
pub(super) fn is_excluded(path: &str) -> bool {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let name = build_output_name(path);
    // Legacy `.omp/` folders may hold MCP server config, whose `env` is where
    // someone puts an API key. Uploading it would hand that key to everyone on
    // the Overleaf project and write it into the project's history.
    let in_app_folder = APP_FOLDERS.iter().any(|dir| {
        path.strip_prefix(dir).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    });
    in_app_folder
        || is_transient_pdf_render_path(path)
        || path == ".gitignore"
        || file_name == ".DS_Store"
        // Conflict copies are ours, not the project's: uploading them puts a
        // duplicate of the paper in front of everyone on Overleaf, where it
        // competes with the real file.
        || is_conflict_copy(file_name)
        || is_latex_save_error_path(path)
        // A half-written `(busy)` artifact caught mid-compile would otherwise
        // live on Overleaf and in the project's history forever.
        || is_build_artifact(&name)
        // The compiled output pdf lives at the project root; figure pdfs live
        // in subdirectories and must sync.
        || (!path.contains('/') && name.ends_with(".pdf"))
}

/// A file this app set aside during a conflict, by the name it gave it.
///
/// Shared with the project module, which must never choose one of these as the
/// document to compile — they are byte-identical to the real file at the
/// moment they are made, so the mistake is invisible until an edit goes
/// missing from the PDF.
pub fn is_conflict_copy(file_name: &str) -> bool {
    file_name.contains(" (local conflict ")
}

pub(super) fn conflict_copy_name(path: &str, stamp: &str) -> String {
    let renamed = |file_name: &str| match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} (local conflict {stamp}).{ext}"),
        _ => format!("{file_name} (local conflict {stamp})"),
    };
    match path.rsplit_once('/') {
        Some((dir, file_name)) => format!("{dir}/{}", renamed(file_name)),
        None => renamed(path),
    }
}

pub(super) fn has_conflict_markers(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_ok_and(|text| text.contains(CONFLICT_MARKER))
}

pub(super) fn validate_inventory_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || path.contains('\\')
    {
        return Err(format!("Invalid authoritative inventory path: {path}"));
    }
    Ok(())
}

// ---- Local file IO ------------------------------------------------------------

/// `root` joined with a forward-slash relative path.
pub(super) fn disk_path(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |path, part| path.join(part))
}

fn relative_slash_path(root: &Path, path: &Path) -> Option<String> {
    let parts: Vec<String> = (path.strip_prefix(root).ok()?.components())
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

pub(super) fn write_local_file(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    ProjectDir::open(root)
        .and_then(|project| project.atomic_write(rel, bytes))
        .map_err(|error| format!("Could not write {rel}: {error}"))
}

/// Every syncable file in the project, and the paths left behind for being
/// too big to carry — reported so the caller can say so rather than let them
/// look synced.
pub(super) struct LocalFiles {
    pub files: BTreeMap<String, Vec<u8>>,
    pub oversized: Vec<String>,
}

/// Walk the project and load every syncable file (path → bytes).
pub(super) fn read_local_files(root: &Path) -> Result<LocalFiles, String> {
    let mut local = LocalFiles { files: BTreeMap::new(), oversized: Vec::new() };
    let walker = walkdir::WalkDir::new(root).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        e.depth() == 0
            || !(e.file_type().is_dir()
                && (APP_FOLDERS.contains(&name.as_ref())
                    || relative_slash_path(root, e.path())
                        .is_some_and(|path| is_transient_pdf_render_path(&path))))
    });
    for entry in walker {
        let entry = entry.map_err(err)?;
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(rel) = relative_slash_path(root, entry.path()) else {
            continue;
        };
        if is_excluded(&rel) {
            continue;
        }
        // Checked from the directory entry, before reading: the whole project
        // is held in memory at once during a sync, and a dataset or a raw
        // video dropped in the folder would take the app down with it. Overleaf
        // will not accept one either, so there is nothing to gain by trying.
        if entry.metadata().map(|meta| meta.len()).unwrap_or(0) > MAX_SYNC_FILE_BYTES {
            local.oversized.push(rel);
            continue;
        }
        let data = fs::read(entry.path()).map_err(|e| format!("Could not read {rel}: {e}"))?;
        local.files.insert(rel, data);
    }
    Ok(local)
}

/// Whether files outside the realtime channel have moved away from the last
/// full-sync baseline. This is intentionally only used for the one-time open
/// check: hashing the project on every remote-version poll would make the
/// supposedly cheap path expensive again.
pub(super) fn local_files_changed(
    root: &Path, state: &SyncState, live: &BTreeSet<String>,
) -> Result<bool, String> {
    let local = read_local_files(root)?.files;
    let tracked_count =
        state.files.keys().filter(|path| !is_excluded(path) && !live.contains(*path)).count();
    let local_count = local.keys().filter(|path| !live.contains(*path)).count();
    if tracked_count != local_count {
        return Ok(true);
    }
    Ok(local.iter().any(|(path, bytes)| {
        !live.contains(path)
            && state.files.get(path).is_none_or(|expected| expected != &sha256_hex(bytes))
    }))
}

// ---- Base copies and merging --------------------------------------------------

/// Only text we can meaningfully merge gets a base copy: merging is
/// line-based, and keeping shadow copies of figures would double the project
/// on disk for no benefit.
fn is_mergeable_text(rel: &str, bytes: &[u8]) -> bool {
    const TEXT_SUFFIXES: &[&str] = &[
        ".tex", ".bib", ".txt", ".md", ".html", ".cls", ".sty", ".bst", ".json", ".yml", ".yaml",
        ".csv", ".tikz", ".sty.txt", ".cfg", ".def", ".ltx",
    ];
    let lower = rel.to_ascii_lowercase();
    // Guard against anything that only looks textual by name.
    TEXT_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix))
        && !bytes.contains(&0)
        && std::str::from_utf8(bytes).is_ok()
}

fn base_copy_path(root: &Path, rel: &str) -> PathBuf {
    disk_path(root, &format!("{BASE_DIR}/{rel}"))
}

pub(super) fn read_base_copy(root: &Path, rel: &str) -> Option<String> {
    fs::read_to_string(base_copy_path(root, rel)).ok()
}

pub(super) fn write_base_copy(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    if !is_mergeable_text(rel, bytes) {
        remove_base_copy(root, rel);
        return Ok(());
    }
    let path = base_copy_path(root, rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    // The shadow tree is Lattice's bookkeeping, never the user's work, so keep
    // it out of the version timeline with a self-ignoring directory.
    let _ = fs::write(base_copy_path(root, ".gitignore"), "*\n");
    fs::write(&path, bytes).map_err(|e| format!("Could not record the sync base for {rel}: {e}"))
}

pub(super) fn remove_base_copy(root: &Path, rel: &str) {
    let _ = fs::remove_file(base_copy_path(root, rel));
}

#[derive(serde::Deserialize)]
pub struct RealtimeCheckpoint {
    pub text: String,
    pub version: i64,
}

/// Called only while the realtime owner holds the exclusive sync lease.
/// This is an OT-proven ancestor, not a save of the (possibly AI-edited) file.
pub fn checkpoint_realtime_text(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    validate_inventory_path(rel)?;
    let mut state = load_state(root)?;
    if !is_mergeable_text(rel, text.as_bytes()) {
        return Ok(());
    }
    // Write the copy first. A failure between these atomic writes leaves an
    // older hash and a genuine shared ancestor, never a new hash with old text.
    write_local_file(root, &format!("{BASE_DIR}/{rel}"), text.as_bytes())?;
    write_local_file(root, &format!("{BASE_DIR}/.gitignore"), b"*\n")?;
    state.files.insert(rel.to_string(), sha256_hex(text.as_bytes()));
    let now = chrono::Utc::now().timestamp_millis();
    state.own_writes.insert(rel.to_string(), HistoryFrom::Time(now));
    let body = serde_json::to_string_pretty(&state).map_err(err)? + "\n";
    write_local_file(root, &format!("{STATE_DIR}/{STATE_FILE}"), body.as_bytes())
}

/// Outcome of reconciling a file both sides changed.
pub(super) enum MergeOutcome {
    /// Combined cleanly; the bytes belong on disk *and* on Overleaf.
    Clean(Vec<u8>),
    /// Genuinely overlapping edits; the bytes carry conflict markers.
    Conflicted(Vec<u8>),
    /// No usable common ancestor (binary, or a file first seen this sync).
    Unmergeable,
}

pub(super) fn merge_three_way(root: &Path, rel: &str, remote: &[u8], local: &[u8]) -> MergeOutcome {
    if !is_mergeable_text(rel, remote) || !is_mergeable_text(rel, local) {
        return MergeOutcome::Unmergeable;
    }
    let (Some(base), Ok(ours), Ok(theirs)) =
        (read_base_copy(root, rel), std::str::from_utf8(local), std::str::from_utf8(remote))
    else {
        return MergeOutcome::Unmergeable;
    };
    match diffy::MergeOptions::new().merge(&base, ours, theirs) {
        Ok(merged) => MergeOutcome::Clean(merged.into_bytes()),
        Err(conflicted) => MergeOutcome::Conflicted(conflicted.into_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overleaf::link::load_state;
    use crate::overleaf::sync::plan_sync;
    use crate::overleaf::test_support::*;

    #[test]
    fn overleaf_exclusion_rules() {
        for (path, excluded) in [
            (".research/overleaf.json", true),
            // MCP server config: `env` is where an API key goes.
            (".omp/mcp.json", true),
            (".omp", true),
            (".git/HEAD", true),
            (".gitignore", true),
            ("sub/.DS_Store", true),
            ("main.aux", true),
            ("main.synctex.gz", true),
            ("main.pdf", true), // compiled output at root
            ("tmp/pdfs/full-appendix/render-1.png", true),
            ("tmp/pdfs", true),
            ("tmp/notes.tex", false),
            // Half-written files a sync can catch mid-compile.
            ("main.synctex(busy)", true),
            ("main.synctex.gz(busy)", true),
            ("nested/chapter.synctex", true),
            ("main.run.xml", true),
            ("main.bcf", true),
            ("lambda_gpu_proposal.bbl-SAVE-ERROR", true),
            // A source file whose name merely ends in "(busy)" is still source.
            ("notes(busy).tex", false),
            ("figures/fig1.pdf", false), // figure pdfs sync
            ("main.tex", false),
            ("nested/chapter.tex", false),
            // Conflict copies are ours to hold locally, never the project's.
            ("neurips_2026 (local conflict 20260724-1308).tex", true),
            ("nested/paper (local conflict 20260101-0900).tex", true),
        ] {
            assert_eq!(is_excluded(path), excluded, "{path}");
        }
        assert!(is_conflict_copy("paper (local conflict 20260101-0900).tex"));
        assert!(!is_conflict_copy("paper.tex"));
        assert!(!is_conflict_copy("local conflict notes.tex"));
    }

    #[test]
    fn realtime_checkpoint_keeps_agent_disk_edits_and_preserves_real_conflicts() {
        let base = b"Old ending.\n";
        let human = b"We hope people understand.\n";
        let agent = b"We hope our work helps people understand.\n";
        let root = linked_root(&[("main.tex", agent)], &[("main.tex", base)]);
        let local = BTreeMap::from([("main.tex".to_string(), agent.to_vec())]);
        let remote = BTreeMap::from([("main.tex".to_string(), human.to_vec())]);
        let plan = |state: &SyncState, remote: &BTreeMap<String, Vec<u8>>| {
            plan_sync(&root, state, remote, &local, &BTreeSet::new(), "test").unwrap()
        };
        edit_state(&root, |state| state.remote_version = Some(91));
        let before = load_state(&root).unwrap();
        assert_eq!(plan(&before, &remote).conflict.len(), 1);

        checkpoint_realtime_text(&root, "main.tex", std::str::from_utf8(human).unwrap()).unwrap();
        let after = load_state(&root).unwrap();
        assert_eq!(
            (&after.last_sync, after.remote_version),
            (&before.last_sync, before.remote_version)
        );
        assert_eq!(fs::read(root.join("main.tex")).unwrap(), agent);
        assert_eq!(read_base_copy(&root, "main.tex").unwrap().as_bytes(), human);
        assert_eq!(after.files["main.tex"], sha256_hex(human));
        let resolved = plan(&after, &remote);
        assert!(resolved.conflict.is_empty());
        assert_eq!(resolved.push, vec!["main.tex"]);
        let peer =
            BTreeMap::from([("main.tex".to_string(), b"A peer replaced the ending.\n".to_vec())]);
        assert_eq!(plan(&after, &peer).conflict.len(), 1);
    }

    #[test]
    fn local_open_check_detects_offline_changes_but_ignores_live_documents() {
        let base = b"shared body".as_slice();
        let root = linked_root(&[("main.tex", base)], &[("main.tex", base)]);
        let state = load_state(&root).unwrap();
        let changed = |live: &[&str]| {
            let live = live.iter().map(|path| path.to_string()).collect();
            local_files_changed(&root, &state, &live).unwrap()
        };

        assert!(!changed(&[]));
        fs::write(root.join("main.tex"), b"edited while Lattice was closed").unwrap();
        assert!(changed(&[]));
        assert!(!changed(&["main.tex"]));

        fs::write(root.join("main.tex"), base).unwrap();
        fs::write(root.join("new.tex"), b"new offline file").unwrap();
        assert!(changed(&[]));
        fs::remove_file(root.join("new.tex")).unwrap();
        fs::remove_file(root.join("main.tex")).unwrap();
        assert!(changed(&[]));
    }
}
