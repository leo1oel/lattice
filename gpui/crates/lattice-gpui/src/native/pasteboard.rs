//! A pasteboard of the process's own for a scenario run, in place of the
//! login session's general one.

use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::NSString;

/// The pasteboard `use_private_pasteboard` gave the process.
static PRIVATE_PASTEBOARD: std::sync::atomic::AtomicPtr<AnyObject> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());
/// `+[NSPasteboard pasteboardWithName:]` as AppKit has it.
static PASTEBOARD_WITH_NAME: std::sync::OnceLock<objc2::runtime::Imp> = std::sync::OnceLock::new();

/// Give the process a pasteboard of its own in place of the general one, for
/// a scenario run: the general pasteboard is one for the whole login session,
/// so a run's copy landed between another run's copy and its paste, and that
/// run's check read the wrong text. Every copy and paste the run makes (GPUI's,
/// the editor's and Vim's registers, a webview's) then goes through a real
/// pasteboard that only this process sees. Called before GPUI starts, which
/// keeps the general pasteboard it finds then.
pub fn use_private_pasteboard() {
    use objc2::runtime::{AnyClass, Imp, Sel};
    unsafe extern "C-unwind" fn general(_class: &AnyClass, _sel: Sel) -> *mut AnyObject {
        PRIVATE_PASTEBOARD.load(std::sync::atomic::Ordering::Relaxed)
    }
    unsafe extern "C-unwind" fn with_name(
        class: &AnyClass,
        sel: Sel,
        name: *mut AnyObject,
    ) -> *mut AnyObject {
        unsafe {
            let general_name = NSString::from_str("Apple CFPasteboard general");
            let is_general: bool =
                !name.is_null() && msg_send![name, isEqualToString: &*general_name];
            if is_general {
                return PRIVATE_PASTEBOARD.load(std::sync::atomic::Ordering::Relaxed);
            }
            let original = PASTEBOARD_WITH_NAME
                .get()
                .expect("set before the method was replaced");
            let original: unsafe extern "C-unwind" fn(
                &AnyClass,
                Sel,
                *mut AnyObject,
            ) -> *mut AnyObject = std::mem::transmute(*original);
            original(class, sel, name)
        }
    }
    unsafe {
        let private: Option<Retained<AnyObject>> =
            msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
        let Some(private) = private else {
            log::warn!("no private pasteboard; the run uses the general one");
            return;
        };
        PRIVATE_PASTEBOARD.store(
            Retained::into_raw(private),
            std::sync::atomic::Ordering::Relaxed,
        );
        let class = class!(NSPasteboard);
        if let Some(method) = class.class_method(objc2::sel!(generalPasteboard)) {
            method.set_implementation(std::mem::transmute::<
                unsafe extern "C-unwind" fn(&AnyClass, Sel) -> *mut AnyObject,
                Imp,
            >(general));
        }
        if let Some(method) = class.class_method(objc2::sel!(pasteboardWithName:)) {
            let original = method.set_implementation(std::mem::transmute::<
                unsafe extern "C-unwind" fn(&AnyClass, Sel, *mut AnyObject) -> *mut AnyObject,
                Imp,
            >(with_name));
            let _ = PASTEBOARD_WITH_NAME.set(original);
        }
    }
}

/// Empty the private pasteboard as the run ends, so the pasteboard server
/// keeps no copy of what the run put there. Not `releaseGlobally`: AppKit
/// still reaches the pasteboard while the app terminates.
pub fn release_private_pasteboard() {
    let private = PRIVATE_PASTEBOARD.load(std::sync::atomic::Ordering::Relaxed);
    if !private.is_null() {
        unsafe {
            let _: isize = msg_send![private, clearContents];
        }
    }
}
