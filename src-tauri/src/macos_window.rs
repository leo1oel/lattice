//! macOS window chrome helpers: traffic lights, window backing colors, AppKit
//! event monitors (pinch, Command-C), the screen color sampler, and quarantine
//! cleanup.

use block2::RcBlock;
use objc2_app_kit::{NSColor, NSEvent, NSEventMask, NSWindow};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::ptr::NonNull;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

static PDF_COPY_TEXT: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static FOCUSED_WINDOW_LABEL: Mutex<Option<String>> = Mutex::new(None);

const LIGHT_WINDOW_BACKGROUND: (f64, f64, f64) = (247.0, 247.0, 246.0);
const DARK_WINDOW_BACKGROUND: (f64, f64, f64) = (23.0, 23.0, 24.0);
/// The center AppKit itself gives the buttons in a unified-compact titlebar,
/// which is exactly as tall as the web titlebar (`--titlebar-height: 40px`).
const DEFAULT_TRAFFIC_LIGHT_CENTER_FROM_TOP: f64 = 20.0;
static TRAFFIC_LIGHT_CENTER_FROM_TOP: Mutex<f64> =
    Mutex::new(DEFAULT_TRAFFIC_LIGHT_CENTER_FROM_TOP);
/// Longer than AppKit's full-screen transition, after which a window that is
/// still not in full screen failed to get there.
const FULL_SCREEN_SETTLE: Duration = Duration::from_secs(2);

/// Payload of the `trackpad-magnify` event the web UI listens for.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MagnifyEvent {
    /// Incremental scale change for this tick: 0.02 means "2% bigger".
    magnification: f64,
    /// Cursor position in CSS pixels from the top-left of the web view, so the
    /// page can decide whether the pinch happened over the PDF.
    x: f64,
    y: f64,
}

/// Observe AppKit events for the app's lifetime. The handler returns the
/// event to let it continue on its way, or null to consume it.
fn add_local_monitor(mask: NSEventMask, handler: impl Fn(&NSEvent) -> bool + 'static) {
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands us a live event for the duration of the block.
        if handler(unsafe { event.as_ref() }) {
            event.as_ptr()
        } else {
            std::ptr::null_mut()
        }
    });
    // SAFETY: the block matches the documented handler signature, and we keep
    // the returned monitor alive for the process lifetime on purpose.
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
    std::mem::forget(monitor);
    std::mem::forget(block);
}

/// Forward trackpad pinches to the web UI.
///
/// A pinch never reaches JavaScript in this webview: WebKit's `gesture*` events
/// are not delivered here, and WKWebView only emits `ctrl`+wheel for pinches in
/// a browser, not embedded. AppKit still sees the raw `NSEventTypeMagnify`
/// though, so we watch for it below WebKit and hand the delta to the page,
/// which is what makes pinch-to-zoom work on the PDF.
pub fn install_magnify_monitor(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};

    add_local_monitor(NSEventMask::Magnify, move |event| {
        let magnification = event.magnification();
        if magnification == 0.0 {
            return true;
        }
        let Some(window) = app.get_webview_window("main") else {
            return true;
        };
        // NSEvent reports window coordinates with a bottom-left origin; the
        // page wants top-left CSS pixels.
        let location = event.locationInWindow();
        let (x, y) = window
            .inner_size()
            .ok()
            .zip(window.scale_factor().ok())
            .map(|(size, scale)| (location.x, size.height as f64 / scale - location.y))
            .unwrap_or((location.x, location.y));
        let _ = window.emit("trackpad-magnify", MagnifyEvent { magnification, x, y });
        true
    });
}

/// Keep the selected PDF text close to AppKit's Command-C handler.
///
/// The frontend updates this only after a PDF drag and clears it when that
/// selection loses ownership. Other platforms copy in the webview directly.
#[tauri::command]
pub fn set_pdf_copy_text(window: tauri::WebviewWindow, text: Option<String>) {
    let mut selections = PDF_COPY_TEXT.lock().unwrap();
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        selections.insert(window.label().to_string(), text);
    } else {
        selections.remove(window.label());
    }
}

