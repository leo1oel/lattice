//! The host's theme as an island's page receives it.

use gpui::{App, Hsla, Rgba};
use lattice_ui::ActiveLattice as _;
use serde_json::{Value, json};

/// The CSS variables an island's page gets from the host's theme: the
/// Tauri app's own names (`src/styles/theme.css`), so a page ported from it
/// reads the same variables it did as an iframe of the app.
pub fn theme_payload(cx: &App) -> Value {
    let palette = cx.palette();
    let css = |color: Hsla| {
        let rgba = Rgba::from(color);
        format!(
            "rgba({}, {}, {}, {:.3})",
            (rgba.r * 255.).round(),
            (rgba.g * 255.).round(),
            (rgba.b * 255.).round(),
            rgba.a
        )
    };
    json!({
        "appearance": if palette.is_dark() { "dark" } else { "light" },
        "vars": {
            "--bg": css(palette.window),
            "--window": css(palette.window),
            "--chrome-surface": css(palette.chrome),
            "--panel": css(palette.panel),
            "--panel-strong": css(palette.raised),
            "--editor-bg": css(palette.editor),
            "--pdf-bg": css(palette.pdf_ground),
            "--text": css(palette.text),
            "--text-primary": css(palette.text),
            "--muted": css(palette.text_secondary),
            "--line": css(palette.line),
            "--line-strong": css(palette.line_strong),
            "--accent": css(palette.accent),
            "--accent-soft": css(palette.accent_soft),
            "--focus": css(palette.focus),
            "--success": css(palette.success),
            "--danger": css(palette.danger),
        },
    })
}
