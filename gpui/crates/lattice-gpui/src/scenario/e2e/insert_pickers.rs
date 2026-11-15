//! The e2e checks of the pickers and Go to line (`search/insert_pickers.rs`,
//! `search/goto_line.rs`, `shell/insert_pickers_flow.rs`), each reached by
//! its key through the window's own key dispatch: ⌘⇧K lists the
//! bibliography's keys and writes `\cite{knuth1984}` at the caret, ⌘⇧L lists
//! the project's labels and writes `\ref{sec:method}`, ⌘G goes to the line
//! typed, and ⌘⇧O lists sections and labels and opens the one picked. The
//! chapter is put back after.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, Keystroke};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

#[cfg(target_os = "macos")]
const CITE: &str = "cmd-shift-k";
#[cfg(not(target_os = "macos"))]
const CITE: &str = "ctrl-shift-k";
#[cfg(target_os = "macos")]
const REF: &str = "cmd-shift-l";
#[cfg(not(target_os = "macos"))]
const REF: &str = "ctrl-shift-l";
#[cfg(target_os = "macos")]
const GOTO_LINE: &str = "cmd-g";
#[cfg(not(target_os = "macos"))]
const GOTO_LINE: &str = "ctrl-g";
#[cfg(target_os = "macos")]
const GOTO_SYMBOL: &str = "cmd-shift-o";
#[cfg(not(target_os = "macos"))]
const GOTO_SYMBOL: &str = "ctrl-shift-o";

