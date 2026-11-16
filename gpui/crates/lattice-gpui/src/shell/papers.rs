//! The Papers panel's requests of the shell: open a reading file (at a
//! line), and the open document's paper marked in the list.
//!
//! A paper's reader is a document of the layout: a `file` view keyed
//! `paper:<arXiv id>` ([`reader_key`]), so it joins the documents' panels
//! and the presets put it with the papers being read (`is_reading`), as the
//! Tauri app's paper tab does, under a key no project file has.

use std::path::Path;

use gpui::{AppContext as _, Context, Entity, Focusable as _, Window};
use lattice_core::papers::PaperSummary;
use trellis::runtime::engine::ViewPlacement;

use super::Shell;

pub(super) mod prewarm;
mod reference;
mod writes;
use crate::papers::{
    PapersEvent, PapersPanel,
    add_sheet::{AddPapers, AddPapersEvent},
    audit::{Audit, AuditEvent},
    bib_editor::add::AddReference,
    linked::{LinkedLibrary, LinkedLibraryEvent},
    literature::{Literature, LiteratureEvent},
    reader::{PaperReader, PaperReaderEvent, ReaderView, reading_path},
};

impl Shell {
    pub(super) fn on_papers_event(
        &mut self,
        _: &Entity<PapersPanel>,
        event: &PapersEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            PapersEvent::Open { path, line } => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(path), *line, window, cx);
                }
            }
            PapersEvent::Read(paper) => self.open_reader((**paper).clone(), window, cx),
            PapersEvent::Likely(paper) => self.prewarm_paper(paper, window, cx),
            PapersEvent::ReadAt { paper, page } => {
                self.open_reader_at((**paper).clone(), *page, window, cx)
            }
            PapersEvent::ReadBeside(paper) => {
                let from = self.beside_from(cx);
                let key = reader_key(&paper.arxiv_id);
                self.open_reader((**paper).clone(), window, cx);
                if let Some((from, shown)) = from
                    && let Some(view) = self.view_of_document(&key, cx)
                {
                    self.place_beside(&view, &from, shown, cx);
                    self.sync_views(window, cx);
                }
            }
            PapersEvent::AddPapers(seed) => self.open_add_papers(seed.clone(), window, cx),
            PapersEvent::SearchLiterature(query) => self.open_literature(query.clone(), window, cx),
            PapersEvent::CheckReferences => self.open_audit(window, cx),
            PapersEvent::MissingPaperTools(failure) => offer_paper_tools(failure, cx),
            PapersEvent::Remove(paper) => self.remove_paper((**paper).clone(), cx),
            PapersEvent::EditEntry(paper) => self.edit_entry((**paper).clone(), window, cx),
            PapersEvent::Review { query, resolved } => {
                self.review_reference(query.clone(), (**resolved).clone(), window, cx)
            }
            PapersEvent::Cite(key) => {
                if self.latex_source_in_front(cx) {
                    self.insert_at_caret("cite", key, window, cx);
                }
            }
            PapersEvent::RefreshEntry { root, key } => {
                self.refresh_entry(root.clone(), key.clone(), cx)
            }
            PapersEvent::Removed | PapersEvent::Rewritten => {
                for editor in self.open_editors() {
                    editor.update(cx, |editor, cx| editor.check_disk(cx));
                }
            }
        }
    }

    /// A saved paper in its reader, a document tab of its own; a paper
    /// already open there comes to the front, with the texts it has now.
    pub(super) fn open_reader(
        &mut self,
        paper: PaperSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let key = reader_key(&paper.arxiv_id);
        let reader = match self.reader_of(&key, cx) {
            Some(reader) => {
                reader.update(cx, |reader, cx| reader.set_paper(paper, window, cx));
                reader
            }
            None => {
                let remembered = self.documents.paper_views.get(&paper.arxiv_id).copied();
                let view = preferred_view(remembered, &paper);
                let reader = cx.new(|cx| PaperReader::new(root.clone(), paper, view, cx));
                cx.subscribe_in(
                    &reader,
                    window,
                    |this, reader, event, window, cx| match event {
                        PaperReaderEvent::Show(view) => {
                            this.give_reader_text(reader, *view, window, cx)
                        }
                        PaperReaderEvent::OpenPath(path) => {
                            if let Some(root) = this.root(cx) {
                                this.open_path(root.join(path), None, window, cx);
                            }
                        }
                    },
                )
                .detach();
                self.give_reader_text(&reader, view, window, cx);
                reader.update(cx, |reader, cx| reader.resume_pdf(window, cx));
                self.documents.readers.push(reader.clone());
                reader
            }
        };
        self.place_document(&key, true, cx);
        self.sync_views(window, cx);
        window.focus(&reader.focus_handle(cx), cx);
        let path = root.join(reader.read(cx).path());
        self.mark_paper(&path, cx);
    }

    /// The editor of `reader`'s text in `view`: the shell's own for the
    /// bundle's file, so it saves, reloads and undoes as any editor's.
    fn give_reader_text(
        &mut self,
        reader: &Entity<PaperReader>,
        view: ReaderView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let id = reader.read(cx).paper().arxiv_id.clone();
        let path = root.join(reading_path(&id, view));
        if let Some(editor) = self.editor_for(&path, window, cx) {
            reader.update(cx, |reader, cx| reader.set_text(view, editor, window, cx));
        }
    }

    /// A saved paper's reading text opened as a file (a search hit, a link
    /// in a note, the Project tree) opens in its paper's reader, at `line`,
    /// as the Tauri app's `openPaper` takes a hit's view and line; a text
    /// the record lacks opens the one it has, at its top. `None` when
    /// `path` is no paper's text the library lists, or the record has none.
    pub(super) fn open_in_reader(
        &mut self,
        path: &Path,
        line: Option<u32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Option<Entity<crate::editor_panel::EditorPanel>>> {
        let root = self.root(cx)?;
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        let relative = path
            .strip_prefix(&canonical_root)
            .or_else(|_| path.strip_prefix(&root))
            .ok()?
            .to_string_lossy()
            .replace('\\', "/");
        let (id, full_text) = crate::editor_panel::paper_text::paper_text_of(&relative)?;
        let paper = self
            .papers
            .read(cx)
            .paper_with_id(&id)
            .filter(|paper| paper.has_full_text || paper.has_blog)?;
        let (view, named) = if full_text {
            (ReaderView::FullText, paper.has_full_text)
        } else {
            (ReaderView::Overview, paper.has_blog)
        };
        self.open_reader(paper, window, cx);
        let reader = self.reader_of(&reader_key(&id), cx)?;
        if named {
            reader.update(cx, |reader, cx| reader.show(view, window, cx));
        }
        let editor = reader.read(cx).editor().cloned();
        if let (Some(editor), Some(line), true) = (&editor, line, named) {
            editor.update(cx, |editor, cx| editor.go_to_line(line, window, cx));
        }
        Some(editor)
    }

    /// The reader holding `editor` as one of its texts, if any: such an
    /// editor stands in the reader's tab, never in a tab of its own.
    pub(super) fn reader_holding(
        &self,
        editor: &Entity<crate::editor_panel::EditorPanel>,
        cx: &gpui::App,
    ) -> Option<Entity<PaperReader>> {
        self.documents
            .readers
            .iter()
            .find(|reader| reader.read(cx).editors().any(|held| held == editor))
            .cloned()
    }

    /// The open reader of the layout's document `key`. A reader is made
    /// only when the writer opens a paper, so a saved layout's paper tab
    /// with none open leaves the layout.
    pub(super) fn reader_of(&self, key: &str, cx: &gpui::App) -> Option<Entity<PaperReader>> {
        self.documents
            .readers
            .iter()
            .find(|reader| reader_key(&reader.read(cx).paper().arxiv_id) == key)
            .cloned()
    }

    /// What takes the keyboard back when a sheet closes: the editor of the
    /// document in front while it is on screen, else a paper's reader in
    /// front. The editor's panel focus is its own: a file showing only its
    /// visual form or preview takes the keys there, not in the hidden source.
    pub(super) fn front_focus(
        &self,
        editor: Option<&Entity<crate::editor_panel::EditorPanel>>,
        cx: &gpui::App,
    ) -> Option<gpui::FocusHandle> {
        let shown = editor.filter(|editor| {
            self.view_of_editor(editor)
                .is_some_and(|view| super::arrange::on_screen(self.workspace.read(cx), &view))
        });
        match shown {
            Some(editor) => Some(editor.read(cx).focus_handle(cx)),
            None => self
                .front_reader_entity(true, cx)
                .map(|reader| reader.focus_handle(cx)),
        }
    }

    /// The reader in front, if a paper's: its reading file and the text it
    /// shows (for scenarios).
    pub(crate) fn front_reader(&self, cx: &gpui::App) -> Option<(String, String)> {
        self.front_reader_entity(false, cx).map(|reader| {
            let reader = reader.read(cx);
            (reader.path(), reader.text(cx).unwrap_or_default())
        })
    }

    /// How the reader in front shows its paper, for scenarios: its text's
    /// view (Edit, Split or Preview), whether that text's reading page has
    /// drawn it and is on screen, and whether the original PDF stands in its
    /// place.
    pub(crate) fn front_reader_state(
        &self,
        cx: &gpui::App,
    ) -> Option<(Option<crate::editor_panel::views::DocumentView>, bool, bool)> {
        self.front_reader_entity(false, cx).map(|reader| {
            let reader = reader.read(cx);
            let editor = reader.editor().map(|editor| editor.read(cx));
            let view = editor.and_then(|editor| editor.document_view());
            // Revealed: the page has drawn the text (`doc:drawn`), not only
            // loaded.
            let page = editor
                .and_then(|editor| editor.markdown_document())
                .and_then(|document| document.read(cx).island())
                .is_some_and(|island| {
                    let island = island.read(cx);
                    island.is_revealed() && island.native_visible(cx)
                });
            (view, page, reader.showing_pdf())
        })
    }

    /// The reader in front, for scenarios.
    pub(crate) fn front_reader_panel(&self, cx: &gpui::App) -> Option<Entity<PaperReader>> {
        self.front_reader_entity(false, cx)
    }

    /// The reader selected in a panel on screen: the focused one, else the
    /// one the writer was in last. With `drawn`, only a panel the window
    /// draws counts, so one outside a zoomed view is passed over.
    fn front_reader_entity(&self, drawn: bool, cx: &gpui::App) -> Option<Entity<PaperReader>> {
        let workspace = self.workspace.read(cx);
        let engine = workspace.engine();
        let shown: Vec<(String, &Entity<PaperReader>)> = self
            .documents
            .readers
            .iter()
            .filter_map(|reader| {
                let view = self.view_of_panel(reader.entity_id())?;
                let placed = if drawn {
                    super::arrange::on_screen(workspace, &view)
                } else {
                    engine.placement_of(&view) != ViewPlacement::Hidden
                };
                (placed && self.in_front(&view, cx)).then_some((view, reader))
            })
            .collect();
        let views: Vec<&str> = shown.iter().map(|(view, _)| view.as_str()).collect();
        front_of(&views, engine.focused_view()).map(|at| shown[at].1.clone())
    }

    /// The panel `panel` took the focus: when it is a paper's reader, it is
    /// the one the writer was in last, and its paper is the open one, even
    /// before the dock has drawn its tab.
    pub(super) fn reader_focused(&mut self, panel: gpui::EntityId, cx: &mut Context<Self>) {
        if !last_used(&mut self.documents.readers, |reader| {
            reader.entity_id() == panel
        }) {
            return;
        }
        let reading = self
            .documents
            .readers
            .iter()
            .find(|reader| reader.entity_id() == panel)
            .map(|reader| reader.read(cx).path());
        if let (Some(reading), Some(root)) = (reading, self.root(cx)) {
            self.mark_paper(&root.join(reading), cx);
        }
    }

    /// Mark the paper in front: a reader's when one is, else the paper
    /// `document` (the document in front) is the text of; none when neither
    /// is open.
    pub(super) fn mark_front_paper(&mut self, document: Option<&Path>, cx: &mut Context<Self>) {
        match (self.front_reader(cx), self.root(cx), document) {
            (Some((reading, _)), Some(root), _) => self.mark_paper(&root.join(reading), cx),
            (_, _, Some(document)) => self.mark_paper(document, cx),
            (_, _, None) => self
                .papers
                .update(cx, |papers, cx| papers.set_active_path(None, cx)),
        }
    }

    /// Readers the writer closed are let go of; they open anew, in the view
    /// each was left in (`paperViewsRef`).
    pub(super) fn forget_closed_readers(&mut self, cx: &gpui::App) {
        let views = self.views.clone();
        let paper_views = &mut self.documents.paper_views;
        self.documents.readers.retain(|reader| {
            let open = views
                .borrow()
                .values()
                .any(|view| view.view().entity_id() == reader.entity_id());
            if !open {
                let reader = reader.read(cx);
                paper_views.insert(reader.paper().arxiv_id.clone(), reader.view());
            }
            open
        });
    }

    /// Add papers, over the window like the project's other sheets.
    pub(super) fn open_add_papers(
        &mut self,
        seed: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.root(cx).is_none() {
            return;
        }
        if !self.dismiss_overlays_for_documents(cx) {
            return;
        }
        // A batch that finished after its sheet closed is done with: the
        // sheet opens on the paste box, a running one on its progress.
        self.papers.update(cx, |papers, cx| papers.clear_batch(cx));
        let papers = self.papers.clone();
        let view = cx.new(|cx| AddPapers::new(papers, seed, window, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            AddPapersEvent::Dismiss => this.close_document_overlays(window, cx),
            AddPapersEvent::EnterManually => this.open_add_reference(window, cx),
            AddPapersEvent::LinkLibrary => this.open_linked_library(window, cx),
        })
        .detach();
        view.update(cx, |view, cx| view.focus_on_open(window, cx));
        self.documents.add_papers = Some(view);
        cx.notify();
    }

    /// Linked library, in place of Add papers.
    fn open_linked_library(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if !self.dismiss_overlays_for_documents(cx) {
            return;
        }
        // The comparison reads the files on disk: what the editors hold is
        // saved first.
        let saved = self.save_editors(cx);
        let view = cx.new(|cx| LinkedLibrary::new(root, saved, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            LinkedLibraryEvent::Dismiss => this.close_document_overlays(window, cx),
            LinkedLibraryEvent::Applied => {
                for editor in this.open_editors() {
                    editor.update(cx, |editor, cx| editor.check_disk(cx));
                }
                this.papers.update(cx, |papers, cx| papers.reload(cx));
            }
        })
        .detach();
        self.documents.linked = Some(view);
        cx.notify();
    }

    /// Discover literature, a drawer at the window's right edge.
    pub(super) fn open_literature(
        &mut self,
        query: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.root(cx).is_none() {
            return;
        }
        if !self.dismiss_overlays_for_documents(cx) {
            return;
        }
        let papers = self.papers.clone();
        let view = cx.new(|cx| Literature::new(papers, query, window, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            LiteratureEvent::Dismiss => this.close_document_overlays(window, cx),
            LiteratureEvent::AddCitation(seed) => this.open_add_papers(seed.clone(), window, cx),
        })
        .detach();
        view.update(cx, |view, cx| view.focus_input(window, cx));
        self.documents.literature = Some(view);
        cx.notify();
    }

    /// Check references, over the window like the project's other sheets.
    pub(super) fn open_audit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if !self.dismiss_overlays_for_documents(cx) {
            return;
        }
        // A check still running from when the sheet closed comes back as it
        // is, with its events still subscribed; one this window left running
        // on another project stops, as the Tauri app's sheet unmounts.
        let owner = cx.entity_id();
        crate::papers::audit::stop_others(owner, &root, cx);
        if let Some(running) = crate::papers::audit::running(owner, &root, cx) {
            window.focus(&running.focus_handle(cx), cx);
            self.documents.audit = Some(running);
            cx.notify();
            return;
        }
        // Every scan reads the files on disk: what the editors hold is saved
        // first, as the Tauri app's `onPrepare` does.
        let shell = cx.entity().downgrade();
        let prepare: crate::papers::audit::Prepare = std::rc::Rc::new(move |cx| {
            shell
                .update(cx, |shell, cx| shell.save_editors(cx))
                .unwrap_or_else(|_| gpui::Task::ready(false))
        });
        let saved = self.save_editors(cx);
        let shell = cx.entity();
        let view = cx.new(|cx| {
            cx.observe_release(&shell, |audit: &mut Audit, _, cx| audit.abandon(cx))
                .detach();
            Audit::new(owner, root, prepare, saved, cx)
        });
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            AuditEvent::Dismiss => this.close_document_overlays(window, cx),
            AuditEvent::OpenSource { path, line } => {
                // The sheet stays while fixes are written, and so does the
                // keyboard: nothing opens behind it.
                if this.overlay_writing(cx) {
                    return;
                }
                this.close_document_overlays(window, cx);
                if let Some(root) = this.root(cx) {
                    this.open_path(root.join(path), Some(*line), window, cx);
                }
            }
            AuditEvent::MissingPaperTools(failure) => offer_paper_tools(failure, cx),
            AuditEvent::Applied => {
                for editor in this.open_editors() {
                    editor.update(cx, |editor, cx| editor.check_disk(cx));
                }
                this.papers.update(cx, |papers, cx| papers.reload(cx));
            }
        })
        .detach();
        window.focus(&view.focus_handle(cx), cx);
        self.documents.audit = Some(view);
        cx.notify();
    }

    /// Check references, while it is up, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn audit(&self) -> Option<&Entity<Audit>> {
        self.documents.audit.as_ref()
    }

    /// Add reference, while it is up, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn add_reference(&self) -> Option<&Entity<AddReference>> {
        self.documents.add_reference.as_ref()
    }

    /// Add papers, while it is up, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn add_papers(&self) -> Option<&Entity<AddPapers>> {
        self.documents.add_papers.as_ref()
    }

    /// The paper whose reading file `path` is, marked as the open one.
    pub(super) fn mark_paper(&mut self, path: &Path, cx: &mut Context<Self>) {
        let relative = self
            .root(cx)
            .and_then(|root| path.strip_prefix(&root).ok().map(Path::to_path_buf));
        let relative = relative.map(|path| path.to_string_lossy().replace('\\', "/"));
        self.papers.update(cx, |papers, cx| {
            papers.set_active_path(relative.as_deref(), cx)
        });
    }
}

