mod agents;
mod alphaxiv;
mod commands;
mod doctor;
mod format_latex;
mod fts;
mod git;
mod latex;
mod literature;
#[cfg(target_os = "macos")]
mod macos_window;
mod mcp_store;
mod models;
mod omp_update;
mod openalex;
mod overleaf;
mod overleaf_rt;
mod papers;
mod pdf_fonts;
mod project;
mod sessions;
mod skill_store;
mod synara;
mod tex_setup;
mod texcount;
mod texlab;

use models::{
    AgentAttachmentDescriptor, AgentAttachmentMetadata, AgentCommand, AgentResult, AgentRunRequest,
    AgentSession, AgentSessionSearchResult, AgentSessionSummary, AgentSkill, AgentSkillSaveRequest,
    AgentStreamEvent, AssetPreview, BuildResult, CitationInfo, DoctorReport, EditorComment,
    GitDiff, GitRemoteResult, GitStatus, HistoryItem, ImportResult, LiteraturePage, McpServer,
    McpServerSaveRequest, OpenAlexWork, PaperSummary, PdfMark, PdfSyncTarget, ProjectManifest,
    ProjectSearchResult, ProjectSnapshot, ReferenceInfo, RenameSymbolResult, ReplacePreview,
    ReplaceResult, ResolvedCitation, SubscriptionLoginEvent, SubscriptionStatus, SymbolOccurrence,
    SyncTexTarget, TexlabCompletionItem, TexlabHover, TexlabLocation, TodoHit, TransactionRecord,
    UnusedSymbols, WordCount,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct AppState {
    root: Mutex<Option<PathBuf>>,
    agent_runtime: agents::AgentRuntime,
    active_build: latex::ActiveBuild,
    texlab: Arc<Mutex<texlab::TexlabPool>>,
    /// Live connection to Overleaf's editing channel, when one is open.
    realtime: Arc<Mutex<Option<Arc<overleaf_rt::RealtimeClient>>>>,
}

impl AppState {
    fn from_environment(agent_runtime: agents::AgentRuntime) -> Self {
        let root = std::env::var_os("LATTICE_PROJECT")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .and_then(|path| path.canonicalize().ok());
        Self {
            root: Mutex::new(root),
            agent_runtime,
            active_build: latex::new_active_build(),
            texlab: Arc::new(Mutex::new(texlab::TexlabPool::default())),
            realtime: Arc::new(Mutex::new(None)),
        }
    }
}

fn current_root(state: &tauri::State<'_, AppState>) -> Result<PathBuf, String> {
    state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "Open a project first.".to_string())
}

fn set_root(state: &tauri::State<'_, AppState>, root: PathBuf) -> Result<(), String> {
    if let Ok(mut pool) = state.texlab.lock() {
        pool.reset();
    }
    *state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())? = Some(root);
    Ok(())
}

async fn run_blocking<T, F>(label: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("{label} stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn create_project(
    state: tauri::State<'_, AppState>,
    parent: String,
    name: String,
    venue: Option<String>,
) -> Result<ProjectSnapshot, String> {
    let venue = project::Venue::parse(venue.as_deref().unwrap_or("neurips"))?;
    let (root, snapshot) = run_blocking("Project creation", move || {
        let root = if venue == project::Venue::Neurips {
            project::create(Path::new(&parent), &name)?
        } else {
            project::create_with_venue(Path::new(&parent), &name, venue)?
        };
        let snapshot = project::open(&root)?;
        Ok((root, snapshot))
    })
    .await?;
    set_root(&state, root)?;
    Ok(snapshot)
}

/// Fresh blank folder under Documents/Lattice Shares for joining a share.
/// Does not modify whatever project the guest had open before.
#[tauri::command]
async fn create_collab_join_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    room: String,
) -> Result<ProjectSnapshot, String> {
    use tauri::Manager;
    let room = room.trim();
    if room.is_empty() {
        return Err("A share room is required.".to_string());
    }
    let safe_room: String = room
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("Could not resolve Documents folder: {error}"))?;
    let (root, snapshot) = run_blocking("Shared workspace creation", move || {
        let parent = documents.join("Lattice Shares");
        std::fs::create_dir_all(&parent)
            .map_err(|error| format!("Could not create Lattice Shares folder: {error}"))?;
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        let name = format!("share-{safe_room}-{stamp}");
        let root = project::create_blank(&parent, &name)?;
        // Each join materializes a full local copy here; it's only a convenience
        // backup, so keep the most-recent handful and delete older ones.
        prune_old_share_workspaces(&parent, &root, MAX_SHARE_WORKSPACES);
        let snapshot = project::open(&root)?;
        Ok((root, snapshot))
    })
    .await?;
    set_root(&state, root)?;
    Ok(snapshot)
}

/// How many joined-share workspaces to retain under Documents/Lattice Shares.
const MAX_SHARE_WORKSPACES: usize = 8;

/// Keep the `keep` most-recently-modified `share-*` folders under `parent`
/// (always keeping `current`), deleting older ones. Best-effort: any failure to
/// enumerate or remove a stale copy is ignored so it never blocks joining.
fn prune_old_share_workspaces(parent: &std::path::Path, current: &std::path::Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let mut workspaces: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let name = path.file_name()?.to_string_lossy();
            if !name.starts_with("share-") {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, path))
        })
        .collect();
    if workspaces.len() <= keep {
        return;
    }
    // Newest first, so everything past `keep` is the oldest.
    workspaces.sort_by_key(|workspace| std::cmp::Reverse(workspace.0));
    for (_, path) in workspaces.into_iter().skip(keep) {
        if path == current {
            continue;
        }
        let _ = std::fs::remove_dir_all(&path);
    }
}

#[tauri::command]
async fn initial_project(
    state: tauri::State<'_, AppState>,
) -> Result<Option<ProjectSnapshot>, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone();
    run_blocking("Initial project load", move || {
        root.map(|path| project::open(&path)).transpose()
    })
    .await
}

#[tauri::command]
async fn open_project(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<ProjectSnapshot, String> {
    let snapshot = run_blocking("Project opening", move || project::open(Path::new(&path))).await?;
    set_root(&state, PathBuf::from(&snapshot.root))?;
    Ok(snapshot)
}

#[tauri::command]
async fn import_project_zip(
    state: tauri::State<'_, AppState>,
    zip_path: String,
    parent: String,
) -> Result<ProjectSnapshot, String> {
    let snapshot = run_blocking("Project import", move || {
        project::import_project_zip(Path::new(&zip_path), Path::new(&parent))
    })
    .await?;
    set_root(&state, PathBuf::from(&snapshot.root))?;
    Ok(snapshot)
}

#[tauri::command]
async fn export_project_zip(
    state: tauri::State<'_, AppState>,
    zip_path: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Project export", move || {
        project::export_project_zip(&root, Path::new(&zip_path))
    })
    .await
}

#[tauri::command]
async fn stat_project_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<project::ProjectFileStat, String> {
    let root = current_root(&state)?;
    run_blocking("Project file status", move || {
        project::stat_file(&root, &path)
    })
    .await
}

#[tauri::command]
async fn refresh_project(state: tauri::State<'_, AppState>) -> Result<ProjectSnapshot, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::open(&root))
        .await
        .map_err(|error| format!("Project refresh stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn read_project_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Project file read", move || {
        project::read_file(&root, &path)
    })
    .await
}

#[tauri::command]
async fn write_project_file(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Project file write", move || {
        let transaction =
            project::apply_transaction(&root, &format!("Edit {path}"), vec![(path, content)])?;
        Ok(transaction.id)
    })
    .await
}

