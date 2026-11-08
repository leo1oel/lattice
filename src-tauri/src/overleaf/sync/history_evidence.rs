//! The evidence a sync needs from Overleaf's history before it acts on a
//! change it cannot undo: where the last agreed copy stands in that history,
//! and which destructive downloads the history confirms.

use super::{Destructive, SyncPlan};
use crate::overleaf::api::Remote;
use crate::overleaf::link::{Refusal, SyncState};
use crate::overleaf::review::{history_since, HistoryFrom};
use crate::util::sha256_hex;
use reqwest::blocking::Client;
use std::collections::BTreeMap;

/// Where the agreed copy from the last sync stands in Overleaf's history: the
/// version it was downloaded at, or failing that the time of the sync.
pub(super) fn agreed_copy(state: &SyncState) -> Option<HistoryFrom> {
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
