//! The window's side of the project's search surfaces: what opens quick
//! open, Find in project and Replace in project, what their picks do, and
//! the files visited this session that quick open lists first
//! (`src/app/app-search-dialogs.tsx`, `use-project-search.ts`).

use std::path::Path;

use gpui::{AnyElement, AppContext as _, Context, Entity, IntoElement as _, Window};
use lattice_core::models::FileNode;

use super::Shell;
use crate::{
    notices::{self, Notice},
    search::{
        find::{FindMemory, ProjectFind, ProjectFindEvent},
        quick_open::{QuickOpen, QuickOpenEvent, QuickOpenPick, QuickOpenSource},
        replace::{ProjectReplace, ProjectReplaceEvent},
    },
};

/// How many visited files the window remembers, newest first.
const VISITED_KEPT: usize = 32;

/// The search surfaces open in the window, and the files visited.
#[derive(Default)]
pub(crate) struct Documents {
    quick_open: Option<Entity<QuickOpen>>,
    find: Option<Entity<ProjectFind>>,
    /// Find's query and tab, kept across reopening.
    find_memory: FindMemory,
    replace: Option<Entity<ProjectReplace>>,
    /// Project-relative, newest first, for this project only.
    visited: Vec<String>,
}

impl Shell {
    /// ⌘P: quick open over the project's files, or closed again.
    pub(crate) fn toggle_quick_open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.documents.quick_open.is_some() {
            self.close_document_overlays(window, cx);
            return;
        }
        let Some(project) = self.project.clone() else {
            return;
        };
        self.dismiss_overlays_for_documents(cx);
        let (root, main, paths) = {
            let project = project.read(cx);
            let mut paths = Vec::new();
            collect_files(project.files(), &mut paths);
            (
                project.root().to_path_buf(),
                project.main_document().map(str::to_string),
                paths,
            )
        };
        let current = self
            .active_editor()
            .map(|editor| editor.read(cx).relative().to_string());
        let source = QuickOpenSource {
            paths,
            recent: self.documents.visited.clone(),
            line_target: current.clone(),
            current,
            root,
            main,
        };
        let weak = cx.entity().downgrade();
        let view = cx.new(|cx| QuickOpen::new(weak, source, window, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            QuickOpenEvent::Dismiss => this.close_document_overlays(window, cx),
        })
        .detach();
        view.update(cx, |view, cx| view.focus_input(window, cx));
        self.documents.quick_open = Some(view);
        cx.notify();
    }

    /// What a quick open pick does: open the file (at its line), or go to a
    /// line of the document on screen.
    pub(crate) fn quick_open_pick(
        &mut self,
        pick: QuickOpenPick,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match pick {
            QuickOpenPick::Open { path, line } => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(path), line, window, cx);
                }
            }
            QuickOpenPick::Line(line) => {
                if let Some(editor) = self.active_editor() {
                    editor.update(cx, |editor, cx| editor.go_to_line(line, window, cx));
                }
            }
        }
    }

    /// ⌘⇧F: Find in project, on the query it was left with.
    pub(crate) fn toggle_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.documents.find.is_some() {
            self.close_document_overlays(window, cx);
            return;
        }
        let Some(root) = self.root(cx) else {
            return;
        };
        self.dismiss_overlays_for_documents(cx);
        let memory = self.documents.find_memory.clone();
        let view = cx.new(|cx| ProjectFind::new(root, memory, window, cx));
        cx.subscribe_in(&view, window, |this, find, event, window, cx| match event {
            ProjectFindEvent::Dismiss => this.close_document_overlays(window, cx),
            ProjectFindEvent::Open { path, line } => {
                // The sheet stays up, as the app's does: F3 opens the next
                // hit from it, so the keyboard goes back to its field.
                if let Some(root) = this.root(cx) {
                    this.open_path(root.join(path), *line, window, cx);
                }
                find.update(cx, |find, cx| find.focus_input(window, cx));
            }
        })
        .detach();
        view.update(cx, |view, cx| view.focus_input(window, cx));
        self.documents.find = Some(view);
        cx.notify();
    }

    /// ⌘⇧H: Replace in project.
    pub(crate) fn toggle_replace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.documents.replace.is_some() {
            self.close_document_overlays(window, cx);
            return;
        }
        let Some(root) = self.root(cx) else {
            return;
        };
        self.dismiss_overlays_for_documents(cx);
        let view = cx.new(|cx| ProjectReplace::new(root.clone(), window, cx));
        cx.subscribe_in(
            &view,
            window,
            move |this, replace, event, window, cx| match event {
                ProjectReplaceEvent::Dismiss => this.close_document_overlays(window, cx),
                ProjectReplaceEvent::OpenMatch { path, line } => {
                    if let Some(root) = this.root(cx) {
                        this.open_path(root.join(path), Some(*line), window, cx);
                    }
                    replace.update(cx, |replace, cx| replace.focus_input(window, cx));
                }
                ProjectReplaceEvent::Save(answer) => {
                    let Some(answer) = answer.borrow_mut().take() else {
                        return;
                    };
                    let saved = this.save_before_leaving(cx);
                    cx.spawn(async move |_, _| {
                        let saved = match saved {
                            Some(saved) => saved.await,
                            None => true,
                        };
                        answer.send(saved).ok();
                    })
                    .detach();
                }
                ProjectReplaceEvent::Replaced(result) => {
                    // Not into a project opened since it was approved.
                    if this.root(cx).as_deref() != Some(root.as_path()) {
                        return;
                    }
                    for editor in this.open_editors() {
                        editor.update(cx, |editor, cx| editor.check_disk(cx));
                    }
                    if let Some(project) = &this.project {
                        project.update(cx, |project, cx| {
                            project.mark_inputs_changed();
                            project.rescan(cx);
                        });
                    }
                    this.close_document_overlays(window, cx);
                    notices::show(
                        Notice::new(
                            lattice_ui::components::ToastLevel::Info,
                            replaced_message(result.replacements, result.files_changed.len()),
                        ),
                        cx,
                    );
                }
            },
        )
        .detach();
        view.update(cx, |view, cx| view.focus_input(window, cx));
        self.documents.replace = Some(view);
        cx.notify();
    }

    /// The palette and the shortcut sheet make way for a search surface,
    /// and one search surface for another.
    fn dismiss_overlays_for_documents(&mut self, cx: &mut Context<Self>) {
        self.palette = None;
        self.shortcuts = None;
        self.take_document_overlays(cx);
    }

    fn take_document_overlays(&mut self, cx: &mut Context<Self>) {
        self.documents.quick_open = None;
        if let Some(find) = self.documents.find.take() {
            self.documents.find_memory = find.read(cx).memory(cx);
        }
        self.documents.replace = None;
    }

    /// Close whichever search surface is open, and give the keyboard back to
    /// the document in front.
    pub(crate) fn close_document_overlays(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.take_document_overlays(cx);
        self.focus_front(window, cx);
        cx.notify();
    }

    /// Whether a search surface is open, for the palette and the shortcut
    /// sheet to close it first.
    pub(crate) fn document_overlay_open(&self) -> bool {
        self.documents.quick_open.is_some()
            || self.documents.find.is_some()
            || self.documents.replace.is_some()
    }

    /// Quick open, while it is up, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn quick_open(&self) -> Option<&Entity<QuickOpen>> {
        self.documents.quick_open.as_ref()
    }

    /// Find in project, while it is up, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn project_find(&self) -> Option<&Entity<ProjectFind>> {
        self.documents.find.as_ref()
    }

    /// Replace in project, while it is up, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn project_replace(&self) -> Option<&Entity<ProjectReplace>> {
        self.documents.replace.as_ref()
    }

    /// Note that `path` was visited, for quick open's Recent.
    pub(super) fn record_visit(&mut self, path: &Path, cx: &mut Context<Self>) {
        let Some(relative) = self
            .root(cx)
            .and_then(|root| crate::project::relative_path(&root, path))
        else {
            return;
        };
        let visited = &mut self.documents.visited;
        visited.retain(|existing| *existing != relative);
        visited.insert(0, relative);
        visited.truncate(VISITED_KEPT);
    }

    /// A new project in the window starts its own history, and its own
    /// search.
    pub(super) fn forget_visits(&mut self) {
        self.documents.visited.clear();
        self.documents.quick_open = None;
        self.documents.find = None;
        self.documents.find_memory = FindMemory::default();
        self.documents.replace = None;
    }

    /// The surfaces drawn over the window.
    pub(super) fn document_overlays(&self) -> Vec<AnyElement> {
        let documents = &self.documents;
        documents
            .quick_open
            .clone()
            .map(|view| view.into_any_element())
            .into_iter()
            .chain(documents.find.clone().map(|view| view.into_any_element()))
            .chain(
                documents
                    .replace
                    .clone()
                    .map(|view| view.into_any_element()),
            )
            .collect()
    }
}

/// What a replace says it did (`use-project-search.ts`).
fn replaced_message(replacements: u32, files: usize) -> String {
    match (replacements, files) {
        (0, _) => "No matches found.".into(),
        (1, _) => format!("Replaced {replacements} occurrence in {files} file."),
        (_, 1) => format!("Replaced {replacements} occurrences in {files} file."),
        _ => format!("Replaced {replacements} occurrences in {files} files."),
    }
}

/// Every file under `nodes`, project-relative, in tree order.
fn collect_files(nodes: &[FileNode], out: &mut Vec<String>) {
    for node in nodes {
        if node.kind == "directory" {
            collect_files(&node.children, out);
        } else if !node.path.is_empty() {
            out.push(node.path.clone());
        }
    }
}
