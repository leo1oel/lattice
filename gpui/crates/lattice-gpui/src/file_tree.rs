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
//! - A row dragged onto a folder (or onto a file, its folder) moves there,
//!   the whole folder lit while it is aimed at (its row, and the rows shown
//!   inside it; the whole tree for the project root). A file's row dragged
//!   past the Project panel is carried on by Trellis (`shell/drops.rs`), and a
//!   figure's row drags on into an editor as a figure.
//! - Files dragged in from Finder land in the folder under the pointer, lit
//!   the same way, as Import files… brings them in.
//! - Delete asks first. Only the primary bibliography (or a folder holding
//!   it) is kept, as lattice-core's `delete_entry` keeps it
//!   (`src/project/deletion-protection.ts`): Add paper and the reference
//!   tools write into it, and Delete there says so instead of asking. Any
//!   `.tex` may go, the main document included.
//! - Import files… brings files and folders in from the Mac, and what came
//!   in is selected and brought into view; ⌘C copies the selected rows'
//!   paths and ⌘V duplicates them into the selected folder.
//! - Enter names the one selected row anew, as Rename does.
//!
//! Rows are selected as the app's are (`selection.rs`): ⌘-click and ⇧-click
//! pick several, which a drag, Delete and ⌘C then take together, and the
//! open file's row is selected, its folders opened and its row brought into
//! view. Which folders are open is kept for each project, and Show hidden
//! files for all of them, across runs (`memory.rs`); until it is on, the
//! tree also leaves out a template's `.sty` and `.bst` files.
//!
//! A file Git sees changed carries its status's colour and letter, and a
//! folder holding one a dot (`TreeRow::git`), read with the project's scans.
//!
//! Its hover is the app's fluid hover (`lattice_ui::fluid_hover`): one fill
//! gliding between rows, never on the open file's row, and dark for 150 ms
//! after a scroll; its scrollbar is Lattice's (`lattice_ui::scrollbar`).

use std::{cell::RefCell, collections::HashSet, path::PathBuf, rc::Rc, time::Duration};

use gpui::{
    Anchor, Animation, AnimationExt as _, App, AppContext as _, Context, DragMoveEvent, Entity,
    EventEmitter, ExternalPaths, FocusHandle, Focusable, InteractiveElement as _, IntoElement,
    KeyDownEvent, ParentElement as _, Pixels, Point, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    input::Input,
    tree::{TreeEvent, TreeState, tree},
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{
        ContextMenu, IconButton, MenuPopover, Surface, TAB_RADIUS, TreeRow, context_menu_trigger,
    },
    fluid_hover::{FluidHover, ItemKind},
    scrollbar::{FluidScrollbar, ScrollbarFeel},
    shape,
};

mod clipboard;
mod dragged;
mod drop_aim;
mod git_marks;
pub(crate) mod memory;
mod menu;
mod naming;
mod probes;
mod rows;
mod selection;

pub use dragged::DraggedEntry;
use dragged::DragPreview;
use drop_aim::{Aim, drop_mark};
use git_marks::GitMarks;
use naming::{Naming, NamingKind, insert_placeholder};
use rows::{hide_template_files, item_ids, tree_items};
use selection::{Selection, including};

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
    /// Files dropped from Finder on the folder `target`.
    DropFiles {
        paths: Vec<PathBuf>,
        target: String,
    },
    /// The file row at `path` dragged out of the tree, the pointer at
    /// `pointer` (window coordinates): the shell may carry it on.
    DragOut {
        path: String,
        pointer: Point<Pixels>,
    },
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
    /// The rows that drag into an editor as a figure.
    figures: Rc<HashSet<String>>,
    /// What the tree's ⌘C last put on the clipboard.
    copied: Option<clipboard::Copied>,
    /// The rows' fluid hover, as last drawn, for a scenario's check.
    hover: Option<FluidHover>,
    /// The rows' context menu, as last drawn (for a scripted check).
    row_menu: Option<Entity<ContextMenu<(String, bool)>>>,
    /// Where a drag over the tree is aimed.
    aim: Rc<RefCell<Aim>>,
    selection: Selection,
    /// Rows to open the folders down to and bring into view once they are
    /// in the tree; `reveal_selects` when they are to be selected too.
    reveal: Option<Vec<String>>,
    reveal_selects: bool,
    /// The open file whose row was last brought into view.
    revealed: Option<String>,
    /// Every row's id, shown or inside a closed folder.
    known: Rc<HashSet<String>>,
    _project_subscription: Option<Subscription>,
    _tree_subscription: Subscription,
}

impl EventEmitter<PanelEvent> for FileTreePanel {}
impl EventEmitter<FileTreeEvent> for FileTreePanel {}

