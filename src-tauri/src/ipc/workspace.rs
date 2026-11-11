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
///
/// On Linux the Documents folder is whatever `XDG_DOCUMENTS_DIR` in
/// ~/.config/user-dirs.dirs names, and a system without xdg-user-dirs (a
/// minimal desktop, a fresh CI home) names none, so Tauri reports an unknown
/// path and the tutorial could not open. `~/Documents` is the XDG default for
/// that folder, so it stands in.
pub(crate) fn documents_folder(app: &AppHandle, name: &str, what: &str) -> Result<PathBuf, String> {
    let paths = app.path();
    let folder = paths
        .document_dir()
        .or_else(|error| {
            if cfg!(target_os = "linux") {
                paths.home_dir().map(|home| home.join("Documents"))
            } else {
                Err(error)
            }
        })
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
            ensure_not_shown_elsewhere(&state, window.label(), &root)?;
            state.set_root(window.label(), root).await?;
            Ok(snapshot)
        })
        .await
}

/// Whether a window other than this one shows the project at `path`, without
/// opening it: a switch asks first, so one that cannot land in this window
/// leaves the project here untouched. A folder that is gone fails as
/// `open_project` would.
#[tauri::command]
pub async fn project_shown_elsewhere(
    state: State<'_, AppState>, window: Window, path: String,
) -> Result<bool, String> {
    let root =
        run_quietly("Project lookup", move || project::folder_root(Path::new(&path))).await?;
    Ok(shown_elsewhere(&state, window.label(), &root))
}

fn shown_elsewhere(state: &AppState, label: &str, root: &Path) -> bool {
    state.window_showing(root).is_some_and(|showing| showing != label)
}

/// One project shows in one window: its own editor buffers, build and Overleaf
/// connection. The app matches this answer to raise that window instead.
fn ensure_not_shown_elsewhere(state: &AppState, label: &str, root: &Path) -> Result<(), String> {
    if shown_elsewhere(state, label, root) {
        return Err(
            "This project is already open in another Lattice window. Open it in the browser from that window instead."
                .to_string(),
        );
    }
    Ok(())
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
    trusted: Option<bool>, stop_on_first_error: Option<bool>, word_budget: Option<u32>,
    page_budget: Option<u32>, clear_word_budget: Option<bool>, clear_page_budget: Option<bool>,
) -> Result<ProjectManifest, String> {
    let settings = project::ManifestSettings {
        engine,
        keep_engine,
        trusted,
        stop_on_first_error,
        word_budget: if clear_word_budget.unwrap_or(false) {
            Some(None)
        } else {
            word_budget.map(Some)
        },
        page_budget: if clear_page_budget.unwrap_or(false) {
            Some(None)
        } else {
            page_budget.map(Some)
        },
    };
    let root = current_root(&state, &window)?;
    run_blocking("Project settings update", move || {
        project::update_manifest_settings(&root, settings)
    })
    .await
}

/// Set as main document: the .tex file builds compile from now on.
#[tauri::command]
pub async fn set_root_document(
    state: State<'_, AppState>, window: Window, project_root: String, path: String,
) -> Result<ProjectManifest, String> {
    let root = pinned_root(&state, &window, &project_root, "the main document could be set")?;
    run_blocking("Main document update", move || {
        let relative = path.trim().replace('\\', "/");
        let file = project::safe_path(&root, &relative);
        if !relative.to_ascii_lowercase().ends_with(".tex")
            || !file.is_ok_and(|file| file.is_file())
        {
            return Err(format!("{relative} is not a LaTeX file in this project."));
        }
        project::choose_root_document(&root, &relative)
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
pub async fn set_project_grammar_ignores(
    state: State<'_, AppState>, window: Window, rules: Vec<String>, sentences: Vec<String>,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Grammar ignore update", move || {
        project::set_grammar_ignores(&root, rules, sentences)
    })
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

#[cfg(test)]
mod tests {
    use super::ensure_not_shown_elsewhere;
    use crate::app_state::AppState;
    use std::path::PathBuf;

    #[test]
    fn a_project_another_window_shows_is_refused_with_the_phrase_the_app_matches() {
        let state = AppState::from_environment();
        let (paper, notes) = (PathBuf::from("/papers/native-vlm"), PathBuf::from("/papers/notes"));
        state.bind_window("project-1", paper.clone()).unwrap();

        // `OPEN_IN_ANOTHER_WINDOW` in src/app/use-project-lifecycle.ts.
        let refused = ensure_not_shown_elsewhere(&state, "main", &paper).unwrap_err();
        assert!(refused.contains("already open in another Lattice window"), "got: {refused}");
        assert_eq!(ensure_not_shown_elsewhere(&state, "project-1", &paper), Ok(()));
        assert_eq!(ensure_not_shown_elsewhere(&state, "main", &notes), Ok(()));
    }
}
