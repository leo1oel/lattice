//! The column widths a Markdown file's tables were given in its visual
//! editor (a column border dragged or double-clicked there,
//! `table-column-widths.ts` in the engine), kept across launches and never
//! in the file: per project, by the file's project-relative path, and by the
//! table's index among the file's tables, the file touched last kept newest,
//! as many files as [`MAX_FILES`].
//!
//! The page hands each change over (`md:table-widths`) and is given the
//! file's widths when it opens it (`doc:open`'s `tableWidths`); it drops a
//! table's widths itself once their count is not the table's column count.
//! A rename or move, of the file or a folder holding it, carries its widths
//! to the new path, as the editors' places go (`editor_panel/place_memory.rs`).
//!
//! One JSON file in the app's state directory (`markdown-table-widths.json`),
//! beside the editors' places, written 250 ms after the last change or as an
//! editor closes or the app quits; a scripted run keeps them in memory unless
//! `LATTICE_GPUI_STATE_DIR` names a directory.

use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::place_memory::{state_dir, write_json};

/// How many files' widths a project keeps.
pub const MAX_FILES: usize = 200;

/// The most columns a table's widths are kept for.
const MAX_COLUMNS: usize = 256;

const WRITE_AFTER: Duration = Duration::from_millis(250);

/// One file's tables' widths in CSS pixels, by table index.
pub type FileWidths = BTreeMap<u32, Vec<f32>>;

/// Every project's files' table widths, by project-relative path, the most
/// recent last.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TableWidths(BTreeMap<PathBuf, IndexMap<String, FileWidths>>);

impl TableWidths {
    pub fn of(&self, root: &Path, file: &str) -> Option<&FileWidths> {
        self.0.get(root)?.get(file)
    }

    /// Keep `widths` as table `table`'s of `file`, or drop them (`None`);
    /// the file becomes the newest, and the oldest goes past [`MAX_FILES`].
    /// Widths that are not each a positive finite width are refused.
    /// Whether anything changed.
    pub fn set(&mut self, root: &Path, file: &str, table: u32, widths: Option<Vec<f32>>) -> bool {
        if widths.as_ref().is_some_and(|widths| {
            widths.is_empty()
                || widths.len() > MAX_COLUMNS
                || widths
                    .iter()
                    .any(|width| !width.is_finite() || *width <= 0.)
        }) {
            return false;
        }
        let files = self.0.entry(root.to_path_buf()).or_default();
        let mut tables = files.shift_remove(file).unwrap_or_default();
        let changed = match widths {
            Some(widths) => tables.insert(table, widths.clone()) != Some(widths),
            None => tables.remove(&table).is_some(),
        };
        if !tables.is_empty() {
            files.insert(file.to_string(), tables);
        }
        while files.len() > MAX_FILES {
            files.shift_remove_index(0);
        }
        if files.is_empty() {
            self.0.remove(root);
        }
        changed
    }

    /// Files of `root` were renamed or moved, each to where `moved` says it
    /// went (`None` for one that stayed): their widths go with them, as
    /// recent as they were, over any left at the new path. Whether anything
    /// changed.
    pub fn remap(&mut self, root: &Path, moved: impl Fn(&str) -> Option<String>) -> bool {
        let Some(files) = self.0.get_mut(root) else {
            return false;
        };
        let moves: Vec<_> = files.keys().map(|file| moved(file)).collect();
        if moves.iter().all(Option::is_none) {
            return false;
        }
        let arrived: HashSet<String> = moves.iter().flatten().cloned().collect();
        *files = std::mem::take(files)
            .into_iter()
            .zip(moves)
            .filter_map(|((file, widths), to)| match to {
                Some(to) => Some((to, widths)),
                None => (!arrived.contains(&file)).then_some((file, widths)),
            })
            .collect();
        true
    }
}

struct Store {
    file: Option<PathBuf>,
    widths: TableWidths,
    unwritten: bool,
    changes: u64,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        let file = state_dir().map(|dir| dir.join("markdown-table-widths.json"));
        let widths = file
            .as_deref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Mutex::new(Store {
            file,
            widths,
            unwritten: false,
            changes: 0,
        })
    })
}

/// `file`'s tables' widths as the page reads them: an object by table index.
pub fn page_widths(root: &Path, file: &str) -> Value {
    store()
        .lock()
        .ok()
        .and_then(|store| store.widths.of(root, file).map(|widths| json!(widths)))
        .unwrap_or_else(|| json!({}))
}

