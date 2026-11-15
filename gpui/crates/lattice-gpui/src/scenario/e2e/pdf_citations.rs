//! A citation's card over its link in the compiled PDF
//! (`pdf-citation-hover.tsx`): a document built with hyperref cites the
//! fixture's `knuth1984`; the pointer resting on the citation link opens
//! the entry's card after its delay, and leaving the link closes it.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

impl Run {
    async fn pdf_citations(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let document = root.join("cite-check.tex");
        std::fs::write(
            &document,
            "\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\nAs \\cite{knuth1984} sets out.\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n",
        )?;
        self.open(cx, &document, Some(4))?;
        self.pause(cx, Duration::from_millis(300)).await;
        // latexmk runs BibTeX and LaTeX again until the citation resolves.
        let (built, _) = self.build(cx).await?;
        let shown = self
            .wait_for(cx, Duration::from_secs(60), |shell, cx| {
                let shell = shell.read(cx);
                shell.live_document() == Some("cite-check.tex") && shell.pdf().read(cx).page_count(cx) > 0
            })
            .await;
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        let mut at = None;
        for _ in 0..50 {
            at = cx.update(|cx| view.read(cx).named_link_center("cite.knuth1984"));
            if at.is_some() {
                break;
            }
            self.pause(cx, Duration::from_millis(200)).await;
        }
        let card = |cx: &mut AsyncApp| cx.update(|cx| view.read(cx).citation_card().map(str::to_string));
        let move_to = |cx: &mut AsyncApp, position: gpui::Point<gpui::Pixels>| {
            self.with_window(cx, move |_, window, cx| {
                window.dispatch_event(
                    gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                        position,
                        pressed_button: None,
                        modifiers: gpui::Modifiers::default(),
                    }),
                    cx,
                );
            })
        };
        let (mut early, mut opened, mut closed) = (None, None, None);
        if let Some(at) = at {
            move_to(cx, at)?;
            // Not before its 250 ms delay.
            self.pause(cx, Duration::from_millis(80)).await;
            early = card(cx);
            self.pause(cx, Duration::from_millis(500)).await;
            opened = card(cx);
            self.snapshot(cx, "pdf-citation-card").await;
            // Off the link and the card: it goes 180 ms later.
            move_to(cx, gpui::point(at.x, at.y + gpui::px(200.)))?;
            self.pause(cx, Duration::from_millis(500)).await;
            closed = card(cx);
        }
        steps.check(
            "PDF: resting on a citation link opens its entry's card after a moment, and leaving it closes the card",
            built && shown && at.is_some() && early.is_none() && opened.as_deref() == Some("knuth1984") && closed.is_none(),
            json!({ "built": built, "shown": shown, "link": at.map(|at| format!("{at:?}")), "early": early, "opened": opened, "closed": closed }),
        );

        // main.tex built again takes the live PDF back.
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.build(cx).await?;
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| shell.read(cx).live_document() == Some("main.tex"))
            .await;
        Ok(())
    }
}

/// This file's registration as the e2e module `pdf_citations`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 30,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/pdf/view/citation.rs",
        "gpui/crates/lattice-gpui/src/pdf/named_links.rs",
        "gpui/crates/lattice-gpui/src/shell/pdf_citations.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.pdf_citations(cx, steps, &fixture.root)),
};
