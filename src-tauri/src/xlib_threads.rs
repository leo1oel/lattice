//! Make Xlib safe to call from more than one thread, before anything opens a
//! display. Under an X11 session Xlib is reached from more than one thread
//! (the GTK/WebKitGTK stack and the crates beside it), and without this the
//! app aborted during the tutorial's first build with "[xcb] Unknown sequence number while processing queue …
//! XInitThreads has not been called" (caught by scripts/linux-e2e.mjs under
//! Xvfb). Harmless under Wayland, where GTK does not use Xlib.

pub(crate) fn init() {
    #[link(name = "X11")]
    extern "C" {
        fn XInitThreads() -> std::os::raw::c_int;
    }
    // SAFETY: XInitThreads takes no arguments and must only precede every
    // other Xlib call, which holds here: it is the first thing `run` does.
    unsafe {
        XInitThreads();
    }
}
