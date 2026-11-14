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
//! - Delete asks first. Only the primary bibliography (or a folder holding
//!   it) is kept, as lattice-core's `delete_entry` keeps it
//!   (`src/project/deletion-protection.ts`): Add paper and the reference
//!   tools write into it, and Delete there says so instead of asking. Any
//!   `.tex` may go, the main document included.
//! - Import files… brings files and folders in from the Mac; ⌘C copies the
//!   selected row's path and ⌘V duplicates it into the selected folder.
//!
//! A file Git sees changed carries its status's colour and letter, and a
//! folder holding one a dot (`TreeRow::git`), read with the project's scans.
//!
//! Its hover is the app's fluid hover (`lattice_ui::fluid_hover`): one fill
//! gliding between rows, never on the open file's row, and dark for 150 ms
//! after a scroll; its scrollbar is Lattice's (`lattice_ui::scrollbar`).

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    rc::Rc,
    time::Duration,
};

use gpui::{
    Anchor, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    input::Input,
    tree::{TreeItem, TreeState, tree},
};
use lattice_core::models::FileNode;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, GlyphKind, Icon, TextRole, TextRoleStyle as _,
    components::{
        ContextMenu, GitMark, IconButton, MenuPopover, Surface, TAB_RADIUS, TreeRow,
        context_menu_trigger,
    },
    fluid_hover::{FluidHover, ItemKind},
    icons::{ICON, file_glyph},
    scrollbar::{FluidScrollbar, ScrollbarFeel},
    shape,
};

mod clipboard;
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
    /// Import files…: choose files and folders to bring into `target`.
    Import {
        target: String,
    },
    /// Duplicate `paths` into `target` (⌘V after the tree's ⌘C).
    Paste {
        paths: Vec<String>,
        target: String,
    },
    /// Save the clipboard's image into `target` (⌘V otherwise, or a
    /// folder's "Paste clipboard image as figure").
    PasteImage {
        target: String,
    },
}

/// A row on its way to another folder.
#[derive(Clone)]
pub struct DraggedEntry {
    path: String,
    name: SharedString,
    folder: bool,
}

impl DraggedEntry {
    /// The row's project-relative path, when it is a file (a folder dragged
    /// out of the tree inserts nothing).
    pub fn file(&self) -> Option<&str> {
        (!self.folder).then_some(self.path.as_str())
    }
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
    /// What Git says of the rows.
    marks: Rc<GitMarks>,
    /// What the tree's ⌘C last put on the clipboard.
    copied: Option<clipboard::Copied>,
    /// The rows' fluid hover, as last drawn, for a scenario's check.
    hover: Option<FluidHover>,
    /// The rows' context menu, as last drawn (for a scripted check).
    row_menu: Option<Entity<ContextMenu<(String, bool)>>>,
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
            hover: None,
            row_menu: None,
            expanded: HashSet::new(),
            marks: Rc::default(),
            copied: None,
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
        self._project_subscription =
            Some(cx.subscribe(&project, |this, _, event, cx| match event {
                ProjectEvent::TreeChanged | ProjectEvent::ManifestChanged => this.rebuild(cx),
                ProjectEvent::GitChanged => {
                    this.read_marks(cx);
                    this.redraw_rows(cx);
                }
                ProjectEvent::FilesChanged(_) => {}
            }));
        self.project = Some(project);
        self.naming = None;
        self.copied = None;
        self.expanded.clear();
        self.rebuild(cx);
    }

    fn read_marks(&mut self, cx: &App) {
        if let Some(project) = &self.project {
            self.marks = Rc::new(GitMarks::new(project.read(cx).git()));
        }
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
        self.read_marks(cx);
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

    /// Whether deleting `path` would remove the primary bibliography, itself
    /// or the folder holding it (`deletesProtectedPath`).
    pub(crate) fn protected(&self, path: &str, cx: &App) -> bool {
        let Some(project) = &self.project else {
            return true;
        };
        deletes_protected(path, &project.read(cx).manifest().primary_bibliography)
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

    /// Select the row at `path` and give the tree the keyboard, as a click
    /// on the row does, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn select_row(&mut self, path: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let id = SharedString::from(path.to_string());
        let Some(ix) = self.state.read(cx).index_of(&id) else {
            return false;
        };
        self.state
            .update(cx, |state, cx| state.set_selected_index(Some(ix), cx));
        window.focus(&self.focus_handle, cx);
        true
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

    /// What the rows' fluid hover shows, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn hover_snapshot(&self, cx: &App) -> Option<lattice_ui::fluid_hover::FluidHoverSnapshot> {
        self.hover.as_ref().map(|hover| hover.snapshot(cx))
    }

    /// Whether the rows' context menu is open and holds focus, for a scripted
    /// check.
    pub fn row_menu_focused(&self, window: &Window, cx: &App) -> bool {
        self.row_menu
            .as_ref()
            .is_some_and(|menu| menu.read(cx).is_focused(window))
    }

    /// The row whose context menu is open (its path), for a scripted check.
    pub fn row_menu_target(&self, cx: &App) -> Option<String> {
        self.row_menu
            .as_ref()
            .and_then(|menu| menu.read(cx).target().map(|(path, _)| path.clone()))
    }
}

