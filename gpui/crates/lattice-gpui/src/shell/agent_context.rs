//! What the Agent is told of the window (its host context's inputs), as the
//! Tauri app's App feeds `useAgentContext` (`src/app/use-agent-context.ts`)
//! from every surface: the file in front, whatever it is (a source file, a
//! board, a sheet, a deck, an image, a project PDF); the surface the writer
//! works in, the editor or a PDF, as focus moves; the compiled PDF's page
//! and page count; the one shared selection, the source editor's, the
//! visual Markdown editor's, a PDF's with the PDF and page it was made
//! on, or a paper's in its reader; Open Slide's deck and slide while a deck
//! is in front; and the paper in its reader, with the text it shows, while
//! its reader is the one worked in.
//!
//! The model is `crate::agent::host_context`; this reads the window into
//! it. The window is read on every frame (`agent_follow_front`), but only
//! what changed is pushed, and the surface waits for the caret to rest.

use gpui::{App, Context, Entity, EntityId, Focusable as _, Task, WeakEntity, Window};
use serde_json::json;

use super::{Shell, trellis_layout::file_key};
use crate::{
    agent::{
        host_context::{self, Inputs, Selected, SharedSelection, Source},
        workspace,
    },
    editor_panel::EditorPanel,
    papers::reader::{PaperReader, ReaderView},
    pdf::{PdfPanel, PdfPanelKind},
    structured::StructuredKind,
};

/// The window's side of the Agent's host context.
#[derive(Default)]
pub(crate) struct ContextState {
    pub(super) selection: SharedSelection,
    surface: Option<Source>,
    /// The PDF the writer last worked in, whose selection is the PDF's.
    pdf: Option<WeakEntity<PdfPanel>>,
    /// That PDF's selection as last seen, and its reading.
    pdf_mark: Option<(usize, String)>,
    _pdf_read: Option<Task<()>>,
    /// What was last pushed from: the editor and the document in front,
    /// the compiled PDF's page and count. A document's own report pushes as
    /// it comes (`surface_context_changed`).
    front: Option<EntityId>,
    document: Option<String>,
    /// The file view that is no editor (an image, a project PDF) the writer
    /// last worked in, until the editor takes the keyboard again.
    other_front: Option<String>,
    pdf_place: (usize, usize),
    /// The paper's reader the writer last worked in (its view or its text's
    /// editor focused), until another surface takes the keyboard, and the
    /// reading file it showed when last pushed.
    paper: Option<WeakEntity<PaperReader>>,
    paper_path: Option<String>,
}

impl Shell {
    /// Every PDF panel of the window: the compiled PDF's, a root
    /// document's, a project PDF's.
    fn pdf_panels(&self) -> Vec<Entity<PdfPanel>> {
        std::iter::once(self.pdf().clone())
            .chain(self.root_pdfs.iter().map(|(_, panel)| panel.clone()))
            .chain(self.file_pdfs.iter().cloned())
            .collect()
    }

    fn context(&mut self) -> &mut ContextState {
        &mut self.agent.state.context
    }

    /// Read the window on a frame: when the writer moved between the editor
    /// and a PDF, or selected in a PDF, or the editor or document in
    /// front or the compiled PDF's page changed, the Agent hears of it.
    pub(crate) fn agent_follow_front(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut changed = false;
        let focused_pdf = self
            .pdf_panels()
            .into_iter()
            .find(|panel| panel.read(cx).focus_handle(cx).contains_focused(window, cx));
        let editor = self.active_editor();
        let editor_focused = editor.as_ref().is_some_and(|editor| {
            editor
                .read(cx)
                .focus_handle(cx)
                .contains_focused(window, cx)
        });
        let reader = self.focused_reader(editor.as_ref(), editor_focused, cx);
        let focused_other = if editor_focused {
            None
        } else {
            self.workspace
                .read(cx)
                .engine()
                .focused_view()
                .filter(|view| {
                    let doc = self.document(cx);
                    !file_key(doc.views.get(*view)).is_empty()
                        && self.panel_of_view(view).is_some_and(|panel| {
                            panel.view().downcast::<EditorPanel>().is_err()
                                && panel.focus_handle(cx).contains_focused(window, cx)
                        })
                })
                .map(str::to_string)
        };
        let surface = match (&focused_pdf, &reader, editor_focused) {
            (Some(_), _, _) => Some(Source::Pdf),
            (None, Some(_), _) => Some(Source::Paper),
            (None, None, true) => Some(Source::Editor),
            (None, None, false) if focused_other.is_some() && self.context().paper.is_some() => {
                Some(Source::Editor)
            }
            (None, None, false) => None,
        };
        // A paper stays in front while the keyboard is elsewhere (the
        // Agent's composer), until another surface or file view takes it.
        match reader {
            Some(reader) => self.context().paper = Some(reader.downgrade()),
            None if surface.is_some() => self.context().paper = None,
            None => {}
        }
        if let Some(surface) = surface
            && self.context().surface != Some(surface)
        {
            let state = self.context();
            state.surface = Some(surface);
            state.selection.activate(surface);
            changed = true;
        }
        if let Some(panel) = focused_pdf
            && self.context().pdf.as_ref().and_then(WeakEntity::upgrade) != Some(panel.clone())
        {
            self.context().pdf = Some(panel.downgrade());
            self.context().pdf_mark = None;
        }
        changed |= self.watch_pdf_selection(cx);
        let other_front = if editor_focused {
            None
        } else {
            focused_other.or_else(|| self.context().other_front.clone())
        };
        self.context().other_front = other_front;
        let front = editor.as_ref().map(Entity::entity_id);
        let (document, _) = self.agent_front_document(cx);
        let live = self.pdf().read(cx).live_view().read(cx);
        let pdf_place = (live.current_page(), live.page_count());
        let paper_path = self.agent_paper(cx).map(|reader| reader.read(cx).path());
        let state = self.context();
        if front != state.front
            || document != state.document
            || pdf_place != state.pdf_place
            || paper_path != state.paper_path
        {
            changed = true;
        }
        if changed {
            self.push_agent_workspace(cx);
        }
        // A deck opened while a turn runs lights up too.
        if self.agent_turn_running() {
            self.tell_decks_of_turn(cx);
        }
    }

