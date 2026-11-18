//! The `lattice-theme.json` format, schema 1 (`docs/themes.md`).

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::roles::{self, SYNTAX_ROLES, TERMINAL_ROLES};
use crate::Appearance;

/// The largest theme file read, far above any real theme.
pub const MAX_THEME_BYTES: usize = 256 * 1024;

/// A colour as a theme writes it: `#RRGGBB` or `#RRGGBBAA`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Color {
    pub rgb: u32,
    pub alpha: u8,
}

impl Color {
    pub const fn opaque(rgb: u32) -> Self {
        Color { rgb, alpha: 0xFF }
    }

    pub fn is_opaque(self) -> bool {
        self.alpha == 0xFF
    }

    pub fn parse(value: &str) -> Option<Color> {
        let digits = value.strip_prefix('#')?;
        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let number = u32::from_str_radix(digits, 16).ok()?;
        match digits.len() {
            6 => Some(Color::opaque(number)),
            8 => Some(Color { rgb: number >> 8, alpha: (number & 0xFF) as u8 }),
            _ => None,
        }
    }

    /// Lower-case `#rrggbb`, or `#rrggbbaa` when not opaque.
    pub fn hex(self) -> String {
        if self.is_opaque() {
            format!("#{:06x}", self.rgb)
        } else {
            format!("#{:06x}{:02x}", self.rgb, self.alpha)
        }
    }
}

impl Serialize for Color {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.hex())
    }
}

/// One appearance of a theme.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Variant {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
    pub colors: BTreeMap<String, Color>,
    pub syntax: BTreeMap<String, Color>,
    pub terminal: BTreeMap<String, Color>,
}

/// A validated theme file.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ThemeFile {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub license: String,
    pub description: String,
    pub variants: Vec<Variant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeError(pub String);

impl fmt::Display for ThemeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ThemeError {}

fn error(message: impl Into<String>) -> ThemeError {
    ThemeError(message.into())
}

// The file as written. Unknown top-level keys are ignored so a theme written
// for a newer Lattice still loads; an unknown role is an error, because it
// asks for a colour this Lattice cannot show.
#[derive(Deserialize)]
struct RawTheme {
    schema: u32,
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    license: String,
    #[serde(default)]
    description: String,
    variants: Vec<RawVariant>,
}

#[derive(Deserialize)]
struct RawVariant {
    id: String,
    #[serde(default)]
    name: Option<String>,
    appearance: Appearance,
    #[serde(default)]
    colors: BTreeMap<String, String>,
    #[serde(default)]
    syntax: BTreeMap<String, String>,
    #[serde(default)]
    terminal: BTreeMap<String, String>,
}

