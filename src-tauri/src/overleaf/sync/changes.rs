//! Overleaf's copy of the project for a sync, fetched only as far as its
//! history says it changed (audit F4).
//!
//! The project download is most of what a sync costs: Overleaf zips the whole
//! project, figures and all, on every request. On a 272-file, 30 MB paper
//! that was 20-34 s a sync, and most of those syncs found one document new in
//! it, or nothing. The copy the last sync agreed on is already on disk, each
//! file either unchanged here or kept as its merge base, and Overleaf's
//! history names every path changed since. So a sync takes the agreed copy
//! for everything the history leaves alone and fetches only the rest: each
//! document over the live channel, as Overleaf's own editor reads it, and each
//! binary file by its id, checked against the hash Overleaf keeps for it.
//!
//! What comes out is the same map of path to bytes the download gives, so the
//! plan, the three-way merges and every safety rule after it (hollow copies,
//! standing down, conflict copies) run exactly as they do on a download. The
//! download stays for whatever the history cannot vouch for: no agreed copy
//! or version, a table that was not exact at the last sync
//! (`SyncState::unsettled`), a held hollow copy, a history that does not
//! reach the version just read, a file leaving the tree with no update to say
//! so, more files to fetch than the project's size pays for (`MOST_FETCHES`),
//! and any fetch that fails or does not match its hash. A folder operation
//! names only the folder, so every agreed path in a folder the history names
//! is fetched, live or not. Only the download passes the gate that holds
//! downloads to the gap between them (`DownloadGate`): fetching what changed
//! is the same traffic Overleaf's own editor makes.

use super::super::api::{expect_success, send, Remote};
use super::super::files::*;
use super::super::review::history_since;
use super::{download, RemoteFiles};
use crate::overleaf::api::{DownloadGate, DownloadProgress};
use crate::overleaf_rt::{EntityEntry, RealtimeClient, RealtimeConfig};
use crate::wide_event;
use reqwest::blocking::Client;
use reqwest::header::COOKIE;
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use tauri::async_runtime as rt;

/// The most documents and files a sync fetches one by one before it takes
/// the project download instead: one per `BYTES_PER_FETCH` of the agreed
/// copy, a stand-in for the download's size, never fewer than
/// `FEWEST_FETCHES`.
const MOST_FETCHES: usize = 40;
const FEWEST_FETCHES: usize = 8;
/// Roughly what the download carries in one round trip on the audit's link
/// (29.6 MB in 22 s, 250 ms round trips): each fetch costs a round trip.
const BYTES_PER_FETCH: usize = 320 * 1024;

/// Where Overleaf's copy for a sync comes from.
pub(super) enum RemoteCopy {
    /// The agreed copy is Overleaf's copy of every file a sync may touch:
    /// nothing to fetch.
    Agreed(RemoteFiles),
    /// The agreed copy, but for the paths the history names.
    Changed(Changes),
    /// Only the project download can tell.
    Download,
}

/// The agreed copy, and what Overleaf changed since it.
pub(super) struct Changes {
    /// Overleaf's copy of every agreed path the history leaves alone.
    agreed: BTreeMap<String, Vec<u8>>,
    /// Paths whose copy must come from Overleaf as it stands now.
    fetch: BTreeSet<String>,
    /// Every path the agreed copy holds.
    table: BTreeSet<String>,
    /// What updates that changed the project tree named, a folder operation
    /// naming only the folder: no other file may have left it.
    tree_paths: BTreeSet<String>,
    /// See `RemoteFiles::unsettled`.
    unsettled: BTreeSet<String>,
    /// How many documents and files may be fetched before the download is
    /// the quicker way (see `MOST_FETCHES`).
    most_fetches: usize,
}

