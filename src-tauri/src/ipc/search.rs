//! Finding things in the project: text and semantic search, replace, labels,
//! references, TODOs and word counts.

use super::{current_root, in_project, run_blocking, scoped_root};
use crate::app_state::AppState;
use crate::models::{
    ProjectSearchResult, ReferenceInfo, RenameSymbolResult, ReplacePreview, ReplaceResult,
    SymbolOccurrence, TodoHit, UnusedSymbols, WordCount,
};
use crate::{papers, project, semantic_search, texcount};
use semantic_search::{SemanticSearchResponse, SemanticSearchStatus};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, Window};

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

#[tauri::command]
pub fn semantic_search_start_index(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<SemanticSearchStatus, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    let search = Arc::clone(&state.project(&root).semantic_search);
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve the local cache folder: {error}"))?
        .join("semantic-search")
        .join("embeddings-v1.sqlite3");
    semantic_search::start_index(Arc::clone(&search), root, cache);
    Ok(search.status())
}

#[tauri::command]
pub fn semantic_search_status(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<SemanticSearchStatus, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    Ok(state.project(&root).semantic_search.status())
}

#[tauri::command]
pub fn semantic_search_cancel(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<SemanticSearchStatus, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    Ok(state.project(&root).semantic_search.cancel())
}

#[tauri::command]
pub async fn semantic_search_project(
    state: State<'_, AppState>, window: Window, project_root: String, query: String,
) -> Result<SemanticSearchResponse, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    let search = Arc::clone(&state.project(&root).semantic_search);
    let response =
        run_blocking("Local semantic search", move || Ok(semantic_search::search(&search, &query)))
            .await?;
    scoped_root(&state, &window, &project_root)
        .map_err(|_| "The project changed before local semantic search finished.".to_string())?;
    Ok(response)
}
