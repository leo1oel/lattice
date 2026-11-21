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
//! A letter typed in the tree filters it (`search.rs`), an open folder
//! scrolled past stays pinned at the top (`sticky.rs`), and a folder opening
//! or closing moves as the app's does (`motion.rs`); the panel is drawn in
//! `view.rs`.
//!
//! A file Git sees changed carries its status's colour and letter, and a
//! folder holding one a dot (`TreeRow::git`), read with the project's scans.
//!
//! Its hover is the app's fluid hover (`lattice_ui::fluid_hover`): one fill
//! gliding between rows, never on the open file's row, and dark for 150 ms
//! after a scroll; its scrollbar is Lattice's (`lattice_ui::scrollbar`).

use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    path::PathBuf,
    rc::Rc,
};

use gpui::{
    Anchor, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    IntoElement, ParentElement as _, Pixels, Point, SharedString, Styled as _, Subscription,
    Window, div, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    tree::{TreeEvent, TreeState},
};
use lattice_i18n::t;
use lattice_ui::{
    Icon,
    components::{ContextMenu, IconButton, MenuPopover, Surface, TAB_RADIUS},
    fluid_hover::FluidHover,
};

mod clipboard;
mod dragged;
mod drop_aim;
mod git_marks;
pub(crate) mod memory;
mod menu;
mod motion;
mod naming;
pub(crate) mod new_entries;
mod probes;
mod rows;
mod search;
mod selection;
mod sticky;
mod view;

use dragged::DragPreview;
pub use dragged::DraggedEntry;
use drop_aim::Aim;
use git_marks::GitMarks;
use naming::{Naming, NamingKind, insert_placeholder};
use rows::{hide_template_files, item_ids, tree_items};
use selection::{Selection, including};

use crate::project::{Project, ProjectEvent};

/// What the tree asks the shell to do.
pub enum FileTreeEvent {
    /// A row's click: a quick look at the file (its panel's preview tab).
    Open(PathBuf),
    /// A row's double-click: the file's tab kept.
    Keep(PathBuf),
    /// Rename the entry at `path` (project-relative) to `name`.
    Rename { path: String, name: String },
    /// Move `paths` into `target` ("" is the project's top level).
    Move { paths: Vec<String>, target: String },
    /// Create an entry at `path`: a file (opened once made) or a folder.
    Create { path: String, folder: bool },
    /// Create the slide deck `id` under `slides/`, and open it.
    CreateDeck { id: String },
    /// Open the project's find (the strip's Find in project).
    FindInProject,
    /// Delete `paths`, already confirmed.
    Delete(Vec<String>),
    /// Import files…: choose files and folders to bring into `target`.
    Import { target: String },
    /// Duplicate `paths` into `target` (⌘V after the tree's ⌘C).
    Paste { paths: Vec<String>, target: String },
    /// Save the clipboard's image into `target` (⌘V otherwise, or a
    /// folder's "Paste clipboard image as figure").
    PasteImage { target: String },
    /// Files dropped from Finder on the folder `target`.
    DropFiles { paths: Vec<PathBuf>, target: String },
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
    /// Whether the press going down landed on a row, pinned or not; a press
    /// on the tree that landed on none clears the selection.
    pressed_row: Rc<Cell<bool>>,
    selection: Selection,
    /// Rows to open the folders down to and bring into view once they are
    /// in the tree; `reveal_selects` when they are to be selected too.
    reveal: Option<Vec<String>>,
    reveal_selects: bool,
    /// The open file whose row was last brought into view.
    revealed: Option<String>,
    /// Every row's id, shown or inside a closed folder.
    known: Rc<HashSet<String>>,
    /// The type-to-filter field, while it is open (`search.rs`).
    search: Option<search::TreeSearch>,
    /// Whether Kit's tree holds a search's rows, whose folders the search
    /// opened, so they are not the writer's to remember.
    filtered: bool,
    /// A folder opening or closing, while it moves (`motion.rs`).
    motion: Option<motion::TreeMotion>,
    _project_subscription: Option<Subscription>,
    _tree_subscription: Subscription,
}

