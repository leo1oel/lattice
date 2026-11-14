//! Lattice's scrollbar: quiet until you reach for it.
//!
//! The Tauri app draws one scrollbar per scroll area, Fluid Functionalism's
//! (`src/components/ui/scroll-area.tsx` and `scroll-area.css`, adapted from
//! <https://www.fluidfunctionalism.com/docs/scrollbars>, on Base UI's scroll
//! area). This draws the same bar over a GPUI scroll container:
//!
//! - a 10px track flush with the area's edge, a hit target even while the
//!   bar is invisible, and nothing at all when the content fits;
//! - the bar shows while the pointer is over the area and for 500 ms after
//!   the last scroll (Base UI's `SCROLL_TIMEOUT`), fading in over 160 ms on
//!   the fast tier's curve; it hides with an ease-out over 120 ms after
//!   waiting 160 ms, so the thumb narrows back before the fade can mask it
//!   (Fluid Functionalism's scroll area: `duration-120 ease-out delay-160`,
//!   `duration-160` in), on every feel alike;
//! - the thumb is a pill, 4px wide at rest and 2px off the edge, 6px under
//!   the pointer, in the ink at 8%, 12% over the track and 16% while held,
//!   its width and colour moving on the moderate tier; it stands 4px in from
//!   the track's ends and is never shorter than 16px;
//! - dragging the thumb scrolls with it; pressing the track jumps the thumb's
//!   middle to the pointer and goes on dragging.
//!
//! The app has four feels of that one bar, which differ only in what reveals
//! it, how long it lingers after a scroll, its shortest thumb and what a
//! press on the track does ([`ScrollbarFeel`]): a scroll area's
//! ([`ScrollbarFeel::AREA`], the above), a virtualized list's
//! (`external-scrollbar.tsx`, [`ScrollbarFeel::LIST`]), a document's overlay
//! (`overlay-scrollbar.tsx`, the PDF: [`ScrollbarFeel::DOCUMENT`]) and the
//! source editor's (`codemirror-scrollbar.tsx`: [`ScrollbarFeel::EDITOR`]). A
//! document's bar shows only under the pointer on the bar itself, so a page
//! does not light its edge whenever the pointer crosses it, and lingers 180
//! ms after a scroll. A wheel over any of them scrolls what is under it.
//!
//! Put it last in the positioned element that holds the scroll container,
//! covering it ([`FluidScrollbar::vertical`] is laid out `absolute`,
//! `inset_0`); the container itself draws no scrollbar of its own.

use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, App, Bounds, Corners, DispatchPhase, ElementId, Entity, Hitbox, HitboxBehavior,
    Hsla, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement as _, Pixels, Point, ScrollEvent, Styled as _, Window, canvas, div, fill, point,
    px, size,
};
use gpui_kit::base::ScrollbarHandle;

use crate::{
    ActiveLattice as _,
    motion::{Motion, Tween},
    token_types::MotionToken,
    tokens::{DURATION_MODERATE, DURATION_MODERATE_EXIT, EASE_EXIT, EASE_FAST},
};

/// The track's width: the hit target, flush with the edge.
pub const TRACK: Pixels = px(10.);
/// The thumb at rest, and under the pointer.
pub const THUMB: Pixels = px(4.);
pub const THUMB_HOVER: Pixels = px(6.);
/// How far the thumb is nudged off the area's edge (`translateX(-2px)`).
pub const THUMB_NUDGE: Pixels = px(2.);
/// The thumb's margin from the track's ends (`--space-2`).
pub const THUMB_MARGIN: Pixels = px(4.);
/// Base UI's `MIN_THUMB_SIZE`.
pub const MIN_THUMB: Pixels = px(16.);
/// How long the bar stays after the last scroll: Base UI's `SCROLL_TIMEOUT`.
pub const SCROLL_TIMEOUT: Duration = Duration::from_millis(500);
/// The ink's share in the thumb at rest, over the track, and held.
pub const INK_REST: f32 = 0.08;
pub const INK_HOVER: f32 = 0.12;
pub const INK_HELD: f32 = 0.16;

