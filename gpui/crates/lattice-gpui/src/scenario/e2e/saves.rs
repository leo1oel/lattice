//! The e2e checks that closing loses nothing typed: a dirty tab, a window
//! and the app, each closed within the autosave pause, so the save is the
//! close's own and not the autosave's; the vanished-file notice going with
//! its tab; and SyncTeX from a .bib entry.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use anyhow::Result;
use gpui::{App, AsyncApp, Entity};
use serde_json::{Value, json};

use super::Steps;
use crate::{
    editor_panel::EditorPanel,
    native,
    notices::{self, NoticeStack},
    scenario::Run,
    shell::Shell,
};

impl Run {
    /// ⌘⇧J from a .bib entry: lattice-core finds the entry's item in the
    /// generated .bbl, and the PDF marks it in the reference list, which the
    /// document prints after the introduction, so lower on the page than the
    /// introduction's line (`intro_top`) was marked.
    pub(super) async fn bib_sync(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        intro_top: Option<f32>,
    ) -> Result<()> {
        // Line 3, the author, inside the knuth1984 entry.
        self.open(cx, &root.join("references.bib"), Some(3))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.forward_sync(&crate::shell::ForwardSync, window, cx)
            })
        })?;
        let marked = self
            .wait_for(cx, Duration::from_secs(60), |shell, cx| {
                let pdf = shell.read(cx).pdf().read(cx);
                let below = match (pdf.sync_mark_top(), intro_top) {
                    (Some(top), Some(intro)) => top > intro,
                    _ => false,
                };
                below && pdf.sync_mark() == Some((0, false))
            })
            .await;
        let top = cx.update(|cx| self.shell.read(cx).pdf().read(cx).sync_mark_top());
        steps.check(
            "SyncTeX from a .bib entry (⌘⇧J) marks its reference in the PDF",
            marked,
            json!({ "top": top, "intro_top": intro_top }),
        );
        Ok(())
    }

    /// Closing a dirty tab, and closing a window, within the autosave pause
    /// writes what was typed; closing the tab of a file deleted outside
    /// Lattice discards its edits and takes down the notice about them.
    pub(super) async fn closing_saves(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let file = root.join("close-check.txt");
        std::fs::write(&file, "draft\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let typed = "Kept on close. ";
        self.type_text(cx, typed).await?;
        let unsaved = self.unsaved(cx, &editor, &file, typed);
        self.close_tab(cx, editor)?;
        let saved = self
            .wait_for(cx, Duration::from_secs(5), |_, _| {
                std::fs::read_to_string(&file).is_ok_and(|text| text.contains(typed))
            })
            .await;
        steps.check(
            "closing a tab within the autosave pause saves what was typed",
            unsaved && saved,
            json!({ "unsaved_before": unsaved, "disk": std::fs::read_to_string(&file).ok() }),
        );
        std::fs::remove_file(&file).ok();

        let file = root.join("vanish-check.txt");
        std::fs::write(&file, "draft\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.type_text(cx, "x").await?;
        std::fs::remove_file(&file)?;
        let title = "vanish-check.txt is no longer on disk";
        let stack = cx.update(notices::install);
        // A key every 400 ms holds the autosave off (each restarts its
        // pause) until the disk check finds the file gone with edits held.
        let started = Instant::now();
        let mut announced = false;
        while started.elapsed() < Duration::from_secs(12) {
            if cx.update(|cx| showing(&stack, title, cx)) {
                announced = true;
                break;
            }
            self.type_text(cx, "x").await?;
            self.pause(cx, Duration::from_millis(400)).await;
        }
        self.close_tab(cx, editor)?;
        let dismissed = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                !showing(&stack, title, cx)
            })
            .await;
        steps.check(
            "closing the tab of a file deleted outside Lattice discards its edits and its notice",
            announced && dismissed && !file.exists(),
            json!({ "announced": announced, "dismissed": dismissed, "recreated": file.exists() }),
        );

        self.close_window_saves(cx, steps, root).await
    }

    /// A second window on the project (closing the last one would end the
    /// app on Windows): type in it, close it as its close button does, and
    /// the window closes once what was typed is on disk.
    async fn close_window_saves(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let file = root.join("window-close-check.txt");
        std::fs::write(&file, "draft\n")?;
        let opened = cx.update(|cx| Shell::open_window(Some(root.to_path_buf()), cx));
        let (window, shell) = opened?;
        let second = Run { shell, window };
        second.root(cx).await?;
        let editor = second.open(cx, &file, Some(1))?;
        second.pause(cx, Duration::from_millis(300)).await;
        let typed = "Saved on window close. ";
        second.type_text(cx, typed).await?;
        let unsaved = second.unsaved(cx, &editor, &file, typed);
        let native = second.native(cx)?;
        // Only the window holds its shell and editors now, as in a real run.
        drop((editor, second));
        native::request_close(native);
        let id = window.window_id();
        let closed = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                let open = cx.windows().iter().any(|open| open.window_id() == id);
                !open && on_disk(&file, typed)
            })
            .await;
        steps.check(
            "closing a window within the autosave pause saves what was typed, then closes it",
            unsaved && closed,
            json!({ "unsaved_before": unsaved, "disk": std::fs::read_to_string(&file).ok() }),
        );
        std::fs::remove_file(&file).ok();
        Ok(())
    }

    /// Type into a file and leave it unsaved for the quit that ends the run
    /// (`scenario::start`). Returns the file and the text, which the CI
    /// workflow looks for in the file once the app has exited.
    pub(super) async fn type_before_quit(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<Value> {
        let file = root.join("quit-check.txt");
        std::fs::write(&file, "draft\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let typed = "Saved on quit.";
        self.type_text(cx, typed).await?;
        let unsaved = self.unsaved(cx, &editor, &file, typed);
        steps.check(
            "text typed just before quitting is still unsaved when the app quits",
            unsaved,
            json!({ "file": file }),
        );
        Ok(json!({ "file": file, "text": typed }))
    }

    /// Whether `typed` is in the buffer, which holds unsaved edits, and not
    /// yet in `file`.
    fn unsaved(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<EditorPanel>,
        file: &Path,
        typed: &str,
    ) -> bool {
        let dirty = cx.update(|cx| editor.read(cx).is_dirty(cx));
        dirty && !on_disk(file, typed) && self.editor_text(cx, editor).contains(typed)
    }

    /// What the tab's close button runs: the dock removes the panel and
    /// tells it so. The panel is then held only by what it started.
    fn close_tab(&self, cx: &mut AsyncApp, editor: Entity<EditorPanel>) -> Result<()> {
        self.with_window(cx, move |shell, window, cx| {
            let area = shell.read(cx).dock_area().clone();
            area.update(cx, |area, cx| area.remove_panel(editor, window, cx));
        })
    }
}

fn on_disk(file: &Path, typed: &str) -> bool {
    std::fs::read_to_string(file).is_ok_and(|text| text.contains(typed))
}

/// Whether a notice titled `title` is showing.
fn showing(stack: &Entity<NoticeStack>, title: &str, cx: &App) -> bool {
    stack.read(cx).titles().iter().any(|t| &**t == title)
}