impl EventEmitter<PanelEvent> for FileTreePanel {}
impl EventEmitter<FileTreeEvent> for FileTreePanel {}

impl FileTreePanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let state = cx.new(|cx| TreeState::new(cx));
        // A folder opened or closed is remembered then, not at the next scan.
        // It moves as it opens or closes, but not under a search's query,
        // which opens and closes folders itself.
        let tree_subscription = cx.subscribe(&state, |this, _, event: &TreeEvent, cx| {
            match event {
                TreeEvent::Expanded(id) if this.search_query().is_none() => {
                    this.begin_motion(id, true, cx)
                }
                TreeEvent::Collapsed(id) if this.search_query().is_none() => {
                    this.begin_motion(id, false, cx)
                }
                _ => {}
            }
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
            pressed_row: Rc::default(),
            selection: Selection::default(),
            reveal: None,
            reveal_selects: false,
            revealed: None,
            known: Rc::default(),
            search: None,
            filtered: false,
            motion: None,
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
                ProjectEvent::TreeChanged => {
                    this.rebuild(cx);
                    this.reveal_scanned(cx);
                }
                ProjectEvent::ManifestChanged => this.rebuild(cx),
                ProjectEvent::GitChanged => {
                    this.read_marks(cx);
                    this.redraw_rows(cx);
                }
                ProjectEvent::FilesChanged(_) => {}
            }));
        // The folders open when this project was last shown come back, and
        // Kit's tree lets go of the last project's rows first: the rebuild
        // notes which of the rows it holds are open, and those are not this
        // project's.
        self.state
            .update(cx, |state, cx| state.set_items(Vec::new(), cx));
        self.expanded = memory::expanded(project.read(cx).root())
            .into_iter()
            .collect();
        self.project = Some(project);
        self.naming = None;
        self.copied = None;
        self.selection.clear();
        self.reveal = None;
        self.reveal_selects = false;
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
        self.adopt_kit_row(cx);
        self.remember_expanded(cx);
        let mut nodes = project.read(cx).files().to_vec();
        if !project.read(cx).show_hidden() {
            hide_template_files(&mut nodes);
        }
        if let Some(Naming {
            path,
            kind: NamingKind::Create { making },
            ..
        }) = &self.naming
        {
            insert_placeholder(&mut nodes, path, making.folder);
        }
        self.read_marks(cx);
        self.figures = Rc::new(
            lattice_core::project::tree_files(&nodes)
                .into_iter()
                .filter(|node| node.kind == "figure" || node.content_kind == "binary")
                .map(|node| node.path.clone())
                .collect(),
        );
        // While the field holds a query only its matches and their folders
        // show, opened; the folders the writer opened wait until it closes.
        let all = tree_items(&nodes, &self.expanded);
        let mut known = HashSet::new();
        item_ids(&all, &mut known);
        self.known = Rc::new(known);
        self.filtered = self.search_query().is_some();
        let items = match self.search_query() {
            Some(query) => {
                let mut open = HashSet::new();
                let nodes = search::filter_nodes(&nodes, query, &mut open);
                tree_items(&nodes, &open)
            }
            None => all,
        };
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
        if self.filtered {
            return;
        }
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
    /// project opens the project's find. Each is a 28px square on
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
                            .surface(Surface::SidePanel)
                            .tooltip(t!("New…")),
                        move |menu, _, _| Self::new_entries_menu(&view, menu),
                    )
                    .anchor(Anchor::TopRight),
                )
                .child(
                    IconButton::new("project-find", Icon::SEARCH)
                        .radius(TAB_RADIUS)
                        .surface(Surface::SidePanel)
                        .tooltip(t!("Find in project"))
                        .on_click(
                            cx.listener(|this, _, window, cx| this.find_in_project(window, cx)),
                        ),
                ),
        )
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
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
