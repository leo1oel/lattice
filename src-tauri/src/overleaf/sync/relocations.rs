//! Replaying local moves on Overleaf by entity id, which must happen before a
//! sync compares contents: a moved file would otherwise read as one deleted
//! and one new, and go up as a fresh upload that loses its comments and
//! history.

use crate::overleaf::account::load_session;
use crate::overleaf::api::{csrf_token, expect_success, http_client, json_str, send_as, sync_host};
use crate::overleaf::files::{read_base_copy, remove_base_copy, write_base_copy};
use crate::overleaf::link::{load_state, save_state, PAUSED};
use crate::overleaf::review::HistoryFrom;
use crate::overleaf_rt::EntityEntry;
use crate::util::err;
use reqwest::header::COOKIE;
use serde_json::{json, Value};
use std::path::Path;

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
    if !state.access().can_write() {
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
        let moved_at = HistoryFrom::Time(chrono::Utc::now().timestamp_millis());
        for (old, new, hash) in &remapped {
            if let Some(base) = read_base_copy(root, old) {
                write_base_copy(root, new, base.as_bytes())?;
            }
            state.files.remove(old);
            state.files.insert(new.clone(), hash.clone());
            state.own_writes.remove(old);
            state.own_writes.insert(new.clone(), moved_at);
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
