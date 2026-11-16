//! ⌥⌘K opens the citation card for the key at the caret, as the Tauri app's
//! `citationCardAtCursor` (`latex-hover-cards.ts`) does: the card the
//! pointer opens on hover, with its first action focused so the keyboard
//! reaches what the pointer does. Tab walks the actions, Return presses the
//! focused one, and Escape gives the caret back; an edit, a caret move or
//! focus leaving the card closes it (`LatticeEditor::open_card_at`).
//! Anywhere else, and outside a LaTeX file, the key goes on.

use std::path::Path;

use gpui::{Context, actions};

use super::EditorPanel;

actions!(
    lattice,
    [
        /// Show the citation card for the key at the caret (⌥⌘K).
        ShowCitationCard,
    ]
);

impl EditorPanel {
    /// ⌥⌘K's handler, on the panel's element.
    pub(super) fn citation_card_actions(element: gpui::Div, cx: &mut Context<Self>) -> gpui::Div {
        use gpui::InteractiveElement as _;
        element.on_action(cx.listener(|this, _: &ShowCitationCard, window, cx| {
            let opened = lattice_editor::latex::is_tex_source(Path::new(this.relative())) && {
                let (_, head) = this.latex_selection(cx);
                this.lattice_editor().update(cx, |editor, cx| {
                    editor.open_card_at(head, "citation", window, cx)
                })
            };
            if !opened {
                cx.propagate();
            }
        }))
    }
}
