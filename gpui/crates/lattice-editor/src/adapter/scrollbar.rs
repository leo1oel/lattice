//! The editor's overlay scrollbar, as the Tauri app draws one over
//! CodeMirror (`src/canvas/codemirror-scrollbar.tsx`, `.cm-overlay-scrollbar`
//! in `editor-workspace.css`), in place of Zed's (turned off in the settings).
//!
//! A 10px strip down the editor's right edge, hidden at rest. It fades in
//! while the text scrolls (until 180 ms after the last scroll), while the
//! pointer is over it and while its thumb is held: on the fast tier's curve
//! over the moderate tier's 160 ms, and out over 80 ms once 160 ms have
//! passed. A strip over text that does not scroll stays hidden and lets the
//! pointer through to the text.
//!
//! The thumb is a 4px pill 4px in from the strip's ends, the code ink at 8%,
//! at least 24px tall, as tall as the share of the document in view; under
//! the pointer it widens to 6px at 12% on the moderate tier, and held it is
//! 16%. Dragging it scrolls in proportion; a press on the strip off the
//! thumb jumps there.

use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, Bounds, Context, Hsla, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, point, px, size,
};
use lattice_ui::{
    Motion,
    interaction::{ease_to, mix},
    tokens::DURATION_MODERATE,
};
use theme::ActiveTheme as _;

use super::LatticeEditor;

/// The strip's width, and the thumb's at rest and under the pointer.
const STRIP: Pixels = px(10.);
const THUMB: f32 = 4.;
const THUMB_HOVER: f32 = 6.;
/// The thumb's inset from the strip's ends, and its least height.
const INSET: f32 = 4.;
const MIN_THUMB: f32 = 24.;
/// How long after the last scroll the strip still counts as scrolling.
const SCROLL_IDLE: Duration = Duration::from_millis(180);

/// The scrollbar's state between frames.
#[derive(Default)]
pub(super) struct Scrollbar {
    scrolled_at: Option<Instant>,
    hovered: bool,
    /// The pointer's y and the top row when the thumb was taken.
    drag: Option<(Pixels, f64)>,
    /// The strip's bounds as last painted, for the pointer's events.
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    _idle: Option<gpui::Task<()>>,
}

/// Where the editor is scrolled, in display rows.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Extent {
    top: f64,
    visible: f64,
    total: f64,
}

impl Extent {
    fn max_top(&self) -> f64 {
        (self.total - self.visible).max(0.)
    }

    fn overflows(&self) -> bool {
        self.max_top() > 0.01
    }

    /// The thumb's top and height in a strip `height` tall
    /// (`thumbGeometry`): the track is the strip less its 4px ends.
    fn thumb(&self, height: f32) -> (f32, f32) {
        let track = (height - INSET * 2.).max(0.);
        let share = if self.total > 0. {
            (self.visible / self.total) as f32
        } else {
            1.
        };
        let thumb = (track * share).max(MIN_THUMB).min(track);
        let travel = (track - thumb).max(0.);
        let ratio = if self.max_top() > 0. {
            (self.top / self.max_top()).clamp(0., 1.) as f32
        } else {
            0.
        };
        (INSET + travel * ratio, thumb)
    }

    /// The top row for a thumb moved `dy` from where it was taken at
    /// `from` in a strip `height` tall.
    fn dragged(&self, from: f64, dy: f32, height: f32) -> f64 {
        let (_, thumb) = self.thumb(height);
        let travel = (height - INSET * 2. - thumb).max(1.);
        (from + dy as f64 * self.max_top() / travel as f64).clamp(0., self.max_top())
    }

    /// The top row a press at `y` (from the strip's top) jumps to.
    fn jumped(&self, y: f32, height: f32) -> f64 {
        (y / height.max(1.)).clamp(0., 1.) as f64 * self.max_top()
    }
}

