//! The e2e checks of carrying the live document across a dropped channel
//! (`overleaf::bridge::documents::resume`), against the stand-in's live
//! channel, which drops the socket at the app's next update and refuses the
//! handshake until the check lets it back:
//!
//! - an update that landed but whose acknowledgement was lost is not
//!   applied twice, and a collaborator's typing and ours during the outage
//!   both reach the other side once the channel is back;
//! - an update lost with the connection is sent again on the new one and
//!   lands once.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use lattice_core::overleaf_rt::ot::insert;
use serde_json::json;

use super::super::Steps;
use crate::{
    overleaf::bridge::{ChannelStatus, OverleafSaveState},
    scenario::{Run, overleaf_mock::MockOverleaf},
};

impl Run {
    pub(super) async fn overleaf_reconnect(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
    ) -> Result<()> {
        let main = self.root(cx).await?.join("main.tex");
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_path(main.clone(), Some(1), window, cx)
            })
        })?;
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| {
            let bridge = shell.read(cx).overleaf.read(cx);
            bridge.live_file() == Some("main.tex") && !bridge.live_sending()
        })
        .await;

        for (landed, word, peer, meanwhile) in [
            (true, "Hopper ", "% while away\n", "too "),
            (false, "Lovelace ", "% away again\n", "also "),
        ] {
            let sent_before = mock.updates().len();
            // The handshake is refused from now on, so the outage lasts until
            // the check ends it; the socket goes at the next update.
            mock.disable_realtime();
            mock.sever(landed);
            self.type_text(cx, word).await?;
            let dropped = self
                .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                    shell.read(cx).overleaf.read(cx).channel() != ChannelStatus::Live
                })
                .await;
            // Both sides go on meanwhile.
            let typed = mock.peer_typed("main.tex", vec![insert(0, peer)]);
            self.type_text(cx, meanwhile).await?;
            let offline = self
                .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                    shell
                        .update(cx, |shell, cx| shell.open_editor(&main, cx))
                        .and_then(|editor| editor.read(cx).overleaf_save())
                        == Some(OverleafSaveState::Offline)
                })
                .await;
            mock.enable_realtime();
            let converged = self
                .wait_for(cx, Duration::from_secs(40), |shell, cx| {
                    let bridge = shell.read(cx).overleaf.read(cx);
                    let settled = bridge.channel() == ChannelStatus::Live
                        && bridge.live_file() == Some("main.tex")
                        && !bridge.live_sending();
                    let text = shell
                        .update(cx, |shell, cx| shell.open_editor(&main, cx))
                        .map(|editor| editor.read(cx).overleaf_text(cx));
                    settled && text.is_some() && text == mock.file("main.tex")
                })
                .await;
            let overleaf = mock.file("main.tex").unwrap_or_default();
            let once = overleaf.matches(word).count() == 1;
            let resent = mock.updates()[sent_before..]
                .iter()
                .filter(|update| update["dupIfSource"].is_array())
                .count();
            // Landed: the replay is the acknowledgement, so nothing goes
            // again. Lost: it goes again, naming the connection it left on.
            let resent_right = if landed { resent == 0 } else { resent == 1 };
            let label = if landed {
                "an update that landed as the channel dropped is not applied twice, and both sides' typing meanwhile meets once it is back"
            } else {
                "an update lost with the channel is sent again on the new one, and lands once"
            };
            steps.check(
                label,
                dropped
                    && typed
                    && offline
                    && converged
                    && once
                    && resent_right
                    && overleaf.starts_with(peer)
                    && overleaf.contains(meanwhile)
                    && mock.rejected().is_empty(),
                json!({
                    "dropped": dropped, "typed": typed, "offline": offline,
                    "converged": converged, "once": once, "resent": resent,
                    "overleaf": overleaf, "rejected": mock.rejected(),
                    "updates": &mock.updates()[sent_before..],
                }),
            );
        }
        Ok(())
    }
}
