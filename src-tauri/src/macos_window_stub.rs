//! Linux / non-macOS stand-ins for the AppKit window helpers.
//!
//! Keeps the same IPC surface so the frontend compiles; vibrancy, quarantine,
//! and AppKit monitors are no-ops until Linux window chrome is implemented.

use std::sync::{Mutex, PoisonError};

static FOCUSED_WINDOW_LABEL: Mutex<Option<String>> = Mutex::new(None);

pub fn install_magnify_monitor(_app: tauri::AppHandle) {}

#[tauri::command]
pub fn set_pdf_copy_text(_window: tauri::WebviewWindow, _text: Option<String>) {}

pub fn clear_pdf_copy_text(window_label: &str) {
    set_window_focused(window_label, false);
}

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

pub fn install_copy_shortcut_monitor(_app: tauri::AppHandle) {}

/// The page's requested window material. No native material is drawn here,
/// so the request's fields (appearance, background, translucent) are
/// accepted and ignored: the webview paints its own background.
#[derive(serde::Deserialize)]
pub struct WindowMaterial {}

impl WindowMaterial {
    pub fn at_launch() -> Self {
        Self {}
    }
}

/// What `apply_window_material` reports to the page: always an opaque
/// window, since there is no vibrancy to fall back from.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowBacking {
    Opaque,
}

pub fn apply_window_material(
    _window: &tauri::WebviewWindow, _material: &WindowMaterial,
) -> WindowBacking {
    WindowBacking::Opaque
}

pub fn forget_window_material(_window_label: &str) {}

pub fn render_at_display_refresh_rate(_window: &tauri::WebviewWindow) {}

pub async fn sample_screen_color(_app: &tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(None)
}

/// Import panel on Linux: files via rfd (folders in the same pick are not
/// offered until a native both-kinds dialog exists).
pub async fn choose_files_and_folders(
    _window: &tauri::Window, title: &str, _prompt: &str,
) -> Result<Option<Vec<String>>, String> {
    let files = rfd::AsyncFileDialog::new().set_title(title).pick_files().await;
    Ok(files.map(|handles| {
        handles.into_iter().map(|handle| handle.path().display().to_string()).collect()
    }))
}

pub fn clear_launch_quarantine() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_requested_material_leaves_the_window_opaque() {
        let material: WindowMaterial = serde_json::from_value(serde_json::json!({
            "appearance": "dark", "background": "#1E1E1E", "translucent": true,
        }))
        .unwrap();
        let _ = (material, WindowMaterial::at_launch());
        assert_eq!(serde_json::to_value(WindowBacking::Opaque).unwrap(), "opaque");
    }
}
