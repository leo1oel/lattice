//! macOS window chrome helpers: window backing colors, AppKit
//! event monitors (pinch, Command-C), the screen color sampler, the Import
//! files… open panel, and quarantine cleanup.

use block2::RcBlock;
use objc2_app_kit::{NSColor, NSEvent, NSEventMask, NSWindow};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::ptr::NonNull;
use std::sync::{LazyLock, Mutex, PoisonError};

static PDF_COPY_TEXT: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static FOCUSED_WINDOW_LABEL: Mutex<Option<String>> = Mutex::new(None);

const LIGHT_WINDOW_BACKGROUND: (f64, f64, f64) = (247.0, 247.0, 246.0);

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
///
/// Every workspace window gets it: the pinch goes to the focused window, and
/// only when it happened in the key window, so a pinch over a background
/// window is not replayed at the same coordinates in another one.
pub fn install_magnify_monitor(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};

    add_local_monitor(NSEventMask::Magnify, move |event| {
        let magnification = event.magnification();
        // AppKit runs local monitors on the main thread.
        let in_key_window = objc2::MainThreadMarker::new()
            .and_then(|mtm| event.window(mtm))
            .is_some_and(|window| window.isKeyWindow());
        if magnification == 0.0 || !in_key_window {
            return true;
        }
        // Read like the copy monitor: window focus events keep the label.
        let Some(label) = focused_window_label() else {
            return true;
        };
        let Some(window) = app.get_webview_window(&label) else {
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
        // `emit` would reach every window, with this window's coordinates.
        let _ = window.emit_to(
            label.as_str(),
            "trackpad-magnify",
            MagnifyEvent { magnification, x, y },
        );
        true
    });
}

/// Keep the selected PDF text close to AppKit's Command-C handler.
///
/// The frontend updates this only after a PDF drag and clears it when that
/// selection loses ownership. Other platforms copy in the webview directly.
#[tauri::command]
pub fn set_pdf_copy_text(window: tauri::WebviewWindow, text: Option<String>) {
    let mut selections = PDF_COPY_TEXT.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        selections.insert(window.label().to_string(), text);
    } else {
        selections.remove(window.label());
    }
}

pub fn clear_pdf_copy_text(window_label: &str) {
    PDF_COPY_TEXT.lock().unwrap_or_else(PoisonError::into_inner).remove(window_label);
    set_window_focused(window_label, false);
}

/// The window that last gained focus and has not lost it since.
pub fn focused_window_label() -> Option<String> {
    FOCUSED_WINDOW_LABEL.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

pub fn set_window_focused(window_label: &str, is_focused: bool) {
    let mut focused = FOCUSED_WINDOW_LABEL.lock().unwrap_or_else(PoisonError::into_inner);
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
        let Some(window_label) = focused_window_label() else {
            return true;
        };
        let Some(text) = PDF_COPY_TEXT
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&window_label)
            .cloned()
        else {
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
pub(crate) fn ns_window_address(window: &tauri::WebviewWindow) -> Option<usize> {
    window.ns_window().ok().filter(|pointer| !pointer.is_null()).map(|pointer| pointer as usize)
}

/// The window's light or dark appearance, when the web app pins one.
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowAppearance {
    Light,
    Dark,
}

/// What the web app asks of the native window (`set_window_material`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaterial {
    /// `None` follows the system. Pinning an appearance also changes what
    /// the page's `prefers-color-scheme` reports, so a page that follows the
    /// system must leave it unpinned or it would only ever hear itself.
    pub appearance: Option<WindowAppearance>,
    /// The opaque `#rrggbb` the page paints behind everything.
    pub background: String,
    /// Put macOS vibrancy behind the page instead of that color.
    pub translucent: bool,
}

impl WindowMaterial {
    /// Before the page has said anything: the system appearance over
    /// vibrancy, which is the default, and the light theme's background.
    pub fn at_launch() -> Self {
        let (red, green, blue) = LIGHT_WINDOW_BACKGROUND;
        Self {
            appearance: None,
            background: rgb_hex(red / 255.0, green / 255.0, blue / 255.0),
            translucent: true,
        }
    }

    fn background_rgb(&self) -> (f64, f64, f64) {
        let hex = self.background.strip_prefix('#').filter(|hex| hex.len() == 6);
        let channel = |at: usize| {
            hex.and_then(|hex| u8::from_str_radix(&hex[at..at + 2], 16).ok()).map(f64::from)
        };
        match (channel(0), channel(2), channel(4)) {
            (Some(red), Some(green), Some(blue)) => (red, green, blue),
            _ => LIGHT_WINDOW_BACKGROUND,
        }
    }
}

thread_local! {
    /// Each workspace window's vibrancy layer, made the first time it turns
    /// translucent and then only shown or hidden. AppKit objects live on the
    /// main thread, which is the only thread that touches this.
    static MATERIAL_VIEWS: std::cell::RefCell<HashMap<String, objc2::rc::Retained<objc2_app_kit::NSVisualEffectView>>> =
        std::cell::RefCell::new(HashMap::new());
}

/// What the window's backing turned out to be.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowBacking {
    Translucent,
    Opaque,
    /// Translucency was asked for, but the user has Reduce transparency on.
    ReducedTransparency,
}

