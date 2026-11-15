//! What the Agent is told of a paper in its reader (`shell/agent_context.rs`,
//! `useAgentContext`'s `activePaper`), on a saved paper written into the
//! scratch copy as an import leaves one:
//!
//! - the paper open in its reader is the Agent's active paper, on the paper
//!   surface, with the text it shows and that text's reading file;
//! - it stays so while the keyboard moves to the Agent's own panel;
//! - text selected on the reading page is the paper's selection;
//! - back in the source editor, the paper goes and the editor is in front.
//!
//! The bibliography and the bundle are put back afterwards.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Focusable as _};
use serde_json::{Value, json};

use super::Steps;
use crate::scenario::Run;

const BUNDLE: &str = ".research/papers/1706.03762";
const ENTRY: &str = "\n@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  author = {Vaswani, Ashish and Shazeer, Noam},\n  journal = {NeurIPS},\n  year = {2017},\n  eprint = {1706.03762}\n}\n";
const PAPER: &str = "---\ntitle: Attention Is All You Need\n---\n\n# Attention Is All You Need\n\nWe call our particular attention scaled dot-product attention.\n";
const SELECTED: &str = "scaled dot-product attention";

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
        let editor = self.open(cx, &root.join("main.tex"), Some(1)).unwrap_or(editor);
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
