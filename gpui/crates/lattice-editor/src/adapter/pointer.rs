//! Hover cards: the pointer over the editor, the targets it rests on, and
//! the stack of cards that opens for them (`hover.rs` has the providers'
//! side).
//!
//! The overlay's mouse listener (`overlay.rs`) reports every move over the
//! editor here. Targets the pointer rests on for [`HOVER_DELAY`] open their
//! cards, one under another; the stack closes [`HOVER_GRACE`] after the
//! pointer is off both the targets and the stack, on a key or an edit, or at
//! once for other targets.

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
/// A stack's width before it has been laid out: the cards' 360px.
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

    fn offsets(&self, text: &BufferSnapshot) -> Range<usize> {
        self.range.start.to_offset(text)..self.range.end.to_offset(text)
    }
}

fn same_places(targets: &[Anchored], others: &[Anchored], text: &BufferSnapshot) -> bool {
    targets.len() == others.len()
        && targets
            .iter()
            .zip(others)
            .all(|(target, other)| target.same_place(other, text))
}

pub(super) enum Hover {
    Idle,
    /// The pointer rests on targets (never none); their cards open when the
    /// timer fires.
    Pending {
        targets: Vec<Anchored>,
        _timer: Task<()>,
    },
    Shown {
        targets: Vec<Anchored>,
        over_card: bool,
        /// The pointer left the targets and the cards; they close when this
        /// fires.
        closing: Option<Task<()>>,
        /// The pointer, still by the shown targets, rests on another set of
        /// them: the stack becomes that set when this fires.
        next: Option<(Vec<Anchored>, Task<()>)>,
    },
}

impl LatticeEditor {
    pub fn add_hover_provider(&mut self, provider: Rc<dyn HoverProvider>) {
        self.hover_providers.push(provider);
    }

    /// The cards shown, top to bottom: each one's provider id and its
    /// range now. Empty when none is.
    pub fn shown_hover(&self, cx: &App) -> Vec<(&'static str, Range<usize>)> {
        let Hover::Shown { targets, .. } = &self.hover else {
            return Vec::new();
        };
        let text = self.buffer.read(cx).snapshot();
        targets
            .iter()
            .map(|target| (target.id, target.offsets(&text)))
            .collect()
    }

    /// Close the cards, and forget targets the pointer was resting on.
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

    /// Every provider's target at `offset`, in the order they were added.
    fn text_targets(&self, text: &BufferSnapshot, offset: usize, cx: &App) -> Vec<Anchored> {
        self.hover_providers
            .iter()
            .filter_map(|provider| {
                let HoverTarget { range, id, card } = provider.target(text, offset, cx)?;
                Some(Anchored {
                    id,
                    range: text.anchor_before(range.start)..text.anchor_after(range.end),
                    gutter_row: None,
                    card,
                })
            })
            .collect()
    }

