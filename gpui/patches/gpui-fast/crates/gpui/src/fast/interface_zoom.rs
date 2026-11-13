//! Interface zoom: a webview's page zoom for a whole window. At zoom `z`
//! every logical pixel the app lays out is drawn `z` device pixels per
//! platform point (times the display's own scale), and the window lays out
//! in `1 / z` of its points, so the interface reflows at the larger size
//! instead of being magnified past the window's edges. Text and paths are
//! rasterized at the zoomed scale, so they stay crisp.
//!
//! The window keeps the platform's measurements and its own apart: the
//! platform reports points (content size, pointer positions, scroll deltas)
//! and takes points (an input method's caret rectangle, the window menu's
//! position), and the app sees the window's zoomed pixels. Conversions are
//! made where the two meet: [`unzoomed_input`] on every event the platform
//! delivers, [`zoomed_bounds`] and [`unzoomed_point`] on the input handler's
//! answers and questions, and [`Window::set_interface_zoom`] for the
//! window's own size, scale and pointer.
//!
//! A pixel delta scrolls the same distance under the finger as it would at
//! 100%, as a browser's page zoom does; a line delta is left in lines.

use crate::{
    App, Bounds, FileDropEvent, PlatformInput, Pixels, Point, ScrollDelta, Size, Window,
};

/// The smallest and largest zoom a window takes.
const RANGE: (f32, f32) = (0.25, 4.);

/// `point` in points, as the window's zoomed pixels.
pub(crate) fn unzoomed_point(point: Point<Pixels>, zoom: f32) -> Point<Pixels> {
    if zoom == 1. {
        return point;
    }
    Point {
        x: point.x / zoom,
        y: point.y / zoom,
    }
}

/// `size` in points, as the window's zoomed pixels.
pub(crate) fn unzoomed_size(size: Size<Pixels>, zoom: f32) -> Size<Pixels> {
    if zoom == 1. {
        return size;
    }
    Size {
        width: size.width / zoom,
        height: size.height / zoom,
    }
}

/// `point` in the window's zoomed pixels, as points.
pub(crate) fn zoomed_point(point: Point<Pixels>, zoom: f32) -> Point<Pixels> {
    if zoom == 1. {
        return point;
    }
    Point {
        x: point.x * zoom,
        y: point.y * zoom,
    }
}

/// `bounds` in points, as the window's zoomed pixels.
pub(crate) fn unzoomed_bounds(bounds: Bounds<Pixels>, zoom: f32) -> Bounds<Pixels> {
    if zoom == 1. {
        return bounds;
    }
    Bounds {
        origin: unzoomed_point(bounds.origin, zoom),
        size: unzoomed_size(bounds.size, zoom),
    }
}

/// `bounds` in the window's zoomed pixels, as points.
pub(crate) fn zoomed_bounds(bounds: Bounds<Pixels>, zoom: f32) -> Bounds<Pixels> {
    if zoom == 1. {
        return bounds;
    }
    Bounds {
        origin: zoomed_point(bounds.origin, zoom),
        size: Size {
            width: bounds.size.width * zoom,
            height: bounds.size.height * zoom,
        },
    }
}

/// A platform event, its positions (and pixel scroll deltas) in points,
/// with them in the window's zoomed pixels.
pub(crate) fn unzoomed_input(event: PlatformInput, zoom: f32) -> PlatformInput {
    if zoom == 1. {
        return event;
    }
    let at = |point| unzoomed_point(point, zoom);
    match event {
        PlatformInput::MouseMove(mut event) => {
            event.position = at(event.position);
            PlatformInput::MouseMove(event)
        }
        PlatformInput::MouseDown(mut event) => {
            event.position = at(event.position);
            PlatformInput::MouseDown(event)
        }
        PlatformInput::MouseUp(mut event) => {
            event.position = at(event.position);
            PlatformInput::MouseUp(event)
        }
        PlatformInput::MousePressure(mut event) => {
            event.position = at(event.position);
            PlatformInput::MousePressure(event)
        }
        PlatformInput::MouseExited(mut event) => {
            event.position = at(event.position);
            PlatformInput::MouseExited(event)
        }
        PlatformInput::Scroll(mut event) => {
            event.position = at(event.position);
            if let ScrollDelta::Pixels(delta) = event.delta {
                event.delta = ScrollDelta::Pixels(at(delta));
            }
            PlatformInput::Scroll(event)
        }
        PlatformInput::Pinch(mut event) => {
            event.position = at(event.position);
            PlatformInput::Pinch(event)
        }
        PlatformInput::FileDrop(drop) => PlatformInput::FileDrop(match drop {
            FileDropEvent::Entered { position, paths } => FileDropEvent::Entered {
                position: at(position),
                paths,
            },
            FileDropEvent::Pending { position } => FileDropEvent::Pending {
                position: at(position),
            },
            FileDropEvent::Submit { position } => FileDropEvent::Submit {
                position: at(position),
            },
            other => other,
        }),
        other => other,
    }
}

