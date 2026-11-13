//! The preferences themselves, typed, with the Tauri app's defaults and its
//! reading of a stored value (`src/settings/app-settings.ts`): every field is
//! read on its own, and one that is missing or unusable takes its default
//! while the others keep theirs, so a hand edit or an older store never loses
//! more than the field it broke.

use serde::Serialize;
use serde_json::{Map, Value};

/// The interface size steps of Settings › Appearance (`interface-scale.ts`).
pub const INTERFACE_SCALE_STEPS: [f32; 5] = [0.9, 1.0, 1.1, 1.2, 1.35];
pub const INTERFACE_SCALE_RANGE: (f32, f32) = (0.9, 1.35);
/// Both editors' font sizes and line heights (`editor-fonts.ts`).
pub const FONT_SIZE_RANGE: (f32, f32) = (10., 28.);
pub const LINE_HEIGHT_RANGE: (f32, f32) = (1.2, 2.4);
pub const SOURCE_LINE_HEIGHT: f32 = 1.6;
pub const PROSE_FONT_SIZE: f32 = 14.;
pub const PROSE_LINE_HEIGHT: f32 = 1.7;
pub const EDITOR_FONT_SIZE: f32 = 14.;

/// A choice among named values, stored as the Tauri app stores it.
pub trait Choice: Sized + Copy + PartialEq + 'static {
    const ALL: &'static [Self];
    fn tag(self) -> &'static str;

    fn from_tag(tag: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|choice| choice.tag() == tag)
    }
}

macro_rules! choice {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $tag:literal),+ $(,)? } default $default:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name { $($(#[$vmeta])* $variant),+ }

        impl Default for $name {
            fn default() -> Self { $name::$default }
        }

        impl Choice for $name {
            const ALL: &'static [Self] = &[$($name::$variant),+];
            fn tag(self) -> &'static str {
                match self { $($name::$variant => $tag),+ }
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.tag())
            }
        }
    };
}

choice!(
    /// Light, dark, or the system's appearance as it changes.
    ThemePreference { System = "system", Light = "light", Dark = "dark" } default System
);
choice!(
    /// Settings › Appearance › Interface language.
    InterfaceLanguage { System = "system", En = "en", ZhCn = "zh-CN" } default System
);
choice!(
    EditorKeymap { Default = "default", Vim = "vim", Emacs = "emacs" } default Default
);
choice!(
    /// Where notifications stack. Top left is missing on purpose: the
    /// traffic lights live there.
    ToastPosition {
        TopRight = "top-right",
        TopCenter = "top-center",
        BottomRight = "bottom-right",
        BottomCenter = "bottom-center",
    } default BottomRight
);
choice!(
    /// The title bar's tool buttons, each of which can be hidden.
    TitlebarTool {
        Comments = "comments",
        Overleaf = "overleaf",
        Git = "git",
        History = "history",
        Browser = "browser",
    } default Comments
);
choice!(
    Tint { Graphite = "graphite", Paper = "paper", Sage = "sage", Mist = "mist", Dusk = "dusk" } default Graphite
);
choice!(
    AccentPreset {
        Graphite = "graphite",
        Blue = "blue",
        Purple = "purple",
        Pink = "pink",
        Orange = "orange",
        Green = "green",
        Teal = "teal",
    } default Graphite
);
choice!(
    /// How much of the desktop shows through the window chrome (macOS).
    Translucency { Off = "off", Subtle = "subtle", Strong = "strong" } default Subtle
);
choice!(
    CodeTheme {
        Github = "github",
        Lattice = "lattice",
        One = "one",
        Solarized = "solarized",
        Catppuccin = "catppuccin",
        TokyoNight = "tokyo-night",
        Dracula = "dracula",
        Nord = "nord",
        Monokai = "monokai",
    } default Github
);
choice!(
    /// Which variant of a two-variant code theme; `auto` follows the app.
    CodeThemeVariant { Auto = "auto", Light = "light", Dark = "dark" } default Auto
);
choice!(
    AutoBuildMode { Manual = "manual", Automatic = "automatic" } default Automatic
);
choice!(
    /// The Settings pages; Settings reopens on the one it was left on.
    SettingsTab {
        Appearance = "appearance",
        Editor = "editor",
        Agent = "agent",
        Mcp = "mcp",
        Usage = "usage",
        Environment = "environment",
        ModelEndpoint = "model-endpoint",
        Overleaf = "overleaf",
        Literature = "literature",
        Api = "api",
        Doctor = "doctor",
        Logs = "logs",
        Acknowledgements = "acknowledgements",
    } default Appearance
);