/// The bar's fade in: `--motion-fast`'s curve over `--duration-moderate`.
const SHOW: MotionToken = MotionToken::new(DURATION_MODERATE, EASE_FAST);
/// The fade out: an ease-out over `--duration-moderate-exit`, after
/// `--duration-moderate`, Fluid Functionalism's `duration-120 ease-out
/// delay-160`: exits a tier quicker than the 160 ms fade in.
pub const HIDE: MotionToken = MotionToken::new(DURATION_MODERATE_EXIT, EASE_EXIT);
pub const HIDE_DELAY: Duration = DURATION_MODERATE;

/// What a press on the track, off the thumb, does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TrackPress {
    /// The thumb's middle jumps to the pointer (Base UI, the overlay bars).
    CenterThumb,
    /// The document jumps to the pointer's share of the track
    /// (`codemirror-scrollbar.tsx`).
    Ratio,
}

/// One of the app's scrollbar feels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollbarFeel {
    /// The pointer anywhere over the area reveals the bar; otherwise only
    /// the pointer on the bar does.
    pub reveal_on_area: bool,
    /// How long the bar stays after the last scroll.
    pub linger: Duration,
    /// The shortest thumb.
    pub min_thumb: Pixels,
    pub press: TrackPress,
}

impl ScrollbarFeel {
    /// A scroll area (`scroll-area.tsx`, Base UI).
    pub const AREA: ScrollbarFeel = ScrollbarFeel {
        reveal_on_area: true,
        linger: SCROLL_TIMEOUT,
        min_thumb: MIN_THUMB,
        press: TrackPress::CenterThumb,
    };
    /// A virtualized list drawn by its own scroller, such as the Project
    /// tree (`external-scrollbar.tsx`): revealed over the list, an 18px thumb.
    pub const LIST: ScrollbarFeel = ScrollbarFeel {
        min_thumb: px(18.),
        ..Self::AREA
    };
    /// A document's overlay bar (`overlay-scrollbar.tsx`, the PDF): revealed
    /// on the bar, 180 ms after a scroll, a 24px thumb.
    pub const DOCUMENT: ScrollbarFeel = ScrollbarFeel {
        reveal_on_area: false,
        linger: Duration::from_millis(180),
        min_thumb: px(24.),
        press: TrackPress::CenterThumb,
    };
    /// The source editor's bar (`codemirror-scrollbar.tsx`): the document's,
    /// with a track press that goes to the pointer's share of the document.
    pub const EDITOR: ScrollbarFeel = ScrollbarFeel {
        press: TrackPress::Ratio,
        ..Self::DOCUMENT
    };
}

/// Which way the bar scrolls.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScrollAxis {
    Vertical,
    Horizontal,
}

#[derive(Clone, Copy, Debug)]
struct Drag {
    /// Where on the thumb it was taken, along the axis.
    grab: Pixels,
}

/// The bar's state between frames.
#[derive(Debug)]
pub struct ScrollbarState {
    feel: ScrollbarFeel,
    last_offset: Option<Point<Pixels>>,
    last_scroll: Option<Instant>,
    over_area: bool,
    over_track: bool,
    drag: Option<Drag>,
    opacity: Tween<f32>,
    width: Tween<Pixels>,
    ink: Tween<f32>,
    /// A wake-up is pending for the scroll timeout.
    timer: bool,
}

impl ScrollbarState {
    fn new(feel: ScrollbarFeel, now: Instant) -> Self {
        Self {
            feel,
            last_offset: None,
            last_scroll: None,
            over_area: false,
            over_track: false,
            drag: None,
            opacity: Tween::settled(0., now),
            width: Tween::settled(THUMB, now),
            ink: Tween::settled(INK_REST, now),
            timer: false,
        }
    }

    fn scrolling(&self, now: Instant) -> bool {
        self.last_scroll
            .is_some_and(|at| now.saturating_duration_since(at) < self.feel.linger)
    }

    /// How long from `now` until a scroll stops holding the bar up.
    fn linger_left(&self, now: Instant) -> Option<Duration> {
        self.last_scroll
            .map(|at| (at + self.feel.linger).saturating_duration_since(now))
            .filter(|due| !due.is_zero())
    }

