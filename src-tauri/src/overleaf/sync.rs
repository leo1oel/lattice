//! Sync against the project ZIP: the cheap remote-change probe, the plan that
//! classifies every file, the sync that carries it out, the dry-run preview of
//! it, and the replay of local moves by entity id that must come first.
//!
//! Classification and execution are deliberately separate: the exact same
//! decisions drive a real sync, the read-only preview the user sees before
//! committing to one, and the staged sync, so there is only ever one set of
//! rules to keep honest.

use super::account::load_session;
use super::api::{
    csrf_token, download_project_zip, err, expect_success, http_client, json_str,
    latest_update_version, read_zip_entries, send_as, sync_host, Remote,
};
use super::files::*;
use super::link::{load_state, now_iso, permits_writing, save_state, SyncState, PAUSED};
use super::review::paths_changed_since;
use crate::overleaf_rt::EntityEntry;
use reqwest::header::COOKIE;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

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
    /// empty, cut to a fraction or missing, because Overleaf's history shows
    /// no change to them since the last sync (see [`settle_destructive`]).
    #[serde(default)]
    pub refused_incoming: Vec<String>,
    /// True when local work stayed here because this account cannot write to
    /// the project. Everything incoming still landed.
    #[serde(default)]
    pub read_only: bool,
}

/// What a pending sync would do to one file, computed without touching disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafChange {
    pub path: String,
    /// "incoming" | "outgoing" | "merge" | "conflict" | "deleteLocal" | "skippedRemoteDelete"
    /// | "refusedIncoming"
    pub kind: String,
    /// The file as it stands locally right now; None when absent locally.
    pub before: Option<String>,
    /// What it becomes if applied; None when it would be deleted.
    pub after: Option<String>,
    pub binary: bool,
}

/// A dry run of `sync`: everything it would do, nothing it did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafPreview {
    pub changes: Vec<OverleafChange>,
    pub remote_version: Option<i64>,
}

/// Result of the cheap remote-change check that live mode polls.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafProbe {
    /// True when Overleaf has moved on since our last sync.
    pub changed: bool,
    /// True when a requested local check found files that differ from the last
    /// sync. Ordinary polling leaves this false so it stays a cheap network
    /// version check rather than rereading the project every few seconds.
    pub local_changed: bool,
    /// False when this instance does not tell us a version, in which case
    /// `changed` is meaningless and polling cannot be used to drive syncing.
    pub version_known: bool,
    pub remote_version: Option<i64>,
    pub last_sync: Option<String>,
}

// ---- Planning ---------------------------------------------------------------

/// One file both sides changed in ways that need a human.
pub(super) struct ConflictPlan {
    pub path: String,
    /// See `OverleafConflict::markers`.
    pub markers: bool,
    /// What lands at `path`: the conflict-marked text, or the remote file when
    /// the two sides cannot be merged line by line.
    pub resolved: Vec<u8>,
    /// The local file as it stood, kept beside the marked-up one.
    pub local: Vec<u8>,
    /// Where that pristine local copy goes.
    pub local_copy: String,
}

impl ConflictPlan {
    pub fn reported(&self) -> OverleafConflict {
        let (path, local_copy) = (self.path.clone(), self.local_copy.clone());
        OverleafConflict { path, local_copy, markers: self.markers }
    }
}

/// An incoming change that would wipe out a file kept unchanged here since
/// the last sync: Overleaf's copy is empty, a fraction of ours, or missing.
///
/// "Changed there, untouched here" is normally a plain pull or deletion. But
/// on 2026-10-01 Overleaf's project download carried 0-byte entries for a
/// hundred files nobody had touched, and taking it at its word emptied them
/// all on disk. So a change like this waits for Overleaf's own history to
/// confirm someone made it.
pub(super) struct Destructive {
    pub path: String,
    /// Overleaf's bytes; `None` when the download no longer has the file.
    pub remote: Option<Vec<u8>>,
}

/// Below this size a file shrinking is ordinary editing, not a sign of a
/// hollow download.
const SHRINK_FLOOR: usize = 1024;