/// What Git says of each row: a changed file's mark, and the folders with a
/// change somewhere under them.
#[derive(Default)]
struct GitMarks {
    files: HashMap<String, GitMark>,
    folders: HashSet<String>,
}

impl GitMarks {
    fn new(statuses: &HashMap<String, String>) -> Self {
        let mut marks = GitMarks::default();
        // Each changed file marks its row, and every folder above it.
        for (path, status) in statuses {
            let mark = GitMark::from_status(status);
            marks.files.insert(path.clone(), mark);
            if mark == GitMark::Ignored {
                continue;
            }
            let mut folder = path.as_str();
            while let Some((parent, _)) = folder.rsplit_once('/') {
                marks.folders.insert(parent.to_string());
                folder = parent;
            }
        }
        marks
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
        Some(t!("Project").into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        t!("Project")
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
                    MenuPopover::new(
                        "project-new-entry-menu",
                        IconButton::new("project-new-entry", Icon::PLUS)
                            .radius(TAB_RADIUS)
                            .surface(Surface::Chrome)
                            .tooltip(t!("New…")),
                        move |menu, _, _| Self::new_entries_menu(&view, menu),
                    )
                    .anchor(Anchor::TopRight),
                )
                .child(
                    IconButton::new("project-find", Icon::SEARCH)
                        .radius(TAB_RADIUS)
                        .surface(Surface::Chrome)
                        .tooltip(t!(
                            "{name} — not in the GPUI preview yet",
                            name = t!("Find in project")
                        )),
                ),
        )
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for FileTreePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(project) = self.project.clone() else {
            return div()
                .id("file-tree-empty")
                .track_focus(&self.focus_handle)
                .size_full()
                .px(px(20.))
                .py(px(12.))
                .text_role(TextRole::Body, cx)
                .text_color(cx.palette().text_secondary)
                .child(t!("Open a LaTeX project folder to start"))
                .into_any_element();
        };
        let view = cx.entity().downgrade();
        let menu_view = view.clone();
        let background_view = view.clone();
        // The rows' menu and the empty area's: Lattice's menu at the pointer.
        let row_menu = ContextMenu::<(String, bool)>::keyed("file-tree-row-menu", window, cx);
        let background_menu = ContextMenu::<()>::keyed("file-tree-menu", window, cx);
        let rows_menu = row_menu.clone();
        self.row_menu = Some(row_menu.clone());
        let root_drop = view.clone();
        let current = self.current.clone();
        let root = project.read(cx).root().to_path_buf();
        let naming = self
            .naming
            .as_ref()
            .map(|naming| (naming.path.clone(), naming.input.clone()));
        let drop_target = cx.palette().drop_target;
        let marks = self.marks.clone();
        // The tree's hover is one fill gliding between rows, as the app's
        // (`project-tree-hover.tsx`): the open file's row keeps its own
        // selection fill and is never lit, and rows recycled under a resting
        // pointer stay dark until 150 ms after the scroll.
        let hover = FluidHover::new("file-tree-hover", window, cx)
            .fill(cx.palette().hover)
            .radius(shape::RADIUS_TARGET)
            .quiet_after_scroll(Duration::from_millis(150), cx);
        let rows_hover = hover.clone();
        self.hover = Some(hover.clone());
        let scroll = self.state.read(cx).scroll_handle().clone();
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
            .on_key_down(cx.listener(Self::clipboard_key))
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
            .map(|this| context_menu_trigger(this, &background_menu, ()))
            .children(ContextMenu::layer(
                &background_menu,
                window,
                cx,
                move |menu, _, _, cx| Self::background_menu(&background_view, menu, cx),
            ))
            .children(ContextMenu::layer(
                &row_menu,
                window,
                cx,
                move |menu, (path, folder), _, cx| {
                    Self::row_menu(&menu_view, path.clone(), *folder, menu, cx)
                },
            ))
            .relative()
            .child(hover.highlight())
            .child(
                tree(&self.state, move |ix, entry, selected, _, cx| {
                    let item = entry.item();
                    let relative = item.id.to_string();
                    let path = root.join(&relative);
                    let is_folder = entry.is_folder();
                    let row_selected =
                        !is_folder && (selected || current.as_deref() == Some(path.as_path()));
                    let kind = if row_selected {
                        ItemKind::skip()
                    } else {
                        ItemKind::target()
                    };
                    let mut row = if is_folder {
                        TreeRow::folder(ix, item.label.clone(), entry.depth(), entry.is_expanded())
                            .contains_change(marks.folders.contains(&relative))
                    } else {
                        TreeRow::file(ix, item.label.clone(), entry.depth())
                            .selected(row_selected)
                            .git(marks.files.get(&relative).copied())
                    }
                    .fluid(rows_hover.probe(ix, kind));
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
                    let menu_target = (relative.clone(), is_folder);
                    let item = row.into_list_item(cx);
                    context_menu_trigger(item, &rows_menu, menu_target)
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
                // Lattice's scrollbar, below, in place of Kit's.
                .scrollbar(false),
            )
            .child(
                FluidScrollbar::vertical("file-tree-scrollbar", &scroll).feel(ScrollbarFeel::LIST),
            )
            .into_any_element()
    }
}

/// Whether deleting `path` removes `bibliography` (the manifest's primary
/// bibliography; none when it is empty): the file itself, or a folder
/// holding it.
fn deletes_protected(path: &str, bibliography: &str) -> bool {
    !bibliography.is_empty()
        && (bibliography == path || bibliography.starts_with(&format!("{path}/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_marks_its_file_and_every_folder_above_it() {
        let statuses = HashMap::from([
            (
                "chapters/parts/intro.tex".to_string(),
                "modified".to_string(),
            ),
            ("notes.md".to_string(), "untracked".to_string()),
            ("build/out.log".to_string(), "ignored".to_string()),
        ]);
        let marks = GitMarks::new(&statuses);
        assert_eq!(
            marks.files.get("chapters/parts/intro.tex"),
            Some(&GitMark::Modified)
        );
        assert_eq!(marks.files.get("notes.md"), Some(&GitMark::Untracked));
        assert_eq!(marks.files.get("build/out.log"), Some(&GitMark::Ignored));
        assert!(marks.folders.contains("chapters"));
        assert!(marks.folders.contains("chapters/parts"));
        // An ignored file is no change to its folder.
        assert!(!marks.folders.contains("build"));
    }

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

    #[test]
    fn only_the_primary_bibliography_is_kept_from_delete() {
        assert!(deletes_protected("references.bib", "references.bib"));
        assert!(deletes_protected("refs", "refs/library.bib"));
        // Another bibliography, the main document, a look-alike folder.
        assert!(!deletes_protected("extra.bib", "references.bib"));
        assert!(!deletes_protected("main.tex", "references.bib"));
        assert!(!deletes_protected("ref", "refs/library.bib"));
        // A project with no primary bibliography keeps nothing.
        assert!(!deletes_protected("references.bib", ""));
    }
}
