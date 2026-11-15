//! The PDF's SyncTeX and file details, as the Tauri app has them: a
//! double-click lands the caret on the clicked word of the source line,
//! not at its start; the palette words the PDF's rows as the Tauri app's
//! command table does; and a PDF of the project open in a tab says when it
//! was removed, and takes the file back once it returns.

use std::{path::Path, time::Duration};

use anyhow::{Result, anyhow};
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{
    pdf::{PdfEngine, PdfViewEvent, clicked_word_at},
    scenario::Run,
    shell::commands,
};

impl Run {
    async fn pdf_sync_polish(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        // The chapter's "second", found in the PDF's own text as PDFium
        // reads it, and the word a double-click on it reads there; the line
        // SyncTeX names for that point (the paragraph may answer any of its
        // lines) must hold it, and the caret lands on it, 1-based.
        let chapter = root.join("chapters/intro.tex");
        let editor = self.open(cx, &chapter, Some(1))?;
        let engine = cx.update(|cx| PdfEngine::global(cx)).map_err(|error| anyhow!("{error}"))?;
        let doc = engine.new_document();
        let info = engine.open(doc, std::fs::read(root.join("main.pdf"))?).await??;
        let mut found = None;
        for page in 0..info.page_sizes.len() {
            let text = engine.text(doc, info.generation, page).await??;
            let at = text.chars.windows(6).position(|run| run.iter().map(|ch| ch.ch).eq("second".chars()));
            if let Some(at) = at {
                let ch = text.chars[at + 1];
                let (x, y) = ((ch.x0 + ch.x1) / 2., (ch.y0 + ch.y1) / 2.);
                found = Some((page as u32 + 1, (x, y), clicked_word_at(&text, x, y)));
                break;
            }
        }
        engine.close(doc);
        let mut detail = json!({ "found": found.is_some() });
        let mut landed = false;
        if let Some((page, (x, y), clicked)) = found {
            let point = (f64::from(x), f64::from(y));
            let line = lattice_core::latex::inverse_search_in(root, page, point.0, point.1, None)
                .map_err(|error| anyhow!(error))?;
            let text = std::fs::read_to_string(&chapter)?;
            let source = text.lines().nth(line.line as usize - 1).unwrap_or_default().to_string();
            let column = source.find("second");
            let word = clicked.as_ref().map(|clicked| clicked.word.clone());
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| shell.double_click_pdf(page, point, clicked, window, cx))
            })?;
            self.pause(cx, Duration::from_millis(600)).await;
            let caret = cx.update(|cx| editor.read(cx).cursor());
            landed = word.as_deref() == Some("second")
                && column.is_some_and(|column| caret == (line.line, column as u32 + 1));
            detail = json!({
                "line": line.line,
                "word": word,
                "column": column,
                "caret": [caret.0, caret.1],
            });
        }
        steps.check(
            "SyncTeX: a double-click in the PDF lands the caret on the clicked word of its line",
            landed,
            detail,
        );

        self.figure_and_newest_jump(cx, steps, root).await?;

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

type Found = (u32, (f64, f64), Option<lattice_editor::latex::synctex_word::SyncTexWord>);

impl Run {
    /// Where `word` is in the PDF's own text as PDFium reads it: its page
    /// (1-based), the point on its second letter, and the word a click
    /// there reads.
    async fn find_in_pdf_text(&self, cx: &mut AsyncApp, root: &Path, word: &str) -> Result<Option<Found>> {
        let engine = cx.update(|cx| PdfEngine::global(cx)).map_err(|error| anyhow!("{error}"))?;
        let doc = engine.new_document();
        let info = engine.open(doc, std::fs::read(root.join("main.pdf"))?).await??;
        let wanted: Vec<char> = word.chars().collect();
        let mut found = None;
        for page in 0..info.page_sizes.len() {
            let text = engine.text(doc, info.generation, page).await??;
            let at = text.chars.windows(wanted.len()).position(|run| run.iter().map(|ch| ch.ch).eq(wanted.iter().copied()));
            if let Some(at) = at {
                let ch = text.chars[at + 1];
                let (x, y) = ((ch.x0 + ch.x1) / 2., (ch.y0 + ch.y1) / 2.);
                found = Some((page as u32 + 1, (f64::from(x), f64::from(y)), clicked_word_at(&text, x, y)));
                break;
            }
        }
        engine.close(doc);
        Ok(found)
    }

