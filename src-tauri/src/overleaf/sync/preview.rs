//! The dry run of a sync: the same fetch and the same classification, so what
//! the user approves is exactly what runs, with nothing written or uploaded.

use super::{fetch, plan_sync, remote_copy, settle_destructive, sync_client, sync_stamp};
use crate::overleaf::api::Remote;
use crate::overleaf::case_collisions;
use crate::overleaf::files::{is_excluded, read_base_copy, read_local_files};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

/// What a pending sync would do to one file, computed without touching disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafChange {
    pub path: String,
    /// "incoming" | "outgoing" | "merge" | "conflict" | "deleteLocal" | "skippedRemoteDelete"
    /// | "refusedIncoming" | "unresolvedConflict"
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

/// Text we can show in a diff view. Anything else is treated as binary: the UI
/// gets a marker instead of the bytes.
fn displayable_text(bytes: &[u8]) -> Option<String> {
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
    let build_pdf = &linked.build_pdf;
    linked.state.files.retain(|path, _| !is_excluded(path) && !build_pdf.is(path));
    let client = sync_client()?;
    let mut local = read_local_files(root)?.files;
    let version = linked.version(&client);
    let copy = remote_copy(&linked, &client, root, version, &local, live);
    let mut remote = fetch(&linked, &client, copy, &|| {}, &|_, _| {})?.files;
    case_collisions::set_aside(&mut remote, &mut local, &linked.state.files);
    let mut plan = plan_sync(root, &linked.state, &remote, &local, live, &sync_stamp())?;
    let refused = settle_destructive(&linked, &client, &mut plan);

    let local_bytes = |path: &str| local.get(path).map(Vec::as_slice);
    // Conflicts first — the rows that wait on a decision — then the rest in
    // the order the user reads them.
    let mut changes: Vec<OverleafChange> = (plan.conflict.iter())
        .map(|c| preview_change(&c.path, "conflict", Some(&c.local), Some(&c.resolved)))
        .collect();
    // Still marked up from an earlier conflict: nothing moves until resolved.
    for path in &plan.unresolved_conflicts {
        let held = local_bytes(path);
        changes.push(preview_change(path, "unresolvedConflict", held, held));
    }
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
    let rank = [
        "conflict",
        "unresolvedConflict",
        "refusedIncoming",
        "incoming",
        "merge",
        "outgoing",
        "deleteLocal",
    ];
    let rank = |kind: &str| rank.iter().position(|k| *k == kind).unwrap_or(rank.len());
    changes.sort_by(|a, b| rank(&a.kind).cmp(&rank(&b.kind)).then_with(|| a.path.cmp(&b.path)));

    Ok(OverleafPreview { changes, remote_version: version })
}
