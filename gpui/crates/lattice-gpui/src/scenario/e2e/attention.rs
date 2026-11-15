//! The editor's attention motions (`editor_panel/reveal_flash.rs`): a jump
//! to a line flashes that whole line on the find-match colour for the
//! linger tier, then takes the flash away.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::{Fixture, Steps};
use crate::{editor_panel::reveal_flash, scenario::Run};

impl Run {
    async fn attention(&self, cx: &mut AsyncApp, steps: &mut Steps, fixture: &Fixture) -> Result<()> {
        let editor = self.open(cx, &fixture.root.join("main.tex"), Some(6))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let rows = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                let panel = editor.read(cx);
                reveal_flash::flashing_rows(&panel.editor().read(cx), cx)
            })
        };
        let during = rows(cx);
        let cleared = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                let panel = editor.read(cx);
                reveal_flash::flashing_rows(&panel.editor().read(cx), cx).is_empty()
            })
            .await;
        steps.check(
            "a jump to a line flashes that line, then the flash goes once the linger tier has run",
            during == [5] && cleared,
            json!({ "during": during, "cleared": cleared }),
        );
        Ok(())
    }
}

/// This file's registration as the e2e module `attention` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 92,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_panel/reveal_flash.rs",
        "gpui/crates/lattice-ui/src/attention.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.attention(cx, steps, fixture)),
};
