//! Compiling the document and the tools around it: the PDF, SyncTeX, TexLab,
//! formatting, spelling, the environment doctor and the TeX installer.

use super::{binary_save, current_root, in_project, pinned_root, run_blocking};
use crate::app_state::AppState;
use crate::command_diagnostics;
use crate::models::{
    BuildResult, DoctorReport, PdfSyncTarget, SyncTexTarget, TexlabCompletionItem, TexlabHover,
    TexlabLocation,
};
use crate::{doctor, format_latex, harper, latex, synara, tex_setup, texlab};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State, Window};

#[tauri::command]
pub async fn build_project(
    state: State<'_, AppState>, window: Window, force: Option<bool>, project_root: String,
    document_path: Option<String>,
    diagnostic_context: Option<command_diagnostics::DiagnosticContext>,
) -> Result<BuildResult, String> {
    command_diagnostics::traced("build_project", diagnostic_context, async {
        let root = pinned_root(&state, &window, &project_root, "its build could start")?;
        let force = force.unwrap_or(false);
        let active = state.project(&root).active_build.clone();
        run_blocking("The LaTeX build task", move || {
            latex::build(&root, force, &active, document_path.as_deref())
        })
        .await
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn compile_repair(
    state: State<'_, AppState>, window: Window, project_root: String, action: String,
    thread_id: Option<String>, diagnostics: Option<Vec<serde_json::Value>>,
    root_document: Option<String>, runtime_mode: Option<String>,
) -> Result<serde_json::Value, String> {
    // Status/cancel may refer to the outgoing project during a window switch.
    if action == "start" {
        pinned_root(&state, &window, &project_root, "repair could start")?;
    }
    let app = window.app_handle().clone();
    run_blocking("Compile repair", move || {
        synara::compile_repair_request(
            &app.state::<synara::SynaraRuntime>(),
            &action,
            thread_id.as_deref(),
            serde_json::json!({
                "workspaceRoot": project_root,
                "diagnostics": diagnostics,
                "rootDocument": root_document,
                "runtimeMode": runtime_mode,
            }),
        )
    })
    .await
}

#[tauri::command]
pub fn abort_build(state: State<'_, AppState>, window: Window) -> Result<bool, String> {
    // Stops this window's build. Sharing one handle meant Stop in either window
    // killed whichever latexmk had started most recently.
    let root = current_root(&state, &window)?;
    latex::abort(&state.project(&root).active_build)
}

#[tauri::command]
pub async fn clean_project(state: State<'_, AppState>, window: Window) -> Result<String, String> {
    in_project(&state, &window, "The LaTeX clean task", latex::clean).await
}

#[tauri::command]
pub async fn read_compiled_pdf(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<tauri::ipc::Response, String> {
    let root = pinned_root(&state, &window, &project_root, "its PDF could be loaded")?;
    let bytes = run_blocking("Compiled PDF read", move || latex::read_compiled_pdf(&root)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn save_compiled_pdf(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let (path, bytes) = binary_save(
        &request,
        "x-pdf-destination",
        "Choose where to save the PDF.",
        "PDF",
        "The PDF contents were not sent as binary data.",
    )?;
    run_blocking("Compiled PDF save", move || latex::save_pdf(&path, &bytes)).await
}

#[tauri::command]
pub async fn synctex_edit(
    state: State<'_, AppState>, window: Window, page: u32, x: f64, y: f64,
) -> Result<SyncTexTarget, String> {
    let root = current_root(&state, &window)?;
    run_blocking("SyncTeX lookup", move || latex::inverse_search(&root, page, x, y)).await
}

#[tauri::command]
pub async fn synctex_view(
    state: State<'_, AppState>, window: Window, path: String, line: u32, column: u32,
) -> Result<Option<PdfSyncTarget>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("The SyncTeX lookup", move || latex::forward_search(&root, &path, line, column))
        .await
}

#[tauri::command]
pub async fn run_doctor(
    state: State<'_, AppState>, window: Window,
) -> Result<DoctorReport, String> {
    // Reports on the window's own project, and still runs the environment
    // checks when that window has nothing open yet.
    let root = state.root_for(window.label()).ok().flatten();
    run_blocking("Doctor check", move || Ok(doctor::run(root.as_deref()))).await
}

#[tauri::command]
pub async fn harper_lint(
    text: String, project_words: Vec<String>,
) -> Result<Vec<harper::HarperLintOut>, String> {
    // Pure text in/out — no project state. The blocking pool keeps the multi-
    // hundred-millisecond lint pass off the async reactor and the UI thread.
    run_blocking("harper_lint", move || Ok(harper::lint(&text, &project_words))).await
}

#[tauri::command]
pub async fn format_latex(
    state: State<'_, AppState>, window: Window, path: String, text: String,
) -> Result<String, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Document formatting", move || format_latex::format_document(&root, &path, &text))
        .await
}

/// Run a request on `root`'s LaTeX language server. Not through `run_blocking`:
/// these fire on every keystroke and hover, and a slow server is routine.
async fn with_texlab<T: Send + 'static>(
    state: &AppState, root: PathBuf,
    request: impl FnOnce(&mut texlab::TexlabPool, &Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let pool = Arc::clone(&state.project(&root).texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool.lock().map_err(|_| "TexLab state is unavailable.".to_string())?;
        request(&mut pool, &root)
    })
    .await
    .map_err(|error| format!("The TexLab task stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn texlab_diagnostics(
    state: State<'_, AppState>, window: Window, path: String, text: String, project_root: String,
    request_id: String,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    if root != Path::new(&project_root) {
        return Err("The TexLab project changed before synchronization.".to_string());
    }
    with_texlab(&state, root, move |pool, root| {
        pool.diagnostics(root, &path, &text, move |diagnostics| {
            let payload =
                serde_json::json!({ "requestId": request_id, "diagnostics": diagnostics });
            let _ = window.emit("texlab-diagnostics", payload);
        })
    })
    .await
}

#[tauri::command]
pub async fn texlab_completion(
    state: State<'_, AppState>, window: Window, path: String, text: String, line: u32,
    character: u32,
) -> Result<Vec<TexlabCompletionItem>, String> {
    with_texlab(&state, current_root(&state, &window)?, move |pool, root| {
        pool.completion(root, &path, &text, line, character)
    })
    .await
}

#[tauri::command]
pub async fn texlab_hover(
    state: State<'_, AppState>, window: Window, path: String, text: String, line: u32,
    character: u32,
) -> Result<Option<TexlabHover>, String> {
    with_texlab(&state, current_root(&state, &window)?, move |pool, root| {
        pool.hover(root, &path, &text, line, character)
    })
    .await
}

#[tauri::command]
pub async fn texlab_definition(
    state: State<'_, AppState>, window: Window, path: String, text: String, line: u32,
    character: u32,
) -> Result<Option<TexlabLocation>, String> {
    with_texlab(&state, current_root(&state, &window)?, move |pool, root| {
        pool.definition(root, &path, &text, line, character)
    })
    .await
}

#[tauri::command]
pub async fn start_tex_install(
    mode: tex_setup::TexInstallMode,
    on_progress: tauri::ipc::Channel<tex_setup::TexInstallProgress>,
) -> Result<(), String> {
    run_blocking("TeX installer launch", move || tex_setup::install_tex(mode, &on_progress)).await
}

#[tauri::command]
pub async fn start_tex_dependency_install(
    missing_file: String, on_progress: tauri::ipc::Channel<tex_setup::TexInstallProgress>,
) -> Result<(), String> {
    run_blocking("TeX package installer launch", move || {
        tex_setup::install_dependency(&missing_file, &on_progress)
    })
    .await
}
