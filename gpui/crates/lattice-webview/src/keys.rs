//! Shortcut forwarding: the app's keys pressed inside an island's page.
//!
//! A focused WKWebView takes every key AppKit sends it, so ⌘B in a page
//! never reaches GPUI's keymap. The Tauri app has the same seam at its
//! iframes and forwards the host's shortcuts from the Agent
//! (`src/agent/synara-host-shortcuts.ts`); here every island forwards them
//! the same way: the host tells the page which key combinations are the
//! app's ([`relay_set`], evaluated against the island's own key context, so
//! an editor-only binding such as ⌘] for Indent is never taken from a page),
//! the page's bridge claims exactly those on keydown (and never while an
//! input method composes) and posts them back, and the host dispatches them
//! through GPUI's own key dispatch after the current update.
//!
//! Combinations travel as `KeyboardEvent.code` plus modifier flags, so a
//! shifted or option-modified character (⌘⇧/ arrives as `?`) and a non-Latin
//! layout name the physical key the keymap binds.

use std::collections::BTreeSet;

use gpui::{App, KeyContext, Keystroke, Modifiers};
use serde::{Deserialize, Serialize};

/// One key combination as a page reports it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageKey {
    pub code: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub meta: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
}

impl PageKey {
    /// The combination's name in the relay set: `meta+shift+KeyK`.
    pub fn combo(&self) -> String {
        combo(self.meta, self.ctrl, self.alt, self.shift, &self.code)
    }

    /// The keystroke GPUI dispatches for it.
    pub fn keystroke(&self) -> Option<Keystroke> {
        let key = key_for_code(&self.code)?;
        let key_char =
            (self.key.chars().count() == 1 && !self.meta && !self.ctrl).then(|| self.key.clone());
        Some(Keystroke {
            modifiers: Modifiers {
                control: self.ctrl,
                alt: self.alt,
                shift: self.shift,
                platform: self.meta,
                function: false,
            },
            key: key.to_string(),
            key_char,
        })
    }
}

fn combo(meta: bool, ctrl: bool, alt: bool, shift: bool, code: &str) -> String {
    let mut name = String::new();
    for (on, part) in [
        (meta, "meta+"),
        (ctrl, "ctrl+"),
        (alt, "alt+"),
        (shift, "shift+"),
    ] {
        if on {
            name.push_str(part);
        }
    }
    name.push_str(code);
    name
}

/// Keys a page keeps whatever the keymap binds them to: text editing and
/// navigation, which belong to the field the writer is typing in.
fn page_keeps(modifiers: &Modifiers, key: &str) -> bool {
    let primary = if cfg!(target_os = "macos") {
        modifiers.platform
    } else {
        modifiers.control
    };
    let editing = matches!(
        key,
        "a" | "c"
            | "v"
            | "x"
            | "z"
            | "y"
            | "left"
            | "right"
            | "up"
            | "down"
            | "home"
            | "end"
            | "backspace"
            | "delete"
            | "enter"
            | "tab"
            | "escape"
            | "space"
    );
    // Only the app's own chords are forwarded: a key with the platform's
    // primary modifier, or a function key.
    let chord = primary || key.starts_with('f') && key.len() > 1 && key[1..].parse::<u8>().is_ok();
    editing || !chord
}

/// The app's key combinations a page focused in `contexts` (the island's
/// key context stack) hands to the host.
pub fn relay_set(contexts: &[KeyContext], cx: &App) -> BTreeSet<String> {
    let keymap = cx.key_bindings();
    let keymap = keymap.borrow();
    let mut set = BTreeSet::new();
    for binding in keymap.bindings() {
        let [keystroke] = binding.keystrokes() else {
            continue;
        };
        if binding.action().name() == "zed::NoAction" {
            continue;
        }
        if binding
            .predicate()
            .is_some_and(|predicate| !predicate.eval(contexts))
        {
            continue;
        }
        let modifiers = keystroke.modifiers();
        let key = keystroke.inner().key.as_str();
        if page_keeps(modifiers, key) {
            continue;
        }
        if let Some((code, shifted)) = code_for_key(key) {
            set.insert(combo(
                modifiers.platform,
                modifiers.control,
                modifiers.alt,
                modifiers.shift || shifted,
                code,
            ));
        }
    }
    set
}

/// The GPUI key on a physical key, as `KeyboardEvent.code` names it.
pub fn key_for_code(code: &str) -> Option<&'static str> {
    CODES
        .iter()
        .find(|(name, _)| *name == code)
        .map(|(_, key)| *key)
}

/// The physical key a GPUI key is on, and whether it needs Shift there
/// (a binding written `cmd-?` is ⌘⇧/ on a US layout).
fn code_for_key(key: &str) -> Option<(&'static str, bool)> {
    if let Some((code, _)) = CODES.iter().find(|(_, name)| *name == key) {
        return Some((code, false));
    }
    SHIFTED
        .iter()
        .find(|(shifted, _)| *shifted == key)
        .and_then(|(_, base)| CODES.iter().find(|(_, name)| name == base))
        .map(|(code, _)| (*code, true))
}

