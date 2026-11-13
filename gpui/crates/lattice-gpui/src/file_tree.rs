//! The project folder as a tree, on GPUI Kit's tree component, drawn as the
//! Tauri app's Project panel: 28px rows with each file's own glyph, the open
//! file's row selected.
//!
//! The tree is the one lattice-core scans for the Tauri app's Project pane
//! (`project::scan_tree`), so the same files are hidden (build output,
//! dotfiles, app state) and Show hidden files brings back the same ones. Its
//! file operations are the Tauri app's (`src/project/project-file-tree.tsx`,
//! `project-tree-inline-create.ts`, `src/app/use-project-tree.ts`):
//!
//! - New file and New folder add an "untitled" row in the folder, named in
//!   place: Enter creates it (a file without an extension becomes `.tex`),
//!   Escape or leaving it unchanged drops it. A new file opens.
//! - Rename names a row in place; the open tab follows the file.
//! - A row dragged onto a folder (or onto a file, its folder) moves there.
//! - Delete asks first, and is not offered for the main document or the
//!   bibliography (or a folder holding either).

use std::{collections::HashSet, path::PathBuf};

use gpui::{
    Anchor, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    input::Input,
    menu::{ContextMenuExt as _, DropdownMenu as _, PopupMenu},
    tree::{TreeItem, TreeState, tree},
};
use lattice_core::models::FileNode;
use lattice_ui::{
    ActiveLattice as _, GlyphKind, Icon, TextRole, TextRoleStyle as _,
    components::{IconButton, Surface, TAB_RADIUS, TreeRow},
    icons::{ICON, file_glyph},
};

mod menu;
mod naming;

use naming::{Naming, NamingKind, insert_placeholder};

use crate::project::{Project, ProjectEvent};

/// What the tree asks the shell to do.
pub enum FileTreeEvent {
    Open(PathBuf),
    /// Rename the entry at `path` (project-relative) to `name`.
    Rename {
        path: String,
        name: String,
    },
    /// Move `paths` into `target` ("" is the project's top level).
    Move {
        paths: Vec<String>,
        target: String,
    },
    /// Create an entry at `path`: a file (opened once made) or a folder.
    Create {
        path: String,
        folder: bool,
    },
    /// Delete `paths`, already confirmed.
    Delete(Vec<String>),
}

/// A row on its way to another folder.
#[derive(Clone)]
pub struct DraggedEntry {
    path: String,
    name: SharedString,
    folder: bool,
}

/// What the dragged row looks like under the pointer: its glyph and name on
/// the lifted surface.
struct DragPreview(DraggedEntry);

impl Render for DragPreview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let glyph = if self.0.folder {
            GlyphKind::Folder
        } else {
            GlyphKind::for_name(&self.0.name)
        };
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .h(px(28.))
            .px(px(8.))
            .rounded(px(6.))
            .bg(palette.raised)
            .shadow(lattice_ui::Elevation::Popover.shadows(&palette))
            .text_role(TextRole::Body, cx)
            .text_color(palette.text)
            .child(file_glyph(glyph, ICON, &palette))
            .child(self.0.name.clone())
    }
}

pub struct FileTreePanel {
    project: Option<Entity<Project>>,
    /// The file open in the editor, whose row is drawn selected.
    current: Option<PathBuf>,
    state: Entity<TreeState>,
    focus_handle: FocusHandle,
    naming: Option<Naming>,
    /// Folders the writer opened, kept across rescans.
    expanded: HashSet<String>,
    _project_subscription: Option<Subscription>,
}

impl EventEmitter<PanelEvent> for FileTreePanel {}
impl EventEmitter<FileTreeEvent> for FileTreePanel {}

