//! The e2e checks of Find in the current file under native keys.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Focusable as _};
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

impl Run {
    pub(super) async fn find_in_file(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let editor = self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.press(cx, 'f', true).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (visible, focused) = {
            let editor = editor.clone();
            self.with_window(cx, move |_, window, cx| {
                let panel = editor.read(cx);
                let bar = panel.search_bar().read(cx);
                (panel.search_visible(), !panel.editor().focus_handle(cx).is_focused(window) && bar.focus_handle(cx).contains_focused(window, cx))
            })?
        };
        steps.check(
            "find: ⌘F / Ctrl+F in the source editor shows the find bar with its query focused",
            visible && focused,
            json!({ "visible": visible, "focused": focused }),
        );
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 25,
    needs: &[],
    setup: false,
    covers: &["gpui/crates/lattice-gpui/src/editor_panel/find_bar"],
    run: |run, cx, steps, fixture| Box::pin(run.find_in_file(cx, steps, &fixture.root)),
};
