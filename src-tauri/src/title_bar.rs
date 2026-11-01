//! What a double-click on the web title bar does.
//!
//! The title bar is web content over a transparent native one, so AppKit
//! never sees the double-click and the page has to ask for the native action.
//! macOS lets the user choose it under Desktop & Dock ▸ "Double-click a
//! window's title bar to", and every native app follows that choice: fill or
//! zoom, minimize, or nothing. Full screen is never one of them; only the
//! green button (or View ▸ Enter Full Screen) goes there.

use crate::macos_window::ns_window_address;

/// The `NSGlobalDomain` key System Settings writes for that choice.
const ACTION_ON_DOUBLE_CLICK: &str = "AppleActionOnDoubleClick";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DoubleClickAction {
    /// Toggle between the filled (zoomed) frame and the user's own frame.
    Zoom,
    Minimize,
    Nothing,
}

/// The action for a value of `AppleActionOnDoubleClick`. "Maximize" is the
/// Zoom choice and "Fill" the Fill choice macOS 15 added beside it; both fill
/// the screen's visible area and toggle back, which is what `zoom:` does for a
/// window that does not define its own standard frame. A missing key is the
/// macOS default, Zoom, and so is a value a later macOS might add.
fn action_for(setting: Option<&str>) -> DoubleClickAction {
    match setting {
        Some("Minimize") => DoubleClickAction::Minimize,
        Some("None") => DoubleClickAction::Nothing,
        _ => DoubleClickAction::Zoom,
    }
}

/// Run the user's title-bar double-click action on `window`.
///
/// Read on every double-click rather than once, so a change in System
/// Settings applies without relaunching, as it does in native apps.
pub fn perform_double_click(window: &tauri::WebviewWindow) {
    let Some(address) = ns_window_address(window) else {
        return;
    };
    let _ = window.run_on_main_thread(move || unsafe {
        use objc2_app_kit::{NSWindow, NSWindowStyleMask};
        use objc2_foundation::{NSString, NSUserDefaults};

        let window = &*(address as *const NSWindow);
        // A full-screen window can neither zoom nor minimize; AppKit ignores a
        // double-click on its revealed title bar too.
        if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
            return;
        }
        let setting = NSUserDefaults::standardUserDefaults()
            .stringForKey(&NSString::from_str(ACTION_ON_DOUBLE_CLICK))
            .map(|value| value.to_string());
        match action_for(setting.as_deref()) {
            DoubleClickAction::Zoom => window.zoom(None),
            DoubleClickAction::Minimize => window.miniaturize(None),
            DoubleClickAction::Nothing => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{action_for, DoubleClickAction};

    #[test]
    fn the_double_click_action_follows_the_system_setting() {
        for (setting, action) in [
            (None, DoubleClickAction::Zoom),
            (Some("Maximize"), DoubleClickAction::Zoom),
            (Some("Fill"), DoubleClickAction::Zoom),
            (Some("Minimize"), DoubleClickAction::Minimize),
            (Some("None"), DoubleClickAction::Nothing),
            (Some("SomethingNew"), DoubleClickAction::Zoom),
        ] {
            assert_eq!(action_for(setting), action, "{setting:?}");
        }
    }
}
