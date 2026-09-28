//! Staged sync for Shared projects, where the Catalog/Yjs state — not the disk
//! — is authoritative. `prepare_sync` plans against a snapshot the caller
//! supplies and holds the plan in memory; the frontend applies the incoming
//! actions it accepts, then `commit_prepared_sync` uploads and records the new
//! common ancestor. Project files are never read or written here.

use super::account::load_session;
use super::api::{err, http_client, sync_host, Remote};
use super::files::*;
use super::link::{load_state, now_iso, permits_writing, save_state, SyncState, PAUSED};
use super::sync::{
    displayable_text, fetch_remote_files, plan_sync, sync_stamp, OverleafSyncResult, RemoteFiles,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A Catalog/Yjs-owned file supplied to staged sync. Disk is deliberately not
/// consulted for these files.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafAuthoritativeEntry {
    pub path: String,
    pub kind: String,
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafPreparedAction {
    pub action_id: String,
    pub path: String,
    pub kind: String,
    pub before_base64: Option<String>,
    pub after_base64: Option<String>,
    pub binary: bool,
    pub outgoing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafPreparedSync {
    pub plan_id: String,
    pub actions: Vec<OverleafPreparedAction>,
    pub result: OverleafSyncResult,
    pub remote_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafAcceptedAction {
    pub action_id: String,
    pub base64: Option<String>,
}

const PREPARED_PLAN_TTL: Duration = Duration::from_secs(120);
const MAX_PREPARED_PLANS: usize = 8;
const MAX_PREPARED_BYTES: usize = 128 * 1024 * 1024;
const EXPIRED: &str = "Unknown or expired prepared sync plan.";

#[derive(Clone, Copy, PartialEq)]
enum PreparedRole {
    Push,
    Pull,
    Merge,
    ConflictMain,
    ConflictCopy,
    Delete,
}

struct StoredAction {
    path: String,
    kind: String,
    binary: bool,
    role: PreparedRole,
}

struct StoredPlan {
    created: Instant,
    bytes: usize,
    root: PathBuf,
    host: String,
    state_digest: String,
    state: SyncState,
    remote_version: Option<i64>,
    remote: BTreeMap<String, Vec<u8>>,
    local: BTreeMap<String, Vec<u8>>,
    planned_files: BTreeMap<String, String>,
    actions: BTreeMap<String, StoredAction>,
    result: OverleafSyncResult,
}

static PREPARED: Mutex<BTreeMap<String, StoredPlan>> = Mutex::new(BTreeMap::new());

fn state_digest(state: &SyncState) -> Result<String, String> {
    serde_json::to_vec(state).map(|bytes| sha256_hex(&bytes)).map_err(err)
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    root.canonicalize().map_err(|e| format!("Could not resolve project root: {e}"))
}

/// Keep at most `MAX_PREPARED_PLANS` unexpired plans within the byte budget,
/// evicting the oldest first.
fn insert_prepared_plan(id: String, plan: StoredPlan) -> Result<(), String> {
    if plan.bytes > MAX_PREPARED_BYTES {
        return Err("The shared project is too large to stage for Overleaf sync.".to_string());
    }
    let mut plans = PREPARED.lock().expect("prepared sync store poisoned");
    let now = Instant::now();
    plans.retain(|_, existing| now.duration_since(existing.created) <= PREPARED_PLAN_TTL);
    plans.insert(id, plan);
    while plans.len() > MAX_PREPARED_PLANS
        || plans.values().map(|plan| plan.bytes).sum::<usize>() > MAX_PREPARED_BYTES
    {
        let Some(oldest) =
            plans.iter().min_by_key(|(_, plan)| plan.created).map(|(id, _)| id.clone())
        else {
            break;
        };
        plans.remove(&oldest);
    }
    Ok(())
}

/// Prepare a Share-safe sync from the Catalog/Yjs snapshot supplied by the
/// caller. This performs network reads and base-copy reads, but no writes.
pub fn prepare_sync(
    config_dir: &Path, root: &Path, authoritative_inventory: &[OverleafAuthoritativeEntry],
    live: &BTreeSet<String>, observed_remote_version: Option<i64>,
) -> Result<OverleafPreparedSync, String> {
    let session = load_session(config_dir)?;
    let mut state = load_state(root)?;
    if state.paused {
        return Err(PAUSED.to_string());
    }
    let loaded_state_digest = state_digest(&state)?;
    state.files.retain(|path, _| !is_excluded(path));
    let host = sync_host(&state, &session)?;
    let root = canonical_root(root)?;
    let linked = Remote { session, state, host };

    let mut local = BTreeMap::new();
    let mut local_kinds = BTreeMap::new();
    let mut skipped_large = Vec::new();
    for entry in authoritative_inventory {
        validate_inventory_path(&entry.path)?;
        if is_excluded(&entry.path) {
            continue;
        }
        if !matches!(entry.kind.as_str(), "text" | "binary" | "board" | "spreadsheet") {
            return Err(format!("Invalid catalog kind for {}: {}", entry.path, entry.kind));
        }
        if local.contains_key(&entry.path) {
            return Err(format!("Duplicate authoritative inventory path: {}", entry.path));
        }
        let bytes = BASE64
            .decode(&entry.base64)
            .map_err(|_| format!("Invalid base64 for {}", entry.path))?;
        if bytes.len() as u64 > MAX_SYNC_FILE_BYTES {
            skipped_large.push(entry.path.clone());
            continue;
        }
        local_kinds.insert(entry.path.clone(), entry.kind.clone());
        local.insert(entry.path.clone(), bytes);
    }

    let remote_version = (linked.version(&http_client(30)?))
        .or(observed_remote_version)
        .or(linked.state.remote_version);
    let RemoteFiles { files: remote, automatic_remote_deletes } = fetch_remote_files(&linked)?;
    let Remote { state, host, .. } = linked;
    let plan = plan_sync(&root, &state, &remote, &local, live, &sync_stamp())?;

    let result = OverleafSyncResult {
        pulled: plan.pull.iter().map(|(path, _)| path.clone()).collect(),
        merged: plan.merge.iter().map(|(path, _)| path.clone()).collect(),
        deleted_local: plan.delete_local.clone(),
        conflicts: plan.conflict.iter().map(|conflict| conflict.reported()).collect(),
        skipped_large,
        automatic_remote_deletes,
        skipped_remote_deletes: plan.skipped_remote_deletes.clone(),
        read_only: !permits_writing(state.permission.as_deref()),
        ..Default::default()
    };
    // A conflict copy is the same kind of file as the one it was taken from.
    for conflict in &plan.conflict {
        if let Some(kind) = local_kinds.get(&conflict.path).cloned() {
            local_kinds.insert(conflict.local_copy.clone(), kind);
        }
    }

    // (path, kind, before, after, role) for every file the plan touches.
    use PreparedRole::*;
    type Staged<'a> = (&'a str, &'a str, Option<&'a [u8]>, Option<&'a [u8]>, PreparedRole);
    fn at<'a>(files: &'a BTreeMap<String, Vec<u8>>, path: &str) -> Option<&'a [u8]> {
        files.get(path).map(Vec::as_slice)
    }
    let mut staged: Vec<Staged> = Vec::new();
    for path in &plan.push {
        staged.push((path, "write", at(&remote, path), at(&local, path), Push));
    }
    for (path, bytes) in &plan.pull {
        let kind = if local.contains_key(path) { "write" } else { "create" };
        staged.push((path, kind, at(&local, path), Some(bytes), Pull));
    }
    for (path, bytes) in &plan.merge {
        staged.push((path, "write", at(&local, path), Some(bytes), Merge));
    }
    for c in &plan.conflict {
        staged.push((&c.local_copy, "create", None, Some(&c.local), ConflictCopy));
        staged.push((&c.path, "write", Some(&c.local), Some(&c.resolved), ConflictMain));
    }
    for path in &plan.delete_local {
        staged.push((path, "delete", at(&local, path), None, Delete));
    }

    let mut actions = BTreeMap::new();
    let mut public_actions = Vec::new();
    for (path, kind, before, after, role) in staged {
        let action_id = uuid::Uuid::new_v4().to_string();
        let binary = local_kinds.get(path).is_some_and(|kind| kind == "binary")
            || before.is_some_and(|bytes| displayable_text(bytes).is_none())
            || after.is_some_and(|bytes| displayable_text(bytes).is_none());
        public_actions.push(OverleafPreparedAction {
            action_id: action_id.clone(),
            path: path.to_string(),
            kind: kind.to_string(),
            before_base64: before.map(|bytes| BASE64.encode(bytes)),
            after_base64: after.map(|bytes| BASE64.encode(bytes)),
            binary,
            outgoing: role == Push,
        });
        let action = StoredAction { path: path.to_string(), kind: kind.to_string(), binary, role };
        actions.insert(action_id, action);
    }
    public_actions.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.kind.cmp(&b.kind)));

    let bytes = remote.values().chain(local.values()).map(Vec::len).sum::<usize>();
    let plan_id = uuid::Uuid::new_v4().to_string();
    let stored = StoredPlan {
        created: Instant::now(),
        bytes,
        root,
        host,
        state_digest: loaded_state_digest,
        state,
        remote_version,
        remote,
        local,
        planned_files: plan.files,
        actions,
        result: result.clone(),
    };
    insert_prepared_plan(plan_id.clone(), stored)?;
    Ok(OverleafPreparedSync { plan_id, actions: public_actions, result, remote_version })
}

