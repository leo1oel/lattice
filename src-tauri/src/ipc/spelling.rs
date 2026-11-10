//! Spell checking in a document's own language (`spelling.rs`): which
//! language that is, downloading its dictionary, and checking prose with it.

use super::{pinned_root, run_blocking, run_quietly};
use crate::app_state::AppState;
use crate::{harper, spelling};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State, Window};

/// Where downloaded dictionaries are kept.
fn store(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("spelling-dictionaries"))
}

/// The language of `path` in the window's project, `None` for English.
#[tauri::command]
pub async fn spelling_document_language(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, path: String,
) -> Result<Option<spelling::SpellingLanguage>, String> {
    let root = pinned_root(&state, &window, &project_root, "its language was read")?;
    let store = store(&app)?;
    // Asked on every lint pass; reads the root's preamble and its inputs.
    run_quietly("spelling_document_language", move || {
        Ok(spelling::document_language(&store, &root, &path))
    })
    .await
}

#[tauri::command]
pub async fn spelling_install_dictionary(app: AppHandle, code: String) -> Result<(), String> {
    let store = store(&app)?;
    run_blocking("spelling_install_dictionary", move || {
        spelling::install_dictionary(&store, &code, &spelling::HttpFetch)
    })
    .await
}

#[tauri::command]
pub async fn spelling_lint(
    app: AppHandle, code: String, text: String, project_words: Vec<String>,
) -> Result<Vec<harper::HarperLintOut>, String> {
    let store = store(&app)?;
    run_blocking("spelling_lint", move || spelling::lint(&store, &code, &text, &project_words))
        .await
}

#[tauri::command]
pub async fn spelling_dictionaries(
    app: AppHandle,
) -> Result<Vec<spelling::DictionaryInfo>, String> {
    let store = store(&app)?;
    run_blocking("spelling_dictionaries", move || Ok(spelling::dictionaries(&store))).await
}
