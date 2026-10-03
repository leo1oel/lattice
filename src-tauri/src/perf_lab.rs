//! The real-app measurement lab's native half, compiled only with the
//! `perf-lab` Cargo feature (`scripts/perf-lab.mjs` builds it; release builds
//! never contain it).
//!
//! It hands the in-page harness (`src/platform/perf-lab-harness.ts`) its run
//! plan, exposes IPC probes, and drives the WKWebView window with real AppKit
//! input. Every knob is an environment variable the launcher sets, so a lab binary run
//! without them behaves like any other build except for its identifier.

use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send, sel};
use objc2_foundation::{NSPoint, NSRect, NSString};
use serde::Serialize;
use std::ffi::c_void;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, WebviewWindow};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateScrollWheelEvent2(
        source: *const c_void, units: u32, wheel_count: u32, wheel1: i32, wheel2: i32, wheel3: i32,
    ) -> *mut c_void;
    fn CGEventSetLocation(event: *mut c_void, location: NSPoint);
    fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
    fn CFRelease(object: *const c_void);
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

pub(crate) fn enabled() -> bool {
    env("LATTICE_PERF_PLAN").is_some() || env("LATTICE_WK_NOOCC").is_some()
}

pub(crate) fn port() -> Option<u16> {
    env("LATTICE_PERF_PORT").and_then(|port| port.parse().ok())
}

pub(crate) fn project() -> Option<std::path::PathBuf> {
    env("LATTICE_PERF_PROJECT")
        .map(std::path::PathBuf::from)
        .and_then(|path| path.canonicalize().ok())
}

pub(crate) fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// Keep the lab account's never-composited process rendering like a
/// frontmost app: no App Nap.
pub(crate) fn disable_app_nap() {
    if !enabled() {
        return;
    }
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let reason = NSString::from_str("Lattice perf lab");
        // NSActivityUserInitiated | NSActivityLatencyCritical
        let options: u64 = 0x00FF_FFFF | 0xFF_0000_0000;
        let token: *mut AnyObject =
            msg_send![info, beginActivityWithOptions: options, reason: &*reason];
        let _: *mut AnyObject = msg_send![token, retain];
    }
    log::info!(target: "lattice::perf", "app-nap-disabled");
}

unsafe fn set_features(view: *mut AnyObject, names: &[String], enabled: bool) {
    let configuration: *mut AnyObject = msg_send![view, configuration];
    let preferences: *mut AnyObject = msg_send![configuration, preferences];
    let features: *mut AnyObject = msg_send![class!(WKPreferences), _features];
    if features.is_null() {
        return;
    }
    let count: usize = msg_send![features, count];
    for index in 0..count {
        let feature: *mut AnyObject = msg_send![features, objectAtIndex: index];
        let key: *mut AnyObject = msg_send![feature, key];
        let utf8: *const std::os::raw::c_char = msg_send![key, UTF8String];
        let name = std::ffi::CStr::from_ptr(utf8).to_string_lossy();
        if names.iter().any(|wanted| wanted == &*name) {
            let flag = if enabled { Bool::YES } else { Bool::NO };
            let _: () = msg_send![preferences, _setEnabled: flag, forFeature: feature];
            log::info!(target: "lattice::perf", "feature {name} -> {enabled}");
        }
    }
}

/// The lab account's windows are never composited on the console user's
/// screen; keep WebKit rendering as it does for a visible, frontmost window.
pub(crate) fn tune_wkwebview(window: &WebviewWindow) {
    if env("LATTICE_WK_NOOCC").is_none() {
        return;
    }
    let off: Vec<String> = env("LATTICE_WK_FEATURES_OFF")
        .map(|names| names.split(',').map(str::to_string).collect())
        .unwrap_or_default();
    let _ = window.with_webview(move |webview| unsafe {
        let view = webview.inner() as *mut AnyObject;
        let responds: bool =
            msg_send![view, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)];
        if responds {
            let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: Bool::NO];
            log::info!(target: "lattice::perf", "occlusion detection off");
        }
        set_features(view, &off, false);
        let ns_window = webview.ns_window() as *mut AnyObject;
        // Re-order the window in so WebKit recomputes its activity state now
        // that occlusion no longer counts: it read "occluded" at creation.
        let _: () = msg_send![ns_window, orderOut: std::ptr::null_mut::<AnyObject>()];
        let _: () = msg_send![ns_window, orderFrontRegardless];
        let visible: bool = msg_send![ns_window, isVisible];
        let occlusion: usize = msg_send![ns_window, occlusionState];
        log::info!(target: "lattice::perf", "window visible={visible} occlusion={occlusion:#x}");
    });
}

