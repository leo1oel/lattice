//! Overleaf's own history, read and acted on from the history drawer: the
//! project as Overleaf recorded it, including work done in the browser.

use super::overleaf::{leased_rest_call, rest_call};
use crate::app_state::AppState;
use crate::overleaf;
use tauri::{AppHandle, State, Window};

const HISTORY: &str = "The Overleaf history";

#[tauri::command]
pub async fn overleaf_history_updates(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    before: Option<i64>, count: Option<u32>,
) -> Result<serde_json::Value, String> {
    let (updates, next) =
        rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
            overleaf::history_updates(config, root, before, count.unwrap_or(20))
        })
        .await?;
    Ok(serde_json::json!({ "updates": updates, "nextBefore": next }))
}

#[tauri::command]
pub async fn overleaf_history_diff(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, path: String,
    from: i64, to: i64,
) -> Result<serde_json::Value, String> {
    rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_diff(config, root, &path, from, to)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_history_files(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_files(config, root, from, to)
    })
    .await
}

/// Roll one file back, or the whole project when `path` is absent.
#[tauri::command]
pub async fn overleaf_history_revert(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, version: i64,
    path: Option<String>,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_revert(config, root, version, path.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn overleaf_history_restore_file(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, version: i64,
    path: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_restore_file(config, root, version, &path)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_history_add_label(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, version: i64,
    comment: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_add_label(config, root, version, &comment)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_history_delete_label(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    label_id: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_delete_label(config, root, &label_id)
    })
    .await
}