const READER_PREFIX: &str = "paper:";

/// The layout's key for the reader of the paper `arxiv_id`.
pub(super) fn reader_key(arxiv_id: &str) -> String {
    format!("{READER_PREFIX}{arxiv_id}")
}

/// Whether a layout's document key is a paper's reader.
pub(super) fn is_reader_key(key: &str) -> bool {
    key.starts_with(READER_PREFIX)
}

/// Which of the readers' views `shown` (from the one used longest ago) is
/// in front: the `focused` view, else the one used last.
fn front_of(shown: &[&str], focused: Option<&str>) -> Option<usize> {
    focused
        .and_then(|focused| shown.iter().position(|view| *view == focused))
        .or_else(|| shown.len().checked_sub(1))
}

/// Move the first of `list` that `is` to its end, as the one used last;
/// whether there was one.
fn last_used<T>(list: &mut Vec<T>, is: impl Fn(&T) -> bool) -> bool {
    let Some(at) = list.iter().position(is) else {
        return false;
    };
    let item = list.remove(at);
    list.push(item);
    true
}

/// The view a paper opens in (`preferredPaperView`): the one last shown for
/// it when that text is there, else its full text, and the overview only
/// when there is no full text.
fn preferred_view(remembered: Option<ReaderView>, paper: &PaperSummary) -> ReaderView {
    if remembered == Some(ReaderView::Overview) && paper.has_blog {
        return ReaderView::Overview;
    }
    if paper.has_full_text || !paper.has_blog {
        ReaderView::FullText
    } else {
        ReaderView::Overview
    }
}

