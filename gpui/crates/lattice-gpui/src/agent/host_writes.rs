//! Project files Lattice writes itself, reported to the Agent panel so its
//! Undo can tell them from the Agent's edits, as the Tauri app reports them
//! (`src/agent/agent-host-writes.ts`, `noteHostFileWrites`): Synara's turn
//! diff is the whole workspace between the turn's start and end, so the
//! writer's own save, a co-author's Overleaf edit pulled in, or a resolved
//! conflict landing while a turn runs is inside that diff, and undoing the
//! turn would take it away. Synara records each reported path on the turn
//! that was running and refuses to undo that file instead.
//!
//! The writes go to every Agent page showing the project, whose own
//! `noteHostFileWrites` coalesces a burst, bounds each message and keeps
//! what arrives while its frame is not ready. Never report a write made on
//! the Agent's behalf (a document tool answering it): that edit is the
//! Agent's, and reporting it would block undoing it.

use std::path::Path;

use gpui::App;

use super::{SurfaceKind, checkpoints::is_workspace_relative, commands::same_root, runtime};

/// What an Overleaf sync wrote here: what it pulled, merged, left marked
/// up or deleted (`reportSyncOutcome`).
pub fn sync_writes(result: &lattice_core::overleaf::OverleafSyncResult) -> Vec<String> {
    result
        .pulled
        .iter()
        .chain(&result.merged)
        .chain(result.conflicts.iter().map(|conflict| &conflict.path))
        .chain(&result.deleted_local)
        .cloned()
        .collect()
}

/// Lattice just wrote `paths` (project-relative) of the project at `root`.
pub fn note(root: &Path, paths: impl IntoIterator<Item = String>, cx: &mut App) {
    let paths: Vec<String> = paths
        .into_iter()
        .map(|path| path.replace('\\', "/"))
        .filter(|path| is_workspace_relative(path, 1_024))
        .collect();
    if paths.is_empty() {
        return;
    }
    for surface in runtime::surfaces(cx) {
        surface
            .update(cx, |surface, cx| {
                if surface.kind() == SurfaceKind::Agent
                    && surface.root().is_some_and(|shown| same_root(shown, root))
                {
                    surface.host_wrote(paths.clone(), cx);
                }
            })
            .ok();
    }
}
