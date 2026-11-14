//! The project's annotations, as the Tauri app's `useEditorComments` keeps
//! them: read from `.research/annotations.json` (lattice-core's
//! `read_annotations`) when the project opens, changed here and written back
//! whole after every change (`write_annotations`).
//!
//! One store per app, holding each open project by its root, so every
//! window and every editor on a project sees one list. A change is refused,
//! saying why, until the file has been read: a save replaces the whole file,
//! so a list never read (a read still under way, a file that does not parse)
//! must not be written over what is on disk. Saves are numbered from the
//! process-wide counter the Agent's page saves through too
//! (`agent::commands`), so whichever of the two writes last wins and an
//! older save that lands late is dropped by lattice-core.
//!
//! What another writer puts in the file (the Agent's page, an edit outside
//! Lattice) is read again when the status counters read the project again,
//! after a save or an outside edit, unless a change made here is still on
//! its way to disk.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use gpui::{App, AppContext as _, Context, Entity, Global, Subscription, Task};
use lattice_core::project::{self, AnnotationRound, EditorComment};
use lattice_i18n::t;

use super::model::{self, Author};

/// What a project holds: its notes and citation reasons in one list, as the
/// file keeps them, and the revision rounds.
#[derive(Clone, Debug, Default)]
pub struct Notes {
    pub annotations: Vec<EditorComment>,
    pub rounds: Vec<AnnotationRound>,
}

#[derive(Default)]
struct ProjectNotes {
    notes: Notes,
    /// `None` until a read lands; then why the file could not be read, if it
    /// could not.
    loaded: Option<Result<(), String>>,
    /// Bumped by every read asked for and every change, so a read that a
    /// change overtook is dropped.
    generation: u64,
    /// Saves sent and not yet written.
    saving: usize,
    /// The status counters' read of the project last followed.
    counters_seen: u64,
    _read: Option<Task<()>>,
}

pub struct AnnotationStore {
    projects: HashMap<PathBuf, ProjectNotes>,
    author_id: String,
    _counters: Option<Subscription>,
}

struct StoreGlobal(Entity<AnnotationStore>);

impl Global for StoreGlobal {}

/// The app's store.
pub fn store(cx: &mut App) -> Entity<AnnotationStore> {
    if let Some(global) = cx.try_global::<StoreGlobal>() {
        return global.0.clone();
    }
    let author_id = author_id(cx);
    let counters = crate::status_counters::project_counters(cx);
    let entity = cx.new(|cx| AnnotationStore {
        projects: HashMap::new(),
        author_id,
        _counters: Some(cx.observe(&counters, |store: &mut AnnotationStore, _, cx| {
            store.follow_counters(cx)
        })),
    });
    cx.set_global(StoreGlobal(entity.clone()));
    entity
}

/// The store, when anything has asked for it yet.
pub fn try_store(cx: &App) -> Option<Entity<AnnotationStore>> {
    cx.try_global::<StoreGlobal>().map(|global| global.0.clone())
}

