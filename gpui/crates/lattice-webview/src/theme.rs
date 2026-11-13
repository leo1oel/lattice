//! The host's theme as an island's page receives it.

use gpui::{App, Hsla, Rgba};
use lattice_ui::{
    ActiveLattice as _,
    palette::{Accent, Palette, Tint},
};
use serde_json::{Value, json};

/// How an island's page takes the host's theme (`host:theme`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IslandTheme {
    /// The palette's colours under the Tauri app's variable names, set on the
    /// root element: a page written for the GPUI app (the HTML viewer's).
    #[default]
    Variables,
    /// The root element's `data-theme`, `data-tint` and `data-accent`, and a
    /// custom accent's `--accent`, exactly as the Tauri app sets them
    /// (`src/settings/use-appearance.ts`): a page that loads the app's own
    /// stylesheets, whose every token then resolves as it does there.
    Document,
}

fn css(color: Hsla) -> String {
    let rgba = Rgba::from(color);
    format!(
        "rgba({}, {}, {}, {:.3})",
        (rgba.r * 255.).round(),
        (rgba.g * 255.).round(),
        (rgba.b * 255.).round(),
        rgba.a
    )
}

/// The host's theme for a page that takes it as `mode` says.
pub fn theme_payload(mode: IslandTheme, cx: &App) -> Value {
    match mode {
        IslandTheme::Variables => variables(cx),
        IslandTheme::Document => document(cx.palette()),
    }
}

/// The root element's attributes the Tauri app sets for this palette
/// (`src/settings/use-appearance.ts`): its stylesheets resolve every token
/// from them, so the page needs nothing else. A custom accent is the one
/// colour the CSS cannot derive: it comes fitted, as `--accent`.
fn document(palette: &Palette) -> Value {
    let theme = if palette.is_dark() { "dark" } else { "light" };
    let tint = match palette.tint {
        Tint::Graphite => "graphite",
        Tint::Paper => "paper",
        Tint::Sage => "sage",
        Tint::Mist => "mist",
        Tint::Dusk => "dusk",
    };
    let accent = match palette.accent_preset {
        Accent::Graphite => "graphite",
        Accent::Blue => "blue",
        Accent::Purple => "purple",
        Accent::Pink => "pink",
        Accent::Orange => "orange",
        Accent::Green => "green",
        Accent::Teal => "teal",
        Accent::Custom(_) => "custom",
    };
    json!({
        "appearance": theme,
        "dataset": { "theme": theme, "tint": tint, "accent": accent },
        "accent": matches!(palette.accent_preset, Accent::Custom(_)).then(|| css(palette.accent)),
    })
}

/// The CSS variables an island's page gets from the host's theme: the
/// Tauri app's own names (`src/styles/theme.css`), so a page ported from it
/// reads the same variables it did as an iframe of the app.
fn variables(cx: &App) -> Value {
    let palette = cx.palette();
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

#[cfg(test)]
mod tests {
    use super::*;
    use lattice_ui::Appearance;

    #[test]
    fn a_document_page_gets_the_tauri_apps_root_attributes() {
        let palette = Palette::new(Appearance::Dark, Tint::Sage, Accent::Blue);
        assert_eq!(
            document(&palette),
            json!({
                "appearance": "dark",
                "dataset": { "theme": "dark", "tint": "sage", "accent": "blue" },
                "accent": null,
            })
        );
        let custom = Palette::new(Appearance::Light, Tint::Graphite, Accent::Custom(0x3366cc));
        let payload = document(&custom);
        assert_eq!(payload["dataset"]["accent"], "custom");
        assert!(payload["accent"].as_str().unwrap().starts_with("rgba("));
    }
}
