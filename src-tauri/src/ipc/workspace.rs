//! Creating, opening and configuring projects.

use super::{current_root, pinned_root, run_blocking, run_quietly};
use crate::app_state::AppState;
use crate::models::{ProjectDeadline, ProjectManifest, ProjectSnapshot, SubmissionItem};
use crate::{fs_watch, latex, project, wide_event};
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
    app: AppHandle, parent: String, name: String, venue: Option<String>,
) -> Result<ProjectSnapshot, String> {
    let store = app.path().app_data_dir().map_err(crate::util::err)?.join("templates");
    run_blocking("Project creation", move || {
        let venue = venue.as_deref().unwrap_or("neurips");
        let root = if let Some(id) = venue.strip_prefix("local:") {
            project::templates::instantiate(&store, id, Path::new(&parent), &name)?
        } else {
            project::create_with_venue(Path::new(&parent), &name, project::Venue::parse(venue)?)?
        };
        project::open(&root)
    })
    .await
}

#[tauri::command]
pub async fn list_local_templates(
    app: AppHandle,
) -> Result<Vec<project::templates::LocalTemplate>, String> {
    let store = app.path().app_data_dir().map_err(crate::util::err)?.join("templates");
    run_blocking("Template list", move || project::templates::list(&store)).await
}

#[tauri::command]
pub async fn inspect_template_source(
    state: State<'_, AppState>, window: Window, source: Option<String>,
) -> Result<project::templates::TemplateSource, String> {
    let source =
        source.map(PathBuf::from).map(Ok).unwrap_or_else(|| current_root(&state, &window))?;
    run_blocking("Template preview", move || project::templates::inspect(&source)).await
}

#[tauri::command]
pub async fn save_local_template(
    app: AppHandle, state: State<'_, AppState>, window: Window, source: Option<String>,
    template: project::templates::LocalTemplate,
) -> Result<project::templates::LocalTemplate, String> {
    let store = app.path().app_data_dir().map_err(crate::util::err)?.join("templates");
    let source =
        source.map(PathBuf::from).map(Ok).unwrap_or_else(|| current_root(&state, &window))?;
    run_blocking("Template save", move || project::templates::save(&store, &source, template)).await
}

#[tauri::command]
pub async fn open_tutorial_project(
    app: AppHandle, state: State<'_, AppState>, window: Window,
) -> Result<ProjectSnapshot, String> {
    let parent = documents_folder(&app, "Lattice Tutorials", "Lattice Tutorials folder")?;
    let snapshot = run_blocking("Tutorial project creation", move || {
        project::open(&project::create_tutorial(&parent)?)
    })
    .await?;
    // The snapshot's root, canonical as `open_project` binds it: Documents
    // reached through a symlink would otherwise bind a root that neither
    // SyncTeX's paths nor the frontend's pinned root share.
    state.set_root(window.label(), PathBuf::from(&snapshot.root)).await?;
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
    let Some(root) = root else { return Ok(None) };
    let operation = wide_event::Operation::start("project.open", project::classify_open_error);
    operation.record("trigger", "launch");
    // Quietly: the operation's event already carries any failure.
    operation.run(run_quietly("Initial project load", move || project::open(&root))).await.map(Some)
}

#[tauri::command]
pub async fn open_project(
    state: State<'_, AppState>, window: Window, path: String,
) -> Result<ProjectSnapshot, String> {
    let operation = wide_event::Operation::start("project.open", project::classify_open_error);
    operation.record("trigger", "open");
    operation
        .run(async {
            // Quietly: the operation's event already carries any failure.
            let snapshot =
                run_quietly("Project opening", move || project::open(Path::new(&path))).await?;
            let root = PathBuf::from(&snapshot.root);
            if state.window_showing(&root).is_some_and(|label| label != window.label()) {
                return Err(
                    "This project is already open in another Lattice window. Open it in the browser from that window instead."
                        .to_string(),
                );
            }
            state.set_root(window.label(), root).await?;
            Ok(snapshot)
        })
        .await
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

/// Stage the arXiv source pack and check it: the staged pack (every check
/// but the test build) goes to `on_staged` at once, and the result, test
/// build and all, is the reply.
#[tauri::command]
pub async fn check_arxiv_package(
    state: State<'_, AppState>, window: Window, project_root: String, options: latex::ArxivOptions,
    on_staged: tauri::ipc::Channel<latex::ArxivCheck>,
) -> Result<latex::ArxivCheck, String> {
    let root = pinned_root(&state, &window, &project_root, "its arXiv checks could start")?;
    let resources = state.project(&root);
    run_blocking("arXiv checks", move || {
        latex::check_arxiv(&root, options, &resources.arxiv_checks, |staged| {
            let _ = on_staged.send(staged.clone());
        })
    })
    .await
}

/// Stop the arXiv check under way: the sheet closed, or its options changed.
#[tauri::command]
pub fn cancel_arxiv_check(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "its arXiv checks could stop")?;
    state.project(&root).arxiv_checks.cancel();
    Ok(())
}

/// Write the arXiv source pack whose checks had `digest` to `zip_path`.
#[tauri::command]
pub async fn export_arxiv_package(
    state: State<'_, AppState>, window: Window, project_root: String, options: latex::ArxivOptions,
    digest: String, zip_path: String,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "its arXiv export could start")?;
    run_blocking("arXiv export", move || {
        latex::export_arxiv(&root, options, &digest, Path::new(&zip_path))
    })
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
    state: State<'_, AppState>, window: Window, engine: Option<String>, keep_engine: Option<bool>,
    trusted: Option<bool>, word_budget: Option<u32>, page_budget: Option<u32>,
    clear_word_budget: Option<bool>, clear_page_budget: Option<bool>,
) -> Result<ProjectManifest, String> {
    let words = if clear_word_budget.unwrap_or(false) { Some(None) } else { word_budget.map(Some) };
    let pages = if clear_page_budget.unwrap_or(false) { Some(None) } else { page_budget.map(Some) };
    let root = current_root(&state, &window)?;
    run_blocking("Project settings update", move || {
        project::update_manifest_settings(&root, engine, keep_engine, trusted, words, pages)
    })
    .await
}

#[tauri::command]
pub async fn set_project_deadline(
    state: State<'_, AppState>, window: Window, deadline: Option<ProjectDeadline>,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Project deadline update", move || project::set_deadline(&root, deadline)).await
}

#[tauri::command]
pub async fn set_submission_items(
    state: State<'_, AppState>, window: Window, items: Vec<SubmissionItem>,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Submission checklist update", move || project::set_submission_items(&root, items))
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
