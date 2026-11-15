//! The PDF toolbar's page value, end to end: a page number typed into it
//! and Enter go there, and Escape drops a draft.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::{pdf::FitMode, scenario::Run};

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
        self.page_keys(cx, steps).await
    }

    /// The Tauri page field's `accept: /^\d*$/`, its zoom field without
    /// `cancelOnEscape`, and WebKit's ⌘↑/⌘↓: a letter typed into the page
    /// value is dropped, so "x3" and Enter go to page 3; a zoom typed and
    /// left with Escape is kept at that percentage of 100%; ⌘↓ shows the
    /// last page and ⌘↑ the first.
    async fn page_keys(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let fit = cx.update(|cx| self.live_view_of(cx).read(cx).fit());
        self.with_view(cx, |view, window, cx| view.edit_draft_to(false, "", window, cx))?;
        self.pause(cx, Duration::from_millis(200)).await;
        for key in ['x', '3', '\n'] {
            self.press(cx, key, false).await?;
        }
        let digits = self.wait_view(cx, 5, |view, _| view.current_page() == 2).await;

        self.with_view(cx, |view, window, cx| view.edit_draft_to(true, "100", window, cx))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let hundred = cx.update(|cx| self.live_view_of(cx).read(cx).scale());
        self.with_view(cx, |view, window, cx| view.edit_draft_to(true, "150", window, cx))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.press(cx, '\u{1b}', false).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let kept = cx.update(|cx| self.live_view_of(cx).read(cx).scale());
        let zoom_kept = (kept - hundred * 1.5).abs() < 0.01 * hundred;

        let (mut reached_last, mut pages) = (false, 0);
        let view = self.live_view(cx);
        for keys in ["cmd-down", "cmd-up"] {
            let target = view.clone();
            self.with_window(cx, move |_, window, cx| {
                window.focus(&gpui::Focusable::focus_handle(target.read(cx), cx), cx);
                window.dispatch_keystroke(gpui::Keystroke::parse(keys).expect("a key"), cx);
            })?;
            self.pause(cx, Duration::from_millis(400)).await;
            if keys == "cmd-down" {
                let count = cx.update(|cx| view.read(cx).page_count());
                reached_last = self
                    .wait_view(cx, 5, move |view, _| view.current_page() + 1 == count)
                    .await;
                pages = count;
            }
        }
        let first = self.wait_view(cx, 5, |view, _| view.current_page() == 0).await;
        steps.check(
            "PDF: the page value takes digits only, Escape keeps a typed zoom, and ⌘↓/⌘↑ go to the last and first page",
            digits && zoom_kept && reached_last && first,
            json!({
                "digits_only": digits,
                "hundred": hundred,
                "escape_scale": kept,
                "zoom_kept": zoom_kept,
                "pages": pages,
                "last": reached_last,
                "first": first,
            }),
        );
        // Back to how the checks after found it.
        if let Some(fit) = fit {
            self.with_view(cx, move |view, _, cx| view.toggle_fit(fit, cx))?;
        }
        self.with_view(cx, |view, _, cx| view.go_to_page(6, cx))?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }
}
