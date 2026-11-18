//! The themes that ship with Lattice (`design-system/themes/`), the same
//! files a writer could install, so they also exercise the format.

use crate::format::ThemeFile;

/// Each bundled theme's file name and text.
pub const BUNDLED: &[(&str, &str)] = &[
    (
        "rose-pine.lattice-theme.json",
        include_str!("../../../design-system/themes/rose-pine.lattice-theme.json"),
    ),
    (
        "nord.lattice-theme.json",
        include_str!("../../../design-system/themes/nord.lattice-theme.json"),
    ),
];

/// The bundled themes, parsed. A bundled file that does not parse is a bug
/// the tests catch, so it is skipped rather than surfaced at run time.
pub fn bundled() -> Vec<ThemeFile> {
    BUNDLED.iter().filter_map(|(_, text)| ThemeFile::parse(text).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::{COLOR_ROLES, GRAPHITE_DARK, GRAPHITE_LIGHT};
    use serde_json::Value;

    #[test]
    fn every_bundled_theme_parses_with_a_light_and_a_dark_variant() {
        for (name, text) in BUNDLED {
            let theme = ThemeFile::parse(text).unwrap_or_else(|err| panic!("{name}: {err}"));
            assert!(theme.id.starts_with("app.lattice."), "{name}");
            for appearance in [crate::Appearance::Light, crate::Appearance::Dark] {
                assert!(theme.variant(appearance).is_some(), "{name} {appearance:?}");
            }
        }
        assert_eq!(bundled().len(), BUNDLED.len());
    }

    // The roles and Graphite's defaults are the design system's: every colour
    // role is a token in tokens.json, and the defaults are its values.
    #[test]
    fn roles_and_defaults_match_tokens_json() {
        let tokens: Value =
            serde_json::from_str(include_str!("../../../design-system/tokens.json")).unwrap();
        let tokens = &tokens["tokens"];
        let hex = |value: &Value| {
            u32::from_str_radix(value.as_str().unwrap().trim_start_matches('#'), 16).unwrap()
        };
        for role in COLOR_ROLES.iter().map(|role| role.key).chain(["accent"]) {
            assert!(tokens.get(format!("--color-{role}")).is_some(), "{role} is not a token");
        }
        for (key, rgb) in GRAPHITE_LIGHT {
            assert_eq!(hex(&tokens[format!("--color-{key}")]["value"]), rgb, "{key} light");
        }
        for (key, rgb) in GRAPHITE_DARK {
            assert_eq!(hex(&tokens[format!("--color-{key}")]["dark"]), rgb, "{key} dark");
        }
    }

    #[test]
    fn syntax_roles_match_the_code_themes() {
        let themes: Value =
            serde_json::from_str(include_str!("../../../design-system/code-themes.json")).unwrap();
        let properties = themes["themes"][0]["apps"]["light"]["properties"].as_object().unwrap();
        let mut known: Vec<&str> =
            properties.keys().filter_map(|key| key.strip_prefix("--syntax-")).collect();
        known.sort_unstable();
        let mut ours = crate::roles::SYNTAX_ROLES.to_vec();
        ours.sort_unstable();
        assert_eq!(known, ours);
    }
}
