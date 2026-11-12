//! The embedded Open Slide runtime's leases (`presentation`).

use super::run_blocking;
use crate::app_state::AppState;
use crate::presentation::{LeaseOwner, PresentationInfo, PresentationRuntime};
use std::fs;
use tauri::{AppHandle, Manager, State, Window};

#[tauri::command]
pub async fn presentation_ensure_ready(
    app: AppHandle, window: Window, runtime: State<'_, PresentationRuntime>, project_root: String,
    page_id: String,
) -> Result<PresentationInfo, String> {
    let owner = LeaseOwner { window: window.label().to_string(), page: page_id };
    let runtime = runtime.inner().clone();
    run_blocking("Open Slide startup", move || {
        let state = app.state::<AppState>();
        // Bindings and lease roots are both canonical paths in practice;
        // canonicalizing again keeps a spelling difference from making a
        // live lease look stale.
        let shows = |window: &str| {
            state.root_for(window).ok().flatten().and_then(|root| fs::canonicalize(root).ok())
        };
        runtime.ensure(&project_root, owner, &shows)
    })
    .await
}

/// Async so it runs off the main thread: releasing waits on the supervisor
/// lock, which `ensure` holds through a startup of up to `STARTUP_TIMEOUT`.
#[tauri::command]
pub async fn presentation_release(
    runtime: State<'_, PresentationRuntime>, project_root: String, lease_id: String,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    run_blocking("Open Slide release", move || runtime.release(&project_root, &lease_id)).await
}

#[tauri::command]
pub async fn presentation_refresh_native_workspace(
    runtime: State<'_, PresentationRuntime>, project_root: String,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    run_blocking("Open Slide refresh", move || runtime.refresh(&project_root)).await
}
