//! The e2e checks of who else is in a linked Overleaf project
//! (`overleaf::bridge::presence`, `shell::overleaf_presence`), against the
//! stand-in's live channel (`scenario::overleaf_realtime_mock`):
//!
//! - the channel comes up, and a collaborator arriving in main.tex joins the
//!   roster, the titlebar's chips, and main.tex's editor as a caret on
//!   their line;
//! - our own caret reaches Overleaf, in main.tex's document;
//! - the collaborator leaving takes them out of the roster and the editor.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{
    overleaf::ChannelStatus,
    scenario::{
        Run,
        overleaf_mock::MockOverleaf,
        overleaf_realtime_mock::{PEER_ID, PEER_NAME, doc_id},
    },
};

impl Run {
    pub(super) async fn overleaf_presence(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
        _clone_root: &Path,
    ) -> Result<()> {
        // The window's own root: the scratch folder's canonical path, which
        // is what its editors are opened under.
        let clone_root = self.root(cx).await?;
        let live = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).overleaf.read(cx).channel() == ChannelStatus::Live
            })
            .await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_path(clone_root.join("main.tex"), Some(2), window, cx)
            })
        })?;
        let editor = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .update(cx, |shell, cx| {
                        shell.open_editor(&clone_root.join("main.tex"), cx)
                    })
                    .is_some()
            })
            .await;

        // A collaborator arrives at main.tex's second line.
        mock.peer_at("main.tex", 1, 2);
        let arrived = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .overleaf
                    .read(cx)
                    .peers()
                    .iter()
                    .any(|peer| peer.id == PEER_ID && peer.name == PEER_NAME)
            })
            .await;
        let caret = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                self.shell
                    .update(cx, |shell, cx| {
                        shell.open_editor(&clone_root.join("main.tex"), cx)
                    })
                    .map(|editor| {
                        editor
                            .read(cx)
                            .lattice_editor()
                            .read(cx)
                            .painted()
                            .cursors
                            .iter()
                            .any(|cursor| cursor.id.as_ref() == PEER_ID)
                    })
                    .unwrap_or(false)
            })
        };
        let drawn = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                // Painted on the next frame.
                cx.refresh_windows();
                true
            })
            .await
            && {
                self.pause(cx, Duration::from_millis(400)).await;
                caret(cx)
            };
        steps.check(
            "the live channel comes up, and a collaborator arriving in main.tex joins the roster and draws their caret there",
            live && editor && arrived && drawn,
            json!({ "live": live, "editor": editor, "arrived": arrived, "drawn": drawn }),
        );

        // Our caret reaches Overleaf, in main.tex's document.
        let published = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                mock.positions()
                    .iter()
                    .any(|position| position["doc_id"] == doc_id("main.tex"))
            })
            .await;
        steps.check(
            "our caret reaches Overleaf, in main.tex's document",
            published,
            json!({ "positions": mock.positions() }),
        );

        // The collaborator leaves.
        mock.peer_left();
        let gone = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).overleaf.read(cx).peers().is_empty()
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        let cleared = !caret(cx);
        steps.check(
            "a collaborator leaving leaves the roster and the editor",
            gone && cleared,
            json!({ "gone": gone, "cleared": cleared }),
        );
        Ok(())
    }
}
