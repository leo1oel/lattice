//! The PDF toolbar's page value, end to end: a page number typed into it
//! and Enter go there, and Escape drops a draft.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::scenario::Run;

impl Run {
    /// The page value: clicked, a number typed and Enter goes there; Escape
    /// drops a draft.
    pub(super) async fn page_draft(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_view(cx, |view, window, cx| {
            view.edit_draft_to(false, "7", window, cx)
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.press(cx, '\n', false).await?;
        let went = self
            .wait_view(cx, 5, |view, _| view.current_page() == 6)
            .await;
        self.with_view(cx, |view, window, cx| {
            view.edit_draft_to(false, "2", window, cx)
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.press(cx, '\u{1b}', false).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let stayed = cx.update(|cx| self.live_view_of(cx).read(cx).current_page()) == 6;
        let mut detail = json!({ "went": went, "stayed": stayed });
        if !(went && stayed) {
            detail["drawing"] = self.drawing(cx).await;
        }
        steps.check(
            "PDF: a page number typed into the page value and Enter go there, and Escape drops a draft",
            went && stayed,
            detail,
        );
        Ok(())
    }
}
