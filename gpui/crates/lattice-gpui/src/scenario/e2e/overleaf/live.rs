//! The e2e checks of editing the open document live with Overleaf
//! (`overleaf::bridge::documents`), against the stand-in's live channel:
//!
//! - main.tex, open in Live mode with the channel up, goes live, and a
//!   collaborator's typing arrives in its buffer;
//! - typing here (native keys) reaches Overleaf as live operations;
//! - typing on both sides at once converges on Overleaf's text;
//! - moving to another file hands main.tex back to regular sync with
//!   Overleaf's text as the agreed copy.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use lattice_core::overleaf_rt::ot::insert;
use serde_json::json;

use super::super::Steps;
use crate::scenario::{Run, overleaf_mock::MockOverleaf};

impl Run {
    pub(super) async fn overleaf_live(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
    ) -> Result<()> {
        let root = self.root(cx).await?;
        let main = root.join("main.tex");
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_path(main.clone(), Some(2), window, cx)
            })
        })?;
        let live = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).overleaf.read(cx).live_file() == Some("main.tex")
            })
            .await;
        let buffer = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                self.shell
                    .update(cx, |shell, cx| shell.open_editor(&main, cx))
                    .map(|editor| editor.read(cx).overleaf_text(cx))
                    .unwrap_or_default()
            })
        };

        // A collaborator types at the top.
        let typed = mock.peer_typed("main.tex", vec![insert(0, "% Ada was here\n")]);
        let arrived = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .update(cx, |shell, cx| shell.open_editor(&main, cx))
                    .is_some_and(|editor| {
                        editor
                            .read(cx)
                            .overleaf_text(cx)
                            .starts_with("% Ada was here\n")
                    })
            })
            .await;
        let seen = self.with_window(cx, |shell, _, cx| {
            let shell = shell.read(cx);
            (
                shell.overleaf.read(cx).live_file().map(str::to_string),
                shell
                    .active_editor()
                    .map(|editor| editor.read(cx).relative().to_string()),
            )
        })?;
        steps.check(
            "main.tex goes live, and a collaborator's typing arrives in its buffer",
            live && typed && arrived,
            json!({ "live": live, "typed": typed, "arrived": arrived, "live_file": seen.0, "active": seen.1 }),
        );

        // Typing here reaches Overleaf as live operations.
        let sent_before = mock.updates().len();
        self.type_text(cx, "Grace ").await?;
        let reached = self
            .wait_for(cx, Duration::from_secs(15), |_, _| {
                mock.file("main.tex")
                    .is_some_and(|text| text.contains("Grace "))
            })
            .await;
        let updates = mock.updates().len() - sent_before;
        steps.check(
            "typing here reaches Overleaf as live operations",
            reached && updates > 0,
            json!({ "reached": reached, "updates": updates }),
        );

        // Both sides at once.
        self.type_text(cx, "and Ada ").await?;
        let crossed = mock.peer_typed("main.tex", vec![insert(0, "% again\n")]);
        let converged = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let sending = shell.read(cx).overleaf.read(cx).live_sending();
                let text = shell
                    .update(cx, |shell, cx| shell.open_editor(&main, cx))
                    .map(|editor| editor.read(cx).overleaf_text(cx));
                !sending && text.is_some() && text == mock.file("main.tex")
            })
            .await;
        let ours = buffer(cx);
        steps.check(
            "typing on both sides at once converges on Overleaf's text",
            crossed && converged && ours.contains("and Ada ") && ours.contains("% again\n"),
            json!({ "converged": converged, "buffer": ours, "overleaf": mock.file("main.tex") }),
        );

        // Moving to another file hands main.tex back to regular sync.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_path(root.join("refs.bib"), None, window, cx)
            })
        })?;
        let moved = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).overleaf.read(cx).live_file() == Some("refs.bib")
            })
            .await;
        let agreed_root = root.clone();
        let agreed = self
            .wait_for(cx, Duration::from_secs(20), move |_, _| {
                lattice_core::overleaf::agreed_text(&agreed_root, "main.tex")
                    == mock.file("main.tex")
            })
            .await;
        steps.check(
            "moving to another file hands main.tex back with Overleaf's text as the agreed copy",
            moved && agreed,
            json!({ "moved": moved, "agreed": agreed, "rejected": mock.rejected(), "updates": mock.updates() }),
        );
        Ok(())
    }
}