impl FileTreePanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            project: None,
            current: None,
            state: cx.new(|cx| TreeState::new(cx)),
            focus_handle: cx.focus_handle(),
            naming: None,
            expanded: HashSet::new(),
            _project_subscription: None,
        }
    }

    pub fn set_current(&mut self, path: Option<PathBuf>, cx: &mut Context<Self>) {
        if self.current != path {
            self.current = path;
            self.redraw_rows(cx);
        }
    }

    /// Draw the rows again: Kit's tree draws them in a view of its own,
    /// replayed until it is told otherwise, so a change only this panel holds
    /// (the open file, a row being named) reaches the rows through it.
    fn redraw_rows(&self, cx: &mut Context<Self>) {
        self.state.update(cx, |_, cx| cx.notify());
        cx.notify();
    }

    pub fn set_project(&mut self, project: Entity<Project>, cx: &mut Context<Self>) {
        self._project_subscription = Some(cx.subscribe(&project, |this, _, event, cx| {
            if matches!(
                event,
                ProjectEvent::TreeChanged | ProjectEvent::ManifestChanged
            ) {
                this.rebuild(cx);
            }
        }));
        self.project = Some(project);
        self.naming = None;
        self.expanded.clear();
        self.rebuild(cx);
    }

    /// Scan the folder again, for a change the watcher could not see.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if let Some(project) = &self.project {
            project.update(cx, |project, cx| project.rescan(cx));
        }
    }

    /// Lay the project's files out as the tree's items, with the row being
    /// created among them, keeping which folders are open.
    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let Some(project) = self.project.clone() else {
            return;
        };
        self.remember_expanded(cx);
        let mut nodes = project.read(cx).files().to_vec();
        if let Some(Naming {
            path,
            kind: NamingKind::Create { folder },
            ..
        }) = &self.naming
        {
            insert_placeholder(&mut nodes, path, *folder);
        }
        let items = tree_items(&nodes, &self.expanded);
        self.state
            .update(cx, |state, cx| state.set_items(items, cx));
        cx.notify();
    }

    fn remember_expanded(&mut self, cx: &App) {
        let state = self.state.read(cx);
        for entry in (0..).map_while(|ix| state.entry(ix)) {
            if !entry.is_folder() {
                continue;
            }
            let id = entry.item().id.to_string();
            if entry.is_expanded() {
                self.expanded.insert(id);
            } else {
                self.expanded.remove(&id);
            }
        }
    }

    /// Paths that may not be deleted: the main document, the bibliography,
    /// and any folder holding either.
    fn protected(&self, path: &str, cx: &App) -> bool {
        let Some(project) = &self.project else {
            return true;
        };
        let project = project.read(cx);
        let manifest = project.manifest();
        project
            .main_document()
            .into_iter()
            .chain(Some(manifest.primary_bibliography.as_str()))
            .filter(|protected| !protected.is_empty())
            .any(|protected| protected == path || protected.starts_with(&format!("{path}/")))
    }

    /// Drop the row at `path` on the folder `target`, as a drag ending there
    /// does, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn drop_on(&mut self, path: String, target: String, cx: &mut Context<Self>) {
        cx.emit(FileTreeEvent::Move {
            paths: vec![path],
            target,
        });
    }

    /// The row being named, its field's text and whether the field has
    /// focus, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn naming_state(&self, window: &Window, cx: &App) -> Option<(String, String, bool)> {
        self.naming.as_ref().map(|naming| {
            let input = naming.input.read(cx);
            (
                naming.path.clone(),
                input.value().to_string(),
                input.focus_handle(cx).is_focused(window),
            )
        })
    }

    /// Give the row being named `name` and confirm it as Enter does, for a
    /// scenario. Typing into the field is GPUI Kit's own, and takes a window
    /// that draws: a scripted run on a locked screen gets no frames.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn confirm_name(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = self.naming.as_ref().map(|naming| naming.input.clone()) else {
            return;
        };
        input.update(cx, |input, cx| {
            input.set_value(name.to_string(), window, cx)
        });
        self.commit_naming(true, window, cx);
    }

    /// The rows on screen, project-relative, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn row_paths(&self, cx: &App) -> Vec<String> {
        let state = self.state.read(cx);
        (0..)
            .map_while(|ix| state.entry(ix))
            .map(|entry| entry.item().id.to_string())
            .collect()
    }
}