    /// Bring the tweens in line with the pointer and the scroll at `now`;
    /// whether anything still moves.
    fn reconcile(&mut self, now: Instant, reduce_motion: bool) -> bool {
        let pointer = if self.feel.reveal_on_area {
            self.over_area
        } else {
            self.over_track
        };
        let shown = pointer || self.drag.is_some() || self.scrolling(now);
        if shown {
            self.opacity.retarget_on(1., SHOW, Duration::ZERO, now);
        } else {
            self.opacity.retarget_on(0., HIDE, HIDE_DELAY, now);
        }
        let wide = self.over_track || self.drag.is_some();
        let width = if wide { THUMB_HOVER } else { THUMB };
        if reduce_motion {
            self.width.jump(width, now);
        } else {
            self.width.retarget(width, Motion::Moderate, now);
        }
        let ink = if self.drag.is_some() {
            INK_HELD
        } else if self.over_track {
            INK_HOVER
        } else {
            INK_REST
        };
        self.ink.retarget(ink, Motion::Moderate, now);
        self.opacity.is_running(now) || self.width.is_running(now) || self.ink.is_running(now)
    }
}

/// Where the thumb stands in a track, along its axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ThumbGeometry {
    /// From the track's start.
    pub start: Pixels,
    pub length: Pixels,
    /// How far the thumb can travel.
    pub travel: Pixels,
}

/// The thumb in a track `track` long, for a viewport `viewport` long over
/// content `content` long, scrolled `scrolled` (a positive distance).
pub fn thumb_geometry(
    min_thumb: Pixels,
    track: Pixels,
    viewport: Pixels,
    content: Pixels,
    scrolled: Pixels,
) -> Option<ThumbGeometry> {
    if content <= viewport + px(1.) || viewport <= px(0.) {
        return None;
    }
    let room = (track - THUMB_MARGIN * 2.).max(px(0.));
    let length = (room * (viewport / content)).max(min_thumb).min(room);
    let travel = (room - length).max(px(0.));
    let max_scroll = content - viewport;
    let progress = (scrolled / max_scroll).clamp(0., 1.);
    Some(ThumbGeometry {
        start: THUMB_MARGIN + travel * progress,
        length,
        travel,
    })
}

/// The scroll distance that puts the thumb's start at `thumb_start` (from
/// the track's start).
pub fn scroll_for_thumb(
    geometry: ThumbGeometry,
    thumb_start: Pixels,
    viewport: Pixels,
    content: Pixels,
) -> Pixels {
    if geometry.travel <= px(0.) {
        return px(0.);
    }
    let progress = ((thumb_start - THUMB_MARGIN) / geometry.travel).clamp(0., 1.);
    (content - viewport) * progress
}

/// A scroll area's bar, laid over it.
pub struct FluidScrollbar {
    id: ElementId,
    handle: Rc<dyn ScrollbarHandle>,
    axis: ScrollAxis,
    feel: ScrollbarFeel,
    ink: Option<Hsla>,
    drawn: Option<Rc<Cell<f32>>>,
    drawn_thumb: Option<Rc<Cell<Option<DrawnThumb>>>>,
}

/// The thumb as it was last painted, and the track it stands in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawnThumb {
    pub thumb: Bounds<Pixels>,
    pub track: Bounds<Pixels>,
}

impl FluidScrollbar {
    pub fn vertical(id: impl Into<ElementId>, handle: &(impl ScrollbarHandle + Clone)) -> Self {
        Self {
            id: id.into(),
            handle: Rc::new(handle.clone()),
            axis: ScrollAxis::Vertical,
            feel: ScrollbarFeel::AREA,
            ink: None,
            drawn: None,
            drawn_thumb: None,
        }
    }

    /// The feel of the surface it scrolls (a scroll area's by default).
    pub fn feel(mut self, feel: ScrollbarFeel) -> Self {
        self.feel = feel;
        self
    }

    /// The thumb's ink, before its 8/12/16% share: the primary text by
    /// default, the code ink over the source editor (`--code-ink`).
    pub fn ink(mut self, ink: Hsla) -> Self {
        self.ink = Some(ink);
        self
    }

    /// Where to note the thumb's opacity each time the bar is drawn, for a
    /// caller that checks what is on screen.
    pub fn drawn_opacity(mut self, drawn: Rc<Cell<f32>>) -> Self {
        self.drawn = Some(drawn);
        self
    }

