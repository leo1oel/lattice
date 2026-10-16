//! Reading and changing the files of the open project.

use super::{
    binary_save, current_root, in_project, lease_if_pinned, maybe_pinned_root, pinned_root,
    run_blocking, run_quietly,
};
use crate::app_state::{AppState, Lease};
use crate::models;
use crate::project::{AnnotationRound, Annotations, AssetPreview, EditorComment};
use crate::{export, project};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{Emitter, State, Window};

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

/// `project-import-progress` payload: files written of the files planned.
#[derive(Clone, serde::Serialize)]
pub struct ImportProgress {
    written: usize,
    total: usize,
}

/// How often a long import reports how far it has got.
const IMPORT_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[tauri::command]
pub async fn import_project_files(
    state: State<'_, AppState>, window: Window, paths: Vec<String>, target_directory: String,
    project_root: String, copy_existing: Option<bool>, conflict: Option<project::NameConflict>,
) -> Result<project::ProjectImport, String> {
    let _lease = state.structural_lease(&project_root, Lease::Shared).await;
    let root = pinned_root(&state, &window, &project_root, "the files could be imported")?;
    run_blocking("File import", move || {
        let request = project::ImportRequest {
            sources: &paths,
            target_directory: &target_directory,
            copy_existing: copy_existing.unwrap_or(false),
            conflict,
        };
        let mut reported = Instant::now();
        project::import_files(&root, request, &mut |written, total| {
            if written < total && reported.elapsed() < IMPORT_PROGRESS_INTERVAL {
                return;
            }
            reported = Instant::now();
            // `emit` would reach every window, and only this one is importing.
            let _ = window.emit_to(
                window.label(),
                "project-import-progress",
                ImportProgress { written, total },
            );
        })
    })
    .await
}

/// The native open panel for Import files…: any mix of files and folders.
#[tauri::command]
pub async fn choose_import_entries(
    window: Window, title: String, prompt: String,
) -> Result<Option<Vec<String>>, String> {
    crate::macos_window::choose_files_and_folders(&window, &title, &prompt).await
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
    // Quietly: a stale version is routine after a rebuild, and the viewer's
    // `pdf.session` event counts failed reads once per document.
    let bytes = run_quietly("Project PDF range read", move || {
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

/// An Agent visual's HTML, which the Agent panel cannot download itself
/// (WebKit cancels a frame's download), saved where the writer chose.
#[tauri::command]
pub async fn save_agent_visual(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let (path, bytes) = binary_save(
        &request,
        "x-html-destination",
        "Choose where to save the visual.",
        "visual",
        "The visual was not sent as binary data.",
    )?;
    run_blocking("Agent visual save", move || export::save(&path, &bytes, &export::HTML)).await
}

/// A copy of the open file, when saving it in place failed, written where
/// the writer chose.
#[tauri::command]
pub async fn save_source_copy(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let (path, bytes) = binary_save(
        &request,
        "x-copy-destination",
        "Choose where to save the copy.",
        "copy",
        "The copy was not sent as binary data.",
    )?;
    run_blocking("Source copy save", move || export::save_text_copy(&path, &bytes)).await
}

#[tauri::command]
pub async fn list_annotations(
    state: State<'_, AppState>, window: Window,
) -> Result<Annotations, String> {
    in_project(&state, &window, "Annotation read", project::read_annotations).await
}

#[tauri::command]
pub async fn save_annotations(
    state: State<'_, AppState>, window: Window, project_root: String,
    annotations: Vec<EditorComment>, rounds: Vec<AnnotationRound>, save: u64,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "saving the annotations")?;
    run_blocking("Annotation save", move || {
        project::write_annotations(&root, annotations, rounds, save)
    })
    .await
}

/// The newest of the agent's reviews of the paper, or none before the first.
#[tauri::command]
pub async fn read_paper_review(
    state: State<'_, AppState>, window: Window,
) -> Result<Option<serde_json::Value>, String> {
    in_project(&state, &window, "Paper review read", project::read_latest_review).await
}

/// Keep a review of the paper, or the writer's decisions on its points.
#[tauri::command]
pub async fn save_paper_review(
    state: State<'_, AppState>, window: Window, project_root: String, review: serde_json::Value,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "saving the review")?;
    let id = review.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    run_blocking("Paper review save", move || project::write_review(&root, &id, &review)).await
}

/// Keep a revision round's files; a settled round also becomes one history
/// entry, whose id this returns.
#[tauri::command]
pub async fn save_annotation_round(
    state: State<'_, AppState>, window: Window, project_root: String, number: u32,
    files: Vec<models::FileChange>, settled: bool,
) -> Result<Option<String>, String> {
    let root = pinned_root(&state, &window, &project_root, "saving the revision round")?;
    run_blocking("Annotation round save", move || {
        project::save_annotation_round(&root, number, files, settled)
    })
    .await
}

/// Restore the project's files to the text `files` gives them (how a
/// revision round left them), as one history entry named `label`.
#[tauri::command]
pub async fn restore_annotation_round(
    state: State<'_, AppState>, window: Window, project_root: String, label: String,
    files: Vec<models::FileChange>,
) -> Result<(), String> {
    let root = pinned_root(&state, &window, &project_root, "restoring the revision round")?;
    let edits = files
        .into_iter()
        .filter_map(|file| file.after.map(|after| (file.path, after)))
        .collect::<Vec<_>>();
    run_blocking("Annotation round restore", move || {
        project::apply_annotation_restore(&root, &label, edits).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn read_annotation_round(
    state: State<'_, AppState>, window: Window, number: u32,
) -> Result<Vec<models::FileChange>, String> {
    in_project(&state, &window, "Annotation round read", move |root| {
        project::read_annotation_round(root, number)
    })
    .await
}