/// The page's `md:table-widths`: `{ table, widths }`, widths null to drop.
pub fn page_changed(root: &Path, file: &str, payload: &Value, cx: &mut gpui::App) {
    let Some(table) = payload
        .get("table")
        .and_then(Value::as_u64)
        .and_then(|table| u32::try_from(table).ok())
    else {
        return;
    };
    let widths = match payload.get("widths") {
        None | Some(Value::Null) => None,
        Some(widths) => match serde_json::from_value::<Vec<f32>>(widths.clone()) {
            Ok(widths) => Some(widths),
            Err(_) => return,
        },
    };
    update(|all| all.set(root, file, table, widths), cx);
}

/// Files of `root` were renamed or moved (see [`TableWidths::remap`]).
pub fn paths_moved(root: &Path, moved: impl Fn(&str) -> Option<String>, cx: &mut gpui::App) {
    update(|all| all.remap(root, moved), cx);
}

fn update(change: impl FnOnce(&mut TableWidths) -> bool, cx: &mut gpui::App) {
    let Ok(mut store) = store().lock() else {
        return;
    };
    if !change(&mut store.widths) {
        return;
    }
    store.unwritten = true;
    store.changes += 1;
    let change = store.changes;
    drop(store);
    cx.spawn(async move |cx| {
        cx.background_executor().timer(WRITE_AFTER).await;
        if self::store()
            .lock()
            .is_ok_and(|store| store.changes == change)
        {
            flush();
        }
    })
    .detach();
}

/// Write the widths now, when they changed since they were last written.
pub fn flush() {
    let Ok(mut store) = store().lock() else {
        return;
    };
    if !std::mem::take(&mut store.unwritten) {
        return;
    }
    if let Some(file) = store.file.clone()
        && let Err(error) = write_json(&file, &store.widths)
    {
        log::warn!("could not save the Markdown tables' column widths: {error:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_tables_widths_are_kept_per_file_and_dropped_on_their_own() {
        let root = Path::new("/p");
        let mut all = TableWidths::default();
        assert!(all.set(root, "notes.md", 0, Some(vec![120., 80.])));
        assert!(all.set(root, "notes.md", 2, Some(vec![60., 60., 90.])));
        assert!(
            !all.set(root, "notes.md", 0, Some(vec![120., 80.])),
            "the same widths again change nothing"
        );
        assert!(all.set(Path::new("/q"), "notes.md", 0, Some(vec![50.])));
        assert_eq!(all.of(root, "notes.md").unwrap()[&0], vec![120., 80.]);
        assert!(all.set(root, "notes.md", 0, None));
        assert_eq!(
            all.of(root, "notes.md").unwrap().keys().collect::<Vec<_>>(),
            [&2]
        );
        assert!(all.set(root, "notes.md", 2, None));
        assert_eq!(all.of(root, "notes.md"), None, "no table left, no file");
        assert_eq!(all.of(Path::new("/q"), "notes.md").unwrap()[&0], vec![50.]);
    }

    #[test]
    fn widths_that_are_not_widths_are_refused() {
        let root = Path::new("/p");
        let mut all = TableWidths::default();
        for widths in [
            vec![],
            vec![0.],
            vec![-3.],
            vec![f32::NAN],
            vec![1.; MAX_COLUMNS + 1],
        ] {
            assert!(!all.set(root, "a.md", 0, Some(widths)));
        }
        assert_eq!(all, TableWidths::default());
    }

    #[test]
    fn the_file_touched_longest_ago_goes_first() {
        let root = Path::new("/p");
        let mut all = TableWidths::default();
        for file in 0..MAX_FILES {
            all.set(root, &format!("{file}.md"), 0, Some(vec![100.]));
        }
        all.set(root, "0.md", 1, Some(vec![90.]));
        all.set(root, "new.md", 0, Some(vec![70.]));
        assert!(all.of(root, "0.md").is_some(), "touched again, kept");
        assert_eq!(all.of(root, "1.md"), None);
    }

    #[test]
    fn a_renamed_files_widths_follow_it_and_read_back_from_json() {
        let root = Path::new("/p");
        let mut all = TableWidths::default();
        all.set(root, "notes/a.md", 1, Some(vec![140.5, 60.]));
        all.set(root, "b.md", 0, Some(vec![80.]));
        all.set(root, "parts/notes/a.md", 0, Some(vec![30.]));
        assert!(all.remap(root, |file| {
            file.strip_prefix("notes/")
                .map(|rest| format!("parts/notes/{rest}"))
        }));
        assert_eq!(
            all.of(root, "parts/notes/a.md").unwrap()[&1],
            vec![140.5, 60.],
            "the moved file wins over what was left at its new path"
        );
        assert_eq!(all.of(root, "notes/a.md"), None);
        assert!(!all.remap(root, |_| None), "nothing moved, nothing changed");
        let json = serde_json::to_string(&all).unwrap();
        assert_eq!(serde_json::from_str::<TableWidths>(&json).unwrap(), all);
    }
}
