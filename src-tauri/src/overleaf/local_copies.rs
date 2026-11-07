//! Which folders on this Mac are linked to which Overleaf project, so "Open
//! from Overleaf" opens the copy that is already here instead of downloading a
//! second one beside it. Two copies of one project both sync, drift apart, and
//! leave the writer guessing which one holds their latest edits.
//!
//! The link itself lives in each folder (`.research/overleaf.json`) and stays
//! the only truth. This module keeps a small app-level list of folders known to
//! have held one — every clone, adopt, publish, and every open of a linked
//! project adds to it — and answers a lookup by reading each candidate's own
//! link, so a folder that was deleted, moved or unlinked since simply stops
//! answering for the project, and is dropped from the list.

use super::account::read_session;
use super::api::sync_host;
use super::link::load_state;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const INDEX_FILE: &str = "overleaf-local-copies.json";
/// Plenty for anyone's projects, and a bound on what one lookup reads.
const MAX_FOLDERS: usize = 200;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    /// Most recently linked or opened first.
    folders: Vec<PathBuf>,
}

/// A folder already linked to an Overleaf project.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCopy {
    /// Canonical, as `open_project` binds it, so the app can tell whether a
    /// window already shows it.
    pub path: String,
    /// The path for people to read, with the home folder as `~`.
    pub display: String,
}

fn index_path(config_dir: &Path) -> PathBuf {
    config_dir.join(INDEX_FILE)
}

fn read_index(config_dir: &Path) -> Index {
    // A missing or damaged list only costs a download, never a wrong answer:
    // every entry is checked against the folder's own link before use.
    (fs::read_to_string(index_path(config_dir)).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_index(config_dir: &Path, index: &Index) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    let body = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    // Written beside and renamed into place, so a reader in another window
    // never sees half a list.
    let temporary = config_dir.join(format!(".{INDEX_FILE}.tmp"));
    fs::write(&temporary, body + "\n").map_err(|error| error.to_string())?;
    fs::rename(&temporary, index_path(config_dir)).map_err(|error| error.to_string())
}

/// Note that `root` holds a linked project. Best effort: the list is a hint,
/// so failing to write it must never fail the clone, publish or open that
/// called this.
pub fn remember_local_copy(config_dir: &Path, root: &Path) {
    let Ok(root) = root.canonicalize() else { return };
    let mut index = read_index(config_dir);
    if index.folders.first() == Some(&root) {
        return;
    }
    index.folders.retain(|folder| folder != &root);
    index.folders.insert(0, root);
    index.folders.truncate(MAX_FOLDERS);
    if let Err(error) = write_index(config_dir, &index) {
        log::warn!("Could not record a linked Overleaf folder: {error}");
    }
}

fn display_path(path: &Path) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match home.as_deref().and_then(|home| path.strip_prefix(home).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// The local copy of each project that has one, by project id.
///
/// `candidates` are folders the caller also knows of (recent projects, the
/// default download folder of each listed project), checked before the
/// remembered list. The first folder that is linked to a project on the
/// signed-in host answers for it. Remembered folders that no longer hold a
/// link are dropped from the list.
pub fn local_copies(config_dir: &Path, candidates: &[PathBuf]) -> BTreeMap<String, LocalCopy> {
    let session = read_session(config_dir).ok();
    let index = read_index(config_dir);
    let mut found = BTreeMap::new();
    let mut seen = Vec::new();
    let mut stale = Vec::new();
    let remembered = index.folders.iter().map(|folder| (folder, true));
    for (folder, from_index) in candidates.iter().map(|folder| (folder, false)).chain(remembered) {
        let Ok(root) = folder.canonicalize() else {
            if from_index {
                stale.push(folder.clone());
            }
            continue;
        };
        if seen.contains(&root) {
            continue;
        }
        seen.push(root.clone());
        let Ok(state) = load_state(&root) else {
            if from_index {
                stale.push(folder.clone());
            }
            continue;
        };
        // A project id names a project on one Overleaf host; a folder linked
        // to another host is not this account's copy of it.
        if session.as_ref().is_some_and(|session| sync_host(&state, session).is_err()) {
            continue;
        }
        found.entry(state.project_id).or_insert_with(|| LocalCopy {
            path: root.to_string_lossy().into_owned(),
            display: display_path(&root),
        });
    }
    if !stale.is_empty() {
        let mut index = index;
        index.folders.retain(|folder| !stale.contains(folder));
        if let Err(error) = write_index(config_dir, &index) {
            log::warn!("Could not tidy the linked Overleaf folders: {error}");
        }
    }
    found
}

#[cfg(test)]
mod tests;
