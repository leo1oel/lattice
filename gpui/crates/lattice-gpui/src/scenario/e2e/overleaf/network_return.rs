//! The live channel joining again when the network comes back
//! (`overleaf/network.rs`, the browser's `online` in
//! `use-overleaf-realtime-connection.ts`): with the channel down long
//! enough that its next try is seconds away, the stand-in lets it back and
//! the system says the network is reachable again; the channel is live
//! long before that next try.

use std::time::{Duration, Instant};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::{
    overleaf::{bridge::ChannelStatus, network},
    scenario::{Run, overleaf_mock::MockOverleaf},
};

/// The wait the toolbar says the channel has before it tries again.
fn next_try(detail: &str) -> Option<u64> {
    let (_, rest) = detail.split_once("Reconnecting in ")?;
    rest.split_whitespace().next()?.parse().ok()
}

impl Run {
    pub(super) async fn overleaf_network_return(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
    ) -> Result<()> {
        const STEP: &str = "the live channel joins again as soon as the network comes back, not at the end of its wait";
        mock.disable_realtime();
        mock.sever(false);
        self.type_text(cx, "% offline\n").await?;
        let dropped = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                shell.read(cx).overleaf.read(cx).channel() != ChannelStatus::Live
            })
            .await;
        // Down until the next try is at least 8 seconds off.
        let waiting = self
            .wait_for(cx, Duration::from_secs(30), |shell, cx| {
                let detail = shell.read(cx).overleaf.read(cx).channel_detail();
                detail
                    .as_deref()
                    .and_then(next_try)
                    .is_some_and(|seconds| seconds >= 8)
            })
            .await;
        let detail = cx.update(|cx| self.shell.read(cx).overleaf.read(cx).channel_detail());
        mock.enable_realtime();
        let back = Instant::now();
        network::announce_return();
        let live = self
            .wait_for(cx, Duration::from_secs(4), |shell, cx| {
                shell.read(cx).overleaf.read(cx).channel() == ChannelStatus::Live
            })
            .await;
        let took = back.elapsed();
        // However it went, the channel is back for the checks after this.
        self.wait_for(cx, Duration::from_secs(40), |shell, cx| {
            shell.read(cx).overleaf.read(cx).channel() == ChannelStatus::Live
        })
        .await;
        steps.check(
            STEP,
            dropped && waiting && live,
            json!({
                "dropped": dropped, "waiting": waiting, "detail": detail.map(|d| d.to_string()),
                "live": live, "took_ms": took.as_millis(),
            }),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::next_try;

    #[test]
    fn reads_the_wait_the_toolbar_says() {
        assert_eq!(
            next_try("Overleaf live editing disconnected (closed). Reconnecting in 16 s…"),
            Some(16)
        );
        assert_eq!(
            next_try("Overleaf live editing disconnected (x). Reconnecting now…"),
            None
        );
    }
}
