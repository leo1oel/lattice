// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/keymap.ts), with Lattice's patch (⌘ first in a macOS combination).

//! The workspace's commands and their default shortcuts.

use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Command {
    FrameToggle,
    NavigationBack,
    NavigationForward,
    NavigationOverview,
    PanelNext,
    PanelPrevious,
    TabNext,
    TabPrevious,
    ViewClose,
    PanelFloat,
    PanelHide,
}

impl Command {
    pub const ALL: [Command; 11] = [
        Command::FrameToggle,
        Command::NavigationBack,
        Command::NavigationForward,
        Command::NavigationOverview,
        Command::PanelNext,
        Command::PanelPrevious,
        Command::TabNext,
        Command::TabPrevious,
        Command::ViewClose,
        Command::PanelFloat,
        Command::PanelHide,
    ];

    /// Trellis's id for the command.
    pub fn id(self) -> &'static str {
        match self {
            Command::FrameToggle => "frame.toggle",
            Command::NavigationBack => "navigation.back",
            Command::NavigationForward => "navigation.forward",
            Command::NavigationOverview => "navigation.overview",
            Command::PanelNext => "panel.next",
            Command::PanelPrevious => "panel.previous",
            Command::TabNext => "tab.next",
            Command::TabPrevious => "tab.previous",
            Command::ViewClose => "view.close",
            Command::PanelFloat => "panel.float",
            Command::PanelHide => "panel.hide",
        }
    }
}

/// Each command's combination (`None`: unbound).
pub type Keymap = BTreeMap<Command, Option<String>>;

pub fn default_keymap() -> Keymap {
    let mut map = Keymap::new();
    let mut set = |command, combo: Option<&str>| {
        map.insert(command, combo.map(str::to_string));
    };
    set(Command::FrameToggle, Some("Mod+Shift+Enter"));
    set(Command::NavigationBack, Some("Mod+Alt+ArrowLeft"));
    set(Command::NavigationForward, Some("Mod+Alt+ArrowRight"));
    set(Command::NavigationOverview, Some("Mod+Alt+ArrowUp"));
    set(Command::PanelNext, Some("F6"));
    set(Command::PanelPrevious, Some("Shift+F6"));
    set(Command::TabNext, Some("Mod+Alt+]"));
    set(Command::TabPrevious, Some("Mod+Alt+["));
    set(Command::ViewClose, Some("Mod+Alt+W"));
    set(Command::PanelFloat, None);
    set(Command::PanelHide, None);
    map
}

/// The default keymap with `overrides` laid over it.
pub fn keymap_with(overrides: &[(Command, Option<&str>)]) -> Keymap {
    let mut map = default_keymap();
    for (command, combo) in overrides {
        map.insert(*command, combo.map(str::to_string));
    }
    map
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Combo {
    pub key: String,
    pub mod_: bool,
    pub ctrl: bool,
    pub meta: bool,
    pub alt: bool,
    pub shift: bool,
}

pub fn parse_combo(combo: &str) -> Combo {
    let mut parts: Vec<&str> = combo.split('+').map(str::trim).collect();
    // "Mod++" style: a trailing empty part means the key is "+".
    let key = match parts.pop() {
        Some("") | None => "+".to_string(),
        Some(key) => key.to_string(),
    };
    let has = |name: &str| parts.iter().any(|p| p.eq_ignore_ascii_case(name));
    Combo {
        mod_: has("Mod"),
        ctrl: has("Ctrl") || has("Control"),
        meta: has("Meta") || has("Cmd"),
        alt: has("Alt") || has("Option"),
        shift: has("Shift"),
        key,
    }
}

/// A key press, as the host reports it: the key's name (`"Enter"`,
/// `"ArrowLeft"`, `"]"`, `"w"`) and the modifiers held.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyPress {
    pub key: String,
    pub ctrl: bool,
    pub meta: bool,
    pub alt: bool,
    pub shift: bool,
}

/// Whether `press` is `combo`, with Mod as ⌘ on macOS and Ctrl elsewhere.
/// Keys are compared by name, case-insensitively.
pub fn matches(press: &KeyPress, combo: &str, mac: bool) -> bool {
    let c = parse_combo(combo);
    let want_ctrl = c.ctrl || (c.mod_ && !mac);
    let want_meta = c.meta || (c.mod_ && mac);
    press.ctrl == want_ctrl
        && press.meta == want_meta
        && press.alt == c.alt
        && press.shift == c.shift
        && press.key.eq_ignore_ascii_case(&c.key)
}

/// Human-readable shortcut, e.g. "⌘⌥←" on macOS or "Ctrl+Alt+←" elsewhere.
/// Lattice patch: ⌘ first, as Lattice writes every combination: ⌘⇧↩, not ⇧⌘↩.
pub fn format_combo(combo: &str, mac: bool) -> String {
    let c = parse_combo(combo);
    let key = match c.key.as_str() {
        "ArrowLeft" => "←".to_string(),
        "ArrowRight" => "→".to_string(),
        "ArrowUp" => "↑".to_string(),
        "ArrowDown" => "↓".to_string(),
        "Enter" => if mac { "↩" } else { "Enter" }.to_string(),
        key if key.chars().count() == 1 => key.to_uppercase(),
        key => key.to_string(),
    };
    if mac {
        return format!(
            "{}{}{}{}{key}",
            if c.ctrl { "⌃" } else { "" },
            if c.mod_ || c.meta { "⌘" } else { "" },
            if c.alt { "⌥" } else { "" },
            if c.shift { "⇧" } else { "" },
        );
    }
    [
        (c.mod_ || c.ctrl).then_some("Ctrl"),
        c.meta.then_some("Meta"),
        c.alt.then_some("Alt"),
        c.shift.then_some("Shift"),
        Some(key.as_str()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_with_command_first_on_macos() {
        assert_eq!(format_combo("Mod+Shift+Enter", true), "⌘⇧↩");
        assert_eq!(format_combo("Mod+Alt+ArrowLeft", true), "⌘⌥←");
        assert_eq!(format_combo("Mod+Shift+Enter", false), "Ctrl+Shift+Enter");
        assert_eq!(format_combo("Mod+Alt+W", false), "Ctrl+Alt+W");
    }

    #[test]
    fn matches_mod_per_platform() {
        let press = KeyPress {
            key: "Enter".into(),
            meta: true,
            shift: true,
            ..Default::default()
        };
        assert!(matches(&press, "Mod+Shift+Enter", true));
        assert!(!matches(&press, "Mod+Shift+Enter", false));
        assert!(!matches(&press, "Mod+Enter", true));
    }
}
