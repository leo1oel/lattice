//! Escape leaves focus mode (`use-focus-mode-escape.ts`), but only as the
//! key's last meaning: not when a surface used it (the editor collapsing a
//! selection or closing its completions, which stop the key there; Zed's
//! editor passes Escape on only when it had nothing to cancel), not while
//! the keyboard is in anything Escape closes (the palette, a menu, a dialog,
//! the find bar), never with a modifier held, and never in Vim, where Escape
//! is the writer's own. The keyboard is in a document then: its editor, or
//! the PDF beside it.

use gpui::{InteractiveElement as _, KeyContext, KeyDownEvent, Modifiers};

use super::{Shell, parts::Part};

/// Whether an Escape that reached the window leaves focus mode: `contexts`
/// is the key context stack the keyboard was in.
fn leaves_focus_mode(key: &str, modifiers: &Modifiers, contexts: &[KeyContext], vim: bool) -> bool {
    if key != "escape" || modifiers.modified() || vim {
        return false;
    }
    let has = |name: &str| contexts.iter().any(|context| context.contains(name));
    // The document's own surfaces, and none that Escape closes inside it.
    (has("LatticeEditor") || has("PdfView")) && !has("LatticeFindBar") && !has("menu")
}

impl Shell {
    /// Whether focus mode is on, for scenarios.
    pub(crate) fn in_focus_mode(&self) -> bool {
        self.layout.focus.is_some()
    }
}

/// The part's state: it keeps none of its own.
struct FocusEscape;

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(FocusEscape),
    views: &[],
    actions: |element, cx| {
        element.on_key_down(
            cx.listener(|this: &mut Shell, event: &KeyDownEvent, window, cx| {
                if this.layout.focus.is_none()
                    || !leaves_focus_mode(
                        &event.keystroke.key,
                        &event.keystroke.modifiers,
                        &window.context_stack(),
                        crate::app::vim_mode_enabled(cx),
                    )
                {
                    return;
                }
                cx.stop_propagation();
                this.set_focus_mode(false, window, cx);
            }),
        )
    },
    commands: super::parts::no_commands,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn stack(contexts: &[&str]) -> Vec<KeyContext> {
        contexts
            .iter()
            .map(|context| KeyContext::parse(context).unwrap())
            .collect()
    }

    #[test]
    fn escape_leaves_focus_mode_only_as_its_last_meaning() {
        let editor = stack(&["LatticeShell", "LatticeEditor", "Editor mode=full"]);
        let none = Modifiers::none();
        assert!(leaves_focus_mode("escape", &none, &editor, false));
        assert!(leaves_focus_mode(
            "escape",
            &none,
            &stack(&["LatticeShell", "PdfView"]),
            false
        ));
        // Vim's own Escape, a modifier, another key.
        assert!(!leaves_focus_mode("escape", &none, &editor, true));
        assert!(!leaves_focus_mode(
            "escape",
            &Modifiers::shift(),
            &editor,
            false
        ));
        assert!(!leaves_focus_mode("enter", &none, &editor, false));
        // The find bar and the editor's menus close on it first; the palette
        // and the sheets hold the keyboard outside any document.
        assert!(!leaves_focus_mode(
            "escape",
            &none,
            &stack(&["LatticeShell", "LatticeEditor", "LatticeFindBar"]),
            false
        ));
        assert!(!leaves_focus_mode(
            "escape",
            &none,
            &stack(&[
                "LatticeShell",
                "LatticeEditor",
                "Editor menu showing_completions"
            ]),
            false
        ));
        assert!(!leaves_focus_mode(
            "escape",
            &none,
            &stack(&["LatticeShell"]),
            false
        ));
    }
}
