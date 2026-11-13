//! Keeping the open file in step with disk, as the Tauri app's disk sync
//! does (`use-document-disk-sync.ts`, `vanished-file.ts`): another version on
//! disk reloads a clean buffer and waits for an edited one's save to merge
//! it; a file that left its path is followed, closed or held with its edits.

use std::{path::Path, time::Duration};

use gpui::{AppContext as _, Context};
use lattice_core::project::{self as core_project, ProjectFileStat};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use super::{DiskVersion, EditorPanel, EditorPanelEvent, Vanished, save::normalize_breaks};
use crate::notices::{self, Notice, NoticeAction};

/// How long a missing file is given to come back before it counts as gone:
/// a save that deletes the old file before writing the new one leaves the
/// path empty for a moment.
const VANISH_CONFIRM: Duration = Duration::from_millis(1000);

impl EditorPanel {
    /// Compare the file on disk with the version last seen, as the Tauri
    /// app's disk poll does.
    pub(crate) fn check_disk(&mut self, cx: &mut Context<Self>) {
        if self.saves_pending > 0 || self.looking_for_file || self.closed {
            return;
        }
        let generation = self.save_generation;
        let saved = self.saved_text.clone();
        let root = self.project.read(cx).root().to_path_buf();
        let relative = self.relative.clone();
        let disk = self.disk.clone();
        cx.spawn(async move |this, cx| {
            let read = cx
                .background_spawn({
                    let relative = relative.clone();
                    async move {
                        let stat = core_project::stat_file(&root, &relative)?;
                        let unchanged = match &disk {
                            DiskVersion::Seen(seen) => same_version(seen, &stat),
                            DiskVersion::Unknown => true,
                            DiskVersion::Unread => false,
                        };
                        let content = if stat.exists && !unchanged {
                            Some(core_project::read_file(&root, &relative)?)
                        } else {
                            None
                        };
                        Ok::<_, String>((stat, content))
                    }
                })
                .await;
            this.update(cx, |this, cx| {
                // A read that raced a save, or a file moved meanwhile, is
                // not an outside edit; the next check looks again.
                if this.saves_pending > 0
                    || this.save_generation != generation
                    || this.saved_text != saved
                    || this.relative != relative
                {
                    return;
                }
                let Ok((stat, content)) = read else {
                    return;
                };
                if !stat.exists {
                    this.file_missing(cx);
                    return;
                }
                this.last_file_id = stat.file_id.clone();
                // A file that vanished holding edits came back: they save
                // into it again.
                if this.vanished.take().is_some() {
                    notices::dismiss(&vanished_key(&this.relative), cx);
                }
                let first = matches!(this.disk, DiskVersion::Unknown);
                let content = content
                    .filter(|_| !first)
                    .map(|content| normalize_breaks(&content))
                    .filter(|content| *content != this.saved_text);
                let Some(content) = content else {
                    this.disk = DiskVersion::Seen(stat);
                    return;
                };
                // An edited buffer keeps its edits: its next save merges the
                // outside edit in against `saved_text`. Until then the
                // version stays unseen, so a buffer that goes back to clean
                // without writing (edits undone) still loads it.
                if this.is_dirty(cx) {
                    return;
                }
                this.disk = DiskVersion::Seen(stat);
                this.replace_text(content, cx);
                this.project
                    .update(cx, |project, _| project.mark_inputs_changed());
                cx.emit(EditorPanelEvent::DiskEdit);
            })
            .ok();
        })
        .detach();
    }