pub fn clear_pdf_copy_text(window_label: &str) {
    PDF_COPY_TEXT.lock().unwrap().remove(window_label);
    set_window_focused(window_label, false);
}

pub fn set_window_focused(window_label: &str, is_focused: bool) {
    let mut focused = FOCUSED_WINDOW_LABEL.lock().unwrap();
    if is_focused {
        *focused = Some(window_label.to_string());
    } else if focused.as_deref() == Some(window_label) {
        *focused = None;
    }
}

/// AppKit consumes Command-C as an Edit-menu key equivalent before WKWebView's
/// JavaScript listeners run. If the active window owns a PDF selection, write
/// its synchronized glyph text here and consume the event so native copying of
/// transparent text cannot overwrite the clipboard with an empty string.
pub fn install_copy_shortcut_monitor(app: tauri::AppHandle) {
    use objc2_app_kit::NSEventModifierFlags as Flags;
    use tauri_plugin_clipboard_manager::ClipboardExt;

    add_local_monitor(NSEventMask::KeyDown, move |pressed| {
        let modifiers = pressed.modifierFlags();
        if !modifiers.contains(Flags::Command)
            || modifiers.intersects(Flags::Shift | Flags::Option | Flags::Control)
        {
            return true;
        }
        let is_c = pressed.keyCode() == 8
            || pressed
                .charactersIgnoringModifiers()
                .is_some_and(|characters| characters.to_string().eq_ignore_ascii_case("c"));
        if !is_c {
            return true;
        }
        // Physical key events are not guaranteed to carry `NSEvent.window`.
        // Window events maintain this label outside AppKit's key callback, so
        // reading it here cannot synchronously call back into Tauri's event loop.
        let Some(window_label) = FOCUSED_WINDOW_LABEL.lock().unwrap().clone() else {
            return true;
        };
        let Some(text) = PDF_COPY_TEXT.lock().unwrap().get(&window_label).cloned() else {
            return true;
        };
        match app.clipboard().write_text(text) {
            Ok(()) => false,
            Err(error) => {
                log::warn!(target: "lattice::pdf", "Could not copy selected PDF text: {error}");
                true
            }
        }
    });
}

/// The window's NSWindow pointer as an address that can cross threads.
fn ns_window_address(window: &tauri::WebviewWindow) -> Option<usize> {
    window.ns_window().ok().filter(|pointer| !pointer.is_null()).map(|pointer| pointer as usize)
}

/// Align the native traffic-light centers with the measured web titlebar.
///
/// The window gets an empty unified-compact toolbar, so AppKit itself lays the
/// titlebar out 40 pt tall with the buttons at the native compact-toolbar
/// position (x 12, centered 20 pt from the top), the same place Finder, Notes
/// or Safari with a compact toolbar put them. That is exactly the web
/// titlebar's center at the default interface scale, so nothing is moved and
/// every AppKit relayout (activation, hover, resize, full screen) lands where
/// it should. Moving the buttons ourselves at 100% fought those relayouts: a
/// pass that caught AppKit halfway through re-spaced and re-leveled them from
/// half-moved frames, and anything missed showed the 32 pt default, 4 pt high.
/// Only a zoomed interface, whose titlebar row is taller or shorter, still
/// shifts them, vertically only.
pub fn install_traffic_light_alignment(window: &tauri::WebviewWindow) {
    install_compact_toolbar(window);
    let _ = measure_traffic_light_alignment(window);
    install_traffic_light_layout_observers(window);

    // AppKit performs a final titlebar layout after the window first appears.
    // Re-read the native frames after that pass instead of assuming the first
    // hierarchy survives unchanged.
    let delayed = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        let _ = measure_traffic_light_alignment(&delayed);
    });
}

