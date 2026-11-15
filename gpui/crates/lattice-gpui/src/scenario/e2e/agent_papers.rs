//! What the Agent is told of a paper in its reader (`shell/agent_context.rs`,
//! `useAgentContext`'s `activePaper`), on a saved paper written into the
//! scratch copy as an import leaves one:
//!
//! - the paper open in its reader is the Agent's active paper, on the paper
//!   surface, with the text it shows and that text's reading file;
//! - it stays so while the keyboard moves to the Agent's own panel;
//! - text selected on the reading page is the paper's selection;
//! - back in the source editor, the paper goes and the editor is in front;
//! - an image focused after the paper is in front instead, on the editor
//!   surface;
//! - its reader closed while the keyboard is in the Agent's panel, the
//!   paper goes.
//!
//! The bibliography and the bundle are put back afterwards.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Focusable as _};
use serde_json::{Value, json};

use super::Steps;
use crate::{scenario::Run, shell::trellis_layout::file_key};

const BUNDLE: &str = ".research/papers/1706.03762";
const ENTRY: &str = "\n@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  author = {Vaswani, Ashish and Shazeer, Noam},\n  journal = {NeurIPS},\n  year = {2017},\n  eprint = {1706.03762}\n}\n";
const PAPER: &str = "---\ntitle: Attention Is All You Need\n---\n\n# Attention Is All You Need\n\nWe call our particular attention scaled dot-product attention.\n";
const SELECTED: &str = "scaled dot-product attention";
const FIGURE: &str = "paper-figure.png";

impl Run {
    pub(super) async fn agent_papers(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let bibliography = root.join("references.bib");
        let original = std::fs::read_to_string(&bibliography)
            .context("the e2e project needs references.bib")?;
        std::fs::create_dir_all(root.join(BUNDLE))?;
        std::fs::write(root.join(BUNDLE).join("paper.md"), PAPER)?;
        std::fs::write(&bibliography, format!("{original}{ENTRY}"))?;
        let outcome = self.agent_papers_steps(cx, steps, root).await;
        std::fs::write(&bibliography, original)?;
        std::fs::remove_dir_all(root.join(BUNDLE))?;
        let _ = std::fs::remove_file(root.join(FIGURE));
        outcome
    }