    /// The caret `word`'s click should land on: SyncTeX's line for the
    /// point, and the word's 1-based column in it.
    fn landing(root: &Path, chapter: &Path, found: &Found, word: &str) -> Result<Option<(u32, u32)>> {
        let line = lattice_core::latex::inverse_search_in(root, found.0, found.1.0, found.1.1, None)
            .map_err(|error| anyhow!(error))?;
        let text = std::fs::read_to_string(chapter)?;
        let source = text.lines().nth(line.line as usize - 1).unwrap_or_default().to_string();
        Ok(source.find(word).map(|column| (line.line, column as u32 + 1)))
    }

    /// A ⌘-double-click off a figure is the ordinary jump, through the PDF
    /// view's own event; and a plain double-click made while that ⌘ lookup
    /// still runs is the one that lands (`pdf-figure-source-open.tsx`).
    async fn figure_and_newest_jump(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let a = self.find_in_pdf_text(cx, root, "second").await?;
        let b = self.find_in_pdf_text(cx, root, "introduces").await?;
        let (Some(a), Some(b)) = (a, b) else {
            steps.check("PDF: a ⌘-double-click off a figure is the ordinary jump", false, json!({ "found": false }));
            return Ok(());
        };
        let (Some(at_a), Some(at_b)) = (Self::landing(root, &chapter, &a, "second")?, Self::landing(root, &chapter, &b, "introduces")?) else {
            steps.check("PDF: a ⌘-double-click off a figure is the ordinary jump", false, json!({ "landing": false }));
            return Ok(());
        };
        let editor = self.open(cx, &chapter, Some(1))?;
        let emit_as = |found: &Found, figure: bool| {
            let event = PdfViewEvent::SourceAt { page: found.0, x: found.1.0, y: found.1.1, word: found.2.clone(), figure };
            move |shell: &gpui::Entity<crate::shell::Shell>, _: &mut gpui::Window, cx: &mut gpui::App| {
                let view = shell.read(cx).pdf().read(cx).live_view().clone();
                view.update(cx, |_, cx| cx.emit(event));
            }
        };
        let emit = |found: &Found| emit_as(found, true);
        // The same event without ⌘, through the same path, for comparison.
        self.with_window(cx, emit_as(&a, false))?;
        self.pause(cx, Duration::from_millis(800)).await;
        let plain = cx.update(|cx| editor.read(cx).cursor());
        let editor = self.open(cx, &chapter, Some(1))?;
        self.with_window(cx, emit(&a))?;
        let mut caret = (0, 0);
        for _ in 0..25 {
            self.pause(cx, Duration::from_millis(200)).await;
            caret = cx.update(|cx| editor.read(cx).cursor());
            if caret == at_a {
                break;
            }
        }
        steps.check(
            "PDF: a ⌘-double-click off a figure is the ordinary jump, landing on the clicked word",
            caret == at_a,
            json!({ "expected": [at_a.0, at_a.1], "caret": [caret.0, caret.1], "plain_same_path": [plain.0, plain.1] }),
        );

        let editor = self.open(cx, &chapter, Some(1))?;
        self.with_window(cx, emit(&a))?;
        let (page, point, word) = b.clone();
        self.with_window(cx, move |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.double_click_pdf(page, point, word, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(1200)).await;
        let caret = cx.update(|cx| editor.read(cx).cursor());
        steps.check(
            "PDF: of a ⌘-double-click and a newer plain double-click, only the newer jump lands",
            caret == at_b && at_a != at_b,
            json!({ "older": [at_a.0, at_a.1], "newer": [at_b.0, at_b.1], "caret": [caret.0, caret.1] }),
        );
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
