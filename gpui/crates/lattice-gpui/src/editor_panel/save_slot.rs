//! What the status bar's save slot reads from an editor and does for it
//! (`use-save-slot.ts` in the Tauri app): when the file was last written,
//! when the linked Overleaf project last synced, and the slot's Try again
//! and Save a copy… for a write that failed.
//!
//! Save a copy is the way out when the file cannot be written in place (a
//! full disk, a project folder that went away), as `save-source-copy.ts`
//! has it: ask where a copy goes and write the text on screen there, through
//! lattice-core's `export::save_text_copy`, which keeps a text file's name
//! (a name without an extension becomes `.txt`). A cancelled panel writes
//! nothing; the outcome is a Save notice either way.

use std::{path::PathBuf, time::Duration};

use gpui::{AppContext as _, Context};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use super::EditorPanel;
use crate::notices::{self, Notice};

/// How often the slot's age ("2m ago") is read again while it shows
/// (`AGE_REFRESH_MS`).
const AGE_REFRESH: Duration = Duration::from_secs(30);

impl EditorPanel {
    /// When this editor last wrote its file; nothing before its first save.
    pub(crate) fn saved_at(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        self.saved_at
    }

    /// When the linked Overleaf project last synced (RFC 3339), if it has.
    pub(crate) fn overleaf_last_sync(&self) -> Option<&str> {
        self.overleaf_last_sync.as_deref()
    }

    /// A write landed now: the slot's age starts again, and is redrawn every
    /// half minute from here, as the app re-reads it.
    pub(super) fn note_saved(&mut self, cx: &mut Context<Self>) {
        self.saved_at = Some(chrono::Utc::now());
        if self._age_tick.is_none() {
            self._age_tick = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(AGE_REFRESH).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            }));
        }
    }

    /// When the linked project last synced, for the slot's popover.
    pub fn set_overleaf_last_sync(&mut self, last_sync: Option<String>, cx: &mut Context<Self>) {
        if self.overleaf_last_sync != last_sync {
            self.overleaf_last_sync = last_sync;
            cx.notify();
        }
    }

    /// The slot's Try again: write the buffer again.
    pub fn retry_save(&mut self, cx: &mut Context<Self>) {
        self._autosave = None;
        self.save(cx).detach();
    }

    /// The slot's Save a copy…: ask where, then write the text on screen
    /// there.
    pub fn save_copy(&mut self, cx: &mut Context<Self>) {
        // The file's own folder may be the one that cannot be written, so
        // the panel opens where the system would (`save-source-copy.ts`
        // passes the name only). GPUI's panel takes no title, so the app's
        // "Save a copy of {name}" has no place here.
        let directory = dirs::document_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("/"));
        let name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let chosen = cx.prompt_for_new_path(&directory, Some(&name));
        let text = self.buffer.read(cx).text();
        cx.spawn(async move |_, cx| {
            let destination = match chosen.await {
                Ok(Ok(Some(destination))) => destination,
                Ok(Ok(None)) | Err(_) => return,
                Ok(Err(error)) => {
                    cx.update(|cx| copy_failed(error.to_string(), cx));
                    return;
                }
            };
            let written = cx
                .background_spawn(async move {
                    lattice_core::export::save_text_copy(&destination, text.as_bytes())
                })
                .await;
            cx.update(|cx| match written {
                Ok(written) => notices::show(
                    Notice::new(
                        ToastLevel::Success,
                        t!("Saved a copy to {written}", written = written),
                    )
                    .source(t!("Save")),
                    cx,
                ),
                Err(error) => copy_failed(error, cx),
            });
        })
        .detach();
    }
}

/// A copy could not be written: say why, as the app's trace fails.
fn copy_failed(error: String, cx: &mut gpui::App) {
    let title = t!("{action} failed", action = t!("Save a copy")).to_string();
    notices::show(
        Notice::new(ToastLevel::Error, title.clone())
            .source(t!("Save"))
            .detail(error.clone())
            .copy(format!("{title}\n{error}")),
        cx,
    );
}
