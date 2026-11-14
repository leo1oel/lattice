//! The tool panels in the window: History, the manuscript's TODOs and the
//! submission checklist open where the Tauri app opens a drawer's tool
//! panel, and what they ask of the window (open a file at a line); and the
//! arXiv export and figure inventory sheets over the window
//! (`crate::submission::arxiv`, `crate::submission::figures`).
//!
//! `reveal_tool` is the Tauri app's `revealTool`
//! (`src/trellis/trellis-controller.ts`): the tool opens as a tab of the
//! documents' panel, or, already in the layout elsewhere, moves there and
//! comes forward; a hidden one is restored; focus mode ends first.

use std::rc::Rc;

use gpui::{AppContext as _, Context, Entity, Subscription, Task, Window, actions};
use trellis::model::Placement;
use trellis::runtime::engine::{OpenOptions, ViewPlacement};

use super::Shell;
use crate::submission::{
    arxiv::{ArxivEvent, ArxivExportSheet},
    checklist::ChecklistPanel,
    figures::{FigureInventory, FigureUndo, FiguresEvent},
    todos::{TodosEvent, TodosPanel},
};

actions!(lattice, [OpenTodos, OpenChecklist, ExportArxiv]);

/// The sheets the submission tools put over the window, while open, and
/// the figure writes that can be undone in the window's project: all of it
/// goes when the window opens another project.
#[derive(Default)]
pub(crate) struct Sheets {
    /// What's new (`help_flow`), which is no project's and stays open when
    /// the window opens another.
    pub(crate) whats_new: Option<(Entity<crate::help::whats_new::WhatsNewSheet>, Subscription)>,
    pub(crate) arxiv: Option<(Entity<ArxivExportSheet>, Subscription)>,
    pub(crate) figures: Option<(Entity<FigureInventory>, Subscription)>,
    pub(crate) figure_undo: FigureUndo,
}

impl Sheets {
    /// Another project opened in the window: its sheets and figure undo go.
    pub(crate) fn project_changed(&mut self) {
        let whats_new = self.whats_new.take();
        *self = Self {
            whats_new,
            ..Self::default()
        };
    }
}

/// Every file in the project tree.
fn files_of(nodes: &[lattice_core::models::FileNode], out: &mut Vec<String>) {
    for node in nodes {
        if !matches!(node.kind.as_str(), "directory" | "symlink") {
            out.push(node.path.clone());
        }
        files_of(&node.children, out);
    }
}

impl Shell {
    /// The window's TODOs and checklist panels, each telling the window what
    /// it asks of it.
    pub(super) fn tool_panels(
        build: &Entity<crate::build_panel::BuildPanel>,
        pdf: &Entity<crate::pdf::PdfPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Entity<TodosPanel>, Entity<ChecklistPanel>) {
        let todos = cx.new(TodosPanel::new);
        let checklist = cx.new(|cx| ChecklistPanel::new(build.clone(), pdf.clone(), window, cx));
        cx.subscribe_in(&checklist, window, |this, _, event, window, cx| {
            this.on_checklist_event(event, window, cx)
        })
        .detach();
        cx.subscribe_in(&todos, window, |this, _, event, window, cx| {
            this.on_todos_event(event, window, cx)
        })
        .detach();
        (todos, checklist)
    }

    /// A project opened in the window: the tools read it.
    pub(super) fn tools_project_opened(
        &mut self,
        project: &Entity<crate::project::Project>,
        root: &std::path::Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let root = root.to_path_buf();
        self.todos
            .update(cx, |todos, cx| todos.set_root(Some(root), cx));
        self.checklist.update(cx, |checklist, cx| {
            checklist.set_project(project.clone(), window, cx)
        });
    }

    /// Bring the tool `kind` (a singleton view) on screen, as a tab of the
    /// documents' panel. False without a project, when nothing opens.
    pub(crate) fn reveal_tool(
        &mut self,
        kind: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.project.is_none() {
            return false;
        }
        if self.layout.focus.is_some() {
            self.set_focus_mode(false, window, cx);
        }
        let anchor = self.document_panel_of_layout(cx);
        match self.placement(kind, cx) {
            Some((ViewPlacement::Hidden, ..)) => self.show_view(kind, true, window, cx),
            Some(_) => {
                let panel = self.panel_holding(kind, cx);
                // Asked for again, it follows the same placement rule rather
                // than leaving focus on a distant old place.
                if let Some(anchor) = anchor.filter(|anchor| Some(anchor) != panel.as_ref()) {
                    self.engine_do(cx, |engine| {
                        engine.dock(
                            kind,
                            Some(trellis::model::DockTarget::Into {
                                into: anchor,
                                index: None,
                            }),
                        )
                    });
                }
                self.engine_do(cx, |engine| engine.focus(kind));
            }
            None => {
                let placement = match anchor {
                    Some(into) => Placement::Into { into, index: None },
                    None => self.home_of(kind, cx),
                };
                self.engine_do(cx, |engine| {
                    engine.open(
                        kind,
                        OpenOptions {
                            id: Some(kind.into()),
                            placement: Some(placement),
                            focus: Some(true),
                            ..OpenOptions::default()
                        },
                    )
                });
            }
        }
        cx.notify();
        true
    }

