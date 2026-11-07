//! Reading Overleaf's side of a sync ahead of the project's exclusive lease
//! (#670): the download that is most of a sync's time, taken while file
//! writes here go on, and checked against the link once the lease is held.

use super::{agreed_remote_files, fetch_remote_files, sync_client, RemoteFiles};
use crate::overleaf::api::{DownloadProgress, Remote};
use crate::overleaf::files::read_local_files;
use crate::overleaf::link::SyncState;
use crate::wide_event;
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
    /// lease. Between the two, a live document may have been checkpointed or
    /// left, a file moved, another sync finished: wherever the table changed
    /// for a path the sync will touch, the download predates what the table
    /// now calls agreed, and comparing the two would read our own newer state
    /// as Overleaf going back. Only a live document, which the sync leaves
    /// alone, may differ.
    pub(super) fn fits(&self, state: &SyncState, live: &BTreeSet<String>) -> bool {
        let paths: BTreeSet<&String> = self.files.keys().chain(state.files.keys()).collect();
        state.pending_relocations.is_empty()
            && (paths.into_iter())
                .all(|path| self.files.get(path) == state.files.get(path) || live.contains(path))
    }
}

/// The slow, read-only half of a sync: Overleaf's version, then its project
/// download when the sync will need one. Run before the sync takes the
/// project's exclusive lease, so creating, deleting and saving files here are
/// not held for the minutes a large project's download can take; the sync
/// then uses the download if it still fits (see [`Prefetched::fits`]), and
/// turns it down if not, for this to run again once the lease is let go.
/// `None` when there is nothing to fetch ahead: the agreed copy stands, or a
/// move must be replayed first.
///
/// `live` is the editor's view of the live documents; the sync recomputes it
/// under the lease, so a stale one costs at most a redundant download.
pub fn prefetch(
    config_dir: &Path, root: &Path, live: &BTreeSet<String>, observed_remote_version: Option<i64>,
    progress: DownloadProgress,
) -> Result<Option<Prefetched>, String> {
    let linked = Remote::open_for_sync(config_dir, root)?;
    if !linked.state.pending_relocations.is_empty() {
        return Ok(None);
    }
    let client = sync_client()?;
    let version = linked.version(&client).or(observed_remote_version);
    let local = read_local_files(root)?.files;
    if agreed_remote_files(&linked, &client, root, version, &local, live).is_some() {
        return Ok(None);
    }
    let step = wide_event::step("download");
    let downloaded = fetch_remote_files(&linked, &client, progress)?;
    drop(step);
    wide_event::record("download", "full");
    let bytes: usize = downloaded.files.values().map(Vec::len).sum();
    wide_event::record("remote_files", downloaded.files.len());
    wide_event::record("remote_bytes", bytes);
    Ok(Some(Prefetched { version, files: linked.state.files, downloaded }))
}