/// Whether replacing `local` with `remote` (`None`: deleting it) loses most
/// of a non-empty file: emptied, dropped, or cut below a quarter of its size.
pub(super) fn wipes_out(local: &[u8], remote: Option<&[u8]>) -> bool {
    match remote {
        _ if local.is_empty() => false,
        None => true,
        Some(remote) => {
            remote.is_empty() || (local.len() >= SHRINK_FLOOR && remote.len() < local.len() / 4)
        }
    }
}

/// Everything a sync would do, decided but not yet done.
#[derive(Default)]
pub(super) struct SyncPlan {
    /// Remote content to write locally (path → bytes).
    pub pull: Vec<(String, Vec<u8>)>,
    /// Paths to upload from the local snapshot.
    pub push: Vec<String>,
    /// Cleanly merged content (path → merged bytes); also uploaded.
    pub merge: Vec<(String, Vec<u8>)>,
    pub conflict: Vec<ConflictPlan>,
    pub delete_local: Vec<String>,
    pub skipped_remote_deletes: Vec<String>,
    /// Pulls and deletions held for confirmation; until then each keeps its
    /// unchanged local hash in `files`.
    pub destructive: Vec<Destructive>,
    /// Post-sync hashes for every surviving path.
    pub files: BTreeMap<String, String>,
}

impl SyncPlan {
    /// Turn the destructive changes `confirmed` vouches for into ordinary
    /// pulls and deletions; return the rest, which stay out.
    ///
    /// A path is confirmed by itself or by a folder above it, since Overleaf
    /// records a folder rename or deletion only under the folder's name.
    fn settle_destructive(&mut self, confirmed: &BTreeSet<String>) -> Vec<String> {
        let vouched = |path: &str| {
            confirmed.contains(path)
                || path.match_indices('/').any(|(at, _)| confirmed.contains(&path[..at]))
        };
        let mut refused = Vec::new();
        for Destructive { path, remote } in std::mem::take(&mut self.destructive) {
            match remote {
                _ if !vouched(&path) => refused.push(path),
                Some(bytes) => {
                    self.files.insert(path.clone(), sha256_hex(&bytes));
                    self.pull.push((path, bytes));
                }
                None => {
                    self.files.remove(&path);
                    self.delete_local.push(path);
                }
            }
        }
        // Callers report every list in path order.
        self.pull.sort_by(|a, b| a.0.cmp(&b.0));
        self.delete_local.sort();
        refused
    }
}