    /// What the pointer at `position` rests on: a gutter mark's line, or the
    /// providers' targets under it.
    fn targets_at(
        &self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Vec<Anchored> {
        let painted = self.painted.borrow().clone();
        let Some(bounds) = painted.bounds else {
            return Vec::new();
        };
        let text = self.buffer.read(cx).snapshot();
        // The line height is read only in frames that drew gutter marks.
        if let Some(line_height) = painted.line_height
            && let Some(target) = self.gutter_target(&painted.gutter, line_height, position, &text)
        {
            return vec![target];
        }
        let Some(offset) = geometry::offset_at(&self.editor, &text, position, window, cx) else {
            return Vec::new();
        };
        // `character_index_for_point` clamps a point past a line's end to
        // the end: the pointer must be over the character it names.
        let over_text = geometry::character_rect(&self.editor, &text, offset, bounds, window, cx)
            .is_some_and(|rect| geometry::near(rect, position, px(1.)));
        if !over_text {
            return Vec::new();
        }
        self.text_targets(&text, offset, cx)
    }

    /// The gutter mark whose line the pointer is beside, when it has a card.
    fn gutter_target(
        &self,
        painted: &[(&'static str, u32, Bounds<Pixels>)],
        line_height: Pixels,
        position: Point<Pixels>,
        text: &BufferSnapshot,
    ) -> Option<Anchored> {
        painted.iter().find_map(|&(layer, row, mark_bounds)| {
            let row_top = mark_bounds.center().y - line_height / 2.;
            // The mark stands at the view's left edge, in the gutter.
            let left = mark_bounds.center().x - gutter::DOT_INSET;
            if !gutter::hover_bounds(left, row_top, line_height).contains(&position) {
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

    /// The rectangle the targets' cards hang from: a gutter mark's line, or
    /// the first row of the text from the earliest target's start to the
    /// latest one's end (CodeMirror's hover host spans its tooltips' ranges).
    fn targets_rect(
        &self,
        targets: &[Anchored],
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        let painted = self.painted.borrow().clone();
        let bounds = painted.bounds?;
        let text = self.buffer.read(cx).snapshot();
        let target = targets.first()?;
        if let Some(row) = target.gutter_row {
            let line_height = painted.line_height?;
            let mark = painted
                .gutter
                .iter()
                .find(|(layer, mark_row, _)| *layer == target.id && *mark_row == row)
                .map(|(_, _, mark)| *mark)?;
            let frame_top = mark.center().y - line_height / 2.;
            let left = mark.center().x - gutter::DOT_INSET;
            return Some(gutter::hover_bounds(left, frame_top, line_height));
        }
        let start = targets
            .iter()
            .map(|target| target.offsets(&text).start)
            .min()?;
        let end = targets
            .iter()
            .map(|target| target.offsets(&text).end)
            .max()?;
        geometry::first_row_rect(&self.editor, &text, start..end, bounds, window, cx)
    }

    pub(super) fn pointer_moved(
        &mut self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let candidates = if self.editor.read(cx).has_visible_completions_menu() {
            Vec::new()
        } else {
            self.targets_at(position, window, cx)
        };
        let text = self.buffer.read(cx).snapshot();
        // Cards the pointer is still on, or still near their targets, stay.
        // Near them, the stack follows the targets under the pointer, as
        // each of CodeMirror's hover sources follows its own range: a card
        // whose target the pointer came onto joins after the hover delay,
        // and one whose target it left goes after the grace. Targets none
        // of which is shown are other targets, as off the stack.
        if let Hover::Shown {
            targets,
            over_card,
            closing,
            ..
        } = &self.hover
        {
            let targets = targets.clone();
            let (on_card, closing_already) = (*over_card, closing.is_some());
            let near_target = self
                .targets_rect(&targets, window, cx)
                .is_some_and(|rect| geometry::near(rect, position, TARGET_MARGIN));
            let kept: Vec<_> = candidates
                .iter()
                .filter(|candidate| {
                    targets
                        .iter()
                        .any(|target| target.same_place(candidate, &text))
                })
                .cloned()
                .collect();
            let moved_on = !candidates.is_empty() && kept.is_empty();
            if on_card || !kept.is_empty() || (near_target && !moved_on) {
                let follow = !on_card
                    && !candidates.is_empty()
                    && !same_places(&targets, &candidates, &text);
                if let Hover::Shown { closing, next, .. } = &mut self.hover {
                    *closing = None;
                    if !follow {
                        *next = None;
                    }
                }
                if follow {
                    self.schedule_next(&targets, kept, candidates, &text, cx);
                }
                return;
            }
            if !closing_already {
                self.schedule_close(cx);
            }
        }
        match &self.hover {
            Hover::Shown { targets, .. } | Hover::Pending { targets, .. }
                if same_places(targets, &candidates, &text) => {}
            Hover::Shown { .. } | Hover::Idle if candidates.is_empty() => {}
            Hover::Pending { .. } if candidates.is_empty() => self.hover = Hover::Idle,
            // Other targets (the pointer left the shown ones, or moved on
            // from the ones it was resting on): their cards come after the
            // delay, and cards shown for the last ones go now.
            _ => {
                if matches!(self.hover, Hover::Shown { .. }) {
                    self.painted.borrow_mut().card = None;
                    cx.notify();
                }
                let timer = cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(HOVER_DELAY).await;
                    this.update(cx, |this, cx| this.open_pending(cx)).ok();
                });
                self.hover = Hover::Pending {
                    targets: candidates,
                    _timer: timer,
                };
            }
        }
    }

    fn open_pending(&mut self, cx: &mut Context<Self>) {
        if let Hover::Pending { targets, .. } = &self.hover {
            if self.editor.read(cx).has_visible_completions_menu() {
                self.hover = Hover::Idle;
                return;
            }
            self.hover = Hover::Shown {
                targets: targets.clone(),
                over_card: false,
                closing: None,
                next: None,
            };
            cx.notify();
        }
    }

    /// Make `candidates` the shown stack, unless a timer for the same set
    /// runs already: the cards whose targets are not among them go after the
    /// grace, leaving those `kept`, and the new ones join after the hover
    /// delay.
    fn schedule_next(
        &mut self,
        shown: &[Anchored],
        kept: Vec<Anchored>,
        candidates: Vec<Anchored>,
        text: &BufferSnapshot,
        cx: &mut Context<Self>,
    ) {
        let Hover::Shown { next, .. } = &mut self.hover else {
            return;
        };
        if next
            .as_ref()
            .is_some_and(|(pending, _)| same_places(pending, &candidates, text))
        {
            return;
        }
        let drops = kept.len() < shown.len();
        let joins = kept.len() < candidates.len();
        let timer = cx.spawn(async move |this, cx| {
            if drops {
                cx.background_executor().timer(HOVER_GRACE).await;
                this.update(cx, |this, cx| {
                    if let Hover::Shown { targets, .. } = &mut this.hover {
                        *targets = kept;
                        cx.notify();
                    }
                })
                .ok();
            }
            if joins {
                let rest = if drops {
                    HOVER_DELAY.saturating_sub(HOVER_GRACE)
                } else {
                    HOVER_DELAY
                };
                cx.background_executor().timer(rest).await;
            }
            this.update(cx, |this, cx| {
                if let Hover::Shown { targets, next, .. } = &mut this.hover
                    && let Some((pending, _)) = next.take()
                {
                    *targets = pending;
                    cx.notify();
                }
            })
            .ok();
        });
        *next = Some((candidates, timer));
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
        if let Hover::Shown { closing, next, .. } = &mut self.hover {
            *closing = Some(task);
            *next = None;
        }
    }

    fn card_hovered(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if let Hover::Shown {
            over_card,
            closing,
            next,
            ..
        } = &mut self.hover
        {
            *over_card = hovered;
            if hovered {
                *closing = None;
                *next = None;
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
        let Hover::Shown { targets, .. } = &self.hover else {
            return None;
        };
        if self.editor.read(cx).has_visible_completions_menu() {
            return None;
        }
        let targets = targets.clone();
        let rect = self.targets_rect(&targets, window, cx)?;
        let bounds = self.painted.borrow().bounds?;
        // Targets scrolled out of the editor take their cards with them.
        if rect.bottom() < bounds.top() || rect.top() > bounds.bottom() {
            return None;
        }
        let context = HoverCardContext {
            editor: cx.weak_entity(),
            max_width: (bounds.size.width - CARD_MARGIN).max(px(160.)),
            text: self.buffer.read(cx).snapshot(),
        };
        // The stack stays inside the editor, as the Tauri app's tooltip space
        // keeps it: shifted left from its targets when it would cross the
        // editor's right edge, and hung below them when it would cross the
        // editor's top. Its size is last frame's; a stack's first frame is
        // the transparent start of its entrance.
        let last = self.painted.borrow().card.map(|card| card.size);
        let width = last
            .map_or(CARD_WIDTH, |size| size.width)
            .min(context.max_width);
        let height = last.map_or(px(0.), |size| size.height);
        let above = rect.top() - CARD_GAP - height >= bounds.top() + CARD_INSET;
        let (attach, anchor, offset, from) = if above {
            (
                Corner::TopLeft,
                Corner::BottomLeft,
                -CARD_GAP,
                PopFrom::Below,
            )
        } else {
            (
                Corner::BottomLeft,
                Corner::TopLeft,
                CARD_GAP,
                PopFrom::Above,
            )
        };
        let left = rect
            .left()
            .min(bounds.right() - CARD_INSET - width)
            .max(bounds.left() + CARD_INSET);
        let rect = Bounds {
            origin: point(left, rect.top()),
            size: rect.size,
        };
        // Each card stands on its own surface, apart by the gap the Tauri
        // app leaves between hover cards that share a popover; the gap is
        // inside the stack, so the pointer crossing it is still over it.
        // A card joining the stack enters on its own, keyed by its target
        // so a new target of the same provider enters too; those shown stay
        // put.
        let cards = div()
            .flex()
            .flex_col()
            .items_start()
            .gap(CARD_GAP)
            .children(
                targets
                    .iter()
                    .map(|target| {
                        let card = (target.card)(&context, window, cx);
                        let start = target.offsets(&context.text).start;
                        pop_in(
                            SharedString::from(format!("lattice-hover-{}-{start}", target.id)),
                            from,
                            card,
                        )
                    })
                    .collect::<Vec<_>>(),
            );
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
                    .attach(rect, attach)
                    .anchor(anchor)
                    .offset(point(px(0.), offset))
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        div()
                            .id("lattice-hover")
                            .occlude()
                            .on_hover(hovered)
                            .child(cards)
                            .child(record),
                    ),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}