/// An accent preset, or a custom colour as lowercase `#rrggbb`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Accent {
    Preset(AccentPreset),
    Custom(String),
}

impl Default for Accent {
    fn default() -> Self {
        Accent::Preset(AccentPreset::default())
    }
}

impl Accent {
    pub fn tag(&self) -> &str {
        match self {
            Accent::Preset(preset) => preset.tag(),
            Accent::Custom(hex) => hex,
        }
    }

    /// A stored accent (`normalizeAccent`), or `None` when it is neither a
    /// preset nor a hex colour.
    pub fn parse(value: &str) -> Option<Accent> {
        if let Some(preset) = AccentPreset::from_tag(value) {
            return Some(Accent::Preset(preset));
        }
        let hex = value.strip_prefix('#')?;
        (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| Accent::Custom(value.to_ascii_lowercase()))
    }

    /// The custom colour's channels, 0–255.
    pub fn custom_rgb(&self) -> Option<[u8; 3]> {
        let Accent::Custom(hex) = self else {
            return None;
        };
        let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
        Some([channel(1)?, channel(3)?, channel(5)?])
    }
}

impl Serialize for Accent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.tag())
    }
}

/// The Tauri app's `AppearanceSettings`, field for field.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub interface_language: InterfaceLanguage,
    pub interface_scale: f32,
    /// The source editor's size; its face and line height follow.
    pub editor_font_size: f32,
    /// A face for the source editor, or "" for the default.
    pub source_font: String,
    pub source_line_height: f32,
    /// A face for the visual Markdown editor, or "" for the reading face.
    pub prose_font: String,
    pub prose_font_size: f32,
    pub prose_line_height: f32,
    pub editor_keymap: EditorKeymap,
    pub editor_spellcheck: bool,
    pub interface_sounds: bool,
    pub toast_position: ToastPosition,
    pub hidden_titlebar_tools: Vec<TitlebarTool>,
    pub tint: Tint,
    pub accent: Accent,
    pub translucency: Translucency,
    pub code_theme: CodeTheme,
    pub code_theme_variant: CodeThemeVariant,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance {
            interface_language: InterfaceLanguage::System,
            interface_scale: 1.,
            editor_font_size: EDITOR_FONT_SIZE,
            source_font: String::new(),
            source_line_height: SOURCE_LINE_HEIGHT,
            prose_font: String::new(),
            prose_font_size: PROSE_FONT_SIZE,
            prose_line_height: PROSE_LINE_HEIGHT,
            editor_keymap: EditorKeymap::Default,
            editor_spellcheck: true,
            interface_sounds: true,
            // Clear of the PDF toolbar and the build's diagnostics card,
            // which share the top right.
            toast_position: ToastPosition::BottomRight,
            hidden_titlebar_tools: Vec::new(),
            tint: Tint::Graphite,
            accent: Accent::default(),
            translucency: Translucency::Subtle,
            code_theme: CodeTheme::Github,
            code_theme_variant: CodeThemeVariant::Auto,
        }
    }
}

/// JavaScript's `Number(value)`, for the values a store can hold: a number,
/// a numeric string, a boolean; `None` for what reads as NaN.
fn js_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if text.trim().is_empty() => Some(0.),
        Value::String(text) => text.trim().parse().ok(),
        Value::Bool(flag) => Some(if *flag { 1. } else { 0. }),
        Value::Null => Some(0.),
        _ => None,
    }
    .filter(|number| number.is_finite())
}

/// `clamp(Number(value) || fallback, min, max)`.
fn number_or(value: Option<&Value>, fallback: f32, (min, max): (f32, f32)) -> f32 {
    let number = js_number(value)
        .filter(|number| *number != 0.)
        .map(|number| number as f32)
        .unwrap_or(fallback);
    number.clamp(min, max)
}

fn choice<T: Choice>(value: Option<&Value>, fallback: T) -> T {
    value
        .and_then(Value::as_str)
        .and_then(T::from_tag)
        .unwrap_or(fallback)
}

/// A stored face name (`normalizeFontName`): quotes, backslashes and
/// characters that could close a declaration dropped, trimmed, 80 at most.
pub fn normalize_font_name(value: Option<&Value>) -> String {
    let Some(Value::String(text)) = value else {
        return String::new();
    };
    let kept: String = text
        .chars()
        .filter(|c| !matches!(c, '"' | '\'' | '\\' | ';' | '{' | '}' | '<' | '>') && !c.is_control())
        .collect();
    kept.trim().chars().take(80).collect()
}

