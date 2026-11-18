//! The parity record between the two shells' derivations of a theme
//! (`docs/themes.md`). A theme sets base roles only; each shell derives the
//! rest, the Tauri app in CSS (`color-mix` in theme.css and foundations.css)
//! and this crate in `Palette::with_theme`. This test writes what GPUI
//! derives for every bundled theme, appearance and kind of accent to
//! `design-system/themes/parity.json`, with the variables the Tauri app sets
//! for the same case; `src/settings/theme-parity.test.ts` evaluates the
//! app's CSS on those variables and must get the same colours.
//!
//! `cargo test -p lattice-ui theme_parity` fails while the committed record
//! is out of date; `LATTICE_UPDATE_THEME_PARITY=1` rewrites it.

use std::sync::Arc;

use gpui::{Hsla, Rgba};
use serde_json::{Map, Value, json};

use crate::{Accent, Appearance, Palette, Tint};

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../design-system/themes/parity.json"
);

fn rgba(color: Hsla) -> String {
    let Rgba { r, g, b, a } = Rgba::from(color);
    let byte = |channel: f32| (channel * 255.).round().clamp(0., 255.) as u8;
    format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        byte(r),
        byte(g),
        byte(b),
        byte(a)
    )
}

fn record() -> Value {
    let mut cases = Vec::new();
    for theme in lattice_theme::bundled() {
        let theme = Arc::new(theme);
        for appearance in [Appearance::Light, Appearance::Dark] {
            for (accent, attribute) in [
                (Accent::Theme, "custom"),
                (Accent::Blue, "blue"),
                (Accent::Graphite, "graphite"),
                (Accent::Custom(0xffe066), "custom"),
            ] {
                let palette =
                    Palette::new(appearance, Tint::Paper, accent).with_theme(Some(theme.clone()));
                let resolved = palette
                    .themed
                    .as_ref()
                    .expect("bundled themes have both variants");
                let variables: Map<String, Value> = resolved
                    .css_variables()
                    .into_iter()
                    .map(|(name, value)| (name, Value::String(value)))
                    .collect();
                let derived = json!({
                    "--surface-titlebar": rgba(palette.titlebar),
                    "--surface-window": rgba(palette.window),
                    "--surface-chrome": rgba(palette.chrome),
                    "--surface-panel": rgba(palette.panel),
                    "--surface-panel-raised": rgba(palette.raised),
                    "--surface-input": rgba(palette.input),
                    "--editor-bg": rgba(palette.editor),
                    "--text-primary": rgba(palette.text),
                    "--text-secondary": rgba(palette.text_secondary),
                    "--border-subtle": rgba(palette.line),
                    "--border-strong": rgba(palette.line_strong),
                    "--accent": rgba(palette.accent),
                    "--accent-soft": rgba(palette.accent_soft),
                    "--focus": rgba(palette.focus),
                    "--pdf-bg": rgba(palette.pdf_ground),
                    "--editor-selection-surface": rgba(palette.selection),
                    "--control-hover-surface": rgba(palette.ink(0.05)),
                    "--status-danger": rgba(palette.danger),
                    "--status-danger-soft": rgba(palette.danger_soft),
                    "--status-danger-soft-hover": rgba(palette.danger_soft_hover),
                    "--status-danger-soft-pressed": rgba(palette.danger_soft_pressed),
                    "--status-success-soft": rgba(palette.success_soft),
                    "--status-warning-soft": rgba(palette.warning_soft),
                    "--annotation-highlight": rgba(palette.annotation_highlight),
                });
                cases.push(json!({
                    "theme": theme.id,
                    "appearance": if appearance == Appearance::Dark { "dark" } else { "light" },
                    "accent": attribute,
                    "variables": variables,
                    "derived": derived,
                }));
            }
        }
    }
    json!({
        "about": "Written by gpui/crates/lattice-ui/src/theme_parity.rs; checked by src/settings/theme-parity.test.ts. Do not edit.",
        "cases": cases,
    })
}

#[test]
fn theme_parity_record_is_current() {
    let generated = serde_json::to_string_pretty(&record()).unwrap() + "\n";
    if std::env::var_os("LATTICE_UPDATE_THEME_PARITY").is_some() {
        std::fs::write(PATH, &generated).unwrap();
    }
    let committed = std::fs::read_to_string(PATH).unwrap_or_default();
    assert!(
        committed == generated,
        "design-system/themes/parity.json is out of date: run LATTICE_UPDATE_THEME_PARITY=1 cargo test -p lattice-ui theme_parity, then the Tauri parity test"
    );
}