/// Work out where Overleaf's copy for this sync must come from, reading at
/// most Overleaf's history.
///
/// `version` is the project version just read. Every update since the agreed
/// copy (`SyncState::agreed_version`) must be in the history read here, each
/// naming what it touched, or it proves nothing. Documents the realtime
/// channel holds need no fetch however much they moved: a sync leaves them
/// alone, so their agreed copy stands in, recorded as unsettled.
pub(super) fn remote_copy(
    remote: &Remote, client: &Client, root: &Path, version: Option<i64>,
    local: &BTreeMap<String, Vec<u8>>, live: &BTreeSet<String>,
) -> RemoteCopy {
    let state = &remote.state;
    let (Some(unsettled), Some(version)) = (state.unsettled.as_ref(), version) else {
        return RemoteCopy::Download;
    };
    let Some(agreed_at) = state.agreed_version.or(state.remote_version) else {
        return RemoteCopy::Download;
    };
    // A held hollow copy is checked against every download. An upload or a
    // replayed move leaves the version unknown; it moved the version too, so
    // one that has not moved means something the table cannot place.
    let unplaced = version == agreed_at && state.remote_version != Some(version);
    if !state.refused.is_empty() || version < agreed_at || unplaced {
        return RemoteCopy::Download;
    }
    // A live document the sync leaves alone: present on both sides, so no
    // pull, push or deletion can come of it either.
    let held_live = |path: &String| {
        live.contains(path) && local.contains_key(path) && state.files.contains_key(path)
    };
    let mut named = BTreeSet::new();
    let mut tree_paths = BTreeSet::new();
    if version > agreed_at {
        let Ok(history) = history_since(remote, client, |update| update.ends_after(agreed_at))
        else {
            return RemoteCopy::Download;
        };
        // The history must reach the version just read, or it is missing
        // updates rather than proving there were none.
        let reaches = (history.first().and_then(|update| update.to_version()))
            .is_some_and(|newest| newest >= version);
        if !reaches || history.iter().any(|update| update.paths.is_empty()) {
            return RemoteCopy::Download;
        }
        for update in history {
            if update.tree {
                tree_paths.extend(update.paths.iter().cloned());
            }
            named.extend(update.paths);
        }
    }
    // Documents the last sync left on an older merge base are fetched again
    // too, unless still live. A folder operation names only the folder, so
    // every agreed path in it is fetched, live or not: another document may
    // stand at that path now.
    let in_tree_change = |path: &String| tree_paths.iter().any(|changed| within(path, changed));
    let in_folder = state.files.keys().filter(|path| in_tree_change(path));
    let (mut still_live, mut fetch): (BTreeSet<String>, BTreeSet<String>) =
        (named.iter().chain(unsettled).chain(in_folder).cloned())
            .partition(|path| held_live(path) && !in_tree_change(path));
    let mut agreed = BTreeMap::new();
    for (path, hash) in &state.files {
        if fetch.contains(path) {
            continue;
        }
        let matches = |bytes: &Vec<u8>| sha256_hex(bytes) == *hash;
        let copy = (local.get(path).filter(|bytes| matches(bytes)).cloned())
            .or_else(|| read_base_copy(root, path).map(String::into_bytes).filter(matches));
        match copy {
            Some(bytes) => {
                agreed.insert(path.clone(), bytes);
            }
            // Edited here, with no copy kept (a figure): Overleaf's is the
            // agreed one, and fetching it costs that file alone.
            None => {
                fetch.insert(path.clone());
            }
        }
    }
    still_live.retain(|path| agreed.contains_key(path));
    if fetch.is_empty() && tree_paths.is_empty() {
        return RemoteCopy::Agreed(RemoteFiles {
            files: agreed,
            automatic_remote_deletes: Vec::new(),
            unsettled: still_live,
        });
    }
    let agreed_bytes: usize = agreed.values().map(Vec::len).sum();
    let most_fetches = (agreed_bytes / BYTES_PER_FETCH).clamp(FEWEST_FETCHES, MOST_FETCHES);
    if fetch.iter().filter(|path| state.files.contains_key(*path)).count() > most_fetches {
        return RemoteCopy::Download;
    }
    let table = state.files.keys().cloned().collect();
    let unsettled = still_live;
    RemoteCopy::Changed(Changes { agreed, fetch, table, tree_paths, unsettled, most_fetches })
}

/// Overleaf's copy as `copy` says to get it: fetching only what changed where
/// that works, and the project download, past `gate`, where it does not.
pub(super) fn fetch(
    remote: &Remote, client: &Client, copy: RemoteCopy, gate: DownloadGate,
    progress: DownloadProgress,
) -> Result<RemoteFiles, String> {
    match copy {
        RemoteCopy::Agreed(files) => Ok(files),
        RemoteCopy::Changed(changes) => match fetch_changes(remote, client, changes, progress) {
            Ok(files) => Ok(files),
            Err(reason) => {
                log::info!(target: "lattice::overleaf", "Downloading the whole project: {reason}");
                wide_event::record("fetch_fallback", reason);
                download(remote, client, gate, progress)
            }
        },
        RemoteCopy::Download => download(remote, client, gate, progress),
    }
}

/// The agreed copy with the changed paths fetched from Overleaf, or why the
/// download must be used instead.
fn fetch_changes(
    remote: &Remote, client: &Client, changes: Changes, progress: DownloadProgress,
) -> Result<RemoteFiles, &'static str> {
    let step = wide_event::step("download");
    let config = RealtimeConfig {
        user_id: remote.session.user_id.clone(),
        host: remote.host.clone(),
        cookie: remote.session.cookie.clone(),
        project_id: remote.state.project_id.clone(),
    };
    let channel = rt::block_on(RealtimeClient::connect(config, |_| {}))
        .map_err(|_| "the live channel could not be reached")?;
    let fetched = fetch_with(remote, client, &channel, changes, progress);
    channel.shutdown();
    let downloaded = fetched?;
    drop(step);
    wide_event::record("download", "partial");
    wide_event::record("remote_files", downloaded.files.len());
    Ok(downloaded)
}

