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
        self.keyboard_between_islands(cx, steps, panel, island, page)
            .await
    }

    /// Native clicks from the Agent's page (a child frame given its own
    /// keyboard, as Synara's composer is) to the preview's, back, and on to
    /// the source: each click leaves the keyboard, AppKit's and GPUI's, with
    /// what was clicked alone. An island losing GPUI's focus gave AppKit's
    /// first responder back to GPUI's view even when another page's view had
    /// just taken it, so the page clicked into looked focused to GPUI while
    /// its keys went nowhere.
    async fn keyboard_between_islands(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        preview: &Entity<lattice_webview::Island>,
        preview_bounds: gpui::Bounds<gpui::Pixels>,
    ) -> Result<()> {
        const STEP: &str = "native clicks from the Agent's child frame to the preview's, back, and to the source leave the keyboard, AppKit's and GPUI's, with what was clicked alone";
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("agent", true, window, cx))
        })?;
        let surface = cx.update(|cx| self.shell.read(cx).agent.panel.read(cx).surface().clone());
        let agent = cx.update(|cx| surface.read(cx).island().cloned());
        let drawn = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                surface.read(cx).is_drawn()
            })
            .await;
        let agent_bounds = agent
            .as_ref()
            .and_then(|agent| cx.update(|cx| agent.read(cx).bounds(cx)));
        let preview_now = cx.update(|cx| preview.read(cx).bounds(cx));
        let (Some(agent), Some(agent_bounds), Some(preview_bounds), true) =
            (agent, agent_bounds, preview_now.or(Some(preview_bounds)), drawn)
        else {
            steps.check(STEP, false, json!({ "drawn": drawn, "agent_bounds": format!("{agent_bounds:?}") }));
            return Ok(());
        };
        // A frame of the page's own origin, over it, with a field, whose
        // presses and focus the page's main frame never hears of.
        let framed = self
            .evaluate(
                cx,
                &agent,
                "(() => { const f = document.createElement('iframe'); \
                 f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:white'; \
                 document.body.append(f); \
                 f.contentDocument.body.innerHTML = '<textarea style=\"width:90%;height:90%\"></textarea>'; \
                 return true; })()",
            )
            .await;
        let state = |cx: &mut AsyncApp| {
            let (panel, agent, preview) = (panel.clone(), agent.clone(), preview.clone());
            self.with_window(cx, move |_, window, cx| {
                let island = |island: &Entity<lattice_webview::Island>| {
                    let read = island.read(cx);
                    json!({
                        "page_focused": read.page_focused(),
                        "gpui_focus": read.focus_handle(cx).contains_focused(window, cx),
                        "appkit": read.holds_keyboard(cx),
                    })
                };
                json!({
                    "source": panel.read(cx).editor().focus_handle(cx).is_focused(window),
                    "agent": island(&agent),
                    "preview": island(&preview),
                })
            })
        };
        let owner = |state: &serde_json::Value, owner: &str| {
            let alone = |name: &str| {
                let focused = name == owner;
                ["page_focused", "gpui_focus", "appkit"]
                    .iter()
                    .all(|key| state[name][key] == focused)
            };
            state["source"] == (owner == "source") && alone("agent") && alone("preview")
        };
        let source_point = gpui::point(
            preview_bounds.left() - gpui::px(120.),
            preview_bounds.center().y,
        );
        let mut seen = Vec::new();
        for (owner_name, at) in [
            ("agent", agent_bounds.center()),
            ("preview", preview_bounds.center()),
            ("agent", agent_bounds.center()),
            ("source", source_point),
        ] {
            native::send_click(self.native(cx)?, at)?;
            self.pause(cx, Duration::from_millis(600)).await;
            let now = state(cx)?;
            seen.push(json!({ "clicked": owner_name, "ok": owner(&now, owner_name), "state": now }));
        }
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("agent", false, window, cx))
        })?;
        let passed = framed == true && seen.iter().all(|round| round["ok"] == true);
        steps.check(STEP, passed, json!({ "framed": framed, "rounds": seen }));
        Ok(())
    }
}
