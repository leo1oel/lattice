//! A saved paper in its reader, as the Tauri app reads one
//! (`paper-reader.tsx`, `document-canvas.tsx`): the full text in the visual
//! editor's reading form under its masthead, Blog and Paper, and the
//! original PDF in the text's place and back.
//!
//! The bundle gains an overview and an original PDF here, and the library
//! is read again so the paper has both; the panel steps put the bundle back.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::{Value, json};

use super::super::Steps;
use crate::{
    papers::{
        PapersPanel,
        reader::{PaperReader, ReaderView},
    },
    scenario::Run,
};

const BLOG: &str = "# Attention, briefly\n\nA reading of the Transformer paper.\n";

/// The smallest PDF PDFium opens (its cross-reference table is rebuilt on
/// load): one blank 200pt page.
const PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

/// What the reading page draws, read from its DOM: the masthead's title,
/// the editor in its reading form, KaTeX's formulas.
const PAGE: &str = "JSON.stringify({\
    title: document.querySelector('.paper-visual-header h1')?.textContent ?? null,\
    reading: Boolean(document.querySelector('.lx-md-editor.is-reading')),\
    formulas: document.querySelectorAll('.katex').length,\
})";

impl Run {
    /// The reader in front, once it shows `view` drawn on its page.
    async fn reader_drawn(
        &self,
        cx: &mut AsyncApp,
        view: ReaderView,
    ) -> Option<Entity<PaperReader>> {
        let drawn = self
            .wait_for(cx, Duration::from_secs(20), move |shell, cx| {
                let shell = shell.read(cx);
                let in_view = shell
                    .front_reader_panel(cx)
                    .is_some_and(|reader| reader.read(cx).view() == view);
                in_view
                    && shell
                        .front_reader_state(cx)
                        .is_some_and(|(_, page, pdf)| page && !pdf)
            })
            .await;
        if !drawn {
            return None;
        }
        cx.update(|cx| self.shell.read(cx).front_reader_panel(cx))
    }

    async fn reading_page(&self, cx: &mut AsyncApp, reader: &Entity<PaperReader>) -> Value {
        let island = cx.update(|cx| {
            reader
                .read(cx)
                .editor()
                .and_then(|editor| editor.read(cx).markdown_document().cloned())
                .and_then(|document| document.read(cx).island().cloned())
        });
        match island {
            Some(island) => self.evaluate(cx, &island, PAGE).await,
            None => Value::Null,
        }
    }

    pub(super) async fn paper_reader(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        papers: &Entity<PapersPanel>,
        bundle: &str,
    ) -> Result<()> {
        std::fs::write(root.join(bundle).join("blog.md"), BLOG)?;
        std::fs::write(root.join(bundle).join("original.pdf"), PDF)?;
        cx.update(|cx| papers.update(cx, |papers, cx| papers.reload(cx)));
        let listed = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                papers
                    .read(cx)
                    .papers
                    .iter()
                    .any(|paper| paper.has_blog && paper.has_local_pdf && paper.has_full_text)
            })
            .await;
        steps.check(
            "a saved paper with an overview and its original PDF is listed with both",
            listed,
            json!({}),
        );
        if !listed {
            return Ok(());
        }
        self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| {
                panel.open_titled("Attention Is All You Need", window, cx)
            })
        })?;
        let Some(reader) = self.reader_drawn(cx, ReaderView::FullText).await else {
            steps.check(
                "the paper's full text is drawn in its reader",
                false,
                json!({}),
            );
            return Ok(());
        };

        // The full text reads in the Tauri app's engine: the masthead names
        // the paper, the editor is in its reading form, the formula is
        // KaTeX's.
        let page = self.reading_page(cx, &reader).await;
        steps.check(
            "the full text reads in the visual editor's reading form under its masthead, with KaTeX",
            page["title"] == "Attention Is All You Need"
                && page["reading"] == true
                && page["formulas"].as_u64().is_some_and(|count| count >= 1),
            json!({ "page": page }),
        );
        self.island_shot(cx, "paper-reader").await?;
        // At the top of the full text its masthead is on screen, so the
        // strip leaves out the title and authors the masthead carries.
        let hidden = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .front_reader_panel(cx)
                    .is_some_and(|reader| reader.read(cx).masthead_on_screen(cx))
            })
            .await;
        steps.check(
            "the strip leaves out the title and authors while the full text's masthead is on screen",
            hidden,
            json!({}),
        );

        // Blog shows the overview, with no masthead over it.
        self.with_window(cx, |_, window, cx| {
            reader.update(cx, |reader, cx| {
                reader.show(ReaderView::Overview, window, cx)
            })
        })?;
        let overview = self.reader_drawn(cx, ReaderView::Overview).await;
        let (path, page) = match &overview {
            Some(reader) => (
                cx.update(|cx| reader.read(cx).path()),
                self.reading_page(cx, reader).await,
            ),
            None => (String::new(), Value::Null),
        };
        steps.check(
            "Blog shows the paper's overview without the full text's masthead",
            path == format!("{bundle}/blog.md") && page["title"].is_null(),
            json!({ "path": path, "page": page }),
        );

        // Back on the full text, still at its top, the strip keeps leaving
        // out the identity: the island has no new intersection to report, so
        // the reader must keep what the full text last reported.
        self.with_window(cx, |_, window, cx| {
            reader.update(cx, |reader, cx| {
                reader.show(ReaderView::FullText, window, cx)
            })
        })?;
        let back_on_paper = self.reader_drawn(cx, ReaderView::FullText).await.is_some();
        let still_hidden = back_on_paper
            && self
                .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                    shell
                        .read(cx)
                        .front_reader_panel(cx)
                        .is_some_and(|reader| reader.read(cx).masthead_on_screen(cx))
                })
                .await;
        steps.check(
            "back from Blog on the full text's top, the strip still leaves out the title and authors",
            still_hidden,
            json!({ "drawn": back_on_paper }),
        );
        self.with_window(cx, |_, window, cx| {
            reader.update(cx, |reader, cx| {
                reader.show(ReaderView::Overview, window, cx)
            })
        })?;
        if self.reader_drawn(cx, ReaderView::Overview).await.is_none() {
            steps.check("Blog is shown again before the PDF", false, json!({}));
        }

        // The original PDF stands in the text's place, the text's page put
        // away while it does, and the way back brings the text again.
        self.with_window(cx, |_, window, cx| {
            reader.update(cx, |reader, cx| reader.open_pdf(window, cx))
        })?;
        let pdf_shown = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .front_reader_state(cx)
                    .is_some_and(|(_, page, pdf)| pdf && !page)
                    && shell
                        .read(cx)
                        .front_reader_panel(cx)
                        .is_some_and(|reader| reader.read(cx).pdf_pages(cx) == 1)
            })
            .await;
        steps.check(
            "the original PDF opens in the reader in the text's place",
            pdf_shown,
            json!({}),
        );
        self.island_shot(cx, "paper-reader-pdf").await?;
        self.with_window(cx, |_, window, cx| {
            reader.update(cx, |reader, cx| {
                let view = reader.view();
                reader.show(view, window, cx)
            })
        })?;
        let back = self.reader_drawn(cx, ReaderView::Overview).await.is_some();
        steps.check(
            "the way back from the PDF shows the text again",
            back,
            json!({}),
        );

        self.press(cx, 'w', true).await?;
        Ok(())
    }
}