    async fn agent_papers_steps(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let editor = self.open(cx, &root.join("main.tex"), Some(1))?;
        let surface = cx.update(|cx| self.shell.read(cx).agent.panel.read(cx).surface().clone());
        let workspace = |cx: &mut AsyncApp| cx.update(|cx| surface.read(cx).workspace().clone());
        let papers = cx.update(|cx| self.shell.read(cx).papers().clone());
        cx.update(|cx| papers.update(cx, |papers, cx| papers.reload(cx)));
        let listed = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                papers
                    .read(cx)
                    .papers
                    .iter()
                    .any(|paper| paper.arxiv_id == "1706.03762" && paper.has_full_text)
            })
            .await;
        let opened = listed
            && self.with_window(cx, |_, window, cx| {
                papers.update(cx, |panel, cx| {
                    panel.open_titled("Attention Is All You Need", window, cx)
                })
            })?;
        let reading = format!("{BUNDLE}/paper.md");
        let in_front = |workspace: &Value| {
            workspace["activePaper"]["arxivId"] == "1706.03762"
                && workspace["activeSurface"] == "paper"
                && workspace["paperView"] == "fulltext"
                && workspace["activeFile"] == json!(reading)
        };
        let told = opened
            && self
                .wait_for(cx, Duration::from_secs(10), |_, cx| {
                    in_front(surface.read(cx).workspace())
                })
                .await;
        steps.check(
            "a paper open in its reader is the Agent's active paper, with the text it shows",
            told,
            json!({ "listed": listed, "opened": opened, "workspace": workspace(cx) }),
        );
        if !told {
            return Ok(());
        }

        // The keyboard moves to the Agent's panel: the paper stays in front.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("agent", true, window, cx));
            if let Some(focus) = surface.read(cx).focus_handle(cx) {
                window.focus(&focus, cx);
            }
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let kept = in_front(&workspace(cx));
        steps.check(
            "the paper stays the Agent's while the keyboard is in the Agent's panel",
            kept,
            json!({ "workspace": workspace(cx) }),
        );

        // A selection on the reading page is the paper's.
        let island = cx.update(|cx| {
            self.shell
                .read(cx)
                .front_reader_panel(cx)
                .and_then(|reader| reader.read(cx).editor().cloned())
                .and_then(|editor| editor.read(cx).markdown_document().cloned())
                .and_then(|document| document.read(cx).island().cloned())
        });
        let mut posted = Value::Null;
        if let Some(island) = &island {
            let script = format!(
                "(() => {{ window.latticeHost?.post('md:selection', {{ text: {} }}); return true; }})()",
                json!(SELECTED)
            );
            posted = self.evaluate(cx, island, &script).await;
        }
        let selected = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["selectionSource"] == "paper" && workspace["selection"] == SELECTED
            })
            .await;
        steps.check(
            "text selected on the reading page is the paper's selection",
            selected,
            json!({ "posted": posted, "workspace": workspace(cx) }),
        );

        // Back in the source editor, the editor is in front.
        let editor = self
            .open(cx, &root.join("main.tex"), Some(1))
            .unwrap_or(editor);
        self.with_window(cx, |_, window, cx| {
            let focus = editor.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
        })?;
        let back = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activePaper"].is_null()
                    && workspace["activeSurface"] == "editor"
                    && workspace["activeFile"] == "main.tex"
            })
            .await;
        steps.check(
            "back in the source editor, the paper goes and the editor is in front",
            back,
            json!({ "workspace": workspace(cx) }),
        );

        // The paper again, then an image takes the keyboard: the image is
        // in front instead.
        let reopened = self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| {
                panel.open_titled("Attention Is All You Need", window, cx)
            })
        })? && self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                in_front(surface.read(cx).workspace())
            })
            .await;
        let figure = root.join(FIGURE);
        image::RgbaImage::from_pixel(4, 4, image::Rgba([40, 80, 160, 255]))
            .save_with_format(&figure, image::ImageFormat::Png)?;
        self.with_window(cx, move |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_path(figure, None, window, cx);
                let doc = shell.document(cx);
                let image = doc
                    .views
                    .iter()
                    .find(|(_, record)| file_key(Some(record)) == FIGURE)
                    .map(|(id, _)| id.clone());
                if let Some(image) = image {
                    shell.engine_do(cx, |engine| engine.focus(&image));
                    shell.focus_view_content(&image, window, cx);
                }
            })
        })?;
        let image_front = reopened
            && self
                .wait_for(cx, Duration::from_secs(5), |_, cx| {
                    let workspace = surface.read(cx).workspace();
                    workspace["activePaper"].is_null()
                        && workspace["activeSurface"] == "editor"
                        && workspace["activeFile"] == FIGURE
                })
                .await;
        steps.check(
            "an image focused after the paper is the Agent's front instead, on the editor surface",
            image_front,
            json!({ "reopened": reopened, "workspace": workspace(cx) }),
        );

        // The paper again, the keyboard in the Agent's panel (where it would
        // otherwise stay in front), then its reader closes: the paper goes.
        let again = self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| {
                panel.open_titled("Attention Is All You Need", window, cx)
            })
        })? && self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                in_front(surface.read(cx).workspace())
            })
            .await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("agent", true, window, cx));
            if let Some(focus) = surface.read(cx).focus_handle(cx) {
                window.focus(&focus, cx);
            }
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let kept_before_close = in_front(&workspace(cx));
        let closed = self.with_window(cx, |shell, _, cx| {
            let view = shell
                .read(cx)
                .front_reader_panel(cx)
                .and_then(|reader| shell.read(cx).view_of_panel(reader.entity_id()));
            let workspace = shell.read(cx).workspace().clone();
            view.inspect(|view| {
                workspace.update(cx, |workspace, cx| workspace.close(&[view.clone()], cx));
            })
            .is_some()
        })?;
        let gone = again
            && kept_before_close
            && closed
            && self
                .wait_for(cx, Duration::from_secs(5), |_, cx| {
                    let workspace = surface.read(cx).workspace();
                    // `buildAgentHostContext` names the paper surface only
                    // with an active paper; without one, any surface but
                    // the PDF is the editor's, so a lingering "paper" here
                    // reaches the Agent as "editor".
                    workspace["activePaper"].is_null()
                        && workspace["activeFile"] != json!(reading)
                        && workspace["activeSurface"] != "pdf"
                })
                .await;
        steps.check(
            "closing the paper's reader while the keyboard is in the Agent's panel takes the paper from the Agent's context",
            gone,
            json!({ "again": again, "kept_before_close": kept_before_close, "closed": closed, "workspace": workspace(cx) }),
        );
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 33,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/agent/host_context.rs",
        "gpui/crates/lattice-gpui/src/shell/agent_context.rs",
        "gpui/crates/lattice-gpui/src/papers/reader.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.agent_papers(cx, steps, &fixture.root)),
};
