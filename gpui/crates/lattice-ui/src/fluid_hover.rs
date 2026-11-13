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

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{bounds, point, size};

    fn row(top: f32) -> Bounds<Pixels> {
        bounds(point(px(0.), px(top)), size(px(100.), px(28.)))
    }

    /// A menu: two rows, a separator's 9px (4 + 1 + 4), two rows.
    fn menu() -> Vec<(usize, Bounds<Pixels>)> {
        vec![(0, row(0.)), (1, row(28.)), (2, row(65.)), (3, row(93.))]
    }

    #[test]
    fn the_row_under_the_pointer_wins() {
        assert_eq!(
            pick(menu(), point(px(10.), px(30.)), Axis::Vertical),
            Some(1)
        );
        assert_eq!(
            pick(menu(), point(px(10.), px(64.5)), Axis::Vertical),
            Some(2)
        );
    }

    #[test]
    fn a_hairline_gap_lights_its_neighbour_and_a_separator_does_not() {
        // 2px under row 1: within the tolerance.
        assert_eq!(
            pick(menu(), point(px(10.), px(58.)), Axis::Vertical),
            Some(1)
        );
        // The separator's middle, 4.5px from either row: dark.
        assert_eq!(pick(menu(), point(px(10.), px(60.5)), Axis::Vertical), None);
        // Beside the list: dark.
        assert_eq!(pick(menu(), point(px(120.), px(30.)), Axis::Vertical), None);
    }

    #[test]
    fn a_strip_measures_along_its_own_axis() {
        let tabs = vec![
            (0, bounds(point(px(0.), px(0.)), size(px(80.), px(28.)))),
            (1, bounds(point(px(82.), px(0.)), size(px(80.), px(28.)))),
        ];
        assert_eq!(
            pick(tabs.clone(), point(px(81.), px(10.)), Axis::Horizontal),
            Some(1)
        );
        assert_eq!(pick(tabs, point(px(170.), px(10.)), Axis::Horizontal), None);
    }

    fn state_with_menu() -> FluidHoverState {
        let mut state = FluidHoverState::default();
        for (ix, bounds) in menu() {
            let section = if ix < 2 { 0 } else { 1 };
            state.record(ix, bounds, ItemKind::target().section(section));
        }
        state
    }

    #[test]
    fn within_a_section_the_fill_glides_on_the_fast_tier() {
        let start = Instant::now();
        let mut state = state_with_menu();
        state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
        state.reconcile(start, false);
        // It came onto the list: a fade in place, no travel.
        let lit = state.lit.unwrap();
        assert_eq!(lit.rect.value(start), row(0.));
        assert_eq!(lit.opacity.value(start), 0.);
        let later = start + crate::tokens::DURATION_FAST;
        state.pointer_moved(point(px(10.), px(40.)), true, false, Axis::Vertical, later);
        assert!(state.reconcile(later, false));
        let lit = state.lit.unwrap();
        assert_eq!(lit.index, 1);
        assert_eq!(
            lit.rect.value(later),
            row(0.),
            "the glide starts where the fill was"
        );
        let halfway = later + crate::tokens::DURATION_FAST / 2;
        let y = f32::from(lit.rect.value(halfway).origin.y);
        assert!(y > 0. && y < 28., "mid-glide {y}");
        assert_eq!(
            lit.rect.value(later + crate::tokens::DURATION_FAST),
            row(28.)
        );
        assert!(state.leaving.is_empty(), "a glide leaves nothing behind");
    }

    #[test]
    fn crossing_a_separator_fades_out_and_in_instead_of_sliding() {
        let start = Instant::now();
        let mut state = state_with_menu();
        state.pointer_moved(point(px(10.), px(40.)), true, false, Axis::Vertical, start);
        state.reconcile(start, false);
        let later = start + crate::tokens::DURATION_FAST;
        state.pointer_moved(point(px(10.), px(70.)), true, false, Axis::Vertical, later);
        state.reconcile(later, false);
        let lit = state.lit.unwrap();
        assert_eq!(lit.index, 2);
        assert_eq!(lit.rect.value(later), row(65.), "placed, not travelling");
        assert_eq!(state.leaving.len(), 1);
        assert_eq!(state.leaving[0].rect, row(28.));
        // The old fill is gone after the fast exit (60 ms), before the new
        // one is fully in (80 ms).
        let exit = later + crate::tokens::DURATION_FAST_EXIT;
        state.reconcile(exit, false);
        assert!(state.leaving.is_empty());
        assert!(state.lit.unwrap().opacity.value(exit) < 1.);
    }

    #[test]
    fn leaving_the_list_fades_the_fill_out_where_it_was() {
        let start = Instant::now();
        let mut state = state_with_menu();
        state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
        state.reconcile(start, false);
        let shown = start + crate::tokens::DURATION_FAST;
        assert!(state.pointer_moved(
            point(px(300.), px(10.)),
            false,
            false,
            Axis::Vertical,
            shown
        ));
        state.reconcile(shown, false);
        assert!(state.lit.is_none());
        assert_eq!(state.leaving.len(), 1);
        assert_eq!(state.leaving[0].rect, row(0.));
        assert!(!state.reconcile(shown + crate::tokens::DURATION_FAST_EXIT, false));
    }

    #[test]
    fn a_skipped_row_clears_the_fill() {
        let start = Instant::now();
        let mut state = state_with_menu();
        state.record(1, row(28.), ItemKind::skip());
        state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
        state.reconcile(start, false);
        state.pointer_moved(point(px(10.), px(40.)), true, false, Axis::Vertical, start);
        state.reconcile(start, false);
        assert!(state.lit.is_none());
    }

    #[test]
    fn a_resting_pointer_does_not_relight_after_a_scroll() {
        let start = Instant::now();
        let mut state = state_with_menu();
        let at = point(px(10.), px(10.));
        state.pointer_moved(at, true, false, Axis::Vertical, start);
        assert!(state.scrolled(start));
        assert!(!state.pointer_moved(at, true, false, Axis::Vertical, start));
        assert_eq!(state.wanted, None);
        assert!(state.pointer_moved(point(px(11.), px(10.)), true, false, Axis::Vertical, start));
        assert_eq!(state.wanted, Some(0));
    }

    #[test]
    fn a_quiet_list_stays_dark_until_the_scroll_settles() {
        let start = Instant::now();
        let mut state = state_with_menu();
        state.quiet_after_scroll = Some(Duration::from_millis(150));
        state.scrolled(start);
        state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
        assert_eq!(state.wanted, None);
        let settled = start + Duration::from_millis(151);
        state.pointer_moved(
            point(px(11.), px(10.)),
            true,
            false,
            Axis::Vertical,
            settled,
        );
        assert_eq!(state.wanted, Some(0));
    }

    #[test]
    fn the_keys_move_the_same_fill_until_the_pointer_moves() {
        let start = Instant::now();
        let mut state = state_with_menu();
        state.follow(Some(0));
        state.reconcile(start, false);
        assert_eq!(state.lit.unwrap().index, 0);
        state.follow(Some(1));
        state.reconcile(start, false);
        assert_eq!(state.lit.unwrap().index, 1);
        // A keyboard-owned fill survives the pointer leaving and a scroll.
        state.pointer_moved(point(px(300.), px(0.)), false, false, Axis::Vertical, start);
        assert!(!state.scrolled(start));
        assert_eq!(state.wanted, Some(1));
        // The pointer moving over the list takes it back.
        state.pointer_moved(point(px(10.), px(100.)), true, false, Axis::Vertical, start);
        assert_eq!(state.wanted, Some(3));
        // The list adopting the pointer's row as current changes no hands.
        state.follow(Some(3));
        state.pointer_moved(point(px(300.), px(0.)), false, false, Axis::Vertical, start);
        assert_eq!(state.wanted, None);
    }

    #[test]
    fn a_held_button_or_a_press_clears_it() {
        let start = Instant::now();
        let mut state = state_with_menu();
        state.pointer_moved(point(px(10.), px(10.)), true, true, Axis::Vertical, start);
        assert_eq!(state.wanted, None);
        state.pointer_moved(point(px(10.), px(11.)), true, false, Axis::Vertical, start);
        assert!(state.pressed());
    }

    #[test]
    fn reduced_motion_lands_the_travel_and_keeps_the_fades() {
        let start = Instant::now();
        let mut state = state_with_menu();
        state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
        state.reconcile(start, true);
        state.pointer_moved(point(px(10.), px(40.)), true, false, Axis::Vertical, start);
        state.reconcile(start, true);
        let lit = state.lit.unwrap();
        assert_eq!(lit.rect.value(start), row(28.));
        assert!(lit.opacity.is_running(start), "the fade still runs");
    }

    #[test]
    fn a_row_gone_from_the_frame_is_not_lit() {
        let start = Instant::now();
        let mut state = state_with_menu();
        state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
        state.reconcile(start, false);
        // The next frame lays out no rows at all.
        state.frame += 1;
        state.reconcile(start, false);
        assert!(state.lit.is_none());
    }
}
