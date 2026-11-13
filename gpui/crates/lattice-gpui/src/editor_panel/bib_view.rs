//! A `.bib` file's views (`trellis-header-tools.tsx`, `bib-preview.tsx`), on
//! the document views an HTML file has (`views.rs`): Edit, the source alone;
//! Split, the source beside its visual form, the list following the
//! reference under the caret and a reference picked in the list shown in the
//! source; Preview, the visual form alone. The view last chosen is the one
//! the next bibliography opens in, as the Tauri app remembers one view for
//! every bibliography (Edit at first).

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Focusable as _, Global, IntoElement, Window,
};

use editor::{SelectionEffects, scroll::Autoscroll};

use super::{DocumentView, EditorPanel, EditorPanelEvent};
use crate::papers::{
    PapersPanel,
    bib_editor::{BibEditor, BibEditorEvent},
};

/// A `.bib` file's visual form, made the first time a view shows it, and
/// the library its references open their papers from.
#[derive(Default)]
pub(super) struct BibState {
    editor: Option<Entity<BibEditor>>,
    papers: Option<Entity<PapersPanel>>,
    /// The source editor has the keyboard: only then does the list follow
    /// its caret (`use-bib-source-sync.ts`), never a caret moved for it.
    source_focused: bool,
}

/// The view the next bibliography opens in.
struct RememberedBibView(DocumentView);

impl Global for RememberedBibView {}

pub(super) fn is_bib_path(path: &std::path::Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("bib"))
}

pub(super) fn remembered_bib_view(cx: &App) -> DocumentView {
    cx.try_global::<RememberedBibView>()
        .map_or(DocumentView::Source, |remembered| remembered.0)
}

pub(super) fn remember_bib_view(view: DocumentView, cx: &mut App) {
    cx.set_global(RememberedBibView(view));
}

impl EditorPanel {
    pub(super) fn is_bib(&self) -> bool {
        is_bib_path(&self.path)
    }

    /// The library a bibliography's references open their papers from.
    pub fn set_papers(&mut self, papers: Entity<PapersPanel>, cx: &mut Context<Self>) {
        if let Some(bib) = &self.bib.editor {
            bib.update(cx, |bib, cx| bib.set_papers(papers.clone(), cx));
        }
        self.bib.papers = Some(papers);
    }

    /// The `.bib` file's visual form, when it is showing.
    pub fn bib_editor(&self) -> Option<&Entity<BibEditor>> {
        self.bib.editor.as_ref().filter(|_| {
            self.document_view()
                .is_some_and(|view| view != DocumentView::Source)
        })
    }

    /// A view was chosen: a bibliography's Preview takes the keys, and its
    /// Split's list starts at the reference under the caret.
    pub(super) fn bib_view_chosen(
        &mut self,
        view: DocumentView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.is_bib() {
            return;
        }
        match view {
            DocumentView::Preview => {
                let bib = self.ensure_bib(window, cx);
                window.focus(&bib.focus_handle(cx), cx);
            }
            DocumentView::Split => {
                let line = self.cursor.0;
                let bib = self.ensure_bib(window, cx);
                bib.update(cx, |bib, cx| bib.follow_line(line, cx));
            }
            DocumentView::Source => {}
        }
    }

    /// A bibliography opening in Preview or Split has its visual form at
    /// once, so the panel's focus is the form's before its first frame.
    pub(super) fn ensure_bib_for_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_bib()
            && self
                .document_view()
                .is_some_and(|view| view != DocumentView::Source)
        {
            self.ensure_bib(window, cx);
        }
    }

    /// A bibliography's visual form, when its view shows it.
    pub(super) fn bib_for_view(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let view = self.document_view()?;
        if !self.is_bib() || view == DocumentView::Source {
            return None;
        }
        Some(self.ensure_bib(window, cx).into_any_element())
    }

    fn ensure_bib(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<BibEditor> {
        if let Some(bib) = &self.bib.editor {
            return bib.clone();
        }
        let root = self.project.read(cx).root().to_path_buf();
        let (relative, buffer) = (self.relative.clone(), self.buffer.clone());
        let bib = cx.new(|cx| BibEditor::new(root, relative, buffer, window, cx));
        if let Some(papers) = self.bib.papers.clone() {
            bib.update(cx, |bib, cx| bib.set_papers(papers, cx));
        }
        cx.subscribe_in(&bib, window, |this, _, event, window, cx| match event {
            BibEditorEvent::OpenLine { path, line } => {
                if *path == this.relative {
                    // The source of this file: beside the list, unless only
                    // the source is showing.
                    if this.document_view() == Some(DocumentView::Preview) {
                        this.set_document_view(DocumentView::Split, window, cx);
                    }
                    this.go_to_line(*line, window, cx);
                } else {
                    cx.emit(EditorPanelEvent::OpenLocation {
                        path: path.clone(),
                        line: *line,
                    });
                }
            }
            BibEditorEvent::Picked { from } => {
                if this.document_view() == Some(DocumentView::Split) {
                    this.show_offset(*from, window, cx);
                }
            }
        })
        .detach();
        self.bib.editor = Some(bib.clone());
        bib
    }

    /// The file moved: the form names it where it is now.
    pub(super) fn bib_moved(&mut self, cx: &mut Context<Self>) {
        if let Some(bib) = &self.bib.editor {
            let relative = self.relative.clone();
            bib.update(cx, |bib, _| bib.set_path(relative));
        }
    }

    pub(super) fn bib_source_focused(&mut self, focused: bool) {
        self.bib.source_focused = focused;
    }

    /// The writer moved the caret to `line`: the list beside the source
    /// follows it.
    pub(super) fn bib_follow_caret(&mut self, line: u32, cx: &mut Context<Self>) {
        if self.document_view() == Some(DocumentView::Split)
            && self.bib.source_focused
            && let Some(bib) = &self.bib.editor
        {
            bib.update(cx, |bib, cx| bib.follow_line(line, cx));
        }
    }

    /// The visual form's focus while it shows alone (Preview): it takes the
    /// keys.
    pub(super) fn bib_focus(&self, cx: &App) -> Option<gpui::FocusHandle> {
        self.bib_editor()
            .filter(|_| self.document_view() == Some(DocumentView::Preview))
            .map(|bib| bib.focus_handle(cx))
    }

    /// Put the cursor at the byte offset `from`, in the middle of the
    /// editor, leaving the focus where it is.
    fn show_offset(&mut self, from: usize, window: &mut Window, cx: &mut Context<Self>) {
        let point = {
            let buffer = self.buffer.read(cx);
            buffer.offset_to_point(from.min(buffer.len()))
        };
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::center()),
                window,
                cx,
                |selections| selections.select_ranges([point..point]),
            );
        });
    }
}
