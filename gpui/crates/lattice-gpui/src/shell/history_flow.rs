//! The project's history in the window: the History tool panel opened where
//! the Tauri app opens it, a file opened from it, and the conflict resolver
//! over the window.
//!
//! The panel opens as the Tauri app's `revealTool` opens a drawer's tool
//! panel (`src/trellis/trellis-controller.ts`): as a tab of the documents'
//! panel, or, already in the layout elsewhere, moved there and brought
//! forward; ending focus mode first. The titlebar's History button, the
//! palette's "Open project history" and the Panels toggle reach it.
//!
//! A file Git left with conflict markers (a merge or a pull that stopped,
//! `git status` naming it as a conflict) is offered to the resolver in a
//! notice as soon as the watcher sees it, and from the palette's "Resolve
//! conflicts…", which takes the file in front when it has markers and else
//! the first file Git names.

use std::{collections::BTreeSet, path::Path};

use gpui::{AppContext as _, Context, Window, actions};
use lattice_i18n::{join_list, t};
use lattice_ui::{
    Icon,
    components::{IconButton, Surface, ToastLevel},
};
use trellis::model::Placement;
use trellis::runtime::engine::{OpenOptions, ViewPlacement};

use super::Shell;
use crate::{
    history::{ConflictEvent, ConflictResolver, HistoryEvent, conflicts::has_conflict_markers},
    notices::{self, Notice, NoticeAction},
};

actions!(lattice, [OpenHistory, ResolveConflicts]);

/// The notice that offers the resolver for the project at `root`, replaced
/// as its files change.
fn conflict_notice(root: &Path) -> String {
    format!("git-conflicts:{}", root.display())
}

impl Shell {
    /// Bring the History panel on screen.
    pub(crate) fn open_history(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.project.is_none() {
            return;
        }
        if self.layout.focus.is_some() {
            self.set_focus_mode(false, window, cx);
        }
        let anchor = self.document_panel_of_layout(cx);
        match self.placement("history", cx) {
            Some((ViewPlacement::Hidden, ..)) => self.show_view("history", true, window, cx),
            Some(_) => {
                let panel = self.panel_holding("history", cx);
                // Asked for again, it follows the same placement rule rather
                // than leaving focus on a distant old place.
                if let Some(anchor) = anchor.filter(|anchor| Some(anchor) != panel.as_ref()) {
                    self.engine_do(cx, |engine| {
                        engine.dock(
                            "history",
                            Some(trellis::model::DockTarget::Into {
                                into: anchor,
                                index: None,
                            }),
                        )
                    });
                }
                self.engine_do(cx, |engine| engine.focus("history"));
            }
            None => {
                let placement = match anchor {
                    Some(into) => Placement::Into { into, index: None },
                    None => self.home_of("history", cx),
                };
                self.engine_do(cx, |engine| {
                    engine.open(
                        "history",
                        OpenOptions {
                            id: Some("history".into()),
                            placement: Some(placement),
                            focus: Some(true),
                            ..OpenOptions::default()
                        },
                    )
                });
            }
        }
        self.history.update(cx, |history, cx| history.reload(cx));
        cx.notify();
    }

    /// The titlebar's History button (`onHistory` in canvas-toolbar.tsx).
    pub(crate) fn history_button(&self, cx: &mut Context<Self>) -> IconButton {
        IconButton::new("history", Icon::HISTORY)
            .surface(Surface::Titlebar)
            .tooltip(t!("Project history"))
            .disabled(self.project.is_none())
            .on_click(cx.listener(|shell, _, window, cx| shell.open_history(window, cx)))
    }

    /// The docked panel holding `view`, read from the layout document (the
    /// engine's per-view state is filled in as the panels are laid out, so
    /// it says nothing yet of a window not drawn).
    pub(crate) fn panel_holding(&self, view: &str, cx: &gpui::App) -> Option<String> {
        let doc = self.document(cx);
        super::trellis_layout::panels_of(&doc, false)
            .into_iter()
            .find(|panel| panel.views.iter().any(|id| id == view))
            .map(|panel| panel.id.clone())
    }

    /// The panel the documents are in (`documentPanel`): the front
    /// document's, else any panel holding a document or its empty place.
    pub(crate) fn document_panel_of_layout(&self, cx: &gpui::App) -> Option<String> {
        let doc = self.document(cx);
        let front = self
            .active_document(cx)
            .and_then(|key| self.view_of_document(&key, cx))
            .and_then(|view| self.panel_holding(&view, cx));
        front.or_else(|| {
            super::trellis_layout::panels_of(&doc, false)
                .into_iter()
                .find(|panel| {
                    panel
                        .views
                        .iter()
                        .any(|id| super::trellis_layout::is_document_view(doc.views.get(id)))
                })
                .map(|panel| panel.id.clone())
        })
    }