#[tauri::command]
async fn list_citation_keys(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::citation_keys(&root))
        .await
        .map_err(|error| format!("Citation scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_citations(state: tauri::State<'_, AppState>) -> Result<Vec<CitationInfo>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::citations(&root))
        .await
        .map_err(|error| format!("Citation scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn read_bib_entry(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<ResolvedCitation>, String> {
    let root = current_root(&state)?;
    run_blocking("Bibliography read", move || {
        project::read_bib_entry(&root, &key)
    })
    .await
}

#[tauri::command]
async fn save_bib_entry(
    state: tauri::State<'_, AppState>,
    key: String,
    bibtex: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Bibliography save", move || {
        project::save_bib_entry(&root, &key, &bibtex)
    })
    .await
}

#[tauri::command]
async fn list_references(state: tauri::State<'_, AppState>) -> Result<Vec<ReferenceInfo>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::references(&root))
        .await
        .map_err(|error| format!("Reference scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_unused_symbols(state: tauri::State<'_, AppState>) -> Result<UnusedSymbols, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::unused_symbols(&root))
        .await
        .map_err(|error| format!("Symbol scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_todos(state: tauri::State<'_, AppState>) -> Result<Vec<TodoHit>, String> {
    let root = current_root(&state)?;
    run_blocking("TODO scan", move || project::list_todos(&root)).await
}

#[tauri::command]
async fn count_project_words(state: tauri::State<'_, AppState>) -> Result<WordCount, String> {
    let root = current_root(&state)?;
    run_blocking("Word count", move || texcount::count_project(&root)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn update_project_manifest(
    state: tauri::State<'_, AppState>,
    engine: Option<String>,
    default_root: Option<String>,
    trusted: Option<bool>,
    word_budget: Option<u32>,
    page_budget: Option<u32>,
    clear_word_budget: Option<bool>,
    clear_page_budget: Option<bool>,
) -> Result<ProjectManifest, String> {
    let words = if clear_word_budget.unwrap_or(false) {
        Some(None)
    } else {
        word_budget.map(Some)
    };
    let pages = if clear_page_budget.unwrap_or(false) {
        Some(None)
    } else {
        page_budget.map(Some)
    };
    let root = current_root(&state)?;
    run_blocking("Project settings update", move || {
        project::update_manifest_settings(&root, engine, default_root, trusted, words, pages)
    })
    .await
}

#[tauri::command]
async fn add_root_document(
    state: tauri::State<'_, AppState>,
    path: String,
    name: Option<String>,
    make_default: Option<bool>,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state)?;
    run_blocking("Root document update", move || {
        project::add_root_document(&root, &path, name, make_default.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn remove_root_document(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state)?;
    run_blocking("Root document update", move || {
        project::remove_root_document(&root, &path)
    })
    .await
}

#[tauri::command]
async fn preview_replace_in_project(
    state: tauri::State<'_, AppState>,
    query: String,
    paths: Option<Vec<String>>,
    match_case: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplacePreview, String> {
    let root = current_root(&state)?;
    run_blocking("Replace preview", move || {
        project::preview_replace_in_project(
            &root,
            &query,
            paths,
            match_case.unwrap_or(true),
            use_regex.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
async fn replace_in_project(
    state: tauri::State<'_, AppState>,
    query: String,
    replacement: String,
    paths: Option<Vec<String>>,
    match_case: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplaceResult, String> {
    let root = current_root(&state)?;
    run_blocking("Project replace", move || {
        project::replace_in_project(
            &root,
            &query,
            &replacement,
            paths,
            match_case.unwrap_or(true),
            use_regex.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
async fn find_label_occurrences(
    state: tauri::State<'_, AppState>,
    label: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    let root = current_root(&state)?;
    run_blocking("Label search", move || {
        project::find_label_occurrences(&root, &label)
    })
    .await
}

#[tauri::command]
async fn find_citation_occurrences(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    let root = current_root(&state)?;
    run_blocking("Citation search", move || {
        project::find_citation_occurrences(&root, &key)
    })
    .await
}

#[tauri::command]
async fn rename_label(
    state: tauri::State<'_, AppState>,
    old_label: String,
    new_label: String,
) -> Result<RenameSymbolResult, String> {
    let root = current_root(&state)?;
    run_blocking("Label rename", move || {
        project::rename_label(&root, &old_label, &new_label)
    })
    .await
}

#[tauri::command]
async fn rename_citation_key(
    state: tauri::State<'_, AppState>,
    old_key: String,
    new_key: String,
) -> Result<RenameSymbolResult, String> {
    let root = current_root(&state)?;
    run_blocking("Citation rename", move || {
        project::rename_citation_key(&root, &old_key, &new_key)
    })
    .await
}

#[tauri::command]
async fn search_project(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<ProjectSearchResult>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = project::search_files(&root, &query)?;
        results.extend(papers::search_papers(&root, &query)?);
        Ok(results)
    })
    .await
    .map_err(|error| format!("Project search stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn create_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    kind: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::create_entry(&root, &path, &kind))
        .await
        .map_err(|error| format!("File creation stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn delete_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::delete_entry(&root, &path))
        .await
        .map_err(|error| format!("File deletion stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn rename_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::rename_entry(&root, &path, &new_name))
        .await
        .map_err(|error| format!("File rename stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn move_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    target_directory: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project::move_entry(&root, &path, &target_directory)
    })
    .await
    .map_err(|error| format!("File move stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn import_project_assets(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    target_directory: String,
) -> Result<Vec<String>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project::import_assets(&root, &paths, &target_directory)
    })
    .await
    .map_err(|error| format!("Asset import stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn import_clipboard_image(
    state: tauri::State<'_, AppState>,
    target_directory: String,
    file_name: String,
    base64_data: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project::import_image_bytes(&root, &target_directory, &file_name, &base64_data)
    })
    .await
    .map_err(|error| format!("Image import stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn resolve_citation_query(query: String) -> Result<ResolvedCitation, String> {
    run_blocking("Citation lookup", move || {
        project::resolve_citation_query(&query)
    })
    .await
}

#[tauri::command]
async fn read_project_asset(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<AssetPreview, String> {
    let root = current_root(&state)?;
    run_blocking("Project asset read", move || {
        project::read_asset(&root, &path)
    })
    .await
}

#[tauri::command]
async fn write_project_bytes(
    state: tauri::State<'_, AppState>,
    path: String,
    base64_data: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Project asset write", move || {
        project::write_bytes(&root, &path, &base64_data)
    })
    .await
}

#[tauri::command]
async fn prepare_latex_figure(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Figure preparation", move || {
        project::prepare_latex_figure(&root, &path)
    })
    .await
}

#[tauri::command]
async fn build_project(
    state: tauri::State<'_, AppState>,
    force: Option<bool>,
) -> Result<BuildResult, String> {
    let root = current_root(&state)?;
    let force = force.unwrap_or(false);
    let active = state.active_build.clone();
    tauri::async_runtime::spawn_blocking(move || latex::build(&root, force, &active))
        .await
        .map_err(|error| format!("The LaTeX build task stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn abort_build(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    latex::abort(&state.active_build)
}

#[tauri::command]
async fn clean_project(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || latex::clean(&root))
        .await
        .map_err(|error| format!("The LaTeX clean task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn run_doctor(state: tauri::State<'_, AppState>) -> Result<DoctorReport, String> {
    let root = state.root.lock().ok().and_then(|guard| guard.clone());
    let executable = state.agent_runtime.executable.clone();
    let assets = state.agent_runtime.assets.clone();
    run_blocking("Doctor check", move || {
        Ok(doctor::run(root.as_deref(), &executable, &assets))
    })
    .await
}

#[tauri::command]
async fn texlab_diagnostics(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
) -> Result<Vec<models::Diagnostic>, String> {
    let root = current_root(&state)?;
    let pool = Arc::clone(&state.texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool
            .lock()
            .map_err(|_| "TexLab state is unavailable.".to_string())?;
        pool.diagnostics(&root, &path, &text)
    })
    .await
    .map_err(|error| format!("The TexLab task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn texlab_completion(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Vec<TexlabCompletionItem>, String> {
    let root = current_root(&state)?;
    let pool = Arc::clone(&state.texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool
            .lock()
            .map_err(|_| "TexLab state is unavailable.".to_string())?;
        pool.completion(&root, &path, &text, line, character)
    })
    .await
    .map_err(|error| format!("The TexLab task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn texlab_hover(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Option<TexlabHover>, String> {
    let root = current_root(&state)?;
    let pool = Arc::clone(&state.texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool
            .lock()
            .map_err(|_| "TexLab state is unavailable.".to_string())?;
        pool.hover(&root, &path, &text, line, character)
    })
    .await
    .map_err(|error| format!("The TexLab task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn texlab_definition(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Option<TexlabLocation>, String> {
    let root = current_root(&state)?;
    let pool = Arc::clone(&state.texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool
            .lock()
            .map_err(|_| "TexLab state is unavailable.".to_string())?;
        pool.definition(&root, &path, &text, line, character)
    })
    .await
    .map_err(|error| format!("The TexLab task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn format_latex(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Document formatting", move || {
        format_latex::format_document(&root, &path, &text)
    })
    .await
}

#[tauri::command]
async fn search_openalex(
    query: String,
    precise: Option<bool>,
) -> Result<Vec<OpenAlexWork>, String> {
    let precise = precise.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || openalex::search_works(&query, precise, 1))
        .await
        .map_err(|error| format!("The OpenAlex task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn search_literature(
    query: String,
    precise: Option<bool>,
    page: Option<u32>,
) -> Result<LiteraturePage, String> {
    let precise = precise.unwrap_or(false);
    let page = page.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || literature::search(&query, precise, page))
        .await
        .map_err(|error| format!("The literature search task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn git_status(state: tauri::State<'_, AppState>) -> Result<GitStatus, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::status(&root))
        .await
        .map_err(|error| format!("Git status stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn git_diff(
    state: tauri::State<'_, AppState>,
    path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    let root = current_root(&state)?;
    run_blocking("Git diff", move || git::diff(&root, &path, staged)).await
}

#[tauri::command]
async fn git_stage(state: tauri::State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Git stage", move || git::stage(&root, &paths)).await
}

#[tauri::command]
async fn git_unstage(state: tauri::State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Git unstage", move || git::unstage(&root, &paths)).await
}

#[tauri::command]
async fn git_commit(state: tauri::State<'_, AppState>, message: String) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Git commit", move || git::commit(&root, &message)).await
}

#[tauri::command]
async fn git_init(state: tauri::State<'_, AppState>) -> Result<GitStatus, String> {
    let root = current_root(&state)?;
    run_blocking("Git initialization", move || git::init(&root)).await
}

#[tauri::command]
async fn git_set_remote(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
    url: String,
) -> Result<GitStatus, String> {
    let root = current_root(&state)?;
    run_blocking("Git remote update", move || {
        git::set_remote(&root, name.as_deref().unwrap_or("origin"), &url)
    })
    .await
}

#[tauri::command]
async fn git_push(state: tauri::State<'_, AppState>) -> Result<GitRemoteResult, String> {
    let root = current_root(&state)?;
    run_blocking("Git push", move || git::push(&root)).await
}

#[tauri::command]
async fn git_pull(state: tauri::State<'_, AppState>) -> Result<GitRemoteResult, String> {
    let root = current_root(&state)?;
    run_blocking("Git pull", move || git::pull(&root)).await
}

#[tauri::command]
async fn git_fetch(state: tauri::State<'_, AppState>) -> Result<GitRemoteResult, String> {
    let root = current_root(&state)?;
    run_blocking("Git fetch", move || git::fetch(&root)).await
}

#[tauri::command]
async fn git_log(
    state: tauri::State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<models::GitLogEntry>, String> {
    let root = current_root(&state)?;
    run_blocking("Git history", move || {
        git::log(&root, limit.unwrap_or(200) as usize)
    })
    .await
}

#[tauri::command]
async fn git_show_diff(
    state: tauri::State<'_, AppState>,
    rev: String,
    path: String,
) -> Result<models::GitFileDiff, String> {
    let root = current_root(&state)?;
    run_blocking("Git revision diff", move || {
        git::show_diff(&root, &rev, &path)
    })
    .await
}

#[tauri::command]
async fn git_restore_file(
    state: tauri::State<'_, AppState>,
    rev: String,
    path: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Git file restore", move || {
        git::restore_file(&root, &rev, &path)
    })
    .await
}

#[tauri::command]
async fn git_restore_project(
    state: tauri::State<'_, AppState>,
    rev: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Git project restore", move || {
        git::restore_project(&root, &rev)
    })
    .await
}

#[tauri::command]
async fn git_auto_commit(
    state: tauri::State<'_, AppState>,
    message: String,
    author: Option<String>,
) -> Result<Option<String>, String> {
    let root = current_root(&state)?;
    run_blocking("Git automatic commit", move || {
        git::auto_commit(&root, &message, author.as_deref())
    })
    .await
}

// ---- Overleaf bridge -------------------------------------------------------

const OVERLEAF_LOGIN_WINDOW: &str = "overleaf-login";

fn overleaf_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve the app config folder: {error}"))
}

#[tauri::command]
async fn overleaf_status(app: tauri::AppHandle) -> Result<overleaf::OverleafStatus, String> {
    let config = overleaf_config_dir(&app)?;
    run_blocking("Overleaf status", move || overleaf::session_status(&config)).await
}

/// Open Overleaf's own login page in a dedicated window. The user signs in
/// exactly as they would in a browser (including SSO); `overleaf_poll_login`
/// then captures the session cookie — no manual copying for the common case.
#[tauri::command]
fn overleaf_begin_login(app: tauri::AppHandle, host: Option<String>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(OVERLEAF_LOGIN_WINDOW) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let host = overleaf::normalize_host(host.as_deref().unwrap_or(""));
    let url: tauri::Url = format!("{host}/login")
        .parse()
        .map_err(|error| format!("Invalid Overleaf host: {error}"))?;
    tauri::WebviewWindowBuilder::new(
        &app,
        OVERLEAF_LOGIN_WINDOW,
        tauri::WebviewUrl::External(url),
    )
    .title("Sign in to Overleaf")
    .inner_size(1040.0, 780.0)
    .build()
    .map_err(|error| format!("Could not open the Overleaf sign-in window: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn overleaf_poll_login(
    app: tauri::AppHandle,
    host: Option<String>,
) -> Result<overleaf::OverleafLoginPoll, String> {
    let Some(window) = app.get_webview_window(OVERLEAF_LOGIN_WINDOW) else {
        return Ok(overleaf::OverleafLoginPoll::cancelled());
    };
    let host = overleaf::normalize_host(host.as_deref().unwrap_or(""));
    let url: tauri::Url = host
        .parse()
        .map_err(|error| format!("Invalid Overleaf host: {error}"))?;
    let target_host = url.host_str().unwrap_or_default().to_string();
    // Read the whole jar and match domains ourselves: wry's `cookies_for_url`
    // compares cookie domain and URL host for equality, so a `.overleaf.com`
    // cookie never matches `www.overleaf.com` and sign-in appears to hang.
    let cookies = window.cookies().unwrap_or_default();
    let matching = cookies
        .iter()
        .filter(|cookie| {
            cookie
                .domain()
                .is_some_and(|domain| overleaf::cookie_domain_matches(domain, &target_host))
        })
        .collect::<Vec<_>>();
    let names = matching
        .iter()
        .map(|cookie| cookie.name().to_string())
        .collect::<Vec<_>>();
    if !overleaf::has_session_cookie(&names) {
        return Ok(overleaf::OverleafLoginPoll::pending());
    }
    let header = matching
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ");
    let config = overleaf_config_dir(&app)?;
    let validated = tauri::async_runtime::spawn_blocking(move || {
        overleaf::store_session_cookie(&config, &host, &header)
    })
    .await
    .map_err(|error| format!("The Overleaf login task stopped unexpectedly: {error}"))?;
    match validated {
        // A session cookie exists before the user finishes signing in (even
        // anonymous visitors get one), so a rejected cookie usually just means
        // "not yet" — keep polling, but hand the reason back so the UI can stop
        // spinning silently if it never resolves.
        Err(reason) => Ok(overleaf::OverleafLoginPoll::pending_with(reason)),
        Ok(session) => {
            let _ = window.close();
            Ok(overleaf::OverleafLoginPoll::connected(session))
        }
    }
}

#[tauri::command]
async fn overleaf_store_cookie(
    app: tauri::AppHandle,
    host: String,
    cookie: String,
) -> Result<overleaf::OverleafStatus, String> {
    let config = overleaf_config_dir(&app)?;
    run_blocking("Overleaf sign-in", move || {
        overleaf::store_session_cookie(&config, &host, &cookie)
    })
    .await
}

#[tauri::command]
async fn overleaf_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLEAF_LOGIN_WINDOW) {
        let _ = window.close();
    }
    // The live channel authenticates with the session being thrown away.
    shutdown_realtime(&state);
    let config = overleaf_config_dir(&app)?;
    run_blocking("Overleaf disconnect", move || overleaf::disconnect(&config)).await
}

#[tauri::command]
async fn overleaf_list_projects(
    app: tauri::AppHandle,
) -> Result<Vec<overleaf::OverleafProject>, String> {
    let config = overleaf_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::list_projects(&config))
        .await
        .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Where Overleaf projects are downloaded to.
fn overleaf_projects_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("Could not resolve Documents folder: {error}"))?;
    let parent = documents.join("Overleaf Projects");
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("Could not create the Overleaf Projects folder: {error}"))?;
    Ok(parent)
}

/// What opening this project would do, so the app can ask before it acts.
#[tauri::command]
async fn overleaf_clone_target(
    app: tauri::AppHandle,
    project_id: String,
    name: String,
) -> Result<overleaf::CloneTarget, String> {
    let parent = overleaf_projects_dir(&app)?;
    run_blocking("Overleaf project location", move || {
        overleaf::clone_target(&project_id, &name, &parent)
    })
    .await
}

#[tauri::command]
async fn overleaf_clone_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_id: String,
    name: String,
    access_level: Option<String>,
    // `adopt`: link the folder already sitting there instead of downloading a
    // second copy beside it. Only meaningful when `overleaf_clone_target`
    // reported `occupied`.
    adopt: Option<bool>,
) -> Result<String, String> {
    let config = overleaf_config_dir(&app)?;
    let parent = overleaf_projects_dir(&app)?;
    let root = tauri::async_runtime::spawn_blocking(move || {
        if adopt.unwrap_or(false) {
            let target = overleaf::clone_target(&project_id, &name, &parent)?;
            if target.kind == "occupied" {
                return overleaf::adopt_project(
                    &config,
                    &project_id,
                    &name,
                    std::path::Path::new(&target.path),
                    access_level.as_deref(),
                );
            }
        }
        overleaf::clone_project(
            &config,
            &project_id,
            &name,
            &parent,
            access_level.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("The Overleaf download stopped unexpectedly: {error}"))??;
    // Cloned projects start version tracking immediately so the Versions
    // timeline can show what each future sync changed.
    let _ = git::init(&root);
    set_root(&state, root.clone())?;
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
async fn overleaf_link(
    state: tauri::State<'_, AppState>,
) -> Result<Option<overleaf::OverleafLink>, String> {
    let root = current_root(&state)?;
    run_blocking("Overleaf project link", move || {
        overleaf::project_link(&root)
    })
    .await
}

// ---- Overleaf realtime editing ---------------------------------------------

fn realtime_client(
    state: &tauri::State<'_, AppState>,
) -> Result<Arc<overleaf_rt::RealtimeClient>, String> {
    state
        .realtime
        .lock()
        .map_err(|_| "The Overleaf connection is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "Not connected to Overleaf's live editing channel.".to_string())
}

/// Open the live editing channel for the current project.
///
/// Every event the channel produces is forwarded to the web UI as
/// `overleaf-realtime`, which is where documents, chat and comments all arrive.
#[tauri::command]
async fn overleaf_rt_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    let (host, cookie, project_id, user_id) =
        tauri::async_runtime::spawn_blocking(move || overleaf::realtime_config(&config, &root))
            .await
            .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))??;

    // Replace any previous connection so reconnecting never leaves two live.
    if let Ok(mut slot) = state.realtime.lock() {
        if let Some(previous) = slot.take() {
            previous.shutdown();
        }
    }

    use tauri::Emitter;
    let emitter = app.clone();
    let client = overleaf_rt::RealtimeClient::connect(
        overleaf_rt::RealtimeConfig {
            user_id,
            host,
            cookie,
            project_id,
        },
        move |event| {
            let _ = emitter.emit("overleaf-realtime", event);
        },
    )
    .await?;
    // Answering with the project tree, rather than only emitting it, is what
    // makes live editing reliable: the app can start the moment this returns
    // instead of depending on an event that may have been emitted before its
    // listener was registered.
    let joined = serde_json::json!({
        "publicId": client.public_id(),
        "rootFolderId": client.project().root_folder_id,
        "docs": client.project().docs,
        "entities": client.project().entities,
        "userId": client.project().user_id,
        "trackChanges": client.project().track_changes,
        // Without this the app read `undefined` and overwrote whatever the
        // projectJoined event had already established: a reviewer was treated
        // as a writer, so their first keystroke went out as a plain edit, the
        // server refused it, and live editing died on the spot.
        "permission": client.project().permission,
    });
    state
        .realtime
        .lock()
        .map_err(|_| "The Overleaf connection is unavailable.".to_string())?
        .replace(Arc::new(client));
    Ok(joined)
}

/// Close the live channel if one is open. Safe to call when there is none.
fn shutdown_realtime(state: &tauri::State<'_, AppState>) {
    if let Ok(mut slot) = state.realtime.lock() {
        if let Some(client) = slot.take() {
            client.shutdown();
        }
    }
}

#[tauri::command]
fn overleaf_rt_disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    shutdown_realtime(&state);
    Ok(())
}

/// Our own id on the channel, or null when not connected. The server echoes
/// our updates back, and this is how the app tells them from someone else's.
#[tauri::command]
fn overleaf_rt_connected(state: tauri::State<'_, AppState>) -> Option<String> {
    state
        .realtime
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|client| client.public_id()))
}

/// Subscribe to a document; returns its current text and version.
///
/// `fromVersion` asks the server to replay what happened while we were away
/// instead of only handing back the current text, which is what lets work that
/// never reached it survive coming back to a file.
#[tauri::command]
async fn overleaf_rt_join_doc(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    from_version: Option<i64>,
) -> Result<overleaf_rt::JoinedDoc, String> {
    realtime_client(&state)?
        .join_doc(&doc_id, from_version)
        .await
}

/// Everyone currently in the Overleaf project, ourselves included.
#[tauri::command]
async fn overleaf_rt_connected_users(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<overleaf_rt::PresenceUser>, String> {
    realtime_client(&state)?.connected_users().await
}

/// Publish our caret, which is also what makes us visible to everyone else.
#[tauri::command]
async fn overleaf_rt_update_position(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    row: i64,
    column: i64,
) -> Result<(), String> {
    realtime_client(&state)?
        .update_position(&doc_id, row, column)
        .await
}

#[tauri::command]
async fn overleaf_rt_leave_doc(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<(), String> {
    realtime_client(&state)?.leave_doc(&doc_id).await
}

#[tauri::command]
async fn overleaf_rt_send_ops(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    version: i64,
    ops: Vec<overleaf_rt::OtOp>,
) -> Result<(), String> {
    realtime_client(&state)?
        .send_ops(&doc_id, version, ops)
        .await
}

/// Anchor a comment thread to a span of the open document.
#[tauri::command]
async fn overleaf_rt_send_comment(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    version: i64,
    position: i64,
    quote: String,
    thread_id: String,
) -> Result<(), String> {
    realtime_client(&state)?
        .send_comment(&doc_id, version, position, &quote, &thread_id)
        .await
}

#[tauri::command]
async fn overleaf_chat_messages(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<overleaf::OverleafMessage>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    let limit = limit.unwrap_or(80);
    tauri::async_runtime::spawn_blocking(move || overleaf::chat_messages(&config, &root, limit))
        .await
        .map_err(|error| format!("The Overleaf chat task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_send_chat_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    content: String,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::send_chat_message(&config, &root, &content)
    })
    .await
    .map_err(|error| format!("The Overleaf chat task stopped unexpectedly: {error}"))?
}

/// Paths the realtime channel is editing right now. Syncing skips them: the
/// channel is already converging both copies, and a REST upload of the same
/// text would reach collaborators as an out-of-band overwrite.
fn live_paths(live: Option<Vec<String>>) -> std::collections::BTreeSet<String> {
    live.unwrap_or_default().into_iter().collect()
}

/// Record what Overleaf says this account may do to the linked project.
#[tauri::command]
async fn overleaf_set_permission(
    state: tauri::State<'_, AppState>,
    permission: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Overleaf permission update", move || {
        overleaf::set_permission(&root, &permission)
    })
    .await
}

// ---- Overleaf's own history ----------------------------------------------

#[tauri::command]
async fn overleaf_history_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    before: Option<i64>,
    count: Option<u32>,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    let (updates, next) = tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_updates(&config, &root, before, count.unwrap_or(20))
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))??;
    Ok(serde_json::json!({ "updates": updates, "nextBefore": next }))
}

#[tauri::command]
async fn overleaf_history_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_diff(&config, &root, &path, from, to)
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::history_files(&config, &root, from, to))
        .await
        .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_labels(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<overleaf::OverleafLabel>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::history_labels(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

/// Roll one file back, or the whole project when `path` is absent.
#[tauri::command]
async fn overleaf_history_revert(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    version: i64,
    path: Option<String>,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_revert(&config, &root, version, path.as_deref())
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_restore_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    version: i64,
    path: String,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_restore_file(&config, &root, version, &path)
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_add_label(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    version: i64,
    comment: String,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_add_label(&config, &root, version, &comment)
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_delete_label(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    label_id: String,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_delete_label(&config, &root, &label_id)
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

/// Accept tracked changes, turning the suggested text into ordinary text.
#[tauri::command]
async fn overleaf_accept_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    doc_id: String,
    change_ids: Vec<String>,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::accept_changes(&config, &root, &doc_id, &change_ids)
    })
    .await
    .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Reject tracked changes by undoing them through the editing channel.
#[tauri::command]
async fn overleaf_reject_changes(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    version: i64,
    changes: Vec<overleaf_rt::TrackedChange>,
) -> Result<(), String> {
    realtime_client(&state)?
        .reject_changes(&doc_id, version, &changes)
        .await
}

/// Send an edit as a suggestion rather than applying it outright.
#[tauri::command]
async fn overleaf_rt_send_tracked_ops(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    version: i64,
    ops: Vec<overleaf_rt::OtOp>,
) -> Result<(), String> {
    realtime_client(&state)?
        .send_tracked_ops(&doc_id, version, ops)
        .await
}

/// Who wrote the suggestions in this project.
#[tauri::command]
async fn overleaf_change_authors(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::change_authors(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Turn suggestions on or off for the accounts named in `on_for`.
#[tauri::command]
async fn overleaf_set_track_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    on_for: serde_json::Value,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::set_track_changes(&config, &root, on_for)
    })
    .await
    .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Create a document on Overleaf, so a file made here exists for everyone.
#[tauri::command]
async fn overleaf_create_doc(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    parent_folder_id: String,
    name: String,
) -> Result<String, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::create_doc(&config, &root, &parent_folder_id, &name)
    })
    .await
    .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Delete a document, file or folder on Overleaf.
#[tauri::command]
async fn overleaf_delete_entity(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    kind: String,
    entity_id: String,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::delete_entity(&config, &root, &kind, &entity_id)
    })
    .await
    .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_threads(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<overleaf::OverleafThread>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::threads(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

/// What is anchored in one document right now, without re-joining it.
#[tauri::command]
async fn overleaf_doc_ranges(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<overleaf::DocRanges, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::doc_ranges(&config, &root, &doc_id))
        .await
        .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Where every comment in the project is anchored, whatever file it is in.
#[tauri::command]
async fn overleaf_comment_anchors(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<overleaf::OverleafCommentAnchor>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::comment_anchors(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_edit_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    thread_id: String,
    message_id: String,
    content: String,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::edit_message(&config, &root, &thread_id, &message_id, &content)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_delete_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    thread_id: String,
    message_id: String,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::delete_message(&config, &root, &thread_id, &message_id)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_reply_to_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    thread_id: String,
    content: String,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::reply_to_thread(&config, &root, &thread_id, &content)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_resolve_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    doc_id: String,
    thread_id: String,
    resolved: bool,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::resolve_thread(&config, &root, &doc_id, &thread_id, resolved)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_delete_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    doc_id: String,
    thread_id: String,
) -> Result<(), String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::delete_thread(&config, &root, &doc_id, &thread_id)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

/// Dry run: what a sync would change, without writing or uploading anything.
#[tauri::command]
async fn overleaf_preview(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    live: Option<Vec<String>>,
) -> Result<overleaf::OverleafPreview, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    let live = live_paths(live);
    tauri::async_runtime::spawn_blocking(move || overleaf::preview(&config, &root, &live))
        .await
        .map_err(|error| format!("The Overleaf comparison stopped unexpectedly: {error}"))?
}

/// Stop or restart syncing for the open project.
#[tauri::command]
async fn overleaf_set_paused(
    state: tauri::State<'_, AppState>,
    paused: bool,
) -> Result<(), String> {
    if paused {
        // A socket left open would keep delivering edits, chat and presence
        // for a project the user just asked us to leave alone.
        shutdown_realtime(&state);
    }
    let root = current_root(&state)?;
    run_blocking("Overleaf sync setting", move || {
        overleaf::set_paused(&root, paused)
    })
    .await
}

#[tauri::command]
async fn overleaf_probe(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<overleaf::OverleafProbe, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::probe(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf check stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_sync(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    live: Option<Vec<String>>,
) -> Result<overleaf::OverleafSyncResult, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    let live = live_paths(live);
    tauri::async_runtime::spawn_blocking(move || overleaf::sync(&config, &root, &live))
        .await
        .map_err(|error| format!("The Overleaf sync stopped unexpectedly: {error}"))?
}

/// The models the agent runtime offers for a provider.
#[tauri::command]
async fn agent_models(
    state: tauri::State<'_, AppState>,
    provider: String,
) -> Result<Vec<agents::AgentModel>, String> {
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || agents::list_models(&runtime, &provider))
        .await
        .map_err(|error| format!("The model lookup stopped unexpectedly: {error}"))?
}

/// Which agent runtime is in use, and whether a newer one is published.
#[tauri::command]
async fn agent_runtime_status(
    state: tauri::State<'_, AppState>,
) -> Result<omp_update::RuntimeStatus, String> {
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bundled = runtime
            .bundled_version()
            .ok_or_else(|| "The bundled agent runtime has no version.".to_string())?;
        Ok(omp_update::status(&runtime.config, &bundled))
    })
    .await
    .map_err(|error| format!("The agent update check stopped unexpectedly: {error}"))?
}

/// Download and install the newest agent runtime beside the bundled one.
#[tauri::command]
async fn agent_runtime_update(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || omp_update::install_latest(&runtime.config))
        .await
        .map_err(|error| format!("The agent update stopped unexpectedly: {error}"))?
}

/// Drop back to the runtime inside the app bundle.
#[tauri::command]
async fn agent_runtime_revert(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || omp_update::revert_to_bundled(&runtime.config))
        .await
        .map_err(|error| format!("The agent revert stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_pdf_annotations(state: tauri::State<'_, AppState>) -> Result<Vec<PdfMark>, String> {
    let root = current_root(&state)?;
    run_blocking("PDF annotation read", move || {
        project::read_pdf_marks(&root)
    })
    .await
}

#[tauri::command]
async fn save_pdf_annotations(
    state: tauri::State<'_, AppState>,
    annotations: Vec<PdfMark>,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("PDF annotation save", move || {
        project::write_pdf_marks(&root, annotations)
    })
    .await
}

#[tauri::command]
async fn list_editor_comments(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<EditorComment>, String> {
    let root = current_root(&state)?;
    run_blocking("Editor comment read", move || {
        project::read_editor_comments(&root)
    })
    .await
}

#[tauri::command]
async fn save_editor_comments(
    state: tauri::State<'_, AppState>,
    comments: Vec<EditorComment>,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Editor comment save", move || {
        project::write_editor_comments(&root, comments)
    })
    .await
}

#[tauri::command]
async fn save_compiled_pdf(path: String, pdf_base64: String) -> Result<String, String> {
    run_blocking("Compiled PDF save", move || {
        latex::save_pdf(Path::new(&path), &pdf_base64)
    })
    .await
}

#[tauri::command]
async fn synctex_edit(
    state: tauri::State<'_, AppState>,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SyncTexTarget, String> {
    let root = current_root(&state)?;
    run_blocking("SyncTeX lookup", move || {
        latex::inverse_search(&root, page, x, y)
    })
    .await
}

#[tauri::command]
async fn synctex_view(
    state: tauri::State<'_, AppState>,
    path: String,
    line: u32,
    column: u32,
) -> Result<Option<PdfSyncTarget>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || latex::forward_search(&root, &path, line, column))
        .await
        .map_err(|error| format!("The SyncTeX lookup stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn import_reference(
    state: tauri::State<'_, AppState>,
    input: String,
) -> Result<ImportResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::import_reference(&root, &input))
        .await
        .map_err(|error| format!("The paper import task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn fetch_paper(
    state: tauri::State<'_, AppState>,
    arxiv_id: String,
) -> Result<papers::FetchResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::fetch_paper(&root, &arxiv_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn upgrade_bibliography(
    state: tauri::State<'_, AppState>,
    dry_run: Option<bool>,
) -> Result<papers::UpgradeResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        papers::upgrade_bibliography(&root, dry_run.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_reference(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<papers::RemoveResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::remove_reference(&root, &key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_papers(state: tauri::State<'_, AppState>) -> Result<Vec<PaperSummary>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::list_papers(&root))
        .await
        .map_err(|error| format!("Paper scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn read_paper(state: tauri::State<'_, AppState>, arxiv_id: String) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Paper read", move || papers::read_paper(&root, &arxiv_id)).await
}

#[tauri::command]
async fn read_paper_blog_local(
    state: tauri::State<'_, AppState>,
    arxiv_id: String,
) -> Result<Option<String>, String> {
    let root = current_root(&state)?;
    run_blocking("Paper overview read", move || {
        papers::read_paper_blog_local(&root, &arxiv_id)
    })
    .await
}

#[tauri::command]
async fn read_paper_blog(
    state: tauri::State<'_, AppState>,
    arxiv_id: String,
) -> Result<Option<String>, String> {
    // May reach the network (lazy backfill), so keep it off the main thread.
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::read_paper_blog(&root, &arxiv_id))
        .await
        .map_err(|error| format!("The paper overview task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn run_agent(
    state: tauri::State<'_, AppState>,
    on_event: tauri::ipc::Channel<AgentStreamEvent>,
    request: AgentRunRequest,
) -> Result<AgentResult, String> {
    let root = current_root(&state)?;
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        agents::run(
            &root,
            &runtime,
            agents::AgentRequest {
                settings: &request.settings,
                message: &request.message,
                attachments: &request.attachments,
                active_file: request.active_file.as_deref(),
                selection: request.selection.as_deref(),
                session_id: &request.session_id,
                session_title: &request.session_title,
                system_prompt: &request.system_prompt,
            },
            &|event| {
                let _ = on_event.send(event);
            },
        )
    })
    .await
    .map_err(|error| format!("The writing agent task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn inspect_agent_attachments(
    attachments: Vec<AgentAttachmentDescriptor>,
) -> Result<Vec<AgentAttachmentMetadata>, String> {
    run_blocking("Attachment inspection", move || {
        agents::inspect_attachments(&attachments)
    })
    .await
}

#[tauri::command]
async fn abort_agent(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.abort_run(&session_id))
        .await
        .map_err(|error| format!("Could not stop the writing agent: {error}"))?
}

#[tauri::command]
async fn subscription_status(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SubscriptionStatus>, String> {
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || agents::subscription_status(&runtime))
        .await
        .map_err(|error| format!("Could not check subscription status: {error}"))?
}

#[tauri::command]
async fn list_agent_commands(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentCommand>, String> {
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || agents::list_agent_commands(&runtime))
        .await
        .map_err(|error| format!("Could not list agent commands: {error}"))?
}

#[tauri::command]
async fn begin_subscription_login(
    state: tauri::State<'_, AppState>,
    provider: String,
    on_event: tauri::ipc::Channel<SubscriptionLoginEvent>,
) -> Result<(), String> {
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        agents::begin_subscription_login(&runtime, &provider, &|event| {
            let _ = on_event.send(event);
        })
    })
    .await
    .map_err(|error| format!("Could not complete OMP sign-in: {error}"))?
}

#[tauri::command]
async fn save_api_key(provider: String, key: String) -> Result<(), String> {
    run_blocking("API key save", move || {
        agents::save_api_key(&provider, &key)
    })
    .await
}

#[tauri::command]
async fn delete_api_key(provider: String) -> Result<(), String> {
    run_blocking("API key deletion", move || {
        agents::delete_api_key(&provider)
    })
    .await
}

#[tauri::command]
async fn api_key_status() -> Result<Vec<(String, bool)>, String> {
    run_blocking("API key status", move || Ok(agents::api_key_status())).await
}

#[tauri::command]
async fn list_history(state: tauri::State<'_, AppState>) -> Result<Vec<HistoryItem>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::history(&root))
        .await
        .map_err(|error| format!("History scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn get_history_entry(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<TransactionRecord, String> {
    let root = current_root(&state)?;
    run_blocking("History entry read", move || {
        project::get_history_entry(&root, &transaction_id)
    })
    .await
}

#[tauri::command]
async fn revert_transaction(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("History revert", move || {
        let record = project::revert(&root, &transaction_id)?;
        Ok(record.id)
    })
    .await
}

#[tauri::command]
async fn revert_history_file(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
    path: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("History file revert", move || {
        let record = project::revert_file(&root, &transaction_id, &path)?;
        Ok(record.id)
    })
    .await
}

#[tauri::command]
async fn delete_history_entry(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("History deletion", move || {
        project::delete_history(&root, &transaction_id)
    })
    .await
}

#[tauri::command]
async fn create_agent_session(
    state: tauri::State<'_, AppState>,
    provider: String,
    model: String,
    reasoning_effort: String,
) -> Result<AgentSession, String> {
    let root = current_root(&state)?;
    run_blocking("Agent session creation", move || {
        sessions::create(&root, &provider, &model, &reasoning_effort)
    })
    .await
}

#[tauri::command]
async fn list_agent_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentSessionSummary>, String> {
    let root = current_root(&state)?;
    run_blocking("Agent session scan", move || sessions::list(&root)).await
}

#[tauri::command]
async fn search_agent_sessions(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<AgentSessionSearchResult>, String> {
    let root = current_root(&state)?;
    run_blocking("Agent session search", move || {
        sessions::search(&root, &query)
    })
    .await
}

#[tauri::command]
async fn read_agent_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<AgentSession, String> {
    let root = current_root(&state)?;
    run_blocking("Agent session read", move || {
        sessions::read(&root, &session_id)
    })
    .await
}

#[tauri::command]
async fn save_agent_session(
    state: tauri::State<'_, AppState>,
    session: AgentSession,
) -> Result<AgentSession, String> {
    let root = current_root(&state)?;
    run_blocking("Agent session save", move || sessions::save(&root, session)).await
}

#[tauri::command]
async fn save_agent_checkpoint(
    state: tauri::State<'_, AppState>,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Agent checkpoint save", move || {
        project::save_conversation_checkpoint(&root, &session_id, &message_id)
    })
    .await
}

#[tauri::command]
async fn delete_agent_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Agent session deletion", move || {
        sessions::delete(&root, &session_id)
    })
    .await
}

#[tauri::command]
async fn fork_agent_session(
    state: tauri::State<'_, AppState>,
    source_session_id: String,
    message_id: String,
    system_prompt: String,
) -> Result<AgentSession, String> {
    let root = current_root(&state)?;
    let runtime = state.agent_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = sessions::read(&root, &source_session_id)?;
        let target_index = source
            .messages
            .iter()
            .position(|message| message.id == message_id && message.role == "user")
            .ok_or_else(|| "The message to branch from is no longer available.".to_string())?;
        let user_message_index = source.messages[..target_index]
            .iter()
            .filter(|message| message.role == "user")
            .count();
        let settings = models::AgentSettings {
            provider: source.provider.clone(),
            model: source.model.clone(),
            reasoning_effort: source.reasoning_effort.clone(),
        };
        let branch = agents::fork_session(
            &root,
            &runtime,
            &settings,
            &source.id,
            &source.title,
            user_message_index,
            &system_prompt,
        )?;
        let session = sessions::create_branch(&root, &source, &branch.session_id, &message_id)?;
        project::restore_conversation_checkpoint(
            &root,
            &source.id,
            &message_id,
            branch.source_timestamp.as_deref(),
        )?;
        Ok(session)
    })
    .await
    .map_err(|error| format!("Could not create the conversation branch: {error}"))?
}

#[tauri::command]
async fn start_tex_install(kind: String) -> Result<(), String> {
    run_blocking("TeX installer launch", move || {
        tex_setup::start_tex_install(&kind)
    })
    .await
}

/// Keep native resize backing surfaces in sync with the web app theme.
#[tauri::command]
fn set_window_background(app: tauri::AppHandle, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is unavailable.".to_string())?;
        macos_window::apply_window_background(&window, dark);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, dark);
        Ok(())
    }
}

#[tauri::command]
fn align_traffic_lights(
    app: tauri::AppHandle,
    close_center_x: f64,
    center_from_top: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is unavailable.".to_string())?;
        macos_window::align_traffic_lights_to(&window, close_center_x, center_from_top);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, close_center_x, center_from_top);
        Ok(())
    }
}

#[tauri::command]
async fn list_agent_skills(state: tauri::State<'_, AppState>) -> Result<Vec<AgentSkill>, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone()
        .unwrap_or_else(|| state.agent_runtime.config.join("no-project"));
    let runtime = state.agent_runtime.clone();
    run_blocking("Agent skill scan", move || {
        skill_store::list(&root, &runtime)
    })
    .await
}

#[tauri::command]
async fn save_agent_skill(
    state: tauri::State<'_, AppState>,
    request: AgentSkillSaveRequest,
) -> Result<AgentSkill, String> {
    let root = if request.scope == "project" {
        current_root(&state)?
    } else {
        state
            .root
            .lock()
            .map_err(|_| "Project state is unavailable.".to_string())?
            .clone()
            .unwrap_or_else(|| state.agent_runtime.config.join("no-project"))
    };
    let runtime = state.agent_runtime.clone();
    run_blocking("Agent skill save", move || {
        skill_store::save(&root, &runtime, request)
    })
    .await
}

#[tauri::command]
async fn set_agent_skill_enabled(
    state: tauri::State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let runtime = state.agent_runtime.clone();
    run_blocking("Agent skill update", move || {
        skill_store::set_enabled(&runtime, &name, enabled)
    })
    .await
}

#[tauri::command]
async fn delete_agent_skill(
    state: tauri::State<'_, AppState>,
    name: String,
    scope: String,
) -> Result<(), String> {
    let root = if scope == "project" {
        current_root(&state)?
    } else {
        state
            .root
            .lock()
            .map_err(|_| "Project state is unavailable.".to_string())?
            .clone()
            .unwrap_or_else(|| state.agent_runtime.config.join("no-project"))
    };
    let runtime = state.agent_runtime.clone();
    run_blocking("Agent skill deletion", move || {
        skill_store::delete(&root, &runtime, &name, &scope)
    })
    .await
}

#[tauri::command]
async fn list_mcp_servers(state: tauri::State<'_, AppState>) -> Result<Vec<McpServer>, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone()
        .unwrap_or_else(|| state.agent_runtime.config.join("no-project"));
    let runtime = state.agent_runtime.clone();
    run_blocking("MCP server scan", move || mcp_store::list(&root, &runtime)).await
}

#[tauri::command]
async fn save_mcp_server(
    state: tauri::State<'_, AppState>,
    request: McpServerSaveRequest,
) -> Result<McpServer, String> {
    let root = if request.scope == "project" {
        current_root(&state)?
    } else {
        state
            .root
            .lock()
            .map_err(|_| "Project state is unavailable.".to_string())?
            .clone()
            .unwrap_or_else(|| state.agent_runtime.config.join("no-project"))
    };
    let runtime = state.agent_runtime.clone();
    run_blocking("MCP server save", move || {
        mcp_store::save(&root, &runtime, request)
    })
    .await
}

#[tauri::command]
async fn set_mcp_server_enabled(
    state: tauri::State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone()
        .unwrap_or_else(|| state.agent_runtime.config.join("no-project"));
    let runtime = state.agent_runtime.clone();
    run_blocking("MCP server update", move || {
        mcp_store::set_enabled(&root, &runtime, &name, enabled)
    })
    .await
}

#[tauri::command]
async fn delete_mcp_server(
    state: tauri::State<'_, AppState>,
    name: String,
    scope: String,
) -> Result<(), String> {
    let root = if scope == "project" {
        current_root(&state)?
    } else {
        state
            .root
            .lock()
            .map_err(|_| "Project state is unavailable.".to_string())?
            .clone()
            .unwrap_or_else(|| state.agent_runtime.config.join("no-project"))
    };
    let runtime = state.agent_runtime.clone();
    run_blocking("MCP server deletion", move || {
        mcp_store::delete(&root, &runtime, &name, &scope)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Literature operations requested by the agent through the same domain code
/// used by the app's own interface.
///
/// The agent runs in a sidecar process and cannot call into the app, so the
/// app offers a private JSON dispatcher through its own executable. Keeping
/// search, fetch, cite, upgrade, and removal here avoids a second TypeScript
/// implementation drifting from the UI.
///
/// Returns true when this was a CLI invocation and the process should exit.
/// Must run before anything touches Tauri or AppKit.
#[derive(serde::Deserialize)]
#[serde(tag = "tool", content = "params", rename_all = "snake_case")]
enum LiteratureRequest {
    SearchLiterature {
        query: String,
        #[serde(default)]
        precise: bool,
        #[serde(default)]
        page: u32,
    },
    FetchPaper {
        #[serde(rename = "arxivId")]
        arxiv_id: String,
    },
    Cite {
        query: String,
    },
    UpgradeBibliography {
        #[serde(rename = "dryRun", default)]
        dry_run: bool,
    },
    RemoveReference {
        key: String,
    },
}

fn run_cli() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("literature") {
        return false;
    }
    let Some(root) = std::env::var_os("LATTICE_PROJECT_ROOT").filter(|v| !v.is_empty()) else {
        eprintln!("LATTICE_PROJECT_ROOT is not set.");
        std::process::exit(2);
    };
    let raw = args.collect::<Vec<_>>().join(" ");
    let request: LiteratureRequest = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Invalid literature request: {error}");
            std::process::exit(2)
        }
    };
    let root = std::path::Path::new(&root);
    let result = match request {
        LiteratureRequest::SearchLiterature {
            query,
            precise,
            page,
        } => literature::search(&query, precise, page)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        LiteratureRequest::FetchPaper { arxiv_id } => papers::fetch_paper(root, &arxiv_id)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        LiteratureRequest::Cite { query } => {
            papers::import_reference_with_history(root, &query, papers::HistoryMode::Defer)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        LiteratureRequest::UpgradeBibliography { dry_run } => {
            papers::upgrade_bibliography_with_history(root, dry_run, papers::HistoryMode::Defer)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        LiteratureRequest::RemoveReference { key } => {
            papers::remove_reference_with_history(root, &key, papers::HistoryMode::Defer)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
    };
    match result {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string())
            );
            std::process::exit(0);
        }
        Err(reason) => {
            eprintln!("{reason}");
            std::process::exit(1);
        }
    }
}

pub fn run() {
    if run_cli() {
        return;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // In-app auto-update (checks GitHub Releases, verifies with the updater key).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Remember the window's size + position across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let config = app
                .path()
                .app_config_dir()
                .map_err(|error| error.to_string())?
                .join("omp");
            let (executable, assets) = agent_runtime_paths(app)?;
            app.manage(AppState::from_environment(agents::AgentRuntime::new(
                executable, assets, config,
            )));
            app.manage(synara::SynaraRuntime::new(app)?);
            synara::prewarm(app.handle().clone());
            #[cfg(target_os = "macos")]
            {
                macos_window::clear_launch_quarantine();
                if let Some(window) = app.get_webview_window("main") {
                    macos_window::install_traffic_light_alignment(&window);
                    macos_window::apply_window_background(&window, false);
                }
                macos_window::install_magnify_monitor(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_project,
            create_collab_join_workspace,
            initial_project,
            open_project,
            import_project_zip,
            export_project_zip,
            refresh_project,
            read_project_file,
            stat_project_file,
            write_project_file,
            list_citation_keys,
            list_citations,
            read_bib_entry,
            save_bib_entry,
            list_references,
            list_unused_symbols,
            list_todos,
            count_project_words,
            update_project_manifest,
            add_root_document,
            remove_root_document,
            preview_replace_in_project,
            replace_in_project,
            find_label_occurrences,
            find_citation_occurrences,
            rename_label,
            rename_citation_key,
            search_project,
            create_project_entry,
            delete_project_entry,
            rename_project_entry,
            move_project_entry,
            import_project_assets,
            import_clipboard_image,
            resolve_citation_query,
            read_project_asset,
            write_project_bytes,
            prepare_latex_figure,
            build_project,
            abort_build,
            clean_project,
            run_doctor,
            texlab_diagnostics,
            texlab_completion,
            texlab_hover,
            texlab_definition,
            format_latex,
            search_openalex,
            search_literature,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            git_init,
            git_set_remote,
            git_push,
            git_pull,
            git_fetch,
            git_log,
            git_show_diff,
            git_restore_file,
            git_restore_project,
            git_auto_commit,
            overleaf_status,
            overleaf_begin_login,
            overleaf_poll_login,
            overleaf_store_cookie,
            overleaf_disconnect,
            overleaf_list_projects,
            overleaf_clone_project,
            overleaf_link,
            overleaf_probe,
            overleaf_rt_connect,
            overleaf_rt_disconnect,
            overleaf_rt_connected,
            overleaf_rt_join_doc,
            overleaf_rt_leave_doc,
            overleaf_rt_send_ops,
            overleaf_rt_send_comment,
            overleaf_rt_connected_users,
            overleaf_rt_update_position,
            agent_models,
            agent_runtime_status,
            agent_runtime_update,
            agent_runtime_revert,
            overleaf_chat_messages,
            overleaf_send_chat_message,
            overleaf_set_permission,
            overleaf_history_updates,
            overleaf_history_diff,
            overleaf_history_files,
            overleaf_history_labels,
            overleaf_history_revert,
            overleaf_history_restore_file,
            overleaf_history_add_label,
            overleaf_history_delete_label,
            overleaf_accept_changes,
            overleaf_reject_changes,
            overleaf_rt_send_tracked_ops,
            overleaf_change_authors,
            overleaf_set_track_changes,
            overleaf_create_doc,
            overleaf_delete_entity,
            overleaf_threads,
            overleaf_comment_anchors,
            overleaf_doc_ranges,
            overleaf_edit_message,
            overleaf_delete_message,
            overleaf_reply_to_thread,
            overleaf_resolve_thread,
            overleaf_delete_thread,
            overleaf_preview,
            overleaf_clone_target,
            overleaf_set_paused,
            overleaf_sync,
            list_pdf_annotations,
            save_pdf_annotations,
            list_editor_comments,
            save_editor_comments,
            save_compiled_pdf,
            synctex_edit,
            synctex_view,
            import_reference,
            fetch_paper,
            upgrade_bibliography,
            remove_reference,
            list_papers,
            read_paper,
            read_paper_blog,
            read_paper_blog_local,
            run_agent,
            inspect_agent_attachments,
            abort_agent,
            subscription_status,
            list_agent_commands,
            begin_subscription_login,
            save_api_key,
            delete_api_key,
            api_key_status,
            list_history,
            get_history_entry,
            revert_transaction,
            revert_history_file,
            delete_history_entry,
            create_agent_session,
            list_agent_sessions,
            search_agent_sessions,
            read_agent_session,
            save_agent_session,
            save_agent_checkpoint,
            delete_agent_session,
            fork_agent_session,
            list_agent_skills,
            save_agent_skill,
            set_agent_skill_enabled,
            delete_agent_skill,
            list_mcp_servers,
            save_mcp_server,
            set_mcp_server_enabled,
            delete_mcp_server,
            start_tex_install,
            set_window_background,
            align_traffic_lights,
            synara::synara_runtime_status,
            synara::synara_ensure_ready,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<synara::SynaraRuntime>().shutdown();
        }
    });
}

fn agent_runtime_paths(app: &tauri::App) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let target = if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
            "aarch64-apple-darwin"
        } else if cfg!(all(target_arch = "x86_64", target_os = "macos")) {
            "x86_64-apple-darwin"
        } else if cfg!(all(target_arch = "x86_64", target_os = "windows")) {
            "x86_64-pc-windows-msvc"
        } else if cfg!(all(target_arch = "x86_64", target_os = "linux")) {
            "x86_64-unknown-linux-gnu"
        } else {
            return Err("This development target is not configured for the OMP sidecar.".into());
        };
        let suffix = if cfg!(target_os = "windows") {
            ".exe"
        } else {
            ""
        };
        return Ok((
            manifest
                .join("binaries")
                .join(format!("lattice-agent-{target}{suffix}")),
            manifest.join("omp-assets"),
        ));
    }

    let executable_name = if cfg!(target_os = "windows") {
        "lattice-agent.exe"
    } else {
        "lattice-agent"
    };
    let executable = std::env::current_exe()?
        .parent()
        .ok_or("The application executable has no parent folder.")?
        .join(executable_name);
    Ok((executable, app.path().resource_dir()?.join("omp-assets")))
}
