//! Keys' characters in a webview page (`lattice-webview`'s `native.rs`):
//! an arrow or End that reaches WebKit's `insertText:` as its character
//! puts nothing into the page, only the text around it lands. The islands
//! check runs it on its HTML page; the sheet and Markdown checks commit the
//! arrows' characters mid-word in theirs.

#![cfg(target_os = "macos")]

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::{Run, Steps};
use crate::native;

impl Run {
    /// An input method that answers an arrow or End with `insertText:` of
    /// the key's own character (↑ ↓ ← → are U+F700–U+F703, End U+F72B) puts
    /// nothing into the page: only the
    /// text around it lands, as in a sheet's cell, a Markdown page or the
    /// Agent's composer.
    pub(super) async fn island_function_key_text(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        island: &Entity<lattice_webview::Island>,
    ) -> Result<()> {
        let Some(bounds) = cx.update(|cx| island.read(cx).bounds(cx)) else {
            steps.check("an input method's arrow and End characters never reach the page", false, json!({}));
            return Ok(());
        };
        native::send_click(self.native(cx)?, bounds.center())?;
        let focused = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| island.read(cx).page_focused())
            .await;
        self.evaluate(
            cx,
            island,
            "(() => { const field = document.createElement('textarea'); field.id = 'e2e-ime-field'; \
             document.body.append(field); field.focus(); return document.activeElement === field; })()",
        )
        .await;
        cx.update(|cx| island.read(cx).insert_text("a\u{F700}\u{F701}b\u{F72B}", cx));
        for arrow in ["\u{F702}", "\u{F703}"] {
            cx.update(|cx| island.read(cx).insert_text(arrow, cx));
        }
        self.pause(cx, Duration::from_millis(300)).await;
        let value = self
            .evaluate(
                cx,
                island,
                "(() => { const field = document.getElementById('e2e-ime-field'); const value = field?.value ?? null; \
                 field?.remove(); return JSON.stringify(value); })()",
            )
            .await;
        steps.check(
            "an input method's arrow and End characters never reach the page: only the text around them lands",
            focused && value == "ab",
            json!({ "focused": focused, "value": value }),
        );
        Ok(())
    }

}
