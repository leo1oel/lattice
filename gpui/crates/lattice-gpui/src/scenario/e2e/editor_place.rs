//! Each file's place in its editor (`editor_panel/place_memory.rs`):
//!
//! - A file left with its caret and scroll deep in it, its tab closed and
//!   the file opened again, comes back to the same caret and first line.
//! - Opened at a line of its own (a search result, an outline entry), it
//!   goes there instead.
//! - Closed straight after a jump, inside the write debounce, it comes back
//!   to the jumped-to line.
//! - Renamed in the tree while closed, it opens under its new name where it
//!   was left.
//!
//! The run keeps the places in memory; that they reach the state folder and
//! read back is `place_memory.rs`'s unit tests.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

/// The first line the editor shows, and its caret's byte offset.
fn place(editor: &Entity<EditorPanel>, cx: &mut AsyncApp) -> (f64, usize) {
    cx.update(|cx| {
        let caret = editor.read(cx).text_and_caret(cx).1;
        let top = editor
            .read(cx)
            .editor()
            .clone()
            .update(cx, |editor, cx| editor.scroll_position(cx).y);
        (top, caret)
    })
}

impl Run {
    async fn editor_place(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &std::path::Path) -> Result<()> {
        let file = root.join("editor-place-check.tex");
        let text: String = (1..=300).map(|line| format!("Line {line} of the place check.\n")).collect();
        std::fs::write(&file, &text)?;
        let editor = self.open(cx, &file, Some(180))?;
        self.pause(cx, Duration::from_millis(600)).await;
        let left = place(&editor, cx);
        self.close_tab(cx, editor)?;
        self.pause(cx, Duration::from_millis(300)).await;

        let again = self
            .with_window(cx, {
                let file = file.clone();
                move |shell, window, cx| shell.update(cx, |shell, cx| shell.open_path(file, None, window, cx))
            })?
            .context("the file opens again")?;
        self.pause(cx, Duration::from_millis(400)).await;
        let back = place(&again, cx);
        let line_180 = text.match_indices('\n').nth(178).map(|(at, _)| at + 1);
        steps.check(
            "a file opened again comes back to the caret and first line it was left at",
            left.0 > 100. && back.1 == left.1 && Some(back.1) == line_180 && (back.0 - left.0).abs() < 0.5,
            json!({ "left": { "top": left.0, "caret": left.1 }, "back": { "top": back.0, "caret": back.1 } }),
        );
        self.close_tab(cx, again)?;
        self.pause(cx, Duration::from_millis(300)).await;

        let at_line = self.open(cx, &file, Some(3))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let (_, caret) = place(&at_line, cx);
        let line_3 = text.match_indices('\n').nth(1).map(|(at, _)| at + 1);
        steps.check(
            "opened at a line of its own, a file goes there, not to the place it was left",
            Some(caret) == line_3,
            json!({ "caret": caret, "line_3": line_3 }),
        );
        self.close_tab(cx, at_line)?;
        self.pause(cx, Duration::from_millis(300)).await;

        // Jumped to a line and closed at once, inside the write debounce:
        // the jump is the place it comes back to.
        let quick = self.open(cx, &file, Some(250))?;
        let line_250 = text.match_indices('\n').nth(248).map(|(at, _)| at + 1);
        // A frame or two, as a person pressing ⌘W at once gets, well inside
        // the 250 ms write debounce.
        self.pause(cx, Duration::from_millis(50)).await;
        self.close_tab(cx, quick)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let reopened = self
            .with_window(cx, {
                let file = file.clone();
                move |shell, window, cx| shell.update(cx, |shell, cx| shell.open_path(file, None, window, cx))
            })?
            .context("the file opens again after a quick close")?;
        self.pause(cx, Duration::from_millis(400)).await;
        let (quick_top, quick_caret) = place(&reopened, cx);
        steps.check(
            "a file closed straight after a jump comes back to the jumped-to line",
            Some(quick_caret) == line_250 && quick_top > 150.,
            json!({ "caret": quick_caret, "top": quick_top, "line_250": line_250 }),
        );
        self.close_tab(cx, reopened)?;
        self.pause(cx, Duration::from_millis(300)).await;

        // Renamed in the tree while closed: the place follows to the new name.
        if let Some(project) = cx.update(|cx| self.shell.read(cx).project().cloned()) {
            cx.update(|cx| project.update(cx, |project, cx| project.rescan(cx)));
        }
        self.pause(cx, Duration::from_millis(500)).await;
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| tree.begin_rename("editor-place-check.tex".into(), window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| tree.confirm_name("editor-place-renamed.tex", window, cx))
        })?;
        let renamed = root.join("editor-place-renamed.tex");
        let moved = self
            .wait_for(cx, Duration::from_secs(8), |_, _| renamed.is_file() && !file.exists())
            .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let after_rename = self
            .with_window(cx, {
                let renamed = renamed.clone();
                move |shell, window, cx| shell.update(cx, |shell, cx| shell.open_path(renamed, None, window, cx))
            })?
            .context("the renamed file opens")?;
        self.pause(cx, Duration::from_millis(400)).await;
        let (renamed_top, renamed_caret) = place(&after_rename, cx);
        steps.check(
            "a closed file renamed in the tree opens at the place it was left under its old name",
            moved && Some(renamed_caret) == line_250 && renamed_top > 150. && (renamed_top - quick_top).abs() < 0.5,
            json!({ "renamed": moved, "caret": renamed_caret, "top": renamed_top, "line_250": line_250 }),
        );
        self.close_tab(cx, after_rename)?;
        std::fs::remove_file(&renamed).ok();
        std::fs::remove_file(&file).ok();
        if let Some(project) = cx.update(|cx| self.shell.read(cx).project().cloned()) {
            cx.update(|cx| project.update(cx, |project, cx| project.rescan(cx)));
        }
        Ok(())
    }
}

/// This file's registration as the e2e module `editor_place`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 102,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_panel/place_memory.rs",
        "gpui/crates/lattice-gpui/src/shell/editors.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.editor_place(cx, steps, &fixture.root)),
};