    /// The selection in the PDF the writer last worked in: read again when
    /// it changes, and shared once read. True when it is now empty.
    fn watch_pdf_selection(&mut self, cx: &mut Context<Self>) -> bool {
        let panel = self
            .context()
            .pdf
            .as_ref()
            .and_then(WeakEntity::upgrade)
            .unwrap_or_else(|| self.pdf().clone());
        let view = panel.read(cx).live_view().clone();
        let mark = view.read(cx).selection_mark();
        if mark == self.context().pdf_mark {
            return false;
        }
        self.context().pdf_mark = mark.clone();
        let Some((page, _)) = mark else {
            self.context()._pdf_read = None;
            self.context()
                .selection
                .observe(Source::Pdf, Selected::default());
            return true;
        };
        // A project PDF open as a document names itself and the page.
        let document = match panel.read(cx).kind() {
            PdfPanelKind::File(path) => self.root(cx).and_then(|root| {
                path.strip_prefix(&root).ok().map(|relative| {
                    json!({
                        "path": relative.to_string_lossy().replace('\\', "/"),
                        "page": page + 1,
                        "pageCount": view.read(cx).page_count(),
                    })
                })
            }),
            _ => None,
        };
        let Some(text) = view.update(cx, |view, cx| view.selected_text_task(cx)) else {
            return false;
        };
        let read = cx.spawn(async move |this, cx| {
            let text = text.await;
            this.update(cx, |this, cx| {
                this.context().selection.observe(
                    Source::Pdf,
                    Selected {
                        text: text.trim().to_string(),
                        pdf_document: document,
                        ..Selected::default()
                    },
                );
                this.push_agent_workspace(cx);
            })
            .ok();
        });
        self.context()._pdf_read = Some(read);
        false
    }

    /// The paper's reader the keyboard is in: its view focused, or the
    /// editor of one of its texts.
    fn focused_reader(
        &self,
        editor: Option<&Entity<EditorPanel>>,
        editor_focused: bool,
        cx: &App,
    ) -> Option<Entity<PaperReader>> {
        let doc = self.document(cx);
        let focused = self
            .workspace
            .read(cx)
            .engine()
            .focused_view()
            .map(|view| file_key(doc.views.get(view)))
            .filter(|key| super::papers::is_reader_key(key))
            .and_then(|key| self.reader_of(&key, cx));
        focused.or_else(|| {
            let editor = editor.filter(|_| editor_focused)?;
            self.documents
                .readers
                .iter()
                .find(|reader| reader.read(cx).editors().any(|text| text == editor))
                .cloned()
        })
    }

    /// The paper in its reader the Agent takes as in front, while that
    /// reader is still open.
    pub(super) fn agent_paper(&self, _: &App) -> Option<Entity<PaperReader>> {
        let reader = self.agent.state.context.paper.as_ref()?.upgrade()?;
        (self.documents.readers.contains(&reader)
            && self.view_of_panel(reader.entity_id()).is_some())
        .then_some(reader)
    }

    /// The document the Agent takes as in front, and whether it is the
    /// active editor's: the file view that is no editor the writer last
    /// worked in (an image, a project PDF, in any pane), or another tab
    /// selected over the editor's in its panel, is in front instead, without
    /// the editor's caret or selection.
    fn agent_front_document(&self, cx: &App) -> (Option<String>, bool) {
        let doc = self.document(cx);
        if let Some(focused) = self.agent.state.context.other_front.as_deref()
            && let key = file_key(doc.views.get(focused))
            && !key.is_empty()
            && !super::papers::is_reader_key(&key)
        {
            return (Some(key), false);
        }
        let document = self.active_document(cx);
        let Some(view) = self
            .active_editor()
            .and_then(|editor| self.view_of_editor(&editor))
        else {
            return (document, true);
        };
        let covering = trellis::model::panels_of(doc.root.as_ref())
            .into_iter()
            .find(|panel| panel.views.contains(&view))
            .filter(|panel| panel.selected != view)
            .map(|panel| file_key(doc.views.get(&panel.selected)))
            .filter(|key| !key.is_empty());
        match covering {
            Some(key) => (Some(key), false),
            None => (document, true),
        }
    }