#[derive(Serialize)]
pub struct PerfConfig {
    plan: Option<String>,
    t0: Option<f64>,
    project: Option<String>,
    label: Option<String>,
    flags: Option<String>,
    out: Option<String>,
}

#[tauri::command]
pub fn perf_config() -> PerfConfig {
    PerfConfig {
        plan: env("LATTICE_PERF_PLAN"),
        t0: env("LATTICE_PERF_T0").and_then(|value| value.parse().ok()),
        project: project().map(|path| path.to_string_lossy().into_owned()),
        label: env("LATTICE_PERF_LABEL"),
        flags: env("LATTICE_LAB_FLAGS"),
        out: env("LATTICE_PERF_OUT"),
    }
}

#[tauri::command]
pub fn perf_now() -> f64 {
    epoch_ms()
}

#[tauri::command]
pub fn perf_echo(payload: String) -> String {
    payload
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexlabProbe {
    sync_ms: f64,
    total_ms: f64,
}

/// TexLab's share of a completion, without the IPC that carries the text
/// (`TexlabPool::lab_probe`).
#[tauri::command]
pub async fn perf_texlab_probe(
    state: tauri::State<'_, crate::app_state::AppState>, window: tauri::Window, path: String,
    line: u32, character: u32, mode: String,
) -> Result<TexlabProbe, String> {
    let root = crate::ipc::current_root(&state, &window)?;
    let pool = std::sync::Arc::clone(&state.project(&root).texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool.lock().map_err(|_| "TexLab state is unavailable.".to_string())?;
        let (sync_ms, total_ms) = pool.lab_probe(&root, &path, line, character, &mode)?;
        Ok(TexlabProbe { sync_ms, total_ms })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn perf_bytes(len: usize) -> tauri::ipc::Response {
    tauri::ipc::Response::new(vec![7u8; len])
}

#[tauri::command]
pub fn perf_write(name: String, content: String) -> Result<(), String> {
    let out = env("LATTICE_PERF_OUT").ok_or("LATTICE_PERF_OUT unset")?;
    if name.contains('/') || name.starts_with('.') {
        return Err("bad name".into());
    }
    std::fs::write(std::path::Path::new(&out).join(name), content).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Tick {
    seq: u32,
    sent_at: f64,
    pad: String,
}

#[tauri::command]
pub fn perf_emit(app: tauri::AppHandle, count: u32, interval_ms: u64, size: usize) {
    std::thread::spawn(move || {
        let pad = "x".repeat(size);
        for seq in 0..count {
            let _ = app.emit("perf-tick", Tick { seq, sent_at: epoch_ms(), pad: pad.clone() });
            std::thread::sleep(Duration::from_millis(interval_ms));
        }
    });
}

#[derive(Serialize, Clone)]
struct Magnify {
    magnification: f64,
    x: f64,
    y: f64,
}

/// The trackpad pinch path: the same event the AppKit magnify monitor emits
/// (macos_window::install_magnify_monitor), to the same window.
#[tauri::command]
pub async fn perf_magnify(
    window: WebviewWindow, steps: u32, magnification: f64, x: f64, y: f64, interval_ms: u64,
) -> f64 {
    let sent = epoch_ms();
    for step in 0..steps {
        let _ = window.emit_to(window.label(), "trackpad-magnify", Magnify { magnification, x, y });
        if step + 1 < steps {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
        }
    }
    sent
}

/// Run `f(nswindow, wkwebview)` on the main thread and wait for its result.
fn on_main<T: Send + 'static>(
    window: &WebviewWindow, f: impl FnOnce(*mut AnyObject, *mut AnyObject) -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let view = webview.inner() as *mut AnyObject;
            let ns_window = webview.ns_window() as *mut AnyObject;
            let _ = sender.send(f(ns_window, view));
        })
        .map_err(|e| e.to_string())?;
    receiver.recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())
}

