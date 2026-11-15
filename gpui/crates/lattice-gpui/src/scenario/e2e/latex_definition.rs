#![cfg(target_os = "macos")]
//! The e2e checks of go to definition and the right-click menu in a LaTeX
//! source (`editor_panel/definition.rs`, `editor_panel/source_pointer.rs`),
//! on `main.tex`: F12 on `\ref{sec:method}` lands on its `\label`'s line, a
//! native ⌘-click on `\cite{knuth1984}` opens the bibliography at its entry,
//! F12 on `\input{chapters/intro}` opens the chapter, and a native
//! right-click on a word puts the caret there and opens the editing menu,
//! which takes the keyboard until Escape gives it back to the text.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, Focusable as _, Keystroke, point, px};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, native, scenario::Run};

impl Run {
    pub(super) async fn latex_definition(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let main = root.join("main.tex");
        let panel = self.open(cx, &main, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let native = self.native(cx)?;
        let active = |cx: &mut AsyncApp, run: &Run| {
            cx.update(|cx| {
                run.shell.read(cx).active_editor().map(|editor| {
                    (
                        editor.read(cx).relative().to_string(),
                        editor.read(cx).cursor().0,
                    )
                })
            })
        };

        // F12 on the \ref's label: the \label's line in the same file.
        let text = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);
        let at = text.find("\\ref{sec:method}").context("the \\ref")? + "\\ref{sec".len();
        self.select(cx, &panel, at, at)?;
        self.f12(cx).await?;
        let label_line = text[..text.find("\\label{sec:method}").context("the \\label")?]
            .matches('\n')
            .count() as u32
            + 1;
        let landed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                panel.read(cx).cursor().0 == label_line
            })
            .await;
        steps.check(
            "F12 on a \\ref's label in a LaTeX file goes to the line of its \\label",
            landed,
            json!({ "wanted": label_line, "at": active(cx, self) }),
        );

        // A native ⌘-click on the citation key: its bibliography entry.
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        let (_, rect) = self
            .text_point(cx, &panel, &lattice, "knuth1984}", 2)
            .await?;
        native::send_command_click(native, point(rect.left() + px(3.), rect.center().y))?;
        let entry = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell
                    .read(cx)
                    .active_editor()
                    .is_some_and(|editor| editor.read(cx).relative() == "references.bib")
            })
            .await;
        let opened = active(cx, self);
        steps.check(
            "a ⌘-click on a citation key in a LaTeX file opens the bibliography at its entry",
            entry && opened.as_ref().is_some_and(|(_, line)| *line == 1),
            json!({ "opened": opened }),
        );

        // F12 on the \input's path: the chapter it reads.
        let panel = self.open(cx, &main, Some(6))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let text = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);
        let at = text.find("chapters/intro").context("the \\input")? + 3;
        self.select(cx, &panel, at, at)?;
        self.f12(cx).await?;
        let chapter = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell
                    .read(cx)
                    .active_editor()
                    .is_some_and(|editor| editor.read(cx).relative() == "chapters/intro.tex")
            })
            .await;
        steps.check(
            "F12 on an \\input's path in a LaTeX file opens the file it reads",
            chapter,
            json!({ "opened": active(cx, self) }),
        );

        self.source_menu(cx, steps, &main).await
    }

    /// A native right-click on a word: the caret there, the menu open with
    /// the keyboard, and Escape back to the text.
    async fn source_menu(&self, cx: &mut AsyncApp, steps: &mut Steps, main: &Path) -> Result<()> {
        let panel = self.open(cx, main, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        let (offset, rect) = self
            .text_point(cx, &panel, &lattice, "Some text", 1)
            .await?;
        let native = self.native(cx)?;
        let at = point(rect.left() + px(3.), rect.center().y);
        native::send_mouse(native, native::Mouse::Moved, at)?;
        native::send_right_click(native, at)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (caret, in_text, focused) = self.text_focus(cx, &panel)?;
        let menu_has_keys = !in_text && focused;
        native::send_key(native, '\u{1b}', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (_, back, _) = self.text_focus(cx, &panel)?;
        steps.check(
            "a right-click on a word in the source puts the caret there and opens the editing menu with the keyboard, and Escape gives the keyboard back to the text",
            caret == offset && menu_has_keys && back,
            json!({ "caret": caret, "pointer_offset": offset, "menu_has_keys": menu_has_keys, "text_focused_after_escape": back }),
        );
        Ok(())
    }

    /// The caret, whether the keyboard is in the text, and whether the
    /// window's keyboard is anywhere (a menu holding it reads as the text
    /// not focused while the window has a focus).
    fn text_focus(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
    ) -> Result<(usize, bool, bool)> {
        self.with_window(cx, |_, window, cx| {
            let panel = panel.read(cx);
            let caret = panel.text_and_caret(cx).1;
            let text = panel.editor().focus_handle(cx).is_focused(window);
            (caret, text, window.focused(cx).is_some())
        })
    }

    async fn f12(&self, cx: &mut AsyncApp) -> Result<()> {
        let f12 = Keystroke::parse("f12").map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| window.dispatch_keystroke(f12, cx))?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }
}

/// This file's registration as the e2e module `latex_definition` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 114,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-editor/src/latex/definition.rs",
        "gpui/crates/lattice-editor/src/adapter/pointer.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/definition.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/source_pointer.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.latex_definition(cx, steps, &fixture.root)),
};
