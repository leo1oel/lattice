//! The file tree's operations, run through lattice-core: create, rename, move
//! (rewriting a moved document's figure paths) and delete, with the open
//! tabs following every path that changes.

use std::collections::HashSet;

use gpui::{AppContext as _, Context, Entity, Window};
use lattice_core::{models::FileNode, project as core_project};
use lattice_i18n::t;

use super::Shell;
use crate::{
    editor_panel::place_memory,
    file_tree::{FileTreeEvent, FileTreePanel},
    moved_paths, notices,
};

impl Shell {
    pub(super) fn on_tree_event(
        &mut self,
        _: &Entity<FileTreePanel>,
        event: &FileTreeEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // A row's click is a quick look; its double-click keeps the tab.
            FileTreeEvent::Open(path) => self.quick_look(path.clone(), None, window, cx),
            FileTreeEvent::Keep(path) => self.open_kept(path.clone(), window, cx),
            FileTreeEvent::Create { path, folder } => {
                self.create_entry(path.clone(), *folder, window, cx)
            }
            FileTreeEvent::CreateDeck { id } => self.create_deck(id.clone(), window, cx),
            // Opens it, never closes it (`useProjectSearch.openFind`).
            FileTreeEvent::FindInProject => self.open_find(window, cx),
            FileTreeEvent::Rename { path, name } => {
                self.rename_entry(path.clone(), name.clone(), window, cx)
            }
            FileTreeEvent::Move { paths, target } => {
                self.move_entries(paths.clone(), target.clone(), window, cx)
            }
            FileTreeEvent::Delete(paths) => self.delete_entries(paths.clone(), window, cx),
            FileTreeEvent::Import { target } => self.choose_imports(target.clone(), window, cx),
            FileTreeEvent::Paste { paths, target } => {
                self.paste_entries(paths.clone(), target.clone(), window, cx)
            }
            FileTreeEvent::PasteImage { target } => {
                self.paste_clipboard_image(target.clone(), window, cx)
            }
            FileTreeEvent::DropFiles { paths, target } => self.drop_files(
                paths.clone(),
                super::drops::DropSurface::Tree(target.clone()),
                window,
                cx,
            ),
            FileTreeEvent::DragOut { path, pointer } => {
                if self.carry_tree_row(path, *pointer, window, cx) {
                    cx.stop_active_drag(window);
                }
            }
        }
    }

    /// New presentation: the deck `id` under `slides/`, made by lattice-core
    /// as the Tauri app makes it (`create_open_slide_deck`), and opened.
    fn create_deck(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let created = cx.background_spawn({
            let root = root.clone();
            async move { core_project::create_open_slide_deck(&root, &id) }
        });
        cx.spawn_in(window, async move |this, cx| {
            let created = created.await;
            this.update_in(cx, |this, window, cx| {
                project.update(cx, |project, cx| project.rescan(cx));
                match created {
                    Ok(entry) => {
                        this.open_path(root.join(entry), None, window, cx);
                    }
                    Err(error) => notices::error(t!("Could not create it"), error, cx),
                }
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn create_entry(
        &mut self,
        path: String,
        folder: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let created = cx.background_spawn({
            let root = root.clone();
            async move {
                core_project::create_entry(&root, &path, if folder { "folder" } else { "file" })
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let created = created.await;
            this.update_in(cx, |this, window, cx| {
                project.update(cx, |project, cx| project.rescan(cx));
                match created {
                    Ok(created) if !folder => {
                        this.open_path(root.join(created), None, window, cx);
                    }
                    Ok(_) => {}
                    Err(error) => notices::error(t!("Could not create it"), error, cx),
                }
            })
            .ok();
        })
        .detach();
    }

    fn rename_entry(
        &mut self,
        path: String,
        name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let renamed = cx.background_spawn({
            let path = path.clone();
            async move { core_project::rename_entry(&root, &path, &name) }
        });
        cx.spawn_in(window, async move |this, cx| {
            let renamed = renamed.await;
            this.update(cx, |this, cx| {
                project.update(cx, |project, cx| project.entries_changed(cx));
                match renamed {
                    Ok(renamed) => this.apply_path_changes(&[(path, renamed)], cx),
                    Err(error) => notices::error(t!("Could not rename it"), error, cx),
                }
            })
            .ok();
        })
        .detach();
    }

    /// Move `paths` into `target`, as the Tauri app's Project pane does: an
    /// open file among them is saved first, and each moved document's figure
    /// paths are rewritten to point at the same files from its new folder.
    fn move_entries(
        &mut self,
        paths: Vec<String>,
        target: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let moving = |relative: &str| {
            paths
                .iter()
                .any(|path| relative == path || relative.starts_with(&format!("{path}/")))
        };
        let editors: Vec<_> = self
            .open_editors()
            .into_iter()
            .filter(|editor| moving(editor.read(cx).relative()))
            .collect();
        let saves = Self::save_dirty(&editors, cx);
        let root = project.read(cx).root().to_path_buf();
        let assets = asset_paths(project.read(cx).files());
        cx.spawn_in(window, async move |this, cx| {
            for save in saves {
                if !save.await.unwrap_or(false) {
                    // The save already said why; nothing moves.
                    return;
                }
            }
            // Each open document's text as the buffer holds it.
            let open_texts: Vec<(String, String)> = this
                .update(cx, |_, cx| {
                    editors
                        .iter()
                        .map(|editor| {
                            let editor = editor.read(cx);
                            (
                                editor.relative().to_string(),
                                editor.editor().read(cx).text(cx),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            // A move that fails stops the batch, but what moved before it
            // (and the move that failed to rewrite after it) is on disk: its
            // tabs follow it all the same.
            let (changes, rewritten, failed) = cx
                .background_spawn(async move {
                    let mut changes = Vec::new();
                    let mut rewritten = Vec::new();
                    for path in &paths {
                        let moved = match core_project::move_entry(&root, path, &target) {
                            Ok(moved) => moved,
                            Err(error) => return (changes, rewritten, Some(error)),
                        };
                        changes.push((path.clone(), moved.clone()));
                        if !moved_paths::is_movable_document(path) || moved == *path {
                            continue;
                        }
                        let text = match open_texts.iter().find(|(open, _)| open == path) {
                            Some((_, text)) => Ok(text.clone()),
                            None => core_project::read_file(&root, &moved),
                        };
                        let written = text.and_then(|text| {
                            let updated =
                                moved_paths::rewrite_moved_document(&text, path, &moved, &assets);
                            if updated == text {
                                return Ok(None);
                            }
                            core_project::apply_editor_transaction(
                                &root,
                                moved.clone(),
                                updated,
                                None,
                                None,
                            )
                            .map(|written| Some(written.content))
                        });
                        match written {
                            Ok(Some(text)) => rewritten.push((moved, text)),
                            Ok(None) => {}
                            Err(error) => return (changes, rewritten, Some(error)),
                        }
                    }
                    (changes, rewritten, None)
                })
                .await;
            this.update(cx, |this, cx| {
                project.update(cx, |project, cx| project.entries_changed(cx));
                this.apply_path_changes(&changes, cx);
                for (path, text) in rewritten {
                    if let Some(editor) = this
                        .open_editors()
                        .into_iter()
                        .find(|editor| editor.read(cx).relative() == path)
                    {
                        editor.update(cx, |editor, cx| editor.accept_written(text, cx));
                    }
                }
                if let Some(error) = failed {
                    notices::error(t!("Could not move it"), error, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn delete_entries(&mut self, paths: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let deleted = cx.background_spawn({
            let paths = paths.clone();
            async move {
                for path in &paths {
                    core_project::delete_entry(&root, path)?;
                }
                Ok::<_, String>(())
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let deleted = deleted.await;
            this.update_in(cx, |this, window, cx| {
                project.update(cx, |project, cx| project.entries_changed(cx));
                if let Err(error) = &deleted {
                    notices::error(t!("Could not delete it"), error.clone(), cx);
                }
                // Whatever went from disk takes its tabs with it.
                let gone: Vec<_> = this
                    .open_editors()
                    .into_iter()
                    .filter(|editor| {
                        let editor = editor.read(cx);
                        !editor.path().exists()
                            && paths.iter().any(|path| {
                                editor.relative() == path
                                    || editor.relative().starts_with(&format!("{path}/"))
                            })
                    })
                    .collect();
                for editor in gone {
                    editor.update(cx, |editor, _| editor.file_deleted());
                    this.close_editor(&editor, window, cx);
                }
                this.close_deleted_assets(&paths, window, cx);
            })
            .ok();
        })
        .detach();
    }

    /// Everything that names a path follows a rename or move: the open tabs,
    /// the tree's open file and every file's editor place.
    fn apply_path_changes(&mut self, changes: &[(String, String)], cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        place_memory::paths_moved(&root, |file| remap(file, changes), cx);
        crate::editor_panel::table_widths::paths_moved(&root, |file| remap(file, changes), cx);
        for editor in self.open_editors() {
            let relative = editor.read(cx).relative().to_string();
            let Some(moved) = remap(&relative, changes) else {
                continue;
            };
            editor.update(cx, |editor, cx| editor.moved_to(moved.clone(), cx));
            let active = self.active_editor().is_some_and(|active| active == editor);
            if active {
                self.file_tree
                    .update(cx, |tree, cx| tree.set_current(Some(root.join(&moved)), cx));
            }
        }
        self.move_assets(changes, cx);
        cx.notify();
    }
}

/// Where `relative` is after `changes` (each a path and where it went; a
/// folder's change carries what is in it), or `None` when it did not move.
pub(super) fn remap(relative: &str, changes: &[(String, String)]) -> Option<String> {
    changes.iter().find_map(|(from, to)| {
        if relative == from {
            Some(to.clone())
        } else {
            relative
                .strip_prefix(&format!("{from}/"))
                .map(|rest| format!("{to}/{rest}"))
        }
    })
}

/// The project's assets, which a moved document's references are checked
/// against.
fn asset_paths(nodes: &[FileNode]) -> HashSet<String> {
    let mut assets = HashSet::new();
    fn walk(nodes: &[FileNode], assets: &mut HashSet<String>) {
        for node in nodes {
            if node.kind == "directory" {
                walk(&node.children, assets);
            } else if moved_paths::is_asset(&node.path, &node.kind, &node.content_kind) {
                assets.insert(node.path.clone());
            }
        }
    }
    walk(nodes, &mut assets);
    assets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_move_carries_what_is_in_a_folder() {
        let changes = vec![
            ("chapters".to_string(), "parts/chapters".to_string()),
            ("main.tex".to_string(), "paper.tex".to_string()),
        ];
        assert_eq!(
            remap("chapters/intro.tex", &changes).as_deref(),
            Some("parts/chapters/intro.tex")
        );
        assert_eq!(remap("main.tex", &changes).as_deref(), Some("paper.tex"));
        assert_eq!(remap("chapters-old/a.tex", &changes), None);
        assert_eq!(remap("notes.md", &changes), None);
    }
}
