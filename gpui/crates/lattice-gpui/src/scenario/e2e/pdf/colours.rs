//! The pages' colours, end to end: Dark pages draws every page dark and
//! back.

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::scenario::Run;

impl Run {
    pub(super) async fn dark_pages(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_view(cx, |view, _, cx| view.toggle_dark_pages(cx))?;
        let dark = self
            .wait_view(cx, 10, |view, _| {
                view.dark_pages() && view.images_follow_dark_pages()
            })
            .await;
        self.with_view(cx, |view, _, cx| view.toggle_dark_pages(cx))?;
        let light = self
            .wait_view(cx, 10, |view, _| {
                !view.dark_pages() && view.images_follow_dark_pages()
            })
            .await;
        steps.check(
            "PDF: Dark pages draws the pages dark, and back",
            dark && light,
            json!({ "dark": dark, "light": light }),
        );
        Ok(())
    }
}
