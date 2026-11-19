//! Keys typed while an input method is selected are read on the ASCII layout
//! under it.
//!
//! A key's name comes from the keyboard layout in use (`chars_for_modified_key`
//! in `events.rs`). A composition-based input method brings a layout of its
//! own, and Pinyin's gives its punctuation as Chinese text writes it: ⇧4 is
//! `¥` and ⇧; is `：`. So a binding of `$` (a LaTeX file's math pair) or
//! of `:` (Vim's command line) never matched while Pinyin was selected,
//! whether or not the input method was composing. Bindings name the keys of
//! an ASCII layout, so while such an input method is selected its keys are
//! read on the ASCII-capable layout the system keeps beside it, as they are
//! with ⌘ held on a non-ASCII layout. What the key types is still the input
//! method's: the event it receives is the one AppKit sent.

use objc2::runtime::AnyObject;

use crate::{
    TISCopyCurrentKeyboardInputSource, TISCopyCurrentKeyboardLayoutInputSource,
    TISGetInputSourceProperty, kTISPropertyInputSourceIsASCIICapable,
    kTISPropertyInputSourceType, kTISTypeKeyboardInputMode,
};
use core_foundation::base::{CFRelease, CFTypeRef};
use core_foundation_sys::base::CFEqual;
use core_foundation_sys::number::{CFBooleanGetValue, CFBooleanRef};
use std::ffi::c_void;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> *mut AnyObject;
}

/// The keyboard layout a key's name is read on, retained: the ASCII-capable
/// layout while a composition-based input method that types no ASCII of its
/// own is selected (Pinyin, Japanese kana, Korean), else the layout in use.
pub(crate) unsafe fn keyboard_layout() -> *mut AnyObject {
    unsafe {
        if composing_input_method_selected() {
            let ascii = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
            if !ascii.is_null() {
                return ascii;
            }
        }
        TISCopyCurrentKeyboardLayoutInputSource()
    }
}

/// Whether the input source in use is an input method's mode that is not
/// ASCII-capable, as `window.rs`'s `is_ime_input_source_active` asks.
unsafe fn composing_input_method_selected() -> bool {
    unsafe {
        let source = TISCopyCurrentKeyboardInputSource();
        if source.is_null() {
            return false;
        }
        let kind = TISGetInputSourceProperty(source, kTISPropertyInputSourceType as *const c_void);
        let input_mode = !kind.is_null()
            && CFEqual(kind as CFTypeRef, kTISTypeKeyboardInputMode as CFTypeRef) != 0;
        let ascii = TISGetInputSourceProperty(
            source,
            kTISPropertyInputSourceIsASCIICapable as *const c_void,
        );
        let ascii_capable = !ascii.is_null() && CFBooleanGetValue(ascii as CFBooleanRef);
        CFRelease(source as CFTypeRef);
        input_mode && !ascii_capable
    }
}
