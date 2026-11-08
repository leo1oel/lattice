//! Reading Overleaf's side of a sync ahead of the project's exclusive lease
//! (#670): fetching what changed there, or the download, which is most of a
//! sync's time, taken while file writes here go on, and checked against the
//! link once the lease is held.

use super::{fetch, remote_copy, sync_client, RemoteCopy, RemoteFiles};
use crate::overleaf::api::{DownloadGate, DownloadProgress, Remote};
use crate::overleaf::files::read_local_files;
use crate::overleaf::link::SyncState;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Overleaf's side of a sync, read before the sync takes the project's
/// lease (see [`prefetch`]).
pub struct Prefetched {
    /// Where Overleaf's history stood before the download.
    pub(super) version: Option<i64>,
    /// The table of agreed hashes the download was taken against.
    files: BTreeMap<String, String>,
    pub(super) downloaded: RemoteFiles,
}

impl Prefetched {
    /// Whether the download still fits the link as it stands now, under the
    /// lease, and the paths the sync must then leave alone as it does a live
    /// document. Between the two, a live document may have been checkpointed
    /// or left, a file moved, another sync finished: wherever the table
    /// changed for a path, the download predates what the table now calls
    /// agreed, and comparing the two would read our own newer state as
    /// Overleaf going back. A path only whose agreed copy moved on, still
    /// here and in the download, can wait for the next sync; one that came or
    /// went cannot, and nor can the paths a move remapped. So too a document
    /// the read ahead left on its agreed copy because the editor had it live
    /// (`RemoteFiles::unsettled`) and that is no longer live: that copy is
    /// not Overleaf's.
    pub(super) fn fits(
        &self, state: &SyncState, live: &BTreeSet<String>, local: &BTreeMap<String, Vec<u8>>,
    ) -> Option<BTreeSet<String>> {
        if !state.pending_relocations.is_empty() {
            return None;
        }
        let stand_ins = &self.downloaded.unsettled;
        let paths: BTreeSet<&String> =
            self.files.keys().chain(state.files.keys()).chain(stand_ins).collect();
        let mut moved = BTreeSet::new();
        for path in paths {
            let unchanged = self.files.get(path) == state.files.get(path);
            if live.contains(path) || (unchanged && !stand_ins.contains(path)) {
                continue;
            }
            let held = self.files.contains_key(path)
                && state.files.contains_key(path)
                && local.contains_key(path)
                && self.downloaded.files.contains_key(path);
            if !held {
                return None;
            }
            moved.insert(path.clone());
        }
        Some(moved)
    }
}

/// The slow, read-only half of a sync: Overleaf's version, then what changed
/// there, or its project download, when the sync will need it. Run before the
/// sync takes the project's exclusive lease, so creating, deleting and saving
/// files here are
/// not held for the minutes a large project's download can take; the sync
/// then uses the download if it still fits (see [`Prefetched::fits`]), and
/// turns it down if not, for this to run again once the lease is let go
/// (see [`READ_AHEAD_ROUNDS`](super::READ_AHEAD_ROUNDS)).
/// `None` when there is nothing to fetch ahead: the agreed copy stands, or a
/// move must be replayed first.
///
/// `live` is the editor's view of the live documents; the sync recomputes it
/// under the lease, so a stale one costs at most a redundant download.
/// `gate` is passed only on the way to the project download.
pub fn prefetch(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>, observed_remote_version: Option<i64>,
    gate: DownloadGate, progress: DownloadProgress,
) -> Result<Option<Prefetched>, String> {
    let linked = Remote::open_for_sync(config_dir, root)?;
    if !linked.state.pending_relocations.is_empty() {
        return Ok(None);
    }
    let client = sync_client()?;
    let version = linked.version(&client).or(observed_remote_version);
    let local = read_local_files(root)?.files;
    let copy = remote_copy(&linked, &client, root, version, &local, live);
    if let RemoteCopy::Agreed(_) = copy {
        return Ok(None);
    }
    let downloaded = fetch(&linked, &client, copy, gate, progress)?;
    Ok(Some(Prefetched { version, files: linked.state.files, downloaded }))
}
