//! Lattice's own edit history: the transaction records under `.research/history`.

use super::{current_root, in_project, maybe_pinned_root, run_blocking};
use crate::app_state::AppState;
use crate::models::{HistoryItem, TransactionRecord};
use crate::project;
use tauri::{State, Window};

#[tauri::command]
pub async fn list_history(
    state: State<'_, AppState>, window: Window,
) -> Result<Vec<HistoryItem>, String> {
    in_project(&state, &window, "History scan", project::history).await
}

#[tauri::command]
pub async fn get_history_entry(
    state: State<'_, AppState>, window: Window, transaction_id: String,
) -> Result<TransactionRecord, String> {
    let root = current_root(&state, &window)?;
    run_blocking("History entry read", move || project::get_history_entry(&root, &transaction_id))
        .await
}

#[tauri::command]
pub async fn revert_transaction(
    state: State<'_, AppState>, window: Window, transaction_id: String,
    project_root: Option<String>,
) -> Result<String, String> {
    let root =
        maybe_pinned_root(&state, &window, project_root.as_deref(), "the action could start")?;
    run_blocking("History revert", move || Ok(project::revert(&root, &transaction_id, None)?.id))
        .await
}

#[tauri::command]
pub async fn revert_history_file(
    state: State<'_, AppState>, window: Window, transaction_id: String, path: String,
) -> Result<String, String> {
    let root = current_root(&state, &window)?;
    run_blocking("History file revert", move || {
        Ok(project::revert(&root, &transaction_id, Some(&path))?.id)
    })
    .await
}

#[tauri::command]
pub async fn delete_history_entry(
    state: State<'_, AppState>, window: Window, transaction_id: String,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("History deletion", move || project::delete_history(&root, &transaction_id)).await
}
