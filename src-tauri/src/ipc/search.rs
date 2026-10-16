//! Finding things in the project: text search, replace, labels, references,
//! TODOs and word counts.

use super::{current_root, in_project, pinned_root, run_blocking};
use crate::app_state::{AppState, Lease};
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

/// Rewrites every match on disk, so it names the project it was approved in:
/// one held behind a save can arrive after the window switched projects.
#[tauri::command]
pub async fn replace_in_project(
    state: State<'_, AppState>, window: Window, project_root: String, query: String,
    replacement: String, match_case: Option<bool>, use_regex: Option<bool>,
) -> Result<ReplaceResult, String> {
    let (match_case, use_regex) = (match_case.unwrap_or(true), use_regex.unwrap_or(false));
    let root = pinned_root(&state, &window, &project_root, "the replace could start")?;
    run_blocking("Project replace", move || {
        project::replace_in_project(&root, &query, &replacement, match_case, use_regex)
    })
    .await
}

/// The Terms panel's confirmed changes, read and checked against the files
/// as the check saw them; named by project like a replace, which it is.
#[tauri::command]
pub async fn apply_term_edits(
    state: State<'_, AppState>, window: Window, project_root: String, label: String,
    files: Vec<project::TermFileEdit>,
) -> Result<Vec<String>, String> {
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the changes could be made")?;
    run_blocking("Term changes", move || project::apply_term_edits(&root, &label, files)).await
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
pub async fn list_citation_usages(
    state: State<'_, AppState>, window: Window,
) -> Result<Vec<SymbolOccurrence>, String> {
    in_project(&state, &window, "Citation scan", project::citation_usages).await
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
