//! What an island asks of the platform's webview directly, outside Wry and
//! gpui-webview: macOS only, with a plain answer elsewhere.

use gpui_webview::WebView;

/// The lab switch scripted runs set (`GPUI_LAB_IGNORE_OCCLUSION`, gpui-fast's
/// macOS patch): the window keeps drawing while covered or on a locked
/// screen, so its pages must too.
pub(crate) fn lab_ignore_occlusion() -> bool {
    std::env::var_os("GPUI_LAB_IGNORE_OCCLUSION").is_some()
}

/// WebKit stops drawing, and runs no animation frames, in a page whose window
/// it believes covered; its private switch turns that off, as the Phase 0
/// spike's runs did. Only ever under the lab switch.
#[cfg(target_os = "macos")]
pub(crate) fn keep_drawing_when_occluded(webview: &WebView) {
    use objc2::{msg_send, runtime::Bool};
    use wry::WebViewExtMacOS as _;
    let view = webview.raw().webview();
    let selector = objc2::sel!(_setWindowOcclusionDetectionEnabled:);
    // SAFETY: on the main thread, on the WKWebView Wry built; the selector is
    // checked before it is sent.
    unsafe {
        let responds: Bool = msg_send![&*view, respondsToSelector: selector];
        if responds.as_bool() {
            let _: () = msg_send![&*view, _setWindowOcclusionDetectionEnabled: Bool::NO];
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn keep_drawing_when_occluded(_: &WebView) {}

/// Whether AppKit's first responder is the page's view or inside it.
#[cfg(target_os = "macos")]
pub(crate) fn native_page_focused(webview: &WebView) -> Option<bool> {
    use objc2::{
        class, msg_send,
        runtime::{AnyObject, Bool},
    };
    use wry::WebViewExtMacOS as _;
    let view = webview.raw().webview();
    // SAFETY: on the main thread; every object is checked before it is used.
    unsafe {
        let window: *mut AnyObject = msg_send![&*view, window];
        if window.is_null() {
            return Some(false);
        }
        let responder: *mut AnyObject = msg_send![window, firstResponder];
        if responder.is_null() {
            return Some(false);
        }
        let is_view: Bool = msg_send![responder, isKindOfClass: class!(NSView)];
        if !is_view.as_bool() {
            return Some(false);
        }
        let inside: Bool = msg_send![responder, isDescendantOf: &*view];
        Some(inside.as_bool())
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn native_page_focused(_: &WebView) -> Option<bool> {
    None
}
