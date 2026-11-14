//! How a command's keys are drawn beside it: the palette's and the
//! shortcut sheet's keycaps, the titlebar's search hint (`key-combos.ts` in
//! the Tauri app).

use gpui::{Action, SharedString};

/// The keys bound to `action`, as the palette and the shortcut sheet draw
/// them ("⌘⇧↩").
pub fn keys_label(action: &dyn Action, window: &gpui::Window) -> Option<SharedString> {
    let binding = window.highest_precedence_binding_for_action(action)?;
    let mut out = String::new();
    for keystroke in binding.keystrokes() {
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
    Some(out.into())
}

fn key_glyph(key: &str) -> String {
    match key {
        "enter" => "↩".into(),
        "escape" => "⎋".into(),
        "backspace" => "⌫".into(),
        "tab" => "⇥".into(),
        "space" => "Space".into(),
        "/" => "/".into(),
        "f8" => "F8".into(),
        other => other.to_uppercase(),
    }
}
