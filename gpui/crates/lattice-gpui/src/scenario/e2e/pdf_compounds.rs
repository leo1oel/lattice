//! A chemnum compound's key over its number in the compiled PDF
//! (`pdf-compound-key-hover.tsx`): a document numbering two compounds is
//! built; the pointer resting on the printed `2` opens the card naming
//! `\cmpd{alcohol}`, and a plain click on the number copies that command.
//! With main.tex's PDF in a root tab meanwhile, a jump to the live PDF
//! spins only the live locate button.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput};
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

impl Run {
    async fn pdf_compounds(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let document = root.join("chem-check.tex");
        std::fs::write(
            &document,
            "\\documentclass{article}\n\\usepackage{chemnum}\n\\begin{document}\nThe ketone \\cmpd{ketone} gave the alcohol \\cmpd{alcohol}.\n\\end{document}\n",
        )?;
        self.open(cx, &document, Some(4))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (built, _) = self.build(cx).await?;
        let shown = self
            .wait_for(cx, Duration::from_secs(60), |shell, cx| {
                let shell = shell.read(cx);
                shell.live_document() == Some("chem-check.tex") && shell.pdf().read(cx).page_count(cx) > 0
            })
            .await;
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        let found = self.find_word_in(cx, &root.join("chem-check.pdf"), "2.").await?;
        let at = found.and_then(|(page, (x, y), _)| {
            cx.update(|cx| view.read(cx).page_point_on_window(page as usize - 1, x as f32, y as f32))
        });
        let send = |cx: &mut AsyncApp, input: PlatformInput| {
            self.with_window(cx, move |_, window, cx| {
                window.dispatch_event(input, cx);
            })
        };
        let (mut card, mut copied) = (None, None);
        if let Some(at) = at {
            send(cx, PlatformInput::MouseMove(MouseMoveEvent { position: at, pressed_button: None, modifiers: Modifiers::default() }))?;
            for _ in 0..30 {
                self.pause(cx, Duration::from_millis(200)).await;
                card = cx.update(|cx| view.read(cx).compound_card());
                if card.is_some() {
                    break;
                }
            }
            self.snapshot(cx, "pdf-compound-card").await;
            send(cx, PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: at,
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }))?;
            send(cx, PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: at,
                modifiers: Modifiers::default(),
                click_count: 1,
            }))?;
            self.pause(cx, Duration::from_millis(600)).await;
            copied = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
        }
        steps.check(
            "PDF: resting on a compound's number shows its chemnum key, and a click on the number copies \\cmpd{key}",
            built
                && shown
                && card == Some(vec!["alcohol".to_string()])
                && copied.as_deref() == Some("\\cmpd{alcohol}"),
            json!({ "built": built, "shown": shown, "at": at.map(|at| format!("{at:?}")), "card": card, "copied": copied }),
        );

        // main.tex keeps its last PDF in a root tab while chem-check.tex is
        // the live one: a jump to the live PDF spins the live locate button
        // only, never the root tab's (`use-document-surfaces.tsx` gives
        // document tabs no `locatingPdf`).
        self.open(cx, &document, Some(4))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (live, root_tabs) = self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.forward_sync(&crate::shell::ForwardSync, window, cx));
            let shell = shell.read(cx);
            let root_tabs: Vec<(String, bool)> = shell
                .root_pdf_tabs()
                .iter()
                .map(|(document, panel)| (document.clone(), panel.read(cx).live_view().read(cx).reveal_state().1))
                .collect();
            (shell.pdf().read(cx).live_view().read(cx).reveal_state().1, root_tabs)
        })?;
        steps.check(
            "PDF: a jump to the live PDF spins its locate button, never a root document's tab's",
            live && root_tabs.iter().any(|(document, _)| document == "main.tex")
                && root_tabs.iter().all(|(_, locating)| !locating),
            json!({ "live_locating": live, "root_tabs": root_tabs }),
        );
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| {
            !shell.read(cx).pdf().read(cx).live_view().read(cx).reveal_state().1
        })
        .await;

        // main.tex built again takes the live PDF back.
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.build(cx).await?;
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| shell.read(cx).live_document() == Some("main.tex"))
            .await;
        Ok(())
    }
}

/// This file's registration as the e2e module `pdf_compounds`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 35,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/pdf_sync.rs",
        "gpui/crates/lattice-gpui/src/pdf/compounds.rs",
        "gpui/crates/lattice-gpui/src/pdf/view/compound.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.pdf_compounds(cx, steps, &fixture.root)),
};
