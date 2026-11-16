//! Add papers' batch, offline (pasted BibTeX entries resolve without a
//! lookup): six references added at once are imported a few at a time,
//! never more than four under way (`ADDS_AT_ONCE`), and every one lands in
//! the bibliography; and an arXiv paper pasted three ways (its id, its
//! abstract page and its arXiv DOI) makes one card.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::super::Steps;
use crate::{
    papers::{PapersPanel, batch::ItemState},
    scenario::Run,
};

/// Six offline entries, each its own key.
fn entries() -> Vec<(String, String)> {
    (1..=6)
        .map(|n| {
            let key = format!("e2ebatchparallel{n}2024");
            let entry = format!(
                "@article{{{key},\n  title = {{Parallel Batch Paper {n}}},\n  author = {{Writer, Ada}},\n  journal = {{Journal of Tests}},\n  year = {{2024}}\n}}\n"
            );
            (key, entry)
        })
        .collect()
}

impl Run {
    pub(super) async fn papers_batch_add(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &Entity<PapersPanel>,
    ) -> Result<()> {
        let root = cx
            .update(|cx| self.shell.read(cx).root(cx))
            .ok_or_else(|| anyhow::anyhow!("the Papers e2e needs a project"))?;
        let manifest =
            lattice_core::project::read_manifest(&root).map_err(|error| anyhow::anyhow!(error))?;
        let bibliography = root.join(manifest.primary_bibliography);
        let original = std::fs::read_to_string(&bibliography)?;
        let sheet = self.open_add_papers(cx).await?;

        // The same arXiv paper three ways is one card.
        let same =
            "arXiv:1706.03762\nhttps://arxiv.org/abs/1706.03762v5\n10.48550/arXiv.1706.03762\n";
        let pasted = sheet.clone();
        self.with_window(cx, move |_, window, cx| {
            pasted.update(cx, |sheet, cx| sheet.paste(same, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let cards = cx.update(|cx| sheet.read(cx).row_states(cx).len());
        steps.check(
            "an arXiv paper pasted as its id, its abstract page and its arXiv DOI makes one card",
            cards == 1,
            json!({ "cards": cards }),
        );

        // Six offline entries, added at once.
        let sheet = self.open_add_papers(cx).await?;
        let entries = entries();
        let text: String = entries.iter().map(|(_, entry)| entry.as_str()).collect();
        let pasted = sheet.clone();
        self.with_window(cx, move |_, window, cx| {
            pasted.update(cx, |sheet, cx| sheet.paste(&text, window, cx))
        })?;
        let listed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                sheet.read(cx).row_states(cx).len() == 6
            })
            .await;
        let adder = sheet.clone();
        cx.update(|cx| adder.update(cx, |sheet, cx| sheet.add(cx)));
        let mut most = 0;
        let started = std::time::Instant::now();
        let landed = loop {
            let (under_way, running, added) = cx.update(|cx| {
                let batch = &papers.read(cx).batch;
                (
                    batch.under_way(),
                    batch.running,
                    batch
                        .items
                        .iter()
                        .filter(|item| item.state == ItemState::Added)
                        .count(),
                )
            });
            most = most.max(under_way);
            if !running && added == 6 {
                break true;
            }
            if started.elapsed() > Duration::from_secs(30) {
                break false;
            }
            self.pause(cx, Duration::from_millis(20)).await;
        };
        let written = std::fs::read_to_string(&bibliography).unwrap_or_default();
        let keys = entries
            .iter()
            .filter(|(key, _)| written.contains(key.as_str()))
            .count();
        steps.check(
            "six papers added at once are imported at most four at a time, and all six land in the bibliography",
            listed && landed && (1..=4).contains(&most) && keys == 6,
            json!({ "listed": listed, "landed": landed, "most_at_once": most, "keys_written": keys }),
        );

        // The steps after these find the bibliography as it was.
        std::fs::write(&bibliography, original)?;
        cx.update(|cx| papers.update(cx, |panel, cx| panel.reload(cx)));
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        Ok(())
    }

    /// Add papers opened afresh, from the palette's Research row.
    async fn open_add_papers(
        &self,
        cx: &mut AsyncApp,
    ) -> Result<Entity<crate::papers::add_sheet::AddPapers>> {
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx));
            window.dispatch_action(Box::new(crate::shell::research_flow::AddPapers), cx)
        })?;
        self.wait_for(cx, Duration::from_secs(5), |shell, cx| {
            shell.read(cx).add_papers().is_some()
        })
        .await;
        cx.update(|cx| self.shell.read(cx).add_papers().cloned())
            .ok_or_else(|| anyhow::anyhow!("Add papers did not open"))
    }
}
