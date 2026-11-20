//! Make Xlib safe to call from more than one thread, before anything opens a
//! display. Under an X11 session Xlib is reached from more than one thread
//! (the GTK/WebKitGTK stack and the crates beside it), and without this the
//! app aborted during the tutorial's first build with "[xcb] Unknown sequence number while processing queue …
//! XInitThreads has not been called" (caught by scripts/linux-e2e.mjs under
//! Xvfb). Harmless under Wayland, where GTK does not use Xlib.
//!
//! A headless browser host (`--browser-host --headless`) also checks here,
//! before GTK starts, that it has a display to open.

use std::os::raw::{c_char, c_int, c_void};

#[link(name = "X11")]
extern "C" {
    fn XInitThreads() -> c_int;
    fn XOpenDisplay(name: *const c_char) -> *mut c_void;
    fn XCloseDisplay(display: *mut c_void) -> c_int;
}

pub(crate) fn init() {
    // SAFETY: XInitThreads takes no arguments and must only precede every
    // other Xlib call, which holds here: it is the first thing `run` does.
    unsafe {
        XInitThreads();
    }
    if crate::browser_host::launched_headless() {
        require_display();
    }
}

/// A headless browser host still opens GTK windows, hidden ones, so it needs
/// a display. Without one GTK aborts before the logger exists, and the
/// process exits with status 101 and says nothing; say what is missing.
fn require_display() {
    // GTK uses Wayland when it has a compositor, and Xlib is not involved.
    if std::env::var_os("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty()) {
        return;
    }
    // SAFETY: a null name opens `$DISPLAY`; a non-null result is a display
    // nothing else holds, closed again at once.
    let opened = unsafe {
        let display = XOpenDisplay(std::ptr::null());
        if !display.is_null() {
            XCloseDisplay(display);
        }
        !display.is_null()
    };
    if !opened {
        eprintln!("{}", crate::browser_host::missing_display_message(std::env::var_os("DISPLAY")));
        std::process::exit(1);
    }
}
