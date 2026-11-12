//! Hover cards: the pointer over the editor, the target it rests on, and
//! the card that opens for it (`hover.rs` has the providers' side).
//!
//! The overlay's mouse listener (`overlay.rs`) reports every move over the
//! editor here. A target the pointer rests on for [`HOVER_DELAY`] opens its
//! card; the card closes [`HOVER_GRACE`] after the pointer is off both the
//! target and the card, on a key or an edit, or at once for another target.

use std::{ops::Range, rc::Rc};

use gpui::{
    Anchor as Corner, AnyElement, App, Bounds, Context, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, Point, SharedString, StatefulInteractiveElement as _, Styled as _,
    Task, Window, anchored, canvas, deferred, div, point, px,
};
use language::{BufferSnapshot, ToOffset as _, ToPoint as _};
use lattice_ui::components::{PopFrom, pop_in};

use super::{LatticeEditor, LatticeEditorEvent};
use crate::{
    geometry, gutter,
    hover::{HOVER_DELAY, HOVER_GRACE, HoverCard, HoverCardContext, HoverProvider, HoverTarget},
};

/// The gap between a card and the text it hovers over (the menus' 4px).
const CARD_GAP: Pixels = px(4.);
/// How far off its target the pointer may stray before the card counts it
/// as gone (the same tolerance on every side).
const TARGET_MARGIN: Pixels = px(4.);
/// The room a card leaves to the editor's edges (`createHoverCard`'s 16px).
const CARD_MARGIN: Pixels = px(16.);
/// How far inside the editor a card stays (`citationTooltipSpace`'s inset).
const CARD_INSET: Pixels = px(8.);
/// A card's width before it has been laid out: the cards' 360px.
const CARD_WIDTH: Pixels = px(360.);

/// A target in the buffer, anchored so it follows edits until it closes.
#[derive(Clone)]
pub(super) struct Anchored {
    id: &'static str,
    range: Range<language::Anchor>,
    /// A gutter mark's card: the mark's row, rather than a text range.
    gutter_row: Option<u32>,
    card: HoverCard,
}

impl Anchored {
    fn same_place(&self, other: &Anchored, text: &BufferSnapshot) -> bool {
        self.id == other.id
            && self.gutter_row == other.gutter_row
            && self.range.start.to_offset(text) == other.range.start.to_offset(text)
            && self.range.end.to_offset(text) == other.range.end.to_offset(text)
    }
}

pub(super) enum Hover {
    Idle,
    /// The pointer rests on a target; the card opens when the timer fires.
    Pending {
        target: Anchored,
        _timer: Task<()>,
    },
    Shown {
        target: Anchored,
        over_card: bool,
        /// The pointer left the target and the card; it closes when this fires.
        closing: Option<Task<()>>,
    },
}

impl LatticeEditor {
    pub fn add_hover_provider(&mut self, provider: Rc<dyn HoverProvider>) {
        self.hover_providers.push(provider);
    }

    /// The card shown, if any: its provider's id and its range now.
    pub fn shown_hover(&self, cx: &App) -> Option<(&'static str, Range<usize>)> {
        let Hover::Shown { target, .. } = &self.hover else {
            return None;
        };
        let text = self.buffer.read(cx).snapshot();
        Some((
            target.id,
            target.range.start.to_offset(&text)..target.range.end.to_offset(&text),
        ))
    }