/// An import or check failed for want of the paper tools: setup offers them
/// (`onMissingPaperTools`).
fn offer_paper_tools(failure: &str, cx: &mut gpui::App) {
    if let Some(center) = crate::build::tex_setup::center::center(cx) {
        let failure = failure.to_string();
        center.update(cx, |center, cx| {
            center.open_for_missing_paper_tools(failure, cx)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_focused_reader_is_in_front_of_the_others_shown() {
        // A opened first, B last, C between; the writer is in C.
        let shown = ["reader-a", "reader-c", "reader-b"];
        assert_eq!(front_of(&shown, Some("reader-c")), Some(1));
        // An editor focused: the reader used last.
        assert_eq!(front_of(&shown, Some("editor")), Some(2));
        assert_eq!(front_of(&shown, None), Some(2));
        assert_eq!(front_of(&[], Some("reader-a")), None);
    }

    #[test]
    fn a_reader_focused_after_another_opened_is_the_one_used_last() {
        // A opened, then B; the writer goes back into A, then into an editor.
        let mut readers = vec!["a", "b"];
        assert!(last_used(&mut readers, |reader| *reader == "a"));
        assert!(!last_used(&mut readers, |reader| *reader == "editor"));
        assert_eq!(readers, ["b", "a"]);
        assert_eq!(front_of(&readers, Some("editor")), Some(1));
    }
}