    /// The manuscript's TODOs (the palette's "Manuscript TODOs", the status
    /// bar's counter).
    pub(crate) fn open_todos(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reveal_tool("todos", window, cx);
    }

    /// The submission checklist (the palette's "Submission checklist"),
    /// its counts and disk checks read again as it comes forward.
    pub(crate) fn open_checklist(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.reveal_tool("checklist", window, cx) {
            self.checklist
                .update(cx, |checklist, cx| checklist.refresh(cx));
        }
    }

    pub(crate) fn on_checklist_event(
        &mut self,
        event: &crate::submission::checklist::ChecklistEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use crate::submission::checklist::ChecklistEvent;
        match event {
            // TODOs open beside the checklist, as a tab in its panel.
            ChecklistEvent::OpenTodos => self.open_todos(window, cx),
            ChecklistEvent::OpenFigures => self.open_figure_inventory(window, cx),
            ChecklistEvent::Open { path, line } => {
                let Some(root) = self.root(cx) else { return };
                self.open_path(root.join(path), *line, window, cx);
            }
            ChecklistEvent::OpenUrl(url) => cx.open_url(url),
        }
    }

    /// The figure inventory, from the checklist: the sheet over the window,
    /// reading the editor in front as it stands; a file opened from it
    /// closes it.
    pub(crate) fn open_figure_inventory(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else { return };
        if self.sheets.figures.is_some() {
            return;
        }
        let mut paths = Vec::new();
        if let Some(project) = &self.project {
            files_of(project.read(cx).files(), &mut paths);
        }
        let overlay = self.active_editor().map(|editor| {
            let editor = editor.read(cx);
            (
                editor.relative().to_string(),
                editor.editor().read(cx).text(cx),
            )
        });
        let shell = cx.entity().downgrade();
        let save: crate::submission::figures::SaveEdits = Rc::new(move |cx| {
            shell
                .update(cx, |shell, cx| shell.save_before_leaving(cx))
                .ok()
                .flatten()
                .unwrap_or_else(|| Task::ready(true))
        });
        let undo = self.sheets.figure_undo.clone();
        let sheet = cx.new(|cx| FigureInventory::new(root, paths, overlay, save, undo, cx));
        let subscription = cx.subscribe_in(&sheet, window, |this, _, event, window, cx| {
            this.sheets.figures = None;
            match event {
                // Back to the checklist it was opened from, as the Tauri
                // app's dialogs return focus; the document behind the
                // checklist's tab is not drawn to take it.
                FiguresEvent::Close if this.view_on_screen("checklist", cx) => {
                    this.focus_view_content("checklist", window, cx)
                }
                FiguresEvent::Close => this.focus_front(window, cx),
                FiguresEvent::Open { path, line } => {
                    if let Some(root) = this.root(cx) {
                        this.open_path(root.join(path), *line, window, cx);
                    }
                }
            }
            cx.notify();
        });
        self.sheets.figures = Some((sheet, subscription));
        cx.notify();
    }

    pub(crate) fn on_todos_event(
        &mut self,
        event: &TodosEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            TodosEvent::Open { path, line } => {
                let Some(root) = self.root(cx) else { return };
                self.open_path(root.join(path), Some(*line), window, cx);
            }
        }
    }

    /// Export for arXiv… (the palette): the sheet over the window, which
    /// saves the open edits before each check and builds a project never
    /// built here.
    pub(crate) fn open_arxiv_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else { return };
        if self.sheets.arxiv.is_some() {
            return;
        }
        let name = self.project_name(cx).to_string();
        let shell = cx.entity().downgrade();
        let save: crate::submission::arxiv::SaveEdits = Rc::new({
            let shell = shell.clone();
            move |cx| {
                shell
                    .update(cx, |shell, cx| shell.save_before_leaving(cx))
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| Task::ready(true))
            }
        });
        let build: crate::submission::arxiv::BuildPaper = Rc::new(move |window, cx| {
            shell
                .update(cx, |shell, cx| shell.build_and_settle(window, cx))
                .unwrap_or_else(|_| Task::ready(()))
        });
        let sheet = cx.new(|cx| ArxivExportSheet::new(root, name, save, build, cx));
        // Closed, the keyboard goes back to the document in front, as the
        // Tauri app's dialogs return it.
        let subscription =
            cx.subscribe_in(&sheet, window, |this, _, event, window, cx| match event {
                ArxivEvent::Close => {
                    this.sheets.arxiv = None;
                    this.focus_front(window, cx);
                    cx.notify();
                }
            });
        self.sheets.arxiv = Some((sheet, subscription));
        cx.notify();
    }

    /// Build as the writer asked, and resolve once every build is over.
    pub(crate) fn build_and_settle(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        self.run_build(super::build::BuildRequest::requested(), window, cx);
        let settled = self.builds_settled(cx);
        cx.spawn(async move |_, _| {
            settled.await.ok();
        })
    }
}
