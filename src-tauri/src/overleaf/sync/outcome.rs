//! What a sync reports: the files it moved, merged or left alone, and its
//! shape (counts, never paths) on the wide event.

use super::stale_folders::KeptFolder;
use super::{CaseCollision, SyncState};
use crate::wide_event;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafConflict {
    pub path: String,
    pub local_copy: String,
    /// Whether the file carries conflict markers to work through.
    ///
    /// False for one that could not be merged line by line at all — a figure,
    /// a PDF — where the remote version simply takes the path and the local
    /// one is kept beside it. Telling someone to resolve the spots in a file
    /// that has none, and opening a marker resolver on it, is worse than
    /// saying plainly that both versions are on disk.
    #[serde(default)]
    pub markers: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafSyncResult {
    pub pulled: Vec<String>,
    pub pushed: Vec<String>,
    /// Files where both sides had edits that combined cleanly.
    pub merged: Vec<String>,
    pub conflicts: Vec<OverleafConflict>,
    pub deleted_local: Vec<String>,
    pub skipped_remote_deletes: Vec<String>,
    /// App-owned transient paths that should be removed remotely without
    /// applying the user's deletion policy for ordinary project files.
    #[serde(default)]
    pub automatic_remote_deletes: Vec<String>,
    /// Files left alone because they are bigger than Overleaf will take.
    /// Reported rather than dropped quietly: to the writer they look synced.
    #[serde(default)]
    pub skipped_large: Vec<String>,
    /// Files kept as they are here although Overleaf's download had them
    /// empty or cut to a fraction, because Overleaf's history does not confirm
    /// a change to them since the last sync (see [`settle_destructive`]). Each
    /// is reported once per Overleaf copy, not again while that copy stays.
    #[serde(default)]
    pub refused_incoming: Vec<String>,
    /// True when local work stayed here because this account cannot write to
    /// the project. Everything incoming still landed.
    #[serde(default)]
    pub read_only: bool,
    /// Files changed here while this sync ran, by something other than the
    /// editor (whose saves wait for a sync to finish): an agent, another
    /// editor. The sync wrote nothing over them and recorded none of it, so
    /// they count as local edits and need one more sync to go up.
    #[serde(default)]
    pub edited_during_sync: Vec<String>,
    /// Documents uploaded whole, for want of the live channel, while someone
    /// else's edit reached the project: the upload may have replaced what a
    /// co-author had just typed in them, which Overleaf's history still has.
    #[serde(default)]
    pub uploaded_over_edits: Vec<String>,
    /// Files still carrying the conflict markers of an earlier sync while
    /// Overleaf moved on again. Merging the marked-up file once more would
    /// nest a second set of markers inside the first, so each is left exactly
    /// as it is, against the copy of Overleaf's its markers show; once it is
    /// resolved, the next sync merges in what Overleaf did since.
    #[serde(default)]
    pub unresolved_conflicts: Vec<String>,
    /// The `unresolved_conflicts` the previous sync did not hold already:
    /// each is news once, not on every sync while it stays marked up.
    #[serde(default)]
    pub newly_unresolved_conflicts: Vec<String>,
    /// Overleaf paths that differ only in case from another, left out of the
    /// sync on both sides (see `case_collisions`); named on every sync until
    /// one is renamed.
    #[serde(default)]
    pub case_collisions: Vec<CaseCollision>,
    /// Files edited here that Overleaf renamed or removed in a way this sync
    /// could not carry the edit through (see `renames`): held back unsent and
    /// undeleted, on their agreed copy, rather than uploaded again under the
    /// old name beside the renamed file. Named on every sync while held.
    #[serde(default)]
    pub held_renames: Vec<String>,
    /// Folders Overleaf no longer has, whose synced files this sync or an
    /// earlier one took away, that stay here for files in them that never
    /// sync: a conflict copy, a file too large for Overleaf. Their build
    /// outputs and empty subfolders are gone (see `stale_folders`). Named once,
    /// by the sync that clears the rest.
    #[serde(default)]
    pub kept_folders: Vec<KeptFolder>,
}

/// Of the files this sync holds marked up, those `state` (the last sync's)
/// did not hold already.
pub(super) fn newly_held(state: &SyncState, held: &[String]) -> Vec<String> {
    held.iter().filter(|path| !state.unresolved_conflicts.contains(path)).cloned().collect()
}

/// The sync's shape on its wide event: counts, never paths.
pub(super) fn record_result(result: &OverleafSyncResult) {
    for (key, count) in [
        ("pulled", result.pulled.len()),
        ("pushed", result.pushed.len()),
        ("merged", result.merged.len()),
        ("conflicts", result.conflicts.len()),
        ("deleted_local", result.deleted_local.len()),
        ("skipped_remote_deletes", result.skipped_remote_deletes.len()),
        ("skipped_large", result.skipped_large.len()),
        ("refused_incoming", result.refused_incoming.len()),
        ("edited_during_sync", result.edited_during_sync.len()),
        ("uploaded_over_edits", result.uploaded_over_edits.len()),
        ("unresolved_conflicts", result.unresolved_conflicts.len()),
        ("case_collisions", result.case_collisions.len()),
        ("held_renames", result.held_renames.len()),
        ("kept_folders", result.kept_folders.len()),
    ] {
        if count > 0 {
            wide_event::record(key, count);
        }
    }
    wide_event::record("read_only", result.read_only);
}