    pub(crate) fn on_history_event(
        &mut self,
        event: &HistoryEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            HistoryEvent::OpenFile { path, line } => {
                let Some(root) = self.root(cx) else { return };
                self.open_path(root.join(path), *line, window, cx);
            }
        }
    }

    /// The files Git names as conflicts, in the project's terms.
    fn conflicted_files(&self, cx: &gpui::App) -> Vec<String> {
        let Some(project) = &self.project else {
            return Vec::new();
        };
        let mut files: Vec<String> = project
            .read(cx)
            .git()
            .iter()
            .filter(|(_, status)| status.as_str() == "conflict")
            .map(|(path, _)| path.clone())
            .collect();
        files.sort();
        files
    }

    /// Offer the resolver once Git leaves a file with markers.
    pub(crate) fn notice_conflicts(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else { return };
        let key = conflict_notice(&root);
        let files: BTreeSet<String> = self.conflicted_files(cx).into_iter().collect();
        if files == self.conflicts_noticed {
            return;
        }
        self.conflicts_noticed = files.clone();
        if files.is_empty() {
            notices::dismiss(&key, cx);
            return;
        }
        let names: Vec<String> = files.iter().cloned().collect();
        let first = names[0].clone();
        let shell = cx.entity().downgrade();
        let notice = Notice::new(
            ToastLevel::Warning,
            t!(
                "Git left conflict markers in {files}.",
                files = join_list(&names)
            ),
        )
        .key(key)
        .persistent()
        .action(NoticeAction::new(
            t!("Resolve conflicts…"),
            move |window, cx| {
                let first = first.clone();
                shell
                    .update(cx, |shell, cx| {
                        shell.open_conflict_resolver(first, false, window, cx)
                    })
                    .ok();
            },
        ));
        notices::show(notice, cx);
    }

    /// Take down the project's conflict notice as the window leaves it.
    pub(crate) fn drop_conflict_notice(&mut self, cx: &mut gpui::App) {
        if let Some(root) = self.root(cx)
            && !std::mem::take(&mut self.conflicts_noticed).is_empty()
        {
            notices::dismiss(&conflict_notice(&root), cx);
        }
    }

    /// "Resolve conflicts…": the file in front when it has markers, else
    /// the first file Git names.
    pub(crate) fn resolve_conflicts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else { return };
        let in_front = self.active_editor().and_then(|editor| {
            let path = editor.read(cx).path().to_path_buf();
            let text = editor.read(cx).editor().read(cx).text(cx);
            has_conflict_markers(&text)
                .then(|| {
                    path.strip_prefix(&root)
                        .ok()
                        .map(|path| path.to_string_lossy().replace('\\', "/"))
                })
                .flatten()
        });
        match in_front.or_else(|| self.conflicted_files(cx).into_iter().next()) {
            Some(path) => self.open_conflict_resolver(path, false, window, cx),
            None => notices::show(
                Notice::new(
                    ToastLevel::Info,
                    t!("No file in this project has conflict markers."),
                ),
                cx,
            ),
        }
    }

    pub(crate) fn open_conflict_resolver(
        &mut self,
        path: String,
        overleaf: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else { return };
        // The editor's unsaved edits reach the file first, so the markers
        // read are the ones on screen.
        for editor in self.open_editors() {
            editor.update(cx, |editor, cx| editor.write_before_quit(cx));
        }
        let resolver = cx.new(|cx| ConflictResolver::new(root, path, cx).overleaf_sides(overleaf));
        let subscription =
            cx.subscribe_in(
                &resolver,
                window,
                |this, _, event, window, cx| match event {
                    ConflictEvent::Resolved(path) => {
                        this.conflict = None;
                        notices::show(
                            Notice::new(ToastLevel::Success, t!("Resolved {path}", path = path)),
                            cx,
                        );
                        if let Some(root) = this.root(cx) {
                            this.open_path(root.join(path), None, window, cx);
                        }
                        this.history.update(cx, |history, cx| history.reload(cx));
                        cx.notify();
                    }
                    ConflictEvent::Closed => {
                        this.conflict = None;
                        cx.notify();
                    }
                },
            );
        self.conflict = Some((resolver, subscription));
        cx.notify();
    }
}
