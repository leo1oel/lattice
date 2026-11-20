//! The plan that classifies every file: what a sync would pull, send, merge,
//! set aside as a conflict or hold for confirmation, decided but not yet
//! done. The real sync, the staged sync and the preview all carry out this
//! one plan, so there is only ever one set of rules to keep honest.

use super::outcome::{ConflictSide, OverleafConflict};
use super::renames;
use crate::overleaf::files::*;
use crate::overleaf::link::SyncState;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// One file both sides changed in ways that need a human, or, binary, that
/// only one side's copy can stand for.
pub(in crate::overleaf) struct ConflictPlan {
    pub path: String,
    /// See `OverleafConflict::markers`.
    pub markers: bool,
    /// What lands at `path`: the conflict-marked text, or for a binary file
    /// the copy kept (Overleaf's, until `settle_binary` finds this Mac's
    /// newer).
    pub resolved: Vec<u8>,
    /// The copy taken off the path: this Mac's as it stood, or for a binary
    /// file where this Mac's is kept, Overleaf's. Nothing is lost: it goes to
    /// `set_aside`.
    pub other: Vec<u8>,
    /// Where `other` is kept (`files::set_aside_path`), out of the project.
    pub set_aside: String,
    /// A binary file whose copy here is the newer: it stays and goes up.
    pub kept_local: bool,
}

impl ConflictPlan {
    pub fn reported(&self) -> OverleafConflict {
        let kept = (!self.markers).then_some(if self.kept_local {
            ConflictSide::ThisMac
        } else {
            ConflictSide::Overleaf
        });
        let (path, set_aside) = (self.path.clone(), self.set_aside.clone());
        OverleafConflict { path, set_aside, markers: self.markers, kept }
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
pub(in crate::overleaf) struct Destructive {
    pub path: String,
    /// Overleaf's bytes.
    pub remote: Vec<u8>,
    /// For a file edited here too, how it combines with Overleaf's copy once
    /// confirmed; `None` for a plain pull.
    pub merged: Option<Merged>,
}

/// A file both sides changed, combined.
pub(in crate::overleaf) enum Merged {
    Clean(Vec<u8>),
    Conflict(ConflictPlan),
}

/// Below this size a file shrinking is ordinary editing, not a sign of a
/// hollow download.
const SHRINK_FLOOR: usize = 1024;

/// Whether replacing `local` with `remote` loses most of a non-empty file:
/// emptied, or cut below a quarter of its size.
pub(in crate::overleaf) fn wipes_out(local: &[u8], remote: &[u8]) -> bool {
    !local.is_empty()
        && (remote.is_empty() || (local.len() >= SHRINK_FLOOR && remote.len() < local.len() / 4))
}

/// Everything a sync would do, decided but not yet done.
#[derive(Default)]
pub(in crate::overleaf) struct SyncPlan {
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
    pub(super) fn settle_destructive(
        &mut self, confirmed: impl Fn(&str) -> bool,
    ) -> Vec<Destructive> {
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
pub(in crate::overleaf) fn plan_sync(
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

    let built_here = crate::latex::built_pdfs(root);
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
                // A PDF still exactly as this copy's last build of it left it
                // is build output, not an edit: next to any other copy on
                // Overleaf it is not a change "here" at all, so Overleaf's
                // wins quietly instead of raising a conflict and setting the
                // build aside as a `(local conflict …)` copy. It is rebuilt
                // whenever it is wanted (`shown_pdf::replaced`). This is
                // what happens to a root document's PDF each time Build
                // moves between documents: the one no longer built rejoins
                // sync with no agreed copy, while Overleaf still holds one
                // an earlier sync sent up.
                let local_changed = local_changed && built_here.get(path) != Some(&local_hash);
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
                        // Binary: one copy takes the path (see `settle_binary`).
                        MergeOutcome::Unmergeable => (false, rb.clone()),
                    };
                    // The untouched local version is kept, out of the project.
                    Merged::Conflict(ConflictPlan {
                        path: path.clone(),
                        markers,
                        resolved,
                        other: lb.clone(),
                        set_aside: set_aside_path(path, stamp, |name| {
                            disk_path(root, name).exists()
                        }),
                        kept_local: false,
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