/// Give the window the empty compact toolbar that makes AppKit's own titlebar
/// geometry match the web titlebar, and take it away for full screen.
///
/// A toolbar stays on screen in full screen unless the window asks AppKit to
/// auto-hide it, and tao owns the delegate that answers that. Full screen has
/// no traffic lights beside the web titlebar to align anyway, so the window
/// simply goes back to its plain overlay titlebar there, and gets the toolbar
/// back when it leaves full screen or never makes it in. The toolbar is empty
/// and the titlebar transparent: it draws nothing, and hit-testing still hands
/// every click in the row to the web view.
fn install_compact_toolbar(window: &tauri::WebviewWindow) {
    let Some(address) = ns_window_address(window) else {
        return;
    };
    let handle = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        use objc2::rc::Retained;
        use objc2_app_kit::{
            NSWindowDidExitFullScreenNotification, NSWindowStyleMask,
            NSWindowWillEnterFullScreenNotification,
        };
        use objc2_foundation::{NSNotification, NSNotificationCenter};

        attach_compact_toolbar(&*(address as *const NSWindow));
        let center = NSNotificationCenter::defaultCenter();
        let window = &*(address as *const NSWindow);
        let on_enter = RcBlock::new(move |notification: NonNull<NSNotification>| {
            if let Some(object) = notification.as_ref().object() {
                (*(Retained::as_ptr(&object) as *const NSWindow)).setToolbar(None);
            }
            // A failed entry posts no notification (only tao's window delegate
            // hears it) and leaves the window windowed without its toolbar.
            // The full-screen style bit is set for the whole transition, so a
            // window without it once the transition is over never got there.
            // Attaching the toolbar re-lays the titlebar out, which realigns
            // the lights of a window that has alignment observers.
            let handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(FULL_SCREEN_SETTLE);
                let Some(address) = ns_window_address(&handle) else {
                    return;
                };
                let _ = handle.run_on_main_thread(move || {
                    let window = &*(address as *const NSWindow);
                    if !window.styleMask().contains(NSWindowStyleMask::FullScreen) {
                        attach_compact_toolbar(window);
                    }
                });
            });
        });
        // Registered before the alignment observers, which realign after it.
        let on_exit = RcBlock::new(|notification: NonNull<NSNotification>| {
            if let Some(object) = notification.as_ref().object() {
                attach_compact_toolbar(&*(Retained::as_ptr(&object) as *const NSWindow));
            }
        });
        for (name, block) in [
            (NSWindowWillEnterFullScreenNotification, &on_enter),
            (NSWindowDidExitFullScreenNotification, &on_exit),
        ] {
            std::mem::forget(center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(window),
                None,
                block,
            ));
        }
    });
}

unsafe fn attach_compact_toolbar(window: &NSWindow) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSToolbar, NSWindowToolbarStyle};

    if window.toolbar().is_some() {
        return;
    }
    let toolbar = NSToolbar::new(MainThreadMarker::new_unchecked());
    window.setToolbar(Some(&toolbar));
    window.setToolbarStyle(NSWindowToolbarStyle::UnifiedCompact);
}

