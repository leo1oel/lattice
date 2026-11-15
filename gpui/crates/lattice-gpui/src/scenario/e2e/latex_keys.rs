//! The e2e checks of the LaTeX source's own keys (`editor_panel/latex_format.rs`,
//! `lattice_editor::latex::edits`): ⌘B (Ctrl+B) on a selected word wraps it
//! in `\textbf{…}` and leaves the word selected, the same key takes it off
//! again, and ⌘I does the same with `\emph{…}`, as the Tauri app's
//! `latexCommandKeymap` does. The chapter is put back after.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use editor::{MultiBufferOffset, SelectionEffects, ToOffset as _};
use gpui::{AsyncApp, Entity, Focusable as _, Keystroke};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

impl Run {
    pub(super) async fn latex_keys(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let editor = self.open(cx, &chapter, Some(2))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let original = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
        let word = "paragraph";
        let at = original.find(word).context("the chapter's first line")?;
        for (key, command) in [('b', "textbf"), ('i', "emph")] {
            if key == 'b' {
                // A build an earlier module started (the palette's last
                // check types into main.tex, and the pause in typing
                // builds) must end first, or it reads as one ⌘B started.
                self.wait_for(cx, Duration::from_secs(60), |shell, cx| {
                    !shell.read(cx).building()
                })
                .await;
            }
            self.select(cx, &editor, at, at + word.len())?;
            let builds = self.builds(cx);
            let was_building = cx.update(|cx| self.shell.read(cx).building());
            self.press(cx, key, true).await?;
            self.pause(cx, Duration::from_millis(150)).await;
            let (on, on_selected) = self.text_and_selection(cx, &editor);
            if key == 'b' {
                // ⌘B is Bold, never Build: Build has no key of its own and
                // shows ⌘S (`use-command-table.ts`).
                let (building, after) = cx.update(|cx| {
                    (
                        self.shell.read(cx).building(),
                        self.shell.read(cx).build_panel().read(cx).builds(),
                    )
                });
                steps.check(
                    "⌘B / Ctrl+B in a LaTeX file starts no build",
                    (was_building || !building) && after == builds,
                    json!({ "was_building": was_building, "building": building, "builds_before": builds, "builds_after": after }),
                );
            }
            self.press(cx, key, true).await?;
            self.pause(cx, Duration::from_millis(150)).await;
            let (off, off_selected) = self.text_and_selection(cx, &editor);
            let wrapped = format!("This \\{command}{{{word}}} introduces");
            steps.check(
                &format!(
                    "⌘{} / Ctrl+{} on a selected word in a LaTeX file wraps it in \\{command}, and again takes it off, the word selected both times",
                    key.to_ascii_uppercase(),
                    key.to_ascii_uppercase()
                ),
                on.contains(&wrapped)
                    && on_selected == word
                    && off == original
                    && off_selected == word,
                json!({ "on": on.lines().nth(1), "on_selected": on_selected, "off_restored": off == original, "off_selected": off_selected }),
            );
        }
        // ⌘⇧K and ⌘⇧L are reserved for Insert citation and Insert reference:
        // never Zed's delete line and select all matches. "line" is in the
        // chapter twice, so select all matches would add a second cursor.
        let repeated = "line";
        let line_at = original
            .find(repeated)
            .context("the chapter's second line")?;
        for (mac, other, zed) in [
            ("cmd-shift-k", "ctrl-shift-k", "delete line"),
            ("cmd-shift-l", "ctrl-shift-l", "select all matches"),
        ] {
            self.select(cx, &editor, line_at, line_at + repeated.len())?;
            let chord: &'static str = if cfg!(target_os = "macos") {
                mac
            } else {
                other
            };
            let keystroke = Keystroke::parse(chord).map_err(|error| anyhow::anyhow!("{error}"))?;
            self.with_window(cx, move |_, window, cx| {
                window.dispatch_keystroke(keystroke, cx)
            })?;
            self.pause(cx, Duration::from_millis(200)).await;
            let (text, selected) = self.text_and_selection(cx, &editor);
            let cursors = cx.update(|cx| editor.read(cx).editor().read(cx).selections.count());
            let picker = cx.update(|cx| self.shell.read(cx).quick_open().is_some());
            steps.check(
                &format!("{chord} in a LaTeX file opens its insert picker, not Zed's {zed}: the text and the one selection stay"),
                picker && text == original && selected == repeated && cursors == 1,
                json!({ "picker": picker, "unchanged": text == original, "selected": selected, "cursors": cursors }),
            );
            // ⎋ closes the picker, as it closes quick open.
            let escape = Keystroke::parse("escape").map_err(|error| anyhow::anyhow!("{error}"))?;
            self.with_window(cx, move |_, window, cx| window.dispatch_keystroke(escape, cx))?;
            self.pause(cx, Duration::from_millis(200)).await;
        }
        // The chapter as it was, for the modules after.
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                let len = editor.text_and_caret(cx).0.len();
                editor.replace_range(0, len, &original, 0, window, cx)
            })
        })?;
        Ok(())
    }

    /// Select `from..to` in the editor, which takes the keyboard.
    fn select(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<EditorPanel>,
        from: usize,
        to: usize,
    ) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            let text = editor.read(cx).editor().clone();
            text.update(cx, |text, cx| {
                text.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([MultiBufferOffset(from)..MultiBufferOffset(to)])
                })
            });
            window.focus(&text.focus_handle(cx), cx);
        })
    }

    /// The buffer's text and its main selection's text.
    fn text_and_selection(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<EditorPanel>,
    ) -> (String, String) {
        cx.update(|cx| {
            let text = editor.read(cx).editor().read(cx);
            let snapshot = text.buffer().read(cx).snapshot(cx);
            let selection = text.selections.newest_anchor();
            let (from, to) = (
                selection.start.to_offset(&snapshot).0,
                selection.end.to_offset(&snapshot).0,
            );
            let all = snapshot.text();
            let selected = all.get(from..to).unwrap_or_default().to_string();
            (all, selected)
        })
    }
}

/// This file's registration as the e2e module `latex_keys` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 112,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-editor/src/latex/edits.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/latex_format.rs",
        "gpui/crates/lattice-gpui/src/shell/commands/keymap.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.latex_keys(cx, steps, &fixture.root)),
};
