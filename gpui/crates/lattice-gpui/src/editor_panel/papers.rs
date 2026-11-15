//! What the Papers panel gives an editor, as the Tauri app's canvas gives
//! its editors the library (`document-canvas.tsx`'s `papers`,
//! `src/editor/paper-drop.ts`, `references.tsx`'s `paperDropExtension`):
//!
//! - A Markdown file's visual editor offers the library's papers in its `@`
//!   menu (`md:papers`), kept up as the library changes.
//! - A paper dragged from the Papers list over a LaTeX or Markdown source
//!   draws the drop caret where it would go (after the word under the
//!   pointer, or at a key boundary of a citation there), and goes in as
//!   `\citep{key}` (joining that citation) or Markdown's `@key` link,
//!   undone with ⌘Z as typing is. The editor lights no ring for it: the
//!   Tauri app lights one only for figures and files.
//! - Over a Markdown file's visual editor the drag is the page's: GPUI's
//!   drag never becomes WebKit's, so its moves and its drop are handed to
//!   the page (`md:paper-drag`), which replays them as the Tauri app's
//!   native bridge does (`paper-drop-bridge.ts`), its own drop cursor drawn
//!   and an `@key` citation put in at the pointer.
//!
//! The paper is looked up in the library as it is at each move and at the
//! drop, so a paper of another project, or one removed meanwhile, inserts
//! nothing; nor does a read-only editor.

use gpui::{
    App, Bounds, Context, Div, Entity, InteractiveElement as _, MouseButton, Pixels, Point, Window,
};
use lattice_core::papers::PaperSummary;
use serde_json::{Value, json};

use super::{DocumentView, EditorPanel};
use crate::{
    papers::{
        PapersPanel,
        drag::{
            DraggedPaper,
            citation::{
                CitationEdit, latex_citation_caret, latex_citation_drop, markdown_citation,
            },
        },
    },
    structured::StructuredDocument,
};

/// Lines on each side of the drop the citation is looked for in: a
/// citation command a drop joins and the word it snaps past are never
/// further away, and a drag must not copy and scan a whole thesis on every
/// move (`dropContext`).
const CONTEXT_LINES: u32 = 5;

/// The library an editor follows, and a paper's drag over its page.
#[derive(Default)]
pub(super) struct PaperLink {
    papers: Option<Entity<PapersPanel>>,
    /// The library's `list_revision` last given to the visual editor.
    revision: Option<u64>,
    /// The paper last dragged over the visual editor's page, while it is.
    on_page: Option<DraggedPaper>,
}

/// The library as the visual editor's `@` menu and drop read it: the
/// fields of `PaperSummary` it uses.
fn page_papers(papers: &[PaperSummary]) -> Value {
    Value::Array(
        papers
            .iter()
            .map(|paper| {
                json!({
                    "arxivId": paper.arxiv_id,
                    "title": paper.title,
                    "citationKey": paper.citation_key,
                    "hasFullText": paper.has_full_text,
                    "hasBlog": paper.has_blog,
                })
            })
            .collect(),
    )
}

/// Where a source takes a paper: LaTeX or Markdown.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceKind {
    Latex,
    Markdown,
}

impl EditorPanel {
    /// Follow `papers`' library: the visual editor's menu lists it.
    pub(super) fn follow_library(&mut self, papers: Entity<PapersPanel>, cx: &mut Context<Self>) {
        self._subscriptions
            .push(cx.observe(&papers, |this, _, cx| this.library_changed(cx)));
        self.library.papers = Some(papers);
        self.library.revision = None;
        self.library_changed(cx);
    }

    /// A visual editor just made for the file lists the library.
    pub(super) fn library_document_made(
        &mut self,
        document: &Entity<StructuredDocument>,
        cx: &mut Context<Self>,
    ) {
        self.give_library(document, cx);
    }

    /// The panel changed (it notifies for much else): a new list goes to
    /// the visual editor.
    fn library_changed(&mut self, cx: &mut Context<Self>) {
        let Some(document) = self.markdown_document().cloned() else {
            return;
        };
        let changed = self
            .library
            .papers
            .as_ref()
            .is_some_and(|papers| self.library.revision != Some(papers.read(cx).list_revision));
        if changed {
            self.give_library(&document, cx);
        }
    }