    /// Where to note the thumb's bounds each time it is drawn (`None` while
    /// it is invisible or the content fits), for a caller that measures it.
    pub fn drawn_thumb(mut self, thumb: Rc<Cell<Option<DrawnThumb>>>) -> Self {
        self.drawn_thumb = Some(thumb);
        self
    }

    pub fn horizontal(id: impl Into<ElementId>, handle: &(impl ScrollbarHandle + Clone)) -> Self {
        Self {
            axis: ScrollAxis::Horizontal,
            ..Self::vertical(id, handle)
        }
    }
}

struct Prepainted {
    state: Entity<ScrollbarState>,
    area: Hitbox,
    track: Option<(Hitbox, ThumbGeometry, Bounds<Pixels>)>,
    lengths: (Pixels, Pixels),
}

impl IntoElement for FluidScrollbar {
    type Element = AnyElement;

    fn into_element(self) -> Self::Element {
        let FluidScrollbar {
            id,
            handle,
            axis,
            feel,
            ink: thumb_ink,
            drawn,
            drawn_thumb,
        } = self;
        div()
            .absolute()
            .inset_0()
            .child(
                canvas(
                    {
                        let handle = handle.clone();
                        move |bounds, window, cx| {
                            let state = window.use_keyed_state(id, cx, |_, _| {
                                ScrollbarState::new(feel, Instant::now())
                            });
                            // Reading the offset here tells a retained view
                            // that its frame depends on the scroll, so a
                            // scroll draws the bar again.
                            let offset = handle.offset();
                            let content = handle.content_size();
                            let viewport = handle.viewport_bounds().size;
                            let (track_len, viewport_len, content_len, scrolled) = match axis {
                                ScrollAxis::Vertical => (
                                    bounds.size.height,
                                    viewport.height,
                                    content.height,
                                    -offset.y,
                                ),
                                ScrollAxis::Horizontal => {
                                    (bounds.size.width, viewport.width, content.width, -offset.x)
                                }
                            };
                            let area = window.insert_hitbox(bounds, HitboxBehavior::Normal);
                            let track = thumb_geometry(
                                feel.min_thumb,
                                track_len,
                                viewport_len,
                                content_len,
                                scrolled,
                            )
                            .map(|geometry| {
                                let track_bounds = match axis {
                                    ScrollAxis::Vertical => Bounds::new(
                                        point(bounds.right() - TRACK, bounds.top()),
                                        size(TRACK, bounds.size.height),
                                    ),
                                    ScrollAxis::Horizontal => Bounds::new(
                                        point(bounds.left(), bounds.bottom() - TRACK),
                                        size(bounds.size.width, TRACK),
                                    ),
                                };
                                // The track takes the pointer even while
                                // the bar is invisible, as the web
                                // scrollbar's does at opacity 0, but a
                                // wheel over it scrolls what is under it.
                                let hitbox = window.insert_hitbox(
                                    track_bounds,
                                    HitboxBehavior::BlockMouseExceptScroll,
                                );
                                (hitbox, geometry, track_bounds)
                            });
                            Prepainted {
                                state,
                                area,
                                track,
                                lengths: (viewport_len, content_len),
                            }
                        }
                    },
                    move |_, prepainted: Prepainted, window, cx| {
                        let now = Instant::now();
                        let state = prepainted.state.clone();
                        let offset = handle.offset();
                        state.update(cx, |state, _| {
                            if state.last_offset.is_some_and(|last| last != offset) {
                                state.last_scroll = Some(now);
                            }
                            state.last_offset = Some(offset);
                        });
                        listen(&state, &handle, axis, feel.press, &prepainted, window);
                        let reduce = cx.reduce_motion();
                        let running = state.update(cx, |state, _| state.reconcile(now, reduce));
                        schedule_timeout(&state, now, window, cx);
                        let (opacity, width, ink) = {
                            let state = state.read(cx);
                            (
                                state.opacity.value(now),
                                state.width.value(now),
                                state.ink.value(now),
                            )
                        };
                        let Some((_, geometry, track)) = prepainted.track else {
                            if let Some(drawn) = &drawn {
                                drawn.set(0.);
                            }
                            if let Some(thumb) = &drawn_thumb {
                                thumb.set(None);
                            }
                            return;
                        };
                        if let Some(drawn) = &drawn {
                            drawn.set(opacity.clamp(0., 1.));
                        }
                        if opacity > 0. {
                            let mut colour: Hsla = thumb_ink.unwrap_or(cx.palette().text);
                            colour.a = ink * opacity.clamp(0., 1.);
                            let thumb = thumb_bounds(axis, track, geometry, width);
                            if let Some(drawn) = &drawn_thumb {
                                drawn.set(Some(DrawnThumb { thumb, track }));
                            }
                            window.paint_quad(
                                fill(thumb, colour).corner_radii(Corners::all(width / 2.)),
                            );
                        }
                        if opacity <= 0.
                            && let Some(thumb) = &drawn_thumb
                        {
                            thumb.set(None);
                        }
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

/// The thumb's bounds in `track`, `width` wide across it: centred in the
/// track, then nudged toward the content by [`THUMB_NUDGE`].
fn thumb_bounds(
    axis: ScrollAxis,
    track: Bounds<Pixels>,
    geometry: ThumbGeometry,
    width: Pixels,
) -> Bounds<Pixels> {
    let across = (TRACK - width) / 2. - THUMB_NUDGE;
    match axis {
        ScrollAxis::Vertical => Bounds::new(
            point(track.left() + across, track.top() + geometry.start),
            size(width, geometry.length),
        ),
        ScrollAxis::Horizontal => Bounds::new(
            point(track.left() + geometry.start, track.top() + across),
            size(geometry.length, width),
        ),
    }
}

fn along(axis: ScrollAxis, position: Point<Pixels>, track: Bounds<Pixels>) -> Pixels {
    match axis {
        ScrollAxis::Vertical => position.y - track.top(),
        ScrollAxis::Horizontal => position.x - track.left(),
    }
}

fn with_scroll(axis: ScrollAxis, offset: Point<Pixels>, scrolled: Pixels) -> Point<Pixels> {
    match axis {
        ScrollAxis::Vertical => point(offset.x, -scrolled),
        ScrollAxis::Horizontal => point(-scrolled, offset.y),
    }
}

fn listen(
    state: &Entity<ScrollbarState>,
    handle: &Rc<dyn ScrollbarHandle>,
    axis: ScrollAxis,
    press: TrackPress,
    prepainted: &Prepainted,
    window: &mut Window,
) {
    let view = window.current_view();
    let (viewport_len, content_len) = prepainted.lengths;
    let area = prepainted.area.clone();
    let track = prepainted.track.clone();

    {
        let state = state.clone();
        let handle = handle.clone();
        let area = area.clone();
        let track = track.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            let over_area = area.is_hovered(window);
            let over_track = track
                .as_ref()
                .is_some_and(|(hitbox, _, _)| hitbox.is_hovered(window));
            let mut changed = false;
            state.update(cx, |state, _| {
                if state.over_area != over_area || state.over_track != over_track {
                    state.over_area = over_area;
                    state.over_track = over_track;
                    changed = true;
                }
                if let (Some(drag), Some((_, geometry, bounds))) = (state.drag, track.as_ref()) {
                    if event.pressed_button == Some(MouseButton::Left) {
                        let start = along(axis, event.position, *bounds) - drag.grab;
                        let scrolled =
                            scroll_for_thumb(*geometry, start, viewport_len, content_len);
                        handle.set_offset(with_scroll(axis, handle.offset(), scrolled));
                        changed = true;
                    }
                }
            });
            if changed {
                cx.notify(view);
            }
        });
    }

    if let Some((hitbox, geometry, bounds)) = track {
        let state = state.clone();
        let handle = handle.clone();
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble
                || event.button != MouseButton::Left
                || !hitbox.is_hovered(window)
            {
                return;
            }
            let at = along(axis, event.position, bounds);
            let on_thumb = at >= geometry.start && at <= geometry.start + geometry.length;
            let grab = if on_thumb {
                at - geometry.start
            } else {
                match press {
                    // The thumb's middle jumps to the pointer.
                    TrackPress::CenterThumb => {
                        let grab = geometry.length / 2.;
                        let scrolled =
                            scroll_for_thumb(geometry, at - grab, viewport_len, content_len);
                        handle.set_offset(with_scroll(axis, handle.offset(), scrolled));
                        grab
                    }
                    // The document goes to the pointer's share of the track,
                    // and the thumb is held where that leaves it.
                    TrackPress::Ratio => {
                        let length = match axis {
                            ScrollAxis::Vertical => bounds.size.height,
                            ScrollAxis::Horizontal => bounds.size.width,
                        };
                        let share = (at / length).clamp(0., 1.);
                        let scrolled = (content_len - viewport_len) * share;
                        handle.set_offset(with_scroll(axis, handle.offset(), scrolled));
                        at - (THUMB_MARGIN + geometry.travel * share)
                    }
                }
            };
            handle.start_drag();
            state.update(cx, |state, _| state.drag = Some(Drag { grab }));
            cx.stop_propagation();
            cx.notify(view);
        });
    }

    {
        let state = state.clone();
        let handle = handle.clone();
        window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            let released = state.update(cx, |state, _| state.drag.take().is_some());
            if released {
                handle.end_drag();
                cx.notify(view);
            }
        });
    }

    {
        let state = state.clone();
        window.on_mouse_event(move |_: &ScrollEvent, phase, window, cx| {
            if phase == DispatchPhase::Bubble && area.is_hovered(window) {
                state.update(cx, |state, _| state.last_scroll = Some(Instant::now()));
                cx.notify(view);
            }
        });
    }
}