    /// Close the card, and forget a target the pointer was resting on.
    pub fn dismiss_hover(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.hover, Hover::Idle) {
            self.hover = Hover::Idle;
            self.painted.borrow_mut().card = None;
            cx.notify();
        }
    }

    pub(crate) fn request_open_location(
        &mut self,
        path: String,
        line: u32,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_hover(cx);
        cx.emit(LatticeEditorEvent::OpenLocation { path, line });
    }

    /// Open the card for the text at `offset` at once, as a pointer resting
    /// there would after the delay: for scripted checks and keyboard use.
    pub fn hover_offset(&mut self, offset: usize, cx: &mut Context<Self>) -> bool {
        let text = self.buffer.read(cx).snapshot();
        match self.text_target(&text, offset, cx) {
            Some(target) => {
                self.hover = Hover::Shown {
                    target,
                    over_card: false,
                    closing: None,
                };
                cx.notify();
                true
            }
            None => false,
        }
    }

    fn text_target(&self, text: &BufferSnapshot, offset: usize, cx: &App) -> Option<Anchored> {
        self.hover_providers.iter().find_map(|provider| {
            let HoverTarget { range, id, card } = provider.target(text, offset, cx)?;
            Some(Anchored {
                id,
                range: text.anchor_before(range.start)..text.anchor_after(range.end),
                gutter_row: None,
                card,
            })
        })
    }

    /// What the pointer at `position` rests on: a gutter mark's line, or a
    /// provider's target under it.
    fn target_at(
        &self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Anchored> {
        let painted = self.painted.borrow().clone();
        let bounds = painted.bounds?;
        let text = self.buffer.read(cx).snapshot();
        // The line height is read only in frames that drew gutter marks.
        if let Some(line_height) = painted.line_height
            && let Some(target) =
                self.gutter_target(&painted.gutter, bounds, line_height, position, &text)
        {
            return Some(target);
        }
        let offset = geometry::offset_at(&self.editor, &text, position, window, cx)?;
        let target = self.text_target(&text, offset, cx)?;
        let range = target.range.start.to_offset(&text)..target.range.end.to_offset(&text);
        // `character_index_for_point` clamps a point past a line's end to
        // the end: the pointer must be over the target's own text.
        let rect =
            geometry::first_row_rect(&self.editor, &text, range.clone(), bounds, window, cx)?;
        let multi_row =
            text.offset_to_point(range.end).row != text.offset_to_point(range.start).row;
        (multi_row || geometry::near(rect, position, px(1.))).then_some(target)
    }

    /// The gutter mark whose line the pointer is beside, when it has a card.
    fn gutter_target(
        &self,
        painted: &[(&'static str, u32, Bounds<Pixels>)],
        bounds: Bounds<Pixels>,
        line_height: Pixels,
        position: Point<Pixels>,
        text: &BufferSnapshot,
    ) -> Option<Anchored> {
        painted.iter().find_map(|&(layer, row, mark_bounds)| {
            let row_top = mark_bounds.center().y - line_height / 2.;
            if !gutter::hover_bounds(bounds.left(), row_top, line_height).contains(&position) {
                return None;
            }
            let card = self.gutter.get(layer)?.iter().find_map(|anchored| {
                (anchored.anchor.to_point(text).row == row)
                    .then(|| anchored.mark.hover.clone())
                    .flatten()
            })?;
            let anchor = text.anchor_before(language::Point::new(row, 0));
            Some(Anchored {
                id: layer,
                range: anchor..anchor,
                gutter_row: Some(row),
                card,
            })
        })
    }

    /// The rectangle a target's card hangs from.
    fn target_rect(
        &self,
        target: &Anchored,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        let painted = self.painted.borrow().clone();
        let bounds = painted.bounds?;
        let text = self.buffer.read(cx).snapshot();
        if let Some(row) = target.gutter_row {
            let line_height = painted.line_height?;
            let frame_top = painted
                .gutter
                .iter()
                .find(|(layer, mark_row, _)| *layer == target.id && *mark_row == row)
                .map(|(_, _, mark)| mark.center().y - line_height / 2.)?;
            return Some(gutter::hover_bounds(bounds.left(), frame_top, line_height));
        }
        let range = target.range.start.to_offset(&text)..target.range.end.to_offset(&text);
        geometry::first_row_rect(&self.editor, &text, range, bounds, window, cx)
    }

    pub(super) fn pointer_moved(
        &mut self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A card the pointer is still on, or still near its target, stays.
        if let Hover::Shown {
            target,
            over_card,
            closing,
        } = &self.hover
        {
            let target = target.clone();
            let (on_card, closing_already) = (*over_card, closing.is_some());
            let near_target = self
                .target_rect(&target, window, cx)
                .is_some_and(|rect| geometry::near(rect, position, TARGET_MARGIN));
            if on_card || near_target {
                if let Hover::Shown { closing, .. } = &mut self.hover {
                    *closing = None;
                }
                return;
            }
            if !closing_already {
                self.schedule_close(cx);
            }
        }
        let candidate = if self.editor.read(cx).has_visible_completions_menu() {
            None
        } else {
            self.target_at(position, window, cx)
        };
        let text = self.buffer.read(cx).snapshot();
        match (&self.hover, candidate) {
            (Hover::Shown { target, .. }, Some(candidate))
                if target.same_place(&candidate, &text) => {}
            (Hover::Pending { target, .. }, Some(candidate))
                if target.same_place(&candidate, &text) => {}
            (Hover::Shown { .. }, None) => {}
            // Another target (the pointer left the shown one, or moved on
            // from the one it was resting on): its card comes after the delay,
            // and a card shown for the last one goes now.
            (_, Some(candidate)) => {
                if matches!(self.hover, Hover::Shown { .. }) {
                    self.painted.borrow_mut().card = None;
                    cx.notify();
                }
                let timer = cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(HOVER_DELAY).await;
                    this.update(cx, |this, cx| this.open_pending(cx)).ok();
                });
                self.hover = Hover::Pending {
                    target: candidate,
                    _timer: timer,
                };
            }
            (Hover::Pending { .. }, None) => self.hover = Hover::Idle,
            (Hover::Idle, None) => {}
        }
    }

    fn open_pending(&mut self, cx: &mut Context<Self>) {
        if let Hover::Pending { target, .. } = &self.hover {
            if self.editor.read(cx).has_visible_completions_menu() {
                self.hover = Hover::Idle;
                return;
            }
            self.hover = Hover::Shown {
                target: target.clone(),
                over_card: false,
                closing: None,
            };
            cx.notify();
        }
    }

    fn schedule_close(&mut self, cx: &mut Context<Self>) {
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(HOVER_GRACE).await;
            this.update(cx, |this, cx| {
                if let Hover::Shown {
                    over_card: false,
                    closing: Some(_),
                    ..
                } = &this.hover
                {
                    this.dismiss_hover(cx);
                }
            })
            .ok();
        });
        if let Hover::Shown { closing, .. } = &mut self.hover {
            *closing = Some(task);
        }
    }

    fn card_hovered(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if let Hover::Shown {
            over_card, closing, ..
        } = &mut self.hover
        {
            *over_card = hovered;
            if hovered {
                *closing = None;
            } else {
                self.schedule_close(cx);
            }
        }
    }

    pub(super) fn pointer_left(&mut self, cx: &mut Context<Self>) {
        match &self.hover {
            Hover::Pending { .. } => self.hover = Hover::Idle,
            Hover::Shown {
                over_card: false,
                closing: None,
                ..
            } => self.schedule_close(cx),
            _ => {}
        }
    }

    pub(super) fn render_card(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let Hover::Shown { target, .. } = &self.hover else {
            return None;
        };
        if self.editor.read(cx).has_visible_completions_menu() {
            return None;
        }
        let target = target.clone();
        let rect = self.target_rect(&target, window, cx)?;
        let bounds = self.painted.borrow().bounds?;
        // A target scrolled out of the editor takes its card with it.
        if rect.bottom() < bounds.top() || rect.top() > bounds.bottom() {
            return None;
        }
        let context = HoverCardContext {
            editor: cx.weak_entity(),
            max_width: (bounds.size.width - CARD_MARGIN).max(px(160.)),
            text: self.buffer.read(cx).snapshot(),
        };
        // The card stays inside the editor, as the Tauri app's tooltip space
        // keeps it: shifted left from its target when it would cross the
        // editor's right edge. Its width is last frame's; a card's first
        // frame is the transparent start of its entrance.
        let width = self
            .painted
            .borrow()
            .card
            .map_or(CARD_WIDTH, |card| card.size.width)
            .min(context.max_width);
        let left = rect
            .left()
            .min(bounds.right() - CARD_INSET - width)
            .max(bounds.left() + CARD_INSET);
        let rect = Bounds {
            origin: point(left, rect.top()),
            size: rect.size,
        };
        let card = (target.card)(&context, window, cx);
        let id = SharedString::from(format!("lattice-hover-{}", target.id));
        let hovered = cx.listener(|this, hovered: &bool, _, cx| this.card_hovered(*hovered, cx));
        let painted = self.painted.clone();
        let record = canvas(
            move |bounds, _, _| painted.borrow_mut().card = Some(bounds),
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        Some(
            deferred(
                anchored()
                    .attach(rect, Corner::TopLeft)
                    .anchor(Corner::BottomLeft)
                    .offset(point(px(0.), -CARD_GAP))
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        div()
                            .id(id.clone())
                            .occlude()
                            .on_hover(hovered)
                            .child(pop_in(id, PopFrom::Below, card))
                            .child(record),
                    ),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}