/// The writer's stable id (the Tauri app's `lattice.editor-comment-author-id.v1`):
/// kept in the state directory, made once; a scripted run gets one for the
/// run.
fn author_id(cx: &App) -> String {
    let dir = crate::shell::workspaces::state_dir(crate::settings::scripted(cx));
    let file = dir.as_ref().map(|dir| dir.join("annotation-author-id"));
    if let Some(file) = &file
        && let Ok(id) = std::fs::read_to_string(file)
        && !id.trim().is_empty()
    {
        return id.trim().to_string();
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(file) = &file {
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(file, &id);
    }
    id
}

/// Who signs what this app writes on the project at `root`: its Git
/// `user.name`, else the "Your name" setting (`resolveAuthorName`).
pub fn author(root: &Path, cx: &App) -> Author {
    let id = try_store(cx)
        .map(|store| store.read(cx).author_id.clone())
        .unwrap_or_else(|| "anonymous".into());
    let git = git_name(root);
    let setting = crate::settings::get(cx).author_name.clone();
    let name = [git.unwrap_or_default(), setting]
        .into_iter()
        .map(|name| name.trim().to_string())
        .find(|name| !name.is_empty())
        .unwrap_or_default();
    Author { id, name }
}

/// Git's `user.name` for `root`, read once per project.
fn git_name(root: &Path) -> Option<String> {
    use std::sync::{Mutex, OnceLock};
    static NAMES: OnceLock<Mutex<HashMap<PathBuf, Option<String>>>> = OnceLock::new();
    let names = NAMES.get_or_init(Default::default);
    if let Some(name) = names.lock().ok()?.get(root) {
        return name.clone();
    }
    let name = lattice_core::git::user_name(root);
    names.lock().ok()?.insert(root.to_path_buf(), name.clone());
    name
}

impl AnnotationStore {
    /// This author's id.
    pub fn author_id(&self) -> &str {
        &self.author_id
    }

    /// Read `root`'s annotations, unless they have been read or are being
    /// read.
    pub fn ensure(&mut self, root: &Path, cx: &mut Context<Self>) {
        let entry = self.projects.entry(root.to_path_buf()).or_default();
        if entry.loaded.is_some() || entry._read.is_some() {
            return;
        }
        self.read(root.to_path_buf(), cx);
    }

    /// Read `root`'s annotations again (another writer changed the file).
    fn read(&mut self, root: PathBuf, cx: &mut Context<Self>) {
        let entry = self.projects.entry(root.clone()).or_default();
        entry.generation += 1;
        let generation = entry.generation;
        let read = root.clone();
        entry._read = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { project::read_annotations(&read) })
                .await;
            this.update(cx, |this, cx| {
                let Some(entry) = this.projects.get_mut(&root) else {
                    return;
                };
                entry._read = None;
                if entry.generation != generation {
                    return;
                }
                match result {
                    Ok(read) => {
                        entry.notes = Notes {
                            annotations: read.annotations,
                            rounds: read.rounds,
                        };
                        entry.loaded = Some(Ok(()));
                    }
                    Err(error) => {
                        // A first read that fails says so; a later one keeps
                        // what was read and the saves going.
                        if entry.loaded.is_none() {
                            crate::notices::error(
                                t!("Annotations"),
                                t!(
                                    "This project's annotations could not be read, so changes to them are not saved: {error}",
                                    error = error
                                ),
                                cx,
                            );
                            entry.loaded = Some(Err(error));
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// The status counters read a project again: take in what another writer
    /// put in its file, unless a save of ours is still on its way.
    fn follow_counters(&mut self, cx: &mut Context<Self>) {
        let roots: Vec<PathBuf> = self.projects.keys().cloned().collect();
        for root in roots {
            let revision = crate::status_counters::annotations_revision(&root, cx);
            let Some(entry) = self.projects.get_mut(&root) else {
                continue;
            };
            if revision == entry.counters_seen {
                continue;
            }
            entry.counters_seen = revision;
            if entry.saving == 0 && entry.loaded.is_some() && entry._read.is_none() {
                self.read(root, cx);
            }
        }
    }

    /// Whether `root`'s annotations have been read.
    pub fn loaded(&self, root: &Path) -> bool {
        self.projects
            .get(root)
            .is_some_and(|entry| matches!(entry.loaded, Some(Ok(()))))
    }

    /// Everything the file holds for `root`.
    pub fn notes(&self, root: &Path) -> Option<&Notes> {
        self.projects.get(root).map(|entry| &entry.notes)
    }

    /// `root`'s annotations, without the citation reasons (which take no
    /// pin, draw no mark and never go to the agent).
    pub fn annotations(&self, root: &Path) -> Vec<&EditorComment> {
        self.notes(root)
            .map(|notes| {
                notes
                    .annotations
                    .iter()
                    .filter(|comment| model::is_note(comment))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// One annotation of `root`'s.
    pub fn get(&self, root: &Path, id: &str) -> Option<&EditorComment> {
        self.notes(root)?
            .annotations
            .iter()
            .find(|comment| comment.id == id)
    }

    /// Change `root`'s annotations with `change`, which says whether it
    /// changed anything, and save them. Refused, saying why, until they have
    /// been read. Returns whether the change was made.
    pub fn commit(
        &mut self,
        root: &Path,
        change: impl FnOnce(&mut Notes) -> bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(entry) = self.projects.get_mut(root) else {
            return false;
        };
        match &entry.loaded {
            Some(Ok(())) => {}
            Some(Err(error)) => {
                crate::notices::error(
                    t!("Annotations"),
                    t!(
                        "This project's annotations could not be read, so changes to them are not saved: {error}",
                        error = error
                    ),
                    cx,
                );
                return false;
            }
            None => {
                crate::notices::error(
                    t!("Annotations"),
                    t!("This project's annotations are still being read. Try again in a moment."),
                    cx,
                );
                return false;
            }
        }
        if !change(&mut entry.notes) {
            return false;
        }
        // A read under way read the file before this change.
        entry.generation += 1;
        entry._read = None;
        entry.saving += 1;
        let save = crate::agent::commands::next_annotation_save();
        let annotations = entry.notes.annotations.clone();
        let rounds = entry.notes.rounds.clone();
        let root = root.to_path_buf();
        cx.spawn(async move |this, cx| {
            let written = root.clone();
            let result = cx
                .background_spawn(async move {
                    project::write_annotations(&written, annotations, rounds, save)
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(entry) = this.projects.get_mut(&root) {
                    entry.saving = entry.saving.saturating_sub(1);
                }
                if let Err(error) = result {
                    crate::notices::error(t!("Annotations"), error, cx);
                }
                // The status bar's counter reads the file again.
                crate::status_counters::refresh(root.clone(), cx);
            })
            .ok();
        })
        .detach();
        cx.notify();
        true
    }

    /// Add `note` as `root`'s next numbered annotation; its id, when it was
    /// added.
    pub fn add(
        &mut self,
        root: &Path,
        mut note: EditorComment,
        cx: &mut Context<Self>,
    ) -> Option<String> {
        let id = note.id.clone();
        self.commit(
            root,
            |notes| {
                note.number = model::next_number(&notes.annotations);
                notes.annotations.push(note);
                true
            },
            cx,
        )
        .then_some(id)
    }

    /// Change the annotation `id` with `change`, marking it as changed now.
    pub fn update(
        &mut self,
        root: &Path,
        id: &str,
        change: impl FnOnce(&mut EditorComment),
        cx: &mut Context<Self>,
    ) -> bool {
        self.commit(
            root,
            |notes| {
                let Some(comment) = notes.annotations.iter_mut().find(|item| item.id == id) else {
                    return false;
                };
                change(comment);
                model::touch(comment);
                true
            },
            cx,
        )
    }

    /// Delete the annotation `id` and its replies at once, with an Undo
    /// rather than a confirmation (`deleteComment`): it goes back where it
    /// was in the list as the list is then, in this project only.
    pub fn delete(&mut self, root: &Path, id: &str, cx: &mut Context<Self>) {
        let Some(index) = self
            .notes(root)
            .and_then(|notes| notes.annotations.iter().position(|item| item.id == id))
        else {
            return;
        };
        let mut removed = None;
        let done = self.commit(
            root,
            |notes| {
                removed = Some(notes.annotations.remove(index));
                true
            },
            cx,
        );
        let (true, Some(removed)) = (done, removed) else {
            return;
        };
        let store = cx.weak_entity();
        let root = root.to_path_buf();
        let id = id.to_string();
        crate::notices::show(
            crate::notices::Notice::new(
                lattice_ui::components::ToastLevel::Info,
                t!("Annotation deleted"),
            )
            .source(t!("Annotations"))
            .key(format!("editor-comment-deleted:{id}"))
            .action(crate::notices::NoticeAction::new(t!("Undo"), move |_, cx| {
                let removed = removed.clone();
                store
                    .update(cx, |store, cx| {
                        store.commit(
                            &root,
                            |notes| {
                                if notes.annotations.iter().any(|item| item.id == removed.id) {
                                    return false;
                                }
                                let at = index.min(notes.annotations.len());
                                notes.annotations.insert(at, removed);
                                true
                            },
                            cx,
                        );
                    })
                    .ok();
            })),
            cx,
        );
    }

    /// Resolve or reopen `id`, saying so with a toast that offers it back
    /// (`changeResolved`).
    pub fn set_resolved(
        &mut self,
        root: &Path,
        id: &str,
        resolved: bool,
        cx: &mut Context<Self>,
    ) {
        if !self.update(root, id, |comment| comment.resolved = resolved, cx) {
            return;
        }
        let store = cx.weak_entity();
        let root = root.to_path_buf();
        let undo_id = id.to_string();
        let title = if resolved {
            t!("Comment resolved")
        } else {
            t!("Comment reopened")
        };
        crate::notices::show(
            crate::notices::Notice::new(lattice_ui::components::ToastLevel::Info, title)
                .source(t!("Comments"))
                .key(format!("editor-comment-resolved:{id}"))
                .action(crate::notices::NoticeAction::new(t!("Undo"), move |_, cx| {
                    store
                        .update(cx, |store, cx| {
                            store.update(
                                &root,
                                &undo_id,
                                |comment| comment.resolved = !resolved,
                                cx,
                            );
                        })
                        .ok();
                })),
            cx,
        );
    }

    /// Reply to `id` as `author`.
    pub fn reply(
        &mut self,
        root: &Path,
        id: &str,
        body: &str,
        author: &Author,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(reply) = model::new_reply(body, author) else {
            return false;
        };
        self.update(root, id, |comment| comment.replies.push(reply), cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_number_after_the_highest_pin() {
        let author = Author {
            id: "a".into(),
            name: "Ada".into(),
        };
        let text = "One two three.";
        let mut notes = Notes::default();
        for quote in ["One", "three"] {
            let at = text.find(quote).unwrap();
            let mut note =
                model::new_note("main.tex", text, at, at + quote.len(), "x", None, &author)
                    .unwrap();
            note.number = model::next_number(&notes.annotations);
            notes.annotations.push(note);
        }
        assert_eq!(
            notes.annotations.iter().map(|note| note.number).collect::<Vec<_>>(),
            vec![1, 2]
        );
        notes.annotations.remove(0);
        assert_eq!(model::next_number(&notes.annotations), 3);
    }
}
