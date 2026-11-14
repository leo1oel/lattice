//! Native Windows input for the scripted runs: the same calls as the macOS
//! `native` module, made with window messages.
//!
//! Keys are posted to the window's message queue, because GPUI reads key-down
//! messages in its own message loop (`translate_accelerator`) before any
//! window procedure sees them, and only an unhandled key goes on to
//! `TranslateMessage` and becomes the `WM_CHAR` that inserts text. That is the
//! path a typed key takes. GPUI reads modifiers with `GetKeyState`, which a
//! posted message does not update, so `send_key` sets the GUI thread's
//! keyboard state first and the caller lifts it with `release_keys` once the
//! loop has handled the key.
//!
//! Mouse messages are handled by the window procedure, so they are sent to it
//! directly and handled before `send_mouse` returns, like `sendEvent:` on
//! macOS. Neither needs the window in front or the console unlocked. The
//! wheel goes the same way, in the screen coordinates its message carries.

use std::time::Duration;

use anyhow::{Result, anyhow};
use gpui::{Pixels, Point, Window};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::{
    Foundation::{HWND, LPARAM, POINT, WPARAM},
    Graphics::Gdi::ClientToScreen,
    UI::{
        Input::KeyboardAndMouse::{
            GetKeyboardState, MAPVK_VK_TO_VSC, MapVirtualKeyW, SetKeyboardState, VK_CONTROL,
            VK_ESCAPE, VK_LCONTROL, VK_LSHIFT, VK_RETURN, VK_RIGHT, VK_SHIFT, VkKeyScanW,
        },
        WindowsAndMessaging::{
            PostMessageW, SendMessageW, SetForegroundWindow, WM_CLOSE, WM_KEYDOWN, WM_KEYUP,
            WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
            WM_RBUTTONUP,
        },
    },
};

/// How long GPUI's message loop gets to take a posted key off the queue,
/// translate it and handle the `WM_CHAR` that follows.
pub const QUEUE_SETTLE: Duration = Duration::from_millis(50);

/// `MK_LBUTTON` in a mouse message's `wParam`: the left button is down.
const LEFT_BUTTON_DOWN: usize = 0x0001;
/// `MK_RBUTTON`: the right button is down.
const RIGHT_BUTTON_DOWN: usize = 0x0002;
/// The high bit of a key's entry in the keyboard state: the key is down.
const KEY_DOWN_STATE: u8 = 0x80;

/// The window GPUI draws into, and its scale factor. Valid while the GPUI
/// window is open.
#[derive(Clone, Copy)]
pub struct Native {
    hwnd: HWND,
    scale: f32,
}

pub fn native(window: &Window) -> Result<Native> {
    let handle = HasWindowHandle::window_handle(window).map_err(|error| anyhow!("{error}"))?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err(anyhow!("not a Win32 window"));
    };
    Ok(Native {
        hwnd: HWND(handle.hwnd.get() as *mut _),
        scale: window.scale_factor(),
    })
}

/// The → key, spelled as the macOS runs spell it, so a scenario sends it
/// the same way on both.
pub const RIGHT_ARROW: char = '\u{f703}';

/// Posts a key press and release for `character`, with Ctrl held when
/// `command` (Windows' shortcut modifier, where macOS has ⌘). Call
/// `release_keys` after `QUEUE_SETTLE`.
pub fn send_key(native: Native, character: char, command: bool) -> Result<()> {
    // Escape and Enter are their own keys: the layout would type the
    // control characters with Ctrl ([ and J).
    let (virtual_key, shift) = match character {
        '\u{1b}' => (u32::from(VK_ESCAPE.0), false),
        '\n' | '\r' => (u32::from(VK_RETURN.0), false),
        RIGHT_ARROW => (u32::from(VK_RIGHT.0), false),
        _ => {
            let mut units = [0u16; 2];
            let [unit] = character.encode_utf16(&mut units) else {
                return Err(anyhow!("{character:?} is not one UTF-16 unit"));
            };
            // The low byte is the virtual key of the current layout; bit 0
            // of the high byte says the character needs Shift.
            let scan = unsafe { VkKeyScanW(*unit) };
            if scan == -1 {
                return Err(anyhow!("{character:?} has no key on this keyboard layout"));
            }
            ((scan & 0xff) as u32, scan & 0x100 != 0)
        }
    };

    let mut state = [0u8; 256];
    unsafe { GetKeyboardState(&mut state)? };
    for (key, down) in [
        (VK_SHIFT, shift),
        (VK_LSHIFT, shift),
        (VK_CONTROL, command),
        (VK_LCONTROL, command),
    ] {
        state[key.0 as usize] = if down { KEY_DOWN_STATE } else { 0 };
    }
    unsafe { SetKeyboardState(&state)? };

    // lParam: repeat count 1 and the scan code; a release also sets the
    // previous-state and transition bits.
    let scan_code = unsafe { MapVirtualKeyW(virtual_key, MAPVK_VK_TO_VSC) } as isize;
    let down = LPARAM(1 | (scan_code << 16));
    let up = LPARAM(1 | (scan_code << 16) | (1 << 30) | (1 << 31));
    unsafe {
        PostMessageW(
            Some(native.hwnd),
            WM_KEYDOWN,
            WPARAM(virtual_key as usize),
            down,
        )?;
        PostMessageW(
            Some(native.hwnd),
            WM_KEYUP,
            WPARAM(virtual_key as usize),
            up,
        )?;
    }
    Ok(())
}