/// Re-apply the alignment from inside AppKit's own layout passes.
///
/// Positioning the buttons is a one-shot write that the next titlebar layout
/// undoes, and a live resize runs that layout on every frame of the drag. A
/// realign driven from the web side can only run after the gesture settles, so
/// the buttons sat visibly at their default top-left corner for as long as the
/// user held the mouse and jumped back on release. These observers fire on the
/// main thread as part of the same pass that displaced them, which is early
/// enough that the default position is never presented.
fn install_traffic_light_layout_observers(window: &tauri::WebviewWindow) {
    let Some(address) = ns_window_address(window) else {
        return;
    };
    let _ = window.run_on_main_thread(move || unsafe {
        use objc2::rc::Retained;
        use objc2_app_kit::{
            NSView, NSViewFrameDidChangeNotification, NSWindowButton,
            NSWindowDidBecomeKeyNotification, NSWindowDidChangeBackingPropertiesNotification,
            NSWindowDidExitFullScreenNotification, NSWindowDidResignKeyNotification,
            NSWindowDidResizeNotification,
        };
        use objc2_foundation::{NSNotification, NSNotificationCenter};

        let window = &*(address as *const NSWindow);
        let center = NSNotificationCenter::defaultCenter();

        // Each block reads its subject back out of the notification instead of
        // capturing a pointer: the observers are never removed, so a captured
        // window could outlive the object it points at.
        let on_resize = RcBlock::new(move |notification: NonNull<NSNotification>| {
            if let Some(object) = notification.as_ref().object() {
                let _ =
                    align_traffic_lights_on_main(&*(Retained::as_ptr(&object) as *const NSWindow));
            }
        });
        // Resizing is not the only titlebar layout: becoming or resigning key,
        // leaving full screen and a backing-scale change each re-lay the
        // buttons out at AppKit's default position without any resize.
        for name in [
            NSWindowDidResizeNotification,
            NSWindowDidBecomeKeyNotification,
            NSWindowDidResignKeyNotification,
            NSWindowDidExitFullScreenNotification,
            NSWindowDidChangeBackingPropertiesNotification,
        ] {
            std::mem::forget(center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(window),
                None,
                &on_resize,
            ));
        }

        // The window notification alone leaves a race: AppKit may lay the
        // titlebar out after posting it. The container's own frame change is
        // posted by that layout, so it is the pass that would otherwise win.
        // Moving the buttons cannot re-enter here — a subview's origin does not
        // change its superview's frame.
        let Some(superview) = window
            .standardWindowButton(NSWindowButton::CloseButton)
            .and_then(|button| button.superview())
        else {
            return;
        };
        let on_layout = RcBlock::new(move |notification: NonNull<NSNotification>| {
            let Some(object) = notification.as_ref().object() else {
                return;
            };
            let view = &*(Retained::as_ptr(&object) as *const NSView);
            if let Some(window) = view.window() {
                let _ = align_traffic_lights_on_main(&window);
            }
        });
        std::mem::forget(center.addObserverForName_object_queue_usingBlock(
            Some(NSViewFrameDidChangeNotification),
            Some(&superview),
            None,
            &on_layout,
        ));

        // AppKit can also move a button back without touching its container
        // (the titlebar re-lays itself out on activation and hover on recent
        // macOS). Each button's own frame change catches that; the alignment
        // skips buttons already in place and ignores its own writes, so this
        // cannot loop.
        let on_button = RcBlock::new(move |notification: NonNull<NSNotification>| {
            let Some(object) = notification.as_ref().object() else {
                return;
            };
            let view = &*(Retained::as_ptr(&object) as *const NSView);
            if let Some(window) = view.window() {
                let _ = align_traffic_lights_on_main(&window);
            }
        });
        for kind in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            if let Some(button) = window.standardWindowButton(kind) {
                button.setPostsFrameChangedNotifications(true);
                std::mem::forget(center.addObserverForName_object_queue_usingBlock(
                    Some(NSViewFrameDidChangeNotification),
                    Some(&button),
                    None,
                    &on_button,
                ));
            }
        }
    });
}

