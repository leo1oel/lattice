//! Sync against the project ZIP: the cheap remote-change probe, the plan that
//! classifies every file, the sync that carries it out, and the dry-run preview
//! of it. The replay of local moves that must come first is in `relocations`.
//!
//! Classification and execution are deliberately separate: the exact same
//! decisions drive a real sync, the read-only preview the user sees before
//! committing to one, and the staged sync, so there is only ever one set of
//! rules to keep honest.

use super::api::{
    csrf_token, download_project_zip, expect_success, folders_above, http_client,
    latest_update_version, read_zip_entries, DownloadProgress, Remote,
};
use super::case_collisions::{self, CaseCollision};
use super::files::*;
use super::link::{now_iso, save_state, Refusal, SyncState, PAUSED};
use super::review::{history_since, HistoryFrom};
use crate::overleaf_rt::{NOT_CONNECTED, SESSION_EXPIRED, SESSION_STILL_VALID};
use crate::util::err;
use crate::wide_event::{self, Failure};
use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

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

/// An incoming change that would wipe out a file here: Overleaf's copy is
/// empty or a fraction of ours.
///
/// "Changed there" is normally a pull, or a merge with what changed here. But
/// on 2026-10-01 Overleaf's project download carried 0-byte entries for a
/// hundred files nobody had touched, and taking it at its word emptied them
/// all on disk. So a change like this waits for Overleaf's own history to
/// confirm someone made it. Until then the local file stands, and an edit made
/// here goes up as if Overleaf had not changed.
pub(super) struct Destructive {
    pub path: String,
    /// Overleaf's bytes.
    pub remote: Vec<u8>,
    /// For a file edited here too, how it combines with Overleaf's copy once
    /// confirmed; `None` for a plain pull.
    pub merged: Option<Merged>,
}

/// A file both sides changed, combined.
pub(super) enum Merged {
    Clean(Vec<u8>),
    Conflict(ConflictPlan),
}

/// Below this size a file shrinking is ordinary editing, not a sign of a
/// hollow download.
const SHRINK_FLOOR: usize = 1024;

/// Whether replacing `local` with `remote` loses most of a non-empty file:
/// emptied, or cut below a quarter of its size.
pub(super) fn wipes_out(local: &[u8], remote: &[u8]) -> bool {
    !local.is_empty()
        && (remote.is_empty() || (local.len() >= SHRINK_FLOOR && remote.len() < local.len() / 4))
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
    /// See `OverleafSyncResult::unresolved_conflicts`.
    pub unresolved_conflicts: Vec<String>,
    /// Pulls and merges held for confirmation; until then each keeps its local
    /// hash in `files`.
    pub destructive: Vec<Destructive>,
    /// Post-sync hashes for every surviving path.
    pub files: BTreeMap<String, String>,
}

impl SyncPlan {
    /// Carry out a merge of a file both sides changed.
    fn take_merge(&mut self, path: String, merged: Merged, remote_hash: String) {
        match merged {
            Merged::Clean(merged) => {
                self.files.insert(path.clone(), sha256_hex(&merged));
                // Overleaf still holds only their half, so send the combined
                // file back up to converge both sides.
                self.merge.push((path, merged));
            }
            // Base is their version: once the markers are resolved the file
            // counts as a local edit again and goes up on the next sync.
            Merged::Conflict(conflict) => {
                self.files.insert(path, remote_hash);
                self.conflict.push(conflict);
            }
        }
    }

