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
    fn CGEventCreateMouseEvent(
        source: *const c_void,
        kind: u32,
        location: NSPoint,
        button: u32,
    ) -> *mut c_void;
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

impl Native {
    /// The `NSWindow`.
    pub fn ns_window(self) -> *mut AnyObject {
        self.window
    }
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

/// The → key, as AppKit spells it in a key event's characters
/// (`NSRightArrowFunctionKey`).
pub const RIGHT_ARROW: char = '\u{f703}';

/// The ANSI virtual key code for a character, as Lattice's perf lab maps it.
pub fn key_code(character: char) -> u16 {
    const CODES: [(char, u16); 35] = [
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
        (',', 0x2B),
        ('\u{1b}', 0x35),
        // The interface size's ⌘=, ⌘- and ⌘0.
        ('=', 0x18),
        ('-', 0x1B),
        ('0', 0x1D),
        (RIGHT_ARROW, 0x7C),
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
    /// The pointer moving with no button held, as for a hover.
    Moved = 5,
    Dragged = 6,
}

/// One left-button mouse event at `position` (GPUI window coordinates).
pub fn send_mouse(native: Native, kind: Mouse, position: Point<Pixels>) -> Result<()> {
    send_mouse_clicks(native, kind, position, 1)
}

/// Close the window as its close button does (`performClose:`), which asks
/// the window's delegate first, so GPUI's should-close handler runs.
pub fn request_close(native: Native) {
    unsafe {
        let _: () = msg_send![native.window, performClose: std::ptr::null_mut::<AnyObject>()];
    }
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

/// A left click on a control in the title bar: the press and release go
/// to GPUI's view, as the move does. Sent through the window, a synthetic
/// press in the title bar's strip is the window's own (AppKit starts a
/// window drag there), and the control under it never sees it.
pub fn send_titlebar_click(native: Native, position: Point<Pixels>) -> Result<()> {
    send_mouse_event(native, Mouse::Down, position, 1, true)?;
    send_mouse_event(native, Mouse::Up, position, 1, true)
}

fn send_mouse_clicks(
    native: Native,
    kind: Mouse,
    position: Point<Pixels>,
    clicks: isize,
) -> Result<()> {
    send_mouse_event(native, kind, position, clicks, false)
}

/// One mouse event; a press or release goes through the window unless
/// `to_view`.
fn send_mouse_event(
    native: Native,
    kind: Mouse,
    position: Point<Pixels>,
    clicks: isize,
    to_view: bool,
) -> Result<()> {
    use std::sync::atomic::{AtomicIsize, Ordering};
    static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);
    let pressure = match kind {
        Mouse::Down | Mouse::Dragged => 1.0f32,
        Mouse::Up | Mouse::Moved => 0.0f32,
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
        match kind {
            // A normal window takes no mouse-moved events itself (GPUI
            // leaves `acceptsMouseMovedEvents` off and tracks the pointer
            // with a tracking area, which calls the view's `mouseMoved:`),
            // so the move goes where the tracking area sends it.
            Mouse::Moved => {
                let _: () = msg_send![native.view, mouseMoved: &*event];
            }
            Mouse::Down if to_view => {
                let _: () = msg_send![native.view, mouseDown: &*event];
            }
            Mouse::Up if to_view => {
                let _: () = msg_send![native.view, mouseUp: &*event];
            }
            _ => {
                let _: () = msg_send![native.window, sendEvent: &*event];
            }
        }
    }
    Ok(())
}

/// A right click at `position` (GPUI window coordinates), which opens a
/// context menu. An `NSEvent` built with `mouseEventWithType:` reports
/// button 0 whatever its type, so GPUI would read it as a left click; this
/// goes through a CoreGraphics event, which names the right button.
pub fn send_right_click(native: Native, position: Point<Pixels>) -> Result<()> {
    const RIGHT_MOUSE_DOWN: u32 = 3;
    const RIGHT_MOUSE_UP: u32 = 4;
    const RIGHT_BUTTON: u32 = 1;
    for kind in [RIGHT_MOUSE_DOWN, RIGHT_MOUSE_UP] {
        unsafe {
            let in_window = to_window(
                native.view,
                f32::from(position.x) as f64,
                f32::from(position.y) as f64,
            );
            let number: isize = msg_send![native.window, windowNumber];
            // As for the wheel: a window-less event's screen location reads
            // as the window point.
            let primary_height = primary_screen_height();
            let location = NSPoint::new(in_window.x, primary_height - in_window.y);
            let event = CGEventCreateMouseEvent(std::ptr::null(), kind, location, RIGHT_BUTTON);
            if event.is_null() {
                return Err(anyhow!("CoreGraphics refused the right-click event"));
            }
            CGEventSetIntegerValueField(event, 91, number as i64); // window under the pointer
            CGEventSetIntegerValueField(event, 92, number as i64); // window that can handle it
            let ns_event: Option<Retained<AnyObject>> =
                msg_send![class!(NSEvent), eventWithCGEvent: event];
            CFRelease(event);
            let ns_event = ns_event.context("NSEvent refused the right-click event")?;
            let _: () = msg_send![native.window, sendEvent: &*ns_event];
        }
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

/// Whether this app is the active one, whose key window takes the keyboard.
pub fn app_is_active() -> bool {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let active: Bool = msg_send![app, isActive];
        active.as_bool()
    }
}

/// Hand activation back to the app that had it, so this one runs in the
/// background, its windows no longer key (`scenario/input_lock.rs`).
pub fn deactivate_app() {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, deactivate];
    }
}

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

/// Remove the private pasteboard from the pasteboard server, as the run ends.
pub fn release_private_pasteboard() {
    let private = PRIVATE_PASTEBOARD.load(std::sync::atomic::Ordering::Relaxed);
    if !private.is_null() {
        unsafe {
            let _: () = msg_send![private, releaseGlobally];
        }
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

/// The system's preferred languages, first choice first, as BCP 47 tags
/// (`navigator.languages` in the Tauri app's web view).
pub fn preferred_languages() -> Vec<String> {
    objc2_foundation::NSLocale::preferredLanguages()
        .iter()
        .map(|language| language.to_string())
        .collect()
}

/// Register the main menu's submenu titled `title` as NSApp's windows menu,
/// so macOS lists the open windows in it whatever the interface language;
/// GPUI registers it only under the English title.
pub fn set_windows_menu(title: &str) {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let main: *mut AnyObject = msg_send![app, mainMenu];
        if main.is_null() {
            return;
        }
        let title = NSString::from_str(title);
        let item: *mut AnyObject = msg_send![main, itemWithTitle: &*title];
        if item.is_null() {
            return;
        }
        let submenu: *mut AnyObject = msg_send![item, submenu];
        if !submenu.is_null() {
            let _: () = msg_send![app, setWindowsMenu: submenu];
        }
    }
}

/// The title of NSApp's windows menu, if one is registered.
pub fn windows_menu_title() -> Option<String> {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let menu: *mut AnyObject = msg_send![app, windowsMenu];
        if menu.is_null() {
            return None;
        }
        let title: Option<Retained<NSString>> = msg_send![menu, title];
        title.map(|title| title.to_string())
    }
}
