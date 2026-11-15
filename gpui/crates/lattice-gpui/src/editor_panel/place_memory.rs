//! Each file's place in its editor kept across launches, as the Tauri app
//! keeps a text file's `FileViewState` (`use-file-view-states.ts`): where
//! its caret was and how far it was scrolled, per project, the file touched
//! last kept newest, as many as [`MAX_PLACES`] (`FILE_VIEW_STATE_FILE_MAX`).
//!
//! An editor reports its place once caret and scroll have rested 250 ms (the
//! Tauri app's persist debounce); one opened on a file goes back to the
//! place it has, unless it was opened at a line of its own; a rename or
//! move carries the place to the new path. The caret is a byte offset,
//! clamped to the text when it comes back; the scroll is the top line,
//! where the Tauri app keeps CodeMirror's pixels.
//!
//! One JSON file in the app's state directory (`editor-places.json`), beside
//! the PDF's places, written whole beside itself and moved over it.
//! `LATTICE_GPUI_STATE_DIR` names another directory (empty for none); a
//! scripted run keeps them in memory.

use std::{
    collections::BTreeMap,
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

/// A place is kept once caret and scroll have rested this long.
const REMEMBER_AFTER: Duration = Duration::from_millis(250);

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
    /// [`MAX_PLACES`].
    pub fn remember(&mut self, root: &Path, file: &str, place: EditorPlace) {
        let places = self.0.entry(root.to_path_buf()).or_default();
        places.shift_remove(file);
        places.insert(file.to_string(), place);
        while places.len() > MAX_PLACES {
            places.shift_remove_index(0);
        }
    }

    /// `from` was renamed or moved to `to`: its place goes with it.
    pub fn moved(&mut self, root: &Path, from: &str, to: &str) {
        let Some(places) = self.0.get_mut(root) else {
            return;
        };
        if let Some(place) = places.shift_remove(from) {
            places.shift_remove(to);
            places.insert(to.to_string(), place);
        }
    }
}

struct Store {
    file: Option<PathBuf>,
    places: Places,
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
        Mutex::new(Store { file, places })
    })
}

fn state_dir() -> Option<PathBuf> {
    let scripted = std::env::args().any(|arg| arg == "--scenario");
    crate::shell::workspaces::state_dir(scripted)
}

/// Where `file` of `root` was left, if it was.
pub fn place(root: &Path, file: &str) -> Option<EditorPlace> {
    store().lock().ok()?.places.get(root, file)
}

/// Change the places and write them, when they changed.
fn update(change: impl FnOnce(&mut Places)) {
    let Ok(mut store) = store().lock() else {
        return;
    };
    let before = store.places.clone();
    change(&mut store.places);
    if store.places == before {
        return;
    }
    if let Some(file) = store.file.clone()
        && let Err(error) = write_json(&file, &store.places)
    {
        log::warn!("could not save the editors' places: {error:#}");
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, serde_json::to_vec(value)?)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

impl EditorPanel {
    /// The caret or the scroll moved: once both rest, the place is kept.
    pub(super) fn place_changed(&mut self, cx: &mut Context<Self>) {
        self.place_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REMEMBER_AFTER).await;
            this.update(cx, |this, cx| this.remember_place(cx)).ok();
        }));
    }

    fn remember_place(&mut self, cx: &mut Context<Self>) {
        let root = self.project.read(cx).root().to_path_buf();
        let place = self.editor().clone().update(cx, |editor, cx| {
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            EditorPlace {
                cursor: editor.selections.newest_anchor().head().to_offset(&snapshot).0,
                top: editor.scroll_position(cx).y.max(0.) as f32,
            }
        });
        let relative = self.relative.clone();
        update(|places| places.remember(&root, &relative, place));
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

    /// The file moved from `from` (project-relative): its place follows.
    pub(super) fn place_moved(&self, from: &str, cx: &mut Context<Self>) {
        let root = self.project.read(cx).root().to_path_buf();
        let to = self.relative.clone();
        update(|places| places.moved(&root, from, &to));
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
        places.remember(root, "old.tex", EditorPlace { cursor: 42, top: 12.5 });
        places.moved(root, "old.tex", "chapters/new.tex");
        assert_eq!(places.get(root, "old.tex"), None);
        assert_eq!(places.get(root, "chapters/new.tex"), Some(EditorPlace { cursor: 42, top: 12.5 }));
        let json = serde_json::to_string(&places).unwrap();
        assert_eq!(serde_json::from_str::<Places>(&json).unwrap(), places);
    }
}
