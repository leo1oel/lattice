//! What the Project tree remembers between runs, as the Tauri app keeps it
//! in its storage: each project's open folders
//! (`lattice:expanded-directories:<root>`, `project-file-tree.tsx`) and
//! whether hidden files are shown, one choice for every project
//! (`lattice:show-hidden-files`, `project-tree-files.ts`).
//!
//! One JSON file in the app's state directory, written whole beside itself
//! and moved over it. `LATTICE_GPUI_STATE_DIR` names another directory (empty
//! for none); a scripted run keeps everything in memory, so a scenario starts
//! from the defaults and leaves the writer's choices alone.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};

use crate::shell::workspaces::write_json;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Memory {
    #[serde(default)]
    show_hidden: bool,
    /// Each project's open folders, project-relative.
    #[serde(default)]
    expanded: BTreeMap<PathBuf, BTreeSet<String>>,
}

struct Store {
    file: Option<PathBuf>,
    memory: Memory,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        let scripted = std::env::args().any(|arg| arg == "--scenario");
        let file = crate::shell::workspaces::state_dir(scripted).map(|dir| dir.join(FILE));
        let memory = file.as_deref().and_then(read).unwrap_or_default();
        Mutex::new(Store { file, memory })
    })
}

const FILE: &str = "project-tree.json";

fn read(file: &Path) -> Option<Memory> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

fn update(change: impl FnOnce(&mut Memory)) {
    let Ok(mut store) = store().lock() else {
        return;
    };
    let before = store.memory.clone();
    change(&mut store.memory);
    if store.memory == before {
        return;
    }
    if let Some(file) = store.file.clone()
        && let Err(error) = write_json(&file, &store.memory)
    {
        log::warn!("could not save the Project tree's state: {error:#}");
    }
}

/// Whether the tree shows hidden files, in every project.
pub fn show_hidden() -> bool {
    store().lock().is_ok_and(|store| store.memory.show_hidden)
}

pub fn set_show_hidden(show: bool) {
    update(|memory| memory.show_hidden = show);
}

/// The folders open in `root`'s tree when it was last shown.
pub fn expanded(root: &Path) -> BTreeSet<String> {
    store()
        .lock()
        .ok()
        .and_then(|store| store.memory.expanded.get(root).cloned())
        .unwrap_or_default()
}

pub fn set_expanded(root: &Path, folders: BTreeSet<String>) {
    update(|memory| {
        if folders.is_empty() {
            memory.expanded.remove(root);
        } else {
            memory.expanded.insert(root.to_path_buf(), folders);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_partial_file_reads_as_nothing_open_and_nothing_hidden_shown() {
        let empty: Memory = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Memory::default());
        let read_back: Memory = serde_json::from_str(
            r#"{ "showHidden": true, "expanded": { "/papers/a": ["chapters", "figures"] } }"#,
        )
        .unwrap();
        assert!(read_back.show_hidden);
        assert_eq!(
            read_back.expanded[Path::new("/papers/a")],
            BTreeSet::from(["chapters".to_string(), "figures".to_string()])
        );
    }
}
