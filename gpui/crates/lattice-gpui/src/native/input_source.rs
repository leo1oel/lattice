//! The keyboard input source a scenario types on.

use std::ffi::c_void;

use objc2_foundation::NSString;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(object: *const c_void);
    fn CFBooleanGetValue(boolean: *const c_void) -> bool;
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn TISCopyCurrentKeyboardInputSource() -> *mut c_void;
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> *mut c_void;
    fn TISSelectInputSource(source: *mut c_void) -> i32;
    fn TISGetInputSourceProperty(source: *mut c_void, key: *const c_void) -> *const c_void;
    static kTISPropertyInputSourceIsASCIICapable: *const c_void;
    static kTISPropertyInputSourceID: *const c_void;
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