/// Decide what a sync would do. Reads base copies from disk, writes nothing.
///
/// `live` holds paths the realtime channel is currently editing. Those are
/// converging through operations already, so this leaves them alone entirely.
pub(super) fn plan_sync(
    root: &Path, state: &SyncState, remote: &BTreeMap<String, Vec<u8>>,
    local: &BTreeMap<String, Vec<u8>>, live: &BTreeSet<String>, stamp: &str,
) -> Result<SyncPlan, String> {
    if !state.pending_relocations.is_empty() {
        return Err(
            "Sync pending file moves with Overleaf before comparing file contents.".to_string()
        );
    }
    let mut all_paths: BTreeSet<&String> = remote.keys().collect();
    all_paths.extend(local.keys());
    all_paths.extend(state.files.keys());

    let mut plan = SyncPlan::default();
    for path in all_paths {
        let base_hash = state.files.get(path);
        match (remote.get(path), local.get(path)) {
            (Some(rb), Some(lb)) if rb == lb => {
                plan.files.insert(path.clone(), sha256_hex(rb));
            }
            // The live channel owns this document. Sending our copy up over
            // REST would land on Overleaf as an out-of-band overwrite — that is
            // what raises "Document Updated Externally" for everyone else in
            // the project — and writing their copy down would fight the editor
            // buffer. Operations reconcile both sides; leave them to it.
            (Some(_), Some(_)) if live.contains(path) => {
                if let Some(base) = base_hash {
                    plan.files.insert(path.clone(), base.clone());
                }
            }
            (Some(rb), Some(lb)) => {
                let remote_hash = sha256_hex(rb);
                let local_hash = sha256_hex(lb);
                let remote_changed = base_hash != Some(&remote_hash);
                let local_changed = base_hash != Some(&local_hash);
                if remote_changed && !local_changed {
                    if wipes_out(lb, Some(rb)) {
                        plan.destructive
                            .push(Destructive { path: path.clone(), remote: Some(rb.clone()) });
                        plan.files.insert(path.clone(), local_hash);
                    } else {
                        plan.pull.push((path.clone(), rb.clone()));
                        plan.files.insert(path.clone(), remote_hash);
                    }
                    continue;
                }
                if local_changed && !remote_changed {
                    plan.push.push(path.clone());
                    plan.files.insert(path.clone(), local_hash);
                    continue;
                }
                // Both sides changed. Combine them line by line against the
                // copy we kept at the last sync, so edits to different parts of
                // a file simply merge — only genuinely overlapping edits need a
                // human.
                let (markers, resolved) = match merge_three_way(root, path, rb, lb) {
                    MergeOutcome::Clean(merged) => {
                        plan.files.insert(path.clone(), sha256_hex(&merged));
                        // Overleaf still holds only their half, so send the
                        // combined file back up to converge both sides.
                        plan.merge.push((path.clone(), merged));
                        continue;
                    }
                    // Markers land in the file itself so the disagreement is
                    // visible exactly where it happened.
                    MergeOutcome::Conflicted(conflicted) => (true, conflicted),
                    // Binary, or no base copy to merge against: keep both,
                    // remote on the real path.
                    MergeOutcome::Unmergeable => (false, rb.clone()),
                };
                // The untouched local version is kept beside it. Base is their
                // version: once the markers are resolved the file counts as a
                // local edit again and goes up on the next sync.
                plan.conflict.push(ConflictPlan {
                    path: path.clone(),
                    markers,
                    resolved,
                    local: lb.clone(),
                    local_copy: conflict_copy_name(path, stamp),
                });
                plan.files.insert(path.clone(), remote_hash);
            }
            (Some(rb), None) => {
                let remote_hash = sha256_hex(rb);
                if base_hash == Some(&remote_hash) {
                    // Deleted locally while remote is unchanged: we never
                    // delete remote files in v1, but we also stop resurrecting
                    // the file locally — drop it from state.
                    plan.skipped_remote_deletes.push(path.clone());
                } else {
                    // New on remote, or deleted locally while remote moved on
                    // (remote wins): pull it.
                    plan.pull.push((path.clone(), rb.clone()));
                    plan.files.insert(path.clone(), remote_hash);
                }
            }
            (None, Some(lb)) => {
                let local_hash = sha256_hex(lb);
                if base_hash == Some(&local_hash) {
                    // Deleted on remote while local is unchanged: delete it,
                    // once history confirms the download is not just missing
                    // it.
                    if wipes_out(lb, None) {
                        plan.destructive.push(Destructive { path: path.clone(), remote: None });
                        plan.files.insert(path.clone(), local_hash);
                    } else {
                        plan.delete_local.push(path.clone());
                    }
                } else {
                    // New locally, or deleted remotely after local edits
                    // (upload restores it remotely): push it.
                    plan.push.push(path.clone());
                    plan.files.insert(path.clone(), local_hash);
                }
            }
            // Present only in state: deleted on both sides, forget it.
            (None, None) => {}
        }
    }
    Ok(plan)
}

/// The remote snapshot a sync or preview works from: the project zip, minus
/// everything that never syncs, plus the app-owned leftovers to delete.
pub(super) struct RemoteFiles {
    pub files: BTreeMap<String, Vec<u8>>,
    pub automatic_remote_deletes: Vec<String>,
}

