//! Project filesystem watcher.
//!
//! `notify` (FSEvents) reports changes, a debounce thread coalesces bursts,
//! and one `project-fs-changed` event tells every window showing that root to
//! refresh, instead of the frontend polling `refresh_project` + `git_status`.
//! The frontend keeps a slow fallback poll as a safety net.
//!
//! `.research/` churn is filtered out: app state writes (history, FTS
//! indexes, caches, the paper library) fire on every save and are invisible to
//! the project tree anyway (`scan_tree` excludes them). `.git/` events stay:
//! they are how commits and stages reach the source-control badge without
//! polling.

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Quiet period before a burst of events becomes one refresh.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// A bounded, off-search-path scan catches events missed by the OS watcher and
/// changes made while Lattice was not running.
const RECONCILE_INTERVAL: Duration = Duration::from_secs(60);

struct WatchBatch {
    paths: Vec<PathBuf>,
    reconcile: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    root: String,
    /// Project-relative paths when the watcher reported an exact set. `None`
    /// tells consumers to conservatively invalidate project-wide state.
    paths: Option<Vec<String>>,
}

/// Keeps the underlying watcher alive; dropping it stops the event stream,
/// which in turn ends the debounce thread once its channel disconnects.
pub struct ProjectWatcher {
    _watcher: RecommendedWatcher,
}

fn relevant(event: &Event, root: &Path) -> bool {
    event.paths.iter().any(|path| {
        let relative = match path.strip_prefix(root) {
            Ok(relative) => relative,
            // Outside the root (rename endpoints, watch-root parents): treat
            // as relevant rather than silently dropping a real change.
            Err(_) => return true,
        };
        !relative.starts_with(".research")
    })
}

fn payload_paths(root: &Path, paths: &[PathBuf], reconcile: bool) -> Option<Vec<String>> {
    if reconcile || paths.is_empty() {
        return None;
    }
    let mut relative_paths = BTreeSet::new();
    for path in paths {
        let Ok(relative) = path.strip_prefix(root) else {
            return None;
        };
        if relative.as_os_str().is_empty() {
            return None;
        }
        relative_paths.insert(
            relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
        );
    }
    (!relative_paths.is_empty()).then(|| relative_paths.into_iter().collect())
}

pub fn spawn(app: tauri::AppHandle, root: PathBuf) -> Result<ProjectWatcher, String> {
    let (sender, receiver) = mpsc::channel::<WatchBatch>();
    let filter_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: Result<Event, notify::Error>| {
        let batch = match event {
            Ok(event) if relevant(&event, &filter_root) => {
                WatchBatch { paths: event.paths, reconcile: false }
            }
            Ok(_) => return,
            Err(_) => WatchBatch { paths: Vec::new(), reconcile: true },
        };
        let _ = sender.send(batch);
    })
    .map_err(|error| error.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|error| error.to_string())?;

    std::thread::spawn(move || {
        let reconcile_index = || {
            if let Err(error) = crate::fts::reconcile(&root) {
                eprintln!("Could not reconcile the project search index: {error}");
            }
        };
        // Reconcile an existing index once after attaching the watcher. This
        // catches edits made while the project was closed without delaying
        // either project open or the first search.
        reconcile_index();
        let mut next_reconcile = Instant::now() + RECONCILE_INTERVAL;
        loop {
            let until_reconcile =
                |deadline: Instant| deadline.saturating_duration_since(Instant::now());
            let WatchBatch { mut paths, mut reconcile } =
                match receiver.recv_timeout(until_reconcile(next_reconcile)) {
                    Ok(batch) => batch,
                    Err(RecvTimeoutError::Timeout) => {
                        reconcile_index();
                        next_reconcile = Instant::now() + RECONCILE_INTERVAL;
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                };
            // Drain the burst: keep absorbing events until things go quiet or
            // the periodic reconcile falls due.
            loop {
                match receiver.recv_timeout(DEBOUNCE.min(until_reconcile(next_reconcile))) {
                    Ok(batch) => {
                        paths.extend(batch.paths);
                        reconcile |= batch.reconcile;
                        if Instant::now() >= next_reconcile {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            reconcile |= Instant::now() >= next_reconcile;
            let changed_paths = payload_paths(&root, &paths, reconcile);
            let update = if reconcile {
                crate::fts::reconcile(&root)
            } else {
                crate::fts::update_paths(&root, &paths)
            };
            if let Err(error) = update {
                eprintln!("Could not update the project search index: {error}");
            }
            if reconcile {
                next_reconcile = Instant::now() + RECONCILE_INTERVAL;
            }
            // Broadcast; each window filters by its own project root.
            let _ = app.emit(
                "project-fs-changed",
                FsChangedPayload { root: root.to_string_lossy().to_string(), paths: changed_paths },
            );
        }
    });

    Ok(ProjectWatcher { _watcher: watcher })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_for(paths: Vec<PathBuf>) -> Event {
        let mut event = Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any));
        event.paths = paths;
        event
    }

    #[test]
    fn filters_app_private_state_but_keeps_project_and_git_paths() {
        let root = PathBuf::from("/tmp/project");
        for (paths, expected) in [
            (&["main.tex"][..], true),
            (&[".git/index"], true),
            (&[".research/history/x.json"], false),
            (&[".research/papers/2401.00001/paper.md"], false),
            // Mixed bursts stay relevant if any path matters.
            (&[".research/cache/fts.sqlite", "notes.md"], true),
        ] {
            let event = event_for(paths.iter().map(|path| root.join(path)).collect());
            assert_eq!(relevant(&event, &root), expected, "{paths:?}");
        }
    }

    #[test]
    fn reports_sorted_deduplicated_project_relative_paths() {
        let root = PathBuf::from("/tmp/project");
        let chart = root.join("images/chart.png");
        let exact = [chart.clone(), root.join("main.md"), chart];
        assert_eq!(
            payload_paths(&root, &exact, false),
            Some(vec!["images/chart.png".into(), "main.md".into()])
        );
        // Not an exact set: a reconcile, the root itself, or a path outside it.
        assert_eq!(payload_paths(&root, &exact, true), None);
        assert_eq!(payload_paths(&root, std::slice::from_ref(&root), false), None);
        assert_eq!(payload_paths(&root, &[PathBuf::from("/tmp/other/main.md")], false), None);
    }
}
