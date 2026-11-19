//! Each document's PDF place, as the Tauri app keeps it in its file view
//! states (`use-file-view-states.ts`, `SavedViewState`): main.tex's live PDF
//! zoomed and scrolled is kept once it rests; when another document's build
//! takes the live PDF, main.tex's own tab opens where main.tex was left.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Modifiers, PlatformInput, ScrollDelta, ScrollEvent, TouchPhase, point, px};
use serde_json::json;

use super::Steps;
use crate::{pdf::preferences, scenario::Run};

impl Run {
    async fn pdf_places(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let live = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        let fit = cx.update(|cx| live.read(cx).fit());
        for _ in 0..4 {
            self.with_window(cx, {
                let live = live.clone();
                move |_, _, cx| live.update(cx, |view, cx| view.step_zoom(1., cx))
            })?;
        }
        self.pause(cx, Duration::from_millis(400)).await;
        let center = cx.update(|cx| live.read(cx).pages_center());
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_event(
                PlatformInput::Scroll(ScrollEvent {
                    position: center,
                    delta: ScrollDelta::Pixels(point(px(0.), px(-240.))),
                    modifiers: Modifiers::default(),
                    touch_phase: TouchPhase::Moved,
                    source: gpui::ScrollSource::Pointer,
                }),
                cx,
            );
        })?;
        // It is kept once it has rested.
        self.pause(cx, Duration::from_millis(900)).await;
        let left = cx.update(|cx| live.read(cx).view_place());
        let kept = preferences::get()
            .places
            .values()
            .find_map(|places| places.get("main.tex").copied());

        let document = root.join("place-check.tex");
        std::fs::write(
            &document,
            "\\documentclass{article}\n\\begin{document}\nAnother document.\n\\end{document}\n",
        )?;
        self.open(cx, &document, Some(3))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (built, _) = self.build(cx).await?;
        let tab = self
            .wait_for(cx, Duration::from_secs(30), |shell, cx| {
                shell
                    .read(cx)
                    .root_pdf_tabs()
                    .iter()
                    .any(|(document, panel)| {
                        document == "main.tex"
                            && panel.read(cx).live_view().read(cx).page_count() > 0
                    })
            })
            .await;
        self.pause(cx, Duration::from_millis(500)).await;
        let reopened = cx.update(|cx| {
            self.shell
                .read(cx)
                .root_pdf_tabs()
                .into_iter()
                .find(|(document, _)| document == "main.tex")
                .map(|(_, panel)| panel.read(cx).live_view().read(cx).view_place())
        });
        let same = |a: &crate::pdf::ViewPlace, b: &crate::pdf::ViewPlace| {
            a.page == b.page
                && (a.scale - b.scale).abs() < 0.01
                && a.top.0 == b.top.0
                && (a.top.2 - b.top.2).abs() < 2.
        };
        steps.check(
            "PDF: each document's place is kept, and its own tab opens where it was left",
            kept.as_ref().is_some_and(|kept| same(kept, &left))
                && left.top.2 > 1.
                && built
                && tab
                && reopened
                    .as_ref()
                    .is_some_and(|reopened| same(reopened, &left)),
            json!({
                "left": format!("{left:?}"),
                "kept": format!("{kept:?}"),
                "built": built,
                "tab": tab,
                "reopened": format!("{reopened:?}"),
            }),
        );

        // main.tex built again takes the live PDF back, at the fit it had.
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.build(cx).await?;
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| {
            shell.read(cx).live_document() == Some("main.tex")
        })
        .await;
        if let Some(mode) = fit {
            self.with_window(cx, move |_, _, cx| {
                live.update(cx, |view, cx| {
                    if view.fit() != Some(mode) {
                        view.apply_fit(mode, cx);
                    }
                })
            })?;
        }
        std::fs::remove_file(&document).ok();
        Ok(())
    }
}

/// This file's registration as the e2e module `pdf_places`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 45,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/pdf/view/place.rs",
        "gpui/crates/lattice-gpui/src/pdf/preferences.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.pdf_places(cx, steps, &fixture.root)),
};
