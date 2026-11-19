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
use lattice_webview::Island;
use serde_json::{Value, json};
use trellis::runtime::keymap::Command as Trellis;

use super::super::Steps;
use crate::{
    papers::{
        PapersPanel,
        reader::{PaperReader, ReaderView},
    },
    pdf::FitMode,
    scenario::Run,
};

const BLOG: &str = "# Attention, briefly\n\nA reading of the Transformer paper.\n";

/// A small PDF PDFium opens (its cross-reference table is rebuilt on load):
/// one Letter page holding the paper's title and the full text's first
/// sentence, in Helvetica, so a passage of either can be found on it.
fn pdf() -> Vec<u8> {
    let content = "BT /F1 12 Tf 72 720 Td (Attention Is All You Need) Tj 0 -24 Td (The dominant sequence transduction models are based on recurrent networks.) Tj ET";
    format!(
        "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n5 0 obj<</Length {}>>stream\n{content}\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
        content.len()
    )
    .into_bytes()
}

/// What the reading page draws, read from its DOM: the masthead's title,
/// the editor in its reading form, KaTeX's formulas.
const PAGE: &str = "JSON.stringify({\
    title: document.querySelector('.paper-visual-header h1')?.textContent ?? null,\
    reading: Boolean(document.querySelector('.lx-md-editor.is-reading')),\
    formulas: document.querySelectorAll('.katex').length,\
})";

/// A pointer over the full text's first heading, then its first paragraph,
/// as hovering them does: the block controls (`block-controls.tsx`) follow
/// the layer's `mousemove` and place themselves when their block changes, so
/// passing over another block first draws them where the layout is now.
const HOVER_BLOCK: &str = "(() => {\
    const block = document.querySelector('.lx-md-editor .lx-md-surface > p');\
    const before = document.querySelector('.lx-md-editor .lx-md-surface > :is(h1, h2, h3)');\
    if (!block || !before) return 'false';\
    for (const element of [before, block]) {\
        const rect = element.getBoundingClientRect();\
        element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + 8, clientY: rect.top + 4 }));\
    }\
    return 'true';\
})()";

/// Where the hovered block's "Add block below" landed: in the text's left
/// lane and inside the scroll viewport, and the topmost thing at its centre,
/// so the viewport's clip does not hide it.
const BLOCK_CONTROLS: &str = "JSON.stringify((() => {\
    const add = document.querySelector('.lx-md-block-controls .lx-md-block-control:not(.is-grip)');\
    const viewport = document.querySelector('.editor-doc-scroll');\
    const block = document.querySelector('.lx-md-editor .lx-md-surface > p');\
    if (!add || !viewport || !block) return { shown: Boolean(add) };\
    const a = add.getBoundingClientRect();\
    const v = viewport.getBoundingClientRect();\
    const hit = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);\
    return {\
        shown: true,\
        left: a.left,\
        right: a.right,\
        viewportLeft: v.left,\
        textLeft: block.getBoundingClientRect().left,\
        inside: a.left >= v.left && a.right <= v.right,\
        hit: Boolean(hit?.closest('.lx-md-block-control')),\
    };\
})())";

