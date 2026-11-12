//! Saving, as the Tauri app's open documents save (`use-document-save.ts`,
//! `use-document-autosave.ts`): after a pause in typing and on leaving the
//! editor, one save at a time, through lattice-core's editor transaction with
//! the text the buffer grew from as the base of a three-way merge.

use std::time::Duration;

use anyhow::Result;
use futures::{FutureExt as _, channel::oneshot};
use gpui::{AppContext as _, Context, Task, WeakEntity};
use lattice_core::project as core_project;

use super::{DiskVersion, EditorPanel, EditorPanelEvent, SaveStatus, vanished_key};
use crate::notices;

/// The pause in typing after which the file saves.
const AUTOSAVE_DELAY: Duration = Duration::from_millis(900);
/// The same with automatic builds, which follow each save.
const AUTOSAVE_BUILD_DELAY: Duration = Duration::from_millis(1200);

impl EditorPanel {
    /// Save after a pause in typing; with automatic builds a build follows.
    pub(super) fn schedule_autosave(&mut self, cx: &mut Context<Self>) {
        if !self.is_dirty(cx) {
            self._autosave = None;
            return;
        }
        let automatic = crate::app::auto_build(cx);
        let delay = if automatic {
            AUTOSAVE_BUILD_DELAY
        } else {
            AUTOSAVE_DELAY
        };
        // Only the wait is replaced by the next keystroke; a save it started
        // runs on.
        self._autosave = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            cx.spawn(async move |cx| Self::save_from(this, automatic, cx).await)
                .detach();
        }));
    }

    /// The writer left the editor: save now, and build with automatic builds
    /// when there was something to save.
    pub(super) fn leave(&mut self, cx: &mut Context<Self>) {
        if !self.is_dirty(cx) {
            return;
        }
        self._autosave = None;
        let automatic = crate::app::auto_build(cx);
        let this = cx.entity().downgrade();
        cx.spawn(async move |_, cx| Self::save_from(this, automatic, cx).await)
            .detach();
    }

    async fn save_from(this: WeakEntity<Self>, automatic: bool, cx: &mut gpui::AsyncApp) {
        let Ok(save) = this.update(cx, |this, cx| this.save(cx)) else {
            return;
        };
        if let Ok(true) = save.await
            && automatic
        {
            this.update(cx, |_, cx| cx.emit(EditorPanelEvent::SavedForBuild))
                .ok();
        }
    }

    /// Write the buffer to disk, after any save already under way. Resolves
    /// true when the buffer is on disk (nothing to write counts), false when
    /// the write is held or failed, which the save slot and a notice report.
    /// The save runs to its end even if the returned task is dropped, so a
    /// write is never cut off halfway through its bookkeeping.
    pub fn save(&mut self, cx: &mut Context<Self>) -> Task<Result<bool>> {
        let previous = self.save_queue.take();
        self.saves_pending += 1;
        self.save_generation += 1;
        let (done, settled) = oneshot::channel::<()>();
        let queued: Task<()> = cx.background_spawn(async move {
            settled.await.ok();
        });
        self.save_queue = Some(queued.shared());
        let (answer, answered) = oneshot::channel::<Result<bool>>();
        cx.spawn(async move |this, cx| {
            if let Some(previous) = previous {
                previous.await;
            }
            let result = match this.update(cx, |this, cx| this.write(cx)) {
                Ok(write) => write.await,
                Err(error) => Err(error),
            };
            this.update(cx, |this, cx| {
                this.saves_pending -= 1;
                cx.notify();
            })
            .ok();
            done.send(()).ok();
            answer.send(result).ok();
        })
        .detach();
        cx.background_spawn(async move {
            answered
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("the save stopped before it ended")))
        })
    }

    fn write(&mut self, cx: &mut Context<Self>) -> Task<Result<bool>> {
        let (content, version) = {
            let buffer = self.buffer.read(cx);
            (buffer.text(), buffer.version())
        };
        if content == self.saved_text && self.vanished.is_none() {
            // Edits typed and undone back to the saved text: nothing to write.
            if self.is_dirty(cx) {
                self.buffer
                    .update(cx, |buffer, cx| buffer.did_save(version, None, cx));
            }
            return Task::ready(Ok(true));
        }
        // The file left its path while these edits were unsaved: writing
        // them waits for the writer's choice, offered again here, unless
        // they chose to recreate it, when there is no file to merge with.
        if let Some(vanished) = &self.vanished
            && !vanished.recreate
        {
            self.announce_vanished(cx);
            return Task::ready(Ok(false));
        }
        let recreating = self.vanished.is_some();
        let root = self.project.read(cx).root().to_path_buf();
        let relative = self.relative.clone();
        let base = (!recreating).then(|| self.saved_text.clone());
        self.status = SaveStatus::Saving;
        cx.notify();
        let written =
            cx.background_spawn({
                let content = content.clone();
                let relative = relative.clone();
                async move {
                    core_project::apply_editor_transaction(&root, relative, content, base, None)
                }
            });
        cx.spawn(async move |this, cx| {
            let written = written.await;
            let merged = this.update(cx, |this, cx| {
                let result = match written {
                    Ok(result) => result,
                    Err(error) => {
                        this.status = SaveStatus::Failed(error.clone().into());
                        notices::error(format!("Could not save {relative}"), error, cx);
                        cx.notify();
                        return None;
                    }
                };
                if recreating {
                    this.vanished = None;
                    notices::dismiss(&vanished_key(&relative), cx);
                }
                let written_text = normalize_breaks(&result.content);
                let same_file = this.relative == relative;
                let typed_on = this.buffer.read(cx).version() != version;
                if result.had_conflicts {
                    notices::warning(
                        format!(
                            "Kept overlapping external edits in {relative} with conflict markers."
                        ),
                        cx,
                    );
                }
                // The saved text is the base the next save merges against,
                // so it must be what the buffer grew from: when this save
                // merged in an outside edit while typing went on, the buffer
                // grew from `content`, and the next save merges again.
                this.saved_text = if written_text != content && typed_on {
                    content.clone()
                } else {
                    written_text.clone()
                };
                // The next check reads the file whatever its version: an
                // outside write may land between this save and its stat.
                this.disk = DiskVersion::Unread;
                this.status = SaveStatus::Saved;
                log::debug!("saved {relative}");
                this.buffer
                    .update(cx, |buffer, cx| buffer.did_save(version.clone(), None, cx));
                this.count_words(cx);
                cx.emit(EditorPanelEvent::Saved);
                cx.notify();
                // A merge brought in edits made outside: the buffer takes
                // them when nothing was typed meanwhile.
                (written_text != content && same_file && !typed_on).then_some(written_text)
            })?;
            let Some(merged) = merged else {
                return Ok(this.update(cx, |this, _| this.status == SaveStatus::Saved)?);
            };
            this.update(cx, |this, cx| this.replace_text(merged, cx))?;
            Ok(true)
        })
    }

    /// Put `text` in the buffer as what is on disk, as a reload does: the
    /// change is computed as a diff so the caret and scroll stay where the
    /// text allows, it is not the writer's to undo, and the buffer is clean
    /// after it.
    pub(super) fn replace_text(&mut self, text: String, cx: &mut Context<Self>) {
        let buffer = self.buffer.clone();
        let diff = buffer.update(cx, |buffer, cx| buffer.diff(text, cx));
        cx.spawn(async move |this, cx| {
            let diff = diff.await;
            buffer.update(cx, |buffer, cx| {
                buffer.finalize_last_transaction();
                if let Some(transaction) = buffer.apply_diff(diff, cx) {
                    buffer.forget_transaction(transaction);
                }
                let version = buffer.version();
                buffer.did_save(version, None, cx);
            });
            this.update(cx, |this, cx| this.count_words(cx)).ok();
        })
        .detach();
    }
}

/// `text` with "\n" line breaks, as the buffer holds it. lattice-core puts
/// a CRLF file's own breaks back on save (project/editor_save.rs).
pub(super) fn normalize_breaks(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_breaks_normalize_to_the_buffers() {
        assert_eq!(normalize_breaks("a\r\nb\r\n"), "a\nb\n");
        assert_eq!(normalize_breaks("a\rb"), "a\nb");
        assert_eq!(normalize_breaks("plain\n"), "plain\n");
    }
}
