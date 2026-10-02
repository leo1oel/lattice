//! Finding things in the project: text search, replace, labels, references,
//! TODOs and word counts.

use super::{current_root, in_project, run_blocking};
use crate::app_state::AppState;
use crate::models::{ProjectSearchResult, SymbolOccurrence};
use crate::project::{
    ReferenceInfo, RenameSymbolResult, ReplacePreview, ReplaceResult, TodoHit, UnusedSymbols,
};
use crate::texcount::WordCount;
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
pub async fn find_symbol_occurrences(
    state: State<'_, AppState>, window: Window, kind: project::Symbol, name: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    let root = current_root(&state, &window)?;
    let label = match kind {
        project::Symbol::Label => "Label search",
        project::Symbol::Citation => "Citation search",
    };
    run_blocking(label, move || kind.occurrences(&root, &name)).await
}

#[tauri::command]
pub async fn rename_symbol(
    state: State<'_, AppState>, window: Window, kind: project::Symbol, old_name: String,
    new_name: String,
) -> Result<RenameSymbolResult, String> {
    let root = current_root(&state, &window)?;
    let label = match kind {
        project::Symbol::Label => "Label rename",
        project::Symbol::Citation => "Citation rename",
    };
    run_blocking(label, move || kind.rename(&root, &old_name, &new_name)).await
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