thread_local! {
    /// Set while the alignment moves the buttons, so the frame-change
    /// notifications those moves post do not re-enter it.
    static ALIGNING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Apply a web-measured vertical center in AppKit logical points.
///
/// Returns the zoom (green) button's right edge in window logical points so the
/// web titlebar can center chrome between that edge and the project switcher.
pub fn align_traffic_lights_to(window: &tauri::WebviewWindow, center_from_top: f64) -> Option<f64> {
    if !center_from_top.is_finite() || center_from_top < 0.0 {
        return None;
    }
    if let Ok(mut target) = TRAFFIC_LIGHT_CENTER_FROM_TOP.lock() {
        *target = center_from_top;
    }
    measure_traffic_light_alignment(window)
}

fn measure_traffic_light_alignment(window: &tauri::WebviewWindow) -> Option<f64> {
    let address = ns_window_address(window)?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let _ = window.run_on_main_thread(move || {
        let right = unsafe { align_traffic_lights_on_main(&*(address as *const NSWindow)) };
        let _ = tx.send(right);
    });
    rx.recv_timeout(Duration::from_millis(500)).ok().flatten()
}

unsafe fn align_traffic_lights_on_main(window: &NSWindow) -> Option<f64> {
    if ALIGNING.with(|flag| flag.replace(true)) {
        return None;
    }
    let right = align_traffic_light_buttons(window);
    ALIGNING.with(|flag| flag.set(false));
    right
}

unsafe fn align_traffic_light_buttons(window: &NSWindow) -> Option<f64> {
    use objc2_app_kit::{NSView, NSWindowButton};
    use objc2_foundation::NSPoint;

    let close = window.standardWindowButton(NSWindowButton::CloseButton)?;
    let miniaturize = window.standardWindowButton(NSWindowButton::MiniaturizeButton)?;
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton)?;
    let button_superview = close.superview()?;

    let center_from_top = TRAFFIC_LIGHT_CENTER_FROM_TOP
        .lock()
        .map_or(DEFAULT_TRAFFIC_LIGHT_CENTER_FROM_TOP, |target| *target);
    let center_y_in_window = window.frame().size.height - center_from_top;

    // Vertical only: AppKit's x positions and spacing are the native ones, and
    // each button is corrected from its own frame, so a pass that runs while
    // AppKit is mid-layout cannot copy one button's stale spacing onto another.
    for button in [close, miniaturize, zoom.clone()] {
        let frame = NSView::frame(&button);
        let current = button_superview.convertPoint_toView(
            NSPoint::new(frame.origin.x, frame.origin.y + frame.size.height / 2.0),
            None,
        );
        let desired = button_superview
            .convertPoint_fromView(NSPoint::new(current.x, center_y_in_window), None);
        let origin_y = desired.y - frame.size.height / 2.0;
        if (frame.origin.y - origin_y).abs() > 0.01 {
            button.setFrameOrigin(NSPoint::new(frame.origin.x, origin_y));
        }
    }

    // Read the laid-out green button back in window coordinates.
    let zoom_in_window = button_superview.convertRect_toView(NSView::frame(&zoom), None);
    Some(zoom_in_window.origin.x + zoom_in_window.size.width)
}

/// Match the native NSWindow backing surface to the web app. WKWebView can
/// briefly expose that surface while AppKit performs a live resize; leaving it
/// at the system default produces white strips along the growing edges.
pub fn apply_window_background(window: &tauri::WebviewWindow, dark: bool) {
    let (red, green, blue) = if dark { DARK_WINDOW_BACKGROUND } else { LIGHT_WINDOW_BACKGROUND };
    let color = move || {
        NSColor::colorWithSRGBRed_green_blue_alpha(red / 255.0, green / 255.0, blue / 255.0, 1.0)
    };

    if let Some(address) = ns_window_address(window) {
        let _ = window.run_on_main_thread(move || unsafe {
            let ns_window = &*(address as *const NSWindow);
            ns_window.setBackgroundColor(Some(&color()));
            // Let AppKit preserve the last complete frame while the window
            // server is resizing faster than WebKit can present new tiles.
            ns_window.setPreservesContentDuringLiveResize(true);
        });
    }

    // NSWindow is only the outer backing surface. During a fast live resize,
    // WKWebView may expose its own under-page surface before WebKit paints the
    // newly allocated pixels, so color that layer as well. Keep the most recent
    // complete WebKit layer scaled to the current bounds between presentations:
    // unlike holding one WindowServer snapshot for the whole mouse gesture,
    // Core Animation can update continuously without exposing tiled backing
    // regions or freezing the page until mouse-up.
    let _ = window.with_webview(move |webview| unsafe {
        use objc2::sel;
        use objc2_app_kit::{NSViewLayerContentsPlacement, NSViewLayerContentsRedrawPolicy};
        use objc2_foundation::NSObjectProtocol;
        use objc2_web_kit::WKWebView;

        let view = &*webview.inner().cast::<WKWebView>();
        view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::OnSetNeedsDisplay);
        view.setLayerContentsPlacement(NSViewLayerContentsPlacement::ScaleAxesIndependently);
        if view.respondsToSelector(sel!(setUnderPageBackgroundColor:)) {
            view.setUnderPageBackgroundColor(Some(&color()));
        }
    });
}

