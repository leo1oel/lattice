//! Linux / non-macOS stand-ins for the AppKit window helpers.
//!
//! Keeps the same IPC surface so the frontend compiles; vibrancy, quarantine,
//! and AppKit monitors are no-ops until Linux window chrome is implemented.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};

static PDF_COPY_TEXT: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static FOCUSED_WINDOW_LABEL: Mutex<Option<String>> = Mutex::new(None);

const LIGHT_WINDOW_BACKGROUND: (f64, f64, f64) = (247.0, 247.0, 246.0);

pub fn install_magnify_monitor(_app: tauri::AppHandle) {}

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

pub(crate) fn ns_window_address(_window: &tauri::WebviewWindow) -> Option<usize> {
    None
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowAppearance {
    Light,
    Dark,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaterial {
    pub appearance: Option<WindowAppearance>,
    pub background: String,
    pub translucent: bool,
}

impl WindowMaterial {
    pub fn at_launch() -> Self {
        let (red, green, blue) = LIGHT_WINDOW_BACKGROUND;
        Self {
            appearance: None,
            background: rgb_hex(red / 255.0, green / 255.0, blue / 255.0),
            translucent: false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowBacking {
    Translucent,
    Opaque,
    ReducedTransparency,
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

fn rgb_hex(red: f64, green: f64, blue: f64) -> String {
    let channel = |value: f64| ((value.clamp(0.0, 1.0) * 255.0).round() as u8);
    format!("#{:02X}{:02X}{:02X}", channel(red), channel(green), channel(blue))
}

#[cfg(test)]
mod tests {
    #[test]
    fn launch_material_is_opaque_on_linux() {
        let material = super::WindowMaterial::at_launch();
        assert!(!material.translucent);
        assert_eq!(material.background, "#F7F7F6");
    }
}
