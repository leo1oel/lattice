//! A binary file both sides changed since the last sync (a figure redrawn
//! here and on Overleaf): nothing can merge it, so the newer copy takes the
//! path, by when each side last changed it, and the other is kept under
//! `.research/overleaf-conflicts/`, named in the sync's result (LATA-51).
//!
//! This Mac's time is the file's modification time; Overleaf's, the end of
//! the newest update in its history since the last sync that names the path.
//! When that cannot be told (no such update, an unreadable history, a project
//! this account may only read), Overleaf's copy takes the path, as it always
//! did: a guess that sends this Mac's copy up over a co-author's is the one
//! that costs them something.

use super::history_evidence::agreed_copy;
use super::SyncPlan;
use crate::overleaf::api::Remote;
use crate::overleaf::files::{disk_path, sha256_hex};
use crate::overleaf::review::history_since;
use reqwest::blocking::Client;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Decide each binary conflict in `plan`: where this Mac's copy is newer, it
/// stays and goes up, and Overleaf's is the one set aside.
pub(super) fn settle_binary(remote: &Remote, client: &Client, root: &Path, plan: &mut SyncPlan) {
    if !plan.conflict.iter().any(|conflict| !conflict.markers) {
        return;
    }
    let since = agreed_copy(&remote.state);
    let history = match history_since(remote, client, |update| update.after(since)) {
        Ok(history) => history,
        Err(error) => {
            log::warn!(target: "lattice::overleaf", "Could not read Overleaf's history to date a figure changed on both sides: {error}");
            return;
        }
    };
    for conflict in plan.conflict.iter_mut().filter(|conflict| !conflict.markers) {
        let path = conflict.path.as_str();
        let theirs = (history.iter())
            .filter(|update| update.paths.iter().any(|changed| names(path, changed)))
            .filter_map(|update| update.ended_at())
            .max();
        let ours = std::fs::metadata(disk_path(root, path))
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as i64);
        let (Some(theirs), Some(ours)) = (theirs, ours) else {
            continue;
        };
        if ours > theirs {
            std::mem::swap(&mut conflict.resolved, &mut conflict.other);
            conflict.kept_local = true;
            plan.files.insert(conflict.path.clone(), sha256_hex(&conflict.resolved));
            plan.push.push(conflict.path.clone());
        }
    }
    plan.push.sort();
}

/// Whether an update naming `changed` touched `path`: the file, or a folder above it.
fn names(path: &str, changed: &str) -> bool {
    path.strip_prefix(changed).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}
