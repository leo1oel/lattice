//! Handing a web address to the system, and hearing back whether it took
//! it: the Tauri app's opener plugin (`openUrl(...)` rejects when the
//! system could not open the link, and Papers says so with "Could not open
//! the article in your browser"). GPUI's `cx.open_url` reports nothing, so
//! the links whose failure the writer is told about open through here.
//!
//! On macOS that is `-[NSWorkspace openURL:]`, which answers whether a
//! handler took the address (no browser for the scheme, a malformed
//! address); elsewhere GPUI's opener, which cannot say.
//!
//! The scripted checks never reach a real browser: they put a stand-in in
//! the system's place ([`stand_in`]) that answers as they choose and keeps
//! the addresses it was handed.

use std::rc::Rc;

use gpui::{App, Global};

type Open = Rc<dyn Fn(&str) -> Result<(), String>>;

/// What opens addresses in the system's place, while one is installed.
struct StandIn(Open);

impl Global for StandIn {}

/// Open `url` with the system's handler for it; `Err` with why when the
/// system did not take it.
pub fn open_url(url: &str, cx: &mut App) -> Result<(), String> {
    if let Some(stand_in) = cx.try_global::<StandIn>() {
        return (stand_in.0.clone())(url);
    }
    system_open(url, cx)
}

/// Put `open` in the system's place, until [`give_back`].
pub fn stand_in(open: impl Fn(&str) -> Result<(), String> + 'static, cx: &mut App) {
    cx.set_global(StandIn(Rc::new(open)));
}

/// Give the system its place back.
pub fn give_back(cx: &mut App) {
    if cx.has_global::<StandIn>() {
        cx.remove_global::<StandIn>();
    }
}

#[cfg(target_os = "macos")]
fn system_open(url: &str, _: &mut App) -> Result<(), String> {
    use objc2::{
        class, msg_send,
        rc::Retained,
        runtime::{AnyObject, Bool},
    };
    use objc2_foundation::NSString;

    let failed = || format!("The system could not open {url}");
    let string = NSString::from_str(url);
    // SAFETY: class messages on AppKit's NSURL and NSWorkspace, on the main
    // thread GPUI runs on; `URLWithString:` answers nil for an address it
    // cannot parse, which is checked before it is used.
    unsafe {
        let address: Option<Retained<AnyObject>> =
            msg_send![class!(NSURL), URLWithString: &*string];
        let address = address.ok_or_else(failed)?;
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let opened: Bool = msg_send![workspace, openURL: &*address];
        if opened.as_bool() {
            Ok(())
        } else {
            Err(failed())
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn system_open(url: &str, cx: &mut App) -> Result<(), String> {
    cx.open_url(url);
    Ok(())
}
