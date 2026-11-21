//! Each file's place in its editor kept across launches, as the Tauri app
//! keeps a text file's `FileViewState` (`use-file-view-states.ts`): where
//! its caret was and how far it was scrolled, per project, the file touched
//! last kept newest, as many as [`MAX_PLACES`] (`FILE_VIEW_STATE_FILE_MAX`).
//!
//! An editor records its place at once whenever its caret or scroll moves,
//! and the places are written 250 ms after the last change (the Tauri app's
//! persist debounce), or as the editor closes or the app quits; one opened
//! on a file goes back to the place it has, unless it was opened at a line
//! of its own; a rename or move, of the file or a folder holding it, open
//! or not, carries the place to the new path. The caret is a byte offset,
//! clamped to the text when it comes back; the scroll is the top line,
//! where the Tauri app keeps CodeMirror's pixels.
//!
//! One JSON file in the app's state directory (`editor-places.json`), beside
//! the PDF's places, written whole beside itself and moved over it.
//! `LATTICE_GPUI_STATE_DIR` names another directory (empty for none); a
//! scripted run keeps them in memory.

use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use editor::{MultiBufferOffset, SelectionEffects, ToOffset as _};
use gpui::{Context, Window, point};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::EditorPanel;

/// How many files' places a project keeps.
pub const MAX_PLACES: usize = 200;

/// The places are written once they have rested this long.
const WRITE_AFTER: Duration = Duration::from_millis(250);

/// Where a file's editor was.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct EditorPlace {
    /// The caret, a byte offset into the text.
    pub cursor: usize,
    /// The first line shown, in lines from the top (fractional).
    pub top: f32,
}

/// Every project's files' places, by project-relative path, the most
/// recent last.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Places(BTreeMap<PathBuf, IndexMap<String, EditorPlace>>);

impl Places {
    pub fn get(&self, root: &Path, file: &str) -> Option<EditorPlace> {
        self.0.get(root)?.get(file).copied()
    }

    /// Keep `place` as `file`'s, the newest; the oldest goes past
    /// [`MAX_PLACES`]. Whether anything changed.
    pub fn remember(&mut self, root: &Path, file: &str, place: EditorPlace) -> bool {
        let places = self.0.entry(root.to_path_buf()).or_default();
        if places
            .last()
            .is_some_and(|(last, at)| last == file && *at == place)
        {
            return false;
        }
        places.shift_remove(file);
        places.insert(file.to_string(), place);
        while places.len() > MAX_PLACES {
            places.shift_remove_index(0);
        }
        true
    }

    /// Files of `root` were renamed or moved, each file to where `moved`
    /// says it went (`None` for one that stayed): their places go with
    /// them, as recent as they were, over any place left at the new path.
    /// Whether anything changed.
    pub fn remap(&mut self, root: &Path, moved: impl Fn(&str) -> Option<String>) -> bool {
        let Some(places) = self.0.get_mut(root) else {
            return false;
        };
        let moves: Vec<_> = places.keys().map(|file| moved(file)).collect();
        if moves.iter().all(Option::is_none) {
            return false;
        }
        let arrived: HashSet<String> = moves.iter().flatten().cloned().collect();
        *places = std::mem::take(places)
            .into_iter()
            .zip(moves)
            .filter_map(|((file, place), to)| match to {
                Some(to) => Some((to, place)),
                None => (!arrived.contains(&file)).then_some((file, place)),
            })
            .collect();
        true
    }
}

struct Store {
    file: Option<PathBuf>,
    places: Places,
    /// Changed since they were last written.
    unwritten: bool,
    /// Counts the changes, so only the wait after the last one writes.
    changes: u64,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        let file = state_dir().map(|dir| dir.join("editor-places.json"));
        let places = file
            .as_deref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Mutex::new(Store {
            file,
            places,
            unwritten: false,
            changes: 0,
        })
    })
}

pub(crate) fn state_dir() -> Option<PathBuf> {
    let scripted = std::env::args().any(|arg| arg == "--scenario");
    crate::shell::workspaces::state_dir(scripted)
}

/// Where `file` of `root` was left, if it was.
pub fn place(root: &Path, file: &str) -> Option<EditorPlace> {
    store().lock().ok()?.places.get(root, file)
}

