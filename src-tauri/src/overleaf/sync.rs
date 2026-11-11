//! Sync against Overleaf's copy of the project: the cheap remote-change probe,
//! the plan that classifies every file, the sync that carries it out, and the
//! dry-run preview of it. Where that copy comes from — the agreed one, only
//! what changed, or the project ZIP (`download`) — is in `changes`; the
//! replay of local moves that must come first is in `relocations`, and
//! renames made on Overleaf in `renames`.
//!
//! Classification and execution are deliberately separate: the exact same
//! decisions drive a real sync, the read-only preview the user sees before
//! committing to one, and the staged sync, so there is only ever one set of
//! rules to keep honest.

use super::api::{csrf_token, http_client, DownloadGate, Remote};
use super::case_collisions::{self, CaseCollision};
use super::files::*;
use super::link::{now_iso, save_state, Refusal, SyncState, Unsettled};
use super::review::HistoryFrom;
use crate::wide_event;
use reqwest::blocking::Client;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

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
    /// Paths to send from the local snapshot (see `send`).
    pub push: Vec<String>,
    /// Cleanly merged content (path → merged bytes); also sent.
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
/// `renamed` names the old path of each file carried to a new one, whose
/// merge base is still kept there (see `renames`).
pub(super) fn plan_sync(
    root: &Path, state: &SyncState, remote: &BTreeMap<String, Vec<u8>>,
    local: &BTreeMap<String, Vec<u8>>, live: &BTreeSet<String>, renamed: &BTreeMap<String, String>,
    stamp: &str,
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
                // Still marked up: merging again would nest markers. Hold it.
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
                    let base = renamed.get(path).unwrap_or(path);
                    let (markers, resolved) = match merge_three_way(root, path, base, rb, lb) {
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
    renames::refuse_case_aliases(plan)
}

/// The remote snapshot a sync or preview works from: Overleaf's copy of every
/// file (see `changes`), minus everything that never syncs, plus the
/// app-owned leftovers to delete.
pub(super) struct RemoteFiles {
    pub files: BTreeMap<String, Vec<u8>>,
    pub automatic_remote_deletes: Vec<String>,
    /// Live documents whose copy in `files` Overleaf has since moved past
    /// (see `SyncState::unsettled`): a download has none; a fetch carries the
    /// live documents it did not fetch.
    pub unsettled: BTreeSet<String>,
}

pub(super) fn sync_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M").to_string()
}

// ---- Sync ---------------------------------------------------------------------

/// Keep the merge-base tree aligned with the hashes that will be persisted.
///
/// Most successful paths now match the bytes on disk. A conflicted path is
/// the exception: the disk copy has markers while its recorded common
/// ancestor is Overleaf's snapshot. So is a file edited again while it was
/// being sent: the ancestor is what went up, which only `known` still
/// holds. Live-held paths may match neither and deliberately keep their
/// previous base. `known` is every other copy of a file this sync had in hand
/// — Overleaf's, and what it sent.
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

/// One sync's HTTP client. Every request of the sync goes through it, so they
/// share one connection instead of each paying for its own TLS handshake —
/// several round trips apiece over a slow or proxied link. The deadline is
/// what the project download allows a stall; quicker reads set their own.
fn sync_client() -> Result<Client, String> {
    http_client(120)
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
    let gate: DownloadGate = &|| {};
    let mut round = 0;
    loop {
        round += 1;
        let read_ahead = round <= READ_AHEAD_ROUNDS;
        let prefetched = if read_ahead {
            prefetch(config_dir, root, live, observed_remote_version, gate, &|_, _| {})?
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
            (!read_ahead).then_some(gate),
        )? {
            return Ok(result);
        }
    }
}

/// The sync, under the project's exclusive lease, starting from what
/// [`prefetch`] read ahead of it. Fetches or downloads only when given
/// `download`, the gate a download passes first: that holds every file write
/// here for the download's minutes, so only a sync's last round may.
/// Otherwise `None` when the sync needs Overleaf's copy and nothing read
/// ahead still fits; the caller lets go of the lease and reads ahead again.
pub fn sync_prefetched(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>, observed_remote_version: Option<i64>,
    prefetched: Option<Prefetched>, download: Option<DownloadGate>,
) -> Result<Option<OverleafSyncResult>, String> {
    let result = sync_files(config_dir, root, live, observed_remote_version, prefetched, download)?;
    if let Some(result) = &result {
        record_result(result);
    }
    Ok(result)
}

