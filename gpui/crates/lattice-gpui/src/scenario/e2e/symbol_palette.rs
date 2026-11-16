#![cfg(target_os = "macos")]
//! The e2e checks of the math symbol palette (`editor_panel/symbol_palette.rs`),
//! as `symbol-palette.test.ts` checks the Tauri app's, in `main.tex` with
//! native keys: ⌥⌘M in the source opens it with the keyboard in its search
//! and every maths command listed, KaTeX drawing every cell (how long that
//! takes is in the detail); ↓ seven times scrolls the grid to keep the
//! highlighted cell, on the eighth row, in view; `leq` and Enter write
//! `\leq` as it is in maths;
//! outside maths `frac`, → ← and Enter write `$\frac{}{}$` with the caret
//! in its first braces; a search that matches nothing says so, and Escape
//! closes the palette with the keyboard back in the text. The buffer is put
//! back after.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, Focusable as _, Keystroke};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

/// The longest the grid's KaTeX pictures may take to come in on first open.
const DRAW_WAIT: Duration = Duration::from_secs(20);

impl Run {
    fn palette_state(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
    ) -> Option<(Vec<&'static str>, usize, usize)> {
        cx.update(|cx| panel.read(cx).symbol_palette_shown())
    }

    /// ⌥⌘M with the caret at `at`, through the window's keymap as a key
    /// press goes.
    async fn open_palette(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        at: usize,
    ) -> Result<()> {
        self.select(cx, panel, at, at)?;
        let keys = Keystroke::parse("cmd-alt-m").map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| window.dispatch_keystroke(keys, cx))?;
        let wait = panel.clone();
        self.wait_for(cx, Duration::from_secs(3), move |_, cx| {
            wait.read(cx).symbol_palette_open()
        })
        .await;
        self.pause(cx, Duration::from_millis(150)).await;
        Ok(())
    }

    pub(super) async fn symbol_palette(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let main = root.join("main.tex");
        let panel = self.open(cx, &main, Some(8))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let original = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);
        let in_math = original.find("+ 1 = 0$").context("main.tex's equation")?;

        // Open: every maths command, drawn by KaTeX.
        let started = Instant::now();
        self.open_palette(cx, &panel, in_math).await?;
        let wait = panel.clone();
        let all_drawn = self
            .wait_for(cx, DRAW_WAIT, move |_, cx| {
                wait.read(cx)
                    .symbol_palette_shown()
                    .is_some_and(|(shown, _, drawn)| !shown.is_empty() && drawn == shown.len())
            })
            .await;
        let took = started.elapsed();
        let state = self.palette_state(cx, &panel);
        self.adapter_shot(cx, "symbol-palette").await;
        let editor_focused = |run: &Self, cx: &mut AsyncApp| -> Result<bool> {
            let panel = panel.clone();
            run.with_window(cx, move |_, window, cx| {
                panel.read(cx).editor().focus_handle(cx).is_focused(window)
            })
        };
        let search_focused = !editor_focused(self, cx)?;
        steps.check(
            "⌥⌘M in a LaTeX source opens the math symbol palette with the keyboard in its search, every maths command listed and drawn by KaTeX",
            all_drawn
                && search_focused
                && state.as_ref().is_some_and(|(shown, _, _)| {
                    shown.len() == lattice_editor::latex::symbol_palette::symbols().len()
                        && shown.contains(&"\\frac")
                }),
            json!({
                "listed": state.as_ref().map(|(shown, _, _)| shown.len()),
                "drawn": state.as_ref().map(|(_, _, drawn)| *drawn),
                "ms_to_draw_all": took.as_millis(),
                "search_focused": search_focused,
            }),
        );

        // ↓ seven times: the highlight on the eighth row, scrolled into view.
        for _ in 0..7 {
            self.press(cx, crate::native::DOWN_ARROW, false).await?;
            self.pause(cx, Duration::from_millis(60)).await;
        }
        self.pause(cx, Duration::from_millis(150)).await;
        let active = self.palette_state(cx, &panel).map(|(_, active, _)| active);
        let in_view = cx.update(|cx| panel.read(cx).symbol_palette_highlight_in_view());
        steps.check(
            "↓ seven times moves the highlight down seven rows of eight and scrolls the grid to keep it in view",
            active == Some(7 * 8) && in_view == Some(true),
            json!({ "active": active, "in_view": in_view }),
        );

        // `leq`, Enter: `\leq` as it is, in the equation.
        self.type_text(cx, "leq").await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let shown = self.palette_state(cx, &panel);
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let (text, caret) = cx.update(|cx| panel.read(cx).text_and_caret(cx));
        let open_after = cx.update(|cx| panel.read(cx).symbol_palette_open());
        steps.check(
            "in maths, a search for leq and Enter write \\leq at the caret as it is, and the palette closes",
            shown
                .as_ref()
                .is_some_and(|(shown, _, _)| shown.first() == Some(&"\\leq"))
                && text.contains("e^{i\\pi} \\leq+ 1 = 0$")
                && !open_after
                && editor_focused(self, cx)?,
            json!({ "shown": shown.map(|(shown, _, _)| shown), "line": text.lines().nth(7), "caret": caret }),
        );

        // Outside maths: `frac`, → ←, Enter: `$\frac{}{}$`, caret in `{}`.
        let end = text.find("\\maketitle").context("the title")? + "\\maketitle".len();
        self.open_palette(cx, &panel, end).await?;
        self.type_text(cx, "frac").await?;
        self.press(cx, crate::native::RIGHT_ARROW, false).await?;
        self.pause(cx, Duration::from_millis(100)).await;
        let moved = self.palette_state(cx, &panel).map(|(_, active, _)| active);
        self.press(cx, crate::native::LEFT_ARROW, false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let active = self.palette_state(cx, &panel).map(|(_, active, _)| active);
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let (text, caret) = cx.update(|cx| panel.read(cx).text_and_caret(cx));
        let wanted = "\\maketitle$\\frac{}{}$";
        let at = text.find(wanted);
        steps.check(
            "outside maths, frac, → ←, and Enter write $\\frac{}{}$ with the caret in its first braces",
            moved == Some(1)
                && active == Some(0)
                && at.is_some_and(|at| caret == at + "\\maketitle$\\frac{".len()),
            json!({ "moved": moved, "active": active, "line": text.lines().nth(4), "caret": caret, "at": at }),
        );

        // Nothing matches: it says so; Escape closes it.
        self.open_palette(cx, &panel, 0).await?;
        self.type_text(cx, "zzqq").await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let empty = self
            .palette_state(cx, &panel)
            .is_some_and(|(shown, _, _)| shown.is_empty());
        self.press(cx, '\u{1b}', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let closed = !cx.update(|cx| panel.read(cx).symbol_palette_open());
        steps.check(
            "a search that matches nothing lists nothing, and Escape closes the palette with the keyboard back in the text",
            empty && closed && editor_focused(self, cx)?,
            json!({ "empty": empty, "closed": closed }),
        );

        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    let len = panel.text_and_caret(cx).0.len();
                    panel.replace_range(0, len, &original, 0, window, cx)
                })
            }
        })?;
        Ok(())
    }
}

/// This file's registration as the e2e module `symbol_palette` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 119,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_panel/symbol_palette.rs",
        "gpui/crates/lattice-editor/src/latex/symbol_palette.rs",
        "gpui/crates/lattice-editor/src/latex/previews.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.symbol_palette(cx, steps, &fixture.root)),
};