impl Window {
    /// The window's interface zoom: 1 unless the app set one.
    pub fn interface_zoom(&self) -> f32 {
        self.fast_interface_zoom
    }

    /// Lay the window out and draw it at `zoom` (clamped to 0.25–4), as a
    /// webview's page zoom does: the interface is `zoom` times as large and
    /// reflows into the window's size divided by `zoom`. The viewport, the
    /// scale factor and the pointer change at once and bounds observers are
    /// told, as after a resize.
    pub fn set_interface_zoom(&mut self, zoom: f32, cx: &mut App) {
        let zoom = if zoom.is_finite() {
            zoom.clamp(RANGE.0, RANGE.1)
        } else {
            1.
        };
        if zoom == self.fast_interface_zoom {
            return;
        }
        self.fast_interface_zoom = zoom;
        self.bounds_changed(cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Modifiers, MouseButton, MouseDownEvent, ScrollWheelEvent, TestAppContext, TouchPhase,
        bounds, point, px, size,
    };

    #[test]
    fn events_arrive_in_the_windows_zoomed_pixels() {
        let down = PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Left,
            position: point(px(300.), px(150.)),
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        });
        let PlatformInput::MouseDown(down) = unzoomed_input(down, 1.5) else {
            panic!("not a mouse down");
        };
        assert_eq!(down.position, point(px(200.), px(100.)));

        // A pixel delta scrolls the same distance under the finger; a line
        // delta stays in lines.
        let scroll = |delta| {
            PlatformInput::Scroll(ScrollWheelEvent {
                position: point(px(60.), px(30.)),
                delta,
                touch_phase: TouchPhase::Moved,
                ..Default::default()
            })
        };
        let PlatformInput::Scroll(pixels) =
            unzoomed_input(scroll(ScrollDelta::Pixels(point(px(0.), px(-24.)))), 2.)
        else {
            panic!("not a scroll");
        };
        assert_eq!(pixels.position, point(px(30.), px(15.)));
        assert!(
            matches!(pixels.delta, ScrollDelta::Pixels(delta) if delta == point(px(0.), px(-12.)))
        );
        let PlatformInput::Scroll(lines) =
            unzoomed_input(scroll(ScrollDelta::Lines(point(0., -3.))), 2.)
        else {
            panic!("not a scroll");
        };
        assert!(matches!(lines.delta, ScrollDelta::Lines(delta) if delta == point(0., -3.)));
    }

    #[test]
    fn what_the_platform_is_told_is_in_points() {
        let caret = bounds(point(px(100.), px(40.)), size(px(2.), px(16.)));
        assert_eq!(
            zoomed_bounds(caret, 1.25),
            bounds(point(px(125.), px(50.)), size(px(2.5), px(20.)))
        );
        assert_eq!(unzoomed_bounds(zoomed_bounds(caret, 1.25), 1.25), caret);
        assert_eq!(zoomed_point(point(px(8.), px(4.)), 1.), point(px(8.), px(4.)));
    }

    #[gpui::test]
    fn a_zoomed_window_lays_out_in_its_size_over_the_zoom(cx: &mut TestAppContext) {
        let window = cx.add_empty_window();
        let (viewport, scale) = window.update(|window, _| (window.viewport_size(), window.scale_factor()));
        window.update(|window, cx| window.set_interface_zoom(1.25, cx));
        window.update(|window, _| {
            assert_eq!(window.interface_zoom(), 1.25);
            assert_eq!(window.scale_factor(), scale * 1.25);
            assert_eq!(window.viewport_size(), unzoomed_size(viewport, 1.25));
        });
        // Out of range, or not a number: clamped, or back to 1.
        window.update(|window, cx| window.set_interface_zoom(9., cx));
        window.update(|window, _| assert_eq!(window.interface_zoom(), 4.));
        window.update(|window, cx| window.set_interface_zoom(f32::NAN, cx));
        window.update(|window, _| {
            assert_eq!(window.interface_zoom(), 1.);
            assert_eq!(window.viewport_size(), viewport);
        });
    }
}