/// Set the window's appearance and backing: the vibrancy Synara's desktop
/// app uses (the under-window material, following the window's active state
/// so a background window stops recompositing) or an opaque color matching
/// the page. The page only clears its own background when the answer is
/// `Translucent`.
///
/// The color also covers live resize. WKWebView can briefly expose the
/// NSWindow surface while AppKit resizes faster than WebKit paints; left at
/// the system default, that showed white strips along the growing edges.
pub fn apply_window_material(
    window: &tauri::WebviewWindow, material: &WindowMaterial,
) -> WindowBacking {
    use objc2_app_kit::NSWorkspace;

    let backing = if !material.translucent {
        WindowBacking::Opaque
    } else if NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency() {
        WindowBacking::ReducedTransparency
    } else {
        WindowBacking::Translucent
    };
    let translucent = backing == WindowBacking::Translucent;
    let (red, green, blue) = material.background_rgb();
    let color = move || {
        if translucent {
            NSColor::clearColor()
        } else {
            NSColor::colorWithSRGBRed_green_blue_alpha(
                red / 255.0,
                green / 255.0,
                blue / 255.0,
                1.0,
            )
        }
    };
    let appearance = material.appearance;
    let label = window.label().to_owned();

    if let Some(address) = ns_window_address(window) {
        let _ = window.run_on_main_thread(move || unsafe {
            use objc2_app_kit::{
                NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua,
                NSAppearanceNameDarkAqua,
            };

            let ns_window = &*(address as *const NSWindow);
            let named = appearance.and_then(|appearance| {
                NSAppearance::appearanceNamed(match appearance {
                    WindowAppearance::Light => NSAppearanceNameAqua,
                    WindowAppearance::Dark => NSAppearanceNameDarkAqua,
                })
            });
            ns_window.setAppearance(named.as_deref());
            show_material_view(ns_window, &label, translucent);
            ns_window.setOpaque(!translucent);
            ns_window.setBackgroundColor(Some(&color()));
            // Let AppKit preserve the last complete frame while the window
            // server is resizing faster than WebKit can present new tiles.
            ns_window.setPreservesContentDuringLiveResize(true);
        });
    }

    // NSWindow is only the outer backing surface. During a fast live resize,
    // WKWebView may expose its own under-page surface before WebKit paints the
    // newly allocated pixels, so color that layer as well (clear over
    // vibrancy). Keep the most recent complete WebKit layer scaled to the
    // current bounds between presentations: unlike holding one WindowServer
    // snapshot for the whole mouse gesture, Core Animation can update
    // continuously without exposing tiled backing regions or freezing the page
    // until mouse-up.
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
    backing
}