impl FileTreePanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let state = cx.new(|cx| TreeState::new(cx));
        // A folder opened or closed is remembered then, not at the next scan.
        let tree_subscription = cx.subscribe(&state, |this, _, _: &TreeEvent, cx| {
            this.remember_expanded(cx)
        });
        Self {
            project: None,
            current: None,
            state,
            focus_handle: cx.focus_handle(),
            naming: None,
            hover: None,
            row_menu: None,
            expanded: HashSet::new(),
            marks: Rc::default(),
            figures: Rc::default(),
            copied: None,
            aim: Rc::default(),
            selection: Selection::default(),
            reveal: None,
            reveal_selects: false,
            revealed: None,
            known: Rc::default(),
            _project_subscription: None,
            _tree_subscription: tree_subscription,
        }
    }

    pub fn set_current(&mut self, path: Option<PathBuf>, cx: &mut Context<Self>) {
        if self.current != path {
            self.current = path;
            self.follow_current(cx);
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
        // The folders open when this project was last shown come back.
        self.expanded = memory::expanded(project.read(cx).root())
            .into_iter()
            .collect();
        self.project = Some(project);
        self.naming = None;
        self.copied = None;
        self.selection.clear();
        self.reveal = None;
        self.revealed = None;
        self.rebuild(cx);
        self.follow_current(cx);
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
        if !project.read(cx).show_hidden() {
            hide_template_files(&mut nodes);
        }
        if let Some(Naming {
            path,
            kind: NamingKind::Create { folder },
            ..
        }) = &self.naming
        {
            insert_placeholder(&mut nodes, path, *folder);
        }
        self.read_marks(cx);
        self.figures = Rc::new(
            lattice_core::project::tree_files(&nodes)
                .into_iter()
                .filter(|node| node.kind == "figure" || node.content_kind == "binary")
                .map(|node| node.path.clone())
                .collect(),
        );
        let items = tree_items(&nodes, &self.expanded);
        let mut known = HashSet::new();
        item_ids(&items, &mut known);
        self.known = Rc::new(known);
        self.state
            .update(cx, |state, cx| state.set_items(items, cx));
        self.settle_selection(cx);
        cx.notify();
    }

    fn all_paths(&self, _: &App) -> Rc<HashSet<String>> {
        self.known.clone()
    }

    /// Note which folders are open, and keep it for the project.
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
        if let Some(project) = &self.project {
            memory::set_expanded(
                project.read(cx).root(),
                self.expanded.iter().cloned().collect(),
            );
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
        if self.project.is_none() {
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
        }
        let view = cx.entity().downgrade();
        let menu_view = view.clone();
        let background_view = view.clone();
        // The rows' menu and the empty area's: Lattice's menu at the pointer.
        let row_menu = ContextMenu::<(String, bool)>::keyed("file-tree-row-menu", window, cx);
        let background_menu = ContextMenu::<()>::keyed("file-tree-menu", window, cx);
        let rows_menu = row_menu.clone();
        self.row_menu = Some(row_menu.clone());
        let root_drop = view.clone();
        let selected = Rc::new(self.selected_paths(cx));
        let naming = self
            .naming
            .as_ref()
            .map(|naming| (naming.path.clone(), naming.input.clone()));
        let aimed = self.aim.borrow().folder(cx);
        let row_aim = self.aim.clone();
        let marks = self.marks.clone();
        let figures = self.figures.clone();
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
            .on_key_down(cx.listener(Self::rename_key))
            // Each move of a drag aims anew: off every row is the root.
            .on_drag_move({
                let aim = self.aim.clone();
                let view = view.clone();
                move |event: &DragMoveEvent<DraggedEntry>, _, cx| {
                    let inside = event.bounds.contains(&event.event.position);
                    *aim.borrow_mut() = Aim { inside, row: None };
                    let dragged = event.drag(cx);
                    if !inside && dragged.single_file() && !dragged.figure {
                        let (path, pointer) = (dragged.path.clone(), event.event.position);
                        view.update(cx, |_, cx| {
                            cx.emit(FileTreeEvent::DragOut { path, pointer })
                        })
                        .ok();
                    }
                }
            })
            .on_drag_move({
                let aim = self.aim.clone();
                move |event: &DragMoveEvent<ExternalPaths>, _, _| {
                    let inside = event.bounds.contains(&event.event.position);
                    *aim.borrow_mut() = Aim { inside, row: None };
                }
            })
            // A row dropped on the empty area moves to the top level.
            .on_drop({
                let aim = self.aim.clone();
                move |dragged: &DraggedEntry, _, cx| {
                    *aim.borrow_mut() = Aim::default();
                    root_drop
                        .update(cx, |_, cx| {
                            cx.emit(FileTreeEvent::Move {
                                paths: dragged.paths.clone(),
                                target: String::new(),
                            })
                        })
                        .ok();
                }
            })
            .on_drop({
                let view = view.clone();
                let aim = self.aim.clone();
                move |paths: &ExternalPaths, _, cx| {
                    *aim.borrow_mut() = Aim::default();
                    let paths = paths.paths().to_vec();
                    view.update(cx, |_, cx| {
                        cx.emit(FileTreeEvent::DropFiles {
                            paths,
                            target: String::new(),
                        })
                    })
                    .ok();
                }
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
            // A drag aimed at the project root washes the whole tree
            // (`.project-file-tree-surface::after`), fading in.
            .when(aimed.as_deref() == Some(""), |tree| {
                let palette = cx.palette().clone();
                tree.child(
                    div()
                        .absolute()
                        .inset_0()
                        .rounded(px(6.))
                        .bg(palette.accent_soft)
                        .border_1()
                        .border_color(palette.accent.opacity(0.27))
                        .with_animation(
                            "file-tree-root-drop",
                            Animation::new(lattice_ui::motion::Motion::Moderate.duration()),
                            |wash, t| wash.opacity(lattice_ui::motion::Motion::Moderate.sample(t)),
                        ),
                )
            })
            .child(
                tree(&self.state, move |ix, entry, _, _, cx| {
                    let item = entry.item();
                    let relative = item.id.to_string();
                    let is_folder = entry.is_folder();
                    let row_selected = selected.contains(&relative);
                    let kind = if row_selected {
                        ItemKind::skip()
                    } else {
                        ItemKind::target()
                    };
                    let mut row = if is_folder {
                        TreeRow::folder(ix, item.label.clone(), entry.depth(), entry.is_expanded())
                            .selected(row_selected)
                            .contains_change(marks.folders.contains(&relative))
                    } else {
                        TreeRow::file(ix, item.label.clone(), entry.depth())
                            .selected(row_selected)
                            .git(marks.files.get(&relative).copied())
                    }
                    .fluid(rows_hover.probe(ix, kind))
                    .drop_mark(drop_mark(
                        aimed.as_deref(),
                        &relative,
                        is_folder,
                    ));
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
                        paths: including(&selected, &relative),
                        path: relative.clone(),
                        name: item.label.clone(),
                        folder: is_folder,
                        figure: figures.contains(&relative),
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
                    let click_path = relative.clone();
                    let drop = view.clone();
                    let paths_drop = view.clone();
                    let entry_aim = row_aim.clone();
                    let paths_aim = row_aim.clone();
                    let entry_drop_aim = row_aim.clone();
                    let paths_drop_aim = row_aim.clone();
                    let (entry_target, paths_target) = (target.clone(), target.clone());
                    let files_target = target.clone();
                    let menu_target = (relative.clone(), is_folder);
                    let item = row.into_list_item(cx);
                    context_menu_trigger(item, &rows_menu, menu_target)
                        .on_drag(dragged, |dragged, _, _, cx| {
                            cx.new(|_| DragPreview(dragged.clone()))
                        })
                        .on_drag_move(move |event: &DragMoveEvent<DraggedEntry>, _, _| {
                            if event.bounds.contains(&event.event.position) {
                                entry_aim.borrow_mut().row = Some(entry_target.clone());
                            }
                        })
                        .on_drag_move(move |event: &DragMoveEvent<ExternalPaths>, _, _| {
                            if event.bounds.contains(&event.event.position) {
                                paths_aim.borrow_mut().row = Some(paths_target.clone());
                            }
                        })
                        .on_drop(move |paths: &ExternalPaths, _, cx| {
                            cx.stop_propagation();
                            *paths_drop_aim.borrow_mut() = Aim::default();
                            let (paths, target) = (paths.paths().to_vec(), files_target.clone());
                            paths_drop
                                .update(cx, |_, cx| {
                                    cx.emit(FileTreeEvent::DropFiles { paths, target })
                                })
                                .ok();
                        })
                        .on_drop(move |dragged: &DraggedEntry, _, cx| {
                            cx.stop_propagation();
                            *entry_drop_aim.borrow_mut() = Aim::default();
                            // Nothing moves into itself; the rest still go.
                            let paths: Vec<String> = dragged
                                .paths
                                .iter()
                                .filter(|path| **path != target)
                                .cloned()
                                .collect();
                            if paths.is_empty() {
                                return;
                            }
                            drop.update(cx, |_, cx| {
                                cx.emit(FileTreeEvent::Move {
                                    paths,
                                    target: target.clone(),
                                })
                            })
                            .ok();
                        })
                        .on_click(move |event, window, cx| {
                            open.update(cx, |this, cx| {
                                this.click_row(&click_path, is_folder, event, window, cx)
                            })
                            .ok();
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
