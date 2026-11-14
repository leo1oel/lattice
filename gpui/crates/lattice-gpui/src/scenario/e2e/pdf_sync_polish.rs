//! The PDF's SyncTeX and file details, as the Tauri app has them: a
//! double-click lands the caret on the clicked word of the source line,
//! not at its start; the palette words the PDF's rows as the Tauri app's
//! command table does; and a PDF of the project open in a tab says when it
//! was removed, and takes the file back once it returns.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use lattice_editor::latex::synctex_word::SyncTexWord;
use serde_json::json;

use super::Steps;
use crate::{scenario::Run, shell::commands};

impl Run {
    async fn pdf_sync_polish(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        // The chapter's third line, its box in the PDF, and the line SyncTeX
        // names for that box's middle (the paragraph may answer any of its
        // lines).
        let chapter = root.join("chapters/intro.tex");
        let editor = self.open(cx, &chapter, Some(1))?;
        let target = lattice_core::latex::forward_search(root, "chapters/intro.tex", 3, 0)
            .ok()
            .flatten();
        let landing = target.as_ref().and_then(|target| {
            let (x, y) = (target.x + target.width / 2., target.y + target.height / 2.);
            let line = lattice_core::latex::inverse_search_in(root, target.page, x, y, None).ok()?;
            let text = std::fs::read_to_string(&chapter).ok()?;
            let source = text.lines().nth(line.line as usize - 1)?.to_string();
            // Its second word, as the PDF reads it.
            let words: Vec<String> = source.split_whitespace().map(str::to_string).collect();
            let word = words.get(1)?.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
            let column = source.find(words[1].as_str())?;
            Some((target.page, (x, y), line.line, word, words, column))
        });
        let mut detail = json!({ "target": target.is_some() });
        let mut landed = false;
        if let Some((page, point, line, word, words, column)) = landing {
            let clicked = SyncTexWord {
                occurrence: 0,
                count: 1,
                before: Some(words[0].to_lowercase()),
                after: words.get(2).map(|after| after.to_lowercase()),
                word: word.clone(),
            };
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| shell.double_click_pdf(page, point, Some(clicked), window, cx))
            })?;
            self.pause(cx, Duration::from_millis(600)).await;
            let caret = cx.update(|cx| editor.read(cx).cursor());
            landed = caret == (line, column as u32 + 1) || caret == (line, column as u32);
            detail = json!({ "line": line, "word": word, "column": column, "caret": [caret.0, caret.1] });
        }
        steps.check(
            "SyncTeX: a double-click in the PDF lands the caret on the clicked word of its line",
            landed,
            detail,
        );

        let rows = cx.update(|cx| {
            let mut context = self.shell.read(cx).command_context(cx);
            context.latex_source = true;
            commands::commands(&context)
                .into_iter()
                .map(|command| (command.id.to_string(), command.label.to_string()))
                .collect::<Vec<_>>()
        });
        let has = |id: &str, label: &str| rows.iter().any(|row| row.0 == id && row.1 == label);
        steps.check(
            "the palette has the PDF's rows as the Tauri app words them",
            has("sync-pdf", "Jump to PDF")
                && has("pdf-window", "Open the PDF in a separate window")
                && (has("pdf-dark-pages", "Dark PDF pages") || has("pdf-dark-pages", "Light PDF pages")),
            json!({ "rows": rows.iter().filter(|row| row.0.starts_with("pdf") || row.0 == "sync-pdf").collect::<Vec<_>>() }),
        );

        // A PDF of the project in a tab of its own, removed and put back.
        let copy = root.join("figures-copy.pdf");
        std::fs::copy(root.join("main.pdf"), &copy)?;
        self.open(cx, &copy, None).ok();
        let tab = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| !shell.read(cx).file_pdf_tabs().is_empty())
            .await;
        let notice = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                self.shell
                    .read(cx)
                    .file_pdf_tabs()
                    .first()
                    .and_then(|tab| tab.read(cx).notice(cx))
                    .map(|notice| notice.to_string())
            })
        };
        let bytes = std::fs::read(&copy)?;
        std::fs::remove_file(&copy)?;
        let removed = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .file_pdf_tabs()
                    .first()
                    .is_some_and(|tab| tab.read(cx).notice(cx).is_some())
            })
            .await;
        let said = notice(cx);
        std::fs::write(&copy, bytes)?;
        let back = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .file_pdf_tabs()
                    .first()
                    .is_some_and(|tab| tab.read(cx).notice(cx).is_none())
            })
            .await;
        steps.check(
            "a project PDF open in a tab says when it was removed, and takes the file back when it returns",
            tab && removed && back && said.as_deref() == Some("This PDF was removed from the project."),
            json!({ "tab": tab, "removed": removed, "said": said, "back": back }),
        );
        std::fs::remove_file(&copy).ok();
        Ok(())
    }
}

/// This file's registration as the e2e module `pdf_sync_polish`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 20,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/synctex.rs",
        "gpui/crates/lattice-gpui/src/shell/pdf_sync.rs",
        "gpui/crates/lattice-gpui/src/shell/pdf_figure.rs",
        "gpui/crates/lattice-gpui/src/pdf/clicked_word.rs",
        "gpui/crates/lattice-editor/src/latex/synctex_word.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.pdf_sync_polish(cx, steps, &fixture.root)),
};