/// While the bar shows only because of a scroll, wake when the scroll
/// timeout ends, so it starts to hide.
fn schedule_timeout(
    state: &Entity<ScrollbarState>,
    now: Instant,
    window: &mut Window,
    cx: &mut App,
) {
    let (pending, due) = {
        let state = state.read(cx);
        (state.timer, state.linger_left(now))
    };
    let (false, Some(due)) = (pending, due) else {
        return;
    };
    state.update(cx, |state, _| state.timer = true);
    let view = window.current_view();
    let state = state.clone();
    window
        .spawn(cx, async move |cx| {
            cx.background_executor().timer(due).await;
            cx.update(|_, cx| {
                state.update(cx, |state, _| state.timer = false);
                cx.notify(view);
            })
            .ok();
        })
        .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_that_fits_draws_no_bar() {
        assert_eq!(
            thumb_geometry(MIN_THUMB, px(300.), px(300.), px(300.), px(0.)),
            None
        );
        assert_eq!(
            thumb_geometry(MIN_THUMB, px(300.), px(300.), px(300.5), px(0.)),
            None
        );
    }

    #[test]
    fn the_thumb_is_the_viewports_share_of_the_track_inside_its_margins() {
        // A 308px track: 300px between the 4px margins; a third of the
        // content in view.
        let g = thumb_geometry(MIN_THUMB, px(308.), px(300.), px(900.), px(0.)).unwrap();
        assert_eq!(g.start, THUMB_MARGIN);
        assert_eq!(g.length, px(100.));
        assert_eq!(g.travel, px(200.));
        let end = thumb_geometry(MIN_THUMB, px(308.), px(300.), px(900.), px(600.)).unwrap();
        assert_eq!(end.start, px(204.));
    }

    #[test]
    fn a_long_document_keeps_a_16px_thumb() {
        let g = thumb_geometry(MIN_THUMB, px(308.), px(300.), px(300_000.), px(0.)).unwrap();
        assert_eq!(g.length, MIN_THUMB);
    }

    #[test]
    fn dragging_the_thumb_maps_back_to_the_scroll() {
        let g = thumb_geometry(MIN_THUMB, px(308.), px(300.), px(900.), px(0.)).unwrap();
        assert_eq!(scroll_for_thumb(g, px(104.), px(300.), px(900.)), px(300.));
        assert_eq!(scroll_for_thumb(g, px(-50.), px(300.), px(900.)), px(0.));
        assert_eq!(scroll_for_thumb(g, px(999.), px(300.), px(900.)), px(600.));
    }

    #[test]
    fn the_thumb_stands_two_pixels_off_the_edge_and_widens_inward() {
        let track = Bounds::new(point(px(90.), px(0.)), size(TRACK, px(308.)));
        let g = thumb_geometry(MIN_THUMB, px(308.), px(300.), px(900.), px(0.)).unwrap();
        let rest = thumb_bounds(ScrollAxis::Vertical, track, g, THUMB);
        assert_eq!(rest.left(), px(91.));
        assert_eq!(track.right() - rest.right(), px(5.));
        let wide = thumb_bounds(ScrollAxis::Vertical, track, g, THUMB_HOVER);
        assert_eq!(wide.left(), px(90.));
        assert_eq!(track.right() - wide.right(), px(4.));
    }

    #[test]
    fn the_bar_fades_in_on_hover_and_out_after_a_pause() {
        let start = Instant::now();
        let mut state = ScrollbarState::new(ScrollbarFeel::AREA, start);
        state.over_area = true;
        assert!(state.reconcile(start, false));
        assert_eq!(state.opacity.value(start + DURATION_MODERATE), 1.);
        let left = start + DURATION_MODERATE;
        state.over_area = false;
        state.reconcile(left, false);
        // Held through the delay, gone 120 ms later.
        assert_eq!(state.opacity.value(left + HIDE_DELAY), 1.);
        assert_eq!(
            state
                .opacity
                .value(left + HIDE_DELAY + DURATION_MODERATE_EXIT),
            0.
        );
    }

    #[test]
    fn a_scroll_shows_the_bar_until_the_timeout() {
        let start = Instant::now();
        let mut state = ScrollbarState::new(ScrollbarFeel::AREA, start);
        state.last_scroll = Some(start);
        state.reconcile(start, false);
        assert!(state.scrolling(start + Duration::from_millis(499)));
        assert!(!state.scrolling(start + SCROLL_TIMEOUT));
    }

    #[test]
    fn the_thumb_widens_and_darkens_over_the_track_and_while_held() {
        let start = Instant::now();
        let mut state = ScrollbarState::new(ScrollbarFeel::AREA, start);
        state.over_area = true;
        state.over_track = true;
        state.reconcile(start, false);
        let settled = start + DURATION_MODERATE;
        assert_eq!(state.width.value(settled), THUMB_HOVER);
        assert_eq!(state.ink.value(settled), INK_HOVER);
        state.drag = Some(Drag { grab: px(3.) });
        state.reconcile(settled, false);
        assert_eq!(state.ink.value(settled + DURATION_MODERATE), INK_HELD);
    }

    #[test]
    fn a_documents_bar_shows_only_on_the_bar_and_lingers_180_ms() {
        let start = Instant::now();
        let mut state = ScrollbarState::new(ScrollbarFeel::DOCUMENT, start);
        state.over_area = true;
        state.reconcile(start, false);
        assert_eq!(
            state.opacity.target(),
            0.,
            "the page under the pointer does not reveal it"
        );
        state.over_track = true;
        state.reconcile(start, false);
        assert_eq!(state.opacity.target(), 1.);
        state.over_track = false;
        state.last_scroll = Some(start);
        assert!(state.scrolling(start + Duration::from_millis(179)));
        assert!(!state.scrolling(start + Duration::from_millis(180)));
    }

    #[test]
    fn the_hide_timer_wakes_when_the_feels_linger_ends() {
        let start = Instant::now();
        let mut document = ScrollbarState::new(ScrollbarFeel::DOCUMENT, start);
        document.last_scroll = Some(start);
        assert_eq!(
            document.linger_left(start),
            Some(Duration::from_millis(180))
        );
        assert_eq!(
            document.linger_left(start + Duration::from_millis(100)),
            Some(Duration::from_millis(80))
        );
        assert_eq!(
            document.linger_left(start + Duration::from_millis(180)),
            None
        );
        let mut area = ScrollbarState::new(ScrollbarFeel::AREA, start);
        area.last_scroll = Some(start);
        assert_eq!(area.linger_left(start), Some(Duration::from_millis(500)));
    }

    #[test]
    fn the_editors_and_documents_thumb_is_never_under_24px() {
        let g = thumb_geometry(
            ScrollbarFeel::EDITOR.min_thumb,
            px(308.),
            px(300.),
            px(300_000.),
            px(0.),
        )
        .unwrap();
        assert_eq!(g.length, px(24.));
        assert_eq!(ScrollbarFeel::LIST.min_thumb, px(18.));
    }
}
