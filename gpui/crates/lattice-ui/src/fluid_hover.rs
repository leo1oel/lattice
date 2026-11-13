//! Fluid hover: one highlight per list, gliding to the row under the pointer.
//!
//! The Tauri app's lists, menus and the Project tree light their rows the way
//! Fluid Functionalism does (`src/components/ui/fluid-hover-surface.tsx`,
//! `use-fluid-hover.ts`, `fluid-hover-highlight.tsx`, adapted from
//! <https://www.fluidfunctionalism.com/docs/fluid-hover>): not a fill per row
//! that blinks off and on between rows, but one fill that travels. This is
//! that surface, behaviour for behaviour:
//!
//! - The pointer lights the row it is over, or a row whose edge is within
//!   3px ([`GAP_TOLERANCE`]), so the hairline between two rows is no dead
//!   zone while a separator's margin or a section label still is.
//! - Within a section the fill travels to the next row on the fast tier
//!   (80 ms, `spring.fast`), position and size together. Coming onto the list,
//!   or crossing a separator or label into another section, starts a new
//!   session instead: the fill fades in on the row on the fast tier, and the
//!   one it leaves fades out where it was on the fast exit (60 ms), never
//!   sliding through the label.
//! - A row that may not be lit (disabled, destructive, or the selected row of
//!   a list that keeps its own selection fill) clears the fill under the
//!   pointer: the highlight is a promise about the click.
//! - Leaving the list, pressing a button, and scrolling under a resting
//!   pointer clear it; only a pointer that really moves lights a row again.
//!   A list can also stay dark for a moment after its last scroll
//!   ([`FluidHover::quiet_after_scroll`]), as the Project tree does for
//!   recycled rows.
//! - The keyboard moves the same fill: a list that has a current row (a
//!   menu's arrow keys, a picker's selection) passes it to
//!   [`FluidHover::follow`], and whichever hand moved last owns the fill. A
//!   list whose keyboard answer is a focus ring (a tree) does not follow.
//! - Under reduced motion the travel lands at once and the fades stay
//!   ("fewer and gentler, not none").
//!
//! Using it, from a view's render:
//!
//! ```ignore
//! let hover = FluidHover::new("outline", window, cx)
//!     .fill(palette.accent_soft)
//!     .radius(shape::MENU.inner())
//!     .follow(self.highlighted, cx);
//! div()
//!     .relative()                 // the highlight is laid over the list
//!     .child(hover.highlight())   // first, so it paints behind the rows
//!     .children(rows.map(|(ix, row)| hover.item(ix, row)))
//! ```
//!
//! [`FluidHover::item`] wraps a row so its bounds are recorded as it is laid
//! out, without changing its layout; [`FluidHover::probe`] is the same for a
//! row built elsewhere (GPUI Kit's tree items), as an absolutely positioned
//! child of a positioned row. Rows paint no hover fill of their own; one that
//! changes its ink under the pointer asks [`FluidHover::is_lit`].
//!
//! The rows have to be built in the same view as the highlight: the
//! highlight reads the bounds they recorded in the same frame, after
//! prepaint, so it never trails the layout by a frame.

use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Bounds, Corners, DispatchPhase, ElementId, Entity, Hitbox, HitboxBehavior,
    Hsla, IntoElement, MouseDownEvent, MouseExitEvent, MouseMoveEvent, ParentElement as _, Pixels,
    Point, ScrollEvent, Styled as _, Window, canvas, div, fill, px,
};

use crate::motion::{Motion, Tween};

/// How far past a row's edge the pointer still lights it
/// (`fluid-hover-surface.tsx`, `gapTolerance`).
pub const GAP_TOLERANCE: Pixels = px(3.);

/// Which way a list runs: the side its gap tolerance and nearest row are
/// measured along.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Axis {
    #[default]
    Vertical,
    Horizontal,
}

/// What a registered row is to the highlight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Role {
    /// A row the fill lands on.
    #[default]
    Target,
    /// A row the pointer can be over that the fill must not promise: a
    /// disabled or destructive row (it keeps its own state), or the selected
    /// row of a list that keeps its selection fill (`preserveSelection`).
    /// Under the pointer it clears the fill.
    Skip,
}

