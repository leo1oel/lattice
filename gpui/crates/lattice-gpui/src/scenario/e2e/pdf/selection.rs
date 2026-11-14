//! Selecting the PDF's text with native drags and copying it.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::{native, scenario::Run};

impl Run {
    pub(super) async fn select_and_copy(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.wait_view(cx, 10, |view, _| view.page_text(0).is_some())
            .await;
        let (text, page, drawn) = cx.update(|cx| {
            let view = self.live_view_of(cx).read(cx);
            (view.page_text(0), view.current_page(), view.stats().clone())
        });
        let Some(text) = text else {
            let drawing = self.drawing(cx).await;
            steps.check(
                "PDF: a drag selects text and ⌘C / Ctrl+C copies it",
                false,
                json!({
                    "text_read": false,
                    "page": page,
                    "stats": format!("{drawn:?}"),
                    "drawing": drawing,
                }),
            );
            return Ok(());
        };
        let chars: String = text.chars.iter().map(|ch| ch.ch).collect();
        let sentence = "Selectable sentence here.";
        let start = chars
            .find(sentence)
            .map(|byte| chars[..byte].chars().count())
            .context("the sentence is not on page 1")?;
        let end = start + sentence.chars().count() - 1;
        let (first, last) = (text.chars[start], text.chars[end]);
        let points = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (
                view.window_point(0, first.x0 + 0.5, (first.y0 + first.y1) / 2.),
                view.window_point(0, last.x1 - 0.5, (last.y0 + last.y1) / 2.),
            )
        });
        let (Some(from), Some(to)) = points else {
            steps.check(
                "PDF: a drag selects text and ⌘C / Ctrl+C copies it",
                false,
                json!({}),
            );
            return Ok(());
        };
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Down, from)?;
        crate::scenario::sleep(cx, Duration::from_millis(40)).await;
        for step in 1..=8 {
            let t = step as f32 / 8.;
            let point = gpui::point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
            native::send_mouse(native, native::Mouse::Dragged, point)?;
            crate::scenario::sleep(cx, Duration::from_millis(20)).await;
        }
        native::send_mouse(native, native::Mouse::Up, to)?;
        self.pause(cx, Duration::from_millis(200)).await;
        let selected = cx.update(|cx| self.live_view_of(cx).read(cx).has_selection());
        self.press(cx, 'c', true).await?;
        let copied = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                cx.read_from_clipboard()
                    .and_then(|item| item.text())
                    .is_some_and(|text| text == sentence)
            })
            .await;
        let clipboard = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
        steps.check(
            "PDF: a drag selects text and ⌘C / Ctrl+C copies it",
            selected && copied,
            json!({ "selected": selected, "clipboard": clipboard }),
        );
        Ok(())
    }
}
