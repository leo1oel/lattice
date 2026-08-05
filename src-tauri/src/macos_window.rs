//! macOS-only window chrome helpers (traffic lights, pinch gestures, quarantine
//! cleanup).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

/// Payload of the `trackpad-magnify` event the web UI listens for.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagnifyEvent {
    /// Incremental scale change for this tick: 0.02 means "2% bigger".
    pub magnification: f64,
    /// Cursor position in CSS pixels from the top-left of the web view, so the
    /// page can decide whether the pinch happened over the PDF.
    pub x: f64,
    pub y: f64,
}

/// Forward trackpad pinches to the web UI.
///
/// A pinch never reaches JavaScript in this webview: WebKit's `gesture*` events
/// are not delivered here, and WKWebView only emits `ctrl`+wheel for pinches in
/// a browser, not embedded. AppKit still sees the raw `NSEventTypeMagnify`
/// though, so we watch for it below WebKit and hand the delta to the page,
/// which is what makes pinch-to-zoom work on the PDF.
#[cfg(target_os = "macos")]
pub fn install_magnify_monitor(app: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use std::ptr::NonNull;
    use tauri::{Emitter, Manager};

    // The monitor must outlive this call; AppKit owns it for the app's life.
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let raw = event.as_ptr();
        // SAFETY: AppKit hands us a live event for the duration of the block.
        let magnification = unsafe { event.as_ref().magnification() };
        if magnification != 0.0 {
            if let Some(window) = app.get_webview_window("main") {
                // NSEvent reports window coordinates with a bottom-left origin;
                // the page wants top-left CSS pixels.
                let location = unsafe { event.as_ref().locationInWindow() };
                let (x, y) = window
                    .inner_size()
                    .ok()
                    .zip(window.scale_factor().ok())
                    .map(|(size, scale)| {
                        let height = size.height as f64 / scale;
                        (location.x, height - location.y)
                    })
                    .unwrap_or((location.x, location.y));
                let _ = window.emit(
                    "trackpad-magnify",
                    MagnifyEvent {
                        magnification,
                        x,
                        y,
                    },
                );
            }
        }
        // Let the event continue on its way; we only observe it.
        raw
    });
    // SAFETY: the block matches the documented handler signature, and we keep
    // the returned monitor alive for the process lifetime on purpose.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::Magnify, &handler)
    };
    std::mem::forget(monitor);
    std::mem::forget(handler);
}

const LIGHT_WINDOW_BACKGROUND: (f64, f64, f64) = (247.0, 247.0, 246.0);
const DARK_WINDOW_BACKGROUND: (f64, f64, f64) = (23.0, 23.0, 24.0);
const TRAFFIC_LIGHT_LEFT_INSET: f64 = 13.0;
const DEFAULT_TRAFFIC_LIGHT_CENTER_FROM_TOP: f64 = 20.0;

static TRAFFIC_LIGHT_CENTER_FROM_TOP: Mutex<f64> =
    Mutex::new(DEFAULT_TRAFFIC_LIGHT_CENTER_FROM_TOP);

fn window_background(dark: bool) -> (f64, f64, f64) {
    if dark {
        DARK_WINDOW_BACKGROUND
    } else {
        LIGHT_WINDOW_BACKGROUND
    }
}

/// Align the native traffic-light centers with the measured web titlebar.
///
/// AppKit owns the button size, spacing, and private titlebar hierarchy, and
/// those details differ between macOS releases. Read that geometry at runtime
/// and convert the desired window-space center into the button superview rather
/// than treating Tauri's version-sensitive titlebar inset as a stable position.
#[cfg(target_os = "macos")]
pub fn install_traffic_light_alignment(window: &tauri::WebviewWindow) {
    schedule_traffic_light_alignment(window);

    // AppKit performs a final titlebar layout after the window first appears.
    // Re-read the native frames after that pass instead of assuming the first
    // hierarchy survives unchanged.
    let delayed = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        schedule_traffic_light_alignment(&delayed);
    });
}

/// Apply a web-measured vertical center in AppKit logical points.
pub fn align_traffic_lights_to(window: &tauri::WebviewWindow, center_from_top: f64) {
    if !center_from_top.is_finite() || center_from_top < 0.0 {
        return;
    }
    if let Ok(mut target) = TRAFFIC_LIGHT_CENTER_FROM_TOP.lock() {
        *target = center_from_top;
    }
    schedule_traffic_light_alignment(window);
}

fn schedule_traffic_light_alignment(window: &tauri::WebviewWindow) {
    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    let ptr = ptr as usize;
    let _ = window.run_on_main_thread(move || unsafe {
        align_traffic_lights_on_main(ptr as *mut std::ffi::c_void);
    });
}

fn traffic_light_center_from_top() -> f64 {
    TRAFFIC_LIGHT_CENTER_FROM_TOP
        .lock()
        .map(|target| *target)
        .unwrap_or(DEFAULT_TRAFFIC_LIGHT_CENTER_FROM_TOP)
}

