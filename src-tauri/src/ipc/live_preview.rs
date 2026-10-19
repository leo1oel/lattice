//! The rtex live preview for LuaLaTeX projects (live_preview.rs): installing
//! the engine, one session per project, and the files its renderer reads.

use super::{pinned_root, run_blocking};
use crate::app_state::AppState;
use crate::live_preview;
use std::sync::PoisonError;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{State, Window};

#[tauri::command]
pub async fn live_preview_status() -> Result<live_preview::InstallStatus, String> {
    // It may run `lualatex --version`.
    run_blocking("Live preview status", || Ok(live_preview::status())).await
}

#[tauri::command]
pub async fn live_preview_install(
    on_progress: Channel<live_preview::InstallProgress>,
) -> Result<live_preview::InstallStatus, String> {
    run_blocking("Live preview install", move || live_preview::install(&on_progress)).await
}

/// Stop every session, then delete rtex and its build folders.
#[tauri::command]
pub async fn live_preview_remove(
    state: State<'_, AppState>,
) -> Result<live_preview::InstallStatus, String> {
    state.stop_all_live_previews();
    run_blocking("Live preview removal", live_preview::remove).await
}

/// Start rtex for the window's project, replacing a session it already had,
/// and return the new session's id: later calls name it, so a request meant
/// for a session that has since been replaced does not reach its successor.
#[tauri::command]
pub async fn live_preview_start(
    state: State<'_, AppState>, window: Window, project_root: String, main_file: String,
    on_event: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    let root = pinned_root(&state, &window, &project_root, "live preview could start")?;
    let project = state.project(&root);
    let session = run_blocking("Live preview start", move || {
        live_preview::Session::start(&root, &main_file, on_event)
    })
    .await?;
    let id = session.id();
    let previous =
        project.live_preview.lock().unwrap_or_else(PoisonError::into_inner).replace(session);
    if let Some(previous) = previous {
        previous.stop();
    }
    Ok(id)
}

#[tauri::command]
pub async fn live_preview_stop(
    state: State<'_, AppState>, window: Window, project_root: String, session: u64,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "live preview could stop")?;
    let project = state.project(&root);
    let mut slot = project.live_preview.lock().unwrap_or_else(PoisonError::into_inner);
    if slot.as_ref().is_some_and(|running| running.id() == session) {
        if let Some(running) = slot.take() {
            running.stop();
        }
    }
    Ok(())
}

/// Send rtex command lines (edit, set_document, request_layout, status or
/// spans), in order. The window sends its next batch only once this one is
/// written, so lines reach rtex in the order they were made.
#[tauri::command]
pub async fn live_preview_send(
    state: State<'_, AppState>, window: Window, project_root: String, session: u64,
    commands: Vec<String>,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "the live preview could update")?;
    let lines = commands
        .iter()
        .map(|command| live_preview::allowed_command(command))
        .collect::<Result<Vec<_>, _>>()?;
    let project = state.project(&root);
    let mut slot = project.live_preview.lock().unwrap_or_else(PoisonError::into_inner);
    match slot.as_mut() {
        Some(running) if running.id() == session => {
            lines.iter().try_for_each(|line| running.send(line))
        }
        _ => Err("The live preview has stopped.".into()),
    }
}

/// A file the renderer draws: `kind` is "font" (a TeX font, encoding or map
/// file), "image" (a project image) or "fallback" (the PDF of a layout rtex
/// could not describe exactly).
#[tauri::command]
pub async fn live_preview_read_file(
    state: State<'_, AppState>, window: Window, project_root: String, session: u64, kind: String,
    path: String,
) -> Result<Response, String> {
    let root = pinned_root(&state, &window, &project_root, "the live preview could load a file")?;
    let build_dir = {
        let project = state.project(&root);
        let slot = project.live_preview.lock().unwrap_or_else(PoisonError::into_inner);
        match slot.as_ref() {
            Some(running) if running.id() == session => running.build_dir().to_path_buf(),
            _ => return Err("The live preview has stopped.".into()),
        }
    };
    let bytes = run_blocking("Live preview file read", move || match kind.as_str() {
        "font" => live_preview::read_font_file(&path),
        "image" => live_preview::read_image_file(&root, &path),
        "fallback" => live_preview::read_fallback_pdf(&build_dir, &path),
        other => Err(format!("Unknown live preview file kind {other:?}.")),
    })
    .await?;
    Ok(Response::new(bytes))
}
