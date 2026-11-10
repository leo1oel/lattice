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
/// The longest a steady stream of events waits before it is reported anyway,
/// so a folder written without pause (an experiment logging into the
/// project) still refreshes the windows now and then.
const MAX_BURST: Duration = Duration::from_secs(2);

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

#[derive(Clone, Serialize)]
struct ReopenedPayload {
    root: String,
}

/// Tell the window already showing `root` that it was asked to open the
/// project again, which a writer does after changing the folder elsewhere.
pub fn announce_reopened<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &Path) {
    // Broadcast like `project-fs-changed`; each window filters by its root.
    let _ =
        app.emit("project-reopened", ReopenedPayload { root: root.to_string_lossy().to_string() });
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

pub fn spawn<R: tauri::Runtime>(
    app: tauri::AppHandle<R>, root: PathBuf,
) -> Result<ProjectWatcher, String> {
    let (sender, receiver) = mpsc::channel::<WatchBatch>();
    let filter_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: Result<Event, notify::Error>| {
        let batch = match event {
            // FSEvents dropped events under these paths and asks for a rescan:
            // the same as a watcher error, for the index and for the windows.
            Ok(event) if event.need_rescan() && relevant(&event, &filter_root) => {
                WatchBatch { paths: Vec::new(), reconcile: true }
            }
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
        // After that the index follows the watcher's reports. A whole-project
        // reconcile runs again only when the watcher says it lost events (an
        // error, an FSEvents rescan): on a timer it rescanned every file of a
        // large project each minute while nothing changed.
        loop {
            let WatchBatch { mut paths, mut reconcile } = match receiver.recv() {
                Ok(batch) => batch,
                Err(_) => return,
            };
            // Drain the burst: keep absorbing events until things go quiet or
            // the burst has run long enough to report.
            let burst = Instant::now() + MAX_BURST;
            loop {
                let wait = DEBOUNCE.min(burst.saturating_duration_since(Instant::now()));
                match receiver.recv_timeout(wait) {
                    Ok(batch) => {
                        paths.extend(batch.paths);
                        reconcile |= batch.reconcile;
                        if Instant::now() >= burst {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let changed_paths = payload_paths(&root, &paths, reconcile);
            let update = if reconcile {
                crate::fts::reconcile(&root)
            } else {
                crate::fts::update_paths(&root, &paths)
            };
            if let Err(error) = update {
                eprintln!("Could not update the project search index: {error}");
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

    /// Folders that arrive from outside the project, copied the way Finder
    /// or `cp -R` copies them and moved in whole, each reach the windows as a
    /// coalesced report naming the new folder.
    #[test]
    fn reports_folders_copied_or_moved_in_from_outside() {
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let project = crate::test_support::TempDir::new("watch-arrivals");
        let outside = crate::test_support::TempDir::new("watch-arrivals-outside");
        project.write("main.tex", "\\documentclass{article}");
        let root = project.canonicalize().unwrap();
        let (sender, reports) = mpsc::channel::<serde_json::Value>();
        app.handle().listen("project-fs-changed", move |event| {
            let _ = sender.send(serde_json::from_str(event.payload()).unwrap());
        });
        let _watcher = spawn(app.handle().clone(), root.clone()).unwrap();
        // Let the stream attach and anything from creating the fixture pass.
        std::thread::sleep(Duration::from_millis(500));
        while reports.recv_timeout(DEBOUNCE * 2).is_ok() {}
        // A report naming any of `paths`.
        let reported = |paths: &[&str]| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while let Ok(report) =
                reports.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                assert_eq!(report["root"], root.to_string_lossy().as_ref());
                // No paths (FSEvents asked for a rescan) covers every one.
                let Some(names) = report["paths"].as_array() else { return true };
                if names.iter().any(|name| paths.iter().any(|path| name == path)) {
                    return true;
                }
            }
            false
        };

        outside.write("figures/plots/loss.png", b"\x89PNG");
        outside.write("figures/table.tex", "\\begin{tabular}");
        std::fs::create_dir_all(root.join("figures/plots")).unwrap();
        for file in ["figures/plots/loss.png", "figures/table.tex"] {
            std::fs::copy(outside.join(file), root.join(file)).unwrap();
        }
        // FSEvents names every file the copy wrote. inotify watches a new
        // folder only once it is reported, so a copy that fills it first can
        // arrive as the folder alone, which still rescans the tree.
        let copied: &[&str] = if cfg!(target_os = "macos") {
            &["figures/plots/loss.png"]
        } else {
            &["figures/plots/loss.png", "figures/plots", "figures"]
        };
        assert!(reported(copied), "a copied folder went unreported");

        outside.write("appendix/proofs.tex", "proof");
        std::fs::rename(outside.join("appendix"), root.join("appendix")).unwrap();
        assert!(reported(&["appendix"]), "a moved-in folder went unreported");
    }

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
