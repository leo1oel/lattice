//! What a Markdown file's visual editor shares with the rest of the window,
//! beyond its text (`document-canvas.tsx`'s `presenceCursors` and
//! `onSelectionMarkdown`):
//!
//! - co-authors' carets on the file, while it is live with Overleaf, drawn
//!   in the visual editor as in the source (`md:presence`, rows of the
//!   file; the page leaves out the front matter it never shows);
//! - Overleaf's suggestions on the file, painted with their cards' Accept
//!   and Reject (`md:overleaf`, `md:overleaf-accept`, `md:overleaf-reject`);
//! - the text selected in the visual editor, which the Agent is told as
//!   the writer's selection (`md:selection`);
//! - the library's papers (`papers`), which its `@` menu offers and a
//!   paper dropped on it is looked up in (`md:papers`, and `doc:open`'s
//!   `papers`);
//! - a paper dragged from the Papers list over the page, which GPUI's drag
//!   never makes WebKit's: its moves, where it left, and its drop, in the
//!   page's pixels from its top left (`md:paper-drag`; on a `.tex` file's
//!   Visual page `tex:paper-drag`, which `gpui/islands/latex` replays the
//!   same way).

use gpui::{App, Bounds, Context, Pixels, Point};
use serde_json::{Value, json};

use super::{StructuredDocument, StructuredEvent};

/// What was last sent to the visual editor beside its text, so the same
/// is not sent again: co-authors' carets and Overleaf's suggestions.
#[derive(Default)]
pub(super) struct Sent {
    pub(super) presence: Option<Value>,
    pub(super) changes: Option<Value>,
}

/// A co-author's caret, as the visual editor takes it (`PresenceCursor`):
/// the 0-based row of the file and the UTF-16 column in it.
pub struct VisualCaret {
    pub name: String,
    pub hue: f64,
    pub row: u32,
    pub column: u32,
}

impl StructuredDocument {
    /// Draw these carets in the visual editor; an empty list clears them.
    pub fn set_markdown_presence(&mut self, carets: Vec<VisualCaret>, cx: &mut Context<Self>) {
        let cursors: Vec<Value> = carets
            .into_iter()
            .map(|caret| {
                json!({
                    "name": caret.name,
                    "hue": caret.hue,
                    "row": caret.row,
                    "column": caret.column,
                })
            })
            .collect();
        let cursors = Value::Array(cursors);
        if self.visual.presence.as_ref() == Some(&cursors) {
            return;
        }
        self.post("md:presence", json!({ "cursors": cursors }), cx);
        self.visual.presence = Some(cursors);
    }

    /// Paint Overleaf's suggestions on the file in the visual editor:
    /// `{ changes, authors, canAct }` (`md:overleaf`), positions in UTF-16
    /// units of the file, which the page moves past the front matter.
    pub fn set_markdown_changes(&mut self, review: Value, cx: &mut Context<Self>) {
        if self.visual.changes.as_ref() == Some(&review) {
            return;
        }
        self.post("md:overleaf", review.clone(), cx);
        self.visual.changes = Some(review);
    }

    /// The library's papers changed: the `@` menu lists these.
    pub fn set_library_papers(&mut self, papers: Value, cx: &mut Context<Self>) {
        let Some(session) = &mut self.markdown else {
            return;
        };
        if session.papers == papers {
            return;
        }
        session.papers = papers.clone();
        self.post("md:papers", json!({ "papers": papers }), cx);
    }

    /// The page's bounds in the window, while it is laid out.
    pub fn page_bounds(&self, cx: &App) -> Option<Bounds<Pixels>> {
        self.island.as_ref()?.read(cx).bounds(cx)
    }

    /// A paper's drag over the page: `phase` is `over`, `leave` or `drop`,
    /// `at` in the page's pixels, `paper` its identity (`PaperDrag`). A
    /// `.tex` file's Visual page takes it as `tex:paper-drag`.
    pub fn paper_drag(
        &mut self,
        phase: &str,
        at: Option<Point<Pixels>>,
        paper: Option<Value>,
        cx: &mut Context<Self>,
    ) {
        let (x, y) = at.map_or((0., 0.), |at| (f32::from(at.x), f32::from(at.y)));
        self.post(
            if self.latex.is_some() {
                "tex:paper-drag"
            } else {
                "md:paper-drag"
            },
            json!({ "phase": phase, "x": x, "y": y, "paper": paper }),
            cx,
        );
    }

    /// The visual editor's selection, if any text is selected in it.
    pub fn visual_selection(&self) -> Option<&str> {
        self.visual_selection
            .as_deref()
            .filter(|text| !text.is_empty())
    }

    /// `md:selection { text }`: the visual editor's selection changed.
    pub(super) fn visual_selection_changed(&mut self, payload: &Value, cx: &mut Context<Self>) {
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string);
        if text == self.visual_selection {
            return;
        }
        self.visual_selection = text;
        cx.emit(StructuredEvent::SurfaceContext);
    }
}
