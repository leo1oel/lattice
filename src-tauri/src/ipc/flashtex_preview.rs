//! The FlashTeX preview spike (flashtex_preview.rs): installing the engine,
//! one session per project, its compiles and the PDF each one writes. Only a
//! window with the developer flag on calls these.

use super::{pinned_root, run_blocking};
use crate::app_state::AppState;
use crate::flashtex_preview;
use std::sync::PoisonError;
use tauri::ipc::{Channel, Response};
use tauri::{State, Window};

#[tauri::command]
pub async fn flashtex_preview_status() -> flashtex_preview::InstallStatus {
    flashtex_preview::status()
}

#[tauri::command]
pub async fn flashtex_preview_install(
    on_progress: Channel<flashtex_preview::InstallProgress>,
) -> Result<flashtex_preview::InstallStatus, String> {
    run_blocking("FlashTeX preview install", move || {
        flashtex_preview::install(&super::channel_sink(on_progress))
    })
    .await
}

/// Copy the window's project and start FlashTeX on it, replacing a session
/// it already had; returns the new session's id, which later calls name.
#[tauri::command]
pub async fn flashtex_preview_start(
    state: State<'_, AppState>, window: Window, project_root: String, main_file: String,
    engine: flashtex_preview::Engine,
) -> Result<u64, String> {
    let root = pinned_root(&state, &window, &project_root, "the FlashTeX preview could start")?;
    let project = state.project(&root);
    let session = run_blocking("FlashTeX preview start", move || {
        flashtex_preview::Session::start(&root, &main_file, engine)
    })
    .await?;
    let id = session.id();
    let previous =
        project.flashtex_preview.lock().unwrap_or_else(PoisonError::into_inner).replace(session);
    if let Some(previous) = previous {
        previous.stop();
    }
    Ok(id)
}

#[tauri::command]
pub async fn flashtex_preview_stop(
    state: State<'_, AppState>, window: Window, project_root: String, session: u64,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "the FlashTeX preview could stop")?;
    let project = state.project(&root);
    let mut slot = project.flashtex_preview.lock().unwrap_or_else(PoisonError::into_inner);
    if slot.as_ref().is_some_and(|running| running.id() == session) {
        if let Some(running) = slot.take() {
            running.stop();
        }
    }
    Ok(())
}

/// The running session `session`, without holding the project's slot while
/// it compiles: stopping it then ends the compile instead of waiting for it.
fn handle(
    state: &AppState, window: &Window, project_root: &str, session: u64,
) -> Result<flashtex_preview::SessionHandle, String> {
    let root = pinned_root(state, window, project_root, "the FlashTeX preview could update")?;
    let project = state.project(&root);
    let slot = project.flashtex_preview.lock().unwrap_or_else(PoisonError::into_inner);
    match slot.as_ref() {
        Some(running) if running.id() == session => Ok(running.handle()),
        _ => Err("The FlashTeX preview has stopped.".into()),
    }
}

/// Typeset with the editor's unsaved `buffers`. The window sends the next
/// compile only once this one answers.
#[tauri::command]
pub async fn flashtex_preview_compile(
    state: State<'_, AppState>, window: Window, project_root: String, session: u64,
    buffers: Vec<flashtex_preview::Buffer>,
) -> Result<flashtex_preview::CompileReport, String> {
    let handle = handle(&state, &window, &project_root, session)?;
    run_blocking("FlashTeX preview compile", move || handle.compile(buffers)).await
}

/// The last compile's PDF, as raw bytes.
#[tauri::command]
pub async fn flashtex_preview_pdf(
    state: State<'_, AppState>, window: Window, project_root: String, session: u64,
) -> Result<Response, String> {
    let handle = handle(&state, &window, &project_root, session)?;
    let bytes = run_blocking("FlashTeX preview PDF", move || handle.pdf()).await?;
    Ok(Response::new(bytes))
}

/// Files that changed on disk (relative to the project), copied again.
#[tauri::command]
pub async fn flashtex_preview_sync(
    state: State<'_, AppState>, window: Window, project_root: String, session: u64,
    paths: Vec<String>,
) -> Result<(), String> {
    let handle = handle(&state, &window, &project_root, session)?;
    run_blocking("FlashTeX preview sync", move || handle.sync(&paths)).await
}