/// US-layout characters typed with Shift, and the key they are on.
const SHIFTED: &[(&str, &str)] = &[
    ("?", "/"),
    ("{", "["),
    ("}", "]"),
    ("|", "\\"),
    (":", ";"),
    ("\"", "'"),
    ("<", ","),
    (">", "."),
    ("_", "-"),
    ("+", "="),
    ("~", "`"),
    ("!", "1"),
    ("@", "2"),
    ("#", "3"),
    ("$", "4"),
    ("%", "5"),
    ("^", "6"),
    ("&", "7"),
    ("*", "8"),
    ("(", "9"),
    (")", "0"),
];

const CODES: &[(&str, &str)] = &[
    ("KeyA", "a"),
    ("KeyB", "b"),
    ("KeyC", "c"),
    ("KeyD", "d"),
    ("KeyE", "e"),
    ("KeyF", "f"),
    ("KeyG", "g"),
    ("KeyH", "h"),
    ("KeyI", "i"),
    ("KeyJ", "j"),
    ("KeyK", "k"),
    ("KeyL", "l"),
    ("KeyM", "m"),
    ("KeyN", "n"),
    ("KeyO", "o"),
    ("KeyP", "p"),
    ("KeyQ", "q"),
    ("KeyR", "r"),
    ("KeyS", "s"),
    ("KeyT", "t"),
    ("KeyU", "u"),
    ("KeyV", "v"),
    ("KeyW", "w"),
    ("KeyX", "x"),
    ("KeyY", "y"),
    ("KeyZ", "z"),
    ("Digit0", "0"),
    ("Digit1", "1"),
    ("Digit2", "2"),
    ("Digit3", "3"),
    ("Digit4", "4"),
    ("Digit5", "5"),
    ("Digit6", "6"),
    ("Digit7", "7"),
    ("Digit8", "8"),
    ("Digit9", "9"),
    ("Minus", "-"),
    ("Equal", "="),
    ("BracketLeft", "["),
    ("BracketRight", "]"),
    ("Backslash", "\\"),
    ("Semicolon", ";"),
    ("Quote", "'"),
    ("Comma", ","),
    ("Period", "."),
    ("Slash", "/"),
    ("Backquote", "`"),
    ("Enter", "enter"),
    ("NumpadEnter", "enter"),
    ("Escape", "escape"),
    ("Tab", "tab"),
    ("Space", "space"),
    ("Backspace", "backspace"),
    ("Delete", "delete"),
    ("ArrowUp", "up"),
    ("ArrowDown", "down"),
    ("ArrowLeft", "left"),
    ("ArrowRight", "right"),
    ("Home", "home"),
    ("End", "end"),
    ("PageUp", "pageup"),
    ("PageDown", "pagedown"),
    ("F1", "f1"),
    ("F2", "f2"),
    ("F3", "f3"),
    ("F4", "f4"),
    ("F5", "f5"),
    ("F6", "f6"),
    ("F7", "f7"),
    ("F8", "f8"),
    ("F9", "f9"),
    ("F10", "f10"),
    ("F11", "f11"),
    ("F12", "f12"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_keys_become_gpui_keystrokes() {
        let key = PageKey {
            code: "Slash".into(),
            key: "?".into(),
            meta: true,
            shift: true,
            ..Default::default()
        };
        let keystroke = key.keystroke().unwrap();
        assert_eq!(keystroke.key, "/");
        assert!(keystroke.modifiers.platform && keystroke.modifiers.shift);
        assert_eq!(keystroke.key_char, None);
        assert_eq!(key.combo(), "meta+shift+Slash");
        assert!(
            PageKey {
                code: "IntlRo".into(),
                ..Default::default()
            }
            .keystroke()
            .is_none()
        );
    }

    #[test]
    fn shifted_bindings_name_their_physical_key() {
        assert_eq!(code_for_key("?"), Some(("Slash", true)));
        assert_eq!(code_for_key("k"), Some(("KeyK", false)));
        assert_eq!(code_for_key("f8"), Some(("F8", false)));
    }

    #[test]
    fn editing_keys_stay_in_the_page() {
        let primary = if cfg!(target_os = "macos") {
            Modifiers {
                platform: true,
                ..Default::default()
            }
        } else {
            Modifiers {
                control: true,
                ..Default::default()
            }
        };
        assert!(page_keeps(&primary, "c"));
        assert!(page_keeps(&primary, "left"));
        assert!(!page_keeps(&primary, "b"));
        assert!(page_keeps(&Modifiers::default(), "b"));
        assert!(!page_keeps(&Modifiers::default(), "f8"));
    }
}
