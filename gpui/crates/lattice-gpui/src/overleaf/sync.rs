//! The Overleaf work that runs off the main thread, as the Tauri app's
//! commands run it (`src-tauri/src/ipc/overleaf.rs`): each call blocks, so
//! the window runs it on the background executor. Every answer that looked
//! signed out has been checked against Overleaf's dashboard on the way back
//! ([`super::settled`]); the `bool` beside it says the session was found
//! dead, which the window then announces.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use lattice_core::{
    overleaf::{
        self, CloneTarget, LocalCopy, OverleafLink, OverleafPreview, OverleafProbe,
        OverleafProjectList, OverleafSyncResult, PastedLink, RemoteDelete,
    },
    overleaf_rt::EntityEntry,
};

use super::{config_dir, download::DownloadProgress, projects_dir, settled, wait_for_download_gap};

/// A result, and whether the session was found expired on the way.
pub type Settled<T> = (Result<T, String>, bool);

/// The quickest a download repeats its progress.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// Report a download's progress to `report`: each attempt's start (so a
/// retry visibly starts over), its end, and no more than one step per
/// [`PROGRESS_INTERVAL`] between.
fn throttled(report: impl Fn(DownloadProgress) + Sync) -> impl Fn(u64, Option<u64>) + Sync {
    let reported = Mutex::new(None::<Instant>);
    move |received, total| {
        let mut last = reported
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        let recent = last.is_some_and(|at| now - at < PROGRESS_INTERVAL);
        if received > 0 && recent && Some(received) != total {
            return;
        }
        *last = Some(now);
        report(DownloadProgress { received, total });
    }
}

/// The project's link, remembering a linked folder as a local copy (so a
/// folder linked before Lattice kept the list, or moved since, is found
/// again by the picker).
pub fn link(root: &Path) -> Result<Option<OverleafLink>, String> {
    let link = overleaf::project_link(root)?;
    if link.is_some() {
        overleaf::remember_local_copy(&config_dir(), root);
    }
    Ok(link)
}

pub fn list_projects() -> Settled<OverleafProjectList> {
    settled(overleaf::list_projects(&config_dir()))
}

pub fn resolve_link(pasted: &str) -> Settled<PastedLink> {
    settled(overleaf::resolve_link(&config_dir(), pasted))
}

/// The folders on this Mac already linked to the listed projects, by
/// project id: each listed name's download folder, and `known` (the recent
/// projects).
pub fn local_copies(names: &[String], known: &[PathBuf]) -> BTreeMap<String, LocalCopy> {
    let Ok(parent) = projects_dir() else {
        return BTreeMap::new();
    };
    let downloads = names
        .iter()
        .filter_map(|name| overleaf::download_folder(&parent, name).ok());
    let candidates: Vec<PathBuf> = known.iter().cloned().chain(downloads).collect();
    overleaf::local_copies(&config_dir(), &candidates)
}

pub fn reopen_local_copy(
    path: &Path,
    project_id: &str,
    access: Option<&str>,
) -> Result<(), String> {
    overleaf::reopen_local_copy(&config_dir(), path, project_id, access)
}

/// What downloading `name` would meet: nothing, the linked folder, or a
/// folder of that name holding other files.
pub fn clone_target(project_id: &str, name: &str) -> Result<CloneTarget, String> {
    overleaf::clone_target(project_id, name, &projects_dir()?)
}

/// Download a project (or, with `adopt`, link the folder already sitting
/// where it would go) and start its version history, reporting progress.
pub fn clone(
    project_id: &str,
    name: &str,
    access: Option<&str>,
    adopt: bool,
    report: impl Fn(DownloadProgress) + Sync,
) -> Settled<PathBuf> {
    let run = || -> Result<PathBuf, String> {
        let config = config_dir();
        let parent = projects_dir()?;
        if adopt {
            let target = overleaf::clone_target(project_id, name, &parent)?;
            if target.kind == "occupied" {
                return overleaf::adopt_project(
                    &config,
                    project_id,
                    name,
                    Path::new(&target.path),
                    access,
                );
            }
        }
        let progress = throttled(report);
        overleaf::clone_project(&config, project_id, name, &parent, access, &progress)
    };
    let (root, expired) = settled(run());
    // A cloned project starts its version history at once, so the Versions
    // timeline can show what each later sync changed.
    if let Ok(root) = &root {
        let _ = lattice_core::git::init(root);
    }
    (root, expired)
}

