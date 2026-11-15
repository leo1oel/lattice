//! Keeps a restored workspace window where the writer can reach it.
//!
//! The window-state plugin puts a project window back where it was last
//! closed, but it only checks that one of the saved frame's four corners lies
//! on an attached screen. A frame saved on a second screen that is gone can
//! still have a corner on the remaining one (a window 1920 wide saved at
//! x = 2552 has its bottom-left corner 8 pixels inside a 2560-pixel screen),
//! so the plugin moves the window there and only a sliver of it shows.
//! `keep_reachable` runs after the plugin has restored the window and moves a
//! window whose title bar cannot be grabbed to the middle of the main screen.

use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

/// The title bar's height, in points: what must stay on a screen to be grabbed.
const TITLE_BAR: f64 = 28.0;
/// How much of the title bar's width must stay on one screen, in points.
const GRIP: f64 = 64.0;

/// A frame in physical pixels: the window's outer top-left corner and its
/// content size, as Tauri reports and sets them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rect {
    pub(crate) x: i64,
    pub(crate) y: i64,
    pub(crate) width: i64,
    pub(crate) height: i64,
}

/// Where `window` must move so its title bar can be grabbed, or None when it
/// already can. `screens` lists the main screen first: an unreachable window
/// goes there, centred, with its size kept within the screen.
pub(crate) fn correction(window: Rect, screens: &[Rect], scale: f64) -> Option<Rect> {
    let bar = (TITLE_BAR * scale).round() as i64;
    let grip = (GRIP * scale).round() as i64;
    let reachable = screens.iter().any(|screen| {
        let across =
            (window.x + window.width).min(screen.x + screen.width) - window.x.max(screen.x);
        let down = (window.y + bar).min(screen.y + screen.height) - window.y.max(screen.y);
        across >= grip && down >= bar / 2
    });
    if reachable {
        return None;
    }
    let screen = screens.first()?;
    let width = window.width.min(screen.width);
    let height = window.height.min(screen.height);
    Some(Rect {
        x: screen.x + (screen.width - width) / 2,
        y: screen.y + (screen.height - height) / 2,
        width,
        height,
    })
}

/// Moves `window` onto the main screen when the plugin restored it where its
/// title bar is out of reach. A maximized window follows its screen and is
/// left alone, as is one whose geometry or screens cannot be read.
pub(crate) fn keep_reachable<R: Runtime>(window: &WebviewWindow<R>) {
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size), Ok(monitors)) =
        (window.outer_position(), window.inner_size(), window.available_monitors())
    else {
        return;
    };
    let main = window.primary_monitor().ok().flatten();
    let mut screens: Vec<(bool, Rect)> = monitors
        .iter()
        .map(|monitor| {
            let is_main = main.as_ref().is_some_and(|main| main.position() == monitor.position());
            let rect = Rect {
                x: i64::from(monitor.position().x),
                y: i64::from(monitor.position().y),
                width: i64::from(monitor.size().width),
                height: i64::from(monitor.size().height),
            };
            (is_main, rect)
        })
        .collect();
    screens.sort_by_key(|(is_main, _)| !is_main);
    let screens: Vec<Rect> = screens.into_iter().map(|(_, rect)| rect).collect();
    let frame = Rect {
        x: i64::from(position.x),
        y: i64::from(position.y),
        width: i64::from(size.width),
        height: i64::from(size.height),
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let Some(target) = correction(frame, &screens, scale) else {
        return;
    };
    tracing::info!(
        label = window.label(),
        from_x = frame.x,
        from_y = frame.y,
        to_x = target.x,
        to_y = target.y,
        "a restored window was off every screen; moved it to the main screen"
    );
    let _ = window.set_size(PhysicalSize::new(target.width as u32, target.height as u32));
    let _ = window.set_position(PhysicalPosition::new(target.x as i32, target.y as i32));
}

#[cfg(test)]
mod tests {
    use super::{correction, Rect};

    fn rect(x: i64, y: i64, width: i64, height: i64) -> Rect {
        Rect { x, y, width, height }
    }

    const MAIN: Rect = Rect { x: 0, y: 0, width: 2560, height: 1600 };

    #[test]
    fn a_window_saved_on_a_screen_that_is_gone_moves_to_the_main_screen() {
        // The case from a real saved state: 1920 wide at x = 2552, so one
        // corner sits 8 pixels inside the 2560-pixel main screen.
        let saved = rect(2552, -8, 1920, 1009);
        assert_eq!(correction(saved, &[MAIN], 1.5), Some(rect(320, 295, 1920, 1009)));
    }

    #[test]
    fn a_window_whose_title_bar_is_on_a_screen_stays() {
        assert_eq!(correction(rect(100, 80, 1440, 900), &[MAIN], 1.5), None);
        // Partly off the left edge and larger than the screen, but grabbable.
        assert_eq!(correction(rect(-184, 59, 2560, 1494), &[MAIN], 1.5), None);
    }

    #[test]
    fn a_window_on_an_attached_second_screen_stays() {
        let second = rect(2560, 0, 1920, 1080);
        assert_eq!(correction(rect(2700, 100, 1200, 800), &[MAIN, second], 1.0), None);
    }

    #[test]
    fn a_window_below_every_screen_moves_and_shrinks_to_fit() {
        let saved = rect(100, 5000, 3000, 2000);
        assert_eq!(correction(saved, &[MAIN], 1.0), Some(rect(0, 0, 2560, 1600)));
    }

    #[test]
    fn without_a_screen_nothing_moves() {
        assert_eq!(correction(rect(5000, 0, 800, 600), &[], 1.0), None);
    }
}