/// Show or hide the window's vibrancy layer, adding it below the web view
/// the first time it is shown.
fn show_material_view(ns_window: &NSWindow, label: &str, shown: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
        NSVisualEffectState, NSVisualEffectView, NSWindowOrderingMode,
    };

    let Some(mtm) = MainThreadMarker::new() else { return };
    MATERIAL_VIEWS.with_borrow_mut(|views| {
        if let Some(view) = views.get(label) {
            view.setHidden(!shown);
            return;
        }
        if !shown {
            return;
        }
        let Some(content) = ns_window.contentView() else { return };
        let view = NSVisualEffectView::initWithFrame(mtm.alloc(), content.bounds());
        view.setMaterial(NSVisualEffectMaterial::UnderWindowBackground);
        view.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
        view.setState(NSVisualEffectState::FollowsWindowActiveState);
        view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        content.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
        views.insert(label.to_owned(), view);
    });
}

/// Release a closed window's vibrancy layer.
pub fn forget_window_material(window_label: &str) {
    MATERIAL_VIEWS.with_borrow_mut(|views| views.remove(window_label));
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

/// Ask for files and folders to import, as a sheet on `window`, and resolve
/// with their paths (`None` when canceled). The dialog plugin's panels take
/// either files or folders; Finder's own Import panels take both at once.
pub async fn choose_files_and_folders(
    window: &tauri::Window, title: &str, prompt: &str,
) -> Result<Option<Vec<String>>, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::NSString;
    use std::sync::Arc;

    let address = window
        .ns_window()
        .ok()
        .filter(|pointer| !pointer.is_null())
        .map(|pointer| pointer as usize)
        .ok_or_else(|| "The window is not ready for a file panel.".to_string())?;
    let (title, prompt) = (title.to_string(), prompt.to_string());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    window
        .run_on_main_thread(move || unsafe {
            let panel = NSOpenPanel::openPanel(MainThreadMarker::new_unchecked());
            panel.setCanChooseFiles(true);
            panel.setCanChooseDirectories(true);
            panel.setAllowsMultipleSelection(true);
            panel.setCanCreateDirectories(false);
            panel.setMessage(Some(&NSString::from_str(&title)));
            panel.setPrompt(Some(&NSString::from_str(&prompt)));
            let chosen = panel.clone();
            let handler = RcBlock::new(move |response: isize| {
                let paths = (response == NSModalResponseOK).then(|| {
                    chosen
                        .URLs()
                        .iter()
                        .filter_map(|url| url.path().map(|path| path.to_string()))
                        .collect::<Vec<_>>()
                });
                if let Some(sender) = sender.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = sender.send(paths);
                }
            });
            // SAFETY: the pointer is this window's live NSWindow, read on the
            // thread that owns it; the sheet retains the panel and the block
            // until the user answers.
            panel.beginSheetModalForWindow_completionHandler(
                &*(address as *const NSWindow),
                &handler,
            );
        })
        .map_err(|reason| format!("Could not open the file panel: {reason}"))?;

    receiver.await.map_err(|_| "The file panel closed without an answer.".to_string())
}

/// Strip Gatekeeper quarantine from our bundle (and an enclosing Lattice folder when present).
///
/// Runs before the launch window exists, so a folder is walked only while it
/// still carries the quarantine flag: `xattr -cr` visits every file below it,
/// and the bundled runtimes are about 30,000 files, 0.6 s on every launch with
/// nothing left to clear. After the first launch clears it, this is one
/// attribute read.
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

/// `path`'s own attributes are cleared last, so its flag stays until
/// everything inside is clear and a walk cut short runs again next launch.
fn clear_quarantine_path(path: &Path) {
    if !is_quarantined(path) {
        return;
    }
    for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
        let _ = Command::new("xattr").args(["-cr"]).arg(entry.path()).status();
    }
    let _ = Command::new("xattr").args(["-c"]).arg(path).status();
}

fn is_quarantined(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: both strings are NUL-terminated and outlive the call; a null
    // buffer of size 0 only asks for the attribute's length.
    let length = unsafe {
        libc::getxattr(
            path.as_ptr(),
            c"com.apple.quarantine".as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    length >= 0
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
        assert_eq!(super::rgb_hex(1.0, 0.5, 0.0), "#FF8000");
        assert_eq!(super::rgb_hex(-0.2, 1.4, 1.0 / 255.0), "#00FF01");
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
