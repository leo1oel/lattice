//! Margin review's keyboard walk (`walk` in `overleaf-margin-review.tsx`):
//! from a pip, a card beside its line or a card in the rail that has focus,
//! J or ↓ goes to the next item and K or ↑ to the previous one, round from
//! either end, by their places in the text. An open card follows the walk
//! (the next item's card opens over its pip, or in the rail), and an item
//! whose line is out of sight is scrolled to a third of the way down first.
//! Escape steps back out: an open card closes and its pip keeps focus, and
//! with none open the caret takes the keyboard again.
//!
//! The keys are bound in the layer's own key context ([`MARGIN_CONTEXT`],
//! `shell/commands/keymap.rs`), so they win over the window's own uses of
//! the arrows and Escape while an item has focus, and never reach the text.

use editor::display_map::ToDisplayPoint as _;
use gpui::{App, Context, FocusHandle, Focusable as _, Window, actions, point};
use language::Point;

use super::{MarginLayout, RAIL_FIRST_CARD};
use crate::editor_panel::EditorPanel;

actions!(
    margin_review,
    [
        /// The next comment or suggestion (J, ↓).
        NextReviewItem,
        /// The previous comment or suggestion (K, ↑).
        PreviousReviewItem,
        /// Close the open card, else give the caret the keyboard (Escape).
        LeaveReviewItem,
    ]
);

/// The key context of margin review's layer, where J, K, the arrows and
/// Escape walk it.
pub const MARGIN_CONTEXT: &str = "MarginReview";

/// The prefix of a rail card's focus key, apart from its pip's.
const RAIL: &str = "rail:";

impl EditorPanel {
    /// The handle `key`'s pip or card beside its line tracks (`rail` false),
    /// or its card in the rail.
    pub(super) fn margin_focus(&self, key: &str, rail: bool, cx: &App) -> FocusHandle {
        let id = if rail {
            format!("{RAIL}{key}")
        } else {
            key.to_string()
        };
        self.margin
            .focus
            .borrow_mut()
            .entry(id)
            .or_insert_with(|| cx.focus_handle())
            .clone()
    }

    /// The items' keys in their order in the text, the walk's order.
    pub fn margin_keys(&self) -> Vec<String> {
        let mut items: Vec<(usize, String)> = self
            .margin
            .items
            .iter()
            .map(|item| (item.offset, item.key.clone()))
            .collect();
        items.sort();
        items.into_iter().map(|(_, key)| key).collect()
    }

    /// The item whose pip or card holds focus, if one does.
    pub fn margin_focused(&self, window: &Window, cx: &App) -> Option<String> {
        self.margin
            .focus
            .borrow()
            .iter()
            .find(|(_, handle)| handle.contains_focused(window, cx))
            .map(|(id, _)| id.strip_prefix(RAIL).unwrap_or(id).to_string())
    }

    /// Move focus `step` items on from the focused one.
    pub(super) fn margin_walk(&mut self, step: isize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(from) = self.margin_focused(window, cx) else {
            return;
        };
        let keys = self.margin_keys();
        let Some(at) = keys.iter().position(|key| *key == from) else {
            return;
        };
        let next = keys[(at as isize + step).rem_euclid(keys.len() as isize) as usize].clone();
        // An open card follows the walk: over the next pip, or in the rail.
        let layout = self.margin.layout;
        if self.margin.open.is_some() && layout != Some(MarginLayout::Wide) {
            self.margin.hover = None;
            self.margin.open = Some((next.clone(), true));
            self.margin.rail = layout == Some(MarginLayout::Narrow);
        }
        self.margin_focus_item(&next, window, cx);
    }

    /// Escape: close the open card back to its pip, else back to the text.
    pub(super) fn margin_leave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((key, _)) = self.margin.open.take() {
            self.margin.hover = None;
            self.margin.rail = false;
            let focus = self.margin_focus(&key, false, cx);
            window.focus(&focus, cx);
            cx.notify();
        } else {
            window.focus(&self.editor.focus_handle(cx), cx);
        }
    }

    /// Focus `key`'s pip or card (its rail card while the rail is open),
    /// its line brought into sight first.
    pub(super) fn margin_focus_item(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.margin.focus_key = Some(key.to_string());
        if let Some((index, offset)) = self
            .margin
            .items
            .iter()
            .position(|item| item.key == key)
            .map(|index| (index, self.margin.items[index].offset))
        {
            if self.margin.rail {
                self.margin
                    .rail_scroll
                    .scroll_to_item(RAIL_FIRST_CARD + index);
            }
            let line = self.buffer.read(cx).snapshot().offset_to_point(offset).row;
            self.editor.update(cx, |editor, cx| {
                let display = editor.snapshot(window, cx);
                let row = Point::new(line, 0)
                    .to_display_point(&display.display_snapshot)
                    .row()
                    .0 as f64;
                let visible = editor.visible_line_count().unwrap_or(0.);
                let position = editor.scroll_position(cx);
                // As the Tauri walk does: a line above the view, or within
                // its last two lines, comes to a third of the way down.
                if row < position.y || row > position.y + visible - 2. {
                    let top = (row - visible / 3.).max(0.);
                    editor.set_scroll_position(point(position.x, top), window, cx);
                }
            });
        }
        let focus = self.margin_focus(key, self.margin.rail, cx);
        window.focus(&focus, cx);
        cx.notify();
    }
}
