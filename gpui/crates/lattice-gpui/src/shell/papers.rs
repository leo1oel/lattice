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
use lattice_i18n::t;
use trellis::runtime::engine::ViewPlacement;

use super::Shell;
use crate::notices;
use crate::papers::{
    PapersEvent, PapersPanel,
    add_sheet::{AddPapers, AddPapersEvent},
    audit::{Audit, AuditEvent},
    bib_editor::add::{AddReference, AddReferenceEvent, AddTarget},
    linked::{LinkedLibrary, LinkedLibraryEvent},
    literature::{Literature, LiteratureEvent},
    reader::{PaperReader, PaperReaderEvent, ReaderView},
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
            PapersEvent::AddPapers(seed) => self.open_add_papers(seed.clone(), window, cx),
            PapersEvent::SearchLiterature(query) => self.open_literature(query.clone(), window, cx),
            PapersEvent::CheckReferences => self.open_audit(window, cx),
            PapersEvent::Remove(paper) => self.remove_paper((**paper).clone(), cx),
            PapersEvent::EditEntry(paper) => self.edit_entry((**paper).clone(), window, cx),
            PapersEvent::Removed => {
                for editor in self.open_editors() {
                    editor.update(cx, |editor, cx| editor.check_disk(cx));
                }
            }
        }
    }

    /// The removal's scan for citations reads the files on disk: what the
    /// editors hold is saved first, and a save that fails stops it, as
    /// `remove-reference-action.ts` does.
    fn remove_paper(&mut self, paper: PaperSummary, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let saves = Self::save_dirty(&self.open_editors(), cx);
        let papers = self.papers.downgrade();
        cx.spawn(async move |_, cx| {
            for save in saves {
                match save.await {
                    Ok(true) => {}
                    // A write held or failed has said why already.
                    Ok(false) => return,
                    Err(error) => {
                        cx.update(|cx| {
                            notices::error(
                                t!("Could not remove the paper"),
                                format!("{error:#}"),
                                cx,
                            )
                        });
                        return;
                    }
                }
            }
            papers
                .update(cx, |papers, cx| papers.remove_saved(&paper, root, cx))
                .ok();
        })
        .detach();
    }

    /// A saved paper in its reader, a document tab of its own; a paper
    /// already open there comes to the front, with the texts it has now.
    fn open_reader(&mut self, paper: PaperSummary, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let key = reader_key(&paper.arxiv_id);
        let reader = match self.reader_of(&key, cx) {
            Some(reader) => {
                reader.update(cx, |reader, cx| reader.set_paper(paper, cx));
                reader
            }
            None => {
                let view = if paper.has_full_text {
                    ReaderView::FullText
                } else {
                    ReaderView::Overview
                };
                let reader = cx.new(|cx| PaperReader::new(root.clone(), paper, view, cx));
                cx.subscribe_in(&reader, window, |this, _, event, window, cx| match event {
                    PaperReaderEvent::OpenPdf(path) => {
                        if let Some(root) = this.root(cx) {
                            this.open_file_pdf(root.join(path), window, cx);
                        }
                    }
                })
                .detach();
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
    /// document in front while its tab is in front, else a paper's reader in
    /// front, else that editor where it is. The editor's panel focus is its
    /// own: a file showing only its visual form or preview takes the keys
    /// there, not in the hidden source.
    pub(super) fn front_focus(
        &self,
        editor: Option<&Entity<crate::editor_panel::EditorPanel>>,
        cx: &gpui::App,
    ) -> Option<gpui::FocusHandle> {
        let shown = editor.filter(|editor| {
            self.view_of_editor(editor)
                .is_some_and(|view| self.in_front(&view, cx))
        });
        match (shown, self.front_reader_entity(cx), editor) {
            (Some(editor), _, _) => Some(editor.read(cx).focus_handle(cx)),
            (None, Some(reader), _) => Some(reader.focus_handle(cx)),
            (None, None, editor) => editor.map(|editor| editor.read(cx).focus_handle(cx)),
        }
    }

    /// The reader in front, if a paper's: its reading file and the text it
    /// shows (for scenarios).
    pub(crate) fn front_reader(&self, cx: &gpui::App) -> Option<(String, String)> {
        self.front_reader_entity(cx).map(|reader| {
            let reader = reader.read(cx);
            (
                reader.path(),
                reader.text(cx).unwrap_or_default().to_string(),
            )
        })
    }

    /// The reader selected in a panel on screen: the focused one, else the
    /// one the writer was in last.
    fn front_reader_entity(&self, cx: &gpui::App) -> Option<Entity<PaperReader>> {
        let engine = self.workspace.read(cx).engine();
        let shown: Vec<(String, &Entity<PaperReader>)> = self
            .documents
            .readers
            .iter()
            .filter_map(|reader| {
                let view = self.view_of_panel(reader.entity_id())?;
                (engine.placement_of(&view) != ViewPlacement::Hidden && self.in_front(&view, cx))
                    .then_some((view, reader))
            })
            .collect();
        let views: Vec<&str> = shown.iter().map(|(view, _)| view.as_str()).collect();
        front_of(&views, engine.focused_view()).map(|at| shown[at].1.clone())
    }

    /// The panel `panel` took the focus: when it is a paper's reader, it is
    /// the one the writer was in last.
    pub(super) fn reader_focused(&mut self, panel: gpui::EntityId, cx: &mut Context<Self>) {
        if !last_used(&mut self.documents.readers, |reader| {
            reader.entity_id() == panel
        }) {
            return;
        }
        let document = self
            .active_editor()
            .map(|editor| editor.read(cx).path().to_path_buf());
        self.mark_front_paper(document.as_deref(), cx);
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

    /// Readers the writer closed are let go of; they open anew.
    pub(super) fn forget_closed_readers(&mut self) {
        let views = self.views.clone();
        self.documents.readers.retain(|reader| {
            views
                .borrow()
                .values()
                .any(|view| view.view().entity_id() == reader.entity_id())
        });
    }

    /// Add papers, over the window like the project's other sheets.
    fn open_add_papers(&mut self, seed: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.root(cx).is_none() {
            return;
        }
        self.dismiss_overlays_for_documents(cx);
        let papers = self.papers.clone();
        let view = cx.new(|cx| AddPapers::new(papers, seed, window, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            AddPapersEvent::Dismiss => this.close_document_overlays(window, cx),
            AddPapersEvent::EnterManually => this.open_add_reference(window, cx),
            AddPapersEvent::LinkLibrary => this.open_linked_library(window, cx),
        })
        .detach();
        view.update(cx, |view, cx| view.focus_input(window, cx));
        self.documents.add_papers = Some(view);
        cx.notify();
    }

    /// A reference entered by hand for the project's bibliography, in place
    /// of Add papers.
    fn open_add_reference(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        self.dismiss_overlays_for_documents(cx);
        let target = AddTarget::Project {
            root,
            papers: self.papers.downgrade(),
            editing: false,
        };
        let view = cx.new(|cx| AddReference::new(target, window, cx));
        view.update(cx, |view, cx| view.focus_lookup(window, cx));
        self.show_add_reference(view, window, cx);
    }

    /// Edit bibliography entry (`editBibEntry`): the entry as the file holds
    /// it, in Add reference's form, saved back under its key.
    fn edit_entry(&mut self, paper: PaperSummary, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(root), Some(key)) = (self.root(cx), paper.citation_key) else {
            return;
        };
        let (read_root, read_key) = (root.clone(), key.clone());
        let read = cx.background_spawn(async move {
            lattice_core::project::read_bib_entry(&read_root, &read_key)
        });
        cx.spawn_in(window, async move |this, cx| {
            let read = read.await;
            this.update_in(cx, |this, window, cx| {
                if this.root(cx).as_ref() != Some(&root) {
                    return;
                }
                let record = match read {
                    Ok(Some(record)) => record,
                    Ok(None) => {
                        let detail = t!(
                            "Couldn't find a bibliography entry for {citationCommand}.",
                            citationCommand = format!("\\cite{{{key}}}")
                        );
                        notices::error(t!("Edit bibliography entry"), detail, cx);
                        return;
                    }
                    Err(error) => {
                        notices::error(t!("Edit bibliography entry"), error, cx);
                        return;
                    }
                };
                this.dismiss_overlays_for_documents(cx);
                let papers = this.papers.downgrade();
                let view = cx.new(|cx| AddReference::edit(root, papers, record, window, cx));
                this.show_add_reference(view, window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn show_add_reference(
        &mut self,
        view: Entity<AddReference>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            AddReferenceEvent::Dismiss => this.close_document_overlays(window, cx),
        })
        .detach();
        self.documents.add_reference = Some(view);
        cx.notify();
    }

    /// Linked library, in place of Add papers.
    fn open_linked_library(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        self.dismiss_overlays_for_documents(cx);
        // The comparison reads the files on disk: what the editors hold is
        // saved first.
        self.save_in_background(cx);
        let view = cx.new(|cx| LinkedLibrary::new(root, cx));
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
    fn open_literature(&mut self, query: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.root(cx).is_none() {
            return;
        }
        self.dismiss_overlays_for_documents(cx);
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
    fn open_audit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        self.dismiss_overlays_for_documents(cx);
        // Every scan reads the files on disk: what the editors hold is saved
        // first, as the Tauri app's `onPrepare` does.
        let shell = cx.entity().downgrade();
        let prepare: crate::papers::audit::Prepare = std::rc::Rc::new(move |cx| {
            shell
                .update(cx, |shell, cx| shell.save_editors(cx))
                .unwrap_or_else(|_| gpui::Task::ready(false))
        });
        let view = cx.new(|cx| Audit::new(root, prepare, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            AuditEvent::Dismiss => this.close_document_overlays(window, cx),
            AuditEvent::OpenSource { path, line } => {
                if let Some(root) = this.root(cx) {
                    this.open_path(root.join(path), Some(*line), window, cx);
                }
            }
            AuditEvent::MissingPaperTools(failure) => {
                if let Some(center) = crate::build::tex_setup::center::center(cx) {
                    let failure = failure.clone();
                    center.update(cx, |center, cx| {
                        center.open_for_missing_paper_tools(failure, cx)
                    });
                }
            }
            AuditEvent::Applied => {
                for editor in this.open_editors() {
                    editor.update(cx, |editor, cx| editor.check_disk(cx));
                }
                this.papers.update(cx, |papers, cx| papers.reload(cx));
            }
        })
        .detach();
        self.documents.audit = Some(view);
        cx.notify();
    }

    /// Check references, while it is up, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn audit(&self) -> Option<&Entity<Audit>> {
        self.documents.audit.as_ref()
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