    fn give_library(&mut self, document: &Entity<StructuredDocument>, cx: &mut Context<Self>) {
        let Some(papers) = self.library.papers.as_ref() else {
            return;
        };
        let panel = papers.read(cx);
        self.library.revision = Some(panel.list_revision);
        let listed = page_papers(&panel.papers);
        document.update(cx, |document, cx| document.set_library_papers(listed, cx));
    }

    /// The paper `dragged` carries, in the library as it is now.
    fn resolve_paper(&self, dragged: &DraggedPaper, cx: &App) -> Option<PaperSummary> {
        let papers = self.library.papers.as_ref()?.read(cx);
        let root = self.project_root(cx);
        dragged
            .resolve(&root.to_string_lossy(), &papers.papers)
            .cloned()
    }

    /// The source a paper dropped at `position` would go into: shown there,
    /// LaTeX or Markdown, and writable.
    fn paper_source_at(&self, position: Point<Pixels>, cx: &App) -> Option<SourceKind> {
        if self.document_view() == Some(DocumentView::Preview) || self.shows_latex_visual(cx) {
            return None;
        }
        let editor = self.editor().read(cx);
        if editor.read_only(cx) || !editor.last_bounds().is_some_and(|b| b.contains(&position)) {
            return None;
        }
        let relative = self.relative().to_ascii_lowercase();
        if relative.ends_with(".tex") {
            Some(SourceKind::Latex)
        } else if relative.ends_with(".md") {
            Some(SourceKind::Markdown)
        } else {
            None
        }
    }

    /// The visual editor's page, when a paper over `position` is its.
    fn paper_page_at(&self, position: Point<Pixels>, cx: &App) -> Option<Bounds<Pixels>> {
        if !matches!(
            self.document_view(),
            Some(DocumentView::Split | DocumentView::Preview)
        ) {
            return None;
        }
        let bounds = self.markdown_document()?.read(cx).page_bounds(cx)?;
        bounds.contains(&position).then_some(bounds)
    }

    /// The lines around byte `offset` of the buffer, from a line start: the
    /// text and where it starts.
    fn drop_context(&self, offset: usize, cx: &App) -> (String, usize) {
        let snapshot = self.buffer.read(cx).snapshot();
        let row = snapshot.offset_to_point(offset.min(snapshot.len())).row;
        let first = language::Point::new(row.saturating_sub(CONTEXT_LINES), 0);
        let last_row = (row + CONTEXT_LINES).min(snapshot.max_point().row);
        let last = language::Point::new(last_row, snapshot.line_len(last_row));
        let from = snapshot.point_to_offset(first);
        let to = snapshot.point_to_offset(last);
        (snapshot.text_for_range(from..to).collect(), from)
    }

    /// The edit a paper dropped at buffer byte `at` makes in a source of
    /// `kind`, in the buffer's offsets, or `None` when it inserts nothing.
    fn paper_edit(
        &self,
        kind: SourceKind,
        paper: &PaperSummary,
        at: usize,
        cx: &App,
    ) -> Option<CitationEdit> {
        match kind {
            SourceKind::Markdown => Some(CitationEdit {
                range: at..at,
                insert: markdown_citation(self.relative(), paper),
            }),
            SourceKind::Latex => {
                let (source, from) = self.drop_context(at, cx);
                let key = paper.citation_key.as_deref().unwrap_or_default();
                let edit = latex_citation_drop(&source, at - from, key)?;
                Some(CitationEdit {
                    range: from + edit.range.start..from + edit.range.end,
                    insert: edit.insert,
                })
            }
        }
    }

    /// Where the drop caret goes for a paper over buffer byte `at`.
    fn paper_caret(
        &self,
        kind: SourceKind,
        paper: &PaperSummary,
        at: usize,
        cx: &App,
    ) -> Option<usize> {
        match kind {
            SourceKind::Markdown => Some(at),
            SourceKind::Latex => {
                let (source, from) = self.drop_context(at, cx);
                let key = paper.citation_key.as_deref().unwrap_or_default();
                latex_citation_caret(&source, at - from, key).map(|caret| from + caret)
            }
        }
    }

