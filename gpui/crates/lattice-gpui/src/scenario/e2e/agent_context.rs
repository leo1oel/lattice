//! What the Agent is told of the window beyond the source editor
//! (`agent/host_context.rs`, `shell/agent_context.rs`), its turn
//! (`shell/agent_turn.rs`) and Lattice's own writes (`agent/host_writes.rs`):
//!
//! - the compiled PDF's page and page count reach the Agent's context;
//! - text selected in the PDF, with the PDF in focus, is the shared
//!   selection, on the PDF surface; back in the editor, it goes;
//! - a turn the page reports running is the window's, and its start marks
//!   Get started's Agent step; reported over, it is gone;
//! - an editor's save is reported to the Agent as Lattice's own write.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Focusable as _};
use serde_json::json;

use super::Steps;
use crate::{agent::SurfaceEvent, editor_panel::EditorPanelEvent, scenario::Run};

impl Run {
    pub(super) async fn agent_context(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let editor = self.open(cx, &root.join("main.tex"), Some(1))?;
        let surface = cx.update(|cx| self.shell.read(cx).agent.panel.read(cx).surface().clone());
        let workspace = |cx: &mut AsyncApp| cx.update(|cx| surface.read(cx).workspace().clone());
        self.wait_for_pdf(cx).await;
        let pages = cx.update(|cx| self.shell.read(cx).pdf().read(cx).page_count(cx));
        let placed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activeFile"] == "main.tex"
                    && workspace["pdfPage"] == 1
                    && workspace["pdfPageCount"] == json!(pages)
            })
            .await;
        steps.check(
            "the compiled PDF's page and page count reach the Agent's context",
            placed && pages > 0,
            json!({ "pages": pages, "workspace": workspace(cx) }),
        );

        // Text selected in the PDF, the PDF in focus.
        self.with_window(cx, |shell, window, cx| {
            let panel = shell.read(cx).pdf().clone();
            let view = panel.read(cx).live_view().clone();
            view.update(cx, |view, cx| view.select((0, 0), (0, 40), cx));
            let focus = panel.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
        })?;
        let shared = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activeSurface"] == "pdf"
                    && workspace["selectionSource"] == "pdf"
                    && workspace["selection"].as_str().is_some_and(|text| !text.is_empty())
            })
            .await;
        steps.check(
            "text selected in the PDF is the Agent's selection, on the PDF surface",
            shared,
            json!({ "workspace": workspace(cx) }),
        );
        self.with_window(cx, |_, window, cx| {
            let focus = editor.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
        })?;
        let back = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activeSurface"] == "editor" && workspace.get("selectionSource").is_none()
            })
            .await;
        steps.check(
            "back in the editor, the PDF's selection goes from the Agent's context",
            back,
            json!({ "workspace": workspace(cx) }),
        );
        self.with_window(cx, |shell, _, cx| {
            let view = shell.read(cx).pdf().read(cx).live_view().clone();
            view.update(cx, |view, cx| view.select((0, 0), (0, 0), cx));
        })?;

        // The panel's turn, as its page reports it.
        let presence = json!({ "state": "running", "threadId": "t", "decks": [] });
        cx.update(|cx| {
            surface.update(cx, |_, cx| {
                cx.emit(SurfaceEvent::Turn(Some(presence)));
                cx.emit(SurfaceEvent::TurnStarted);
            })
        });
        self.pause(cx, Duration::from_millis(100)).await;
        let (running, marked) = cx.update(|cx| {
            (
                self.shell.read(cx).agent_turn_running(),
                crate::get_started::progress::global_read(cx)
                    .is_some_and(|progress| progress.is_done(crate::get_started::Step::Agent)),
            )
        });
        cx.update(|cx| surface.update(cx, |_, cx| cx.emit(SurfaceEvent::Turn(None))));
        self.pause(cx, Duration::from_millis(100)).await;
        let over = cx.update(|cx| !self.shell.read(cx).agent_turn_running());
        steps.check(
            "a running turn is the window's until the page reports it over, and its start marks Get started's Agent step",
            running && marked && over,
            json!({ "running": running, "marked": marked, "over": over }),
        );

        // The writer's save, beside a turn.
        cx.update(|cx| editor.update(cx, |_, cx| cx.emit(EditorPanelEvent::Saved)));
        self.pause(cx, Duration::from_millis(100)).await;
        let writes: Vec<String> = cx.update(|cx| surface.read(cx).host_writes().cloned().collect());
        steps.check(
            "an editor's save is reported to the Agent as Lattice's own write",
            writes.iter().any(|path| path == "main.tex"),
            json!({ "writes": writes }),
        );
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 31,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/agent/host_context.rs",
        "gpui/crates/lattice-gpui/src/agent/host_writes.rs",
        "gpui/crates/lattice-gpui/src/shell/agent_context.rs",
        "gpui/crates/lattice-gpui/src/shell/agent_turn.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.agent_context(cx, steps, &fixture.root)),
};
