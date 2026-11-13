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

/// How many places back and forward go through
/// (`NAVIGATION_HISTORY_LIMIT`, `src/app/open-documents-store.ts`).
const HISTORY_KEPT: usize = 80;

/// The search surfaces open in the window, and the files visited.
#[derive(Default)]
pub(crate) struct Documents {
    quick_open: Option<Entity<QuickOpen>>,
    find: Option<Entity<ProjectFind>>,
    /// Find's query and tab, kept across reopening.
    find_memory: FindMemory,
    replace: Option<Entity<ProjectReplace>>,
    /// Add papers, opened from the Papers panel.
    pub(super) add_papers: Option<Entity<crate::papers::add_sheet::AddPapers>>,
    /// Discover literature, opened from the Papers box.
    pub(super) literature: Option<Entity<crate::papers::literature::Literature>>,
    /// Add papers' Enter manually: a reference for the project's
    /// bibliography, typed or looked up.
    pub(super) add_reference: Option<Entity<crate::papers::bib_editor::add::AddReference>>,
    /// Linked library, from Add papers.
    pub(super) linked: Option<Entity<crate::papers::linked::LinkedLibrary>>,
    /// Check references, opened from the Papers strip.
    pub(super) audit: Option<Entity<crate::papers::audit::Audit>>,
    /// Saved papers open in their reader, one tab each.
    pub(super) readers: Vec<Entity<crate::papers::reader::PaperReader>>,
    /// The places the writer went (project-relative path, line), oldest
    /// first, and the one back and forward stand on.
    history: Vec<(String, u32)>,
    history_index: usize,
    /// Back or forward is opening its place, which is not a new one.
    navigating: bool,
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
            recent: self.recent_paths(),
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
    pub(super) fn dismiss_overlays_for_documents(&mut self, cx: &mut Context<Self>) {
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
        self.documents.add_papers = None;
        self.documents.literature = None;
        self.documents.audit = None;
        self.documents.add_reference = None;
        self.documents.linked = None;
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
            || self.documents.add_papers.is_some()
            || self.documents.literature.is_some()
            || self.documents.audit.is_some()
            || self.documents.add_reference.is_some()
            || self.documents.linked.is_some()
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

    /// Note where the writer went, for back and forward and quick open's
    /// Recent (`pushNavigation`): a file opened, at its line or its top; the
    /// file already in front only when a line was asked for. A place after
    /// the one back stood on drops the places forward of it.
    pub(super) fn record_visit(
        &mut self,
        path: &Path,
        line: Option<u32>,
        in_front: bool,
        cx: &mut Context<Self>,
    ) {
        if self.documents.navigating || (in_front && line.is_none()) {
            return;
        }
        let Some(relative) = self
            .root(cx)
            .and_then(|root| crate::project::relative_path(&root, path))
        else {
            return;
        };
        let entry = (relative, line.unwrap_or(1));
        let documents = &mut self.documents;
        documents
            .history
            .truncate((documents.history_index + 1).min(documents.history.len()));
        if documents.history.last() != Some(&entry) {
            documents.history.push(entry);
        }
        let overflow = documents.history.len().saturating_sub(HISTORY_KEPT);
        documents.history.drain(..overflow);
        documents.history_index = documents.history.len().saturating_sub(1);
    }

    /// ⌘[ and ⌘]: the place before or after the one back stands on.
    pub(crate) fn go_back_or_forward(
        &mut self,
        step: isize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let next = self.documents.history_index as isize + step;
        let Some((path, line)) = usize::try_from(next)
            .ok()
            .and_then(|next| self.documents.history.get(next).cloned())
        else {
            return;
        };
        let Some(root) = self.root(cx) else {
            return;
        };
        self.documents.history_index = next as usize;
        self.documents.navigating = true;
        self.open_path(root.join(path), Some(line), window, cx);
        self.documents.navigating = false;
    }

    /// The files visited this session, newest first and each once.
    fn recent_paths(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (path, _) in self.documents.history.iter().rev() {
            if !out.contains(path) {
                out.push(path.clone());
            }
        }
        out
    }

    /// A new project in the window starts its own history, and its own
    /// search.
    pub(super) fn forget_visits(&mut self) {
        self.documents.history.clear();
        self.documents.history_index = 0;
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
            .chain(
                documents
                    .literature
                    .clone()
                    .map(|view| view.into_any_element()),
            )
            .chain(documents.audit.clone().map(|view| view.into_any_element()))
            .chain(
                documents
                    .add_reference
                    .clone()
                    .map(|view| view.into_any_element()),
            )
            .chain(documents.linked.clone().map(|view| view.into_any_element()))
            .chain(
                documents
                    .add_papers
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
