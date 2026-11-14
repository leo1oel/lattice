//! "Review here" (`requestMarginReviewHere` in `margin-review-mode.ts`):
//! the palette's way to the comment or suggestion by the caret, the one on
//! or after its line, else the first. Markers open its card over its pip
//! (a narrow editor, the rail); wide cards are open already.

use gpui::Context;

use super::{MarginLayout, MarginMode};
use crate::editor_panel::EditorPanel;

impl EditorPanel {
    /// Open the item by the caret; false when there is none.
    pub fn margin_review_here(&mut self, cx: &mut Context<Self>) -> bool {
        if self.margin.mode == MarginMode::Off {
            return false;
        }
        let snapshot = self.buffer.read(cx).snapshot();
        let line = language::Point::new(self.cursor.0.saturating_sub(1), 0);
        let from = snapshot.point_to_offset(line.min(snapshot.max_point()));
        let Some(next) = self
            .margin
            .items
            .iter()
            .find(|item| item.offset >= from)
            .or(self.margin.items.first())
        else {
            return false;
        };
        let key = next.key.clone();
        let layout = self.margin.layout.unwrap_or(MarginLayout::Markers);
        if layout != MarginLayout::Wide {
            self.margin.hover = None;
            self.margin.open = Some((key, true));
            self.margin.rail = layout == MarginLayout::Narrow;
            cx.notify();
        }
        true
    }
}
