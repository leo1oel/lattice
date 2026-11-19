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

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateKeyboardEvent(source: *const c_void, key_code: u16, down: bool) -> *mut c_void;
    fn CGEventSetFlags(event: *mut c_void, flags: u64);
    fn CGEventPost(tap: u32, event: *mut c_void);
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
/// in use before it is selected again, and the input method disabled again
/// when the step had to enable it.
pub struct InputMethod {
    source: *mut c_void,
    previous: *mut c_void,
    enabled_here: bool,
}

/// Select the installed input source `id` (an input method's mode, such as
/// Pinyin's `com.apple.inputmethod.SCIM.ITABC`), enabling it first when the
/// user has not, for the system and for `native`'s view's text input
/// context (which otherwise picks the change up only when it is activated
/// again), until the returned guard is dropped.
pub fn select_input_method(native: super::Native, id: &str) -> Result<InputMethod> {
    unsafe {
        let filter: Retained<AnyObject> = msg_send![class!(NSDictionary),
            dictionaryWithObject: &*NSString::from_str(id),
            forKey: kTISPropertyInputSourceID.cast::<AnyObject>()];
        let list = TISCreateInputSourceList(&*filter, true);
        let list: Option<Retained<AnyObject>> = Retained::from_raw(list);
        let list = list.with_context(|| format!("no input source {id} is installed"))?;
        let count: usize = msg_send![&*list, count];
        anyhow::ensure!(count > 0, "no input source {id} is installed");
        let source: *mut AnyObject = msg_send![&*list, objectAtIndex: 0usize];
        let source = CFRetain(source.cast()).cast_mut();
        let enabled = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsEnabled);
        let enabled_here = enabled.is_null() || !CFBooleanGetValue(enabled);
        if enabled_here {
            TISEnableInputSource(source);
        }
        let previous = TISCopyCurrentKeyboardInputSource();
        let status = TISSelectInputSource(source);
        let method = InputMethod {
            source,
            previous,
            enabled_here,
        };
        anyhow::ensure!(status == 0, "could not select {id} (status {status})");
        let context: *mut AnyObject = msg_send![native.view, inputContext];
        if !context.is_null() {
            let _: () =
                msg_send![context, setSelectedKeyboardInputSource: &*NSString::from_str(id)];
        }
        Ok(method)
    }
}

impl Drop for InputMethod {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_null() {
                TISSelectInputSource(self.previous);
                CFRelease(self.previous);
            }
            if self.enabled_here {
                TISDisableInputSource(self.source);
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

/// A key as the keyboard sends it: posted to the system's event stream
/// (`kCGHIDEventTap`), so the input method in use takes it before the key
/// window does, as it does a key typed by hand. A key sent to the window
/// itself (`send_key`) reaches the input method only as an already
/// interpreted event that Pinyin inserts without composing. Goes to the
/// frontmost app's key window, so the caller holds a foreground section.
/// `key_code` is the ANSI key code; `shift` holds Shift down with it.
pub fn post_hid_key(key_code: u16, shift: bool) -> Result<()> {
    const SHIFT_KEY: u16 = 0x38;
    const SHIFT_FLAG: u64 = 1 << 17;
    let mut events = Vec::new();
    if shift {
        events.push((SHIFT_KEY, true, SHIFT_FLAG));
    }
    let flags = if shift { SHIFT_FLAG } else { 0 };
    events.push((key_code, true, flags));
    events.push((key_code, false, flags));
    if shift {
        events.push((SHIFT_KEY, false, 0));
    }
    post_hid_events(&events)
}

/// Shift pressed and let go alone, through the system's event stream, as
/// an input method that switches between its own language and English on
/// Shift sees it.
pub fn post_hid_shift_tap() -> Result<()> {
    const SHIFT_KEY: u16 = 0x38;
    post_hid_events(&[(SHIFT_KEY, true, 1 << 17), (SHIFT_KEY, false, 0)])
}

fn post_hid_events(events: &[(u16, bool, u64)]) -> Result<()> {
    const HID_EVENT_TAP: u32 = 0;
    for &(key_code, down, flags) in events {
        unsafe {
            let event = CGEventCreateKeyboardEvent(std::ptr::null(), key_code, down);
            anyhow::ensure!(!event.is_null(), "CoreGraphics refused the key event");
            CGEventSetFlags(event, flags);
            CGEventPost(HID_EVENT_TAP, event);
            CFRelease(event);
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    Ok(())
}
