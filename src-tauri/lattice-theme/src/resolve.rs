//! A theme as one appearance shows it: the variant, the accent, and every
//! text colour fitted to its floor.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::color::{fit_accent, fit_contrast, ACCENT_FLOOR};
use crate::format::{Color, ThemeFile};
use crate::roles::{
    self, Fit, COLOR_ROLES, GRAPHITE_DARK, GRAPHITE_LIGHT, SYNTAX_ROLES, TERMINAL_ROLES,
};
use crate::Appearance;

/// The writer's accent choice (Settings › Appearance › Accent). An accent
/// the writer picked wins over the theme's; `ThemeDefault` takes the
/// theme's, or the app's own Graphite when there is no theme or it has none
/// (decision L13).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccentChoice {
    ThemeDefault,
    /// A preset, as `0xRRGGBB` in the appearance being resolved. Presets
    /// already read on the app's own surfaces, so without a theme they are
    /// left to the shell.
    Preset(u32),
    /// A colour the writer picked.
    Custom(u32),
}

/// What a shell lays over its own palette. Roles a theme leaves out are not
/// here: they keep the app's own colour for the appearance.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub appearance: Appearance,
    /// The theme in effect, or `None` when no theme has a variant for this
    /// appearance.
    pub theme: Option<String>,
    pub variant: Option<String>,
    pub colors: BTreeMap<&'static str, Color>,
    /// The accent to use, fitted; `None` leaves the shell's own accent.
    pub accent: Option<Color>,
    pub syntax: BTreeMap<&'static str, Color>,
    pub terminal: BTreeMap<&'static str, Color>,
}

fn graphite(appearance: Appearance, key: &str) -> u32 {
    let table = match appearance {
        Appearance::Light => &GRAPHITE_LIGHT,
        Appearance::Dark => &GRAPHITE_DARK,
    };
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, rgb)| *rgb)
        .expect("a Graphite surface or ink")
}

/// Resolves `theme` (or no theme) for `appearance` with the writer's
/// `accent` choice.
pub fn resolve(
    theme: Option<&ThemeFile>, appearance: Appearance, accent: AccentChoice,
) -> Resolved {
    let variant = theme.and_then(|theme| theme.variant(appearance));
    let Some(variant) = variant else {
        return Resolved {
            appearance,
            accent: match accent {
                AccentChoice::Custom(rgb) => Some(Color::opaque(fit_accent(rgb, appearance))),
                AccentChoice::ThemeDefault | AccentChoice::Preset(_) => None,
            },
            ..Resolved::default()
        };
    };
    // The surfaces as this variant paints them, the app's own where it is
    // silent: what its inks have to read on.
    let surface = |key: &str| {
        variant
            .colors
            .get(key)
            .filter(|color| color.is_opaque())
            .map(|color| color.rgb)
            .unwrap_or_else(|| graphite(appearance, key))
    };
    let all_surfaces = ["window", "chrome", "panel", "raised", "editor"].map(surface);
    let text_surfaces = ["chrome", "panel", "raised", "editor"].map(surface);
    let sheets = ["panel", "raised"].map(surface);

    let mut colors = BTreeMap::new();
    for role in COLOR_ROLES {
        let Some(color) = variant.colors.get(role.key) else {
            continue;
        };
        let fitted = match role.fit {
            Fit::None => *color,
            Fit::Text => Color::opaque(fit_contrast(color.rgb, &all_surfaces, 4.5, appearance)),
            Fit::Status => Color::opaque(fit_contrast(color.rgb, &sheets, 4.5, appearance)),
        };
        colors.insert(role.key, fitted);
    }

    let fit_to_theme =
        |rgb: u32| Color::opaque(fit_contrast(rgb, &text_surfaces, ACCENT_FLOOR, appearance));
    let accent = match accent {
        AccentChoice::ThemeDefault => {
            variant.colors.get(roles::ACCENT).map(|color| fit_to_theme(color.rgb))
        }
        AccentChoice::Preset(rgb) | AccentChoice::Custom(rgb) => Some(fit_to_theme(rgb)),
    };

    let editor = [surface("editor")];
    let syntax = SYNTAX_ROLES
        .iter()
        .filter_map(|key| {
            let color = variant.syntax.get(*key)?;
            Some((*key, Color::opaque(fit_contrast(color.rgb, &editor, 4.5, appearance))))
        })
        .collect();
    let terminal = TERMINAL_ROLES
        .iter()
        .filter_map(|key| Some((*key, *variant.terminal.get(*key)?)))
        .collect();

    Resolved {
        appearance,
        theme: theme.map(|theme| theme.id.clone()),
        variant: Some(variant.id.clone()),
        colors,
        accent,
        syntax,
        terminal,
    }
}