/// Lifts the modifiers `send_key` pressed.
pub fn release_keys() -> Result<()> {
    let mut state = [0u8; 256];
    unsafe { GetKeyboardState(&mut state)? };
    for key in [VK_SHIFT, VK_LSHIFT, VK_CONTROL, VK_LCONTROL] {
        state[key.0 as usize] = 0;
    }
    unsafe { SetKeyboardState(&state)? };
    Ok(())
}

pub enum Mouse {
    Down,
    Up,
    /// The right button, which opens a context menu.
    RightDown,
    RightUp,
    /// The pointer moving with no button held, as for a hover.
    Moved,
    Dragged,
}

/// A left-button mouse message at `position` in window coordinates.
pub fn send_mouse(native: Native, kind: Mouse, position: Point<Pixels>) -> Result<()> {
    let (message, buttons) = match kind {
        Mouse::Down => (WM_LBUTTONDOWN, LEFT_BUTTON_DOWN),
        Mouse::Dragged => (WM_MOUSEMOVE, LEFT_BUTTON_DOWN),
        Mouse::Moved => (WM_MOUSEMOVE, 0),
        Mouse::Up => (WM_LBUTTONUP, 0),
        Mouse::RightDown => (WM_RBUTTONDOWN, RIGHT_BUTTON_DOWN),
        Mouse::RightUp => (WM_RBUTTONUP, 0),
    };
    // Client coordinates in device pixels, packed as two signed 16-bit words.
    let x = (f32::from(position.x) * native.scale).round() as i16 as u16 as isize;
    let y = (f32::from(position.y) * native.scale).round() as i16 as u16 as isize;
    unsafe {
        SendMessageW(
            native.hwnd,
            message,
            Some(WPARAM(buttons)),
            Some(LPARAM(x | (y << 16))),
        );
    }
    Ok(())
}

/// One wheel turn of `dy` at `position` in window coordinates, negative
/// scrolling the content down as on macOS. `dy` is the wheel delta, 120 to a
/// notch, which GPUI turns into lines (`-200` is five at the default three a
/// notch) where macOS counts pixels; the scenarios ask only that the text
/// moved. Unlike the other mouse messages, `WM_MOUSEWHEEL` carries screen
/// coordinates, which GPUI maps back into the window.
pub fn send_wheel(native: Native, position: Point<Pixels>, dy: i32) -> Result<()> {
    let mut point = POINT {
        x: (f32::from(position.x) * native.scale).round() as i32,
        y: (f32::from(position.y) * native.scale).round() as i32,
    };
    unsafe { ClientToScreen(native.hwnd, &mut point).ok()? };
    // wParam: the delta in the high word; lParam: x and y, each a signed
    // 16-bit word.
    let delta = i16::try_from(dy).map_err(|_| anyhow!("wheel delta {dy} is out of range"))?;
    let wparam = WPARAM((delta as u16 as usize) << 16);
    let lparam =
        LPARAM((point.x as i16 as u16 as isize) | ((point.y as i16 as u16 as isize) << 16));
    unsafe {
        SendMessageW(native.hwnd, WM_MOUSEWHEEL, Some(wparam), Some(lparam));
    }
    Ok(())
}

/// A left click at `position`.
pub fn send_click(native: Native, position: Point<Pixels>) -> Result<()> {
    send_mouse(native, Mouse::Down, position)?;
    send_mouse(native, Mouse::Up, position)
}

/// A left click on a control in the title bar. The messages go straight to
/// the window's client handler, as everywhere else, so this is a plain click.
pub fn send_titlebar_click(native: Native, position: Point<Pixels>) -> Result<()> {
    send_click(native, position)
}

/// A right click at `position`, which opens a context menu.
pub fn send_right_click(native: Native, position: Point<Pixels>) -> Result<()> {
    send_mouse(native, Mouse::RightDown, position)?;
    send_mouse(native, Mouse::RightUp, position)
}

/// A left double click at `position`: GPUI counts two presses close in time
/// and place as one double click, as Windows does.
pub fn send_double_click(native: Native, position: Point<Pixels>) -> Result<()> {
    for _ in 0..2 {
        send_mouse(native, Mouse::Down, position)?;
        send_mouse(native, Mouse::Up, position)?;
    }
    Ok(())
}

/// Close the window as its close button does: `WM_CLOSE`, which GPUI hands
/// to the window's should-close handler before destroying it.
pub fn request_close(native: Native) {
    unsafe {
        SendMessageW(native.hwnd, WM_CLOSE, None, None);
    }
}

pub fn bring_to_front(native: Native) {
    unsafe {
        let _ = SetForegroundWindow(native.hwnd);
    }
}

/// The scenario's foreground sections (`scenario/input_lock.rs`) matter on
/// macOS only; the Windows runner has the machine to itself, so the app never
/// reads as active outside one.
pub fn app_is_active() -> bool {
    false
}

/// See `app_is_active`.
pub fn deactivate_app() {}

/// The Windows runner has the machine, and its clipboard, to itself.
pub fn release_private_pasteboard() {}

/// macOS opts out of App Nap here; Windows does not throttle the window.
pub fn begin_latency_critical_activity() {}