pub(super) fn fetch_remote_files(remote: &Remote) -> Result<RemoteFiles, String> {
    let Remote { host, session, state } = remote;
    let zip_bytes =
        download_project_zip(&http_client(120)?, host, &session.cookie, &state.project_id)?;
    let entries = read_zip_entries(&zip_bytes)?;
    // The realtime tree owns entity ids, so the sync cannot delete these
    // itself. Return app-owned leftovers for the frontend to remove; collapse
    // PDF renders to their stable parent folder so cleanup takes one request.
    // Until deletion succeeds, filtering below also prevents a pull.
    let mut automatic_remote_deletes: Vec<String> =
        entries.keys().filter(|path| is_latex_save_error_path(path)).cloned().collect();
    if entries.keys().any(|path| is_transient_pdf_render_path(path)) {
        automatic_remote_deletes.push(TRANSIENT_PDF_RENDER_DIRECTORY.to_string());
    }
    automatic_remote_deletes.sort();
    let files = entries.into_iter().filter(|(path, _)| !is_excluded(path)).collect();
    Ok(RemoteFiles { files, automatic_remote_deletes })
}

/// How far before the last sync the history check also looks, so clock skew
/// between this machine and Overleaf cannot hide a change made just before it.
const HISTORY_SLACK_MS: i64 = 10 * 60 * 1000;

/// Settle the plan's destructive changes against Overleaf's history: each one
/// goes ahead when an update since the last sync (or since the sync before
/// its first refusal) touched the path, and is refused otherwise, logged and
/// returned with the time its refusal window opened.
///
/// An unreadable history refuses them all. Holding a file back costs one more
/// sync; writing a hollow download over it costs the file.
pub(super) fn settle_destructive(remote: &Remote, plan: &mut SyncPlan) -> BTreeMap<String, String> {
    if plan.destructive.is_empty() {
        return BTreeMap::new();
    }
    let state = &remote.state;
    let opened = |path: &str| state.refused_since.get(path).or(state.last_sync.as_ref()).cloned();
    let windows: Vec<Option<String>> =
        plan.destructive.iter().map(|change| opened(&change.path)).collect();
    // One read covers them all: from the earliest window, or the whole
    // history when one has no sync to start from.
    let since_ms = windows
        .iter()
        .map(|at| {
            let at = chrono::DateTime::parse_from_rfc3339(at.as_deref()?).ok()?;
            Some(at.timestamp_millis() - HISTORY_SLACK_MS)
        })
        .collect::<Option<Vec<i64>>>()
        .and_then(|starts| starts.into_iter().min());
    let confirmed = paths_changed_since(remote, since_ms).unwrap_or_else(|error| {
        log::warn!(target: "lattice::overleaf", "Could not read Overleaf's history to confirm destructive changes: {error}");
        BTreeSet::new()
    });
    let refused = plan.settle_destructive(&confirmed);
    (refused.into_iter())
        .map(|path| {
            log::warn!(
                target: "lattice::overleaf",
                "Kept {path}: Overleaf's download has it empty, much smaller or missing, \
                 and Overleaf's history records no change to it since the last sync"
            );
            let since = opened(&path).unwrap_or_else(now_iso);
            (path, since)
        })
        .collect()
}

pub(super) fn sync_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M").to_string()
}

// ---- Sync ---------------------------------------------------------------------

/// Keep the merge-base tree aligned with the hashes that will be persisted.
///
/// Most successful paths now match the bytes on disk. A conflicted path is
/// the exception: the disk copy has markers while its recorded common
/// ancestor is Overleaf's snapshot. Live-held paths may match neither and
/// deliberately keep their previous base.
pub(super) fn finalize_base_copies(
    root: &Path, previous_files: &BTreeMap<String, String>, next_files: &BTreeMap<String, String>,
    remote: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    for (path, expected_hash) in next_files {
        let disk = fs::read(disk_path(root, path)).ok();
        let agreed = (disk.as_ref().filter(|bytes| sha256_hex(bytes) == *expected_hash))
            .or_else(|| remote.get(path).filter(|bytes| sha256_hex(bytes) == *expected_hash));
        if let Some(bytes) = agreed {
            write_base_copy(root, path, bytes)?;
        }
    }
    // Retain an old base while either side still has the file. A local edit
    // held back by read-only/unknown permission still needs that ancestor when
    // write access returns.
    for path in previous_files.keys() {
        if !next_files.contains_key(path)
            && !disk_path(root, path).exists()
            && !remote.contains_key(path)
        {
            remove_base_copy(root, path);
        }
    }
    Ok(())
}

