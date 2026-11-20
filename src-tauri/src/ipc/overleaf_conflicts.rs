//! What a sync conflict leaves the writer to choose: the copy it set aside
//! under `.research/overleaf-conflicts/` can go back on its path.

use super::{run_blocking, scoped_root};
use crate::app_state::{AppState, Lease};
use crate::overleaf;
use tauri::{State, Window};

/// Put the copy an Overleaf sync conflict set aside back on its path.
#[tauri::command]
pub async fn overleaf_restore_set_aside(
    state: State<'_, AppState>, window: Window, project_root: String, set_aside: String,
    path: String,
) -> Result<(), String> {
    let _lease = state.lease(&project_root, Lease::Exclusive).await;
    let root = scoped_root(&state, &window, &project_root)?;
    run_blocking("Restoring a set-aside copy", move || {
        overleaf::restore_set_aside(&root, &set_aside, &path)
    })
    .await
}