    /// Tell the Agent what the writer is working in now (`useAgentContext`).
    pub(crate) fn push_agent_workspace(&mut self, cx: &mut Context<Self>) {
        if let Some(reader) = self.agent_paper(cx) {
            return self.push_agent_paper(&reader, cx);
        }
        self.context().paper_path = None;
        let editor = self.active_editor();
        let front = editor.as_ref().map(Entity::entity_id);
        let (document, editor_in_front) = self.agent_front_document(cx);
        let editor = editor.filter(|_| editor_in_front);
        let structured = editor
            .as_ref()
            .and_then(|editor| editor.read(cx).structured().cloned());
        let mut active_file = document
            .clone()
            .filter(|key| !super::papers::is_reader_key(key))
            .unwrap_or_default();
        let mut editor_position = None;
        let mut selected = Selected::default();
        if let Some(editor) = &editor {
            let state = workspace::of_editor(editor.read(cx), cx);
            if active_file.is_empty() {
                active_file = state.relative.clone();
            }
            // A board, sheet or deck has no caret of its own.
            if structured.is_none() {
                editor_position = Some(state.position);
                selected = state.selected;
            }
        }
        // The visual Markdown editor's selection, when its source has none.
        if selected.text.is_empty()
            && let Some(text) = editor
                .as_ref()
                .and_then(|editor| editor.read(cx).markdown_document())
                .and_then(|document| document.read(cx).visual_selection())
                .map(str::trim)
                .filter(|text| !text.is_empty())
        {
            selected = Selected {
                text: text.to_string(),
                ..Selected::default()
            };
        }
        // Open Slide's deck and slide, while a deck is in front.
        let presentation = structured
            .filter(|document| document.read(cx).kind() == StructuredKind::Deck)
            .and_then(|document| document.read(cx).deck_context().cloned());
        let live = self.pdf().read(cx).live_view().read(cx);
        let pdf_place = (live.current_page(), live.page_count());
        let state = self.context();
        state.front = front;
        state.document = document;
        state.pdf_place = pdf_place;
        state.selection.observe(Source::Editor, selected);
        let workspace = host_context::workspace(Inputs {
            active_file: &active_file,
            editor_position,
            surface: state.surface.unwrap_or(Source::Editor),
            pdf_page: pdf_place.0 + 1,
            pdf_page_count: (pdf_place.1 > 0).then_some(pdf_place.1),
            presentation,
            paper: None,
            selection: &state.selection,
        });
        self.agent_surface(cx)
            .update(cx, |surface, cx| surface.set_workspace(workspace, cx));
    }

    /// The paper in `reader` is in front (`activePaper`): its reading file,
    /// the text it shows and that text's selection, the paper's, with no
    /// caret, as `buildAgentHostContext` takes a paper before any file.
    fn push_agent_paper(&mut self, reader: &Entity<PaperReader>, cx: &mut Context<Self>) {
        let (path, view, summary, editor) = {
            let reader = reader.read(cx);
            (
                reader.path(),
                reader.view(),
                serde_json::to_value(reader.paper()).unwrap_or_default(),
                reader.editor().cloned(),
            )
        };
        let mut selected = editor
            .as_ref()
            .map(|editor| workspace::of_editor(editor.read(cx), cx).selected)
            .unwrap_or_default();
        selected.lines = None;
        if selected.text.is_empty()
            && let Some(text) = editor
                .as_ref()
                .and_then(|editor| editor.read(cx).markdown_document())
                .and_then(|document| document.read(cx).visual_selection())
                .map(str::trim)
                .filter(|text| !text.is_empty())
        {
            selected.text = text.to_string();
            selected.length = None;
        }
        let front = self.active_editor().as_ref().map(Entity::entity_id);
        let (document, _) = self.agent_front_document(cx);
        let live = self.pdf().read(cx).live_view().read(cx);
        let pdf_place = (live.current_page(), live.page_count());
        let state = self.context();
        state.front = front;
        state.document = document;
        state.pdf_place = pdf_place;
        state.paper_path = Some(path.clone());
        state.selection.observe(Source::Paper, selected);
        let workspace = host_context::workspace(Inputs {
            active_file: &path,
            editor_position: None,
            surface: Source::Paper,
            pdf_page: pdf_place.0 + 1,
            pdf_page_count: (pdf_place.1 > 0).then_some(pdf_place.1),
            presentation: None,
            paper: Some((
                summary,
                match view {
                    ReaderView::FullText => "fulltext",
                    ReaderView::Overview => "blog",
                },
            )),
            selection: &state.selection,
        });
        self.agent_surface(cx)
            .update(cx, |surface, cx| surface.set_workspace(workspace, cx));
    }

    /// The Agent took the selection: it stays out until it changes.
    pub(super) fn agent_selection_taken(&mut self, cx: &mut Context<Self>) {
        self.context().selection.dismiss();
        self.push_agent_workspace(cx);
    }
}
