//! The e2e checks of a Markdown file's Split chrome
//! (`editor_panel/views.rs`): its divider, focused, moves 3% with each
//! arrow key within its 20–80% range (`nudgeSplit`).

#![cfg(target_os = "macos")]

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::{Run, Steps};
use crate::editor_panel::EditorPanel;

impl Run {
    pub(super) async fn markdown_split_divider(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
    ) -> Result<()> {
        let before = cx.update(|cx| crate::editor_panel::views::split_ratio(cx));
        let panel = panel.clone();
        self.with_window(cx, move |_, window, cx| {
            panel.update(cx, |panel, cx| panel.focus_split_divider(window, cx));
            for key in ["right", "right", "left"] {
                window.dispatch_keystroke(gpui::Keystroke::parse(key).expect("a key"), cx);
            }
        })?;
        let after = cx.update(|cx| crate::editor_panel::views::split_ratio(cx));
        let moved = ((after - before) - 0.03).abs() < 1e-4 || (after - 0.8).abs() < 1e-4;
        // Back where it was, for the checks after.
        cx.update(|cx| crate::editor_panel::views::set_split_ratio(before, cx));
        steps.check(
            "Split's divider, focused, moves 3% with each arrow key",
            moved,
            json!({ "before": before, "after": after }),
        );
        Ok(())
    }
}
