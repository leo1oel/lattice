#![cfg(target_os = "macos")]
//! The e2e checks of the source editor's keys and commands where Zed's
//! differ from the Tauri app's: ⌃L selects the caret's line, a native
//! ⌘-click on plain text adds a cursor, ⌃⌥[ and ⌃⌥] fold and unfold the
//! LaTeX fold column's ranges, Format document runs latexindent on
//! a scratch file (skipped without latexindent), and with the Vim keymap on,
//! `:` opens Lattice's command line, where `:w` saves the file to disk, `:3`
//! goes to line 3 and `:q` closes the tab (`editor_panel/vim_ex.rs`). The
//! keymap and the files are put back after.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Keystroke, point, px};
use lattice_settings::EditorKeymap;
use serde_json::json;

use super::Steps;
use crate::{native, scenario::Run};

const MESSY: &str = "\\begin{itemize}\n\\item one\n\\item two\n\\end{itemize}\n";
/// The fixture's main.tex as checked in. The modules before this one leave
/// their edits in the open buffer (editor_adapter's `xcolor,` in the
/// `\usepackage` list, palette's `%` before `\documentclass`, which rightly
/// takes the preamble's fold away), so the key checks run on this text and
/// the buffer is put back after them.
const FIXTURE_MAIN: &str = include_str!("../../../../../fixtures/e2e/main.tex");