/// A reverse-domain id, as plugins use: lower-case ASCII letters, digits and
/// hyphens in at least two dot-separated labels.
pub fn valid_id(id: &str) -> bool {
    id.len() <= 128
        && id.split('.').count() >= 2
        && id.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn valid_version(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn colors(
    variant: &str, section: &str, raw: BTreeMap<String, String>, known: impl Fn(&str) -> bool,
    opaque: impl Fn(&str) -> bool,
) -> Result<BTreeMap<String, Color>, ThemeError> {
    let mut out = BTreeMap::new();
    for (key, value) in raw {
        if !known(&key) {
            return Err(error(format!(
                "variant \"{variant}\": \"{key}\" is not a {section} role this Lattice knows"
            )));
        }
        let color = Color::parse(&value).ok_or_else(|| {
            error(format!(
                "variant \"{variant}\": {section}.{key} is \"{value}\"; use #RRGGBB or #RRGGBBAA"
            ))
        })?;
        if opaque(&key) && !color.is_opaque() {
            return Err(error(format!(
                "variant \"{variant}\": {section}.{key} colours text, so it must be opaque (#RRGGBB)"
            )));
        }
        out.insert(key, color);
    }
    Ok(out)
}

impl ThemeFile {
    /// Parses and validates a theme file's text.
    pub fn parse(text: &str) -> Result<ThemeFile, ThemeError> {
        if text.len() > MAX_THEME_BYTES {
            return Err(error("the theme file is larger than 256 KiB"));
        }
        let raw: RawTheme =
            serde_json::from_str(text).map_err(|err| error(format!("not a theme file: {err}")))?;
        if raw.schema != 1 {
            return Err(error(format!(
                "theme schema {} is newer than this Lattice reads (1)",
                raw.schema
            )));
        }
        if !valid_id(&raw.id) {
            return Err(error(format!(
                "\"{}\" is not a theme id: use reverse-domain lower case, like dev.example.my-theme",
                raw.id
            )));
        }
        let name = raw.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(error("the theme's name must be 1 to 64 characters"));
        }
        if !valid_version(&raw.version) {
            return Err(error(format!("\"{}\" is not a version like 1.0.0", raw.version)));
        }
        if raw.variants.is_empty() || raw.variants.len() > 8 {
            return Err(error("a theme has 1 to 8 variants"));
        }
        let mut variants: Vec<Variant> = Vec::with_capacity(raw.variants.len());
        for variant in raw.variants {
            if variant.id.is_empty() || variants.iter().any(|seen| seen.id == variant.id) {
                return Err(error(format!("variant id \"{}\" is empty or repeated", variant.id)));
            }
            let id = variant.id;
            let text_role = |key: &str| {
                key == roles::ACCENT
                    || roles::color_role(key).is_some_and(|role| role.fit != roles::Fit::None)
            };
            variants.push(Variant {
                colors: colors(
                    &id,
                    "colors",
                    variant.colors,
                    |key| key == roles::ACCENT || roles::color_role(key).is_some(),
                    text_role,
                )?,
                syntax: colors(
                    &id,
                    "syntax",
                    variant.syntax,
                    |key| SYNTAX_ROLES.contains(&key),
                    |_| true,
                )?,
                terminal: colors(
                    &id,
                    "terminal",
                    variant.terminal,
                    |key| TERMINAL_ROLES.contains(&key),
                    |_| false,
                )?,
                name: variant
                    .name
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| name.clone()),
                appearance: variant.appearance,
                id,
            });
        }
        Ok(ThemeFile {
            id: raw.id,
            name,
            version: raw.version,
            author: raw.author.trim().to_string(),
            license: raw.license.trim().to_string(),
            description: raw.description.trim().to_string(),
            variants,
        })
    }

    /// The first variant for `appearance`, if the theme has one.
    pub fn variant(&self, appearance: Appearance) -> Option<&Variant> {
        self.variants.iter().find(|variant| variant.appearance == appearance)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme(variant: &str) -> String {
        format!(
            r#"{{"schema":1,"id":"dev.example.t","name":"T","version":"1.0.0","variants":[{variant}]}}"#
        )
    }

    #[test]
    fn colours_are_literal_hex_only() {
        assert_eq!(Color::parse("#FAFAFA"), Some(Color::opaque(0xFAFAFA)));
        assert_eq!(Color::parse("#1c1c1f17"), Some(Color { rgb: 0x1c1c1f, alpha: 0x17 }));
        for bad in ["fafafa", "#fff", "red", "var(--bg)", "#gggggg", "#+fffff"] {
            assert_eq!(Color::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_minimal_theme_parses() {
        let file = ThemeFile::parse(&theme(
            r##"{"id":"day","appearance":"light","colors":{"chrome":"#eeeeee"}}"##,
        ))
        .unwrap();
        assert_eq!(file.variants[0].name, "T");
        assert_eq!(
            file.variant(Appearance::Light).unwrap().colors["chrome"],
            Color::opaque(0xeeeeee)
        );
        assert!(file.variant(Appearance::Dark).is_none());
    }

    #[test]
    fn unknown_roles_expressions_and_translucent_ink_are_refused() {
        let unknown = ThemeFile::parse(&theme(
            r##"{"id":"a","appearance":"light","colors":{"hover":"#000000"}}"##,
        ));
        assert!(unknown.unwrap_err().0.contains("\"hover\""));
        let expression = ThemeFile::parse(&theme(
            r#"{"id":"a","appearance":"light","colors":{"text":"color-mix(in srgb, red, blue)"}}"#,
        ));
        assert!(expression.is_err());
        let translucent = ThemeFile::parse(&theme(
            r##"{"id":"a","appearance":"light","colors":{"text":"#00000080"}}"##,
        ));
        assert!(translucent.unwrap_err().0.contains("opaque"));
        let line = ThemeFile::parse(&theme(
            r##"{"id":"a","appearance":"light","colors":{"line":"#00000017"}}"##,
        ));
        assert!(line.is_ok());
    }

    #[test]
    fn ids_versions_and_schema_are_checked() {
        assert!(valid_id("dev.example.rose-pine"));
        for bad in ["rose-pine", "Dev.example", "dev..x", "dev.-x", "dev.ex ample"] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert!(valid_version("1.2.3") && valid_version("1.0.0-beta.1"));
        assert!(!valid_version("1.2") && !valid_version("v1.2.3"));
        let newer =
            r#"{"schema":2,"id":"dev.example.t","name":"T","version":"1.0.0","variants":[]}"#;
        assert!(ThemeFile::parse(newer).unwrap_err().0.contains("newer"));
    }
}