pub fn sync(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>, observed_remote_version: Option<i64>,
) -> Result<OverleafSyncResult, String> {
    let linked = Remote::open_for_sync(config_dir, root)?;
    let (client, csrf) = linked.csrf_client(30)?;

    // Where Overleaf's history stood when we took our copy. Comparing it again
    // just before uploading tells us whether anyone edited in the meantime.
    let remote_version_before = linked
        .version(&client)
        // The cheap probe that requested this sync is an observed lower
        // bound for the snapshot. Preserve it when the best-effort repeat
        // is rate-limited instead of erasing a usable baseline.
        .or(observed_remote_version)
        .or(linked.state.remote_version);
    let RemoteFiles { files: remote, automatic_remote_deletes } = fetch_remote_files(&linked)?;
    let LocalFiles { files: local, oversized } = read_local_files(root)?;
    let mut plan = plan_sync(root, &linked.state, &remote, &local, live, &sync_stamp())?;
    let refused_since = settle_destructive(&linked, &mut plan);

    let mut result = OverleafSyncResult {
        refused_incoming: refused_since.keys().cloned().collect(),
        skipped_large: oversized,
        automatic_remote_deletes,
        skipped_remote_deletes: plan.skipped_remote_deletes,
        ..Default::default()
    };
    let mut new_files = plan.files;
    for (path, bytes) in &plan.pull {
        write_local_file(root, path, bytes)?;
        result.pulled.push(path.clone());
    }
    // Merged bytes exist on disk but not in the `local` snapshot taken at the
    // start of this sync; uploads read from here first.
    let mut merged_content: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for (path, bytes) in plan.merge {
        write_local_file(root, &path, &bytes)?;
        result.merged.push(path.clone());
        merged_content.insert(path, bytes);
    }
    for conflict in &plan.conflict {
        write_local_file(root, &conflict.local_copy, &conflict.local)?;
        write_local_file(root, &conflict.path, &conflict.resolved)?;
        result.conflicts.push(conflict.reported());
    }
    for path in &plan.delete_local {
        fs::remove_file(disk_path(root, path))
            .map_err(|e| format!("Could not delete {path}: {e}"))?;
        result.deleted_local.push(path.clone());
    }

    // Plain pushes and merged files both go up.
    let mut to_push: Vec<String> = plan.push;
    to_push.extend(merged_content.keys().cloned());
    to_push.sort();
    let upload_bytes = |path: &String| merged_content.get(path).or_else(|| local.get(path));

    // A reviewer or a viewer may read the project and not change it. Trying
    // anyway would be rejected file by file and reported as a sync failure,
    // when in fact everything that could be done has been: incoming work is
    // already on disk above, and the local edits simply stay here.
    let writable = permits_writing(linked.state.permission.as_deref());
    // Never hand Overleaf a file whose conflict markers are still unresolved —
    // that would publish the markers to everyone else in the project.
    let (mut to_push, held_back): (Vec<String>, Vec<String>) = if writable {
        to_push
            .into_iter()
            .partition(|path| !upload_bytes(path).is_some_and(|b| has_conflict_markers(b)))
    } else {
        (Vec::new(), to_push)
    };
    // Held-back paths stay out of state too, so they count as local edits and
    // upload as soon as they can.
    for path in &held_back {
        new_files.remove(path);
    }

    // Overleaf may have moved on between the copy we planned against and now —
    // someone typing in the web editor while we worked. Uploading then replaces
    // whatever they just wrote (and is what makes Overleaf warn them their
    // recent changes may have been overwritten). Stand down instead: dropping
    // these paths from state marks them as local edits again, so the next sync
    // merges their work first and sends the combined result.
    if !to_push.is_empty()
        && remote_version_before.is_some()
        && linked.version(&client) != remote_version_before
    {
        for path in to_push.drain(..) {
            new_files.remove(&path);
        }
    }
    if !to_push.is_empty() {
        let uploader = linked.uploader(&client, &csrf)?;
        for path in &to_push {
            let bytes = upload_bytes(path)
                .cloned()
                .ok_or_else(|| format!("{path} disappeared during sync"))?;
            uploader.upload(path, bytes)?;
        }
    }
    result.pushed = to_push;
    result.read_only = !writable;

    // Record what both sides now agree on: this is the common ancestor the
    // next sync merges against.
    let mut state = linked.state;
    finalize_base_copies(root, &state.files, &new_files, &remote)?;
    state.files = new_files;
    state.refused_since = refused_since;
    state.last_sync = Some(now_iso());
    // `remote_version_before` is the only history position known to precede
    // the downloaded snapshot. Never replace it with a newer value fetched at
    // the end: that newer value may include a collaborator's edit which is not
    // in the zip we materialized as the new base.
    //
    // Uploads advance history themselves, but Overleaf does not return the
    // resulting project version. Leave it unknown so the next probe performs
    // one verification sync instead of attributing an unverified latest
    // version to our upload.
    state.remote_version = if result.pushed.is_empty() { remote_version_before } else { None };
    save_state(root, &state)?;
    // Every list is already in path order: the plan walks paths sorted.
    Ok(result)
}

