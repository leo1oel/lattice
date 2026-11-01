//! The macOS title bar's traffic lights: AppKit's compact-toolbar geometry,
//! kept centered on the web titlebar through every AppKit relayout.

use crate::macos_window::ns_window_address;
use block2::RcBlock;
use objc2_app_kit::NSWindow;
use std::ptr::NonNull;
use std::sync::Mutex;
use std::time::Duration;

/// The center AppKit itself gives the buttons in a unified-compact titlebar,
/// which is exactly as tall as the web titlebar (`--titlebar-height: 40px`).
const DEFAULT_TRAFFIC_LIGHT_CENTER_FROM_TOP: f64 = 20.0;
static TRAFFIC_LIGHT_CENTER_FROM_TOP: Mutex<f64> =
    Mutex::new(DEFAULT_TRAFFIC_LIGHT_CENTER_FROM_TOP);
/// Longer than AppKit's full-screen transition, after which a window that is
/// still not in full screen failed to get there.
const FULL_SCREEN_SETTLE: Duration = Duration::from_secs(2);

/// Align the native traffic-light centers with the measured web titlebar.
///
/// The window gets an empty unified-compact toolbar, so AppKit itself lays the
/// titlebar out 40 pt tall with the buttons at the native compact-toolbar
/// position (x 12, centered 20 pt from the top), the same place Finder, Notes
/// or Safari with a compact toolbar put them. That is exactly the web
/// titlebar's center at the default interface scale, so nothing is moved and
/// every AppKit relayout (activation, hover, resize, full screen) lands where
/// it should. Moving the buttons ourselves at 100% fought those relayouts: a
/// pass that caught AppKit halfway through re-spaced and re-leveled them from
/// half-moved frames, and anything missed showed the 32 pt default, 4 pt high.
/// Only a zoomed interface, whose titlebar row is taller or shorter, still
/// shifts them, vertically only.
pub fn install_traffic_light_alignment(window: &tauri::WebviewWindow) {
    install_compact_toolbar(window);
    let _ = measure_traffic_light_alignment(window);
    install_traffic_light_layout_observers(window);

    // AppKit performs a final titlebar layout after the window first appears.
    // Re-read the native frames after that pass instead of assuming the first
    // hierarchy survives unchanged.
    let delayed = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        let _ = measure_traffic_light_alignment(&delayed);
    });
}

/// Give the window the empty compact toolbar that makes AppKit's own titlebar
/// geometry match the web titlebar, and take it away for full screen.
///
/// A toolbar stays on screen in full screen unless the window asks AppKit to
/// auto-hide it, and tao owns the delegate that answers that. Full screen has
/// no traffic lights beside the web titlebar to align anyway, so the window
/// simply goes back to its plain overlay titlebar there, and gets the toolbar
/// back when it leaves full screen or never makes it in. The toolbar is empty
/// and the titlebar transparent: it draws nothing, and hit-testing still hands
/// every click in the row to the web view.
fn install_compact_toolbar(window: &tauri::WebviewWindow) {
    let Some(address) = ns_window_address(window) else {
        return;
    };
    let handle = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        use objc2::rc::Retained;
        use objc2_app_kit::{
            NSWindowDidExitFullScreenNotification, NSWindowStyleMask,
            NSWindowWillEnterFullScreenNotification,
        };
        use objc2_foundation::{NSNotification, NSNotificationCenter};

        attach_compact_toolbar(&*(address as *const NSWindow));
        let center = NSNotificationCenter::defaultCenter();
        let window = &*(address as *const NSWindow);
        let on_enter = RcBlock::new(move |notification: NonNull<NSNotification>| {
            if let Some(object) = notification.as_ref().object() {
                (*(Retained::as_ptr(&object) as *const NSWindow)).setToolbar(None);
            }
            // A failed entry posts no notification (only tao's window delegate
            // hears it) and leaves the window windowed without its toolbar.
            // The full-screen style bit is set for the whole transition, so a
            // window without it once the transition is over never got there.
            // Attaching the toolbar re-lays the titlebar out, which realigns
            // the lights of a window that has alignment observers.
            let handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(FULL_SCREEN_SETTLE);
                let Some(address) = ns_window_address(&handle) else {
                    return;
                };
                let _ = handle.run_on_main_thread(move || {
                    let window = &*(address as *const NSWindow);
                    if !window.styleMask().contains(NSWindowStyleMask::FullScreen) {
                        attach_compact_toolbar(window);
                    }
                });
            });
        });
        // Registered before the alignment observers, which realign after it.
        let on_exit = RcBlock::new(|notification: NonNull<NSNotification>| {
            if let Some(object) = notification.as_ref().object() {
                attach_compact_toolbar(&*(Retained::as_ptr(&object) as *const NSWindow));
            }
        });
        for (name, block) in [
            (NSWindowWillEnterFullScreenNotification, &on_enter),
            (NSWindowDidExitFullScreenNotification, &on_exit),
        ] {
            std::mem::forget(center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(window),
                None,
                block,
            ));
        }
    });
}

