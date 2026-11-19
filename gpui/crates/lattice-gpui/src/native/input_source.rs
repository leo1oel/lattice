//! The keyboard input source a scenario types on.

use std::ffi::c_void;

use anyhow::{Context as _, Result};
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::NSString;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(object: *const c_void);
    fn CFBooleanGetValue(boolean: *const c_void) -> bool;
    fn CFRetain(object: *const c_void) -> *const c_void;
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn TISCopyCurrentKeyboardInputSource() -> *mut c_void;
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> *mut c_void;
    fn TISSelectInputSource(source: *mut c_void) -> i32;
    fn TISCreateInputSourceList(
        properties: *const AnyObject,
        all_installed: bool,
    ) -> *mut AnyObject;
    fn TISEnableInputSource(source: *mut c_void) -> i32;
    fn TISDisableInputSource(source: *mut c_void) -> i32;
    fn TISGetInputSourceProperty(source: *mut c_void, key: *const c_void) -> *const c_void;
    static kTISPropertyInputSourceIsASCIICapable: *const c_void;
    static kTISPropertyInputSourceID: *const c_void;
    static kTISPropertyInputSourceIsEnabled: *const c_void;
}

/// The input source `use_ascii_keyboard` switched away from, retained.
static SWITCHED_FROM: std::sync::atomic::AtomicPtr<c_void> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

fn input_source_id(source: *mut c_void) -> Option<String> {
    unsafe {
        let id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
        (!id.is_null()).then(|| (*id.cast::<NSString>()).to_string())
    }
}

/// Type the run's keys on an ASCII keyboard layout. The scenario's keys are
/// US keystrokes; while an input method such as Pinyin is selected, GPUI
/// hands every printable key to it before the key bindings
/// (`is_ime_input_source_active` in gpui-fast's `gpui_macos`), so `$` never
/// pairs, Vim's `:` never opens, and Pinyin's Shift takes a capital. The
/// source is the login session's, so the one in use goes back when the run
/// ends (`restore_keyboard`); returns the ids switched from and to, or
/// `None` when the source in use is already ASCII-capable.
pub fn use_ascii_keyboard() -> Option<(String, String)> {
    unsafe {
        let current = TISCopyCurrentKeyboardInputSource();
        if current.is_null() {
            return None;
        }
        let capable = TISGetInputSourceProperty(current, kTISPropertyInputSourceIsASCIICapable);
        if !capable.is_null() && CFBooleanGetValue(capable) {
            CFRelease(current);
            return None;
        }
        let ascii = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
        if ascii.is_null() {
            CFRelease(current);
            return None;
        }
        let ids = (
            input_source_id(current).unwrap_or_default(),
            input_source_id(ascii).unwrap_or_default(),
        );
        let status = TISSelectInputSource(ascii);
        CFRelease(ascii);
        if status != 0 {
            log::warn!(
                "could not select the ASCII keyboard {} (status {status})",
                ids.1
            );
            CFRelease(current);
            return None;
        }
        SWITCHED_FROM.store(current, std::sync::atomic::Ordering::Relaxed);
        Some(ids)
    }
}

/// The input source `use_ascii_keyboard` switched away from, selected again.
pub fn restore_keyboard() {
    let previous = SWITCHED_FROM.swap(std::ptr::null_mut(), std::sync::atomic::Ordering::Relaxed);
    if previous.is_null() {
        return;
    }
    unsafe {
        TISSelectInputSource(previous);
        CFRelease(previous);
    }
}

/// The keyboard a step types on, given back when it is dropped: the source
/// in use before it is selected again, and the input sources the step had
/// to enable disabled again.
pub struct InputMethod {
    source: *mut c_void,
    previous: *mut c_void,
    enabled_here: Vec<*mut c_void>,
}

/// The installed input source `id`, retained.
fn installed_source(id: &str) -> Option<*mut c_void> {
    unsafe {
        let filter: Retained<AnyObject> = msg_send![class!(NSDictionary),
            dictionaryWithObject: &*NSString::from_str(id),
            forKey: kTISPropertyInputSourceID.cast::<AnyObject>()];
        let list = TISCreateInputSourceList(&*filter, true);
        let list: Retained<AnyObject> = Retained::from_raw(list)?;
        let count: usize = msg_send![&*list, count];
        if count == 0 {
            return None;
        }
        let source: *mut AnyObject = msg_send![&*list, objectAtIndex: 0usize];
        Some(CFRetain(source.cast()).cast_mut())
    }
}

/// Enable `source` when the user has not; returns whether it was enabled
/// here.
fn enable(source: *mut c_void) -> bool {
    unsafe {
        let enabled = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsEnabled);
        let enable = enabled.is_null() || !CFBooleanGetValue(enabled);
        if enable {
            TISEnableInputSource(source);
        }
        enable
    }
}

/// Select the installed input source `id` (an input method's mode, such as
/// Pinyin's `com.apple.inputmethod.SCIM.ITABC`), enabling it and its input
/// method (`com.apple.inputmethod.SCIM`) first when the user has not, as a
/// fresh Mac (a CI runner) has neither, for the system and for `native`'s
/// view's text input context (which otherwise picks the change up only when
/// it is activated again), until the returned guard is dropped.
pub fn select_input_method(native: super::Native, id: &str) -> Result<InputMethod> {
    let source =
        installed_source(id).with_context(|| format!("no input source {id} is installed"))?;
    let mut method = InputMethod {
        source,
        previous: unsafe { TISCopyCurrentKeyboardInputSource() },
        enabled_here: Vec::new(),
    };
    if let Some(parent) = id
        .rsplit_once('.')
        .and_then(|(parent, _)| installed_source(parent))
    {
        if enable(parent) {
            method.enabled_here.push(parent);
        } else {
            unsafe { CFRelease(parent) };
        }
    }
    if enable(source) {
        method
            .enabled_here
            .push(unsafe { CFRetain(source) }.cast_mut());
    }
    // Enabling lands asynchronously, so a source enabled just now may refuse
    // to be selected for a moment.
    let mut status = 0;
    for _ in 0..20 {
        status = unsafe { TISSelectInputSource(source) };
        if status == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    anyhow::ensure!(status == 0, "could not select {id} (status {status})");
    unsafe {
        let context: *mut AnyObject = msg_send![native.view, inputContext];
        if !context.is_null() {
            let _: () =
                msg_send![context, setSelectedKeyboardInputSource: &*NSString::from_str(id)];
        }
    }
    Ok(method)
}

impl Drop for InputMethod {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_null() {
                TISSelectInputSource(self.previous);
                CFRelease(self.previous);
            }
            for source in self.enabled_here.drain(..).rev() {
                TISDisableInputSource(source);
                CFRelease(source);
            }
            CFRelease(self.source);
        }
    }
}

/// The id of the keyboard input source in use.
pub fn current_input_source() -> Option<String> {
    unsafe {
        let source = TISCopyCurrentKeyboardInputSource();
        if source.is_null() {
            return None;
        }
        let id = input_source_id(source);
        CFRelease(source);
        id
    }
}
