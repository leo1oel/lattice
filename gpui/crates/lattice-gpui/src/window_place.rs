//! Where a window comes back: on the display it was left on, found by the
//! UUID that names it across launches (the main one when that display is
//! gone), and only when enough of it still shows there to grab. The
//! workspace's windows (`shell::windows`) and the windows of their own the
//! PDF and the Agent open (`pdf::window`, `agent::window`) share it.

use std::{cell::Cell, rc::Rc, time::Duration};

use gpui::{
    App, Bounds, Context, DisplayId, Pixels, PlatformDisplay, Size, Subscription, Window,
    WindowBounds, point, px, size,
};

use crate::pdf::preferences::WindowFrame;

/// How long a moved or resized window of its own rests before its place is
/// kept, so a drag writes once.
const SETTLE: Duration = Duration::from_millis(500);

/// The display named `uuid`, else the main one.
pub(crate) fn display_named(uuid: Option<&str>, cx: &App) -> Option<Rc<dyn PlatformDisplay>> {
    uuid.and_then(|uuid| {
        cx.displays()
            .into_iter()
            .find(|display| display.uuid().is_ok_and(|id| id.to_string() == uuid))
    })
    .or_else(|| cx.primary_display())
}

/// The UUID of the display `window` is on.
pub(crate) fn display_of(window: &Window, cx: &App) -> Option<String> {
    window
        .display(cx)
        .and_then(|display| display.uuid().ok())
        .map(|uuid| uuid.to_string())
}

/// Whether enough of `bounds` shows on `screen` to grab it, both from the
/// screen's top left: a display rearranged or swapped since can leave a
/// place nobody could reach.
pub(crate) fn reaches(bounds: Bounds<Pixels>, screen: Bounds<Pixels>) -> bool {
    let overlap = screen.intersect(&bounds);
    f32::from(overlap.size.width) >= 100. && f32::from(overlap.size.height) >= 40.
}

/// Where a window of its own left at `frame` opens again, never smaller than
/// `min`: on the display it was on, when enough of it shows there. `None`
/// leaves it to open at its default place.
pub(crate) fn reopen(
    frame: &WindowFrame,
    min: Size<Pixels>,
    cx: &App,
) -> Option<(Bounds<Pixels>, DisplayId)> {
    let bounds = Bounds {
        origin: point(px(frame.x), px(frame.y)),
        size: size(
            px(frame.width.max(f32::from(min.width))),
            px(frame.height.max(f32::from(min.height))),
        ),
    };
    let display = display_named(frame.display.as_deref(), cx)?;
    reaches(bounds, display.bounds()).then(|| (bounds, display.id()))
}

/// Where `window` is now, as a window of its own keeps it: its corner on its
/// display, the size it shows (its bounds would add the title bar each time
/// it opens again), and the display. `None` while it is not a plain window
/// (full screen, zoomed), whose content is the screen's size, not its own.
pub(crate) fn frame_of(window: &Window, cx: &App) -> Option<WindowFrame> {
    let WindowBounds::Windowed(bounds) = window.window_bounds() else {
        return None;
    };
    let origin = bounds.origin;
    let shown = window.viewport_size();
    Some(WindowFrame {
        x: f32::from(origin.x),
        y: f32::from(origin.y),
        width: f32::from(shown.width),
        height: f32::from(shown.height),
        display: display_of(window, cx),
    })
}

/// Hand `keep` where `window` is each time it comes to rest after a move or
/// a resize, so a window the app does not close (a crash, a power cut) is
/// still found where it was left.
pub(crate) fn keep_placed<T: 'static>(
    window: &mut Window,
    cx: &mut Context<T>,
    keep: impl Fn(WindowFrame) + 'static,
) -> Subscription {
    let moves = Rc::new(Cell::new(0_u64));
    let keep = Rc::new(keep);
    cx.observe_window_bounds(window, move |_, window, cx| {
        let this_move = moves.get() + 1;
        moves.set(this_move);
        let Some(frame) = frame_of(window, cx) else {
            return;
        };
        let (moves, keep) = (moves.clone(), keep.clone());
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SETTLE).await;
            if this.upgrade().is_some() && moves.get() == this_move {
                keep(frame);
            }
        })
        .detach();
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_place_counts_only_when_enough_of_it_shows_on_its_display() {
        // A 1440×900 display, its own top left at the origin, as GPUI gives
        // a display's bounds and the window's on it.
        let screen = Bounds {
            origin: point(px(0.), px(0.)),
            size: size(px(1440.), px(900.)),
        };
        let at = |x: f32, y: f32| Bounds {
            origin: point(px(x), px(y)),
            size: size(px(1200.), px(800.)),
        };
        assert!(reaches(at(100., 100.), screen));
        // 100×40 left on screen is still a titlebar to grab; less is not.
        assert!(reaches(at(1340., 860.), screen));
        assert!(!reaches(at(1341., 100.), screen));
        assert!(!reaches(at(100., 861.), screen));
        // Left of a display that is no longer there.
        assert!(!reaches(at(-2000., 100.), screen));
    }

    #[test]
    fn a_frame_kept_before_displays_were_named_still_reads() {
        let older: WindowFrame =
            serde_json::from_str(r#"{"x":1,"y":2,"width":480,"height":760}"#).unwrap();
        assert_eq!(older.display, None);
        assert_eq!(older.width, 480.);
    }
}