fn sync_files(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>, observed_remote_version: Option<i64>,
    prefetched: Option<Prefetched>, download: Option<DownloadGate>,
) -> Result<Option<OverleafSyncResult>, String> {
    let mut linked = Remote::open_for_sync(config_dir, root)?;
    let client = sync_client()?;
    // Read here only now, under the lease: whatever changed while the
    // download ran is part of this sync rather than left for the next.
    let read = read_local_files(root)?;
    let mut live = live.clone();
    let prefetched = prefetched.and_then(|prefetched| {
        live.extend(prefetched.fits(&linked, &live, &read.files)?);
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
    let (read, RemoteFiles { files: mut remote, automatic_remote_deletes, mut unsettled, .. }) =
        match prefetched {
            Some(Prefetched { downloaded, .. }) => (read, downloaded),
            None => match remote_copy(&linked, &client, root, version, &read.files, live) {
                RemoteCopy::Agreed(agreed) => {
                    wide_event::record("download", "skipped");
                    (read, agreed)
                }
                copy => {
                    let Some(gate) = download else {
                        return Ok(None);
                    };
                    let downloaded = fetch(&linked, &client, copy, gate, &|_, _| {})?;
                    // Read again after the download, as above.
                    (read_local_files(root)?, downloaded)
                }
            },
        };
    let LocalFiles { files: mut local, oversized } = read;
    wide_event::record("local_files", local.len());
    // The table can never agree with Overleaf on a path set aside, so later
    // syncs download to see it again rather than trust the agreed copy.
    let (case_collisions, aside) =
        case_collisions::set_aside(&mut remote, &mut local, &linked.state.files);
    unsettled.extend(aside.iter().cloned());
    let synced_before: BTreeSet<String> = linked.state.files.keys().cloned().collect();
    let renames = remote_renames(&linked, &client, &remote, &local);
    carry(&mut linked.state, &mut local, &renames);
    let carried = &renames.carried;
    let mut plan = plan_sync(root, &linked.state, &remote, &local, live, carried, &sync_stamp())?;
    hold(&mut plan, &linked.state, &renames);
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
        newly_unresolved_conflicts: newly_held(&linked.state, &plan.unresolved_conflicts),
        unresolved_conflicts: plan.unresolved_conflicts,
        case_collisions,
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
    let moved = move_local(root, &renames, &local)?;
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

    // Never publish conflict markers: a marked-up file stays unsent, on the
    // base its markers show, until resolved.
    let marked = |path: &String| upload_bytes(path).is_some_and(|b| has_conflict_markers(b));
    let (to_push, held_back): (Vec<String>, Vec<String>) = if writable {
        to_push.into_iter().partition(|path| !marked(path))
    } else {
        (Vec::new(), to_push)
    };
    for path in &held_back {
        match linked.state.files.get(path).filter(|_| marked(path)) {
            Some(hash) => new_files.insert(path.clone(), hash.clone()),
            None => new_files.remove(path),
        };
    }

    let files = (to_push.iter())
        .map(|path| {
            let bytes = upload_bytes(path).ok_or_else(|| format!("{path} disappeared during sync"));
            Ok((path.clone(), bytes?.clone()))
        })
        .collect::<Result<_, String>>()?;
    let outcome =
        send::send(&linked, &client, csrf.as_deref(), &remote, files, remote_version_before)?;
    outcome.keep_planned_copies(&remote, &mut new_files);
    let send::Sent { sent, over_edits, stood_down } = outcome;
    result.uploaded_over_edits = over_edits;
    let pushed: Vec<String> = sent.keys().cloned().collect();
    let mut own_writes = linked.state.own_writes.clone();
    if !pushed.is_empty() {
        let written = linked
            .version(&client)
            .map(HistoryFrom::Version)
            .unwrap_or_else(|| HistoryFrom::Time(chrono::Utc::now().timestamp_millis()));
        own_writes.extend(pushed.iter().map(|path| (path.clone(), written)));
        // What went up is the agreed copy even if the file changed again
        // meanwhile; that newer edit goes up next time.
        for path in &pushed {
            if since_read(root, path, sent.get(path)) == SinceRead::Edited {
                result.edited_during_sync.push(path.clone());
            }
        }
    }
    result.pushed = pushed;
    report(&mut result, &renames, &moved);
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
    // What went up differs only by what this sync wrote, which Overleaf's
    // history names after the copy, so the next sync fetches it again.
    let fetched = |path: &String| live.contains(path) || sent.contains_key(path);
    state.unsettled = renames.unsettled(&differs, fetched);
    state.files = new_files;
    own_writes.retain(|path, _| state.files.contains_key(path));
    state.own_writes = own_writes;
    state.refused = refused;
    state.unresolved_conflicts = result.unresolved_conflicts.clone();
    state.last_sync = Some(now_iso());
    // `remote_version_before` is the only history position known to precede
    // the downloaded snapshot. Never replace it with a newer value fetched at
    // the end: that newer value may include a collaborator's edit which is not
    // in the zip we materialized as the new base.
    //
    // Uploads and live operations advance history themselves, but Overleaf
    // does not return the resulting project version. Leave it unknown so the
    // next probe performs one verification sync instead of attributing an
    // unverified latest version to what we sent.
    state.remote_version = if result.pushed.is_empty() { remote_version_before } else { None };
    state.agreed_version = remote_version_before;
    save_state(root, &state)?;
    renames::forget_old_bases(root, &renames);
    let held = renames.held.keys().chain(&held_back).chain(&stood_down);
    let held = held.chain(&result.edited_during_sync);
    let kept = state.files.keys().chain(remote.keys()).chain(&aside).chain(held);
    result.kept_folders = stale_folders::clear(root, kept, &synced_before);
    // Every list is already in path order: the plan walks paths sorted.
    Ok(Some(result))
}

// ---- Probe ---------------------------------------------------------------------

mod changes;
mod download;
mod failure;
mod history_evidence;
mod outcome;
mod prefetch;
mod preview;
mod probe;
mod relocations;
mod remote_delete;
mod renames;
mod send;
mod since_read;
mod stale_folders;
use changes::{fetch, remote_copy, RemoteCopy};
use download::download;
pub use failure::classify_sync_error;
use history_evidence::{agreed_copy, settle_destructive};
use outcome::{newly_held, record_result};
pub use outcome::{OverleafConflict, OverleafSyncResult};
pub use prefetch::{prefetch, Prefetched};
pub use preview::{preview, OverleafPreview};
pub use probe::{probe, OverleafProbe};
pub use relocations::sync_relocations;
pub use remote_delete::{delete_unchanged, RemoteDelete};
use renames::{carry, hold, move_local, remote_renames, report};
use since_read::{since_read, SinceRead};

#[cfg(test)]
mod tests;
