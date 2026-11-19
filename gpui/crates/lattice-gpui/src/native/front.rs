//! Bringing the run's app and window to the front of the machine and
//! handing the front back (`scenario/input_lock.rs`).

use objc2::{
    class, msg_send,
    runtime::{AnyObject, Bool},
};

use super::Native;

/// Put the window in front of everything and make it key, so macOS neither
/// occludes it (which stops its display link) nor GPUI throttles it as an
/// inactive window while a scenario measures it. Lattice's lab does the same
/// for WebKit with `LATTICE_WK_NOOCC`.
pub fn bring_to_front(native: Native) {
    const FLOATING_WINDOW_LEVEL: isize = 3;
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, activateIgnoringOtherApps: Bool::YES];
        let _: () = msg_send![native.window, setLevel: FLOATING_WINDOW_LEVEL];
        let _: () = msg_send![native.window, orderFrontRegardless];
        let _: () = msg_send![native.window, makeKeyWindow];
    }
}

/// Whether `native`'s window is AppKit's key window of the active app,
/// making it key once the app is active: `bring_to_front`'s
/// `makeKeyWindow` is lost when it runs before activation lands, and under
/// `GPUI_LAB_ASSUME_KEY` GPUI reports every window active, so only AppKit
/// tells whether the keyboard and the input method reach this one.
pub fn window_is_key(native: Native) -> bool {
    unsafe {
        let key: Bool = msg_send![native.window, isKeyWindow];
        if !key.as_bool() && app_is_active() {
            let _: () = msg_send![native.window, makeKeyWindow];
        }
        key.as_bool()
    }
}

/// Whether this app is the active one, whose key window takes the keyboard.
pub fn app_is_active() -> bool {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let active: Bool = msg_send![app, isActive];
        active.as_bool()
    }
}

/// Hand activation back to the app that had it, so this one runs in the
/// background, its windows no longer key (`scenario/input_lock.rs`).
pub fn deactivate_app() {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, deactivate];
    }
}
