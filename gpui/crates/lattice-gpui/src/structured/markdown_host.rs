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
//!   the writer's selection (`md:selection`).

use gpui::Context;
use serde_json::{Value, json};

use super::{StructuredDocument, StructuredEvent};

/// What was last sent to the visual editor beside its text, so the same
/// is not sent again: co-authors' carets and Overleaf's suggestions.
#[derive(Default)]
pub(super) struct Sent {
    pub(super) presence: Option<Value>,
    changes: Option<Value>,
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
