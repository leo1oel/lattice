//! Creating, opening and configuring projects.

use super::{current_root, run_blocking, run_quietly};
use crate::app_state::AppState;
use crate::models::{ProjectManifest, ProjectSnapshot};
use crate::{fs_watch, project};
use std::path::{Path, PathBuf};
use std::sync::PoisonError;
use tauri::{AppHandle, Manager, State, Window};

/// `name` under the user's Documents folder, created on demand; `what` names it
/// in the error when it cannot be.
pub(crate) fn documents_folder(app: &AppHandle, name: &str, what: &str) -> Result<PathBuf, String> {
    let folder = app
        .path()
        .document_dir()
        .map_err(|error| format!("Could not resolve Documents folder: {error}"))?
        .join(name);
    std::fs::create_dir_all(&folder)
        .map_err(|error| format!("Could not create {what}: {error}"))?;
    Ok(folder)
}

/// Create a project on disk. Which window shows it is a separate decision the
/// caller makes with `open_project` or `open_project_window` — binding it here
/// would take the calling window's project away before it could open the new
/// one somewhere else.
#[tauri::command]
pub async fn create_project(
    parent: String, name: String, venue: Option<String>,
) -> Result<ProjectSnapshot, String> {
    let venue = project::Venue::parse(venue.as_deref().unwrap_or("neurips"))?;
    run_blocking("Project creation", move || {
        project::open(&project::create_with_venue(Path::new(&parent), &name, venue)?)
    })
    .await
}

#[tauri::command]
pub async fn open_tutorial_project(
    app: AppHandle, state: State<'_, AppState>, window: Window,
) -> Result<ProjectSnapshot, String> {
    let parent = documents_folder(&app, "Lattice Tutorials", "Lattice Tutorials folder")?;
    let (root, snapshot) = run_blocking("Tutorial project creation", move || {
        let root = project::create_tutorial(&parent)?;
        let snapshot = project::open(&root)?;
        Ok((root, snapshot))
    })
    .await?;
    state.set_root(window.label(), root).await?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn initial_project(
    state: State<'_, AppState>, window: Window,
) -> Result<Option<ProjectSnapshot>, String> {
    // Both the window the app launches with (bound from LATTICE_PROJECT) and a
    // window opened for a specific project (bound before it loads) find their
    // project here, so the frontend startup path is the same for either.
    let root = state.root_for(window.label())?;
    // A lab run opens its fixture project in whichever window loads first.
    #[cfg(feature = "perf-lab")]
    let root = match (root, crate::perf_lab::project()) {
        (None, Some(project)) => {
            state.set_root(window.label(), project.clone()).await?;
            Some(project)
        }
        (root, _) => root,
    };
    run_blocking("Initial project load", move || root.map(|path| project::open(&path)).transpose())
        .await
}

#[tauri::command]
pub async fn open_project(
    state: State<'_, AppState>, window: Window, path: String,
) -> Result<ProjectSnapshot, String> {
    let snapshot = run_blocking("Project opening", move || project::open(Path::new(&path))).await?;
    let root = PathBuf::from(&snapshot.root);
    if state.window_showing(&root).is_some_and(|label| label != window.label()) {
        return Err(
            "This project is already open in another Lattice window. Open it in the browser from that window instead."
                .to_string(),
        );
    }
    state.set_root(window.label(), root).await?;
    Ok(snapshot)
}

/// Unpack a project from a ZIP. As with `create_project`, placing it in a
/// window is the caller's separate decision.
#[tauri::command]
pub async fn import_project_zip(
    zip_path: String, parent: String,
) -> Result<ProjectSnapshot, String> {
    run_blocking("Project import", move || {
        project::import_project_zip(Path::new(&zip_path), Path::new(&parent))
    })
    .await
}

#[tauri::command]
pub async fn export_project_zip(
    state: State<'_, AppState>, window: Window, zip_path: String,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("Project export", move || project::export_project_zip(&root, Path::new(&zip_path)))
        .await
}

#[tauri::command]
pub async fn refresh_project(
    state: State<'_, AppState>, window: Window,
) -> Result<ProjectSnapshot, String> {
    let root = current_root(&state, &window)?;
    run_quietly("Project refresh", move || project::open(&root)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_project_manifest(
    state: State<'_, AppState>, window: Window, engine: Option<String>, trusted: Option<bool>,
    word_budget: Option<u32>, page_budget: Option<u32>, clear_word_budget: Option<bool>,
    clear_page_budget: Option<bool>,
) -> Result<ProjectManifest, String> {
    let words = if clear_word_budget.unwrap_or(false) { Some(None) } else { word_budget.map(Some) };
    let pages = if clear_page_budget.unwrap_or(false) { Some(None) } else { page_budget.map(Some) };
    let root = current_root(&state, &window)?;
    run_blocking("Project settings update", move || {
        project::update_manifest_settings(&root, engine, trusted, words, pages)
    })
    .await
}

#[tauri::command]
pub async fn set_project_spelling_words(
    state: State<'_, AppState>, window: Window, words: Vec<String>,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Project dictionary update", move || project::set_spelling_words(&root, words))
        .await
}

#[tauri::command]
pub fn watch_project(
    app: AppHandle, state: State<'_, AppState>, window: Window,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    let resources = state.project(&root);
    let mut watcher = resources.fs_watcher.lock().unwrap_or_else(PoisonError::into_inner);
    if watcher.is_none() {
        *watcher = Some(fs_watch::spawn(app, root)?);
    }
    Ok(())
}