unsafe fn uptime() -> f64 {
    let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
    msg_send![info, systemUptime]
}

/// Page CSS pixels (top-left origin) → window coordinates (bottom-left).
unsafe fn to_window(view: *mut AnyObject, x: f64, y: f64) -> NSPoint {
    let flipped: bool = msg_send![view, isFlipped];
    let bounds: NSRect = msg_send![view, bounds];
    let local = if flipped { NSPoint::new(x, y) } else { NSPoint::new(x, bounds.size.height - y) };
    msg_send![view, convertPoint: local, toView: std::ptr::null_mut::<AnyObject>()]
}

/// Window coordinates → global CoreGraphics coordinates (top-left origin of the primary display).
unsafe fn to_global(ns_window: *mut AnyObject, point: NSPoint) -> NSPoint {
    let screen_point: NSPoint = msg_send![ns_window, convertPointToScreen: point];
    let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
    let count: usize = if screens.is_null() { 0 } else { msg_send![screens, count] };
    let height = if count > 0 {
        let primary: *mut AnyObject = msg_send![screens, objectAtIndex: 0usize];
        let frame: NSRect = msg_send![primary, frame];
        frame.size.height
    } else {
        0.0
    };
    NSPoint::new(screen_point.x, height - screen_point.y)
}

#[derive(Serialize)]
pub struct FocusState {
    key: bool,
    first_responder_is_webview: bool,
}

#[tauri::command]
pub async fn perf_focus(window: WebviewWindow) -> Result<FocusState, String> {
    on_main(&window, |ns_window, view| unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, activateIgnoringOtherApps: Bool::YES];
        let _: () = msg_send![ns_window, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
        let _: Bool = msg_send![ns_window, makeFirstResponder: view];
        let key: bool = msg_send![ns_window, isKeyWindow];
        let responder: *mut AnyObject = msg_send![ns_window, firstResponder];
        FocusState { key, first_responder_is_webview: responder == view }
    })
}

fn key_code(character: char) -> u16 {
    const LETTERS: &[(char, u16)] = &[
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
    ];
    LETTERS
        .iter()
        .find(|(c, _)| *c == character.to_ascii_lowercase())
        .map(|(_, code)| *code)
        .unwrap_or(0)
}

/// Type `text` through AppKit: one keyDown + keyUp NSEvent per character,
/// sent to the window like the window server's events. Returns the epoch ms
/// of the first send.
#[tauri::command]
pub async fn perf_key(window: WebviewWindow, text: String) -> Result<f64, String> {
    on_main(&window, move |ns_window, _view| unsafe {
        let number: isize = msg_send![ns_window, windowNumber];
        let mut first = 0.0;
        for character in text.chars() {
            let chars = if character == '\n' { "\r".to_string() } else { character.to_string() };
            let chars = NSString::from_str(&chars);
            let code = key_code(character);
            if first == 0.0 {
                first = epoch_ms();
            }
            for kind in [10usize, 11usize] {
                let event: *mut AnyObject = msg_send![class!(NSEvent),
                    keyEventWithType: kind,
                    location: NSPoint::new(0.0, 0.0),
                    modifierFlags: 0usize,
                    timestamp: uptime(),
                    windowNumber: number,
                    context: std::ptr::null_mut::<AnyObject>(),
                    characters: &*chars,
                    charactersIgnoringModifiers: &*chars,
                    isARepeat: Bool::NO,
                    keyCode: code];
                if !event.is_null() {
                    let _: () = msg_send![ns_window, sendEvent: event];
                }
            }
        }
        first
    })
}

#[derive(Serialize)]
pub struct WheelSent {
    sent: f64,
    global: (f64, f64),
    window: (f64, f64),
    direct: bool,
    has_window: bool,
    event_point: (f64, f64),
}

