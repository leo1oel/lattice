//! Project filesystem watcher.
//!
//! The frontend used to poll `refresh_project` + `git_status` every 2
//! seconds, which re-scanned the project tree and spawned git subprocesses
//! whether or not anything had changed. This watcher inverts that: `notify`
//! (FSEvents on macOS) reports changes, a debounce thread coalesces bursts,
//! and one `project-fs-changed` event tells every window showing that root
//! to refresh. The frontend keeps a slow fallback poll as a safety net.
//!
//! `.research/` churn is filtered out — the app's own state writes (history
//! records, FTS index, caches) fire on every save and are invisible to the
//! project tree anyway (`scan_files` excludes them). `.git/` events stay:
//! they are how commits and stages reach the source-control badge without
//! polling.

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
use tauri::Emitter;

/// Quiet period before a burst of events becomes one refresh.
const DEBOUNCE_MS: u64 = 300;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    root: String,
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

pub fn spawn(app: tauri::AppHandle, root: PathBuf) -> Result<ProjectWatcher, String> {
    let (sender, receiver) = mpsc::channel::<()>();
    let filter_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: Result<Event, notify::Error>| {
        let Ok(event) = event else { return };
        if !relevant(&event, &filter_root) {
            return;
        }
        let _ = sender.send(());
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;

    let payload = FsChangedPayload {
        root: root.to_string_lossy().to_string(),
    };
    std::thread::spawn(move || {
        while receiver.recv().is_ok() {
            // Drain the burst: keep absorbing events until things go quiet.
            loop {
                match receiver.recv_timeout(Duration::from_millis(DEBOUNCE_MS)) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            // Broadcast; each window filters by its own project root.
            let _ = app.emit("project-fs-changed", payload.clone());
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
        assert!(relevant(&event_for(vec![root.join("main.tex")]), &root));
        assert!(relevant(&event_for(vec![root.join(".git/index")]), &root));
        assert!(!relevant(
            &event_for(vec![root.join(".research/history/x.json")]),
            &root
        ));
        // Mixed bursts stay relevant if any path matters.
        assert!(relevant(
            &event_for(vec![
                root.join(".research/cache/fts.sqlite"),
                root.join("notes.md")
            ]),
            &root
        ));
    }
}