fn fetch_with(
    remote: &Remote, client: &Client, channel: &RealtimeClient, changes: Changes,
    progress: DownloadProgress,
) -> Result<RemoteFiles, &'static str> {
    let project = channel.project();
    // Every document and file in Overleaf's tree, as the download would list
    // them.
    let mut entries: BTreeMap<String, &EntityEntry> = BTreeMap::new();
    for entity in project.entities.iter().filter(|entity| entity.kind != "folder") {
        validate_inventory_path(&entity.path).map_err(|_| "the tree holds an unsafe path")?;
        entries.insert(entity.path.clone(), entity);
    }
    // As for a download (`fetch_remote_files`).
    let mut automatic_remote_deletes: Vec<String> =
        entries.keys().filter(|path| is_latex_save_error_path(path)).cloned().collect();
    if entries.keys().any(|path| is_transient_pdf_render_path(path)) {
        automatic_remote_deletes.push(TRANSIENT_PDF_RENDER_DIRECTORY.to_string());
    }
    automatic_remote_deletes.sort();
    let left_out: Vec<String> = (entries.keys())
        .filter(|path| excluded_in(&entries, path) || remote.build_pdfs.contains(path))
        .cloned()
        .collect();
    for path in left_out {
        entries.remove(&path);
    }
    // A file gone from the tree is one a sync deletes here, so only an
    // update that removed or renamed it, or a folder above it, may account
    // for it; a tree missing anything else is not trusted.
    let named = |path: &str| changes.tree_paths.iter().any(|changed| within(path, changed));
    if (changes.table.iter()).any(|path| !entries.contains_key(path) && !named(path)) {
        return Err("a file left Overleaf's tree with no update saying so");
    }
    let mut files = BTreeMap::new();
    let mut missing = Vec::new();
    for (path, entity) in entries {
        let hash = project.file_hashes.get(&entity.id).filter(|_| entity.kind == "file");
        // A figure replaced under the same name is caught by its hash even
        // where the history missed it.
        let agreed = (changes.agreed.get(&path).filter(|_| !changes.fetch.contains(&path)))
            .filter(|bytes| hash.is_none_or(|hash| blob_hash(bytes) == *hash));
        match agreed {
            Some(bytes) => {
                files.insert(path, bytes.clone());
            }
            None => missing.push((path, entity, hash)),
        }
    }
    // Each fetch is a round trip of its own, so past this many the one
    // download is the quicker way to the same copy.
    if missing.len() > changes.most_fetches {
        return Err("too much changed to fetch file by file");
    }
    let mut fetched_bytes = 0usize;
    for (path, entity, hash) in &missing {
        let bytes = if entity.kind == "doc" {
            fetch_doc(channel, &entity.id)?
        } else {
            fetch_file(remote, client, &entity.id)?
        };
        if hash.is_some_and(|hash| blob_hash(&bytes) != *hash) {
            return Err("a fetched file does not match Overleaf's hash for it");
        }
        fetched_bytes += bytes.len();
        progress(fetched_bytes as u64, None);
        files.insert(path.clone(), bytes);
    }
    wide_event::record("fetched_files", missing.len());
    wide_event::record("fetched_bytes", fetched_bytes);
    Ok(RemoteFiles { files, automatic_remote_deletes, unsettled: changes.unsettled })
}

/// Whether `path` is `changed` itself or lies in the folder `changed`: what
/// an update naming `changed` may have touched.
fn within(path: &str, changed: &str) -> bool {
    path.strip_prefix(changed).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// A document's text as Overleaf holds it now. It stays joined until the
/// channel closes, which leaves every document at once.
fn fetch_doc(channel: &RealtimeClient, id: &str) -> Result<Vec<u8>, &'static str> {
    let joined =
        rt::block_on(channel.join_doc(id, None)).map_err(|_| "a document would not join")?;
    Ok(joined.text.into_bytes())
}

/// A binary file's bytes, `GET {host}/project/{id}/file/{file id}`, which
/// is how Overleaf's editor shows a figure.
fn fetch_file(remote: &Remote, client: &Client, id: &str) -> Result<Vec<u8>, &'static str> {
    let url = format!("{}/project/{}/file/{id}", remote.host, remote.state.project_id);
    let request = client.get(url).header(COOKIE, &remote.session.cookie);
    let response = send(request).map_err(|_| "a file could not be fetched")?;
    let response = expect_success(response, "for a file").map_err(|_| "a file was refused")?;
    Ok(response.bytes().map_err(|_| "a file broke off")?.to_vec())
}

/// The hash Overleaf keeps a file under, git's blob SHA-1:
/// `sha1("blob {byte length}\0{bytes}")`.
pub(super) fn blob_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}
