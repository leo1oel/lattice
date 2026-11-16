//! The caret card on the adapter (`caret_card.rs` has the providers' side):
//! which target the caret is in, Escape putting the card away until the
//! caret leaves it, and the card placed by it in the editor's frame.

use std::{ops::Range, rc::Rc};

use editor::ToOffset as _;
use gpui::{
    Anchor as Corner, AnyElement, App, Context, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Pixels, Styled as _, Window, anchored, canvas,
    deferred, div, point, px,
};
use language::ToOffset as _;

use super::LatticeEditor;
use crate::{
    caret_card::{
        CARD_INSET, CaretCardContext, CaretCardProvider, TargetRects, inset, place, text_box,
    },
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

    /// After an edit, let the provider start on the card for the target
    /// the caret is now in (KaTeX's picture of the formula as typed), so it
    /// is being made while the frame that draws the edit is waited for.
    /// Nothing for a target Escape put the card away for.
    pub(super) fn prefetch_caret_card(&mut self, cx: &mut Context<Self>) {
        let Some(provider) = self.caret_card.provider.clone() else {
            return;
        };
        let text = self.buffer.read(cx).snapshot();
        let caret = self.caret_offset(cx);
        let Some(target) = provider.target(&text, caret, cx) else {
            return;
        };
        if self
            .caret_card
            .dismissed
            .is_some_and(|dismissed| dismissed.to_offset(&text) == target.start)
        {
            return;
        }
        let context = CaretCardContext {
            editor: cx.weak_entity(),
            max_width: Pixels::MAX,
            max_height: Pixels::MAX,
            caret,
            text,
        };
        provider.prefetch(target, &context, cx);
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
        // Placed by the text's own box on each line, not the line's, as
        // CodeMirror's `coordsAtPos` gives the Tauri card a character's box.
        let content = text_height(window, cx);
        let mut rect = |offset| {
            geometry::caret_rect(&self.editor, &text, offset, bounds, window, cx)
                .map(|line| (line, text_box(line, content)))
        };
        let (_, start_rect) = rect(target.start)?;
        let (_, end_rect) = rect(target.end)?;
        let (caret_line, caret_rect) = rect(caret)?;
        let rects = TargetRects {
            start: start_rect,
            end_bottom: end_rect.bottom(),
            caret: caret_rect,
        };
        let mut context = CaretCardContext {
            editor: cx.weak_entity(),
            max_width: (view.size.width - px(16.)).max(px(160.)),
            max_height: Pixels::MAX,
            caret,
            text,
        };
        // The provider says the card's size before it is placed, as
        // CodeMirror measures a tooltip first, so a card opens on the side
        // it fits in the frame it first shows, with no frame laid out
        // unseen to measure it.
        let size = provider.size(target.clone(), &context, window, cx)?;
        let placement = place(
            rects,
            view,
            inset(view, CARD_INSET),
            size,
            caret_line.size.height,
        )?;
        context.max_height = placement.room;
        let content = provider.card(target.clone(), &context, window, cx)?;
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
                            .child(content)
                            .child(record),
                    ),
            )
            .into_any_element(),
        )
    }
}

/// How tall the buffer font's text is (its ascent and descent), the box a
/// browser gives a character inside its line.
fn text_height(window: &Window, cx: &App) -> Pixels {
    let (font, font_size) = super::gutter_column::buffer_font(cx);
    let text_system = window.text_system();
    let font_id = text_system.resolve_font(&font);
    text_system.ascent(font_id, font_size) + text_system.descent(font_id, font_size).abs()
}
