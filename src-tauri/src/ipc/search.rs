//! Finding things in the project: text search, replace, labels, references,
//! TODOs and word counts.

use super::{current_root, in_project, run_blocking};
use crate::app_state::AppState;
use crate::models::{
    ProjectSearchResult, ReferenceInfo, RenameSymbolResult, ReplacePreview, ReplaceResult,
    SymbolOccurrence, TodoHit, UnusedSymbols, WordCount,
};
use crate::{papers, project, texcount};
use tauri::{State, Window};

#[tauri::command]
pub async fn search_project(
    state: State<'_, AppState>, window: Window, query: String,
) -> Result<Vec<ProjectSearchResult>, String> {
    in_project(&state, &window, "Project search", move |root| {
        let mut results = project::search_files(root, &query)?;
        results.extend(papers::search_library(root, &query)?);
        Ok(results)
    })
    .await
}

#[tauri::command]
pub async fn preview_replace_in_project(
    state: State<'_, AppState>, window: Window, query: String, match_case: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplacePreview, String> {
    let (match_case, use_regex) = (match_case.unwrap_or(true), use_regex.unwrap_or(false));
    let root = current_root(&state, &window)?;
    run_blocking("Replace preview", move || {
        project::preview_replace_in_project(&root, &query, match_case, use_regex)
    })
    .await
}

#[tauri::command]
pub async fn replace_in_project(
    state: State<'_, AppState>, window: Window, query: String, replacement: String,
    match_case: Option<bool>, use_regex: Option<bool>,
) -> Result<ReplaceResult, String> {
    let (match_case, use_regex) = (match_case.unwrap_or(true), use_regex.unwrap_or(false));
    let root = current_root(&state, &window)?;
    run_blocking("Project replace", move || {
        project::replace_in_project(&root, &query, &replacement, match_case, use_regex)
    })
    .await
}

#[tauri::command]
pub async fn find_label_occurrences(
    state: State<'_, AppState>, window: Window, label: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Label search", move || project::Symbol::Label.occurrences(&root, &label)).await
}

#[tauri::command]
pub async fn find_citation_occurrences(
    state: State<'_, AppState>, window: Window, key: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Citation search", move || project::Symbol::Citation.occurrences(&root, &key))
        .await
}

#[tauri::command]
pub async fn rename_label(
    state: State<'_, AppState>, window: Window, old_label: String, new_label: String,
) -> Result<RenameSymbolResult, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Label rename", move || {
        project::Symbol::Label.rename(&root, &old_label, &new_label)
    })
    .await
}

#[tauri::command]
pub async fn rename_citation_key(
    state: State<'_, AppState>, window: Window, old_key: String, new_key: String,
) -> Result<RenameSymbolResult, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Citation rename", move || {
        project::Symbol::Citation.rename(&root, &old_key, &new_key)
    })
    .await
}

#[tauri::command]
pub async fn list_references(
    state: State<'_, AppState>, window: Window,
) -> Result<Vec<ReferenceInfo>, String> {
    in_project(&state, &window, "Reference scan", project::references).await
}

#[tauri::command]
pub async fn list_unused_symbols(
    state: State<'_, AppState>, window: Window,
) -> Result<UnusedSymbols, String> {
    in_project(&state, &window, "Symbol scan", project::unused_symbols).await
}

#[tauri::command]
pub async fn list_todos(
    state: State<'_, AppState>, window: Window,
) -> Result<Vec<TodoHit>, String> {
    in_project(&state, &window, "TODO scan", project::list_todos).await
}

#[tauri::command]
pub async fn count_project_words(
    state: State<'_, AppState>, window: Window,
) -> Result<WordCount, String> {
    in_project(&state, &window, "Word count", texcount::count_project).await
}
