//! The checks running with their sheet closed. The Tauri app keeps its
//! Check references sheet mounted while hidden, so a check goes on after
//! Close and the results wait in the sheet ("Closing this window does not
//! stop the check…"). Here closing drops the sheet's view, so a run holds
//! its `Audit` itself, by the shell that opened it and the project, from
//! Check until it finishes; opening the sheet again for that project takes
//! the same `Audit` back, still running.

use std::{collections::HashMap, path::Path, path::PathBuf};

use gpui::{App, Entity, EntityId, Global};

use super::Audit;

#[derive(Default)]
struct Running(HashMap<(EntityId, PathBuf), Entity<Audit>>);

impl Global for Running {}

/// The check `owner` started on `root` that is still running.
pub fn running(owner: EntityId, root: &Path, cx: &App) -> Option<Entity<Audit>> {
    cx.try_global::<Running>()?
        .0
        .get(&(owner, root.to_path_buf()))
        .cloned()
}

/// Keep `audit` while its run goes on.
pub(super) fn hold(owner: EntityId, root: &Path, audit: Entity<Audit>, cx: &mut App) {
    cx.default_global::<Running>()
        .0
        .insert((owner, root.to_path_buf()), audit);
}

pub(super) fn release(owner: EntityId, root: &Path, cx: &mut App) {
    if let Some(running) = cx.try_global::<Running>()
        && running.0.contains_key(&(owner, root.to_path_buf()))
    {
        // Dropped after the update that released it, never inside it.
        let audit = cx
            .global_mut::<Running>()
            .0
            .remove(&(owner, root.to_path_buf()));
        cx.defer(move |_| drop(audit));
    }
}

/// Stop what `owner` still runs on a project other than `root`: a project
/// switched away from stops its check, as the Tauri app's sheet unmounts.
pub fn stop_others(owner: EntityId, root: &Path, cx: &mut App) {
    let others: Vec<Entity<Audit>> = cx
        .try_global::<Running>()
        .map(|running| {
            running
                .0
                .iter()
                .filter(|((each, path), _)| *each == owner && path != root)
                .map(|(_, audit)| audit.clone())
                .collect()
        })
        .unwrap_or_default();
    for audit in others {
        audit.update(cx, |audit, cx| audit.abandon(cx));
    }
}
