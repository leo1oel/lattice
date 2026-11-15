//! The LaTeX source's typing rules (`lattice_editor::latex::input_rules`), as
//! the Tauri app's editor applies them: `$` pairs or wraps the selection in
//! `$…$` (`dollarPairCommand`), Enter writes the `\end{…}` of the
//! `\begin{…}` before it and continues or leaves an `\item` list
//! (`insertLatexNewline`), and a typed or completed `\begin{…}` or `\left(`
//! gets its `\end{…}` or `\right)` (the editor's update listener).
//!
//! The keys are bound outside Vim's normal and visual modes, where `$` and
//! Enter are Vim's (the Tauri app gives `$` the lowest precedence for the
//! same reason), and outside a menu, where Enter accepts the completion.
//! Each passes on to the editor's own key when its rule has nothing to do,
//! when the keyboard is in another editor on the panel, or with several
//! carets: the rules act on the main selection, so the editor types at
//! every caret instead.

use editor::{Editor, EditorEvent};
use gpui::{Context, Entity, Focusable as _, Subscription, Window, actions};
use lattice_editor::latex::{input_rules, region_edits};

use super::{EditorPanel, latex_format::Outcome};

actions!(lattice, [TypeDollar, LatexNewline]);

impl EditorPanel {
    /// The keys' handlers, on the panel's element.
    pub(super) fn latex_input_actions(element: gpui::Div, cx: &mut Context<Self>) -> gpui::Div {
        use gpui::InteractiveElement as _;
        element
            .on_action(cx.listener(|this, _: &TypeDollar, window, cx| {
                this.typing_rule(
                    |text, from, to, head| {
                        Outcome::Edit(if from == to {
                            input_rules::dollar_pair(text, head).into_format()
                        } else {
                            region_edits::wrap_range(text, from, to, "$", "$", "").into_format()
                        })
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &LatexNewline, window, cx| {
                this.typing_rule(
                    |text, from, to, _| {
                        input_rules::latex_newline(text, from, to)
                            .map_or(Outcome::Pass, |edit| Outcome::Edit(edit.into_format()))
                    },
                    window,
                    cx,
                )
            }))
    }

    fn typing_rule(
        &mut self,
        rule: impl FnOnce(&str, usize, usize, usize) -> Outcome,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let editor = self.editor().read(cx);
        if !editor.focus_handle(cx).is_focused(window) || editor.selections.count() > 1 {
            cx.propagate();
            return;
        }
        self.run_latex_command(rule, window, cx);
    }

    /// After the editor takes typed or completed text: the `\begin{…}` or
    /// `\left(` it finished, closed.
    pub(super) fn latex_input_rules(
        editor: &Entity<Editor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Subscription {
        cx.subscribe_in(editor, window, |this, editor, event, window, cx| {
            if !matches!(event, EditorEvent::InputHandled { text, .. } if !text.is_empty())
                || editor.read(cx).selections.count() > 1
                || !lattice_editor::latex::is_tex_source(std::path::Path::new(this.relative()))
            {
                return;
            }
            this.run_latex_command(
                |text, from, to, head| match input_rules::after_input(text, head) {
                    Some(edit) if from == to => Outcome::Edit(edit.into_format()),
                    _ => Outcome::Nothing,
                },
                window,
                cx,
            );
        })
    }
}