impl Run {
    pub(super) async fn editor_commands(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let main = root.join("main.tex");
        let panel = self.open(cx, &main, Some(2))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let original = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);
        let set_text = |run: &Self, cx: &mut AsyncApp, text: &str| -> Result<()> {
            let panel = panel.clone();
            let text = text.to_string();
            run.with_window(cx, move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    let len = panel.text_and_caret(cx).0.len();
                    panel.replace_range(0, len, &text, 0, window, cx)
                })
            })
        };
        set_text(self, cx, FIXTURE_MAIN)?;
        self.pause(cx, Duration::from_millis(150)).await;

        // ⌃L: the caret's whole line, its newline included.
        let line = FIXTURE_MAIN.find("\\usepackage").context("line 2")?;
        self.select(cx, &panel, line + 2, line + 2)?;
        let ctrl_l = Keystroke::parse("ctrl-l").map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(ctrl_l, cx)
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        let (_, selected) = self.text_and_selection(cx, &panel);
        steps.check(
            "⌃L in the source selects the caret's whole line, as CodeMirror's Ctrl-L does",
            selected == "\\usepackage{amsmath}\n",
            json!({ "selected": selected }),
        );

        // A native ⌘-click on plain text: a second cursor.
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        self.select(cx, &panel, line, line)?;
        let (_, rect) = self
            .text_point(cx, &panel, &lattice, "Some text", 2)
            .await?;
        let native = self.native(cx)?;
        native::send_command_click(native, point(rect.left() + px(3.), rect.center().y))?;
        self.pause(cx, Duration::from_millis(200)).await;
        let cursors = cx.update(|cx| panel.read(cx).editor().read(cx).selections.count());
        steps.check(
            "a native ⌘-click on plain text in the source adds a cursor, as CodeMirror's does",
            cursors == 2,
            json!({ "cursors": cursors }),
        );
        self.press(cx, '\u{1b}', false).await?;

        // ⌃⌥[ and ⌃⌥]: the LaTeX ranges the fold column folds, from the top.
        let folded_rows = |run: &Self, cx: &mut AsyncApp, keys: &'static str| -> Result<Vec<u32>> {
            let keys = Keystroke::parse(keys).map_err(|error| anyhow::anyhow!("{error}"))?;
            let lattice = lattice.clone();
            run.with_window(cx, move |_, window, cx| {
                window.dispatch_keystroke(keys, cx);
                lattice.update(cx, |lattice, cx| {
                    (0..11)
                        .filter(|row| lattice.is_folded(*row, window, cx))
                        .collect()
                })
            })
        };
        let all = folded_rows(self, cx, "ctrl-alt-[")?;
        let none = folded_rows(self, cx, "ctrl-alt-]")?;
        steps.check(
            "⌃⌥[ folds the preamble and the document environment as the LaTeX fold column does, and ⌃⌥] unfolds them",
            all.contains(&0) && all.contains(&3) && none.is_empty(),
            json!({ "folded": all, "after_unfold": none }),
        );
        set_text(self, cx, &original)?;

        self.format_document_step(cx, steps, root).await?;
        self.emacs_ctrl_l(cx, steps, &main).await?;
        self.vim_line_closes(cx, steps, &main).await?;
        self.vim_command_line(cx, steps, &main, &original).await
    }

    /// Under the Emacs keymap ⌃L stays Emacs's recenter, so it selects nothing.
    async fn emacs_ctrl_l(&self, cx: &mut AsyncApp, steps: &mut Steps, main: &Path) -> Result<()> {
        let keymap = cx.update(|cx| crate::settings::get(cx).appearance.editor_keymap);
        cx.update(|cx| {
            crate::settings::update_appearance(cx, |a| a.editor_keymap = EditorKeymap::Emacs)
        });
        self.pause(cx, Duration::from_millis(200)).await;
        let panel = self.open(cx, main, Some(2))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.select(cx, &panel, 2, 2)?;
        let ctrl_l = Keystroke::parse("ctrl-l").map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| window.dispatch_keystroke(ctrl_l, cx))?;
        self.pause(cx, Duration::from_millis(150)).await;
        let (_, selected) = self.text_and_selection(cx, &panel);
        cx.update(|cx| crate::settings::update_appearance(cx, |a| a.editor_keymap = keymap));
        self.pause(cx, Duration::from_millis(200)).await;
        steps.check(
            "with the Emacs keymap on, ⌃L stays Emacs's recenter and selects nothing",
            selected.is_empty(),
            json!({ "selected": selected }),
        );
        Ok(())
    }

    /// Vim's `:` line closes on Escape and when focus leaves it.
    async fn vim_line_closes(&self, cx: &mut AsyncApp, steps: &mut Steps, main: &Path) -> Result<()> {
        let keymap = cx.update(|cx| crate::settings::get(cx).appearance.editor_keymap);
        cx.update(|cx| {
            crate::settings::update_appearance(cx, |a| a.editor_keymap = EditorKeymap::Vim)
        });
        self.pause(cx, Duration::from_millis(200)).await;
        let panel = self.open(cx, main, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.select(cx, &panel, 0, 0)?;
        self.press(cx, '\u{1b}', false).await?;
        self.press(cx, ':', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let opened_1 = cx.update(|cx| panel.read(cx).vim_ex_open());
        self.press(cx, '\u{1b}', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let after_escape = cx.update(|cx| panel.read(cx).vim_ex_open());
        self.press(cx, ':', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let opened_2 = cx.update(|cx| panel.read(cx).vim_ex_open());
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                let focus = gpui::Focusable::focus_handle(panel.read(cx).editor().read(cx), cx);
                window.focus(&focus, cx);
            }
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        let after_blur = cx.update(|cx| panel.read(cx).vim_ex_open());
        cx.update(|cx| crate::settings::update_appearance(cx, |a| a.editor_keymap = keymap));
        self.pause(cx, Duration::from_millis(200)).await;
        steps.check(
            "with Vim on, the : line closes on Escape and when focus leaves it for the text",
            opened_1 && !after_escape && opened_2 && !after_blur,
            json!({ "opened": opened_1, "after_escape": after_escape, "reopened": opened_2, "after_blur": after_blur }),
        );
        Ok(())
    }

    async fn format_document_step(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        if !lattice_core::commands::available("latexindent") {
            steps.check(
                "Format document runs latexindent (skipped: latexindent is not installed)",
                true,
                json!({ "skipped": true }),
            );
            return Ok(());
        }
        let path = root.join("e2e-format.tex");
        std::fs::write(&path, MESSY)?;
        let panel = self.open(cx, &path, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        // From the palette, found by its keyword as the Tauri command table's
        // `format` entry is (`keywords: "latexindent"`).
        self.open_palette_now(cx)?;
        self.palette_type(cx, "latexindent")?;
        self.pause(cx, Duration::from_millis(150)).await;
        let rows = self.palette_rows_now(cx);
        let listed = rows.iter().any(|(_, label, _)| label == "Format document");
        let ran = listed && self.palette_run(cx, "Format document")?;
        steps.check(
            "typing latexindent in the palette lists Format document for a LaTeX file",
            listed && ran,
            json!({ "rows": rows.iter().map(|(group, label, _)| format!("{group}: {label}")).collect::<Vec<_>>() }),
        );
        let formatted = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                let text = panel.read(cx).text_and_caret(cx).0;
                text != MESSY
                    && text
                        .lines()
                        .any(|line| line.trim_start() == "\\item one" && line != "\\item one")
            })
            .await;
        let text = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);
        steps.check(
            "Format document in a LaTeX file applies latexindent's result to the buffer, the items indented",
            formatted,
            json!({ "text": text }),
        );
        self.close_panel(cx, &panel).await?;
        std::fs::remove_file(&path).ok();
        Ok(())
    }

    /// Vim's `:w`, `:3` and `:q` typed with native keys.
    async fn vim_command_line(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        main: &Path,
        original: &str,
    ) -> Result<()> {
        let keymap = cx.update(|cx| crate::settings::get(cx).appearance.editor_keymap);
        cx.update(|cx| {
            crate::settings::update_appearance(cx, |a| a.editor_keymap = EditorKeymap::Vim)
        });
        self.pause(cx, Duration::from_millis(200)).await;
        let panel = self.open(cx, main, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let edited = format!("{original}% vim\n");
        self.with_window(cx, {
            let panel = panel.clone();
            let edited = edited.clone();
            move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    let len = panel.text_and_caret(cx).0.len();
                    panel.replace_range(0, len, &edited, 0, window, cx)
                })
            }
        })?;
        self.select(cx, &panel, 0, 0)?;
        self.press(cx, '\u{1b}', false).await?;
        self.press(cx, ':', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let opened = cx.update(|cx| panel.read(cx).vim_ex_open());
        self.type_text(cx, "w\n").await?;
        let saved = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                std::fs::read_to_string(main).is_ok_and(|text| text == edited)
            })
            .await;
        self.press(cx, ':', false).await?;
        self.type_text(cx, "3\n").await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let line = cx.update(|cx| panel.read(cx).cursor().0);
        // The file as it was before `:q` closes its tab.
        self.with_window(cx, {
            let panel = panel.clone();
            let original = original.to_string();
            move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    let len = panel.text_and_caret(cx).0.len();
                    panel.replace_range(0, len, &original, 0, window, cx)
                })
            }
        })?;
        self.press(cx, ':', false).await?;
        self.type_text(cx, "w\n").await?;
        self.wait_for(cx, Duration::from_secs(10), |_, _| {
            std::fs::read_to_string(main).is_ok_and(|text| text == original)
        })
        .await;
        self.press(cx, ':', false).await?;
        self.type_text(cx, "q\n").await?;
        // Its view leaves the workspace, as the tab's own X takes it away.
        let closed = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).view_of_editor(&panel).is_none()
            })
            .await;
        cx.update(|cx| crate::settings::update_appearance(cx, |a| a.editor_keymap = keymap));
        steps.check(
            "with Vim on, : opens Lattice's command line in the source, :w saves the file, :3 goes to line 3 and :q closes the tab",
            opened && saved && line == 3 && closed,
            json!({ "opened": opened, "saved": saved, "line": line, "closed": closed }),
        );
        Ok(())
    }
}

/// This file's registration as the e2e module `editor_commands` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 115,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_panel/vim_ex.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/format_document.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/source_pointer.rs",
        "gpui/crates/lattice-gpui/src/shell/commands/keymap.rs",
        "gpui/crates/lattice-gpui/src/app.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.editor_commands(cx, steps, &fixture.root)),
};