/// A row's place in its list.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ItemKind {
    pub role: Role,
    /// The section the row belongs to: moving between sections starts a new
    /// session (a fade) instead of a glide. Rows after a menu's separator or
    /// label take the next number.
    pub section: usize,
}

impl ItemKind {
    pub fn target() -> Self {
        Self::default()
    }

    pub fn skip() -> Self {
        Self {
            role: Role::Skip,
            ..Self::default()
        }
    }

    pub fn section(mut self, section: usize) -> Self {
        self.section = section;
        self
    }
}

/// Who moved the fill last.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Hand {
    #[default]
    Pointer,
    Keyboard,
}

#[derive(Clone, Copy, Debug)]
struct Slot {
    bounds: Bounds<Pixels>,
    kind: ItemKind,
    /// The frame the bounds were recorded in.
    frame: u64,
}

/// The fill on screen.
#[derive(Clone, Copy, Debug)]
struct Lit {
    index: usize,
    section: usize,
    rect: Tween<Bounds<Pixels>>,
    opacity: Tween<f32>,
}

/// A fill on its way out, fading where it was.
#[derive(Clone, Copy, Debug)]
struct Leaving {
    rect: Bounds<Pixels>,
    opacity: Tween<f32>,
}

/// One list's highlight: the rows it knows, which one it wants lit, and the
/// fills it is drawing.
#[derive(Debug, Default)]
pub struct FluidHoverState {
    slots: Vec<Option<Slot>>,
    /// The row the hands asked for; the paint reconciles the fills with it.
    wanted: Option<usize>,
    hand: Hand,
    lit: Option<Lit>,
    leaving: Vec<Leaving>,
    frame: u64,
    last_pointer: Option<Point<Pixels>>,
    /// The keyboard's current row as last seen, so only a change moves the
    /// fill.
    followed: Option<Option<usize>>,
    quiet_after_scroll: Option<Duration>,
    quiet_until: Option<Instant>,
    /// How many fills have faded in: a glide adds none.
    sessions: u64,
}

impl FluidHoverState {
    fn record(&mut self, index: usize, bounds: Bounds<Pixels>, kind: ItemKind) {
        if self.slots.len() <= index {
            self.slots.resize(index + 1, None);
        }
        self.slots[index] = Some(Slot {
            bounds,
            kind,
            frame: self.frame,
        });
    }

    /// The rows laid out in the last frame drawn.
    fn live(&self) -> impl Iterator<Item = (usize, &Slot)> {
        let frame = self.frame;
        self.slots.iter().enumerate().filter_map(move |(ix, slot)| {
            slot.as_ref()
                .filter(|slot| slot.frame == frame)
                .map(|s| (ix, s))
        })
    }

    /// The row a pointer at `position` lights.
    fn pick(&self, position: Point<Pixels>, axis: Axis) -> Option<usize> {
        pick(
            self.live().map(|(ix, slot)| (ix, slot.bounds)),
            position,
            axis,
        )
    }

    /// The pointer moved to `position`: whether what is wanted changed.
    fn pointer_moved(
        &mut self,
        position: Point<Pixels>,
        over_list: bool,
        button_held: bool,
        axis: Axis,
        now: Instant,
    ) -> bool {
        let before = self.wanted;
        if !over_list {
            self.last_pointer = None;
            if self.hand == Hand::Pointer {
                self.wanted = None;
            }
            return self.wanted != before;
        }
        // A list that scrolls under a resting pointer sees the same
        // position again; only a pointer that really moved takes the fill
        // back from the keyboard.
        if self.last_pointer == Some(position) {
            return false;
        }
        self.last_pointer = Some(position);
        self.hand = Hand::Pointer;
        if button_held || self.quiet_until.is_some_and(|until| now < until) {
            self.wanted = None;
        } else {
            self.wanted = self.pick(position, axis);
        }
        self.wanted != before
    }

    fn pressed(&mut self) -> bool {
        let before = self.wanted;
        self.wanted = None;
        before.is_some()
    }

    fn scrolled(&mut self, now: Instant) -> bool {
        if let Some(quiet) = self.quiet_after_scroll {
            self.quiet_until = Some(now + quiet);
        }
        if self.hand == Hand::Keyboard {
            return false;
        }
        self.pressed()
    }

