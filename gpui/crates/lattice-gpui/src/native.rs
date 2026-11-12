//! Native macOS input for the scripted runs, built the way Lattice's perf lab
//! builds it (`src-tauri/src/perf_lab.rs`): keyDown/keyUp `NSEvent`s and
//! continuous pixel scroll-wheel events sent through `-[NSWindow sendEvent:]`,
//! so they take the same AppKit path, input method included, as real input.
//!
//! Events are sent outside any GPUI update, the way the window server's
//! arrive: GPUI handles them synchronously and needs the app unborrowed.

use std::ffi::c_void;

use anyhow::{Context as _, Result, anyhow};
use gpui::{Pixels, Point, Window};
use objc2::{
    class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool},
};
use objc2_foundation::{NSPoint, NSRect, NSString};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateScrollWheelEvent2(
        source: *const c_void,
        units: u32,
        wheel_count: u32,
        wheel1: i32,
        wheel2: i32,
        wheel3: i32,
    ) -> *mut c_void;
    fn CGEventSetLocation(event: *mut c_void, location: NSPoint);
    fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(object: *const c_void);
}

const KEY_DOWN: usize = 10;
const KEY_UP: usize = 11;
const COMMAND_MODIFIER: usize = 1 << 20;

/// The AppKit view GPUI draws into, and its window. Valid while the GPUI
/// window is open.
#[derive(Clone, Copy)]
pub struct Native {
    view: *mut AnyObject,
    window: *mut AnyObject,
}

pub fn native(window: &Window) -> Result<Native> {
    let handle = HasWindowHandle::window_handle(window).map_err(|error| anyhow!("{error}"))?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return Err(anyhow!("not an AppKit window"));
    };
    let view = handle.ns_view.as_ptr() as *mut AnyObject;
    let ns_window: *mut AnyObject = unsafe { msg_send![view, window] };
    if ns_window.is_null() {
        return Err(anyhow!("the view has no window"));
    }
    Ok(Native {
        view,
        window: ns_window,
    })
}

fn uptime() -> f64 {
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        msg_send![info, systemUptime]
    }
}

/// The ANSI virtual key code for a character, as Lattice's perf lab maps it.
pub fn key_code(character: char) -> u16 {
    const CODES: [(char, u16); 30] = [
        ('a', 0x00),
        ('s', 0x01),
        ('d', 0x02),
        ('f', 0x03),
        ('h', 0x04),
        ('g', 0x05),
        ('z', 0x06),
        ('x', 0x07),
        ('c', 0x08),
        ('v', 0x09),
        ('b', 0x0B),
        ('q', 0x0C),
        ('w', 0x0D),
        ('e', 0x0E),
        ('r', 0x0F),
        ('y', 0x10),
        ('t', 0x11),
        ('o', 0x1F),
        ('u', 0x20),
        ('i', 0x22),
        ('p', 0x23),
        ('l', 0x25),
        ('j', 0x26),
        ('k', 0x28),
        ('n', 0x2D),
        ('m', 0x2E),
        (' ', 0x31),
        ('\n', 0x24),
        ('\\', 0x2A),
        ('\u{1b}', 0x35),
    ];
    CODES
        .iter()
        .find(|(c, _)| *c == character.to_ascii_lowercase())
        .map(|(_, code)| *code)
        .unwrap_or(0)
}

/// One keyDown and keyUp for `character`, through the window.
pub fn send_key(native: Native, character: char, command: bool) -> Result<()> {
    let text = match character {
        '\n' => "\r".to_string(),
        other => other.to_string(),
    };
    let characters = NSString::from_str(&text);
    let modifiers = if command { COMMAND_MODIFIER } else { 0 };
    unsafe {
        let number: isize = msg_send![native.window, windowNumber];
        for kind in [KEY_DOWN, KEY_UP] {
            let event: Option<Retained<AnyObject>> = msg_send![class!(NSEvent),
                keyEventWithType: kind,
                location: NSPoint::new(0.0, 0.0),
                modifierFlags: modifiers,
                timestamp: uptime(),
                windowNumber: number,
                context: std::ptr::null_mut::<AnyObject>(),
                characters: &*characters,
                charactersIgnoringModifiers: &*characters,
                isARepeat: Bool::NO,
                keyCode: key_code(character)];
            let event = event.context("NSEvent refused the key event")?;
            let _: () = msg_send![native.window, sendEvent: &*event];
        }
    }
    Ok(())
}

