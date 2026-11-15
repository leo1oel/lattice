//! The caret card on the adapter (`caret_card.rs` has the providers' side):
//! which target the caret is in, Escape putting the card away until the
//! caret leaves it, and the card placed by it in the editor's frame.

use std::{ops::Range, rc::Rc};

use editor::ToOffset as _;
use gpui::{
    Anchor as Corner, AnyElement, App, Context, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Styled as _, Window, anchored, canvas, deferred,
    div, point, prelude::FluentBuilder as _, px,
};
use language::ToOffset as _;

use super::LatticeEditor;
use crate::{
    caret_card::{CARD_INSET, CaretCardContext, CaretCardProvider, TargetRects, inset, place},
    geometry,
};

/// The caret card's state on the adapter.
#[derive(Default)]
pub(super) struct CaretCardState {
    provider: Option<Rc<dyn CaretCardProvider>>,
    /// The target the caret is in, as of the last frame.
    target: Option<Range<language::Anchor>>,
    /// Where the target Escape put the card away for starts: it stays away
    /// until the caret leaves that target.
    dismissed: Option<language::Anchor>,
    /// Where the target of the card drawn last frame starts.
    shown: Option<usize>,
}

impl LatticeEditor {
    /// Show `provider`'s card by the caret, in place of any before.
    pub fn set_caret_card(&mut self, provider: Rc<dyn CaretCardProvider>, cx: &mut Context<Self>) {
        self.caret_card.provider = Some(provider);
        cx.notify();
    }

    /// The caret card's provider, if one is set.
    pub fn caret_card_provider(&self) -> Option<Rc<dyn CaretCardProvider>> {
        self.caret_card.provider.clone()
    }

    /// The target of the caret card drawn last frame, in buffer offsets:
    /// `None` when none was.
    pub fn shown_caret_card(&self, cx: &App) -> Option<Range<usize>> {
        self.caret_card.shown?;
        let text = self.buffer.read(cx).snapshot();
        self.caret_card
            .target
            .as_ref()
            .map(|target| target.start.to_offset(&text)..target.end.to_offset(&text))
    }

    /// The main caret's buffer offset (CodeMirror's `selection.main.head`).
    pub fn caret_offset(&self, cx: &App) -> usize {
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        editor
            .selections
            .newest_anchor()
            .head()
            .to_offset(&snapshot)
            .0
    }

    /// Escape puts the card away while the caret stays in its target. The
    /// key goes on to the editor: it still leaves Vim's insert mode, say.
    /// An Escape that closes the completion menu is the menu's alone.
    pub(super) fn caret_card_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        if event.keystroke.key != "escape"
            || self.editor.read(cx).has_visible_completions_menu()
            || self.caret_card.dismissed.is_some()
        {
            return;
        }
        if let Some(target) = &self.caret_card.target {
            self.caret_card.dismissed = Some(target.start);
            cx.notify();
        }
    }

    pub(super) fn render_caret_card(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let card = self.build_caret_card(window, cx);
        if card.is_none() {
            self.caret_card.shown = None;
            self.painted.borrow_mut().caret_card = None;
        }
        card
    }

    fn build_caret_card(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let provider = self.caret_card.provider.clone()?;
        let text = self.buffer.read(cx).snapshot();
        let caret = self.caret_offset(cx);
        let target = provider.target(&text, caret, cx);
        let start = target.as_ref().map(|target| target.start);
        if let Some(dismissed) = self.caret_card.dismissed
            && start != Some(dismissed.to_offset(&text))
        {
            self.caret_card.dismissed = None;
        }
        self.caret_card.target = target
            .as_ref()
            .map(|target| text.anchor_before(target.start)..text.anchor_after(target.end));
        let target = target?;
        // It shows only while the editor has the keyboard: the caret it
        // follows is the one being typed at.
        let focused = window.is_window_active() && self.editor.focus_handle(cx).is_focused(window);
        if self.caret_card.dismissed.is_some() || !focused {
            return None;
        }
        let painted = self.painted.borrow().clone();
        let (bounds, view) = (painted.bounds?, painted.view?);
        let mut rect =
            |offset| geometry::caret_rect(&self.editor, &text, offset, bounds, window, cx);
        let start_rect = rect(target.start)?;
        let end_rect = rect(target.end)?;
        let caret_rect = rect(caret)?;
        let rects = TargetRects {
            start: start_rect,
            end_bottom: end_rect.bottom(),
            caret: caret_rect,
        };
        // The card's size is last frame's. A card for another target is
        // laid out once unseen first, so it opens on the side it fits.
        let measured = self.caret_card.shown == Some(target.start);
        let last = painted
            .caret_card
            .filter(|_| measured)
            .map(|card| card.size)
            .unwrap_or_default();
        let placement = place(
            rects,
            view,
            inset(view, CARD_INSET),
            last,
            caret_rect.size.height,
        )?;
        let context = CaretCardContext {
            editor: cx.weak_entity(),
            max_width: (view.size.width - px(16.)).max(px(160.)),
            max_height: placement.room,
            caret,
            text,
        };
        let content = provider.card(target.clone(), &context, window, cx)?;
        if !measured {
            cx.on_next_frame(window, |_, _, cx| cx.notify());
        }
        self.caret_card.shown = Some(target.start);
        let record = {
            let painted = self.painted.clone();
            canvas(
                move |bounds, _, _| painted.borrow_mut().caret_card = Some(bounds),
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full()
        };
        let corner = if placement.above {
            Corner::BottomLeft
        } else {
            Corner::TopLeft
        };
        Some(
            deferred(
                anchored()
                    .position(point(placement.left, placement.edge))
                    .anchor(corner)
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        div()
                            .id("lattice-caret-card")
                            // It takes no focus, and a press on it leaves
                            // the caret where it is.
                            .occlude()
                            .when(!measured, |card| card.opacity(0.))
                            .child(content)
                            .child(record),
                    ),
            )
            .into_any_element(),
        )
    }
}
