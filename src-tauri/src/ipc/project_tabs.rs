//! A project can change windows only after both pages save and agree to leave
//! their current editors. The host transfers the binding once, while both
//! pages are held, so no window can start editing the transferred root early.

use super::{run_blocking, windows::free_project_window_label};
use crate::app_state::{AppState, Lease};
use crate::{latex, models::ProjectSnapshot, project};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;

const REQUEST_EVENT: &str = "project-tab-move-request";

#[derive(Default)]
pub(crate) struct ProjectTabMoves(Mutex<HashMap<String, PendingMove>>);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTabDestination {
    window_label: String,
    before_root: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveRequest {
    id: String,
    before_root: Option<String>,
}

#[derive(Clone)]
struct ProjectMove {
    source: String,
    source_root: PathBuf,
    root: PathBuf,
    destination: String,
}

struct PendingMove {
    movement: ProjectMove,
    reply: oneshot::Sender<bool>,
}

impl ProjectTabMoves {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingMove>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn reject(&self, id: &str, destination: &str) {
        let mut pending = self.pending();
        if pending.get(id).is_some_and(|request| request.movement.destination == destination) {
            if let Some(request) = pending.remove(id) {
                let _ = request.reply.send(false);
            }
        }
    }
}

impl ProjectMove {
    fn from_active_tab(&self) -> bool {
        self.root == self.source_root
    }

    fn check_bindings(
        &self, roots: &HashMap<String, PathBuf>, destination_root: Option<&Path>,
    ) -> Result<(), String> {
        if roots.get(&self.source) != Some(&self.source_root)
            || roots.get(&self.destination).map(PathBuf::as_path) != destination_root
            || roots.iter().any(|(label, root)| root == &self.root && label != &self.source)
        {
            return Err("The project changed before its tab could move.".into());
        }
        Ok(())
    }