impl Run {
    pub(super) async fn insert_pickers(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let editor = self.open(cx, &chapter, Some(2))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let original = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
        let end_of_line = original
            .find("document.")
            .context("the chapter's second line")?
            + "document.".len();

        for (keys, command, key, wanted) in [
            (CITE, "cite", "knuth1984", "@knuth1984"),
            (REF, "ref", "sec:method", "@sec:method"),
        ] {
            self.caret_at(cx, &editor, end_of_line)?;
            self.dispatch_keys(cx, keys)?;
            let rows = self.picker_rows(cx).await;
            let listed = rows.iter().any(|row| row == wanted);
            if command == "cite" {
                self.light_and_dark_shots(cx, "insert-citation").await;
            }
            // The key the scenario wants, typed so it ranks first.
            self.type_text(cx, key).await?;
            self.pause(cx, Duration::from_millis(200)).await;
            self.confirm_picker(cx)?;
            self.pause(cx, Duration::from_millis(300)).await;
            let (text, caret) = cx.update(|cx| editor.read(cx).text_and_caret(cx));
            let written = format!("\\{command}{{{key}}}");
            let closed = cx.update(|cx| self.shell.read(cx).quick_open().is_none());
            steps.check(
                &format!(
                    "{keys} lists {wanted} and writes {written} at the caret, the caret after it"
                ),
                listed
                    && closed
                    && text.get(end_of_line..end_of_line + written.len()) == Some(written.as_str())
                    && caret == end_of_line + written.len(),
                json!({ "rows": rows, "closed": closed, "line": text.lines().nth(1), "caret": caret }),
            );
            self.restore(cx, &editor, &original)?;
        }

        // A label typed and not saved is listed, as `liveReferences` has it.
        let unsaved = "\\label{fig:unsaved}";
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.replace_range(end_of_line, end_of_line, unsaved, end_of_line, window, cx)
            })
        })?;
        self.dispatch_keys(cx, REF)?;
        let rows = self.picker_rows(cx).await;
        steps.check(
            "⇧⌘L / Ctrl+Shift+L lists a label typed in the chapter before it is saved",
            rows.iter().any(|row| row == "@fig:unsaved"),
            json!({ "rows": rows }),
        );
        self.close_pickers(cx)?;
        self.restore(cx, &editor, &original)?;

        // One search dialog at a time: each key switches to its own dialog,
        // and only its own key closes it again.
        self.caret_at(cx, &editor, end_of_line)?;
        let mut open = Vec::new();
        for keys in [GOTO_LINE, CITE, REF, GOTO_LINE, REF, REF] {
            self.dispatch_keys(cx, keys)?;
            self.pause(cx, Duration::from_millis(200)).await;
            open.push(cx.update(|cx| {
                let shell = self.shell.read(cx);
                let picker = shell
                    .quick_open()
                    .map(|view| format!("{:?}", view.read(cx).picker_kind()));
                (shell.goto_line_open(), picker)
            }));
        }
        let ref_picker = Some("Some(InsertReference)".to_string());
        let wanted = [
            (true, None),
            (false, Some("Some(InsertCitation)".to_string())),
            (false, ref_picker.clone()),
            (true, None),
            (false, ref_picker),
            (false, None),
        ];
        steps.check(
            "⌘G, ⇧⌘K and ⇧⌘L switch straight to their own dialog over another, and a dialog's own key closes it",
            open == wanted,
            json!({ "open": open }),
        );
        self.close_pickers(cx)?;

        // ⌘G: the caret's line starts selected, so the typed line replaces it.
        self.caret_at(cx, &editor, 0)?;
        self.dispatch_keys(cx, GOTO_LINE)?;
        self.pause(cx, Duration::from_millis(200)).await;
        let opened = cx.update(|cx| self.shell.read(cx).goto_line_open());
        self.light_and_dark_shots(cx, "goto-line").await;
        self.type_text(cx, "3\n").await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let row = self.cursor_row(cx, &editor);
        let closed = cx.update(|cx| !self.shell.read(cx).goto_line_open());
        steps.check(
            "⌘G / Ctrl+G opens Go to line, and the line typed there with Enter is where the caret goes",
            opened && closed && row == 2,
            json!({ "opened": opened, "closed": closed, "row": row }),
        );

        // ⌘⇧O: sections and labels, an unsaved one among them; the label
        // opens where it is.
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.replace_range(end_of_line, end_of_line, unsaved, end_of_line, window, cx)
            })
        })?;
        self.dispatch_keys(cx, GOTO_SYMBOL)?;
        let rows = self.picker_rows(cx).await;
        self.type_text(cx, "sec:method").await?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.confirm_picker(cx)?;
        let landed = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).active_editor_path(cx).as_deref() == Some("main.tex")
            })
            .await;
        steps.check(
            "⌘⇧O / Ctrl+Shift+O lists the manuscript's sections and labels, one typed and not saved among them, and a label picked opens its file",
            landed
                && rows.iter().any(|row| row == "@Method")
                && rows.iter().any(|row| row == "@sec:method")
                && rows.iter().any(|row| row == "@fig:unsaved"),
            json!({ "rows": rows, "landed": landed }),
        );

        // The chapter as it was, for the modules after.
        let editor = self.open(cx, &chapter, Some(2))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.restore(cx, &editor, &original)?;

        // The palette offers the four with a LaTeX source in front, as the
        // Tauri palette does (`textEditor`, `latexSource`), and each row
        // opens its own dialog.
        let mut ran = Vec::new();
        for label in ["Insert citation", "Insert reference", "Go to symbol", "Go to line"] {
            let label_owned = label.to_string();
            let found = self.with_window(cx, move |shell, window, cx| {
                shell.update(cx, |shell, cx| {
                    shell.close_document_overlays(window, cx);
                    shell.open_palette(window, cx);
                });
                let palette = shell.read(cx).palette_view();
                palette.is_some_and(|palette| {
                    palette.update(cx, |palette, cx| {
                        palette.type_query(&label_owned, window, cx);
                        palette.run_labelled(&label_owned, window, cx)
                    })
                })
            })?;
            self.pause(cx, Duration::from_millis(300)).await;
            let open = cx.update(|cx| {
                let shell = self.shell.read(cx);
                let picker = shell
                    .quick_open()
                    .map(|view| format!("{:?}", view.read(cx).picker_kind()));
                (shell.goto_line_open(), picker)
            });
            ran.push((label, found, open));
        }
        self.close_pickers(cx)?;
        let wanted = [
            ("Insert citation", true, (false, Some("Some(InsertCitation)".to_string()))),
            ("Insert reference", true, (false, Some("Some(InsertReference)".to_string()))),
            ("Go to symbol", true, (false, Some("Some(GoToSymbol)".to_string()))),
            ("Go to line", true, (true, None)),
        ];
        steps.check(
            "the palette's Insert citation, Insert reference, Go to symbol and Go to line rows open their own dialogs",
            ran.iter().zip(wanted.iter()).all(|(got, want)| {
                got.0 == want.0 && got.1 == want.1 && got.2 == want.2
            }),
            json!({ "ran": format!("{ran:?}") }),
        );

        // With the bibliography in front (a text editor, not a LaTeX
        // source) the palette keeps Go to line and drops the inserts.
        self.open(cx, &root.join("references.bib"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let labels = self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_palette(window, cx));
            shell.read(cx).palette_view().map(|palette| {
                palette.update(cx, |palette, cx| palette.type_query("Go to", window, cx));
                let mut labels: Vec<String> =
                    palette.read(cx).rows().into_iter().map(|row| row.1).collect();
                palette.update(cx, |palette, cx| palette.type_query("Insert", window, cx));
                labels.extend(palette.read(cx).rows().into_iter().map(|row| row.1));
                labels
            })
        })?;
        let labels = labels.unwrap_or_default();
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;
        steps.check(
            "with references.bib in front the palette offers Go to line but not Insert citation or Insert reference",
            labels.iter().any(|label| label == "Go to line")
                && !labels.iter().any(|label| label == "Insert citation" || label == "Insert reference"),
            json!({ "labels": labels }),
        );
        self.open(cx, &chapter, Some(2))?;
        self.pause(cx, Duration::from_millis(200)).await;
        Ok(())
    }

    /// The window as `name-light` and `name-dark` under `LATTICE_E2E_SHOTS`.
    async fn light_and_dark_shots(&self, cx: &mut AsyncApp, name: &str) {
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return;
        }
        for (appearance, theme) in [
            (lattice_ui::Appearance::Light, "light"),
            (lattice_ui::Appearance::Dark, "dark"),
        ] {
            cx.update(|cx| lattice_ui::LatticeTheme::set_appearance(appearance, cx));
            self.papers_shot(cx, &format!("{name}-{theme}")).await;
        }
        cx.update(|cx| lattice_ui::LatticeTheme::set_appearance(lattice_ui::Appearance::Light, cx));
    }

    pub(super) fn dispatch_keys(&self, cx: &mut AsyncApp, keys: &'static str) -> Result<()> {
        let keystroke = Keystroke::parse(keys).map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(keystroke, cx);
        })
    }

    /// The open picker's rows once it has some.
    async fn picker_rows(&self, cx: &mut AsyncApp) -> Vec<String> {
        self.wait_for(cx, Duration::from_secs(8), |shell, cx| {
            shell.read(cx).quick_open().is_some_and(|view| {
                let view = view.read(cx);
                !view.reading_symbols() && !view.row_texts().is_empty()
            })
        })
        .await;
        cx.update(|cx| {
            self.shell
                .read(cx)
                .quick_open()
                .map(|view| view.read(cx).row_texts())
                .unwrap_or_default()
        })
    }

    fn confirm_picker(&self, cx: &mut AsyncApp) -> Result<()> {
        let view = cx.update(|cx| self.shell.read(cx).quick_open().cloned());
        let Some(view) = view else {
            return Ok(());
        };
        self.with_window(cx, |_, window, cx| {
            view.update(cx, |view, cx| view.confirm(window, cx))
        })
    }

    fn close_pickers(&self, cx: &mut AsyncApp) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })
    }

    fn caret_at(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>, at: usize) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| editor.replace_range(at, at, "", at, window, cx))
        })
    }

    fn restore(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>, text: &str) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                let len = editor.text_and_caret(cx).0.len();
                editor.replace_range(0, len, text, 0, window, cx)
            })
        })
    }
}

/// This file's registration as the e2e module `insert_pickers` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 113,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/search/insert_pickers.rs",
        "gpui/crates/lattice-gpui/src/search/goto_line.rs",
        "gpui/crates/lattice-gpui/src/search/live_labels.rs",
        "gpui/crates/lattice-gpui/src/search/quick_open.rs",
        "gpui/crates/lattice-gpui/src/shell/insert_pickers_flow.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.insert_pickers(cx, steps, &fixture.root)),
};
