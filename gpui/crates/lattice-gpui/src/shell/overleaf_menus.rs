//! Margin review in the palette (`use-command-table.ts`'s
//! `margin-review-here`): "Review here" opens the comment or suggestion by
//! the caret, the one on or after its line, else the first
//! (`requestMarginReviewHere`). View ▸ Margin Review lives in `menus.rs`.

use gpui::{Context, InteractiveElement as _, Window, actions};
use lattice_i18n::t;

use super::{
    Shell,
    commands::{Command, Section},
    parts::Part,
};
use crate::editor_panel::MarginMode;

actions!(lattice, [ReviewHere]);

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(()),
    views: &[],
    actions: |element, cx| {
        element.on_action(
            cx.listener(|this, _: &ReviewHere, window, cx| this.margin_review_here(window, cx)),
        )
    },
    commands: |context, out| {
        if context.in_project && context.overleaf_linked {
            out.push(Command::new(
                "margin-review-here",
                t!("Review here"),
                Section::Overleaf,
                ReviewHere,
            ));
        }
    },
};

impl Shell {
    /// "Review here".
    fn margin_review_here(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.active_editor() else {
            return;
        };
        if self.margin_mode == MarginMode::Off {
            return;
        }
        let opened = editor.update(cx, |editor, cx| editor.margin_review_here(cx));
        if opened {
            let focus = gpui::Focusable::focus_handle(editor.read(cx), cx);
            window.focus(&focus, cx);
        }
    }
}