/// Change the places at once, and write them [`WRITE_AFTER`] the last
/// change, by a wait no editor owns, so one closing does not lose it.
fn update(change: impl FnOnce(&mut Places) -> bool, cx: &mut gpui::App) {
    let Ok(mut store) = store().lock() else {
        return;
    };
    if !change(&mut store.places) {
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

/// Write the places now, when they changed since they were last written.
pub fn flush() {
    let Ok(mut store) = store().lock() else {
        return;
    };
    if !std::mem::take(&mut store.unwritten) {
        return;
    }
    if let Some(file) = store.file.clone()
        && let Err(error) = write_json(&file, &store.places)
    {
        log::warn!("could not save the editors' places: {error:#}");
    }
}

/// Files of `root` were renamed or moved (see [`Places::remap`]), open in
/// an editor or not.
pub fn paths_moved(root: &Path, moved: impl Fn(&str) -> Option<String>, cx: &mut gpui::App) {
    update(|places| places.remap(root, moved), cx);
}

pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, serde_json::to_vec(value)?)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

impl EditorPanel {
    /// The caret or the scroll moved: the place is kept at once.
    pub(super) fn place_changed(&mut self, cx: &mut Context<Self>) {
        let root = self.project.read(cx).root().to_path_buf();
        let place = self.editor().clone().update(cx, |editor, cx| {
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            EditorPlace {
                cursor: editor
                    .selections
                    .newest_anchor()
                    .head()
                    .to_offset(&snapshot)
                    .0,
                top: editor.scroll_position(cx).y.max(0.) as f32,
            }
        });
        let relative = self.relative.clone();
        update(|places| places.remember(&root, &relative, place), cx);
    }

    /// Back to where the file was left, if it was: the caret (clamped to
    /// the text) and the first line shown.
    pub fn restore_place(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let root = self.project.read(cx).root().to_path_buf();
        let Some(place) = place(&root, &self.relative) else {
            return;
        };
        let editor = self.editor().clone();
        editor.update(cx, |editor, cx| {
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            let text = snapshot.text();
            let mut at = place.cursor.min(text.len());
            while !text.is_char_boundary(at) {
                at -= 1;
            }
            let at = MultiBufferOffset(at);
            editor.change_selections(SelectionEffects::no_scroll(), window, cx, |selections| {
                selections.select_ranges([at..at])
            });
            editor.set_scroll_position(point(0., f64::from(place.top)), window, cx);
        });
    }

    /// The file moved from `from` (project-relative): its place, and a
    /// Markdown file's table widths, follow, unless the move already took
    /// them there.
    pub(super) fn place_moved(&self, from: &str, cx: &mut Context<Self>) {
        let root = self.project.read(cx).root().to_path_buf();
        let to = self.relative.clone();
        paths_moved(&root, |file| (file == from).then(|| to.clone()), cx);
        crate::editor_panel::table_widths::paths_moved(
            &root,
            |file| (file == from).then(|| to.clone()),
            cx,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(cursor: usize) -> EditorPlace {
        EditorPlace { cursor, top: 0. }
    }

    #[test]
    fn each_files_place_is_kept_per_project_the_oldest_going_first() {
        let (a, b) = (Path::new("/a"), Path::new("/b"));
        let mut places = Places::default();
        places.remember(a, "main.tex", at(3));
        places.remember(b, "main.tex", at(7));
        assert_eq!(places.get(a, "main.tex"), Some(at(3)));
        assert_eq!(places.get(b, "main.tex"), Some(at(7)));
        // FILE_VIEW_STATE_FILE_MAX: 200, the file touched longest ago goes.
        for file in 0..MAX_PLACES {
            places.remember(a, &format!("{file}.tex"), at(file));
        }
        assert_eq!(places.get(a, "main.tex"), None);
        places.remember(a, "0.tex", at(1));
        places.remember(a, "new.tex", at(2));
        assert_eq!(places.get(a, "0.tex"), Some(at(1)), "touched again, kept");
        assert_eq!(places.get(a, "1.tex"), None);
    }

    #[test]
    fn a_renamed_files_place_follows_it_and_reads_back_from_json() {
        let root = Path::new("/p");
        let mut places = Places::default();
        places.remember(
            root,
            "old.tex",
            EditorPlace {
                cursor: 42,
                top: 12.5,
            },
        );
        places.remap(root, |file| {
            (file == "old.tex").then(|| "chapters/new.tex".to_string())
        });
        assert_eq!(places.get(root, "old.tex"), None);
        assert_eq!(
            places.get(root, "chapters/new.tex"),
            Some(EditorPlace {
                cursor: 42,
                top: 12.5
            })
        );
        let json = serde_json::to_string(&places).unwrap();
        assert_eq!(serde_json::from_str::<Places>(&json).unwrap(), places);
    }

    #[test]
    fn a_closed_file_renamed_and_a_moved_folders_files_keep_their_places() {
        let root = Path::new("/p");
        let mut places = Places::default();
        places.remember(root, "chapters/a.tex", at(1));
        places.remember(root, "main.tex", at(2));
        places.remember(root, "parts/chapters/a.tex", at(3));
        places.remember(root, "chapters/b.tex", at(4));
        places.remember(root, "chapters-old/c.tex", at(5));
        // The tree's changes: a folder moved, a file renamed.
        let changes = [("chapters", "parts/chapters"), ("main.tex", "paper.tex")];
        let moved = |file: &str| {
            changes.iter().find_map(|(from, to)| {
                if file == *from {
                    Some(to.to_string())
                } else {
                    file.strip_prefix(&format!("{from}/"))
                        .map(|rest| format!("{to}/{rest}"))
                }
            })
        };
        assert!(places.remap(root, moved));
        let files: Vec<_> = places.0[root]
            .iter()
            .map(|(file, place)| (file.as_str(), *place))
            .collect();
        // Each keeps its recency; the moved file wins over the place left
        // at its new path.
        assert_eq!(
            files,
            [
                ("parts/chapters/a.tex", at(1)),
                ("paper.tex", at(2)),
                ("parts/chapters/b.tex", at(4)),
                ("chapters-old/c.tex", at(5)),
            ]
        );
        assert!(
            !places.remap(root, |_| None),
            "nothing moved, nothing changed"
        );
    }
}
