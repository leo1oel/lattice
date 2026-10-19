//! Compiling the document and the tools around it: the PDF, SyncTeX, TexLab,
//! formatting, spelling and proofreading, the environment doctor and the TeX
//! installer.

use super::{
    binary_save, current_root, in_project, lease_if_pinned, pinned_root, run_blocking, run_quietly,
};
use crate::app_state::AppState;
use crate::command_diagnostics;
use crate::doctor::DoctorReport;
use crate::latex::{BuildResult, BuildStep, BuildSteps, PdfSyncTarget};
use crate::models::SyncTexTarget;
use crate::texlab::{DocumentAt, TexlabCompletionItem, TexlabHover, TexlabLocation};
use crate::{
    doctor, export, format_latex, harper, latex, pdf_pages, review_pdf, synara, tex_setup, texlab,
    wide_event,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State, Window};

#[tauri::command]
pub async fn build_project(
    state: State<'_, AppState>, window: Window, force: Option<bool>, project_root: String,
    document_path: Option<String>, progress_id: Option<u32>,
    diagnostic_context: Option<command_diagnostics::DiagnosticContext>,
) -> Result<BuildResult, String> {
    let operation = wide_event::Operation::start("latex.compile", latex::classify_build_error);
    operation
        .run(command_diagnostics::traced(diagnostic_context, async {
            let root = pinned_root(&state, &window, &project_root, "its build could start")?;
            wide_event::project(&root);
            let force = force.unwrap_or(false);
            let active = state.project(&root).active_build.clone();
            let steps = build_progress(window, project_root, progress_id);
            // Quietly: the operation's event already carries any failure.
            run_quietly("The LaTeX build task", move || {
                latex::build(&root, force, &active, document_path.as_deref(), &steps)
            })
            .await
        }))
        .await
}

/// The passes of a running build, sent to the window that asked for it as
/// each one starts and ends, so its Build button can draw the sequence live.
/// `progress_id` is the caller's name for this build, so a late event from
/// the one before it is not taken for this one's.
const BUILD_PROGRESS_EVENT: &str = "build-progress";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildProgress<'a> {
    project_root: &'a str,
    progress_id: Option<u32>,
    elapsed_ms: u64,
    steps: &'a [BuildStep],
}

fn build_progress(window: Window, project_root: String, progress_id: Option<u32>) -> BuildSteps {
    BuildSteps::new(move |elapsed_ms, steps| {
        let progress =
            BuildProgress { project_root: &project_root, progress_id, elapsed_ms, steps };
        let _ = window.emit_to(window.label(), BUILD_PROGRESS_EVENT, progress);
    })
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
        synara::task_relay_request(
            &app.state::<synara::SynaraRuntime>(),
            synara::COMPILE_REPAIR_ROUTE,
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

/// One read-only agent turn over `prompt`, answered by its final message
/// (proofreading a selection). Start, then poll `status` until it settles.
#[tauri::command]
pub async fn agent_text_task(
    state: State<'_, AppState>, window: Window, project_root: String, action: String,
    task_id: Option<String>, prompt: Option<String>,
) -> Result<serde_json::Value, String> {
    // Status/cancel may refer to the outgoing project during a window switch.
    if action == "start" {
        pinned_root(&state, &window, &project_root, "the agent task could start")?;
    }
    let app = window.app_handle().clone();
    run_blocking("Agent text task", move || {
        synara::task_relay_request(
            &app.state::<synara::SynaraRuntime>(),
            synara::TEXT_TASK_ROUTE,
            &action,
            task_id.as_deref(),
            serde_json::json!({ "workspaceRoot": project_root, "prompt": prompt }),
        )
    })
    .await
}

/// Save the root document's PDF with the changes from `from` to `to` (the
/// files now, when absent) marked, beside the paper's own PDF.
#[tauri::command]
pub async fn export_changes_pdf(
    state: State<'_, AppState>, window: Window, project_root: String, from: String,
    to: Option<String>, options: latex::ChangesPdfOptions,
) -> Result<latex::ChangesPdf, String> {
    let _lease = lease_if_pinned(&state, Some(&project_root)).await;
    let root = pinned_root(&state, &window, &project_root, "the PDF could be exported")?;
    run_blocking("PDF with changes marked", move || {
        latex::export_changes_pdf(&root, &from, to.as_deref(), options)
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
    run_blocking("Compiled PDF save", move || export::save(&path, &bytes, &export::PDF)).await
}

/// Signatures of the pages of the PDF sent as the raw body, so the preview
/// can tell which pages a rebuild changed (pdf_pages.rs).
#[tauri::command]
pub async fn pdf_page_signatures(
    request: tauri::ipc::Request<'_>,
) -> Result<pdf_pages::PageSignatures, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The PDF was not sent as binary data.".to_string());
    };
    let bytes = bytes.clone();
    run_quietly("PDF page signatures", move || pdf_pages::signatures(&bytes)).await
}

/// A review copy of the compiled PDF with the writer's chosen annotations
/// (review_pdf.rs), saved to `destination`.
#[tauri::command]
pub async fn save_review_pdf(
    state: State<'_, AppState>, window: Window, project_root: String, destination: String,
    review: review_pdf::ReviewPdf,
) -> Result<String, String> {
    let root = pinned_root(&state, &window, &project_root, "its review PDF could be saved")?;
    run_blocking("Review PDF save", move || {
        let annotated = review_pdf::annotate(latex::read_compiled_pdf(&root)?, &review)?;
        export::save(Path::new(&destination), &annotated, &export::PDF)
    })
    .await
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

/// How many pages of the compiled PDF the manuscript's body takes.
#[tauri::command]
pub async fn synctex_body_pages(
    state: State<'_, AppState>, window: Window, spans: Vec<latex::BodySpan>,
) -> Result<Option<u32>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("The SyncTeX page count", move || latex::body_pages(&root, &spans)).await
}

/// The page of the compiled PDF each outline heading is typeset on.
#[tauri::command]
pub async fn synctex_heading_pages(
    state: State<'_, AppState>, window: Window, headings: Vec<latex::SourceLine>,
) -> Result<Vec<Option<u32>>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("The SyncTeX section lookup", move || latex::heading_pages(&root, &headings)).await
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
    let root = pinned_root(&state, &window, &project_root, "TexLab synchronization")?;
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
    state: State<'_, AppState>, window: Window, path: String, text: Option<String>,
    revision: Option<u64>, line: u32, character: u32,
) -> Result<Vec<TexlabCompletionItem>, String> {
    with_texlab(&state, current_root(&state, &window)?, move |pool, root| {
        let at = DocumentAt { path: &path, text: text.as_deref(), revision, line, character };
        pool.completion(root, &at)
    })
    .await
}

#[tauri::command]
pub async fn texlab_hover(
    state: State<'_, AppState>, window: Window, path: String, text: Option<String>,
    revision: Option<u64>, line: u32, character: u32,
) -> Result<Option<TexlabHover>, String> {
    with_texlab(&state, current_root(&state, &window)?, move |pool, root| {
        let at = DocumentAt { path: &path, text: text.as_deref(), revision, line, character };
        pool.hover(root, &at)
    })
    .await
}

#[tauri::command]
pub async fn texlab_definition(
    state: State<'_, AppState>, window: Window, path: String, text: Option<String>,
    revision: Option<u64>, line: u32, character: u32,
) -> Result<Option<TexlabLocation>, String> {
    with_texlab(&state, current_root(&state, &window)?, move |pool, root| {
        let at = DocumentAt { path: &path, text: text.as_deref(), revision, line, character };
        pool.definition(root, &at)
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
