//! The keyboard between GPUI's text and an island's page whose own keyboard
//! is in a child frame (the Agent's Synara composer, the HTML preview's
//! sandboxed document), for the islands module (`islands.rs`).

#![cfg(target_os = "macos")]

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity, Focusable as _};
use serde_json::json;

use super::{Run, Steps};
use crate::{editor_panel::EditorPanel, native};

impl Run {
    /// In Split, the keyboard back and forth between the source (GPUI's text)
    /// and the page, whose own keyboard is in a child frame (the HTML
    /// preview's sandboxed document, as the Agent's Synara composer is):
    /// each native click leaves exactly one of them focused. The child
    /// frame's focus and blur never reach the main frame's bridge, so before
    /// AppKit said when the page's view took the keyboard, a click back in
    /// the page left GPUI's focus on the source, whose caret kept blinking
    /// and which took the page's ⌘V.
    pub(super) async fn keyboard_between_source_and_page(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        island: &Entity<lattice_webview::Island>,
    ) -> Result<()> {
        let Some(page) = cx.update(|cx| island.read(cx).bounds(cx)) else {
            steps.check(
                "in Split, a click moves the keyboard between the source and the page's child frame, one of them focused at a time",
                false,
                json!({ "bounds": null }),
            );
            return Ok(());
        };
        // The preview's frame posts its presses to the page, which reports
        // them to the host; the Agent's Synara frame posts none. Without them
        // only the page's view taking AppKit's keyboard can tell the host.
        self.evaluate(
            cx,
            island,
            "(() => { window.addEventListener('message', (event) => { \
             if (event.data && event.data.type === 'lattice:island-pointerdown') \
             event.stopImmediatePropagation(); }, true); return true; })()",
        )
        .await;
        let presses = cx.update(|cx| island.read(cx).stats().presses);
        let focus = |cx: &mut AsyncApp| {
            let (panel, island) = (panel.clone(), island.clone());
            self.with_window(cx, move |_, window, cx| {
                (
                    panel.read(cx).editor().focus_handle(cx).is_focused(window),
                    island.read(cx).page_focused()
                        && island.read(cx).focus_handle(cx).contains_focused(window, cx),
                )
            })
        };
        let mut rounds = Vec::new();
        for _ in 0..2 {
            native::send_click(self.native(cx)?, page.center())?;
            let in_page = self
                .wait_for(cx, Duration::from_secs(3), |_, cx| {
                    island.read(cx).page_focused()
                })
                .await;
            let at_page = focus(cx)?;
            let editor = panel.clone();
            self.with_window(cx, move |_, window, cx| {
                let handle = editor.read(cx).editor().focus_handle(cx);
                window.focus(&handle, cx);
            })?;
            let left = self
                .wait_for(cx, Duration::from_secs(3), |_, cx| {
                    !island.read(cx).page_focused()
                })
                .await;
            let at_source = focus(cx)?;
            rounds.push(json!({
                "in_page": in_page, "at_page": [at_page.0, at_page.1],
                "left": left, "at_source": [at_source.0, at_source.1],
            }));
        }
        let presses = cx.update(|cx| island.read(cx).stats().presses) - presses;
        let passed = presses == 0 && rounds.iter().all(|round| {
            round["in_page"] == true
                && round["at_page"] == json!([false, true])
                && round["left"] == true
                && round["at_source"] == json!([true, false])
        });
        steps.check(
            "in Split, a click moves the keyboard between the source and the page's child frame, one of them focused at a time",
            passed,
            json!({ "rounds": rounds, "presses_reported": presses }),
        );
        Ok(())
    }
}