/// The file table and base copies a commit will persist.
struct Baseline {
    files: BTreeMap<String, String>,
    bases: BTreeMap<String, Vec<u8>>,
}

impl Baseline {
    /// Both sides now hold `bytes` at `path`: the next merge's common ancestor.
    fn agree(&mut self, path: &str, bytes: Vec<u8>) {
        self.files.insert(path.to_string(), sha256_hex(&bytes));
        self.bases.insert(path.to_string(), bytes);
    }
}

/// Commit a prepared sync after the frontend has first applied accepted
/// incoming actions to Catalog/Yjs. Project files are never read or written.
pub fn commit_prepared_sync(
    config_dir: &Path, root: &Path, prepared_plan_id: &str,
    accepted_actions: &[OverleafAcceptedAction],
) -> Result<OverleafSyncResult, String> {
    let plan = PREPARED
        .lock()
        .expect("prepared sync store poisoned")
        .remove(prepared_plan_id)
        .ok_or_else(|| EXPIRED.to_string())?;
    if plan.created.elapsed() > PREPARED_PLAN_TTL {
        return Err(EXPIRED.to_string());
    }
    if canonical_root(root)? != plan.root {
        return Err("Prepared sync belongs to a different project root.".to_string());
    }
    let current_state = load_state(root)?;
    if state_digest(&current_state)? != plan.state_digest {
        return Err("Overleaf sync state changed after preparation.".to_string());
    }
    let session = load_session(config_dir)?;
    if sync_host(&current_state, &session)? != plan.host
        || current_state.project_id != plan.state.project_id
    {
        return Err("Prepared sync belongs to a different Overleaf project.".to_string());
    }

    let mut accepted = BTreeMap::<String, Option<Vec<u8>>>::new();
    for item in accepted_actions {
        let action = (plan.actions.get(&item.action_id))
            .ok_or_else(|| format!("Unknown prepared action: {}", item.action_id))?;
        if accepted.contains_key(&item.action_id) {
            return Err(format!("Duplicate prepared action: {}", item.action_id));
        }
        let bytes = match (action.kind.as_str(), item.base64.as_deref()) {
            ("delete", None) => None,
            ("delete", Some(_)) => return Err("Delete actions must not include bytes.".to_string()),
            (_, None) => return Err("Create/write actions require canonical bytes.".to_string()),
            (_, Some(encoded)) => {
                let bytes = BASE64
                    .decode(encoded)
                    .map_err(|_| format!("Invalid base64 for {}", action.path))?;
                if bytes.len() as u64 > MAX_SYNC_FILE_BYTES {
                    return Err(format!("{} exceeds Overleaf's sync size limit", action.path));
                }
                Some(bytes)
            }
        };
        accepted.insert(item.action_id.clone(), bytes);
    }
    for id in accepted.keys() {
        let StoredAction { path, role, .. } = &plan.actions[id];
        if *role != PreparedRole::ConflictMain {
            continue;
        }
        let local_copy = (plan.result.conflicts.iter())
            .find(|conflict| conflict.path == *path)
            .map(|conflict| conflict.local_copy.as_str())
            .ok_or_else(|| "Prepared conflict action is incomplete.".to_string())?;
        let copy_accepted = plan.actions.iter().any(|(copy_id, candidate)| {
            candidate.path == local_copy
                && candidate.role == PreparedRole::ConflictCopy
                && accepted.contains_key(copy_id)
        });
        if !copy_accepted {
            return Err(format!("Conflict copy must be accepted before replacing {path}."));
        }
    }

    let linked = Remote { session, state: plan.state, host: plan.host };
    let (client, csrf) = linked.csrf_client(30)?;
    let writable = permits_writing(linked.state.permission.as_deref());
    // Never publish unresolved conflict markers.
    let held_back: BTreeSet<&str> = (accepted.iter())
        .filter(|(id, bytes)| {
            !plan.actions[*id].binary && bytes.as_deref().is_some_and(has_conflict_markers)
        })
        .map(|(id, _)| plan.actions[id].path.as_str())
        .collect();
    let mut uploads: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for (id, bytes) in &accepted {
        let action = &plan.actions[id];
        let outgoing =
            matches!(action.role, PreparedRole::Push | PreparedRole::Pull | PreparedRole::Merge);
        if !writable || !outgoing || held_back.contains(action.path.as_str()) {
            continue;
        }
        let bytes = bytes.as_ref().expect("validated action bytes");
        if plan.remote.get(&action.path) != Some(bytes) {
            uploads.insert(action.path.clone(), bytes.clone());
        }
    }

    let mut result = OverleafSyncResult {
        read_only: !writable,
        skipped_large: plan.result.skipped_large,
        automatic_remote_deletes: plan.result.automatic_remote_deletes,
        ..Default::default()
    };
    // Overleaf moved on since the plan was made: stand down, as `sync` does,
    // so the next round merges their work first.
    if !uploads.is_empty()
        && plan.remote_version.is_some()
        && linked.version(&client) != plan.remote_version
    {
        return Ok(result);
    }
    if !uploads.is_empty() {
        let uploader = linked.uploader(&client, &csrf)?;
        for (path, bytes) in &uploads {
            uploader.upload(path, bytes.clone())?;
        }
    }

    // A path an action controls starts from the recorded state; every other
    // path takes the plan's verdict directly.
    let controlled: BTreeSet<&str> = (plan.actions.values())
        .filter(|action| action.role != PreparedRole::ConflictCopy)
        .map(|action| action.path.as_str())
        .collect();
    let is_controlled = |path: &&String| controlled.contains(path.as_str());
    let kept = linked.state.files.iter().filter(|(path, _)| is_controlled(path));
    let decided = plan.planned_files.iter().filter(|(path, _)| !is_controlled(path));
    let files = kept.chain(decided).map(|(path, hash)| (path.clone(), hash.clone())).collect();
    let mut next = Baseline { files, bases: BTreeMap::new() };

    result.skipped_remote_deletes = plan.result.skipped_remote_deletes;
    for (id, bytes) in accepted {
        let action = &plan.actions[&id];
        let path = action.path.as_str();
        let held = held_back.contains(path);
        let remote = plan.remote.get(path);
        match action.role {
            PreparedRole::Push => {
                if writable && !held {
                    next.agree(path, bytes.expect("validated action bytes"));
                }
            }
            PreparedRole::Pull => {
                result.pulled.push(path.to_string());
                let canonical = bytes.expect("validated action bytes");
                // Held back or read-only, Overleaf keeps its own copy — unless
                // what we accepted is exactly that.
                if !held && (writable || remote == Some(&canonical)) {
                    next.agree(path, canonical);
                } else if let Some(remote) = remote {
                    next.agree(path, remote.clone());
                }
            }
            PreparedRole::Merge => {
                result.merged.push(path.to_string());
                if writable && !held {
                    next.agree(path, bytes.expect("validated action bytes"));
                } else {
                    next.files.remove(path);
                }
            }
            PreparedRole::ConflictMain => {
                next.agree(path, remote.cloned().unwrap_or_default());
                let conflict = plan.result.conflicts.iter().find(|c| c.path == path);
                result.conflicts.extend(conflict.cloned());
            }
            PreparedRole::ConflictCopy => {}
            PreparedRole::Delete => {
                next.files.remove(path);
                result.deleted_local.push(path.to_string());
            }
        }
    }
    for (path, bytes) in &uploads {
        next.agree(path, bytes.clone());
    }
    // Every other surviving path needs a base too: whichever side holds bytes
    // with the recorded hash.
    for (path, hash) in &next.files {
        if next.bases.contains_key(path) {
            continue;
        }
        let matching = |bytes: &&Vec<u8>| sha256_hex(bytes) == *hash;
        if let Some(bytes) =
            plan.remote.get(path).filter(matching).or_else(|| plan.local.get(path).filter(matching))
        {
            next.bases.insert(path.clone(), bytes.clone());
        }
    }
    for (path, bytes) in &next.bases {
        write_base_copy(root, path, bytes)?;
    }
    let state = SyncState {
        files: next.files,
        last_sync: Some(now_iso()),
        remote_version: if uploads.is_empty() { plan.remote_version } else { None },
        ..linked.state
    };
    save_state(root, &state)?;
    result.pushed = uploads.into_keys().collect();
    result.pulled.sort();
    result.merged.sort();
    result.deleted_local.sort();
    result.conflicts.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overleaf::link::state_path;
    use crate::overleaf::test_support::*;
    use std::fs;

    /// Prepare from a Catalog snapshot holding exactly `files`.
    fn prepare(config: &Path, root: &Path, files: Files) -> OverleafPreparedSync {
        let inventory: Vec<OverleafAuthoritativeEntry> = (files.iter())
            .map(|(path, bytes)| OverleafAuthoritativeEntry {
                path: path.to_string(),
                kind: if std::str::from_utf8(bytes).is_ok() { "text" } else { "binary" }
                    .to_string(),
                base64: BASE64.encode(bytes),
            })
            .collect();
        prepare_sync(config, root, &inventory, &BTreeSet::new(), None).unwrap()
    }

    /// Accept `action` with `bytes`, or with exactly the bytes it proposed.
    fn accept(action: &OverleafPreparedAction, bytes: Option<&[u8]>) -> OverleafAcceptedAction {
        let base64 = bytes.map(|bytes| BASE64.encode(bytes)).or(action.after_base64.clone());
        OverleafAcceptedAction { action_id: action.action_id.clone(), base64 }
    }

    fn as_offered(action: &OverleafPreparedAction) -> OverleafAcceptedAction {
        accept(action, None)
    }

    fn action<'a>(prepared: &'a OverleafPreparedSync, path: &str) -> &'a OverleafPreparedAction {
        prepared.actions.iter().find(|action| action.path == path).unwrap()
    }

    #[test]
    fn staged_prepare_is_side_effect_free_and_commit_uses_reconciled_bytes() {
        let (base, remote, canonical) = (
            b"base body".as_slice(),
            b"remote body".as_slice(),
            b"remote body\npeer note".as_slice(),
        );
        let server = Mock::project(&[("main.tex", remote)]).serve();
        let (config, root) = linked(&server, &[("main.tex", base)], &[("main.tex", base)]);
        let state_before = fs::read(state_path(&root)).unwrap();
        let base_before = read_base_copy(&root, "main.tex").unwrap();

        let prepared = prepare(&config, &root, &[("main.tex", base)]);

        assert_eq!(read_local(&root, "main.tex").unwrap(), base);
        assert_eq!(fs::read(state_path(&root)).unwrap(), state_before);
        assert_eq!(read_base_copy(&root, "main.tex").unwrap(), base_before);
        let incoming = action(&prepared, "main.tex");
        assert!(!incoming.outgoing);

        let accepted = [accept(incoming, Some(canonical))];
        let result = commit_prepared_sync(&config, &root, &prepared.plan_id, &accepted).unwrap();

        assert_eq!(result.pulled, vec!["main.tex"]);
        assert!(server.uploads()[0].body_text().contains("peer note"));
        assert_eq!(state_files(&root).get("main.tex"), Some(&sha256_hex(canonical)));
        assert_eq!(read_base_copy(&root, "main.tex").unwrap(), "remote body\npeer note");
        // Staged sync never treats disk as authoritative or rewrites it itself.
        assert_eq!(read_local(&root, "main.tex").unwrap(), base);
    }

    #[test]
    fn staged_deferred_delete_preserves_the_baseline() {
        let base = b"keep me".as_slice();
        let server = Mock::project(&[]).serve();
        let (config, root) = linked(&server, &[("main.tex", base)], &[("main.tex", base)]);
        let prepared = prepare(&config, &root, &[("main.tex", base)]);
        assert_eq!(prepared.actions[0].kind, "delete");

        let result = commit_prepared_sync(&config, &root, &prepared.plan_id, &[]).unwrap();

        assert!(result.deleted_local.is_empty());
        assert_eq!(state_files(&root).get("main.tex"), Some(&sha256_hex(base)));
        assert_eq!(read_base_copy(&root, "main.tex").unwrap(), "keep me");
    }

    #[test]
    fn staged_plans_are_one_use_and_validate_actions_and_state() {
        let base = b"base".as_slice();
        let server = Mock::project(&[("main.tex", b"remote")]).serve();
        let (config, root) = linked(&server, &[("main.tex", base)], &[("main.tex", base)]);
        let commit = |plan_id: &str, accepted: &[OverleafAcceptedAction]| {
            commit_prepared_sync(&config, &root, plan_id, accepted).unwrap_err()
        };
        assert!(commit("missing-plan", &[]).contains("Unknown or expired"));

        let prepared = prepare(&config, &root, &[("main.tex", base)]);
        let accepted = as_offered(&prepared.actions[0]);
        assert!(commit(&prepared.plan_id, &[accepted.clone(), accepted]).contains("Duplicate"));
        assert!(commit(&prepared.plan_id, &[]).contains("Unknown or expired"));

        let prepared = prepare(&config, &root, &[("main.tex", base)]);
        edit_state(&root, |state| state.last_sync = Some("changed-after-prepare".to_string()));
        assert!(commit(&prepared.plan_id, &[]).contains("state changed"));
    }

    #[test]
    fn staged_commit_stands_down_when_remote_history_moves() {
        let (base, local) = (b"base".as_slice(), b"local edit".as_slice());
        let server =
            Mock { versions: vec![11, 12], ..Mock::project(&[("main.tex", base)]) }.serve();
        let (config, root) = linked(&server, &[("main.tex", local)], &[("main.tex", base)]);
        let prepared = prepare(&config, &root, &[("main.tex", local)]);
        let outgoing = prepared.actions.iter().find(|action| action.outgoing).unwrap();

        let accepted = [accept(outgoing, Some(local))];
        let result = commit_prepared_sync(&config, &root, &prepared.plan_id, &accepted).unwrap();

        assert!(result.pushed.is_empty());
        assert!(server.uploads().is_empty());
        assert_eq!(state_files(&root).get("main.tex"), Some(&sha256_hex(base)));
    }

    #[test]
    fn staged_conflict_requires_the_local_copy_before_the_main_replacement() {
        let base = b"base body".as_slice();
        let local = b"local edit".as_slice();
        let server = Mock::project(&[("main.tex", b"remote edit")]).serve();
        let (config, root) = linked(&server, &[("main.tex", local)], &[("main.tex", base)]);
        let prepared = prepare(&config, &root, &[("main.tex", local)]);

        let accepted = [as_offered(action(&prepared, "main.tex"))];
        let error = commit_prepared_sync(&config, &root, &prepared.plan_id, &accepted).unwrap_err();

        assert!(error.contains("Conflict copy must be accepted"));
        assert!(server.uploads().is_empty());
        assert_eq!(state_files(&root).get("main.tex"), Some(&sha256_hex(base)));
    }

    #[test]
    fn staged_partial_upload_failure_does_not_advance_state() {
        let (base_a, base_b) = (b"base a".as_slice(), b"base b".as_slice());
        let local: Files = &[("a.tex", b"local a"), ("b.tex", b"local b")];
        let base: Files = &[("a.tex", base_a), ("b.tex", base_b)];
        let server =
            Mock { versions: vec![11], fail_upload_at: Some(2), ..Mock::project(base) }.serve();
        let (config, root) = linked(&server, local, base);
        let prepared = prepare(&config, &root, local);
        let accepted: Vec<_> = prepared.actions.iter().map(as_offered).collect();

        assert!(commit_prepared_sync(&config, &root, &prepared.plan_id, &accepted).is_err());
        assert_eq!(server.uploads().len(), 2);
        let state = state_files(&root);
        assert_eq!(state.get("a.tex"), Some(&sha256_hex(base_a)));
        assert_eq!(state.get("b.tex"), Some(&sha256_hex(base_b)));
        assert_eq!(read_base_copy(&root, "a.tex").unwrap(), "base a");
        assert_eq!(read_base_copy(&root, "b.tex").unwrap(), "base b");
    }
}