pub fn publish(root: &Path, name: &str) -> Settled<OverleafLink> {
    settled(overleaf::publish_project(&config_dir(), root, name))
}

/// Has Overleaf's history moved since the last sync; with `local`, have the
/// files here (less `live`, which the channel carries) changed too.
pub fn probe(root: &Path, local: Option<&BTreeSet<String>>) -> Settled<OverleafProbe> {
    settled(overleaf::probe(&config_dir(), root, local))
}

pub fn preview(root: &Path, live: &BTreeSet<String>) -> Settled<OverleafPreview> {
    settled(overleaf::preview(&config_dir(), root, live))
}

pub fn set_paused(root: &Path, paused: bool) -> Result<(), String> {
    overleaf::set_paused(root, paused)
}

/// Remove a file deleted here from Overleaf. With `path` (a writer's
/// delete), Overleaf's history is read first and a file a co-author edited
/// meanwhile is left; without (app-owned clutter), it goes as it is.
pub fn delete_entity(
    root: &Path,
    kind: &str,
    entity_id: &str,
    path: Option<&str>,
) -> Settled<RemoteDelete> {
    let config = config_dir();
    settled(match path {
        Some(path) => overleaf::delete_unchanged(&config, root, path, kind, entity_id),
        None => {
            overleaf::delete_entity(&config, root, kind, entity_id).map(|()| RemoteDelete::Deleted)
        }
    })
}

/// One sync, as the Tauri app's `overleaf_sync` runs it: read ahead (the
/// download, which only reads and is most of a sync's time), then sync
/// against what was read; round again while the link moved past what was
/// read ahead, and past [`overleaf::READ_AHEAD_ROUNDS`] download inside the
/// sync instead. `live` are the paths the live channel carries, which the
/// sync leaves alone; `entities` the channel's tree, for following renames.
pub fn sync(
    root: &Path,
    live: &BTreeSet<String>,
    observed_remote_version: Option<i64>,
    entities: Option<Vec<EntityEntry>>,
) -> Settled<OverleafSyncResult> {
    let config = config_dir();
    let gate: &(dyn Fn() + Sync) = &wait_for_download_gap;
    let mut round = 0;
    loop {
        round += 1;
        let read_ahead = round <= overleaf::READ_AHEAD_ROUNDS;
        let prefetched = if read_ahead {
            match settled(overleaf::prefetch(
                &config,
                root,
                live,
                observed_remote_version,
                gate,
                &|_, _| {},
            )) {
                (Ok(prefetched), _) => prefetched,
                (Err(error), expired) => return (Err(error), expired),
            }
        } else {
            None
        };
        let synced = overleaf::sync_relocations(&config, root, entities.clone()).and_then(|()| {
            overleaf::sync_prefetched(
                &config,
                root,
                live,
                observed_remote_version,
                prefetched,
                (!read_ahead).then_some(gate),
            )
        });
        match settled(synced) {
            (Ok(Some(result)), expired) => return (Ok(result), expired),
            (Ok(None), _) => continue,
            (Err(error), expired) => return (Err(error), expired),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn progress_is_reported_at_most_every_quarter_second_but_always_at_the_ends() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let report = {
            let seen = Arc::clone(&seen);
            throttled(move |step: DownloadProgress| seen.lock().unwrap().push(step.received))
        };
        report(0, Some(30));
        report(10, Some(30));
        report(20, Some(30));
        report(30, Some(30));
        assert_eq!(*seen.lock().unwrap(), [0, 30]);
    }
}
