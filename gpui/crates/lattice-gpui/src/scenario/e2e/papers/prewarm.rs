//! Papers' hover prewarm (`prewarmLikelyPaper` in `use-preview-prewarm.ts`):
//! the pointer resting on a readable paper's row readies the text that
//! paper opens with, outside the dock, and the click that follows opens it
//! in the reader with that very editor.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity, EntityId};
use serde_json::json;

use super::super::Steps;
use crate::{native, papers::PapersPanel, scenario::Run};

impl Run {
    /// Rest the pointer on `title`'s row; the editor readied for its text.
    pub(super) async fn papers_prewarm(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &Entity<PapersPanel>,
        title: &str,
        reading: &str,
    ) -> Result<Option<EntityId>> {
        let row = cx.update(|cx| papers.read(cx).row_bounds(title, cx));
        let Some(row) = row else {
            steps.check(
                "resting the pointer on a saved paper's row readies its text",
                false,
                json!({ "row": false }),
            );
            return Ok(None);
        };
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Moved, row.center())?;
        let readied = |shell: &Entity<crate::shell::Shell>, cx: &gpui::App| {
            shell
                .read(cx)
                .prewarmed()
                .iter()
                .find(|editor| editor.read(cx).path().ends_with(reading))
                .map(|editor| editor.entity_id())
        };
        let warmed = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                readied(shell, cx).is_some()
            })
            .await;
        let warmed = warmed
            .then(|| cx.update(|cx| readied(&self.shell, cx)))
            .flatten();
        // Readied outside the dock: no tab, and not one of the open editors.
        let path = cx
            .update(|cx| self.shell.read(cx).root(cx))
            .map(|root| root.join(reading));
        let outside = match &path {
            Some(path) => cx.update(|cx| {
                self.shell
                    .update(cx, |shell, cx| shell.open_editor(path, cx).is_none())
            }),
            None => false,
        };
        steps.check(
            "resting the pointer on a saved paper's row readies its text outside the dock",
            warmed.is_some() && outside,
            json!({ "warmed": warmed.is_some(), "outside": outside }),
        );
        Ok(warmed)
    }
}