    /// Turn the destructive changes `confirmed` vouches for into ordinary
    /// pulls and merges; return the rest, which stay out, a local edit among
    /// them going up instead.
    fn settle_destructive(&mut self, confirmed: impl Fn(&str) -> bool) -> Vec<Destructive> {
        let mut refused = Vec::new();
        for change in std::mem::take(&mut self.destructive) {
            let Destructive { path, remote, merged } = change;
            match merged {
                _ if !confirmed(&path) => {
                    if merged.is_some() {
                        self.push.push(path.clone());
                    }
                    refused.push(Destructive { path, remote, merged: None });
                }
                Some(merged) => self.take_merge(path, merged, sha256_hex(&remote)),
                None => {
                    self.files.insert(path.clone(), sha256_hex(&remote));
                    self.pull.push((path, remote));
                }
            }
        }
        // Callers report every list in path order.
        self.pull.sort_by(|a, b| a.0.cmp(&b.0));
        self.push.sort();
        self.merge.sort_by(|a, b| a.0.cmp(&b.0));
        self.conflict.sort_by(|a, b| a.path.cmp(&b.path));
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
                if local_changed && !remote_changed {
                    plan.push.push(path.clone());
                    plan.files.insert(path.clone(), local_hash);
                    continue;
                }
                // Still marked up from an earlier conflict, and Overleaf moved
                // on again (a co-author still typing). The markers' "theirs"
                // is the recorded base; keep it, and the file, until the
                // writer resolves it. Merging now would wrap these markers in
                // a second set and overwrite the untouched local copy.
                if local_changed && has_conflict_markers(lb) {
                    if let Some(base) = base_hash {
                        plan.files.insert(path.clone(), base.clone());
                    }
                    plan.unresolved_conflicts.push(path.clone());
                    continue;
                }
                // Changed there. When both sides changed, combine them line
                // by line against the copy we kept at the last sync, so edits
                // to different parts of a file simply merge — only genuinely
                // overlapping edits need a human.
                let merged = local_changed.then(|| {
                    let (markers, resolved) = match merge_three_way(root, path, rb, lb) {
                        MergeOutcome::Clean(merged) => return Merged::Clean(merged),
                        // Markers land in the file itself so the disagreement
                        // is visible exactly where it happened.
                        MergeOutcome::Conflicted(conflicted) => (true, conflicted),
                        // Binary, or no base copy to merge against: keep both,
                        // remote on the real path.
                        MergeOutcome::Unmergeable => (false, rb.clone()),
                    };
                    // The untouched local version is kept beside it.
                    Merged::Conflict(ConflictPlan {
                        path: path.clone(),
                        markers,
                        resolved,
                        local: lb.clone(),
                        local_copy: conflict_copy_name(path, stamp, |name| {
                            disk_path(root, name).exists()
                        }),
                    })
                });
                if wipes_out(lb, rb) {
                    plan.files.insert(path.clone(), local_hash);
                    let (path, remote) = (path.clone(), rb.clone());
                    plan.destructive.push(Destructive { path, remote, merged });
                    continue;
                }
                match merged {
                    Some(merged) => plan.take_merge(path.clone(), merged, remote_hash),
                    None => {
                        plan.pull.push((path.clone(), rb.clone()));
                        plan.files.insert(path.clone(), remote_hash);
                    }
                }
            }
            (Some(rb), None) => {
                let remote_hash = sha256_hex(rb);
                if base_hash == Some(&remote_hash) {
                    // Deleted here, unchanged on Overleaf. The writer's
                    // setting decides that copy; keeping its hash is what
                    // stops the next sync pulling the file back as new.
                    plan.skipped_remote_deletes.push(path.clone());
                } else {
                    // New on remote, or deleted locally while remote moved on
                    // (remote wins): pull it.
                    plan.pull.push((path.clone(), rb.clone()));
                }
                plan.files.insert(path.clone(), remote_hash);
            }
            (None, Some(lb)) => {
                let local_hash = sha256_hex(lb);
                if base_hash == Some(&local_hash) {
                    // Deleted on remote while local is unchanged: delete it.
                    plan.delete_local.push(path.clone());
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
    /// Live documents whose copy in `files` Overleaf has since moved past
    /// (see `SyncState::unsettled`); a download has none.
    pub unsettled: BTreeSet<String>,
}

pub(super) fn fetch_remote_files(
    remote: &Remote, client: &Client, progress: DownloadProgress,
) -> Result<RemoteFiles, String> {
    let Remote { host, session, state } = remote;
    let zip_bytes =
        download_project_zip(client, host, &session.cookie, &state.project_id, progress)?;
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
    let files = syncable(entries);
    Ok(RemoteFiles { files, automatic_remote_deletes, unsettled: BTreeSet::new() })
}

/// Overleaf's copy of the project without downloading it, when its history
/// proves the copy the last sync agreed on is still Overleaf's copy of every
/// file this sync may touch.
///
/// The download is most of what a sync costs: Overleaf zips the whole project
/// on every request, figures and all, and most syncs then find nothing new in
/// it. They run because an upload or typing in a live document moved the
/// project's version, not because anyone changed a file. So when the version
/// has not moved since the agreed copy, or every update since then only edited
/// documents the realtime channel holds (which a sync leaves alone anyway),
/// the agreed copy stands — and it is already on disk, each file either
/// unchanged here or kept as its merge base. It must have been exact when it
/// was recorded (see `SyncState::unsettled`), with every document it was not
/// exact for still live. Any file that cannot be rebuilt from disk byte for
/// byte, any change to the project tree, any update the history cannot place,
/// and a held hollow copy (re-checked against every download) all mean
/// downloading after all.
pub(super) fn agreed_remote_files(
    remote: &Remote, client: &Client, root: &Path, version: Option<i64>,
    local: &BTreeMap<String, Vec<u8>>, live: &BTreeSet<String>,
) -> Option<RemoteFiles> {
    let state = &remote.state;
    let (Some(agreed), Some(version)) = (state.remote_version, version) else { return None };
    // A live document the sync leaves alone: present on both sides, so no
    // pull, push or deletion can come of it either.
    let held_live = |path: &String| {
        live.contains(path) && local.contains_key(path) && state.files.contains_key(path)
    };
    let mut unsettled = state.unsettled.clone()?;
    if version < agreed || !state.refused.is_empty() || !unsettled.iter().all(held_live) {
        return None;
    }
    if version > agreed {
        // Only live documents can excuse a move, so with none there is
        // nothing to ask the history.
        if live.is_empty() {
            return None;
        }
        let history = history_since(remote, client, |update| update.ends_after(agreed)).ok()?;
        // The history must reach the version just read, or it is missing
        // updates rather than proving there were none.
        let reaches = history.first().and_then(|update| update.to_version()) == Some(version);
        let only_live = (history.iter()).all(|update| {
            !update.tree && !update.paths.is_empty() && update.paths.iter().all(held_live)
        });
        if !reaches || !only_live {
            return None;
        }
        unsettled.extend(history.into_iter().flat_map(|update| update.paths));
    }
    let files = (state.files.iter())
        .map(|(path, hash)| {
            let agreed = |bytes: &Vec<u8>| sha256_hex(bytes) == *hash;
            let bytes = (local.get(path).filter(|bytes| agreed(bytes)).cloned())
                .or_else(|| read_base_copy(root, path).map(String::into_bytes).filter(agreed))?;
            Some((path.clone(), bytes))
        })
        .collect::<Option<_>>()?;
    Some(RemoteFiles { files, automatic_remote_deletes: Vec::new(), unsettled })
}

/// Where the agreed copy from the last sync stands in Overleaf's history: the
/// version it was downloaded at, or failing that the time of the sync.
fn agreed_copy(state: &SyncState) -> Option<HistoryFrom> {
    let version = state.agreed_version.or(state.remote_version);
    version.map(HistoryFrom::Version).or_else(|| {
        let at = chrono::DateTime::parse_from_rfc3339(state.last_sync.as_deref()?).ok()?;
        Some(HistoryFrom::Time(at.timestamp_millis()))
    })
}

/// Settle the plan's destructive changes against Overleaf's history: each one
/// goes ahead when an update missing from the last agreed copy (or from the
/// one before its first refusal), and not part of Lattice's own last write to
/// the path, touched the path; it is refused otherwise,
/// returned with where its refusal window opened and the copy it refused.
///
/// An unreadable history refuses them all. Holding a file back costs one more
/// sync; writing a hollow download over it costs the file.
pub(super) fn settle_destructive(
    remote: &Remote, client: &Client, plan: &mut SyncPlan,
) -> BTreeMap<String, Refusal> {
    if plan.destructive.is_empty() {
        return BTreeMap::new();
    }
    let state = &remote.state;
    let windows: BTreeMap<String, Option<HistoryFrom>> = (plan.destructive.iter())
        .map(|change| {
            let since = state.refused.get(&change.path).map(|refusal| refusal.since);
            (change.path.clone(), since.unwrap_or_else(|| agreed_copy(state)))
        })
        .collect();
    // One read covers them all, back to the earliest window.
    let history = (history_since(remote, client, |update| windows.values().any(|from| update.after(*from))))
        .unwrap_or_else(|error| {
            log::warn!(target: "lattice::overleaf", "Could not read Overleaf's history to confirm destructive changes: {error}");
            Vec::new()
        });
    // A path is confirmed by itself or by a folder above it, since Overleaf
    // records a folder rename or deletion only under the folder's name.
    let confirmed = |path: &str| {
        let names = |changed: &String| {
            (path.strip_prefix(changed.as_str()))
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        };
        let own = state.own_writes.get(path).copied();
        (history.iter()).any(|update| {
            update.after(windows[path])
                && !own.is_some_and(|own| update.within(own))
                && update.paths.iter().any(names)
        })
    };
    (plan.settle_destructive(confirmed).into_iter())
        .map(|Destructive { path, remote, .. }| {
            let since = windows[&path];
            (path, Refusal { since, remote: sha256_hex(&remote) })
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
/// ancestor is Overleaf's snapshot. So is a file edited again while its upload
/// was under way: the ancestor is what went up, which only `known` still
/// holds. Live-held paths may match neither and deliberately keep their
/// previous base. `known` is every other copy of a file this sync had in hand
/// — Overleaf's, and what it uploaded.
pub(super) fn finalize_base_copies(
    root: &Path, previous_files: &BTreeMap<String, String>, next_files: &BTreeMap<String, String>,
    known: &[&BTreeMap<String, Vec<u8>>],
) -> Result<(), String> {
    for (path, expected_hash) in next_files {
        let agreed = |bytes: &&Vec<u8>| sha256_hex(bytes) == *expected_hash;
        let disk = fs::read(disk_path(root, path)).ok();
        let bytes = (disk.as_ref().filter(agreed))
            .or_else(|| known.iter().find_map(|copies| copies.get(path).filter(agreed)));
        if let Some(bytes) = bytes {
            write_base_copy(root, path, bytes)?;
        }
    }
    // Retain an old base while either side still has the file. A local edit
    // held back by read-only/unknown permission still needs that ancestor when
    // write access returns.
    for path in previous_files.keys() {
        if !next_files.contains_key(path)
            && !disk_path(root, path).exists()
            && !known.iter().any(|copies| copies.contains_key(path))
        {
            remove_base_copy(root, path);
        }
    }
    Ok(())
}

/// What became of `path` on disk since this sync read it there.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SinceRead {
    /// It still holds what was read (`None`: it was absent), so writing over
    /// it or deleting it loses nothing.
    Unchanged,
    /// The file this sync read was edited or deleted: the next sync reads the
    /// change as the local edit it is.
    Edited,
    /// Something this sync never read sits there — a file too large, not a
    /// regular file, under a symlinked folder, or unreadable. It is left
    /// alone, but syncing again would find exactly the same, so it is no edit
    /// to report.
    Unread,
}

/// The editor's own saves wait for a sync to finish, but an agent or another
/// program writes whenever it likes. Its edit is newer than anything the plan
/// knows about, so a file changed since the read is left exactly as it is.
/// Only a file within the size limit is ever read, here as in the sync's own
/// read of the project.
fn since_read(root: &Path, path: &str, read: Option<&Vec<u8>>) -> SinceRead {
    let disk = disk_path(root, path);
    let meta = fs::symlink_metadata(&disk);
    let Some(read) = read else {
        return match meta {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SinceRead::Unchanged,
            _ => SinceRead::Unread,
        };
    };
    match meta {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_SYNC_FILE_BYTES => match fs::read(&disk) {
            Ok(bytes) if bytes == *read => SinceRead::Unchanged,
            _ => SinceRead::Edited,
        },
        _ => SinceRead::Edited,
    }
}

/// One sync's HTTP client. Every request of the sync goes through it, so they
/// share one connection instead of each paying for its own TLS handshake —
/// several round trips apiece over a slow or proxied link. The deadline is
/// what the project download allows a stall; quicker reads set their own.
fn sync_client() -> Result<Client, String> {
    http_client(120)
}

/// What a failed sync means for whoever reads the log.
pub fn classify_sync_error(error: &str) -> Failure {
    let error = error
        .strip_prefix("Failed to upload ")
        .and_then(|rest| rest.split_once(" to Overleaf: "))
        .map_or(error, |(_, cause)| cause);
    if error == SESSION_EXPIRED || error == NOT_CONNECTED {
        Failure {
            kind: "session_expired",
            fix: "Reconnect in Settings → Overleaf, then sync again.",
        }
    } else if error == SESSION_STILL_VALID {
        Failure {
            kind: "server_refused",
            fix: "Check the project still opens on Overleaf, then sync again.",
        }
    } else if error == PAUSED {
        Failure { kind: "paused", fix: "Resume syncing in Settings → Overleaf." }
    } else if error.starts_with("Could not reach Overleaf") {
        Failure { kind: "network", fix: "Check the connection (and any proxy), then sync again." }
    } else if error.starts_with("Overleaf returned") || error.starts_with("Overleaf rejected") {
        Failure {
            kind: "server_refused",
            fix: "Wait a minute and sync again; Overleaf may be busy.",
        }
    } else if error.contains("not linked") {
        Failure { kind: "not_linked", fix: "Link the project to Overleaf again." }
    } else if error.starts_with("Could not") && !error.contains("Overleaf") {
        Failure {
            kind: "local_io",
            fix: "Check the project folder is writable and the disk is not full.",
        }
    } else {
        Failure { kind: "sync_error", fix: "Sync again; if it repeats, report it with the log." }
    }
}

/// Lease-free reads ahead a sync makes before its last round, which takes
/// the lease and downloads under it if it must, so a link that keeps moving
/// during each download cannot keep a sync from finishing.
pub const READ_AHEAD_ROUNDS: usize = 2;

/// A whole sync as the app runs one, without the lease.
#[cfg(test)]
pub(super) fn sync(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>, observed_remote_version: Option<i64>,
) -> Result<OverleafSyncResult, String> {
    sync_meanwhile(config_dir, root, live, observed_remote_version, || {})
}

/// [`sync`], with `meanwhile` run between each read ahead and the rest of
/// its round, where the app lets file writes and live documents go on.
#[cfg(test)]
pub(super) fn sync_meanwhile(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>, observed_remote_version: Option<i64>,
    mut meanwhile: impl FnMut(),
) -> Result<OverleafSyncResult, String> {
    let mut round = 0;
    loop {
        round += 1;
        let read_ahead = round <= READ_AHEAD_ROUNDS;
        let prefetched = if read_ahead {
            prefetch(config_dir, root, live, observed_remote_version, &|_, _| {})?
        } else {
            None
        };
        meanwhile();
        if let Some(result) = sync_prefetched(
            config_dir,
            root,
            live,
            observed_remote_version,
            prefetched,
            !read_ahead,
        )? {
            return Ok(result);
        }
    }
}

/// The sync, under the project's exclusive lease, starting from what
/// [`prefetch`] read ahead of it. Downloads only when `may_download`: that
/// holds every file write here for the download's minutes, so only a sync's
/// last round may. Otherwise `None` when the sync needs Overleaf's copy and
/// nothing read ahead still fits; the caller lets go of the lease and reads
/// ahead again.
pub fn sync_prefetched(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>, observed_remote_version: Option<i64>,
    prefetched: Option<Prefetched>, may_download: bool,
) -> Result<Option<OverleafSyncResult>, String> {
    let result =
        sync_files(config_dir, root, live, observed_remote_version, prefetched, may_download)?;
    if let Some(result) = &result {
        record_result(result);
    }
    Ok(result)
}

/// The project download, timed and counted on the sync's wide event.
pub(super) fn download(
    remote: &Remote, client: &Client, progress: DownloadProgress,
) -> Result<RemoteFiles, String> {
    let step = wide_event::step("download");
    let downloaded = fetch_remote_files(remote, client, progress)?;
    drop(step);
    wide_event::record("download", "full");
    let bytes: usize = downloaded.files.values().map(Vec::len).sum();
    wide_event::record("remote_files", downloaded.files.len());
    wide_event::record("remote_bytes", bytes);
    Ok(downloaded)
}

fn sync_files(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>, observed_remote_version: Option<i64>,
    prefetched: Option<Prefetched>, may_download: bool,
) -> Result<Option<OverleafSyncResult>, String> {
    let linked = Remote::open_for_sync(config_dir, root)?;
    let client = sync_client()?;
    // Read here only now, under the lease: whatever changed while the
    // download ran is part of this sync rather than left for the next.
    let read = read_local_files(root)?;
    let mut live = live.clone();
    let prefetched = prefetched.and_then(|prefetched| {
        live.extend(prefetched.fits(&linked.state, &live, &read.files)?);
        Some(prefetched)
    });
    let live = &live;

    // Where Overleaf's history stood when we took our copy. Comparing it again
    // just before uploading tells us whether anyone edited in the meantime.
    // The cheap probe that requested this sync is an observed lower bound for
    // the snapshot: preserve it when the best-effort repeat is rate-limited.
    let version = match &prefetched {
        Some(prefetched) => prefetched.version,
        None => linked.version(&client).or(observed_remote_version),
    };
    let remote_version_before = version.or(linked.state.remote_version);
    let mut downloaded_under_lease = false;
    let (read, RemoteFiles { files: mut remote, automatic_remote_deletes, mut unsettled }) =
        match prefetched {
            Some(Prefetched { downloaded, .. }) => (read, downloaded),
            None => match agreed_remote_files(&linked, &client, root, version, &read.files, live) {
                Some(agreed) => {
                    wide_event::record("download", "skipped");
                    (read, agreed)
                }
                None if may_download => {
                    downloaded_under_lease = true;
                    let downloaded = download(&linked, &client, &|_, _| {})?;
                    // Read again after the download, as above.
                    (read_local_files(root)?, downloaded)
                }
                None => return Ok(None),
            },
        };
    let LocalFiles { files: mut local, oversized } = read;
    wide_event::record("local_files", local.len());
    // The table can never agree with Overleaf on a path set aside, so later
    // syncs download to see it again rather than trust the agreed copy.
    let (case_collisions, aside) =
        case_collisions::set_aside(&mut remote, &mut local, &linked.state.files);
    unsettled.extend(aside);
    let mut plan = plan_sync(root, &linked.state, &remote, &local, live, &sync_stamp())?;
    let mut refused = settle_destructive(&linked, &client, &mut plan);
    // Warn about a refused copy once; the same hollow download on every
    // later sync is not news.
    let refused_incoming: Vec<String> = (refused.iter())
        .filter(|(path, refusal)| {
            linked.state.refused.get(*path).map(|known| &known.remote) != Some(&refusal.remote)
        })
        .map(|(path, _)| path.clone())
        .collect();
    // Each is a file Overleaf's download has empty or much smaller, which its
    // history does not confirm; the result lists them, the event counts them.

    // A reviewer or a viewer may read the project and not change it. Trying
    // anyway would be rejected file by file and reported as a sync failure,
    // when in fact everything that could be done has been: incoming work is
    // landing below, and the local edits simply stay here.
    let writable = linked.state.access().can_write();
    // Uploads need the dashboard's CSRF token, which is a whole page of the
    // account's projects; fetch it only for a sync with something to send,
    // and before writing anything, so a dead session fails the sync whole.
    let csrf = (writable && !(plan.push.is_empty() && plan.merge.is_empty()))
        .then(|| csrf_token(&client, &linked.host, &linked.session.cookie))
        .transpose()?;

    let mut result = OverleafSyncResult {
        refused_incoming,
        skipped_large: oversized,
        automatic_remote_deletes,
        skipped_remote_deletes: plan.skipped_remote_deletes,
        unresolved_conflicts: plan.unresolved_conflicts,
        case_collisions,
        downloaded_under_lease,
        ..Default::default()
    };
    let mut new_files = plan.files;
    // A file changed here since it was read keeps the hash it had before this
    // sync: an edit on top of the old agreed copy, merged or sent next time.
    // The agreed version moves on regardless, so a download that would wipe
    // it out keeps the history window it was confirmed in, as a refusal does,
    // or the next sync would find the change unconfirmed and send the edit
    // up over it.
    let mut leave = |path: &String, new_files: &mut BTreeMap<String, String>, since| {
        let hash = linked.state.files.get(path);
        match hash {
            Some(hash) => new_files.insert(path.clone(), hash.clone()),
            None => new_files.remove(path),
        };
        if let (Some(read), Some(theirs)) = (local.get(path), remote.get(path)) {
            if wipes_out(read, theirs) {
                let since = (linked.state.refused.get(path))
                    .map_or_else(|| agreed_copy(&linked.state), |refusal| refusal.since);
                refused.insert(path.clone(), Refusal { since, remote: sha256_hex(theirs) });
            }
        }
        if since == SinceRead::Edited {
            result.edited_during_sync.push(path.clone());
        }
    };
    let since = |path: &String| since_read(root, path, local.get(path));
    let mut pulled = Vec::new();
    for (path, bytes) in &plan.pull {
        let since = since(path);
        if since != SinceRead::Unchanged {
            leave(path, &mut new_files, since);
            continue;
        }
        write_local_file(root, path, bytes)?;
        pulled.push(path.clone());
    }
    // Merged bytes exist on disk but not in the `local` snapshot taken at the
    // start of this sync; uploads read from here first.
    let mut merged_content: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut merged = Vec::new();
    for (path, bytes) in plan.merge {
        let since = since(&path);
        if since != SinceRead::Unchanged {
            leave(&path, &mut new_files, since);
            continue;
        }
        write_local_file(root, &path, &bytes)?;
        merged.push(path.clone());
        merged_content.insert(path, bytes);
    }
    let mut conflicts = Vec::new();
    for conflict in &plan.conflict {
        let since = since(&conflict.path);
        if since != SinceRead::Unchanged {
            leave(&conflict.path, &mut new_files, since);
            continue;
        }
        write_local_file(root, &conflict.local_copy, &conflict.local)?;
        write_local_file(root, &conflict.path, &conflict.resolved)?;
        conflicts.push(conflict.reported());
    }
    let mut deleted_local = Vec::new();
    for path in &plan.delete_local {
        let since = since(path);
        if since != SinceRead::Unchanged {
            leave(path, &mut new_files, since);
            continue;
        }
        fs::remove_file(disk_path(root, path))
            .map_err(|e| format!("Could not delete {path}: {e}"))?;
        deleted_local.push(path.clone());
    }
    (result.pulled, result.merged, result.conflicts, result.deleted_local) =
        (pulled, merged, conflicts, deleted_local);

    // Plain pushes and merged files both go up.
    let mut to_push: Vec<String> = plan.push;
    to_push.extend(merged_content.keys().cloned());
    to_push.sort();
    let upload_bytes = |path: &String| merged_content.get(path).or_else(|| local.get(path));

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
        wide_event::record("stood_down", to_push.len());
        for path in to_push.drain(..) {
            new_files.remove(&path);
        }
    }
    let mut own_writes = linked.state.own_writes.clone();
    let mut sent: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    if !to_push.is_empty() {
        let csrf = csrf.as_deref().ok_or("Overleaf's upload token was not fetched.")?;
        for path in &to_push {
            let bytes =
                upload_bytes(path).ok_or_else(|| format!("{path} disappeared during sync"))?;
            sent.insert(path.clone(), bytes.clone());
        }
        // Overleaf has every folder that holds a file of its copy.
        let folders = (remote.keys()).flat_map(|path| folders_above(path)).map(str::to_string);
        wide_event::record("upload_bytes", sent.values().map(Vec::len).sum::<usize>());
        let step = wide_event::step("upload");
        linked.uploader(&client, csrf)?.upload_all(&sent, &folders.collect())?;
        drop(step);
        let written = linked
            .version(&client)
            .map(HistoryFrom::Version)
            .unwrap_or_else(|| HistoryFrom::Time(chrono::Utc::now().timestamp_millis()));
        own_writes.extend(to_push.iter().map(|path| (path.clone(), written)));
        // What went up is the agreed copy even if the file changed again
        // meanwhile; that newer edit goes up next time.
        for path in &to_push {
            if since_read(root, path, sent.get(path)) == SinceRead::Edited {
                result.edited_during_sync.push(path.clone());
            }
        }
    }
    result.pushed = to_push;
    result.read_only = !writable;
    result.edited_during_sync.sort();
    result.edited_during_sync.dedup();

    // Record what both sides now agree on: this is the common ancestor the
    // next sync merges against.
    let mut state = linked.state;
    finalize_base_copies(root, &state.files, &new_files, &[&remote, &sent])?;
    // Where the table now differs from Overleaf's copy, besides what Overleaf
    // has moved past already. Only live documents may: anything else, a later
    // sync must download to see.
    let mut differs = unsettled;
    let paths: BTreeSet<&String> = remote.keys().chain(new_files.keys()).collect();
    differs.extend(
        (paths.into_iter())
            .filter(|path| new_files.get(*path) != remote.get(*path).map(sha256_hex).as_ref())
            .cloned(),
    );
    state.unsettled = differs.iter().all(|path| live.contains(path)).then_some(differs);
    state.files = new_files;
    own_writes.retain(|path, _| state.files.contains_key(path));
    state.own_writes = own_writes;
    state.refused = refused;
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
    state.agreed_version = remote_version_before;
    save_state(root, &state)?;
    // Every list is already in path order: the plan walks paths sorted.
    Ok(Some(result))
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

mod outcome;
mod prefetch;
mod preview;
mod relocations;
use outcome::record_result;
pub use outcome::{OverleafConflict, OverleafSyncResult};
pub use prefetch::{prefetch, Prefetched};
pub use preview::{preview, OverleafPreview};
pub use relocations::sync_relocations;

#[cfg(test)]
mod tests;
