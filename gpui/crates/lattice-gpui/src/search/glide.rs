//! The current row's fill that glides from row to row, as the Tauri app's
//! keyboard lists draw it (`FluidHoverHighlight` over a `fluid-hover-surface`,
//! `src/components/ui/fluid-hover-highlight.tsx`): one fill behind the rows,
//! springing on the fast tier to the row the keys or the pointer reached,
//! rather than each row lighting on its own.
//!
//! The rows are measured where they were laid out: each row carries a probe
//! that records its bounds when the frame is prepainted, and the fill, drawn
//! first so it sits under the rows, paints once every row is measured. The
//! fill keeps its place relative to the list's content, so scrolling moves
//! it with the rows instead of starting a glide.

use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{Bounds, Corners, Hsla, IntoElement, Pixels, Point, Styled as _, canvas, fill, point};
use lattice_ui::Motion;

#[derive(Default)]
struct State {
    /// Each row's bounds this frame, in window coordinates.
    rows: HashMap<usize, Bounds<Pixels>>,
    /// The glide under way, relative to the list's content.
    from: Option<Bounds<Pixels>>,
    to: Option<Bounds<Pixels>>,
    started: Option<Instant>,
}

/// One list's fill. Cheap to clone; keep one per list for the list's life.
#[derive(Clone, Default)]
pub struct Glide(Rc<RefCell<State>>);

impl Glide {
    /// Forget where the fill was, so the next active row takes it without a
    /// glide (a new query's results).
    pub fn reset(&self) {
        let mut state = self.0.borrow_mut();
        state.from = None;
        state.to = None;
        state.started = None;
    }

    /// The probe a row carries: an empty canvas over the row recording its
    /// bounds. Put it inside the row, which must be `relative`.
    pub fn probe(&self, ix: usize) -> impl IntoElement {
        let state = self.0.clone();
        canvas(
            move |bounds, _, _| {
                state.borrow_mut().rows.insert(ix, bounds);
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }

    /// The fill, under row `active`: the list's first child, over the whole
    /// content (the content must be `relative`).
    pub fn fill(&self, active: Option<usize>, color: Hsla, radius: Pixels) -> impl IntoElement {
        let prepaint = self.0.clone();
        let paint = self.0.clone();
        canvas(
            // The fill prepaints before its sibling rows, so last frame's
            // measurements are cleared here and this frame's land after.
            move |bounds, _, _| {
                prepaint.borrow_mut().rows.clear();
                bounds.origin
            },
            move |_, origin: Point<Pixels>, window, cx| {
                let mut state = paint.borrow_mut();
                let Some(row) = active.and_then(|ix| state.rows.get(&ix).copied()) else {
                    return;
                };
                let target = Bounds::new(row.origin - origin, row.size);
                let now = Instant::now();
                let duration = if cx.reduce_motion() {
                    Duration::ZERO
                } else {
                    Motion::Fast.duration()
                };
                if state.to != Some(target) {
                    // From wherever the fill is now, so a glide redirected
                    // mid-way does not jump.
                    let current = current(&state, now, duration);
                    state.from = current.or(Some(target));
                    state.to = Some(target);
                    state.started = Some(now);
                }
                let shown = current(&state, now, duration).unwrap_or(target);
                if shown != target {
                    window.request_animation_frame();
                }
                let shown = Bounds::new(shown.origin + origin, shown.size);
                window.paint_quad(fill(shown, color).corner_radii(Corners::all(radius)));
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

/// Where the fill is at `now`, on the fast tier's curve.
fn current(state: &State, now: Instant, duration: Duration) -> Option<Bounds<Pixels>> {
    let (from, to, started) = (state.from?, state.to?, state.started?);
    let elapsed = now.saturating_duration_since(started);
    if duration.is_zero() || elapsed >= duration {
        return Some(to);
    }
    let t = Motion::Fast.sample(elapsed.as_secs_f32() / duration.as_secs_f32());
    let lerp = |a: Pixels, b: Pixels| a + (b - a) * t;
    Some(Bounds::new(
        point(
            lerp(from.origin.x, to.origin.x),
            lerp(from.origin.y, to.origin.y),
        ),
        gpui::size(
            lerp(from.size.width, to.size.width),
            lerp(from.size.height, to.size.height),
        ),
    ))
}
