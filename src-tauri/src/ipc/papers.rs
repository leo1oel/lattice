//! Literature search and the project's paper library.

use super::{current_root, in_project, run_blocking};
use crate::app_state::AppState;
use crate::literature::LiteraturePage;
use crate::models::ProjectSearchResult;
use crate::papers::{ImportResult, PaperSummary};
use crate::{literature, paper_pdf_proxy, papers};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, Window};

/// Announce a literature pipeline stage to the window. Best-effort: a stage
/// the frontend never hears about only degrades the status line, never the
/// import itself.
fn emit_paper_progress(app: &AppHandle, window_label: &str, stage: &str) {
    // Addressed to the window that started the import. Broadcasting made a
    // second window narrate progress for a paper it was not importing.
    let _ = app.emit_to(window_label, "paper-import-progress", stage);
}

#[tauri::command]
pub async fn search_literature(
    query: String, precise: Option<bool>, page: Option<u32>,
) -> Result<LiteraturePage, String> {
    let (precise, page) = (precise.unwrap_or(false), page.unwrap_or(0));
    run_blocking("The literature search task", move || literature::search(&query, precise, page))
        .await
}

#[tauri::command]
pub async fn import_reference(
    app: AppHandle, state: State<'_, AppState>, window: Window, input: String, request_id: String,
) -> Result<ImportResult, String> {
    let root = current_root(&state, &window)?;
    let window_label = window.label().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .paper_imports
        .lock()
        .map_err(|_| "Paper import state is unavailable.".to_string())?
        .insert(window_label.clone(), (request_id.clone(), Arc::clone(&cancel)));
    let result = run_blocking("The paper import task", move || {
        let progress = |stage: &str| emit_paper_progress(&app, &window_label, stage);
        papers::import_reference(&root, &input, papers::HistoryMode::Record, &progress, &cancel)
    })
    .await;
    if let Ok(mut imports) = state.paper_imports.lock() {
        if imports.get(window.label()).is_some_and(|(id, _)| id == &request_id) {
            imports.remove(window.label());
        }
    }
    result
}

#[tauri::command]
pub fn cancel_reference_import(
    state: State<'_, AppState>, window: Window, request_id: String,
) -> Result<bool, String> {
    let imports =
        state.paper_imports.lock().map_err(|_| "Paper import state is unavailable.".to_string())?;
    let Some((active_id, cancel)) = imports.get(window.label()) else {
        return Ok(false);
    };
    if active_id != &request_id {
        return Ok(false);
    }
    cancel.store(true, Ordering::Release);
    Ok(true)
}

#[tauri::command]
pub async fn fetch_paper(
    app: AppHandle, state: State<'_, AppState>, window: Window, arxiv_id: String,
) -> Result<papers::FetchResult, String> {
    let window_label = window.label().to_string();
    in_project(&state, &window, "Paper fetch", move |root| {
        let progress = |stage: &str| emit_paper_progress(&app, &window_label, stage);
        papers::fetch_paper(root, &arxiv_id, &progress)
    })
    .await
}

#[tauri::command]
pub async fn paper_pdf_preview_url(
    state: State<'_, AppState>, window: Window, url: String,
) -> Result<String, String> {
    current_root(&state, &window)?;
    paper_pdf_proxy::preview_url(&url).await
}

#[tauri::command]
pub async fn fetch_web_reference(
    state: State<'_, AppState>, window: Window, url: String,
) -> Result<papers::FetchResult, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Web reference fetch", move || papers::fetch_web_reference(&root, &url)).await
}

#[tauri::command]
pub async fn list_papers(
    state: State<'_, AppState>, window: Window,
) -> Result<Vec<PaperSummary>, String> {
    in_project(&state, &window, "Paper scan", papers::list_papers).await
}

#[tauri::command]
pub async fn search_paper_library(
    state: State<'_, AppState>, window: Window, query: String,
) -> Result<Vec<ProjectSearchResult>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Paper library search", move || papers::search_library(&root, &query)).await
}

#[tauri::command]
pub async fn read_paper(
    state: State<'_, AppState>, window: Window, arxiv_id: String,
) -> Result<String, String> {
    in_project(&state, &window, "Paper read", move |root| papers::read_paper(root, &arxiv_id)).await
}

#[tauri::command]
pub async fn read_paper_blog_local(
    state: State<'_, AppState>, window: Window, arxiv_id: String,
) -> Result<Option<String>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Paper overview read", move || papers::read_paper_blog_local(&root, &arxiv_id))
        .await
}
