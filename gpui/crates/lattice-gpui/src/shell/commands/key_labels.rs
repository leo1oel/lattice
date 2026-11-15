//! How a command's keys are drawn beside it: the palette's and the
//! shortcut sheet's keycaps, the titlebar's search hint (`key-combos.ts` in
//! the Tauri app).

use gpui::{Action, KeybindingKeystroke, Keystroke, OperatingSystem, SharedString};

/// The keys bound to `action`, as the palette and the shortcut sheet draw
/// them ("⌘⇧↩").
pub fn keys_label(action: &dyn Action, window: &gpui::Window) -> Option<SharedString> {
    let binding = window.highest_precedence_binding_for_action(action)?;
    Some(keystrokes_label(binding.keystrokes()).into())
}

/// A binding's keystrokes as keycaps draw them: each one's modifiers in the
/// Mac's order, then its key; a chord's keystrokes apart ("⌘K ⌘0").
pub fn keystrokes_label(keystrokes: &[KeybindingKeystroke]) -> String {
    let mut out = String::new();
    for (ix, keystroke) in keystrokes.iter().enumerate() {
        if ix > 0 {
            out.push(' ');
        }
        let modifiers = keystroke.modifiers();
        #[cfg(target_os = "macos")]
        {
            if modifiers.control {
                out.push('⌃');
            }
            if modifiers.alt {
                out.push('⌥');
            }
            if modifiers.shift {
                out.push('⇧');
            }
            if modifiers.platform {
                out.push('⌘');
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            if modifiers.control {
                out.push_str("Ctrl+");
            }
            if modifiers.alt {
                out.push_str("Alt+");
            }
            if modifiers.shift {
                out.push_str("Shift+");
            }
        }
        out.push_str(&key_glyph(keystroke.key()));
    }
    out
}

/// A key name of the Tauri app's tables (`Mod-Shift-ArrowUp`, CodeMirror's
/// and ProseMirror's spelling) as the keystroke GPUI would bind: `Mod` is ⌘
/// on macOS and Ctrl elsewhere.
pub fn tauri_keystroke(name: &str) -> Option<KeybindingKeystroke> {
    let parts: Vec<&str> = name.split('-').collect();
    let (key, modifiers) = match parts.split_last()? {
        // "Mod--" would end in an empty part; no table names one.
        (&"", _) => return None,
        (key, modifiers) => (*key, modifiers),
    };
    let mut out: Vec<String> = Vec::new();
    for modifier in modifiers {
        out.push(
            match *modifier {
                "Mod" if cfg!(target_os = "macos") => "cmd",
                "Mod" | "Ctrl" => "ctrl",
                "Shift" => "shift",
                "Alt" => "alt",
                "Meta" | "Cmd" => "cmd",
                _ => return None,
            }
            .to_string(),
        );
    }
    out.push(match key {
        "ArrowUp" => "up".into(),
        "ArrowDown" => "down".into(),
        "ArrowLeft" => "left".into(),
        "ArrowRight" => "right".into(),
        "Enter" => "enter".into(),
        "Escape" => "escape".into(),
        "Backspace" => "backspace".into(),
        "Tab" => "tab".into(),
        other => other.to_lowercase(),
    });
    let source = out.join("-");
    let os = if cfg!(target_os = "macos") {
        OperatingSystem::Mac
    } else if cfg!(target_os = "windows") {
        OperatingSystem::Windows
    } else {
        OperatingSystem::Linux
    };
    let keystroke = Keystroke::parse_with_os(&source, os).ok();
    keystroke.map(KeybindingKeystroke::from_keystroke)
}

fn key_glyph(key: &str) -> String {
    match key {
        "enter" => "↩".into(),
        "escape" => "⎋".into(),
        "backspace" => "⌫".into(),
        "delete" => "⌦".into(),
        "tab" => "⇥".into(),
        "space" => "Space".into(),
        "up" => "↑".into(),
        "down" => "↓".into(),
        "left" => "←".into(),
        "right" => "→".into(),
        "pageup" => "PgUp".into(),
        "pagedown" => "PgDn".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        other => other.to_uppercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(name: &str) -> String {
        keystrokes_label(&[tauri_keystroke(name).expect(name)])
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn tauri_key_names_read_as_mac_keycaps() {
        // engine-shortcuts.ts's and latex-shortcuts.ts's names, as the
        // Tauri sheet draws them (key-combos.ts: ⌃⌥⇧⌘ then the key).
        assert_eq!(label("Mod-Shift-ArrowUp"), "⇧⌘↑");
        assert_eq!(label("Mod-Alt-1"), "⌥⌘1");
        assert_eq!(label("Mod-Enter"), "⌘↩");
        assert_eq!(label("Mod-k"), "⌘K");
        assert_eq!(label("Escape"), "⎋");
        assert_eq!(label("Shift-F12"), "⇧F12");
        assert!(tauri_keystroke("Hyper-x").is_none());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_chord_reads_as_its_keystrokes_apart() {
        let parse = |keys| KeybindingKeystroke::from_keystroke(Keystroke::parse(keys).unwrap());
        let chord = [parse("cmd-k"), parse("cmd-0")];
        assert_eq!(keystrokes_label(&chord), "⌘K ⌘0");
        assert_eq!(keystrokes_label(&[parse("cmd-alt-left")]), "⌥⌘←");
    }
}
