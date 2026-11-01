//! AppKit's `terminate:` waits for every window to save.
//!
//! Dock ▸ Quit, logging out, restarting or shutting down the Mac, a script's
//! `quit app "Lattice"` and Activity Monitor's Quit all reach Lattice as
//! `terminate:`. tao's application delegate does not implement
//! `applicationShouldTerminate:`, so AppKit terminated at once and Lattice only
//! heard `RunEvent::Exit`, too late for a page to save its last second of
//! typing. This adds that method to the delegate tao installed: it answers
//! `NSTerminateLater` while `save_before_close` asks every window to save, and
//! `reply` gives AppKit the answer once they have (or the wait ran out).

use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::{class, msg_send, sel};
use tauri::{AppHandle, Runtime};

/// `NSApplicationTerminateReply`.
const NS_TERMINATE_NOW: usize = 1;
const NS_TERMINATE_LATER: usize = 2;

/// The app AppKit's question is about, set once the delegate can ask it.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Give tao's application delegate `applicationShouldTerminate:`. Called from
/// `setup`, on the main thread, once tao has set its delegate.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    // SAFETY: on the main thread, as AppKit requires; the delegate is tao's,
    // which tao keeps alive for the life of the event loop.
    unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![ns_app, delegate];
        if delegate.is_null() {
            log::warn!(target: "lattice::app", "No application delegate: quitting from the Dock will not save first");
            return;
        }
        add_should_terminate(objc2::ffi::object_getClass(delegate));
        // AppKit may have noted which methods the delegate has when it was
        // set; setting it again makes it look again.
        let _: () = msg_send![ns_app, setDelegate: std::ptr::null_mut::<AnyObject>()];
        let _: () = msg_send![ns_app, setDelegate: delegate];
    }
}

/// Add the method to `class`, unless it already answers it.
///
/// # Safety
/// `class` must be a registered Objective-C class.
unsafe fn add_should_terminate(class: *const AnyClass) {
    let selector = sel!(applicationShouldTerminate:);
    if unsafe { objc2::ffi::class_respondsToSelector(class, selector) }.as_bool() {
        return;
    }
    type Method = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;
    let method: Method = should_terminate;
    // SAFETY: the encoding matches `should_terminate`'s signature
    // (NSUInteger, self, _cmd, id) on 64-bit Apple platforms.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            class.cast_mut(),
            selector,
            std::mem::transmute::<Method, objc2::runtime::Imp>(method),
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        log::warn!(target: "lattice::app", "Could not add applicationShouldTerminate: to the application delegate");
    }
}

extern "C-unwind" fn should_terminate(_: *mut AnyObject, _: Sel, _: *mut AnyObject) -> usize {
    match APP.get() {
        Some(app) if !crate::save_before_close::terminate(app) => NS_TERMINATE_LATER,
        _ => NS_TERMINATE_NOW,
    }
}

/// Answer AppKit's waiting `terminate:`: `proceed` ends Lattice (through
/// `applicationWillTerminate:` and `RunEvent::Exit`, as before); otherwise
/// Lattice stays open, and a logout or shutdown stops.
pub fn reply<R: Runtime>(app: &AppHandle<R>, proceed: bool) {
    let replied = app.run_on_main_thread(move || {
        // SAFETY: on the main thread; AppKit is waiting for exactly this reply.
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, replyToApplicationShouldTerminate: Bool::new(proceed)];
        }
    });
    if let Err(error) = replied {
        log::error!(target: "lattice::app", "Could not answer the request to quit: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{add_should_terminate, NS_TERMINATE_NOW};
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, NSObject};
    use objc2::{msg_send, sel, ClassType};

    #[test]
    fn a_delegate_without_the_method_gains_it_and_an_app_with_nothing_to_save_ends_at_once() {
        // tao's delegate as it comes: AppKit, finding no
        // `applicationShouldTerminate:`, terminates without asking anyone.
        let builder = ClassBuilder::new(c"LatticeTestAppDelegate", NSObject::class()).unwrap();
        let class: &'static AnyClass = builder.register();
        assert!(!class.responds_to(sel!(applicationShouldTerminate:)));

        unsafe { add_should_terminate(class) };
        assert!(class.responds_to(sel!(applicationShouldTerminate:)));
        // Adding it twice keeps the first.
        unsafe { add_should_terminate(class) };

        // No app is set up in a test: nothing can be waiting to save.
        let delegate: *mut AnyObject = unsafe { msg_send![class, new] };
        let reply: usize = unsafe {
            msg_send![delegate, applicationShouldTerminate: std::ptr::null_mut::<AnyObject>()]
        };
        assert_eq!(reply, NS_TERMINATE_NOW);
        let _: () = unsafe { msg_send![delegate, release] };
    }
}