/// One precise (trackpad-like, pixel) scroll-wheel event at page point
/// (`x`, `y`): through the window (`direct` false) or straight to the WKWebView.
#[tauri::command]
pub async fn perf_wheel(
    window: WebviewWindow, x: f64, y: f64, dy: i32, phase: Option<i64>, direct: Option<bool>,
) -> Result<WheelSent, String> {
    let direct = direct.unwrap_or(false);
    on_main(&window, move |ns_window, view| unsafe {
        let in_window = to_window(view, x, y);
        let global = to_global(ns_window, in_window);
        let number: isize = msg_send![ns_window, windowNumber];
        let event = CGEventCreateScrollWheelEvent2(std::ptr::null(), 0, 1, dy, 0, 0);
        // A window-less NSEvent reports its screen location as locationInWindow,
        // which WKWebView hit-tests with; place it where the window point is.
        let primary_height = to_global(ns_window, NSPoint::new(0.0, 0.0)).y + {
            let screen_point: NSPoint =
                msg_send![ns_window, convertPointToScreen: NSPoint::new(0.0, 0.0)];
            screen_point.y
        };
        let location =
            if direct { NSPoint::new(in_window.x, primary_height - in_window.y) } else { global };
        CGEventSetLocation(event, location);
        CGEventSetIntegerValueField(event, 88, 1); // kCGScrollWheelEventIsContinuous
        CGEventSetIntegerValueField(event, 91, number as i64); // window under pointer
        CGEventSetIntegerValueField(event, 92, number as i64); // …that can handle it
        if let Some(phase) = phase.filter(|phase| *phase != 0) {
            CGEventSetIntegerValueField(event, 99, phase); // kCGScrollWheelEventScrollPhase
        }
        let ns_event: *mut AnyObject = msg_send![class!(NSEvent), eventWithCGEvent: event];
        let (has_window, event_point) = if ns_event.is_null() {
            (false, NSPoint::new(-1.0, -1.0))
        } else {
            let event_window: *mut AnyObject = msg_send![ns_event, window];
            let point: NSPoint = msg_send![ns_event, locationInWindow];
            (!event_window.is_null(), point)
        };
        let sent = epoch_ms();
        if !ns_event.is_null() {
            if direct {
                let _: () = msg_send![view, scrollWheel: ns_event];
            } else {
                let _: () = msg_send![ns_window, sendEvent: ns_event];
            }
        }
        CFRelease(event);
        WheelSent {
            sent,
            global: (global.x, global.y),
            window: (in_window.x, in_window.y),
            direct,
            has_window,
            event_point: (event_point.x, event_point.y),
        }
    })
}

static EVENT_NUMBER: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(1);

unsafe fn mouse_event(
    ns_window: *mut AnyObject, view: *mut AnyObject, kind: usize, x: f64, y: f64,
) {
    let location = to_window(view, x, y);
    let number: isize = msg_send![ns_window, windowNumber];
    let pressure: f32 = if kind == 1 || kind == 6 { 1.0 } else { 0.0 };
    let click: isize = if kind == 1 || kind == 2 { 1 } else { 0 };
    let event: *mut AnyObject = msg_send![class!(NSEvent),
        mouseEventWithType: kind,
        location: location,
        modifierFlags: 0usize,
        timestamp: uptime(),
        windowNumber: number,
        context: std::ptr::null_mut::<AnyObject>(),
        eventNumber: EVENT_NUMBER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        clickCount: click,
        pressure: pressure];
    if !event.is_null() {
        let _: () = msg_send![ns_window, sendEvent: event];
    }
}

/// Press at the first point, drag through the rest, release at the last,
/// `interval_ms` apart. A single point is a click. Returns the epoch ms of the press.
#[tauri::command]
pub async fn perf_mouse(
    window: WebviewWindow, points: Vec<(f64, f64)>, interval_ms: u64,
) -> Result<f64, String> {
    let Some(&(x0, y0)) = points.first() else {
        return Err("no points".into());
    };
    let started = on_main(&window, move |ns_window, view| unsafe {
        mouse_event(ns_window, view, 5, x0, y0); // moved
        let started = epoch_ms();
        mouse_event(ns_window, view, 1, x0, y0); // left down
        started
    })?;
    for (index, &(x, y)) in points.iter().enumerate().skip(1) {
        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
        let last = index + 1 == points.len();
        on_main(&window, move |ns_window, view| unsafe {
            mouse_event(ns_window, view, 6, x, y); // left dragged
            if last {
                mouse_event(ns_window, view, 2, x, y); // left up
            }
        })?;
    }
    if points.len() == 1 {
        on_main(&window, move |ns_window, view| unsafe {
            mouse_event(ns_window, view, 2, x0, y0)
        })?;
    }
    Ok(started)
}