// ---- Preview -------------------------------------------------------------------

/// Text we can show in a diff view. Anything else is treated as binary: the UI
/// gets a marker instead of the bytes.
pub(super) fn displayable_text(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

/// Build one preview row. A side that exists but cannot be rendered as text
/// makes the whole change binary, and then neither side is shipped to the UI.
fn preview_change(
    path: &str, kind: &str, before: Option<&[u8]>, after: Option<&[u8]>,
) -> OverleafChange {
    let before_text = before.map(displayable_text);
    let after_text = after.map(displayable_text);
    let binary = matches!(before_text, Some(None)) || matches!(after_text, Some(None));
    OverleafChange {
        path: path.to_string(),
        kind: kind.to_string(),
        before: if binary { None } else { before_text.flatten() },
        after: if binary { None } else { after_text.flatten() },
        binary,
    }
}

/// Dry run: what `sync` would do to this project, without doing any of it.
///
/// Same fetch and the same classification as `sync`, so what the user approves
/// is exactly what runs. Nothing here writes to disk or uploads: the CSRF token
/// a real sync needs for uploads is not even fetched.
pub fn preview(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>,
) -> Result<OverleafPreview, String> {
    let mut linked = Remote::open(config_dir, root)?;
    linked.state.files.retain(|path, _| !is_excluded(path));
    let remote = fetch_remote_files(&linked)?.files;
    let local = read_local_files(root)?.files;
    let mut plan = plan_sync(root, &linked.state, &remote, &local, live, &sync_stamp())?;
    let refused = settle_destructive(&linked, &mut plan);

    let local_bytes = |path: &str| local.get(path).map(Vec::as_slice);
    // Conflicts first — they are the only rows that need a decision — then
    // the rest in the order the user reads them.
    let mut changes: Vec<OverleafChange> = (plan.conflict.iter())
        .map(|c| preview_change(&c.path, "conflict", Some(&c.local), Some(&c.resolved)))
        .collect();
    for path in refused.keys() {
        let after = remote.get(path).map(Vec::as_slice);
        changes.push(preview_change(path, "refusedIncoming", local_bytes(path), after));
    }
    let pulled = plan.pull.iter().map(|(path, bytes)| (path, "incoming", Some(bytes.as_slice())));
    let merged = plan.merge.iter().map(|(path, bytes)| (path, "merge", Some(bytes.as_slice())));
    for (path, kind, after) in pulled.chain(merged) {
        changes.push(preview_change(path, kind, local_bytes(path), after));
    }
    for path in &plan.push {
        // The base copy is the last version Overleaf saw, so it is the honest
        // "before" for an upload — when we kept one.
        let base = read_base_copy(root, path);
        changes.push(preview_change(
            path,
            "outgoing",
            base.as_deref().map(str::as_bytes),
            local_bytes(path),
        ));
    }
    for path in &plan.delete_local {
        changes.push(preview_change(path, "deleteLocal", local_bytes(path), None));
    }
    for path in &plan.skipped_remote_deletes {
        changes.push(preview_change(path, "skippedRemoteDelete", None, None));
    }
    let rank = ["conflict", "refusedIncoming", "incoming", "merge", "outgoing", "deleteLocal"];
    let rank = |kind: &str| rank.iter().position(|k| *k == kind).unwrap_or(rank.len());
    changes.sort_by(|a, b| rank(&a.kind).cmp(&rank(&b.kind)).then_with(|| a.path.cmp(&b.path)));

    Ok(OverleafPreview { changes, remote_version: linked.version(&http_client(30)?) })
}

// ---- Probe ---------------------------------------------------------------------

/// Cheap "did anything change over there?" check.
///
/// Overleaf's history API reports the project's newest version in a small JSON
/// payload, so this can run every few seconds — unlike a full sync, which
/// downloads the whole project as a zip. Live mode polls this and only syncs
/// for real when the version moved.
pub fn probe(
    config_dir: &Path, root: &Path, local_live_paths: Option<&BTreeSet<String>>,
) -> Result<OverleafProbe, String> {
    let remote = Remote::open(config_dir, root)?;
    let state = &remote.state;
    let local_changed = !state.pending_relocations.is_empty()
        || local_live_paths
            .map(|live| local_files_changed(root, state, live))
            .transpose()?
            .unwrap_or(false);
    let response = remote.get("/updates?min_count=1", 15)?;
    let body: Value = expect_success(response, "for the project history")?.json().map_err(err)?;
    let remote_version = latest_update_version(&body);
    Ok(OverleafProbe {
        changed: match (remote_version, state.remote_version) {
            (Some(remote), Some(known)) => remote != known,
            // First look with a usable version: sync once to set the baseline.
            (Some(_), None) => true,
            // No version to compare. Saying "changed" here would download the
            // whole project on every poll, which is what earned a 429.
            (None, _) => false,
        },
        local_changed,
        version_known: remote_version.is_some(),
        remote_version,
        last_sync: remote.state.last_sync,
    })
}

// ---- Relocations -----------------------------------------------------------------

fn relocated_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    let suffix = path.strip_prefix(from).filter(|suffix| suffix.starts_with('/'))?;
    Some(format!("{to}{suffix}"))
}