/// Line heights move in steps of 0.05 inside [`LINE_HEIGHT_RANGE`].
pub fn normalize_line_height(value: Option<&Value>, fallback: f32) -> f32 {
    match js_number(value) {
        Some(number) if number > 0. => {
            let (min, max) = LINE_HEIGHT_RANGE;
            ((number as f32).clamp(min, max) * 20.).round() / 20.
        }
        _ => fallback,
    }
}

/// The interface size step closest to `scale`.
pub fn nearest_interface_step(scale: f32) -> f32 {
    INTERFACE_SCALE_STEPS
        .iter()
        .copied()
        .fold(1., |best, step| {
            if (step - scale).abs() < (best - scale).abs() {
                step
            } else {
                best
            }
        })
}

/// ⌘+, ⌘− and ⌘0: the size one step up or down, held at the ends, or 100%.
pub fn zoomed_interface_scale(scale: f32, change: i8) -> f32 {
    if change == 0 {
        return 1.;
    }
    let steps = INTERFACE_SCALE_STEPS;
    let index = steps
        .iter()
        .position(|step| *step == nearest_interface_step(scale))
        .unwrap_or(1) as i32;
    steps[(index + i32::from(change.signum())).clamp(0, steps.len() as i32 - 1) as usize]
}

impl Appearance {
    /// Read a stored appearance (`loadAppearance`). `legacy` says it came
    /// from an older key (v4 or v3), whose 110% was the implicit default
    /// and is read as 100%.
    pub fn from_value(value: &Value, legacy: bool) -> Appearance {
        let defaults = Appearance::default();
        let empty = Map::new();
        let fields = value.as_object().unwrap_or(&empty);
        let field = |name: &str| fields.get(name);
        let interface_scale = number_or(
            field("interfaceScale"),
            defaults.interface_scale,
            INTERFACE_SCALE_RANGE,
        );
        let hidden = field("hiddenTitlebarTools")
            .and_then(Value::as_array)
            .map(|tools| {
                TitlebarTool::ALL
                    .iter()
                    .copied()
                    .filter(|tool| tools.iter().any(|stored| stored.as_str() == Some(tool.tag())))
                    .collect()
            })
            .unwrap_or_default();
        Appearance {
            interface_language: choice(field("interfaceLanguage"), defaults.interface_language),
            interface_scale: if legacy && (interface_scale - 1.1).abs() < 1e-6 {
                defaults.interface_scale
            } else {
                interface_scale
            },
            editor_font_size: number_or(
                field("editorFontSize"),
                defaults.editor_font_size,
                FONT_SIZE_RANGE,
            ),
            source_font: normalize_font_name(field("sourceFont")),
            source_line_height: normalize_line_height(
                field("sourceLineHeight"),
                defaults.source_line_height,
            ),
            prose_font: normalize_font_name(field("proseFont")),
            prose_font_size: number_or(
                field("proseFontSize"),
                defaults.prose_font_size,
                FONT_SIZE_RANGE,
            ),
            prose_line_height: normalize_line_height(
                field("proseLineHeight"),
                defaults.prose_line_height,
            ),
            editor_keymap: choice(field("editorKeymap"), defaults.editor_keymap),
            // Absent means "never chose"; only an explicit false turns it off.
            editor_spellcheck: field("editorSpellcheck") != Some(&Value::Bool(false)),
            interface_sounds: field("interfaceSounds") != Some(&Value::Bool(false)),
            toast_position: choice(field("toastPosition"), defaults.toast_position),
            hidden_titlebar_tools: hidden,
            tint: choice(field("tint"), defaults.tint),
            accent: field("accent")
                .and_then(Value::as_str)
                .and_then(Accent::parse)
                .unwrap_or(defaults.accent),
            translucency: choice(field("translucency"), defaults.translucency),
            code_theme: choice(field("codeTheme"), defaults.code_theme),
            code_theme_variant: choice(field("codeThemeVariant"), defaults.code_theme_variant),
        }
    }
}

/// Everything Settings keeps for the GPUI app.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme_preference: ThemePreference,
    pub appearance: Appearance,
    pub auto_build_mode: AutoBuildMode,
    /// "Your name": what signs comments when no Git or Overleaf name does.
    pub author_name: String,
    pub settings_tab: SettingsTab,
}

/// The version of the file's layout; a file from a newer one is set aside.
pub const FILE_VERSION: u64 = 1;