unsafe fn attach_compact_toolbar(window: &NSWindow) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSToolbar, NSWindowToolbarStyle};

    if window.toolbar().is_some() {
        return;
    }
    let toolbar = NSToolbar::new(MainThreadMarker::new_unchecked());
    window.setToolbar(Some(&toolbar));
    window.setToolbarStyle(NSWindowToolbarStyle::UnifiedCompact);
}

/// Re-apply the alignment from inside AppKit's own layout passes.
///
/// Positioning the buttons is a one-shot write that the next titlebar layout
/// undoes, and a live resize runs that layout on every frame of the drag. A
/// realign driven from the web side can only run after the gesture settles, so
/// the buttons sat visibly at their default top-left corner for as long as the
/// user held the mouse and jumped back on release. These observers fire on the
/// main thread as part of the same pass that displaced them, which is early
/// enough that the default position is never presented.
fn install_traffic_light_layout_observers(window: &tauri::WebviewWindow) {
    let Some(address) = ns_window_address(window) else {
        return;
    };
    let _ = window.run_on_main_thread(move || unsafe {
        use objc2::rc::Retained;
        use objc2_app_kit::{
            NSView, NSViewFrameDidChangeNotification, NSWindowButton,
            NSWindowDidBecomeKeyNotification, NSWindowDidChangeBackingPropertiesNotification,
            NSWindowDidExitFullScreenNotification, NSWindowDidResignKeyNotification,
            NSWindowDidResizeNotification,
        };
        use objc2_foundation::{NSNotification, NSNotificationCenter};

        let window = &*(address as *const NSWindow);
        let center = NSNotificationCenter::defaultCenter();

        // Each block reads its subject back out of the notification instead of
        // capturing a pointer: the observers are never removed, so a captured
        // window could outlive the object it points at.
        let on_resize = RcBlock::new(move |notification: NonNull<NSNotification>| {
            if let Some(object) = notification.as_ref().object() {
                let _ =
                    align_traffic_lights_on_main(&*(Retained::as_ptr(&object) as *const NSWindow));
            }
        });
        // Resizing is not the only titlebar layout: becoming or resigning key,
        // leaving full screen and a backing-scale change each re-lay the
        // buttons out at AppKit's default position without any resize.
        for name in [
            NSWindowDidResizeNotification,
            NSWindowDidBecomeKeyNotification,
            NSWindowDidResignKeyNotification,
            NSWindowDidExitFullScreenNotification,
            NSWindowDidChangeBackingPropertiesNotification,
        ] {
            std::mem::forget(center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(window),
                None,
                &on_resize,
            ));
        }

        // The window notification alone leaves a race: AppKit may lay the
        // titlebar out after posting it. The container's own frame change is
        // posted by that layout, so it is the pass that would otherwise win.
        // Moving the buttons cannot re-enter here — a subview's origin does not
        // change its superview's frame.
        let Some(superview) = window
            .standardWindowButton(NSWindowButton::CloseButton)
            .and_then(|button| button.superview())
        else {
            return;
        };
        let on_layout = RcBlock::new(move |notification: NonNull<NSNotification>| {
            let Some(object) = notification.as_ref().object() else {
                return;
            };
            let view = &*(Retained::as_ptr(&object) as *const NSView);
            if let Some(window) = view.window() {
                let _ = align_traffic_lights_on_main(&window);
            }
        });
        std::mem::forget(center.addObserverForName_object_queue_usingBlock(
            Some(NSViewFrameDidChangeNotification),
            Some(&superview),
            None,
            &on_layout,
        ));

        // AppKit can also move a button back without touching its container
        // (the titlebar re-lays itself out on activation and hover on recent
        // macOS). Each button's own frame change catches that; the alignment
        // skips buttons already in place and ignores its own writes, so this
        // cannot loop.
        let on_button = RcBlock::new(move |notification: NonNull<NSNotification>| {
            let Some(object) = notification.as_ref().object() else {
                return;
            };
            let view = &*(Retained::as_ptr(&object) as *const NSView);
            if let Some(window) = view.window() {
                let _ = align_traffic_lights_on_main(&window);
            }
        });
        for kind in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            if let Some(button) = window.standardWindowButton(kind) {
                button.setPostsFrameChangedNotifications(true);
                std::mem::forget(center.addObserverForName_object_queue_usingBlock(
                    Some(NSViewFrameDidChangeNotification),
                    Some(&button),
                    None,
                    &on_button,
                ));
            }
        }
    });
}

