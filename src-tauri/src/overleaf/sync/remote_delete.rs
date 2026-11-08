//! Carrying out a deletion made here on Overleaf too, once the writer chose to.
//!
//! A sync only reports such a file (`skipped_remote_deletes`) when Overleaf
//! still held exactly the agreed copy. The removal itself comes later, after
//! the setting or a confirmation dialog that may have stayed open for minutes
//! while a co-author kept editing. So the report is evidence about the past
//! only: right before the removal, Overleaf's history is read again, and any
//! change to the path since the agreed copy keeps the file there.

use super::{agreed_copy, sync_client};
use crate::overleaf::api::Remote;
use crate::overleaf::files::disk_path;
use crate::overleaf::review::{delete_entity, history_since};
use serde::Serialize;
use std::path::Path;

/// What became of one removal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteDelete {
    Deleted,
    /// Someone changed it on Overleaf after the copy the deletion was judged
    /// against. The next sync brings their version back here.
    ChangedOnOverleaf,
    /// It exists here again, so there is no deletion left to carry out.
    BackHere,
}

/// Remove `path` (entity `entity_id`) from Overleaf, unless Overleaf changed
/// it since the last agreed copy or it has come back here.
///
/// Every change to the path counts, Lattice's own included. The reporting
/// sync's agreed copy already postdates earlier uploads (the file was absent
/// here, so that sync pushed nothing to it), and a live-mode leave checkpoint
/// records its own write as a wall-clock time with minutes of slack that would
/// hide a co-author's edit. A false refusal costs one sync and a new decision,
/// never a lost edit.
///
/// An unreadable history is an error, not a removal: the file left on
/// Overleaf can be removed later, a co-author's edit cannot be unremoved
/// except by digging through Overleaf's history.
pub fn delete_unchanged(
    config_dir: &Path, root: &Path, path: &str, kind: &str, entity_id: &str,
) -> Result<RemoteDelete, String> {
    if disk_path(root, path).exists() {
        return Ok(RemoteDelete::BackHere);
    }
    let remote = Remote::open(config_dir, root)?;
    let from = agreed_copy(&remote.state);
    // A file is touched by a change to itself or to a folder above it, which
    // Overleaf records under the folder's name only.
    let touches = |changed: &String| {
        (path.strip_prefix(changed.as_str()))
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    let client = sync_client()?;
    let history = history_since(&remote, &client, |update| update.after(from))
        .map_err(|error| format!("Could not check whether {path} changed on Overleaf: {error}"))?;
    let changed = history.iter().any(|update| update.paths.iter().any(touches));
    if changed {
        return Ok(RemoteDelete::ChangedOnOverleaf);
    }
    delete_entity(config_dir, root, kind, entity_id)?;
    Ok(RemoteDelete::Deleted)
}
