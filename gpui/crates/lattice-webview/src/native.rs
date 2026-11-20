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

/// A hidden page never keeps the keyboard. WebKit makes a page's view
/// AppKit's first responder when the page focuses an element of its own (the
/// sheet's Univer does as it loads), hidden or not. A hidden view holding it
/// is later dropped onto the window, where typed letters reach nothing while
/// GPUI's focus is elsewhere (Enter, a key equivalent, still does). Hiding a
/// page hands the keyboard back first (gpui-webview's `set_visible`), but a
/// page built hidden, or focusing itself just after its island is hidden,
/// takes it after that.
///
/// So Wry's view class refuses `becomeFirstResponder` while hidden (AppKit's
/// `makeFirstResponder:`, which WebKit calls, never asks
/// `acceptsFirstResponder`). A refusal leaves the window itself first
/// responder, since AppKit has already resigned the previous one; the view
/// therefore queues, on the main run loop, giving the keyboard back to GPUI's
/// view, which each page's view remembers, if nothing has taken it by then.
/// The methods go on Wry's class once per process; it overrides neither.
#[cfg(target_os = "macos")]
pub(crate) fn refuse_keyboard_while_hidden(webview: &WebView, window: &gpui::Window) {
    use objc2::{
        ffi, msg_send,
        runtime::{AnyClass, AnyObject, Bool, Imp, Sel},
        sel,
    };
    use std::{ffi::c_void, sync::Once};
    use wry::WebViewExtMacOS as _;
    use wry::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    /// The key GPUI's view is kept under on each page's view.
    static GPUI_VIEW: u8 = 0;
    fn gpui_view_key() -> *const c_void {
        std::ptr::from_ref(&GPUI_VIEW).cast()
    }

    extern "C-unwind" fn become_first_responder(this: &AnyObject, _: Sel) -> Bool {
        // SAFETY: on the main thread, on an instance of Wry's class or of a
        // subclass Key-Value Observing made of it, so WKWebView's own answer
        // is the next one up from Wry's class, not from the instance's.
        unsafe {
            let hidden: Bool = msg_send![this, isHiddenOrHasHiddenAncestor];
            if hidden.as_bool() {
                let _: () = msg_send![
                    this,
                    performSelectorOnMainThread: sel!(latticeReturnKeyboard),
                    withObject: std::ptr::null::<AnyObject>(),
                    waitUntilDone: Bool::NO
                ];
                return Bool::NO;
            }
            let Some(superclass) = AnyClass::get(c"WryWebView").and_then(AnyClass::superclass)
            else {
                return Bool::YES;
            };
            let became: Bool = msg_send![super(this, superclass), becomeFirstResponder];
            if became.as_bool() {
                took_keyboard(std::ptr::from_ref(this).addr());
            }
            became
        }
    }

    extern "C-unwind" fn return_keyboard(this: &AnyObject, _: Sel) {
        // SAFETY: on the main thread; every object is checked before use.
        unsafe {
            let window: *mut AnyObject = msg_send![this, window];
            let gpui_view = ffi::objc_getAssociatedObject(this, gpui_view_key());
            if window.is_null() || gpui_view.is_null() {
                return;
            }
            let responder: *mut AnyObject = msg_send![window, firstResponder];
            if responder == window {
                let _: Bool = msg_send![window, makeFirstResponder: gpui_view];
            }
        }
    }

    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let Some(class) = AnyClass::get(c"WryWebView") else {
            log::warn!("WryWebView is not registered; hidden pages may take the keyboard");
            return;
        };
        let class = std::ptr::from_ref(class).cast_mut();
        // SAFETY: on the main thread; each function matches its method's
        // signature (`- (BOOL)becomeFirstResponder`, `- (void)latticeReturnKeyboard`).
        unsafe {
            let become_imp: Imp = std::mem::transmute(
                become_first_responder as extern "C-unwind" fn(&AnyObject, Sel) -> Bool,
            );
            let return_imp: Imp =
                std::mem::transmute(return_keyboard as extern "C-unwind" fn(&AnyObject, Sel));
            let returns = ffi::class_addMethod(
                class,
                sel!(latticeReturnKeyboard),
                return_imp,
                c"v@:".as_ptr(),
            );
            let refuses = returns.as_bool()
                && ffi::class_addMethod(
                    class,
                    sel!(becomeFirstResponder),
                    become_imp,
                    c"B@:".as_ptr(),
                )
                .as_bool();
            if !refuses {
                log::warn!("WryWebView already answers becomeFirstResponder");
            }
        }
    });

    let Ok(RawWindowHandle::AppKit(handle)) =
        HasWindowHandle::window_handle(window).map(|h| h.as_raw())
    else {
        return;
    };
    let view = webview.raw().webview();
    // SAFETY: on the main thread; GPUI's view is retained by the page's view,
    // which never retains the page's view back.
    unsafe {
        ffi::objc_setAssociatedObject(
            objc2::rc::Retained::as_ptr(&view)
                .cast::<AnyObject>()
                .cast_mut(),
            gpui_view_key(),
            handle.ns_view.as_ptr().cast(),
            ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn refuse_keyboard_while_hidden(_: &WebView, _: &gpui::Window) {}

/// Each page's view, by address, and its island's ear for
/// [`watch_keyboard`]; an entry whose island is gone drops at the next send
/// or watch.
#[cfg(target_os = "macos")]
type KeyboardWatchers = Vec<(usize, futures::channel::mpsc::UnboundedSender<()>)>;

#[cfg(target_os = "macos")]
thread_local! {
    static KEYBOARD_WATCHERS: std::cell::RefCell<KeyboardWatchers> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// A message, each time the page's view becomes AppKit's first responder (a
/// click in it, or WebKit focusing an element of its own), for its island to
/// give GPUI's focus to the page. The page's bridge cannot be relied on for
/// it: when the page's keyboard is in a child frame (the Agent's Synara
/// composer, the HTML preview's sandboxed document), the focus and blur the
/// view's first responder changes bring reach that frame alone, never the
/// main frame the bridge listens in, and a press in it never reaches the
/// main frame either. GPUI's focus then stayed on the .tex editor: its caret
/// kept blinking beside the composer's and it took the composer's ⌘V.
/// Only once [`refuse_keyboard_while_hidden`] has put the methods on Wry's
/// class; `None` off macOS.
#[cfg(target_os = "macos")]
pub(crate) fn watch_keyboard(
    webview: &WebView,
) -> Option<futures::channel::mpsc::UnboundedReceiver<()>> {
    use wry::WebViewExtMacOS as _;
    let view = objc2::rc::Retained::as_ptr(&webview.raw().webview()).addr();
    let (sender, receiver) = futures::channel::mpsc::unbounded();
    KEYBOARD_WATCHERS.with(|watchers| {
        let mut watchers = watchers.borrow_mut();
        watchers.retain(|(watched, sender)| *watched != view && !sender.is_closed());
        watchers.push((view, sender));
    });
    Some(receiver)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn watch_keyboard(_: &WebView) -> Option<futures::channel::mpsc::UnboundedReceiver<()>> {
    None
}

/// The view at `view` became first responder: tell its island.
#[cfg(target_os = "macos")]
fn took_keyboard(view: usize) {
    KEYBOARD_WATCHERS.with(|watchers| {
        watchers
            .borrow_mut()
            .retain(|(watched, sender)| *watched != view || sender.unbounded_send(()).is_ok());
    });
}

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

/// The page's view's frame in its window, in points from the window's top
/// left.
#[cfg(target_os = "macos")]
pub(crate) fn native_frame(webview: &WebView) -> Option<gpui::Bounds<gpui::Pixels>> {
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_foundation::NSRect;
    use wry::WebViewExtMacOS as _;
    let view = webview.raw().webview();
    // SAFETY: on the main thread; every object is checked before it is used.
    unsafe {
        let window: *mut AnyObject = msg_send![&*view, window];
        if window.is_null() {
            return None;
        }
        let content: *mut AnyObject = msg_send![window, contentView];
        if content.is_null() {
            return None;
        }
        let frame: NSRect = msg_send![&*view, bounds];
        let frame: NSRect = msg_send![&*view, convertRect: frame, toView: content];
        let content: NSRect = msg_send![content, bounds];
        Some(gpui::Bounds::new(
            gpui::point(
                gpui::px(frame.origin.x as f32),
                gpui::px((content.size.height - frame.origin.y - frame.size.height) as f32),
            ),
            gpui::size(
                gpui::px(frame.size.width as f32),
                gpui::px(frame.size.height as f32),
            ),
        ))
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn native_frame(_: &WebView) -> Option<gpui::Bounds<gpui::Pixels>> {
    None
}