impl Run {
    /// The reader in front, once it shows `view` drawn on its page.
    pub(super) async fn reader_drawn(
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

    /// The island the reader's text is drawn in.
    fn reading_island(cx: &mut AsyncApp, reader: &Entity<PaperReader>) -> Option<Entity<Island>> {
        cx.update(|cx| {
            reader
                .read(cx)
                .editor()
                .and_then(|editor| editor.read(cx).markdown_document().cloned())
                .and_then(|document| document.read(cx).island().cloned())
        })
    }

    async fn reading_page(&self, cx: &mut AsyncApp, reader: &Entity<PaperReader>) -> Value {
        match Self::reading_island(cx, reader) {
            Some(island) => self.evaluate(cx, &island, PAGE).await,
            None => Value::Null,
        }
    }

    /// Hover the full text's first paragraph and read where its block
    /// controls landed.
    async fn paper_block_controls(&self, cx: &mut AsyncApp, reader: &Entity<PaperReader>) -> Value {
        let Some(island) = Self::reading_island(cx, reader) else {
            return Value::Null;
        };
        if self.evaluate(cx, &island, HOVER_BLOCK).await != true {
            return Value::Null;
        }
        // React draws the controls on the next frame.
        self.pause(cx, Duration::from_millis(300)).await;
        self.evaluate(cx, &island, BLOCK_CONTROLS).await
    }

    /// Maximize the reader's panel, or restore it.
    fn toggle_reader_maximized(&self, cx: &mut AsyncApp, reader: &Entity<PaperReader>) -> Result<()> {
        let reader = reader.entity_id();
        self.with_window(cx, move |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                if let Some(view) = shell.view_of_panel(reader) {
                    shell.engine_do(cx, |engine| engine.focus_view(&view));
                }
                shell.run_trellis(Trellis::FrameToggle, cx);
            })
        })
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
        std::fs::write(root.join(bundle).join("original.pdf"), pdf())?;
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
        // Hovering a block of the text shows Add block below and the grip in
        // the text's left lane, inside the pane, as the Tauri reader does:
        // the surface's inline padding is that lane
        // (`lattice-visual-editor.css`), which the island leaves to it.
        let controls = self.paper_block_controls(cx, &reader).await;
        steps.check(
            "hovering a block of the full text shows Add block below beside it, inside the pane",
            controls["shown"] == true
                && controls["inside"] == true
                && controls["hit"] == true
                && controls["right"].as_f64() <= controls["textLeft"].as_f64(),
            json!({ "controls": controls }),
        );
        self.island_shot(cx, "paper-reader").await?;
        // A pane wider than the text's measure gives it a centring margin:
        // the controls stay in that margin and in the pane (a rule of the
        // island's once cut the lane to 24px there, and the "+" fell off the
        // pane's left edge). The reader's panel fills the workspace for it.
        self.toggle_reader_maximized(cx, &reader)?;
        self.pause(cx, Duration::from_millis(600)).await;
        let wide = self.paper_block_controls(cx, &reader).await;
        steps.check(
            "in a pane wider than the text, Add block below still shows beside the hovered block, inside the pane",
            wide["shown"] == true
                && wide["inside"] == true
                && wide["hit"] == true
                && wide["right"].as_f64() <= wide["textLeft"].as_f64(),
            json!({ "controls": wide }),
        );
        self.island_shot(cx, "paper-reader-wide").await?;
        self.toggle_reader_maximized(cx, &reader)?;
        self.pause(cx, Duration::from_millis(300)).await;
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
        if pdf_shown {
            self.paper_pdf_fit_width(cx, steps, &reader).await?;
            self.paper_pdf_toolbar_start(cx, steps, root, bundle, &reader)
                .await?;
            self.paper_pdf_actions(cx, steps, root, bundle, &reader)
                .await?;
        }
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
        self.paper_text_actions(cx, steps, root, bundle, &reader)
            .await?;
        self.paper_browser_failure(cx, steps, &reader).await?;

        self.press(cx, 'w', true).await?;
        Ok(())
    }

    /// The way back from the PDF stands at its toolbar's start, before
    /// Previous page, as the Tauri reader's `toolbarStart` does, not among
    /// the controls on the right; and while the PDF is still coming from
    /// the web (staged here, as the scenario has no network) the toolbar
    /// holds only the way back, over the page's skeleton, and then over
    /// "Could not load PDF" when it did not come.
    /// Fit page to width pressed while the page is already fitted fits it
    /// again and stays on; only a zoom leaves the fit, and the button then
    /// brings the fitted scale back.
    async fn paper_pdf_fit_width(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        reader: &Entity<PaperReader>,
    ) -> Result<()> {
        let Some(view) = cx.update(|cx| reader.read(cx).pdf_view()) else {
            return Ok(());
        };
        let state = |cx: &mut AsyncApp| cx.update(|cx| (view.read(cx).fit(), view.read(cx).scale()));
        cx.update(|cx| view.update(cx, |view, cx| view.apply_fit(FitMode::Width, cx)));
        self.pause(cx, Duration::from_millis(300)).await;
        let fitted = state(cx);
        cx.update(|cx| view.update(cx, |view, cx| view.apply_fit(FitMode::Width, cx)));
        self.pause(cx, Duration::from_millis(300)).await;
        let again = state(cx);
        cx.update(|cx| view.update(cx, |view, cx| view.step_zoom(-1., cx)));
        self.pause(cx, Duration::from_millis(300)).await;
        let zoomed = state(cx);
        cx.update(|cx| view.update(cx, |view, cx| view.apply_fit(FitMode::Width, cx)));
        self.pause(cx, Duration::from_millis(300)).await;
        let refitted = state(cx);
        steps.check(
            "the paper's PDF: Fit page to width pressed when fitted stays on, and refits after a zoom",
            fitted.0 == Some(FitMode::Width)
                && again == fitted
                && zoomed.0.is_none()
                && zoomed.1 < fitted.1
                && refitted.0 == Some(FitMode::Width)
                && (refitted.1 - fitted.1).abs() < 0.01,
            json!({ "fitted": format!("{fitted:?}"), "again": format!("{again:?}"), "zoomed": format!("{zoomed:?}"), "refitted": format!("{refitted:?}") }),
        );
        Ok(())
    }

    async fn paper_pdf_toolbar_start(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        bundle: &str,
        reader: &Entity<PaperReader>,
    ) -> Result<()> {
        let Some(view) = cx.update(|cx| reader.read(cx).pdf_view()) else {
            steps.check("the reader's PDF has a viewer", false, json!({}));
            return Ok(());
        };
        let (start_row, previous_row) = crate::pdf::toolbar_start_rows();
        let rows = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                view.read(cx)
                    .toolbar_hover_snapshot(cx)
                    .unwrap_or_default()
                    .rows
            })
        };
        let bounds_of = |rows: &[(usize, gpui::Bounds<gpui::Pixels>, bool)], row: usize| {
            rows.iter()
                .find(|(ix, _, _)| *ix == row)
                .map(|(_, bounds, _)| *bounds)
        };
        self.pause(cx, Duration::from_millis(300)).await;
        let loaded = rows(cx);
        let start = bounds_of(&loaded, start_row);
        let previous = bounds_of(&loaded, previous_row);
        let before_pages = start
            .zip(previous)
            .is_some_and(|(start, previous)| start.right() <= previous.left());
        steps.check(
            "the reader's way back from the PDF stands at the toolbar's start, before Previous page, as the Tauri reader's toolbarStart does",
            before_pages,
            json!({
                "start": start.map(|b| format!("{b:?}")),
                "previous": previous.map(|b| format!("{b:?}")),
                "rows": loaded.iter().map(|(ix, _, _)| *ix).collect::<Vec<_>>(),
            }),
        );

        // Still coming from the web: the way back alone, over the skeleton.
        self.with_window(cx, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.close(window, cx);
                view.set_host_load(crate::pdf::HostLoad::Fetching, cx);
            })
        })?;
        self.pause(cx, Duration::from_millis(400)).await;
        let fetching = rows(cx);
        let only_start = fetching.len() == 1 && bounds_of(&fetching, start_row).is_some();
        self.island_shot(cx, "paper-reader-pdf-loading").await?;
        self.with_window(cx, |_, _, cx| {
            view.update(cx, |view, cx| {
                view.set_host_load(
                    crate::pdf::HostLoad::Failed(lattice_i18n::t!("Could not load PDF").into()),
                    cx,
                )
            })
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let failed = rows(cx);
        let failed_only_start = failed.len() == 1 && bounds_of(&failed, start_row).is_some();
        self.island_shot(cx, "paper-reader-pdf-failed").await?;
        // The PDF arrives: the whole toolbar again.
        let file = root.join(bundle).join("original.pdf");
        self.with_window(cx, |_, window, cx| {
            view.update(cx, |view, cx| view.open(file, window, cx))
        })?;
        let back = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                view.read(cx).page_count() == 1
                    && *view.read(cx).host_load() == crate::pdf::HostLoad::Ready
            })
            .await;
        steps.check(
            "while the reader's PDF is still coming, its toolbar holds only the way back, over the skeleton and then over Could not load PDF, and the whole toolbar returns once it comes",
            only_start && failed_only_start && back,
            json!({
                "fetching": fetching.iter().map(|(ix, _, _)| *ix).collect::<Vec<_>>(),
                "failed": failed.iter().map(|(ix, _, _)| *ix).collect::<Vec<_>>(),
                "back": back,
            }),
        );
        Ok(())
    }
}