impl Resolved {
    /// The CSS custom properties the Tauri app sets on `<html>` for this
    /// theme: base variables only, which `theme.css` and `foundations.css`
    /// derive every other role from.
    pub fn css_variables(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for role in COLOR_ROLES {
            if let Some(color) = self.colors.get(role.key) {
                for name in role.css {
                    out.push(((*name).to_string(), color.hex()));
                }
            }
        }
        if let Some(accent) = self.accent {
            out.push(("--accent".to_string(), accent.hex()));
        }
        for (key, color) in &self.syntax {
            out.push((format!("--syntax-{key}"), color.hex()));
        }
        for (key, color) in &self.terminal {
            out.push((format!("--terminal-{key}"), color.hex()));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::contrast_ratio;

    fn theme(colors: &str) -> ThemeFile {
        ThemeFile::parse(&format!(
            r##"{{"schema":1,"id":"dev.example.t","name":"T","version":"1.0.0","variants":[
              {{"id":"night","appearance":"dark","colors":{colors},
                "syntax":{{"comment":"#303040"}},"terminal":{{"red":"#ff0000"}}}}]}}"##
        ))
        .unwrap()
    }

    #[test]
    fn no_theme_leaves_everything_to_the_shell_but_a_custom_accent() {
        let none = resolve(None, Appearance::Light, AccentChoice::Preset(0x096acb));
        assert_eq!(none, Resolved { appearance: Appearance::Light, ..Resolved::default() });
        let custom = resolve(None, Appearance::Light, AccentChoice::Custom(0xffe066));
        assert_eq!(custom.accent, Some(Color::opaque(fit_accent(0xffe066, Appearance::Light))));
        assert!(custom.css_variables().iter().any(|(name, _)| name == "--accent"));
    }

    #[test]
    fn a_theme_without_a_variant_for_the_appearance_is_not_in_effect() {
        let file = theme(r##"{"chrome":"#101018"}"##);
        let light = resolve(Some(&file), Appearance::Light, AccentChoice::ThemeDefault);
        assert_eq!(light.theme, None);
        assert!(light.colors.is_empty());
        let dark = resolve(Some(&file), Appearance::Dark, AccentChoice::ThemeDefault);
        assert_eq!(dark.theme.as_deref(), Some("dev.example.t"));
        assert_eq!(dark.variant.as_deref(), Some("night"));
    }

    #[test]
    fn inks_and_syntax_are_lifted_to_read_on_the_themes_surfaces() {
        let file = theme(
            r##"{"chrome":"#101018","panel":"#181820","text":"#505060","accent":"#202080"}"##,
        );
        let resolved = resolve(Some(&file), Appearance::Dark, AccentChoice::ThemeDefault);
        let text = resolved.colors["text"].rgb;
        for ground in [0x101018, 0x181820, 0x252528, 0x1F1F22, 0x171718] {
            assert!(contrast_ratio(text, ground) >= 4.45, "{text:06x} on {ground:06x}");
        }
        let accent = resolved.accent.unwrap().rgb;
        assert!(contrast_ratio(accent, 0x181820) >= 4.55);
        let comment = resolved.syntax["comment"].rgb;
        assert!(contrast_ratio(comment, 0x1F1F22) >= 4.45);
        // Surfaces and the terminal are taken as given.
        assert_eq!(resolved.colors["chrome"], Color::opaque(0x101018));
        assert_eq!(resolved.terminal["red"], Color::opaque(0xff0000));
    }

    #[test]
    fn the_writers_accent_wins_over_the_themes() {
        let file = theme(r##"{"accent":"#9ccfd8"}"##);
        let theirs = resolve(Some(&file), Appearance::Dark, AccentChoice::ThemeDefault);
        assert_eq!(theirs.accent, Some(Color::opaque(0x9ccfd8)));
        let mine = resolve(Some(&file), Appearance::Dark, AccentChoice::Preset(0xd56b97));
        assert_eq!(mine.accent, Some(Color::opaque(0xd56b97)));
        let silent = theme(r##"{"chrome":"#101018"}"##);
        assert_eq!(
            resolve(Some(&silent), Appearance::Dark, AccentChoice::ThemeDefault).accent,
            None
        );
    }

    #[test]
    fn css_variables_are_the_base_variables() {
        let file = theme(r##"{"editor":"#1e1e2e","line":"#ffffff14","accent":"#9ccfd8"}"##);
        let variables =
            resolve(Some(&file), Appearance::Dark, AccentChoice::ThemeDefault).css_variables();
        let get = |name: &str| {
            variables.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
        };
        assert_eq!(get("--editor-bg"), Some("#1e1e2e"));
        assert_eq!(get("--editor-gutter"), Some("#1e1e2e"));
        assert_eq!(get("--line"), Some("#ffffff14"));
        assert_eq!(get("--accent"), Some("#9ccfd8"));
        assert!(get("--syntax-comment").is_some());
        assert_eq!(get("--terminal-red"), Some("#ff0000"));
    }
}
