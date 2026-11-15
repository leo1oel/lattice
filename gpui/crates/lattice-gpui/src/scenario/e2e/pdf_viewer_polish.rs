//! The PDF viewer's details: a PDF on its way (`pdf-loading.tsx`) shows a
//! skeleton of its page on a first load and "Updating…" over the pages on
//! a refresh, never the skeleton over them; and a middle press on the pages
//! scrolls them towards the pointer until a press stops it
//! (`use-pdf-autoscroll.ts`).

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

impl Run {
    async fn pdf_viewer_polish(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let copy = root.join("loading-check.pdf");
        std::fs::copy(root.join("main.pdf"), &copy)?;
        // The tab opens and starts reading the file in the same turn.
        self.open(cx, &copy, None).ok();
        let tab = cx.update(|cx| self.shell.read(cx).file_pdf_tabs().into_iter().find(|tab| {
            tab.read(cx).source() == Some(copy.as_path())
        }));
        let indicator = |cx: &mut AsyncApp| {
            tab.as_ref().and_then(|tab| cx.update(|cx| tab.read(cx).live_view().read(cx).loading_indicator()))
        };
        let first = indicator(cx);
        let loaded = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                tab.as_ref().is_some_and(|tab| {
                    let view = tab.read(cx).live_view().read(cx);
                    view.loading_indicator().is_none() && view.page_count() > 0
                })
            })
            .await;
        // The same file again: the pages stay while it is read.
        let refresh = match &tab {
            Some(tab) => {
                let view = cx.update(|cx| tab.read(cx).live_view().clone());
                self.with_window(cx, move |_, window, cx| {
                    view.update(cx, |view, cx| view.open(copy.clone(), window, cx))
                })?;
                indicator(cx)
            }
            None => None,
        };
        steps.check(
            "PDF: a first load shows the page's skeleton, and a refresh of the PDF on screen says Updating… over it",
            first == Some("skeleton") && loaded && refresh == Some("updating"),
            json!({ "tab": tab.is_some(), "first": first, "loaded": loaded, "refresh": refresh }),
        );
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            tab.as_ref().is_none_or(|tab| tab.read(cx).live_view().read(cx).loading_indicator().is_none())
        })
        .await;
        std::fs::remove_file(root.join("loading-check.pdf")).ok();
        self.middle_autoscroll(cx, steps).await
    }

    /// Zoomed in so the page scrolls, a middle press starts autoscroll, the
    /// pointer below the press scrolls the pages down, and a left press
    /// stops it without selecting or following anything.
    async fn middle_autoscroll(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        use gpui::{Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput, point, px};
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        let fit = cx.update(|cx| view.read(cx).fit());
        for _ in 0..6 {
            self.with_window(cx, {
                let view = view.clone();
                move |_, _, cx| view.update(cx, |view, cx| view.step_zoom(1., cx))
            })?;
        }
        self.pause(cx, Duration::from_millis(400)).await;
        let center = cx.update(|cx| view.read(cx).pages_center());
        let send = |cx: &mut AsyncApp, input: PlatformInput| {
            self.with_window(cx, move |_, window, cx| {
                window.dispatch_event(input, cx);
            })
        };
        send(cx, PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Middle,
            position: center,
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        }))?;
        send(cx, PlatformInput::MouseUp(MouseUpEvent {
            button: MouseButton::Middle,
            position: center,
            modifiers: Modifiers::default(),
            click_count: 1,
        }))?;
        let started = cx.update(|cx| view.read(cx).autoscrolling());
        let before = cx.update(|cx| view.read(cx).scroll_top());
        send(cx, PlatformInput::MouseMove(MouseMoveEvent {
            position: point(center.x, center.y + px(120.)),
            pressed_button: None,
            modifiers: Modifiers::default(),
        }))?;
        self.pause(cx, Duration::from_millis(500)).await;
        let moved = cx.update(|cx| view.read(cx).scroll_top());
        send(cx, PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Left,
            position: center,
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        }))?;
        send(cx, PlatformInput::MouseUp(MouseUpEvent {
            button: MouseButton::Left,
            position: center,
            modifiers: Modifiers::default(),
            click_count: 1,
        }))?;
        let stopped = cx.update(|cx| !view.read(cx).autoscrolling());
        let at_stop = cx.update(|cx| view.read(cx).scroll_top());
        self.pause(cx, Duration::from_millis(300)).await;
        let after = cx.update(|cx| view.read(cx).scroll_top());
        steps.check(
            "PDF: a middle press scrolls the pages towards the pointer, and a press stops it",
            started && moved > before + 20. && stopped && (after - at_stop).abs() < 0.5,
            json!({ "started": started, "before": before, "moved": moved, "stopped": stopped, "at_stop": at_stop, "after": after }),
        );
        // The fit it had, for the modules after this one.
        if let Some(mode) = fit {
            self.with_window(cx, move |_, _, cx| view.update(cx, |view, cx| view.toggle_fit(mode, cx)))?;
            self.pause(cx, Duration::from_millis(300)).await;
        }
        Ok(())
    }
}

/// This file's registration as the e2e module `pdf_viewer_polish`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 40,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/pdf/loading.rs",
        "gpui/crates/lattice-gpui/src/pdf/view/autoscroll.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.pdf_viewer_polish(cx, steps, &fixture.root)),
};
