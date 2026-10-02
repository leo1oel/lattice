//! Reading and changing the files of the open project.

use super::{
    binary_save, current_root, in_project, lease_if_pinned, maybe_pinned_root, pinned_root,
    run_blocking,
};
use crate::app_state::{AppState, Lease};
use crate::models::{self, AssetPreview, EditorComment};
use crate::{export, project};
use std::path::Path;
use tauri::{State, Window};

#[tauri::command]
pub async fn list_project_tree_with_hidden(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<Vec<models::FileNode>, String> {
    let root = pinned_root(&state, &window, &project_root, "loading hidden files")?;
    run_blocking("Project tree", move || {
        project::scan_tree(&root, project::TreeView::ProjectWithHidden)
    })
    .await
}

#[tauri::command]
pub async fn stat_project_file(
    state: State<'_, AppState>, window: Window, path: String,
) -> Result<project::ProjectFileStat, String> {
    in_project(&state, &window, "Project file status", move |root| project::stat_file(root, &path))
        .await
}

#[tauri::command]
pub async fn read_project_file(
    state: State<'_, AppState>, window: Window, path: String, project_root: Option<String>,
) -> Result<String, String> {
    // Overleaf replaces incoming files atomically, so navigation can safely
    // see either complete version without waiting behind the network-bound
    // full-sync write lease. Writes still take that lease: only reads bypass
    // it, and the pinned root check still rejects stale project work.
    let root =
        maybe_pinned_root(&state, &window, project_root.as_deref(), "the file could be read")?;
    run_blocking("Project file read", move || project::read_file(&root, &path)).await
}

#[tauri::command]
pub async fn write_project_file(
    state: State<'_, AppState>, window: Window, path: String, content: String,
    project_root: String, base_content: Option<String>, expected_content: Option<String>,
) -> Result<project::EditorWriteResult, String> {
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the file could be written")?;
    run_blocking("Project file write", move || {
        project::apply_editor_transaction(&root, path, content, base_content, expected_content)
    })
    .await
}

#[tauri::command]
pub async fn create_project_entry(
    state: State<'_, AppState>, window: Window, path: String, kind: String, project_root: String,
) -> Result<String, String> {
    let _lease = state.structural_lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the file could be created")?;
    run_blocking("File creation", move || project::create_entry(&root, &path, &kind)).await
}

#[tauri::command]
pub async fn create_open_slide_deck(
    state: State<'_, AppState>, window: Window, deck_id: String, project_root: String,
) -> Result<String, String> {
    let _lease = state.structural_lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the slide deck could be created")?;
    run_blocking("Slide deck creation", move || project::create_open_slide_deck(&root, &deck_id))
        .await
}

#[tauri::command]
pub async fn delete_project_entry(
    state: State<'_, AppState>, window: Window, path: String, project_root: String,
) -> Result<(), String> {
    let _lease = state.structural_lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the file could be deleted")?;
    run_blocking("File deletion", move || project::delete_entry(&root, &path)).await
}

#[tauri::command]
pub async fn rename_project_entry(
    state: State<'_, AppState>, window: Window, path: String, new_name: String,
    project_root: String,
) -> Result<String, String> {
    let _lease = state.structural_lease(&project_root, Lease::Exclusive).await;
    let root = pinned_root(&state, &window, &project_root, "the file could be renamed")?;
    run_blocking("File rename", move || project::rename_entry(&root, &path, &new_name)).await
}

#[tauri::command]
pub async fn move_project_entry(
    state: State<'_, AppState>, window: Window, path: String, target_directory: String,
    project_root: String,
) -> Result<String, String> {
    let _lease = state.structural_lease(&project_root, Lease::Exclusive).await;
    let root = pinned_root(&state, &window, &project_root, "the file could be moved")?;
    run_blocking("File move", move || project::move_entry(&root, &path, &target_directory)).await
}

#[tauri::command]
pub async fn import_project_assets(
    state: State<'_, AppState>, window: Window, paths: Vec<String>, target_directory: String,
    project_root: String,
) -> Result<Vec<String>, String> {
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the assets could be imported")?;
    run_blocking("Asset import", move || project::import_assets(&root, &paths, &target_directory))
        .await
}

#[tauri::command]
pub async fn read_agent_composer_files(
    paths: Vec<String>,
) -> Result<Vec<project::AgentComposerFile>, String> {
    run_blocking("Reading dropped files", move || project::read_agent_composer_files(&paths)).await
}

#[tauri::command]
pub async fn import_project_files(
    state: State<'_, AppState>, window: Window, paths: Vec<String>, target_directory: String,
    project_root: String, copy_existing: Option<bool>,
) -> Result<Vec<project::ImportedProjectFile>, String> {
    let _lease = state.structural_lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the files could be imported")?;
    let copy_existing = copy_existing.unwrap_or(false);
    run_blocking("File import", move || {
        if copy_existing {
            project::import_files_with_copy(&root, &paths, &target_directory, true)
        } else {
            project::import_files(&root, &paths, &target_directory)
        }
    })
    .await
}

#[tauri::command]
pub async fn import_project_sources(
    state: State<'_, AppState>, window: Window, paths: Vec<String>, target_directory: String,
    project_root: String,
) -> Result<Vec<String>, String> {
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the sources could be imported")?;
    run_blocking("Source import", move || project::import_sources(&root, &paths, &target_directory))
        .await
}

#[tauri::command]
pub async fn import_clipboard_image(
    state: State<'_, AppState>, window: Window, target_directory: String, file_name: String,
    base64_data: String, project_root: String,
) -> Result<String, String> {
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the image could be imported")?;
    run_blocking("Image import", move || {
        project::import_image_bytes(&root, &target_directory, &file_name, &base64_data)
    })
    .await
}

#[tauri::command]
pub async fn read_project_asset(
    state: State<'_, AppState>, window: Window, path: String, project_root: Option<String>,
) -> Result<AssetPreview, String> {
    let _lease = lease_if_pinned(&state, project_root.as_ref()).await;
    let root =
        maybe_pinned_root(&state, &window, project_root.as_deref(), "the asset could be read")?;
    run_blocking("Project asset read", move || project::read_asset(&root, &path)).await
}

/// Bytes `[start, end)` of a project PDF `read_project_asset` reported, as a
/// raw IPC reply: PDF.js asks for the ranges its pages need.
#[tauri::command]
pub async fn read_project_asset_range(
    state: State<'_, AppState>, window: Window, path: String, version: String, start: u64, end: u64,
) -> Result<tauri::ipc::Response, String> {
    let root = current_root(&state, &window)?;
    let bytes = run_blocking("Project PDF range read", move || {
        project::read_asset_range(&root, &path, &version, start, end)
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Save a copy of a project PDF, at the version `read_project_asset` reported,
/// to `destination`: the file is copied on disk, not sent to the webview.
#[tauri::command]
pub async fn save_project_pdf(
    state: State<'_, AppState>, window: Window, path: String, version: String, destination: String,
) -> Result<String, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Project PDF save", move || {
        project::save_asset_copy(&root, &path, &version, Path::new(&destination))
    })
    .await
}

#[tauri::command]
pub async fn write_project_bytes(
    state: State<'_, AppState>, window: Window, path: String, base64_data: String,
    project_root: String,
) -> Result<(), String> {
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the asset could be written")?;
    run_blocking("Project asset write", move || project::write_bytes(&root, &path, &base64_data))
        .await
}

#[tauri::command]
pub async fn prepare_latex_figure(
    state: State<'_, AppState>, window: Window, path: String, project_root: String,
) -> Result<String, String> {
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the figure could be prepared")?;
    run_blocking("Figure preparation", move || project::prepare_latex_figure(&root, &path)).await
}

#[tauri::command]
pub async fn save_xlsx(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let (path, bytes) = binary_save(
        &request,
        "x-xlsx-destination",
        "Choose where to export the Excel workbook.",
        "Excel",
        "The Excel workbook was not sent as binary data.",
    )?;
    run_blocking("Excel workbook save", move || export::save(&path, &bytes, &export::XLSX)).await
}

#[tauri::command]
pub async fn list_editor_comments(
    state: State<'_, AppState>, window: Window,
) -> Result<Vec<EditorComment>, String> {
    in_project(&state, &window, "Editor comment read", project::read_editor_comments).await
}

#[tauri::command]
pub async fn save_editor_comments(
    state: State<'_, AppState>, window: Window, comments: Vec<EditorComment>,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("Editor comment save", move || project::write_editor_comments(&root, comments))
        .await
}