    fn follow(&mut self, current: Option<usize>) {
        if self.followed == Some(current) {
            return;
        }
        self.followed = Some(current);
        // The pointer already lit this row and the list adopted it as its
        // current one: the pointer keeps the fill.
        if current.is_some() && current == self.wanted {
            return;
        }
        self.key_to(current);
    }

    fn key_to(&mut self, current: Option<usize>) {
        self.followed = Some(current);
        self.hand = Hand::Keyboard;
        self.wanted = current;
    }

    /// Bring the fills in line with what is wanted, at `now`. Returns whether
    /// anything still moves.
    fn reconcile(&mut self, now: Instant, reduce_motion: bool) -> bool {
        let target = self.wanted.and_then(|ix| {
            let slot = self.slots.get(ix).copied().flatten()?;
            (slot.frame == self.frame && slot.kind.role == Role::Target).then_some((ix, slot))
        });
        match (target, self.lit.as_mut()) {
            (Some((ix, slot)), Some(lit)) if lit.index == ix => {
                // The same row moved (a scroll, a reflow): the fill moves
                // with it rather than gliding after it.
                if lit.rect.target() != slot.bounds {
                    if lit.rect.is_running(now) && !reduce_motion {
                        lit.rect.retarget(slot.bounds, Motion::Fast, now);
                    } else {
                        lit.rect.jump(slot.bounds, now);
                    }
                }
            }
            (Some((ix, slot)), Some(lit)) if lit.section == slot.kind.section => {
                lit.index = ix;
                if reduce_motion {
                    lit.rect.jump(slot.bounds, now);
                } else {
                    lit.rect.retarget(slot.bounds, Motion::Fast, now);
                }
                lit.opacity.retarget(1., Motion::Fast, now);
            }
            (Some((ix, slot)), _) => {
                self.retire(now);
                self.sessions += 1;
                let mut opacity = Tween::settled(0., now);
                opacity.retarget(1., Motion::Fast, now);
                self.lit = Some(Lit {
                    index: ix,
                    section: slot.kind.section,
                    rect: Tween::settled(slot.bounds, now),
                    opacity,
                });
            }
            (None, _) => self.retire(now),
        }
        self.leaving
            .retain(|leaving| leaving.opacity.is_running(now));
        self.lit
            .as_ref()
            .is_some_and(|lit| lit.rect.is_running(now) || lit.opacity.is_running(now))
            || !self.leaving.is_empty()
    }

    fn retire(&mut self, now: Instant) {
        if let Some(lit) = self.lit.take() {
            let mut opacity = Tween::settled(lit.opacity.value(now), now);
            opacity.retarget(0., Motion::FastExit, now);
            self.leaving.push(Leaving {
                rect: lit.rect.value(now),
                opacity,
            });
        }
    }

    /// The fills to draw at `now`: rect and opacity.
    fn fills(&self, now: Instant) -> impl Iterator<Item = (Bounds<Pixels>, f32)> + '_ {
        self.leaving
            .iter()
            .map(move |leaving| (leaving.rect, leaving.opacity.value(now)))
            .chain(
                self.lit
                    .iter()
                    .map(move |lit| (lit.rect.value(now), lit.opacity.value(now))),
            )
            .filter(|(_, opacity)| *opacity > 0.)
    }
}

/// The row a pointer at `position` lights among `rows` (index and bounds, in
/// window coordinates): the last row it is inside, else the nearest whose
/// edge is within [`GAP_TOLERANCE`] along `axis`, the later of two equally
/// near (`fluid-hover-surface.tsx`'s `nearestRow`).
pub fn pick(
    rows: impl IntoIterator<Item = (usize, Bounds<Pixels>)>,
    position: Point<Pixels>,
    axis: Axis,
) -> Option<usize> {
    let mut inside = None;
    let mut nearest = None;
    let mut distance = GAP_TOLERANCE;
    for (ix, bounds) in rows {
        if bounds.contains(&position) {
            inside = Some(ix);
            continue;
        }
        // Across the list the pointer must be within the row's span; along
        // it, within the tolerance of an edge.
        let (along, start, end, across, across_start, across_end) = match axis {
            Axis::Vertical => (
                position.y,
                bounds.top(),
                bounds.bottom(),
                position.x,
                bounds.left(),
                bounds.right(),
            ),
            Axis::Horizontal => (
                position.x,
                bounds.left(),
                bounds.right(),
                position.y,
                bounds.top(),
                bounds.bottom(),
            ),
        };
        if across < across_start || across > across_end {
            continue;
        }
        let away = if along < start {
            start - along
        } else if along > end {
            along - end
        } else {
            px(0.)
        };
        if away <= distance {
            nearest = Some(ix);
            distance = away;
        }
    }
    inside.or(nearest)
}

