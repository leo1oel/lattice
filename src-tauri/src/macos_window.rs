//! macOS-only window chrome helpers (traffic lights + quarantine cleanup).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

/// Fallback when the web UI has not reported a measured titlebar yet.
const DEFAULT_TITLEBAR_HEIGHT: f64 = 46.0;
const TRAFFIC_LIGHT_X: f64 = 16.0;

#[derive(Clone, Copy)]
struct TrafficLightTarget {
    /// Desired vertical center of the lights, from the top of the window (AppKit points).
    center_y: f64,
    /// Titlebar / traffic-light container height (AppKit points).
    titlebar_height: f64,
}

static TRAFFIC_LIGHT_TARGET: Mutex<Option<TrafficLightTarget>> = Mutex::new(None);

pub fn apply_traffic_light_position(window: &tauri::WebviewWindow) {
    schedule_align(window);
}

/// Align native traffic lights to a web-measured titlebar control center.
///
/// `center_y` / `titlebar_height` are in the same coordinate space as the
/// window's AppKit point size (logical points from the top of the window).
pub fn align_traffic_lights_to(window: &tauri::WebviewWindow, center_y: f64, titlebar_height: f64) {
    if !center_y.is_finite() || center_y < 0.0 {
        return;
    }
    if !titlebar_height.is_finite() || titlebar_height < 20.0 {
        return;
    }
    if let Ok(mut guard) = TRAFFIC_LIGHT_TARGET.lock() {
        *guard = Some(TrafficLightTarget {
            center_y,
            titlebar_height,
        });
    }
    schedule_align(window);
}

fn schedule_align(window: &tauri::WebviewWindow) {
    fn align(window: &tauri::WebviewWindow) {
        if let Ok(ptr) = window.ns_window() {
            if !ptr.is_null() {
                unsafe {
                    align_traffic_lights(ptr);
                }
            }
        }
    }

    let window = window.clone();
    let immediate = window.clone();
    let _ = window.clone().run_on_main_thread(move || align(&immediate));
    // AppKit sometimes creates the buttons a tick later on Sequoia guests.
    let delayed = window;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        let target = delayed.clone();
        let _ = delayed.run_on_main_thread(move || align(&target));
    });
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

fn traffic_light_target() -> TrafficLightTarget {
    TRAFFIC_LIGHT_TARGET
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .unwrap_or(TrafficLightTarget {
            center_y: DEFAULT_TITLEBAR_HEIGHT / 2.0,
            titlebar_height: DEFAULT_TITLEBAR_HEIGHT,
        })
}

/// Align traffic lights with the web titlebar controls.
///
/// Tauri/tao's `trafficLightPosition.y` only grows the titlebar container — it does
/// **not** move the buttons vertically. We set `origin.y` explicitly from a
/// measured center (preferred) or a geometric fallback.
#[cfg(target_os = "macos")]
unsafe fn align_traffic_lights(ns_window: *mut std::ffi::c_void) {
    use objc2::msg_send;
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

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
    let Some(title_bar_container_view) = button_superview.superview() else {
        return;
    };

    let target = traffic_light_target();
    let titlebar_height = target.titlebar_height.max(close.frame().size.height + 4.0);

    let close_rect = NSView::frame(&close);
    let mut title_bar_rect = NSView::frame(&title_bar_container_view);
    title_bar_rect.size.height = titlebar_height;
    title_bar_rect.origin.y = window.frame().size.height - titlebar_height;
    let _: () = msg_send![&title_bar_container_view, setFrame: title_bar_rect];

    let space_between = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
    // AppKit origin is bottom-left inside the titlebar container.
    // Place the button so its vertical center matches the measured web control.
    let button_y = (titlebar_height - target.center_y - close_rect.size.height / 2.0).max(0.0);

    for (index, button) in [close, miniaturize, zoom].into_iter().enumerate() {
        let mut rect = NSView::frame(&button);
        rect.origin.x = TRAFFIC_LIGHT_X + (index as f64 * space_between);
        rect.origin.y = button_y;
        button.setFrameOrigin(rect.origin);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_titlebar_height_matches_css() {
        assert_eq!(super::DEFAULT_TITLEBAR_HEIGHT, 46.0);
    }

    #[test]
    fn measured_target_is_stored() {
        if let Ok(mut guard) = super::TRAFFIC_LIGHT_TARGET.lock() {
            *guard = Some(super::TrafficLightTarget {
                center_y: 25.0,
                titlebar_height: 50.0,
            });
        }
        let target = super::traffic_light_target();
        assert_eq!(target.center_y, 25.0);
        assert_eq!(target.titlebar_height, 50.0);
        if let Ok(mut guard) = super::TRAFFIC_LIGHT_TARGET.lock() {
            *guard = None;
        }
    }
}
