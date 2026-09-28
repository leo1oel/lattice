//! Creating, opening and configuring projects.

use super::{current_root, in_project, run_blocking};
use crate::app_state::AppState;
use crate::models::{ProjectManifest, ProjectSnapshot};
use crate::{fs_watch, project};
use std::path::{Path, PathBuf};
use std::sync::PoisonError;
use tauri::{AppHandle, Manager, State, Window};

/// How many joined-share workspaces to retain under Documents/Lattice Shares.
const MAX_SHARE_WORKSPACES: usize = 8;

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

/// Fresh blank folder under Documents/Lattice Shares for joining a share.
/// Does not modify whatever project the guest had open before.
#[tauri::command]
pub async fn create_collab_join_workspace(
    app: AppHandle, room: String, project_name: Option<String>,
) -> Result<ProjectSnapshot, String> {
    let room = room.trim();
    if room.is_empty() {
        return Err("A share room is required.".to_string());
    }
    let safe_room: String = room
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect();
    let safe_title: String = project_name
        .unwrap_or_else(|| "Shared project".to_string())
        .trim()
        .chars()
        .filter(|ch| ch.is_alphanumeric() || *ch == ' ' || *ch == '-' || *ch == '_')
        .take(48)
        .collect::<String>()
        .trim_matches([' ', '-', '_'])
        .to_string();
    let safe_title = if safe_title.is_empty() { "Shared project".to_string() } else { safe_title };
    let parent = documents_folder(&app, "Lattice Shares", "Lattice Shares folder")?;
    run_blocking("Shared workspace creation", move || {
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        let root =
            project::create_blank(&parent, &format!("{safe_title} — Shared {safe_room}-{stamp}"))?;
        // Each join materializes a full local copy here; it's only a convenience
        // backup, so keep the most-recent handful and delete older ones.
        prune_old_share_workspaces(&parent, &root, MAX_SHARE_WORKSPACES);
        project::open(&root)
    })
    .await
}

/// Keep the `keep` most-recently-modified joined-share folders under `parent`
/// (always keeping `current`), deleting older ones. Best-effort: any failure to
/// enumerate or remove a stale copy is ignored so it never blocks joining.
fn prune_old_share_workspaces(parent: &Path, current: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let mut workspaces = entries
        .flatten()
        .filter(|entry| {
            let (path, name) = (entry.path(), entry.file_name());
            let name = name.to_string_lossy();
            path.is_dir()
                && (name.starts_with("share-") || name.contains(" — Shared "))
                && project::read_manifest(&path).is_ok_and(|manifest| manifest.venue == "shared")
        })
        .map(|entry| {
            let modified = entry.metadata().and_then(|meta| meta.modified());
            (modified.unwrap_or(std::time::UNIX_EPOCH), entry.path())
        })
        .collect::<Vec<_>>();
    // Newest first, so everything past `keep` is the oldest.
    workspaces.sort_by_key(|workspace| std::cmp::Reverse(workspace.0));
    for (_, path) in workspaces.into_iter().skip(keep) {
        if path != current {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[tauri::command]
pub async fn initial_project(
    state: State<'_, AppState>, window: Window,
) -> Result<Option<ProjectSnapshot>, String> {
    // Both the window the app launches with (bound from LATTICE_PROJECT) and a
    // window opened for a specific project (bound before it loads) find their
    // project here, so the frontend startup path is the same for either.
    let root = state.root_for(window.label())?;
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
    in_project(&state, &window, "Project refresh", project::open).await
}

#[tauri::command]
pub async fn collab_project_inventory_v2(
    state: State<'_, AppState>, window: Window,
) -> Result<project::CollabProjectInventoryV2, String> {
    in_project(
        &state,
        &window,
        "Collaboration project inventory",
        project::collab_project_inventory_v2,
    )
    .await
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

#[cfg(test)]
mod tests {
    use super::prune_old_share_workspaces;
    use crate::project;
    use crate::project::test_support::Fixture;

    #[test]
    fn share_workspace_pruning_requires_an_owned_shared_project_manifest() {
        let shares = Fixture::empty("share-prune");
        let current = project::create_blank(&shares.root, "Current — Shared abc123").unwrap();
        let old = project::create_blank(&shares.root, "Old — Shared def456").unwrap();
        shares.write("Notes — Shared Archive/notes.md", "# Notes\n");

        prune_old_share_workspaces(&shares.root, &current, 0);

        assert!(current.exists());
        assert!(!old.exists());
        assert!(shares.path("Notes — Shared Archive").exists());
    }
}