/// One continuous (trackpad-like) pixel scroll of `dy` at `position`, given
/// in GPUI's window coordinates (logical pixels from the top-left).
pub fn send_wheel(native: Native, position: Point<Pixels>, dy: i32) -> Result<()> {
    unsafe {
        let in_window = to_window(
            native.view,
            f32::from(position.x) as f64,
            f32::from(position.y) as f64,
        );
        let number: isize = msg_send![native.window, windowNumber];
        let event = CGEventCreateScrollWheelEvent2(std::ptr::null(), 0, 1, dy, 0, 0);
        if event.is_null() {
            return Err(anyhow!("CoreGraphics refused the scroll event"));
        }
        // A window-less NSEvent reports its screen location as
        // locationInWindow, which GPUI hit-tests with; place it so that
        // reads as the window point (Lattice's `direct` placement).
        let primary_height = primary_screen_height();
        CGEventSetLocation(
            event,
            NSPoint::new(in_window.x, primary_height - in_window.y),
        );
        CGEventSetIntegerValueField(event, 88, 1); // kCGScrollWheelEventIsContinuous
        CGEventSetIntegerValueField(event, 91, number as i64); // window under the pointer
        CGEventSetIntegerValueField(event, 92, number as i64); // window that can handle it
        let ns_event: Option<Retained<AnyObject>> =
            msg_send![class!(NSEvent), eventWithCGEvent: event];
        CFRelease(event);
        let ns_event = ns_event.context("NSEvent refused the scroll event")?;
        let _: () = msg_send![native.window, sendEvent: &*ns_event];
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub enum Mouse {
    Down = 1,
    Up = 2,
    Dragged = 6,
}

/// One left-button mouse event at `position` (GPUI window coordinates).
pub fn send_mouse(native: Native, kind: Mouse, position: Point<Pixels>) -> Result<()> {
    send_mouse_clicks(native, kind, position, 1)
}

/// A left double click at `position`: AppKit counts a click by the event's
/// `clickCount`, so the second press says 2.
pub fn send_double_click(native: Native, position: Point<Pixels>) -> Result<()> {
    for clicks in [1, 2] {
        send_mouse_clicks(native, Mouse::Down, position, clicks)?;
        send_mouse_clicks(native, Mouse::Up, position, clicks)?;
    }
    Ok(())
}

fn send_mouse_clicks(
    native: Native,
    kind: Mouse,
    position: Point<Pixels>,
    clicks: isize,
) -> Result<()> {
    use std::sync::atomic::{AtomicIsize, Ordering};
    static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);
    let pressure = match kind {
        Mouse::Down | Mouse::Dragged => 1.0f32,
        Mouse::Up => 0.0f32,
    };
    unsafe {
        let location = to_window(
            native.view,
            f32::from(position.x) as f64,
            f32::from(position.y) as f64,
        );
        let number: isize = msg_send![native.window, windowNumber];
        let event: Option<Retained<AnyObject>> = msg_send![class!(NSEvent),
            mouseEventWithType: kind as usize,
            location: location,
            modifierFlags: 0usize,
            timestamp: uptime(),
            windowNumber: number,
            context: std::ptr::null_mut::<AnyObject>(),
            eventNumber: EVENT_NUMBER.fetch_add(1, Ordering::Relaxed),
            clickCount: clicks,
            pressure: pressure];
        let event = event.context("NSEvent refused the mouse event")?;
        let _: () = msg_send![native.window, sendEvent: &*event];
    }
    Ok(())
}

/// A left click at `position` (GPUI window coordinates): mouse down and up.
pub fn send_click(native: Native, position: Point<Pixels>) -> Result<()> {
    send_mouse(native, Mouse::Down, position)?;
    send_mouse(native, Mouse::Up, position)
}

/// Switch this window's input source, as the Input menu does: AppKit keeps the
/// choice per text input context. Returns the previously selected source.
pub fn select_input_source(native: Native, source: &str) -> Result<Option<String>> {
    unsafe {
        let context: *mut AnyObject = msg_send![native.view, inputContext];
        if context.is_null() {
            return Err(anyhow!("the view has no input context"));
        }
        let previous: Option<Retained<NSString>> = msg_send![context, selectedKeyboardInputSource];
        let wanted = NSString::from_str(source);
        let _: () = msg_send![context, setSelectedKeyboardInputSource: &*wanted];
        let now: Option<Retained<NSString>> = msg_send![context, selectedKeyboardInputSource];
        if now.as_ref().map(|now| now.to_string()).as_deref() != Some(source) {
            let available: Option<Retained<AnyObject>> = msg_send![context, keyboardInputSources];
            let description = available
                .map(|list| {
                    let text: Retained<NSString> = msg_send![&*list, description];
                    text.to_string()
                })
                .unwrap_or_default();
            return Err(anyhow!(
                "could not select input source {source} (selected: {:?}; available: {description})",
                now.map(|now| now.to_string())
            ));
        }
        Ok(previous.map(|previous| previous.to_string()))
    }
}

/// The window server's number for the window, which `screencapture -l` takes.
#[cfg_attr(feature = "offscreen-shots", allow(dead_code))]
pub fn window_number(native: Native) -> isize {
    unsafe { msg_send![native.window, windowNumber] }
}

/// Put the window above every other window without activating the app, so
/// it draws while the keyboard stays where it is.
pub fn order_front(native: Native) {
    unsafe {
        let _: () = msg_send![native.window, orderFrontRegardless];
    }
}

/// Put the window in front of everything and make it key, so macOS neither
/// occludes it (which stops its display link) nor GPUI throttles it as an
/// inactive window while a scenario measures it. Lattice's lab does the same
/// for WebKit with `LATTICE_WK_NOOCC`.
pub fn bring_to_front(native: Native) {
    const FLOATING_WINDOW_LEVEL: isize = 3;
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, activateIgnoringOtherApps: Bool::YES];
        let _: () = msg_send![native.window, setLevel: FLOATING_WINDOW_LEVEL];
        let _: () = msg_send![native.window, orderFrontRegardless];
        let _: () = msg_send![native.window, makeKeyWindow];
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct NSRange {
    pub location: usize,
    pub length: usize,
}

unsafe impl objc2::Encode for NSRange {
    const ENCODING: objc2::Encoding =
        objc2::Encoding::Struct("_NSRange", &[usize::ENCODING, usize::ENCODING]);
}

const NOT_FOUND: usize = isize::MAX as usize;

/// What an input method does to the view while composing: the
/// `NSTextInputClient` calls AppKit makes on GPUI's view for marked text and
/// for the committed text. Returns whether the view reported marked text
/// after `setMarkedText`.
pub fn compose(
    native: Native,
    marked: &str,
    committed: &str,
) -> Result<(bool, Option<(usize, usize)>)> {
    unsafe {
        let marked_text = NSString::from_str(marked);
        let replacement = NSRange {
            location: NOT_FOUND,
            length: 0,
        };
        let selection = NSRange {
            location: marked.encode_utf16().count(),
            length: 0,
        };
        let _: () = msg_send![native.view,
            setMarkedText: &*marked_text,
            selectedRange: selection,
            replacementRange: replacement];
        let has_marked: bool = msg_send![native.view, hasMarkedText];
        let range: NSRange = msg_send![native.view, markedRange];
        let marked_range = (range.location != NOT_FOUND).then_some((range.location, range.length));
        let committed_text = NSString::from_str(committed);
        let _: () =
            msg_send![native.view, insertText: &*committed_text, replacementRange: replacement];
        Ok((has_marked, marked_range))
    }
}

/// `setMarkedText:` alone, as each keystroke of a composition sends it.
pub fn set_marked(native: Native, marked: &str) -> Result<()> {
    unsafe {
        let marked_text = NSString::from_str(marked);
        let replacement = NSRange {
            location: NOT_FOUND,
            length: 0,
        };
        let selection = NSRange {
            location: marked.encode_utf16().count(),
            length: 0,
        };
        let _: () = msg_send![native.view,
            setMarkedText: &*marked_text,
            selectedRange: selection,
            replacementRange: replacement];
    }
    Ok(())
}

/// Keep macOS from napping or timer-coalescing the process during a
/// measurement, as Lattice's lab does by disabling App Nap.
pub fn begin_latency_critical_activity() {
    const USER_INITIATED: u64 = 0x00FF_FFFF | (1 << 20);
    const LATENCY_CRITICAL: u64 = 0xFF_0000_0000;
    const OPTIONS: u64 = USER_INITIATED | LATENCY_CRITICAL;
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let reason = NSString::from_str("lattice-gpui measurement");
        let token: Option<Retained<AnyObject>> =
            msg_send![info, beginActivityWithOptions: OPTIONS, reason: &*reason];
        // Held for the life of the process.
        std::mem::forget(token);
    }
}

/// View coordinates (top-left origin) to window coordinates (bottom-left).
unsafe fn to_window(view: *mut AnyObject, x: f64, y: f64) -> NSPoint {
    unsafe {
        let flipped: bool = msg_send![view, isFlipped];
        let bounds: NSRect = msg_send![view, bounds];
        let local = if flipped {
            NSPoint::new(x, y)
        } else {
            NSPoint::new(x, bounds.size.height - y)
        };
        msg_send![view, convertPoint: local, toView: std::ptr::null_mut::<AnyObject>()]
    }
}

fn primary_screen_height() -> f64 {
    unsafe {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        let count: usize = if screens.is_null() {
            0
        } else {
            msg_send![screens, count]
        };
        if count == 0 {
            return 0.0;
        }
        let primary: *mut AnyObject = msg_send![screens, objectAtIndex: 0usize];
        let frame: NSRect = msg_send![primary, frame];
        frame.size.height
    }
}
