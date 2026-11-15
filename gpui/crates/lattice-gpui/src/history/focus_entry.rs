//! History opened on one entry (`src/history/history-focus.ts`,
//! `history-drawer.tsx`'s `historyFocus`): a revision round's Open in History
//! shows the Activity view, opens the round's entry, and scrolls it into
//! view once it is drawn. An entry not read yet is opened once the activity
//! log has it.

use std::{cell::RefCell, rc::Rc};

use gpui::{AnyElement, Bounds, Context, IntoElement, Pixels, Styled as _, canvas, point, px};

use super::{
    panel::HistoryPanel,
    timeline::{ActivityFilter, HistoryView, activity_key},
};

/// How far under the panel's top the focused entry lands.
const MARGIN: Pixels = px(40.);

#[derive(Default)]
pub(super) struct Focus {
    /// The entry asked for, until the activity log has it.
    pending: Option<String>,
    /// The row to scroll into view once it is drawn.
    scroll_to: Rc<RefCell<Option<String>>>,
}

impl HistoryPanel {
    /// Show the entry `id` in the Activity view, opened.
    pub(crate) fn focus_entry(&mut self, id: &str, cx: &mut Context<Self>) {
        self.select_view(HistoryView::Activity, cx);
        self.set_filter(ActivityFilter::All, cx);
        self.focus.pending = Some(id.to_string());
        self.apply_focus(cx);
    }

    /// The row open now, by its key (for a scenario).
    pub(crate) fn expanded_row(&self) -> Option<&str> {
        self.expanded.as_deref()
    }

    /// Open the entry asked for once the activity log has it.
    pub(super) fn apply_focus(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.focus.pending.clone() else {
            return;
        };
        let Some(item) = self.activity.iter().find(|item| item.id == id).cloned() else {
            return;
        };
        self.focus.pending = None;
        let key = activity_key(&id);
        if self.expanded.as_deref() != Some(key.as_str()) {
            self.toggle_activity(&item, cx);
        }
        *self.focus.scroll_to.borrow_mut() = Some(key);
        cx.notify();
    }

    /// For the row `key`, a probe that scrolls it into view when it is the
    /// one asked for.
    pub(super) fn focus_probe(&self, key: &str) -> Option<AnyElement> {
        if self.focus.scroll_to.borrow().as_deref() != Some(key) {
            return None;
        }
        let (wanted, scroll, sticky) =
            (self.focus.scroll_to.clone(), self.scroll.clone(), self.sticky.clone());
        Some(
            canvas(
                move |bounds: Bounds<Pixels>, _, _| {
                    if wanted.borrow_mut().take().is_none() {
                        return;
                    }
                    let offset = scroll.offset();
                    let top = bounds.origin.y - sticky.viewport_top() - offset.y;
                    scroll.set_offset(point(offset.x, -(top - MARGIN).max(px(0.))));
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0()
            .into_any_element(),
        )
    }
}