    fn claim_binding(&self, roots: &mut HashMap<String, PathBuf>) {
        if self.from_active_tab() {
            roots.remove(&self.source);
        }
        roots.insert(self.destination.clone(), self.root.clone());
    }
}

/// Claim the destination with no interval in which two windows own the root.
/// A path-pinned write or sync that already started must release its lease
/// first. Lock both roots in path order so opposite moves cannot deadlock.
async fn transfer_binding(
    state: &AppState, movement: &ProjectMove, destination_root: Option<&Path>,
    still_pending: impl FnOnce() -> bool,
) -> Result<bool, String> {
    let mut roots_to_leave = Vec::new();
    if movement.from_active_tab() {
        roots_to_leave.push(movement.root.as_path());
    }
    roots_to_leave.extend(destination_root);
    roots_to_leave.sort_unstable();
    roots_to_leave.dedup();
    let mut leases = Vec::new();
    for root in roots_to_leave {
        leases.push(state.structural_lease(root, Lease::Exclusive).await);
    }
    let mut roots = state.roots()?;
    movement.check_bindings(&roots, destination_root)?;
    // The source's wait may have expired while a sync held a project lease.
    // The caller keeps the request lock through this test and the binding.
    if !still_pending() {
        return Ok(false);
    }
    movement.claim_binding(&mut roots);
    // Invalidate the old pages' realtime generations under the ownership
    // lock. The new page will reconnect through its normal entry path.
    let previous_connections: Vec<_> =
        leases.iter().filter_map(|lease| lease.project.realtime().ok()?.cancel(None)).collect();
    drop(roots);
    for previous in previous_connections {
        previous.shutdown();
    }
    for lease in &leases {
        let _ = latex::abort(&lease.project.active_build);
        lease.project.stop_live_preview();
        if let Ok(mut pool) = lease.project.texlab.lock() {
            pool.reset();
        }
    }
    state.retire_unused_projects();
    Ok(true)
}

#[tauri::command]
pub async fn move_project_tab(
    app: AppHandle, window: WebviewWindow, state: State<'_, AppState>,
    moves: State<'_, ProjectTabMoves>, id: String, root: String, source_root: String,
    target: Option<ProjectTabDestination>,
) -> Result<bool, String> {
    if !crate::is_workspace_window(window.label()) {
        return Ok(false);
    }
    let root =
        run_blocking("Project opening", move || project::folder_root(Path::new(&root))).await?;
    let source = window.label().to_owned();
    let source_root = PathBuf::from(source_root);

    let Some(target) = target else {
        let destination = free_project_window_label(&app, &state);
        let movement = ProjectMove { source, source_root, root, destination };
        // Check the manifest before opening a native window so unreadable
        // projects report a failure in the original window.
        let path = movement.root.clone();
        run_blocking("Project opening", move || project::open(&path)).await?;
        transfer_binding(&state, &movement, None, || true).await?;
        return match crate::workspace_window(&app, &movement.destination, false) {
            Ok(created) => {
                let _ = created.set_focus();
                Ok(true)
            }
            Err(error) => {
                let source_exists = app.get_webview_window(&movement.source).is_some();
                let mut roots = state.roots()?;
                if roots.get(&movement.destination) == Some(&movement.root) {
                    roots.remove(&movement.destination);
                }
                if movement.from_active_tab() && source_exists {
                    roots.entry(movement.source).or_insert(movement.source_root);
                }
                Err(format!("Could not open a new Lattice window: {error}"))
            }
        };
    };
    let destination = target.window_label;
    if source == destination || !crate::is_workspace_window(&destination) {
        return Ok(false);
    }
    let Some(receiver) = app.get_webview_window(&destination) else { return Ok(false) };
    let (reply, mut answer) = oneshot::channel();
    let movement = ProjectMove { source, source_root, root, destination: destination.clone() };
    {
        let mut pending = moves.pending();
        if pending.contains_key(&id) {
            return Ok(false);
        }
        pending.insert(id.clone(), PendingMove { movement, reply });
    }
    let _ = receiver.set_focus();
    if let Err(error) = app.emit_to(
        &destination,
        REQUEST_EVENT,
        MoveRequest { id: id.clone(), before_root: target.before_root },
    ) {
        moves.reject(&id, &destination);
        return Err(error.to_string());
    }
    // A target window can close, reload, or leave a confirmation unanswered.
    // Expiring the request also invalidates delayed claims in that window.
    match tokio::time::timeout(Duration::from_secs(120), &mut answer).await {
        Ok(result) => Ok(result.unwrap_or(false)),
        Err(_) => {
            moves.reject(&id, &destination);
            Ok(answer.await.unwrap_or(false))
        }
    }
}

#[tauri::command]
pub async fn receive_project_tab(
    window: WebviewWindow, state: State<'_, AppState>, moves: State<'_, ProjectTabMoves>,
    id: String, active_root: Option<String>,
) -> Result<Option<ProjectSnapshot>, String> {
    let destination = window.label();
    let Some(active_root) = active_root else {
        moves.reject(&id, destination);
        return Ok(None);
    };
    let movement = moves.pending().get(&id).and_then(|request| {
        (request.movement.destination == destination).then(|| request.movement.clone())
    });
    let Some(movement) = movement else { return Ok(None) };
    let path = movement.root.clone();
    let snapshot = run_blocking("Project opening", move || project::open(&path)).await?;
    let mut accepted = None;
    let moved = transfer_binding(&state, &movement, Some(Path::new(&active_root)), || {
        accepted = moves.pending().remove(&id);
        accepted.is_some()
    })
    .await?;
    if let Some(request) = accepted {
        let _ = request.reply.send(moved);
    }
    Ok(moved.then_some(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_tabs_change_one_binding_without_overwriting_a_stale_destination() {
        let mut roots = HashMap::from([
            ("main".into(), PathBuf::from("/a")),
            ("project-1".into(), PathBuf::from("/b")),
        ]);
        let mut movement = ProjectMove {
            source: "project-1".into(),
            source_root: "/b".into(),
            root: "/b".into(),
            destination: "main".into(),
        };
        assert!(movement.check_bindings(&roots, Some(Path::new("/old"))).is_err());
        movement.check_bindings(&roots, Some(Path::new("/a"))).unwrap();
        movement.claim_binding(&mut roots);
        assert_eq!(roots, HashMap::from([("main".into(), PathBuf::from("/b"))]));

        movement.source = "main".into();
        movement.destination = "project-1".into();
        movement.root = "/a".into();
        movement.check_bindings(&roots, None).unwrap();
        movement.claim_binding(&mut roots);
        assert_eq!(
            roots.len(),
            2,
            "moving a suspended tab leaves the source's active project in place"
        );
    }
}
