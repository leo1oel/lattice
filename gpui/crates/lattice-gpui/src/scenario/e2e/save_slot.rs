//! The status bar's save slot (`editor_status/save_state.rs`): a write that
//! fails turns the slot to "Couldn’t save", and its popover names the file,
//! says why, and offers Try again and Save a copy…; once the folder can be
//! written again, Try again saves, and the slot says how long ago.
//!
//! The write is made to fail as a full disk or a lost folder would, for
//! real: the file's folder is made read-only, so lattice-core cannot place
//! its temporary file beside it.
//!
//! A read-only folder is a Unix permission; NTFS lets a file be created in
//! one, so the module is macOS-only, as the e2e scenario is.

#![cfg(target_os = "macos")]

use std::{os::unix::fs::PermissionsExt as _, path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::{Fixture, Steps};
use crate::{
    editor_panel::SaveStatus,
    editor_status::save_state::{Mode, SaveSlot, SlotAction},
    scenario::Run,
};

impl Run {
    async fn save_slot(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        fixture: &Fixture,
    ) -> Result<()> {
        let folder = fixture.root.join("locked");
        std::fs::create_dir_all(&folder)?;
        let file = folder.join("note.tex");
        std::fs::write(&file, "draft\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        set_writable(&folder, false)?;
        self.type_text(cx, "x").await?;
        let failed = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                matches!(editor.read(cx).save_status(), SaveStatus::Failed(_))
            })
            .await;
        let slot = cx.update(|cx| SaveSlot::read(editor.read(cx)));
        let details = slot.details();
        let (_, label) = slot.label();
        steps.check(
            "a write that fails turns the save slot red and its popover offers Try again and Save a copy…",
            failed
                && slot.mode() == Mode::Error
                && &*label == "Couldn’t save"
                && details.title.as_deref() == Some("Lattice couldn’t write note.tex")
                && details.reason.as_ref().is_some_and(|reason| !reason.is_empty())
                && details.actions == [SlotAction::Retry, SlotAction::SaveCopy],
            json!({
                "failed": failed,
                "label": label.to_string(),
                "title": details.title.as_deref(),
                "reason": details.reason.as_deref(),
                "actions": format!("{:?}", details.actions),
            }),
        );

        set_writable(&folder, true)?;
        cx.update(|cx| editor.update(cx, |editor, cx| editor.retry_save(cx)));
        let saved = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                editor.read(cx).save_status() == &SaveStatus::Saved
            })
            .await;
        let slot = cx.update(|cx| SaveSlot::read(editor.read(cx)));
        let on_disk = std::fs::read_to_string(&file).unwrap_or_default();
        steps.check(
            "Try again saves once the folder can be written, and the slot says how long ago",
            saved
                && slot.mode() == Mode::Saved
                && slot.shown_age() == Some("just now")
                && on_disk.contains('x'),
            json!({
                "saved": saved,
                "age": slot.shown_age(),
                "on_disk": on_disk,
            }),
        );
        self.close_tab(cx, editor)?;
        Ok(())
    }
}

fn set_writable(folder: &Path, writable: bool) -> Result<()> {
    let mode = if writable { 0o755 } else { 0o555 };
    std::fs::set_permissions(folder, std::fs::Permissions::from_mode(mode))?;
    Ok(())
}

/// This file's registration as the e2e module `save_slot` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 93,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_status/save_state.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/save_slot.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.save_slot(cx, steps, fixture)),
};