/// The WebKit feature that holds page rendering updates (requestAnimationFrame,
/// scroll-driven work, main-thread animation) near 60 Hz even on a 120 Hz
/// ProMotion or XDR display. WKWebView turns it on by default; Safari and
/// Chromium render at the display's rate.
const NEAR_60FPS_FEATURE: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

/// Let the web view render at the display's refresh rate. With the cap on,
/// every scroll, panel animation and dialog entrance runs at half the frame
/// rate of a 120 Hz display (idle 59 → 119 fps, PDF scroll 60 → 120 fps when
/// lifted). Applied after the view is built, it takes effect for the page that
/// is already loading.
///
/// `+[WKPreferences _features]` and `-[WKPreferences _setEnabled:forFeature:]`
/// are WebKit SPI, which a Developer ID build may call. A WebKit without either
/// selector, or one that no longer lists the feature, keeps its own rate and
/// the log says why.
pub fn render_at_display_refresh_rate(window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let _ = window.with_webview(move |webview| unsafe {
        use objc2::rc::Retained;
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{msg_send, sel, ClassType};
        use objc2_foundation::{NSArray, NSObjectProtocol, NSString};
        use objc2_web_kit::{WKPreferences, WKWebView};

        let view = &*webview.inner().cast::<WKWebView>();
        let preferences = view.configuration().preferences();
        let class = WKPreferences::class();
        if !class.metaclass().responds_to(sel!(_features))
            || !preferences.respondsToSelector(sel!(_setEnabled:forFeature:))
        {
            log::warn!(
                target: "lattice::window",
                "{label}: this WebKit cannot lift its 60 Hz rendering cap; staying at 60 Hz"
            );
            return;
        }
        let features: Option<Retained<NSArray<AnyObject>>> = msg_send![class, _features];
        let cap = features.map(|features| features.to_vec()).unwrap_or_default().into_iter().find(
            |feature| {
                let has_key: bool = msg_send![&**feature, respondsToSelector: sel!(key)];
                has_key && {
                    let key: Option<Retained<NSString>> = msg_send![&**feature, key];
                    key.is_some_and(|key| key.to_string() == NEAR_60FPS_FEATURE)
                }
            },
        );
        match cap {
            Some(feature) => {
                let _: () = msg_send![&*preferences, _setEnabled: Bool::NO, forFeature: &*feature];
                log::info!(target: "lattice::window", "{label}: rendering at the display's refresh rate");
            }
            None => log::info!(
                target: "lattice::window",
                "{label}: this WebKit has no {NEAR_60FPS_FEATURE}; keeping its own rate"
            ),
        }
    });
}

fn rgb_hex(red: f64, green: f64, blue: f64) -> String {
    let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02X}{:02X}{:02X}", channel(red), channel(green), channel(blue))
}

/// Open AppKit's system-wide color sampler and resolve after the user selects
/// a screen pixel or cancels. NSColorSampler owns the loupe, multi-display
/// sampling, Escape handling, and screen access, so the app does not need to
/// capture the desktop or request screen-recording permission itself.
pub async fn sample_screen_color(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    use objc2_app_kit::{NSColorSampler, NSColorSpace};
    use std::sync::Arc;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    app.run_on_main_thread(move || {
        let sampler = NSColorSampler::new();
        let handler = RcBlock::new(move |color: *mut NSColor| {
            let selected = NonNull::new(color).and_then(|color| {
                // SAFETY: AppKit guarantees the selected NSColor remains valid
                // for the duration of the completion handler.
                let color = unsafe { color.as_ref() };
                let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
                Some(rgb_hex(srgb.redComponent(), srgb.greenComponent(), srgb.blueComponent()))
            });
            if let Some(sender) = sender.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = sender.send(selected);
            }
        });
        // SAFETY: the block has AppKit's documented NSColor callback signature.
        // NSColorSampler retains itself until the asynchronous session completes.
        unsafe { sampler.showSamplerWithSelectionHandler(&handler) };
    })
    .map_err(|reason| format!("Could not start the screen color sampler: {reason}"))?;

    receiver.await.map_err(|_| "The screen color sampler ended without a result.".to_string())
}

