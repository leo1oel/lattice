//! Lattice's own edit history: the transaction records under `.research/history`.

use super::{current_root, in_project, maybe_pinned_root, pinned_root, run_blocking};
use crate::app_state::AppState;
use crate::project;
use crate::project::{HistoryItem, ReviewBases, TransactionRecord};
use std::collections::BTreeMap;
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

/// Review mode's bases, or nothing while it is off (project/review_mode.rs).
#[tauri::command]
pub async fn review_mode_load(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<Option<ReviewBases>, String> {
    let root = pinned_root(&state, &window, &project_root, "review mode could be read")?;
    run_blocking("Review mode read", move || project::load_review(&root)).await
}

/// Turn review mode on: every `.tex` and `.bib` as it is now becomes its base.
#[tauri::command]
pub async fn review_mode_start(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<ReviewBases, String> {
    let root = pinned_root(&state, &window, &project_root, "review mode could be turned on")?;
    run_blocking("Review mode start", move || project::start_review(&root)).await
}

/// Every `.tex` and `.bib` as it is now, read before an Overleaf sync changes them.
#[tauri::command]
pub async fn review_mode_files(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<BTreeMap<String, String>, String> {
    let root = pinned_root(&state, &window, &project_root, "review mode could be read")?;
    run_blocking("Review mode read", move || project::reviewable_texts(&root)).await
}

/// Keep a file's new base: an accept, or a co-author's edit carried into it.
#[tauri::command]
pub async fn review_mode_save_base(
    state: State<'_, AppState>, window: Window, project_root: String, path: String, base: String,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "the reviewed text could be saved")?;
    run_blocking("Review base save", move || project::save_review_base(&root, &path, &base)).await
}

/// Turn review mode off: the files stay as they are; the bases are deleted.
#[tauri::command]
pub async fn review_mode_stop(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "review mode could be turned off")?;
    state.project(&root).review_changes.cancel();
    run_blocking("Review mode stop", move || project::stop_review(&root)).await
}
