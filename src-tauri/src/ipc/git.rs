//! The project's Git repository.

use super::{in_project, lease_if_pinned, maybe_pinned_root, run_blocking};
use crate::app_state::AppState;
use crate::git;
use crate::models::{self, GitStatus};
use tauri::{State, Window};

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, window: Window) -> Result<GitStatus, String> {
    in_project(&state, &window, "Git status", git::status).await
}

#[tauri::command]
pub async fn git_init(state: State<'_, AppState>, window: Window) -> Result<GitStatus, String> {
    in_project(&state, &window, "Git initialization", git::init).await
}

#[tauri::command]
pub async fn git_log(
    state: State<'_, AppState>, window: Window, limit: Option<u32>,
) -> Result<Vec<models::GitLogEntry>, String> {
    let limit = limit.unwrap_or(200) as usize;
    in_project(&state, &window, "Git history", move |root| git::log(root, limit)).await
}

#[tauri::command]
pub async fn git_show_diff(
    state: State<'_, AppState>, window: Window, rev: String, path: String,
) -> Result<models::GitFileDiff, String> {
    in_project(&state, &window, "Git revision diff", move |root| git::show_diff(root, &rev, &path))
        .await
}

#[tauri::command]
pub async fn git_restore_file(
    state: State<'_, AppState>, window: Window, rev: String, path: String,
) -> Result<(), String> {
    in_project(&state, &window, "Git file restore", move |root| {
        git::restore_file(root, &rev, &path)
    })
    .await
}

#[tauri::command]
pub async fn git_restore_project(
    state: State<'_, AppState>, window: Window, rev: String,
) -> Result<String, String> {
    in_project(&state, &window, "Git project restore", move |root| git::restore_project(root, &rev))
        .await
}

#[tauri::command]
pub async fn git_auto_commit(
    state: State<'_, AppState>, window: Window, message: String, author: Option<String>,
    project_root: Option<String>,
) -> Result<Option<String>, String> {
    let _lease = lease_if_pinned(&state, project_root.as_ref()).await;
    let root = maybe_pinned_root(
        &state,
        &window,
        project_root.as_deref(),
        "the version could be recorded",
    )?;
    run_blocking("Git automatic commit", move || {
        git::auto_commit(&root, &message, author.as_deref())
    })
    .await
}