/// Strip Gatekeeper quarantine from our bundle (and an enclosing Lattice folder when present).
pub fn clear_launch_quarantine() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(bundle) = exe.ancestors().find(|path| {
        path.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
    }) else {
        return;
    };
    clear_quarantine_path(bundle);
    if let Some(parent) = bundle.parent().filter(|parent| {
        parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains("Lattice"))
    }) {
        clear_quarantine_path(parent);
    }
}

fn clear_quarantine_path(path: &Path) {
    let _ = Command::new("xattr").args(["-cr"]).arg(path).status();
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    #[test]
    fn sampled_colors_are_clamped_and_formatted_as_srgb_hex() {
        // The native window backings match the CSS themes' backgrounds.
        let hex = |(red, green, blue): (f64, f64, f64)| {
            super::rgb_hex(red / 255.0, green / 255.0, blue / 255.0)
        };
        assert_eq!(hex(super::LIGHT_WINDOW_BACKGROUND), "#F7F7F6");
        assert_eq!(hex(super::DARK_WINDOW_BACKGROUND), "#171718");
        assert_eq!(super::rgb_hex(1.0, 0.5, 0.0), "#FF8000");
        assert_eq!(super::rgb_hex(-0.2, 1.4, 1.0 / 255.0), "#00FF01");
    }

    #[test]
    fn macos_window_uses_runtime_traffic_light_geometry() {
        let config: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        assert_eq!(config["app"]["macOSPrivateApi"], true);
        let window = &config["app"]["windows"][0];
        assert!(window.get("trafficLightPosition").is_none());
        assert_eq!(window["backgroundColor"], "#F7F7F6");
        for (source, expected) in [
            (include_str!("../../src/app/use-native-window.ts"), "align_traffic_lights"),
            (include_str!("../../src/app/use-native-window.ts"), "--titlebar-traffic-space-width"),
            (include_str!("../../src/App.css"), "./styles/app-shell.css"),
            (include_str!("../../src/styles/app-shell.css"), ".titlebar {"),
            (include_str!("../../src/styles/app-shell.css"), "height: var(--titlebar-height)"),
            (include_str!("../../src/styles/app-shell.css"), "align-items: center"),
            (include_str!("../../src/styles/app-shell.css"), ".traffic-space"),
            (include_str!("../../src/styles/foundations.css"), "--titlebar-height: 40px"),
            (include_str!("../../src/styles/foundations.css"), "--titlebar-traffic-space-width"),
        ] {
            assert!(source.contains(expected), "{expected}");
        }
        assert!(
            include_str!("../Cargo.toml").contains("\"macos-private-api\""),
            "the macOS WebView must disable its opaque white backing surface"
        );
        // The main and project windows (`workspace_window`) take the
        // activation click from `overlay_title_bar`.
        let lib = include_str!("lib.rs");
        assert_eq!(lib.matches(".accept_first_mouse(true)").count(), 1);
        assert!(lib.contains("let window = overlay_title_bar(builder).build()?;"));
    }

    #[test]
    fn the_browser_host_window_may_destroy_itself() {
        // The hidden browser-host window destroys itself once its browser tab
        // disconnects, which needs the ACL grant.
        let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("valid capability file");
        let permissions = capability["permissions"].as_array().expect("capability permissions");
        assert!(
            permissions.iter().any(|permission| permission == "core:window:allow-destroy"),
            "the browser host bridge needs core:window:allow-destroy"
        );
    }
}
