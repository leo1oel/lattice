//! The e2e checks of the LaTeX source's typing rules
//! (`editor_panel/latex_input.rs`, `lattice_editor::latex::input_rules`),
//! typed with native keys at a fresh line after the chapter, as the Tauri
//! app's editor applies them: `\begin{itemize}` typed is closed by its
//! `\end{itemize}` with the caret on its first `\item`, Enter on an item
//! starts the next and on an empty one leaves the list, `$` pairs, and
//! `\left(` grows its `\right)`. Ctrl-M inside that math lands on its
//! opening `$`. The chapter is put back after.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, Keystroke};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

/// The caret, in the text after it lands: `|`.
fn with_caret(text: &str, caret: usize) -> String {
    format!("{}|{}", &text[..caret], &text[caret..])
}

impl Run {
    pub(super) async fn latex_typing(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let editor = self.open(cx, &chapter, Some(2))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let original = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
        let start = original.len() + 1;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                let end = original.len();
                editor.replace_range(end, end, "\n", end + 1, window, cx)
            })
        })?;
        self.select(cx, &editor, start, start)?;
        let tail = |cx: &mut AsyncApp, editor: &Entity<EditorPanel>| {
            cx.update(|cx| {
                let (text, caret) = editor.read(cx).text_and_caret(cx);
                with_caret(&text, caret)
                    .get(start..)
                    .unwrap_or_default()
                    .to_string()
            })
        };

        self.type_text(cx, "\\begin{itemize}").await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let closed = tail(cx, &editor);
        // A completion menu the typing opened would take Enter.
        self.press(cx, '\u{1b}', false).await?;
        self.type_text(cx, "one").await?;
        self.press(cx, '\u{1b}', false).await?;
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let next = tail(cx, &editor);
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let left = tail(cx, &editor);
        steps.check(
            "typing \\begin{itemize} in a LaTeX file writes its \\end{itemize} with the caret on its first \\item, Enter on an item starts the next, and Enter on the empty one leaves the list",
            closed == "\\begin{itemize}\n  \\item |\n\\end{itemize}"
                && next == "\\begin{itemize}\n  \\item one\n  \\item |\n\\end{itemize}"
                && left == "\\begin{itemize}\n  \\item one\n\\end{itemize}\n|",
            json!({ "closed": closed, "next": next, "left": left }),
        );

        self.type_text(cx, "$").await?;
        self.pause(cx, Duration::from_millis(100)).await;
        let paired = tail(cx, &editor);
        self.type_text(cx, "\\left(").await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let sized = tail(cx, &editor);
        let list = "\\begin{itemize}\n  \\item one\n\\end{itemize}\n";
        steps.check(
            "in a LaTeX file $ writes a pair with the caret between, and \\left( grows its \\right) after the caret",
            paired == format!("{list}$|$") && sized == format!("{list}$\\left(|\\right)$"),
            json!({ "paired": paired, "sized": sized }),
        );

        // Ctrl-M outside any environment: the math's opening `$`.
        self.press(cx, '\u{1b}', false).await?;
        let ctrl_m = Keystroke::parse("ctrl-m").map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(ctrl_m, cx)
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        let (text, selected) = self.text_and_selection(cx, &editor);
        let dollar = text.rfind("$\\left").context("the typed math")?;
        let at = cx.update(|cx| editor.read(cx).text_and_caret(cx).1);
        steps.check(
            "Ctrl-M inside inline math where no environment holds the caret selects its opening $",
            selected == "$" && at == dollar + 1,
            json!({ "selected": selected, "caret": at, "opening": dollar }),
        );

        // The chapter as it was, for the modules after.
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                let len = editor.text_and_caret(cx).0.len();
                editor.replace_range(0, len, &original, 0, window, cx)
            })
        })?;

        // With Vim on, `f$` in Normal mode is Vim's find motion, its `$`
        // waiting for a character (`vim_mode = waiting`), never the typing
        // rule's pair: `x` then deletes the `$` it found, and nothing else
        // in the file changes.
        cx.update(|cx| crate::app::set_vim_mode(true, cx));
        let scratch = root.join("vim-dollar.tex");
        std::fs::write(&scratch, "a $x$ b\n")?;
        let vim_editor = self.open(cx, &scratch, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.type_text(cx, "f$").await?;
        self.pause(cx, Duration::from_millis(100)).await;
        self.type_text(cx, "x").await?;
        self.pause(cx, Duration::from_millis(100)).await;
        let vim_text = self.editor_text(cx, &vim_editor);
        steps.check(
            "with Vim on, f$ in a LaTeX file finds the next $ (x then deletes it) rather than writing a $ pair",
            vim_text == "a x$ b\n",
            json!({ "text": vim_text }),
        );
        cx.update(|cx| crate::app::set_vim_mode(false, cx));
        self.wait_for(cx, Duration::from_secs(6), |_, cx| {
            !vim_editor.read(cx).is_dirty(cx)
        })
        .await;
        std::fs::remove_file(&scratch).ok();
        Ok(())
    }
}

/// This file's registration as the e2e module `latex_typing` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 113,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-editor/src/latex/input_rules.rs",
        "gpui/crates/lattice-editor/src/latex/syntax.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/latex_input.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/latex_format.rs",
        "gpui/crates/lattice-gpui/src/shell/commands/keymap.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.latex_typing(cx, steps, &fixture.root)),
};