/// The tree's rows. A folder whose only entry is a folder shows as one row
/// with its descendant, down the chain, as the Tauri app's tree flattens
/// them (`flattenEmptyDirectories`): "slides / understanding-attention",
/// which stands for the deepest folder (its id, its children, opening,
/// renaming and dropping into it).
fn tree_items(nodes: &[FileNode], expanded: &HashSet<String>) -> Vec<TreeItem> {
    nodes
        .iter()
        .map(|node| {
            if node.kind != "directory" {
                return TreeItem::new(node.path.clone(), node.name.clone());
            }
            let (deepest, label) = flattened(node);
            TreeItem::new(deepest.path.clone(), label)
                .children(tree_items(&deepest.children, expanded))
                .expanded(expanded.contains(&deepest.path))
        })
        .collect()
}

/// A folder and the chain of single folders under it: the deepest one and
/// the names on the way, joined by "/".
fn flattened(node: &FileNode) -> (&FileNode, String) {
    let mut deepest = node;
    let mut label = node.name.clone();
    while let [only] = deepest.children.as_slice() {
        if only.kind != "directory" {
            break;
        }
        label.push('/');
        label.push_str(&only.name);
        deepest = only;
    }
    (deepest, label)
}

impl Focusable for FileTreePanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for FileTreePanel {
    fn panel_name(&self) -> &'static str {
        "FileTreePanel"
    }

    /// Its tab's X takes it off screen, as the Tauri app's does; the Panels
    /// menu brings it back.
    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for FileTreePanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some("Project".into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        "Project"
    }

    fn dropdown_menu(
        &mut self,
        menu: PopupMenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        let view = cx.entity().downgrade();
        Self::background_menu(&view, menu, cx)
    }

    /// The strip's tools before ⋯, as the Tauri app's Project panel has them
    /// (`trellis-panel-actions.tsx`): + opens what can be added, and Find in
    /// project, which is not in the GPUI app yet. Each is a 28px square on
    /// the panel's chrome with the tab's corners, a hairline apart
    /// (`.trellis-accessory-host`).
    fn title_suffix(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let view = cx.entity().downgrade();
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(1.))
                .child(
                    IconButton::new("project-new-entry", Icon::PLUS)
                        .radius(TAB_RADIUS)
                        .surface(Surface::Chrome)
                        .tooltip("New…")
                        .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, _, _| {
                            Self::new_entries_menu(&view, menu)
                        }),
                )
                .child(
                    IconButton::new("project-find", Icon::SEARCH)
                        .radius(TAB_RADIUS)
                        .surface(Surface::Chrome)
                        .tooltip("Find in project — not in the GPUI preview yet"),
                ),
        )
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for FileTreePanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(project) = self.project.clone() else {
            return div()
                .id("file-tree-empty")
                .track_focus(&self.focus_handle)
                .size_full()
                .px(px(20.))
                .py(px(12.))
                .text_role(TextRole::Body, cx)
                .text_color(cx.palette().text_secondary)
                .child("Open a LaTeX project folder to start")
                .into_any_element();
        };
        let view = cx.entity().downgrade();
        let menu_view = view.clone();
        let background_view = view.clone();
        let root_drop = view.clone();
        let current = self.current.clone();
        let root = project.read(cx).root().to_path_buf();
        let naming = self
            .naming
            .as_ref()
            .map(|naming| (naming.path.clone(), naming.input.clone()));
        let drop_target = cx.palette().drop_target;
        // Measured on the Main window: rows 12px in from both sides, the
        // first 7px under the tab strip.
        div()
            .id("file-tree")
            .key_context("LatticeFileTree")
            .track_focus(&self.focus_handle)
            .size_full()
            .pt(px(7.))
            .px(px(12.))
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" && this.naming.is_some() {
                    cx.stop_propagation();
                    this.cancel_naming(window, cx);
                }
            }))
            // A row dropped on the empty area moves to the top level.
            .on_drop(move |dragged: &DraggedEntry, _, cx| {
                root_drop
                    .update(cx, |_, cx| {
                        cx.emit(FileTreeEvent::Move {
                            paths: vec![dragged.path.clone()],
                            target: String::new(),
                        })
                    })
                    .ok();
            })
            .context_menu(move |menu, _, cx| Self::background_menu(&background_view, menu, cx))
            .child(
                tree(&self.state, move |ix, entry, selected, _, cx| {
                    let item = entry.item();
                    let relative = item.id.to_string();
                    let path = root.join(&relative);
                    let is_folder = entry.is_folder();
                    let mut row = if is_folder {
                        TreeRow::folder(ix, item.label.clone(), entry.depth(), entry.is_expanded())
                    } else {
                        TreeRow::file(ix, item.label.clone(), entry.depth())
                            .selected(selected || current.as_deref() == Some(path.as_path()))
                    };
                    if let Some((_, input)) = naming.as_ref().filter(|(at, _)| *at == relative) {
                        // The app's rename field: 20px on the compact
                        // corner, its padding and border outside the name's
                        // left edge, so the name stays where it was.
                        let palette = cx.palette().clone();
                        row = row.editing(
                            div()
                                .flex()
                                .items_center()
                                .h(px(20.))
                                .ml(px(-9.))
                                .px(px(8.))
                                .rounded(px(4.))
                                .border_1()
                                .border_color(palette.field_border_hover)
                                .bg(palette.input)
                                .text_role(TextRole::Body, cx)
                                .text_color(palette.text)
                                .child(
                                    Input::new(input).appearance(false).px_0().py_0().h(px(18.)),
                                ),
                        );
                    }
                    // Parity regions are named by the path from the project
                    // root, as the app's tree names its rows (`data-item-path`).
                    if lattice_ui::parity::enabled() {
                        row = row.parity(format!("row/{relative}"));
                    }
                    let dragged = DraggedEntry {
                        path: relative.clone(),
                        name: item.label.clone(),
                        folder: is_folder,
                    };
                    // A drop on a folder moves into it; on a file, into the
                    // file's folder.
                    let target = if is_folder {
                        relative.clone()
                    } else {
                        relative
                            .rsplit_once('/')
                            .map(|(parent, _)| parent.to_string())
                            .unwrap_or_default()
                    };
                    let open = view.clone();
                    let drop = view.clone();
                    row.into_list_item(cx)
                        .on_drag(dragged, |dragged, _, _, cx| {
                            cx.new(|_| DragPreview(dragged.clone()))
                        })
                        .drag_over::<DraggedEntry>(move |style, _, _, _| style.bg(drop_target))
                        .on_drop(move |dragged: &DraggedEntry, _, cx| {
                            cx.stop_propagation();
                            if dragged.path == target {
                                return;
                            }
                            drop.update(cx, |_, cx| {
                                cx.emit(FileTreeEvent::Move {
                                    paths: vec![dragged.path.clone()],
                                    target: target.clone(),
                                })
                            })
                            .ok();
                        })
                        .on_click(move |_, _, cx| {
                            if !is_folder {
                                open.update(cx, |_, cx| cx.emit(FileTreeEvent::Open(path.clone())))
                                    .ok();
                            }
                        })
                })
                .context_menu(move |_, entry, menu, _, cx| {
                    Self::row_menu(
                        &menu_view,
                        entry.item().id.to_string(),
                        entry.is_folder(),
                        menu,
                        cx,
                    )
                }),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(path: &str, kind: &str, children: Vec<FileNode>) -> FileNode {
        FileNode {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            content_kind: String::new(),
            size: 0,
            children,
        }
    }

    #[test]
    fn a_chain_of_single_folders_is_one_row_for_the_deepest() {
        let deck = node(
            "slides/understanding-attention",
            "directory",
            vec![node(
                "slides/understanding-attention/index.tsx",
                "file",
                vec![],
            )],
        );
        let slides = node("slides", "directory", vec![deck]);
        let (deepest, label) = flattened(&slides);
        assert_eq!(deepest.path, "slides/understanding-attention");
        assert_eq!(label, "slides/understanding-attention");
        let items = tree_items(&[slides], &HashSet::new());
        assert_eq!(items[0].id.as_ref(), "slides/understanding-attention");
    }

    #[test]
    fn a_folder_holding_a_file_stays_its_own_row() {
        let chapters = node(
            "chapters",
            "directory",
            vec![node("chapters/intro.tex", "file", vec![])],
        );
        assert_eq!(flattened(&chapters).1, "chapters");
        let two = node(
            "figures",
            "directory",
            vec![
                node("figures/a", "directory", vec![]),
                node("figures/b", "directory", vec![]),
            ],
        );
        assert_eq!(flattened(&two).1, "figures");
    }
}