/// Replay explicit local relocations before taking the remote content
/// snapshot. Requests address existing ids, preserving comments, history and
/// rootDoc_id. A failed/ambiguous request leaves the intent in state and stops
/// content sync; it must never fall back to upload-and-delete.
pub fn sync_relocations(
    config_dir: &Path, root: &Path, entities: Option<Vec<EntityEntry>>,
) -> Result<(), String> {
    let mut state = load_state(root)?;
    if state.pending_relocations.is_empty() {
        return Ok(());
    }
    if state.paused {
        return Err(PAUSED.to_string());
    }
    if !permits_writing(state.permission.as_deref()) {
        return Err(
            "Overleaf write access is required to sync moved files. Local moves have been kept."
                .to_string(),
        );
    }
    let mut entities = entities.ok_or_else(|| {
        "Waiting for Overleaf's live file tree before syncing moved files.".to_string()
    })?;
    let session = load_session(config_dir)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(20)?;
    let csrf = csrf_token(&client, &host, &session.cookie)?;
    let project_id = state.project_id.clone();
    let post = |route: &str, body: Value| {
        let request = (client.post(format!("{host}/project/{project_id}/{route}")))
            .header(COOKIE, &session.cookie)
            .header("X-Csrf-Token", &csrf)
            .json(&body);
        let what = "while syncing a file move. The move will be retried";
        expect_success(send_as(request, err)?, what)
    };
    while let Some(change) = state.pending_relocations.first().cloned() {
        let entity = (entities.iter())
            .find(|entry| match &change.entity_id {
                Some(id) => &entry.id == id,
                None => entry.path == change.from,
            })
            .cloned();
        let Some(entity) = entity else {
            // A never-uploaded local file has no remote identity to preserve.
            // A previously synced file missing remotely is a conflict, not
            // permission to invent a replacement id.
            if change.entity_id.is_some()
                || state
                    .files
                    .keys()
                    .any(|path| relocated_path(path, &change.from, &change.to).is_some())
            {
                return Err(format!(
                    "Could not locate {} on Overleaf to sync its move. No files were deleted.",
                    change.from
                ));
            }
            state.pending_relocations.remove(0);
            save_state(root, &state)?;
            continue;
        };
        if entity.path != change.from && entity.path != change.to {
            return Err(format!(
                "{} was also moved on Overleaf. Resolve the conflicting locations before syncing.",
                change.from
            ));
        }
        if entities.iter().any(|other| other.path == change.to && other.id != entity.id) {
            return Err(format!(
                "{} already exists on Overleaf. No files were overwritten.",
                change.to
            ));
        }
        // Persist identity BEFORE the network call. If its response is lost,
        // the next live tree can prove the same entity is already at `to`.
        state.pending_relocations[0].entity_id = Some(entity.id.clone());
        save_state(root, &state)?;
        if entity.path != change.to {
            let (from_parent, from_name) =
                change.from.rsplit_once('/').unwrap_or(("", &change.from));
            let (to_parent, to_name) = change.to.rsplit_once('/').unwrap_or(("", &change.to));
            let entity_route = format!("{}/{}", entity.kind, entity.id);
            if from_parent == to_parent {
                post(&format!("{entity_route}/rename"), json!({"name": to_name}))?;
            } else {
                // Each local operation is either a rename or a move, never
                // both. Preserve operation order for chained offline edits.
                if from_name != to_name {
                    return Err("A pending Overleaf move also changes its name.".to_string());
                }
                let mut folder_id = state.root_folder_id.clone().ok_or_else(|| {
                    "Overleaf has not supplied the root folder id yet.".to_string()
                })?;
                let mut parents = Vec::new();
                for name in to_parent.split('/').filter(|part| !part.is_empty()) {
                    parents.push(name);
                    let folder_path = parents.join("/");
                    if let Some(folder) = entities.iter().find(|entry| entry.path == folder_path) {
                        if folder.kind != "folder" {
                            return Err(format!("{folder_path} is not a folder on Overleaf."));
                        }
                        folder_id = folder.id.clone();
                        continue;
                    }
                    let body = json!({ "name": name, "parent_folder_id": folder_id });
                    let created: Value = post("folder", body)?.json().map_err(err)?;
                    folder_id = json_str(&created, &["_id"])
                        .ok_or_else(|| "Overleaf created no folder.".to_string())?;
                    entities.push(EntityEntry {
                        id: folder_id.clone(),
                        path: folder_path.clone(),
                        kind: "folder".to_string(),
                    });
                }
                post(&format!("{entity_route}/move"), json!({"folder_id": folder_id}))?;
            }
        }
        // Keep the original common ancestor, not the edited local bytes, so
        // concurrent remote edits still merge after a move (including folders).
        let remapped: Vec<_> = (state.files.iter())
            .filter_map(|(path, hash)| {
                relocated_path(path, &change.from, &change.to)
                    .map(|next| (path.clone(), next, hash.clone()))
            })
            .collect();
        for (old, new, hash) in &remapped {
            if let Some(base) = read_base_copy(root, old) {
                write_base_copy(root, new, base.as_bytes())?;
            }
            state.files.remove(old);
            state.files.insert(new.clone(), hash.clone());
        }
        state.pending_relocations.remove(0);
        state.remote_version = None;
        save_state(root, &state)?;
        for (old, _, _) in remapped {
            remove_base_copy(root, &old);
        }
        if entity.path != change.to {
            for entry in &mut entities {
                if let Some(path) = relocated_path(&entry.path, &change.from, &change.to) {
                    entry.path = path;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
