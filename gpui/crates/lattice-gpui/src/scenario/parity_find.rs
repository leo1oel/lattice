//! The find bar's screen of the parity harness (`LATTICE_PARITY_SCREEN=find`),
//! staged as `design-system/screens/scenes.mjs`'s `find` stages it: ⌘F in
//! the tutorial's `main.tex`, "attention" typed as the query, and nothing
//! focused, so both apps draw the bar at rest with its matches marked.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;

use super::{Run, sleep};

impl Run {
    pub(super) async fn parity_find(&self, cx: &mut AsyncApp) -> Result<bool> {
        let Some(root) = cx.update(|cx| self.shell.read(cx).root(cx)) else {
            return Ok(false);
        };
        let panel = self.open(cx, &root.join("main.tex"), Some(1))?;
        let bar = cx.update(|cx| panel.read(cx).find_bar().clone());
        self.with_window(cx, |_, window, cx| {
            bar.update(cx, |bar, cx| {
                bar.open(window, cx);
                bar.set_query("attention", window, cx);
            })
        })?;
        let found = self
            .wait_for(cx, Duration::from_secs(10), {
                let bar = bar.clone();
                move |_, cx| !bar.read(cx).pending() && bar.read(cx).match_count() > 0
            })
            .await;
        sleep(cx, Duration::from_millis(300)).await;
        self.with_window(cx, |_, window, cx| window.blur(cx))?;
        Ok(found)
    }
}