impl LatticeEditor {
    /// The text scrolled: show the strip until it rests again.
    pub(super) fn note_scroll(&mut self, cx: &mut Context<Self>) {
        self.scrollbar.scrolled_at = Some(Instant::now());
        if self.scrollbar._idle.is_some() {
            return;
        }
        self.scrollbar._idle = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(SCROLL_IDLE).await;
                let resting = this
                    .update(cx, |this, cx| {
                        let resting = this
                            .scrollbar
                            .scrolled_at
                            .is_none_or(|at| at.elapsed() >= SCROLL_IDLE);
                        if resting {
                            this.scrollbar._idle = None;
                            cx.notify();
                        }
                        resting
                    })
                    .unwrap_or(true);
                if resting {
                    break;
                }
            }
        }));
    }

    fn extent(&self, cx: &mut Context<Self>) -> Extent {
        self.editor.update(cx, |editor, cx| {
            let top = editor.scroll_position(cx).y;
            let visible = editor.visible_line_count().unwrap_or(0.);
            let total = editor.max_point(cx).row().0 as f64 + 1.;
            Extent {
                top,
                visible,
                total,
            }
        })
    }

    fn scroll_to(&mut self, top: f64, window: &mut Window, cx: &mut Context<Self>) {
        self.editor.update(cx, |editor, cx| {
            let x = editor.scroll_position(cx).x;
            editor.set_scroll_position(point(x, top), window, cx);
        });
    }

    pub(super) fn render_scrollbar(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let extent = self.extent(cx);
        let overflows = extent.overflows();
        let scrolling = self
            .scrollbar
            .scrolled_at
            .is_some_and(|at| at.elapsed() < SCROLL_IDLE);
        let dragging = self.scrollbar.drag.is_some();
        let shown = overflows && (self.scrollbar.hovered || scrolling || dragging);
        // In: the fast tier's curve over the moderate tier's length. Out:
        // the fast tier, once the moderate tier's length has passed.
        let fast = Motion::Fast.duration();
        let opacity = if shown {
            ease_to(
                "lattice-scrollbar-shown",
                1.,
                Motion::Fast,
                DURATION_MODERATE,
                Duration::ZERO,
                window,
                cx,
            )
        } else {
            ease_to(
                "lattice-scrollbar-shown",
                0.,
                Motion::Fast,
                fast,
                DURATION_MODERATE,
                window,
                cx,
            )
        };
        let lit = self.scrollbar.hovered || dragging;
        let widen = ease_to(
            "lattice-scrollbar-hover",
            if lit { 1. } else { 0. },
            Motion::Moderate,
            DURATION_MODERATE,
            Duration::ZERO,
            window,
            cx,
        );
        let ink = cx.theme().colors().editor_foreground;
        let rest = ink.opacity(0.08);
        let color: Hsla = if dragging {
            ink.opacity(0.16)
        } else {
            mix(rest, ink.opacity(0.12), widen)
        };
        let width = THUMB + (THUMB_HOVER - THUMB) * widen;
        let bounds_cell = self.scrollbar.bounds.clone();
        let this = cx.entity().downgrade();
        let strip = div()
            .id("lattice-scrollbar")
            .absolute()
            .top_0()
            .right_0()
            .w(STRIP)
            .h_full()
            .opacity(opacity)
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| {
                        bounds_cell.set(Some(bounds));
                        if opacity <= 0. {
                            return;
                        }
                        let (top, height) = extent.thumb(f32::from(bounds.size.height));
                        // Centred in the strip, then 2px further from the
                        // edge, on the line every Lattice scrollbar keeps.
                        let left = (f32::from(STRIP) - width) / 2. - 2.;
                        let thumb = Bounds::new(
                            point(
                                bounds.origin.x + px(left.max(0.)),
                                bounds.origin.y + px(top),
                            ),
                            size(px(width), px(height)),
                        );
                        window.paint_quad(gpui::fill(thumb, color).corner_radii(px(width / 2.)));
                    },
                )
                .size_full(),
            );
        if !overflows {
            return strip.into_any_element();
        }
        let hover = this.clone();
        let down = this.clone();
        let bounds = self.scrollbar.bounds.clone();
        strip
            .on_hover(move |hovered, _, cx| {
                hover
                    .update(cx, |this, cx| {
                        if this.scrollbar.hovered != *hovered {
                            this.scrollbar.hovered = *hovered;
                            cx.notify();
                        }
                    })
                    .ok();
            })
            .on_mouse_down(
                MouseButton::Left,
                move |event: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    let Some(strip) = bounds.get() else {
                        return;
                    };
                    down.update(cx, |this, cx| {
                        let extent = this.extent(cx);
                        let height = f32::from(strip.size.height);
                        let y = f32::from(event.position.y - strip.origin.y);
                        let (top, thumb) = extent.thumb(height);
                        if !(top..top + thumb).contains(&y) {
                            // Off the thumb: jump there, then hold it from there.
                            let jumped = extent.jumped(y, height);
                            this.scroll_to(jumped, window, cx);
                            this.scrollbar.drag = Some((event.position.y, jumped));
                        } else {
                            this.scrollbar.drag = Some((event.position.y, extent.top));
                        }
                        cx.notify();
                    })
                    .ok();
                },
            )
            .child(self.drag_listener(window, cx))
            .into_any_element()
    }

    /// While the thumb is held, the pointer drives the scroll wherever it
    /// goes, and letting go ends it.
    fn drag_listener(&self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity().downgrade();
        let bounds = self.scrollbar.bounds.clone();
        let held = self.scrollbar.drag.is_some();
        canvas(
            |_, _, _| (),
            move |_, _, window, _| {
                if !held {
                    return;
                }
                let moved = this.clone();
                let strip = bounds.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                    if !phase.bubble() {
                        return;
                    }
                    let Some(strip) = strip.get() else {
                        return;
                    };
                    moved
                        .update(cx, |this, cx| {
                            let Some((from_y, from_top)) = this.scrollbar.drag else {
                                return;
                            };
                            let extent = this.extent(cx);
                            let top = extent.dragged(
                                from_top,
                                f32::from(event.position.y - from_y),
                                f32::from(strip.size.height),
                            );
                            this.scroll_to(top, window, cx);
                        })
                        .ok();
                });
                let released = this.clone();
                window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                    if !phase.bubble() {
                        return;
                    }
                    released
                        .update(cx, |this, cx| {
                            if this.scrollbar.drag.take().is_some() {
                                cx.notify();
                            }
                        })
                        .ok();
                });
            },
        )
        .absolute()
        .size_0()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extent(top: f64) -> Extent {
        Extent {
            top,
            visible: 40.,
            total: 400.,
        }
    }

    #[test]
    fn the_thumb_is_the_share_in_view_and_travels_the_track() {
        let (top, height) = extent(0.).thumb(408.);
        assert_eq!(top, INSET);
        assert!((height - 40.).abs() < 1e-3, "{height}");
        let (bottom, _) = extent(360.).thumb(408.);
        assert!((bottom + height - (408. - INSET)).abs() < 1e-3);
    }

    #[test]
    fn a_short_share_keeps_the_least_thumb() {
        let long = Extent {
            top: 0.,
            visible: 40.,
            total: 40_000.,
        };
        assert_eq!(long.thumb(408.).1, MIN_THUMB);
    }

    #[test]
    fn dragging_the_whole_travel_scrolls_the_whole_document() {
        let at_top = extent(0.);
        let travel = 408. - INSET * 2. - at_top.thumb(408.).1;
        assert!((at_top.dragged(0., travel, 408.) - 360.).abs() < 1e-6);
        assert_eq!(at_top.dragged(0., -50., 408.), 0.);
    }

    #[test]
    fn text_that_fits_does_not_overflow() {
        let fits = Extent {
            top: 0.,
            visible: 40.,
            total: 30.,
        };
        assert!(!fits.overflows());
        assert_eq!(fits.max_top(), 0.);
    }
}