/// What a list's highlight shows, for a scripted check.
#[derive(Clone, Debug, Default)]
pub struct FluidHoverSnapshot {
    /// The row the fill is on (or travelling to).
    pub lit: Option<usize>,
    /// Where the fill is drawn now.
    pub fill: Option<Bounds<Pixels>>,
    /// Fills fading out.
    pub leaving: usize,
    /// How many fills have faded in since the list was first drawn: a glide
    /// to another row adds none.
    pub sessions: u64,
    /// The rows laid out in the last frame: index, bounds, and whether the
    /// fill may land there.
    pub rows: Vec<(usize, Bounds<Pixels>, bool)>,
}

/// A list's fluid hover, for one frame: built in the view's render.
#[derive(Clone)]
pub struct FluidHover {
    state: Entity<FluidHoverState>,
    fill: Hsla,
    radius: Pixels,
    axis: Axis,
}

impl FluidHover {
    /// The highlight keyed by `id`, kept while the list is drawn in
    /// consecutive frames.
    pub fn new(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> Self {
        let state = window.use_keyed_state(id, cx, |_, _| FluidHoverState::default());
        state.update(cx, |state, _| state.frame = state.frame.wrapping_add(1));
        Self {
            state,
            fill: gpui::transparent_black(),
            radius: crate::shape::RADIUS_TARGET,
            axis: Axis::Vertical,
        }
    }

    /// The fill's colour: the list's own current-row wash
    /// (`--fluid-hover-fill`), so a row lit by the pointer and one lit by
    /// the keys look the same.
    pub fn fill(mut self, fill: Hsla) -> Self {
        self.fill = fill;
        self
    }

    /// The fill's corner: the rows' own, usually a [`crate::shape::Nest`]'s
    /// inner radius.
    pub fn radius(mut self, radius: Pixels) -> Self {
        self.radius = radius;
        self
    }

    pub fn axis(mut self, axis: Axis) -> Self {
        self.axis = axis;
        self
    }

    /// The list's current row as the keys left it; a change moves the fill
    /// there, until the pointer moves again.
    pub fn follow(self, current: Option<usize>, cx: &mut App) -> Self {
        self.state.update(cx, |state, _| state.follow(current));
        self
    }

    /// A key moved the list's current row to `current`: the fill goes
    /// there even when the keys chose that row before.
    pub fn key_to(&self, current: Option<usize>, cx: &mut App) {
        self.state.update(cx, |state, cx| {
            state.key_to(current);
            cx.notify();
        });
    }

    /// Keep the list dark for `quiet` after each scroll, so rows recycled
    /// under a resting pointer do not light (the Project tree's 150 ms).
    pub fn quiet_after_scroll(self, quiet: Duration, cx: &mut App) -> Self {
        self.state
            .update(cx, |state, _| state.quiet_after_scroll = Some(quiet));
        self
    }

    /// Whether the fill is on row `index` (or on its way there).
    pub fn is_lit(&self, index: usize, cx: &App) -> bool {
        let state = self.state.read(cx);
        state.wanted == Some(index)
            && state
                .slots
                .get(index)
                .copied()
                .flatten()
                .is_some_and(|slot| slot.kind.role == Role::Target)
    }

    /// What the highlight shows now, for a scripted check.
    pub fn snapshot(&self, cx: &App) -> FluidHoverSnapshot {
        let state = self.state.read(cx);
        let now = Instant::now();
        FluidHoverSnapshot {
            lit: state.lit.map(|lit| lit.index),
            fill: state.lit.map(|lit| lit.rect.value(now)),
            leaving: state.leaving.len(),
            sessions: state.sessions,
            rows: state
                .live()
                .map(|(ix, slot)| (ix, slot.bounds, slot.kind.role == Role::Target))
                .collect(),
        }
    }

    /// The row the pointer or keys lit, for a list that runs it on Enter.
    pub fn lit(&self, cx: &App) -> Option<usize> {
        self.state.read(cx).wanted
    }

    /// Wrap `row` so its bounds are recorded as row `index` of this list.
    pub fn item(&self, index: usize, row: impl IntoElement) -> AnyElement {
        self.item_as(index, ItemKind::target(), row)
    }

    /// [`FluidHover::item`] for a row of `kind`.
    pub fn item_as(&self, index: usize, kind: ItemKind, row: impl IntoElement) -> AnyElement {
        let state = self.state.clone();
        crate::measure::measured(row, move |bounds, cx| {
            state.update(cx, |state, _| state.record(index, bounds, kind));
        })
    }

    /// An absolutely positioned child that records its positioned parent's
    /// bounds as row `index`: for a row built elsewhere that takes children.
    pub fn probe(&self, index: usize, kind: ItemKind) -> AnyElement {
        let state = self.state.clone();
        canvas(
            move |bounds, _, cx| {
                state.update(cx, |state, _| state.record(index, bounds, kind));
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0()
        .into_any_element()
    }

    /// The fill, laid over the list it lights: put it in the positioned list
    /// before the rows, so it paints behind them. It listens for the pointer
    /// over the list's bounds and draws only inside them.
    pub fn highlight(&self) -> AnyElement {
        let state = self.state.clone();
        let (fill_colour, radius, axis) = (self.fill, self.radius, self.axis);
        div()
            .absolute()
            .inset_0()
            .child(
                canvas(
                    |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                    move |bounds, hitbox: Hitbox, window, cx| {
                        listen(&state, hitbox, axis, window);
                        let now = Instant::now();
                        let reduce = cx.reduce_motion();
                        let running = state.update(cx, |state, _| state.reconcile(now, reduce));
                        let fills: Vec<_> = state.read(cx).fills(now).collect();
                        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
                            for (rect, opacity) in fills {
                                let mut colour = fill_colour;
                                colour.a *= opacity.clamp(0., 1.);
                                window.paint_quad(
                                    fill(rect, colour).corner_radii(Corners::all(radius)),
                                );
                            }
                        });
                        if running {
                            window.request_animation_frame();
                        }
                    },
                )
                .size_full(),
            )
            .into_any_element()
    }
}

/// The pointer's listeners, registered while the highlight paints.
fn listen(state: &Entity<FluidHoverState>, hitbox: Hitbox, axis: Axis, window: &mut Window) {
    let view = window.current_view();
    let moved = state.clone();
    let over = hitbox.clone();
    window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        let over_list = over.is_hovered(window);
        let changed = moved.update(cx, |state, _| {
            state.pointer_moved(
                event.position,
                over_list,
                event.pressed_button.is_some(),
                axis,
                Instant::now(),
            )
        });
        if changed {
            cx.notify(view);
        }
    });
    let left = state.clone();
    window.on_mouse_event(move |_: &MouseExitEvent, phase, _, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        let changed = left.update(cx, |state, _| {
            state.last_pointer = None;
            state.hand == Hand::Pointer && state.pressed()
        });
        if changed {
            cx.notify(view);
        }
    });
    let pressed = state.clone();
    let down = hitbox.clone();
    window.on_mouse_event(move |_: &MouseDownEvent, phase, window, cx| {
        if phase == DispatchPhase::Bubble
            && down.is_hovered(window)
            && pressed.update(cx, |state, _| state.pressed())
        {
            cx.notify(view);
        }
    });
    let scrolled = state.clone();
    window.on_mouse_event(move |_: &ScrollEvent, phase, window, cx| {
        if phase == DispatchPhase::Bubble
            && hitbox.is_hovered(window)
            && scrolled.update(cx, |state, _| state.scrolled(Instant::now()))
        {
            cx.notify(view);
        }
    });
}

mod kit_menu;
#[cfg(test)]
mod tests;

pub use kit_menu::KitMenuGlide;