#[cfg(target_os = "macos")]
unsafe fn align_traffic_lights_on_main(ns_window: *mut std::ffi::c_void) {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
    use objc2_foundation::NSPoint;

    let window = &*(ns_window as *const NSWindow);
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let Some(zoom) = window.standardWindowButton(NSWindowButton::ZoomButton) else {
        return;
    };
    let Some(button_superview) = close.superview() else {
        return;
    };

    let close_frame = NSView::frame(&close);
    let miniaturize_frame = NSView::frame(&miniaturize);
    let spacing = miniaturize_frame.origin.x - close_frame.origin.x;
    let center_y_in_window = window.frame().size.height - traffic_light_center_from_top();

    for (index, button) in [close, miniaturize, zoom].into_iter().enumerate() {
        let frame = NSView::frame(&button);
        let desired_window_center = NSPoint::new(
            TRAFFIC_LIGHT_LEFT_INSET + index as f64 * spacing + frame.size.width / 2.0,
            center_y_in_window,
        );
        let desired_local_center =
            button_superview.convertPoint_fromView(desired_window_center, None);
        button.setFrameOrigin(NSPoint::new(
            desired_local_center.x - frame.size.width / 2.0,
            desired_local_center.y - frame.size.height / 2.0,
        ));
    }
}

/// Match the native NSWindow backing surface to the web app. WKWebView can
/// briefly expose that surface while AppKit performs a live resize; leaving it
/// at the system default produces white strips along the growing edges.
pub fn apply_window_background(window: &tauri::WebviewWindow, dark: bool) {
    let (red, green, blue) = window_background(dark);

    if let Ok(ptr) = window.ns_window() {
        if !ptr.is_null() {
            let ptr = ptr as usize;
            let _ = window.run_on_main_thread(move || unsafe {
                use objc2_app_kit::{NSColor, NSWindow};
                let ns_window = &*(ptr as *const NSWindow);
                let color = NSColor::colorWithSRGBRed_green_blue_alpha(
                    red / 255.0,
                    green / 255.0,
                    blue / 255.0,
                    1.0,
                );
                ns_window.setBackgroundColor(Some(&color));
                // Let AppKit preserve the last complete frame while the window
                // server is resizing faster than WebKit can present new tiles.
                ns_window.setPreservesContentDuringLiveResize(true);
            });
        }
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
        use objc2_app_kit::{
            NSColor, NSViewLayerContentsPlacement, NSViewLayerContentsRedrawPolicy,
        };
        use objc2_foundation::NSObjectProtocol;
        use objc2_web_kit::WKWebView;

        let view = &*webview.inner().cast::<WKWebView>();
        view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::OnSetNeedsDisplay);
        view.setLayerContentsPlacement(NSViewLayerContentsPlacement::ScaleAxesIndependently);
        if view.respondsToSelector(sel!(setUnderPageBackgroundColor:)) {
            let color = NSColor::colorWithSRGBRed_green_blue_alpha(
                red / 255.0,
                green / 255.0,
                blue / 255.0,
                1.0,
            );
            view.setUnderPageBackgroundColor(Some(&color));
        }
    });
}

fn rgb_hex(red: f64, green: f64, blue: f64) -> String {
    let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!(
        "#{:02X}{:02X}{:02X}",
        channel(red),
        channel(green),
        channel(blue)
    )
}

/// Open AppKit's system-wide color sampler and resolve after the user selects
/// a screen pixel or cancels. NSColorSampler owns the loupe, multi-display
/// sampling, Escape handling, and screen access, so the app does not need to
/// capture the desktop or request screen-recording permission itself.
pub async fn sample_screen_color(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSColor, NSColorSampler, NSColorSpace};
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;

    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    app.run_on_main_thread(move || {
        let sampler = NSColorSampler::new();
        let sender = Arc::clone(&sender);
        let handler = RcBlock::new(move |color: *mut NSColor| {
            let selected = NonNull::new(color).and_then(|color| {
                // SAFETY: AppKit guarantees the selected NSColor remains valid
                // for the duration of the completion handler.
                let color = unsafe { color.as_ref() };
                let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
                Some(rgb_hex(
                    srgb.redComponent(),
                    srgb.greenComponent(),
                    srgb.blueComponent(),
                ))
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

    receiver
        .await
        .map_err(|_| "The screen color sampler ended without a result.".to_string())
}

/// Strip Gatekeeper quarantine from our bundle (and an adjacent collab folder when present).
pub fn clear_launch_quarantine() {
    if let Some(bundle) = bundle_root() {
        clear_quarantine_path(&bundle);
        if let Some(parent) = bundle.parent() {
            if parent
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains("Lattice"))
            {
                clear_quarantine_path(parent);
            }
        }
    }
}

fn bundle_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
        })
        .map(Path::to_path_buf)
}

fn clear_quarantine_path(path: &Path) {
    let _ = Command::new("xattr").args(["-cr"]).arg(path).status();
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    #[test]
    fn native_window_backgrounds_match_css_themes() {
        assert_eq!(super::window_background(false), (247.0, 247.0, 246.0));
        assert_eq!(super::window_background(true), (23.0, 23.0, 24.0));
    }

    #[test]
    fn sampled_colors_are_clamped_and_formatted_as_srgb_hex() {
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
        assert!(include_str!("../../src/App.tsx").contains("align_traffic_lights"));
        let css_entry = include_str!("../../src/App.css");
        assert!(css_entry.contains("./styles/app-shell.css"));
        let css = include_str!("../../src/styles/app-shell.css");
        assert!(css.contains(".titlebar {"));
        assert!(css.contains("height: var(--titlebar-height)"));
        assert!(css.contains("align-items: center"));
        let foundations = include_str!("../../src/styles/foundations.css");
        assert!(foundations.contains("--titlebar-height: 40px"));
        assert_eq!(window["backgroundColor"], "#F7F7F6");
        assert!(
            include_str!("../Cargo.toml").contains("\"macos-private-api\""),
            "the macOS WebView must disable its opaque white backing surface"
        );
    }
}