    /// The disk check found the file gone: give it a moment to come back,
    /// then follow it, close its tab or hold its edits.
    fn file_missing(&mut self, cx: &mut Context<Self>) {
        if self.vanished.is_some() {
            // Edits undone back to the saved text leave nothing to keep.
            if !self.is_dirty(cx) {
                self.vanished = None;
                notices::dismiss(&vanished_key(&self.relative), cx);
                self.close_deleted(cx);
            }
            return;
        }
        self.looking_for_file = true;
        let root = self.project.read(cx).root().to_path_buf();
        let relative = self.relative.clone();
        let file_id = self.last_file_id.clone();
        let saved = self.saved_text.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(VANISH_CONFIRM).await;
            let found = cx
                .background_spawn({
                    let relative = relative.clone();
                    async move {
                        let back = core_project::stat_file(&root, &relative)
                            .map(|stat| stat.exists)
                            .unwrap_or(false);
                        if back {
                            return None;
                        }
                        Some(
                            core_project::find_moved_file(&root, &file_id, Some(&saved))
                                .ok()
                                .flatten(),
                        )
                    }
                })
                .await;
            this.update(cx, |this, cx| {
                this.looking_for_file = false;
                // The tab followed a move made in Lattice meanwhile.
                if this.relative != relative {
                    return;
                }
                let Some(moved) = found else {
                    return;
                };
                match moved {
                    Some(moved) if moved != this.relative => {
                        let previous = std::mem::replace(&mut this.relative, String::new());
                        this.moved_to(moved.clone(), cx);
                        notices::info(
                            t!(
                                "{path} was moved to {moved}",
                                path = previous,
                                moved = moved
                            ),
                            t!("It was moved outside Lattice, and its tab followed it."),
                            cx,
                        );
                    }
                    _ if !this.is_dirty(cx) => this.close_deleted(cx),
                    _ => {
                        this.vanished = Some(Vanished { recreate: false });
                        this.announce_vanished(cx);
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn close_deleted(&mut self, cx: &mut Context<Self>) {
        notices::info(
            t!("{path} was deleted", path = self.relative),
            t!("It was deleted outside Lattice and had no unsaved edits, so its tab closed."),
            cx,
        );
        self.closed = true;
        cx.emit(EditorPanelEvent::Close);
    }

    /// Offer the writer the ways out for edits whose file is gone.
    pub(super) fn announce_vanished(&mut self, cx: &mut Context<Self>) {
        let this = cx.entity().downgrade();
        let save_elsewhere = this.clone();
        notices::show(
            Notice::new(
                ToastLevel::Warning,
                t!("{path} is no longer on disk", path = self.relative),
            )
            .detail(t!(
                "It was deleted or moved outside Lattice. Your unsaved edits are still open: \
                 recreate the file, save them elsewhere, or close its tab to discard them."
            ))
            .action(NoticeAction::new(t!("Recreate"), move |_, cx| {
                this.update(cx, |this, cx| this.recreate(cx)).ok();
            }))
            .action(NoticeAction::new(t!("Save As…"), move |_, cx| {
                save_elsewhere
                    .update(cx, |this, cx| this.save_elsewhere(cx))
                    .ok();
            }))
            .key(vanished_key(&self.relative))
            .persistent(),
            cx,
        );
    }

    /// Write the held edits back where the file was; a file that came back
    /// meanwhile is saved into, merging as usual.
    fn recreate(&mut self, cx: &mut Context<Self>) {
        let Some(vanished) = &mut self.vanished else {
            return;
        };
        let root = self.project.read(cx).root().to_path_buf();
        if core_project::stat_file(&root, &self.relative).is_ok_and(|stat| stat.exists) {
            self.vanished = None;
        } else {
            vanished.recreate = true;
        }
        let save = self.save(cx);
        let relative = self.relative.clone();
        cx.spawn(async move |this, cx| {
            let saved = save.await.unwrap_or(false);
            this.update(cx, |this, cx| {
                if let Some(vanished) = &mut this.vanished {
                    vanished.recreate = false;
                }
                if !saved || this.vanished.is_some() {
                    this.announce_vanished(cx);
                    return;
                }
                this.project.update(cx, |project, cx| project.rescan(cx));
                notices::show(
                    Notice::new(ToastLevel::Success, t!("Recreated {path}", path = relative)),
                    cx,
                );
            })
            .ok();
        })
        .detach();
    }

    /// Ask where the held edits go: into the project, the tab follows;
    /// outside it, a copy is written and the tab closes.
    fn save_elsewhere(&mut self, cx: &mut Context<Self>) {
        let root = self.project.read(cx).root().to_path_buf();
        let directory = self.path.parent().map_or(root.clone(), Path::to_path_buf);
        let name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        let chosen = cx.prompt_for_new_path(&directory, name.as_deref());
        let text = self.buffer.read(cx).text();
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(destination))) = chosen.await else {
                // Cancelled: the choice is still open.
                this.update(cx, |this, cx| this.announce_vanished(cx)).ok();
                return;
            };
            let destination = destination.canonicalize().unwrap_or(destination);
            let inside = crate::project::relative_path(&root, &destination);
            let written = cx
                .background_spawn({
                    let root = root.clone();
                    let inside = inside.clone();
                    let destination = destination.clone();
                    let text = text.clone();
                    async move {
                        match inside {
                            Some(relative) => core_project::apply_editor_transaction(
                                &root, relative, text, None, None,
                            )
                            .map(|result| Some(result.content)),
                            None => std::fs::write(&destination, &text)
                                .map(|_| None)
                                .map_err(|error| error.to_string()),
                        }
                    }
                })
                .await;
            this.update(cx, |this, cx| match (written, inside) {
                (Ok(Some(content)), Some(relative)) => {
                    notices::dismiss(&vanished_key(&this.relative), cx);
                    this.vanished = None;
                    this.moved_to(relative.clone(), cx);
                    this.saved_text = normalize_breaks(&content);
                    let version = this.buffer.read(cx).version();
                    this.buffer
                        .update(cx, |buffer, cx| buffer.did_save(version, None, cx));
                    this.project.update(cx, |project, cx| {
                        project.mark_inputs_changed();
                        project.rescan(cx);
                    });
                    notices::show(
                        Notice::new(
                            ToastLevel::Success,
                            t!("Saved your edits as {nextPath}", nextPath = relative),
                        ),
                        cx,
                    );
                }
                (Ok(_), _) => {
                    notices::dismiss(&vanished_key(&this.relative), cx);
                    this.vanished = None;
                    notices::show(
                        Notice::new(
                            ToastLevel::Success,
                            t!(
                                "Saved your edits to {written}",
                                written = destination.display()
                            ),
                        )
                        .detail(t!("That file is outside this project, so the tab closed.")),
                        cx,
                    );
                    this.closed = true;
                    cx.emit(EditorPanelEvent::Close);
                }
                (Err(error), _) => {
                    notices::error(t!("Could not save {name}", name = this.relative), error, cx);
                    this.announce_vanished(cx);
                }
            })
            .ok();
        })
        .detach();
    }
}

/// The notice about a vanished file, one per path.
pub(super) fn vanished_key(relative: &str) -> String {
    format!("vanished-file:{relative}")
}

/// Whether two stats describe one version of a file: any field differing
/// means another, as a restored backup keeps an older mtime than the version
/// it replaced (`read-document.ts` `sameDiskVersion`).
fn same_version(a: &ProjectFileStat, b: &ProjectFileStat) -> bool {
    a.exists == b.exists && a.mtime_ms == b.mtime_ms && a.size == b.size && a.file_id == b.file_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_field_differing_is_another_version() {
        let stat = |mtime_ms, size, file_id: &str| ProjectFileStat {
            exists: true,
            mtime_ms,
            size,
            file_id: file_id.to_string(),
        };
        assert!(same_version(&stat(1, 2, "a"), &stat(1, 2, "a")));
        // A restored backup can keep an older mtime than the file it replaced.
        assert!(!same_version(&stat(2, 2, "a"), &stat(1, 2, "a")));
        assert!(!same_version(&stat(1, 3, "a"), &stat(1, 2, "a")));
        assert!(!same_version(&stat(1, 2, "b"), &stat(1, 2, "a")));
    }
}
