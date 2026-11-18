//! The roles a theme may colour, and where each one lands.
//!
//! Colour roles are the design system's base colours, named as
//! `design-system/tokens.json` names them without `--color-` (a test holds
//! the two together). Each carries the Tauri app's base CSS variables it sets:
//! the variables `theme.css` declares per tint, which every derived role
//! (`color-mix` in `theme.css` and `foundations.css`) is computed from.

/// How a role is held to a contrast floor when a theme sets it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    /// A surface, a line or a wash: used as given.
    None,
    /// Ink: 4.5:1 on every surface.
    Text,
    /// A status colour, used for text on panels: 4.5:1 on the panel and lift.
    Status,
}

pub struct ColorRole {
    pub key: &'static str,
    /// The Tauri app's base variables this role sets.
    pub css: &'static [&'static str],
    pub fit: Fit,
}

const fn role(key: &'static str, css: &'static [&'static str], fit: Fit) -> ColorRole {
    ColorRole { key, css, fit }
}

/// Every colour role, surfaces first. `accent` is resolved on its own
/// (`resolve::AccentChoice`), so it is not in this list.
pub const COLOR_ROLES: &[ColorRole] = &[
    role("window", &["--bg"], Fit::None),
    role("chrome", &["--chrome-surface"], Fit::None),
    role("panel", &["--panel"], Fit::None),
    role("raised", &["--panel-strong"], Fit::None),
    role("input", &["--side-surface"], Fit::None),
    role("editor", &["--editor-bg", "--editor-gutter"], Fit::None),
    role("pdf-ground", &["--pdf-bg"], Fit::None),
    role("text", &["--text"], Fit::Text),
    role("text-secondary", &["--muted"], Fit::Text),
    role("line", &["--line"], Fit::None),
    role("line-strong", &["--line-strong"], Fit::None),
    role("focus", &["--focus"], Fit::None),
    role("selection", &["--editor-selection-tint"], Fit::None),
    role("danger", &["--danger"], Fit::Status),
    role("success", &["--success"], Fit::Status),
    role("warning", &["--warning"], Fit::Status),
    role("info", &["--info"], Fit::Status),
    role("annotation", &["--annotation"], Fit::Status),
];

/// The key of the accent role in a theme's `colors`.
pub const ACCENT: &str = "accent";

/// The source editor's token roles (`design-system/code-themes.json`), each
/// set as `--syntax-<role>` and held to 4.5:1 on the editor surface.
pub const SYNTAX_ROLES: &[&str] = &[
    "attribute",
    "bracket",
    "citation",
    "comment",
    "comment-doc",
    "constant",
    "function",
    "keyword",
    "number",
    "operator",
    "property",
    "reference",
    "string",
    "type",
    "variable",
    "variable-special",
];

/// The terminal's sixteen ANSI colours, each set as `--terminal-<role>`.
pub const TERMINAL_ROLES: &[&str] = &[
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "bright-black",
    "bright-red",
    "bright-green",
    "bright-yellow",
    "bright-blue",
    "bright-magenta",
    "bright-cyan",
    "bright-white",
];

/// Graphite's surfaces and inks, which a theme that leaves one out stands
/// on, and which its inks are fitted against: window, chrome, panel,
/// raised, editor, text, text-secondary (`tokens.json`, held by a test).
pub(crate) const GRAPHITE_LIGHT: [(&str, u32); 7] = [
    ("window", 0xF7F7F6),
    ("chrome", 0xEFEFF0),
    ("panel", 0xFAFAFA),
    ("raised", 0xFFFFFF),
    ("editor", 0xFAFAFA),
    ("text", 0x242426),
    ("text-secondary", 0x5F5F64),
];
pub(crate) const GRAPHITE_DARK: [(&str, u32); 7] = [
    ("window", 0x171718),
    ("chrome", 0x131315),
    ("panel", 0x1A1A1C),
    ("raised", 0x252528),
    ("editor", 0x1F1F22),
    ("text", 0xE9E9E7),
    ("text-secondary", 0xA0A0A7),
];

pub fn color_role(key: &str) -> Option<&'static ColorRole> {
    COLOR_ROLES.iter().find(|role| role.key == key)
}