    /// Hand a paper's drag over the visual editor's page to it, `at` in the
    /// window; `None` when it left the page.
    fn paper_over_page(
        &mut self,
        dragged: Option<(&DraggedPaper, Point<Pixels>, Bounds<Pixels>)>,
        drop: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(document) = self.markdown_document().cloned() else {
            self.library.on_page = None;
            return;
        };
        match dragged {
            Some((paper, at, page)) => {
                self.library.on_page = (!drop).then(|| paper.clone());
                let phase = if drop { "drop" } else { "over" };
                let identity = paper.identity();
                document.update(cx, |document, cx| {
                    document.paper_drag(phase, Some(at - page.origin), Some(identity), cx)
                });
            }
            None => {
                if self.library.on_page.take().is_some() {
                    document.update(cx, |document, cx| {
                        document.paper_drag("leave", None, None, cx)
                    });
                }
            }
        }
    }

    /// A paper's drag moved: the caret where it would go in the source, or
    /// the page told where it is.
    fn paper_moved(
        &mut self,
        dragged: &DraggedPaper,
        position: Point<Pixels>,
        inside: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.drop_hover.borrow_mut().caret = None;
        self.drop_hover.borrow_mut().lit = None;
        if let Some(page) = self.paper_page_at(position, cx).filter(|_| inside) {
            self.paper_over_page(Some((dragged, position, page)), false, cx);
            return;
        }
        self.paper_over_page(None, false, cx);
        let Some(kind) = self.paper_source_at(position, cx).filter(|_| inside) else {
            return;
        };
        let Some(paper) = self.resolve_paper(dragged, cx) else {
            return;
        };
        let caret = self
            .offset_under(position, window, cx)
            .and_then(|offset| self.paper_caret(kind, &paper, offset, cx))
            .and_then(|caret| self.caret_before(caret, window, cx));
        self.drop_hover.borrow_mut().caret = caret;
    }

    /// A paper let go over the panel: cited in the source under the pointer.
    fn paper_dropped(
        &mut self,
        dragged: &DraggedPaper,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        *self.drop_hover.borrow_mut() = Default::default();
        if let Some(page) = self.paper_page_at(position, cx) {
            self.paper_over_page(Some((dragged, position, page)), true, cx);
            return;
        }
        self.paper_over_page(None, true, cx);
        let Some(kind) = self.paper_source_at(position, cx) else {
            return;
        };
        let Some(paper) = self.resolve_paper(dragged, cx) else {
            return;
        };
        let Some(at) = self.offset_under(position, window, cx) else {
            return;
        };
        if let Some(edit) = self.paper_edit(kind, &paper, at, cx) {
            let caret = edit.range.start + edit.insert.len();
            self.replace_range(
                edit.range.start,
                edit.range.end,
                &edit.insert,
                caret,
                window,
                cx,
            );
        }
    }

    /// Where the drop caret for a paper is drawn now, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn paper_drop_caret(&self, cx: &App) -> Option<Bounds<Pixels>> {
        self.drop_hover
            .borrow()
            .caret
            .filter(|_| DraggedPaper::dragging(cx))
    }

    /// The paper drag's handlers, on the panel's root.
    pub(super) fn wire_paper_drops(&self, element: Div, cx: &mut Context<Self>) -> Div {
        element
            .on_drag_move(cx.listener(
                |this, event: &gpui::DragMoveEvent<DraggedPaper>, window, cx| {
                    let position = event.event.position;
                    let inside = event.bounds.contains(&position);
                    let dragged = event.drag(cx).clone();
                    this.paper_moved(&dragged, position, inside, window, cx);
                },
            ))
            .on_drop(cx.listener(|this, dragged: &DraggedPaper, window, cx| {
                let position = window.mouse_position();
                this.paper_dropped(dragged, position, window, cx);
            }))
            // The page's native view takes the pointer from GPUI's hit test,
            // so a drop on it reaches the panel as a release outside it.
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseUpEvent, window, cx| {
                    let Some(dragged) = this.library.on_page.clone() else {
                        return;
                    };
                    if DraggedPaper::dragging(cx) {
                        this.paper_dropped(&dragged, event.position, window, cx);
                    } else {
                        this.paper_over_page(None, false, cx);
                    }
                }),
            )
    }
}