thread_local! {
    /// Set while the alignment moves the buttons, so the frame-change
    /// notifications those moves post do not re-enter it.
    static ALIGNING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Apply a web-measured vertical center in AppKit logical points.
///
/// Returns the zoom (green) button's right edge in window logical points so the
/// web titlebar can center chrome between that edge and the project switcher.
pub fn align_traffic_lights_to(window: &tauri::WebviewWindow, center_from_top: f64) -> Option<f64> {
    if !center_from_top.is_finite() || center_from_top < 0.0 {
        return None;
    }
    if let Ok(mut target) = TRAFFIC_LIGHT_CENTER_FROM_TOP.lock() {
        *target = center_from_top;
    }
    measure_traffic_light_alignment(window)
}

fn measure_traffic_light_alignment(window: &tauri::WebviewWindow) -> Option<f64> {
    let address = ns_window_address(window)?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let _ = window.run_on_main_thread(move || {
        let right = unsafe { align_traffic_lights_on_main(&*(address as *const NSWindow)) };
        let _ = tx.send(right);
    });
    rx.recv_timeout(Duration::from_millis(500)).ok().flatten()
}

unsafe fn align_traffic_lights_on_main(window: &NSWindow) -> Option<f64> {
    if ALIGNING.with(|flag| flag.replace(true)) {
        return None;
    }
    let right = align_traffic_light_buttons(window);
    ALIGNING.with(|flag| flag.set(false));
    right
}

unsafe fn align_traffic_light_buttons(window: &NSWindow) -> Option<f64> {
    use objc2_app_kit::{NSView, NSWindowButton, NSWindowStyleMask};
    use objc2_foundation::NSPoint;

    let close = window.standardWindowButton(NSWindowButton::CloseButton)?;
    let miniaturize = window.standardWindowButton(NSWindowButton::MiniaturizeButton)?;
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton)?;
    let button_superview = close.superview()?;
    // Full screen (its transitions included) moves the buttons into AppKit's
    // own title bar, a separate window that slides in with the menu bar, so
    // they are not beside the web titlebar and AppKit's layout of that bar is
    // the right one. The center below is measured from this window's top
    // edge, the screen's top there: aligning to it put the close and minimize
    // buttons 36 pt below AppKit's spot, out of that bar and over the web
    // titlebar's left end, and left the green one behind.
    let fullscreen = window.styleMask().contains(NSWindowStyleMask::FullScreen)
        || close.window().is_some_and(|host| !std::ptr::eq(&*host, window));
    if fullscreen {
        return None;
    }

    let center_from_top = TRAFFIC_LIGHT_CENTER_FROM_TOP
        .lock()
        .map_or(DEFAULT_TRAFFIC_LIGHT_CENTER_FROM_TOP, |target| *target);
    let center_y_in_window = window.frame().size.height - center_from_top;

    // Vertical only: AppKit's x positions and spacing are the native ones, and
    // each button is corrected from its own frame, so a pass that runs while
    // AppKit is mid-layout cannot copy one button's stale spacing onto another.
    for button in [close, miniaturize, zoom.clone()] {
        let frame = NSView::frame(&button);
        let current = button_superview.convertPoint_toView(
            NSPoint::new(frame.origin.x, frame.origin.y + frame.size.height / 2.0),
            None,
        );
        let desired = button_superview
            .convertPoint_fromView(NSPoint::new(current.x, center_y_in_window), None);
        let origin_y = desired.y - frame.size.height / 2.0;
        if (frame.origin.y - origin_y).abs() > 0.01 {
            button.setFrameOrigin(NSPoint::new(frame.origin.x, origin_y));
        }
    }

    // Read the laid-out green button back in window coordinates.
    let zoom_in_window = button_superview.convertRect_toView(NSView::frame(&zoom), None);
    Some(zoom_in_window.origin.x + zoom_in_window.size.width)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    #[test]
    fn macos_window_uses_runtime_traffic_light_geometry() {
        let config: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        assert_eq!(config["app"]["macOSPrivateApi"], true);
        let window = &config["app"]["windows"][0];
        assert!(window.get("trafficLightPosition").is_none());
        assert_eq!(window["backgroundColor"], "#F7F7F6");
        for (source, expected) in [
            (include_str!("../../src/app/use-native-window.ts"), "align_traffic_lights"),
            (include_str!("../../src/app/use-native-window.ts"), "--titlebar-traffic-space-width"),
            (include_str!("../../src/App.css"), "./styles/app-shell.css"),
            (include_str!("../../src/styles/app-shell.css"), ".titlebar {"),
            (include_str!("../../src/styles/app-shell.css"), "height: var(--titlebar-height)"),
            (include_str!("../../src/styles/app-shell.css"), "align-items: center"),
            (include_str!("../../src/styles/app-shell.css"), ".traffic-space"),
            (include_str!("../../src/styles/foundations.css"), "--titlebar-height: 40px"),
            (include_str!("../../src/styles/foundations.css"), "--titlebar-traffic-space-width"),
        ] {
            assert!(source.contains(expected), "{expected}");
        }
        assert!(
            include_str!("../Cargo.toml").contains("\"macos-private-api\""),
            "the macOS WebView must disable its opaque white backing surface"
        );
        // The main and project windows (`workspace_window`) take the
        // activation click from `overlay_title_bar`.
        let lib = include_str!("lib.rs");
        assert_eq!(lib.matches(".accept_first_mouse(true)").count(), 1);
        assert!(lib.contains("let window = overlay_title_bar(builder).build()?;"));
    }
}