impl Settings {
    /// Read the GPUI app's settings file, each field on its own.
    pub fn from_value(value: &Value) -> Settings {
        let defaults = Settings::default();
        let field = |name: &str| value.get(name);
        Settings {
            theme_preference: choice(field("themePreference"), defaults.theme_preference),
            appearance: field("appearance")
                .map(|appearance| Appearance::from_value(appearance, false))
                .unwrap_or_default(),
            auto_build_mode: choice(field("autoBuildMode"), defaults.auto_build_mode),
            author_name: field("authorName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            settings_tab: choice(field("settingsTab"), defaults.settings_tab),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(object) = value.as_object_mut() {
            object.insert("version".into(), FILE_VERSION.into());
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_empty_store_is_the_tauri_apps_defaults() {
        let appearance = Appearance::from_value(&Value::Null, false);
        assert_eq!(appearance, Appearance::default());
        assert_eq!(appearance.toast_position, ToastPosition::BottomRight);
        assert_eq!(appearance.translucency, Translucency::Subtle);
        assert!(appearance.editor_spellcheck);
    }

    #[test]
    fn each_field_is_read_on_its_own() {
        let appearance = Appearance::from_value(
            &json!({
                "interfaceLanguage": "zh-CN",
                "interfaceScale": 5,
                "editorFontSize": "16",
                "sourceFont": "  \"Fira Code\";  ",
                "sourceLineHeight": 1.63,
                "proseFontSize": 0,
                "proseLineHeight": -1,
                "editorKeymap": "vim",
                "editorSpellcheck": false,
                "interfaceSounds": "no",
                "toastPosition": "top-left",
                "hiddenTitlebarTools": ["git", "nope", "comments"],
                "tint": "sage",
                "accent": "#3D7AF2",
                "translucency": "strong",
                "codeTheme": "tokyo-night",
                "codeThemeVariant": "dark"
            }),
            false,
        );
        assert_eq!(appearance.interface_language, InterfaceLanguage::ZhCn);
        assert_eq!(appearance.interface_scale, 1.35);
        assert_eq!(appearance.editor_font_size, 16.);
        assert_eq!(appearance.source_font, "Fira Code");
        assert_eq!(appearance.source_line_height, 1.65);
        assert_eq!(appearance.prose_font_size, PROSE_FONT_SIZE);
        assert_eq!(appearance.prose_line_height, PROSE_LINE_HEIGHT);
        assert_eq!(appearance.editor_keymap, EditorKeymap::Vim);
        assert!(!appearance.editor_spellcheck);
        // Only an explicit false turns a switch off.
        assert!(appearance.interface_sounds);
        assert_eq!(appearance.toast_position, ToastPosition::BottomRight);
        assert_eq!(
            appearance.hidden_titlebar_tools,
            vec![TitlebarTool::Comments, TitlebarTool::Git]
        );
        assert_eq!(appearance.tint, Tint::Sage);
        assert_eq!(appearance.accent, Accent::Custom("#3d7af2".into()));
        assert_eq!(appearance.accent.custom_rgb(), Some([0x3d, 0x7a, 0xf2]));
        assert_eq!(appearance.code_theme, CodeTheme::TokyoNight);
        assert_eq!(appearance.code_theme_variant, CodeThemeVariant::Dark);
    }

    #[test]
    fn a_legacy_store_reads_its_implicit_110_percent_as_100() {
        let stored = json!({ "interfaceScale": 1.1 });
        assert_eq!(Appearance::from_value(&stored, true).interface_scale, 1.);
        assert_eq!(Appearance::from_value(&stored, false).interface_scale, 1.1);
    }

    #[test]
    fn interface_size_steps_and_zoom() {
        assert_eq!(nearest_interface_step(1.04), 1.);
        assert_eq!(nearest_interface_step(1.3), 1.35);
        assert_eq!(zoomed_interface_scale(1., 1), 1.1);
        assert_eq!(zoomed_interface_scale(1.35, 1), 1.35);
        assert_eq!(zoomed_interface_scale(0.9, -1), 0.9);
        assert_eq!(zoomed_interface_scale(1.2, 0), 1.);
    }

    #[test]
    fn the_settings_file_round_trips() {
        let mut settings = Settings::default();
        settings.theme_preference = ThemePreference::Dark;
        settings.appearance.accent = Accent::Preset(AccentPreset::Teal);
        settings.appearance.hidden_titlebar_tools = vec![TitlebarTool::Browser];
        settings.auto_build_mode = AutoBuildMode::Manual;
        settings.author_name = "Ada".into();
        settings.settings_tab = SettingsTab::Editor;
        let value = settings.to_value();
        assert_eq!(value["version"], json!(1));
        assert_eq!(value["appearance"]["accent"], json!("teal"));
        assert_eq!(value["appearance"]["interfaceLanguage"], json!("system"));
        assert_eq!(Settings::from_value(&value), settings);
    }
}
