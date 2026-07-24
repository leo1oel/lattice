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
mod models;
mod openalex;
mod papers;
mod pdf_fonts;
mod project;
mod sessions;
mod skill_store;
mod tex_setup;
mod texcount;
mod texlab;

use models::{
    AgentCommand, AgentResult, AgentRunRequest, AgentSession, AgentSessionSearchResult,
    AgentSessionSummary, AgentSkill, AgentSkillSaveRequest, AgentStreamEvent, AssetPreview,
    BuildResult, CitationInfo, DoctorReport, EditorComment, GitDiff, GitRemoteResult, GitStatus,
    HistoryItem, ImportResult, LiteraturePage, OpenAlexWork, PaperSummary, PdfMark, PdfSyncTarget,
    ProjectManifest, ProjectSearchResult, ProjectSnapshot, ReferenceInfo, RenameSymbolResult,
    ReplacePreview, ReplaceResult, ResolvedCitation, SubscriptionLoginEvent, SubscriptionStatus,
    SymbolOccurrence, SyncTexTarget, TexlabCompletionItem, TexlabHover, TexlabLocation, TodoHit,
    TransactionRecord, UnusedSymbols, WordCount,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct AppState {
    root: Mutex<Option<PathBuf>>,
    agent_runtime: agents::AgentRuntime,
    active_build: latex::ActiveBuild,
    texlab: Arc<Mutex<texlab::TexlabPool>>,
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

#[tauri::command]
fn create_project(
    state: tauri::State<'_, AppState>,
    parent: String,
    name: String,
    venue: Option<String>,
) -> Result<ProjectSnapshot, String> {
    let venue = project::Venue::parse(venue.as_deref().unwrap_or("neurips"))?;
    let root = if venue == project::Venue::Neurips {
        project::create(Path::new(&parent), &name)?
    } else {
        project::create_with_venue(Path::new(&parent), &name, venue)?
    };
    let snapshot = project::open(&root)?;
    set_root(&state, root)?;
    Ok(snapshot)
}

/// Fresh blank folder under Documents/Lattice Shares for joining a share.
/// Does not modify whatever project the guest had open before.
#[tauri::command]
fn create_collab_join_workspace(
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
fn initial_project(state: tauri::State<'_, AppState>) -> Result<Option<ProjectSnapshot>, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone();
    root.map(|path| project::open(&path)).transpose()
}

#[tauri::command]
fn open_project(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<ProjectSnapshot, String> {
    let snapshot = project::open(Path::new(&path))?;
    set_root(&state, PathBuf::from(&snapshot.root))?;
    Ok(snapshot)
}

#[tauri::command]
fn import_project_zip(
    state: tauri::State<'_, AppState>,
    zip_path: String,
    parent: String,
) -> Result<ProjectSnapshot, String> {
    let snapshot = project::import_project_zip(Path::new(&zip_path), Path::new(&parent))?;
    set_root(&state, PathBuf::from(&snapshot.root))?;
    Ok(snapshot)
}

#[tauri::command]
fn export_project_zip(state: tauri::State<'_, AppState>, zip_path: String) -> Result<(), String> {
    project::export_project_zip(&current_root(&state)?, Path::new(&zip_path))
}

#[tauri::command]
fn stat_project_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<project::ProjectFileStat, String> {
    project::stat_file(&current_root(&state)?, &path)
}

#[tauri::command]
fn refresh_project(state: tauri::State<'_, AppState>) -> Result<ProjectSnapshot, String> {
    project::open(&current_root(&state)?)
}

#[tauri::command]
fn read_project_file(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    project::read_file(&current_root(&state)?, &path)
}

#[tauri::command]
fn write_project_file(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
) -> Result<String, String> {
    let transaction = project::apply_transaction(
        &current_root(&state)?,
        &format!("Edit {path}"),
        vec![(path, content)],
    )?;
    Ok(transaction.id)
}

#[tauri::command]
fn list_citation_keys(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    project::citation_keys(&current_root(&state)?)
}

#[tauri::command]
fn list_citations(state: tauri::State<'_, AppState>) -> Result<Vec<CitationInfo>, String> {
    project::citations(&current_root(&state)?)
}

#[tauri::command]
fn read_bib_entry(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<ResolvedCitation>, String> {
    project::read_bib_entry(&current_root(&state)?, &key)
}

#[tauri::command]
fn save_bib_entry(
    state: tauri::State<'_, AppState>,
    key: String,
    bibtex: String,
) -> Result<(), String> {
    project::save_bib_entry(&current_root(&state)?, &key, &bibtex)
}

#[tauri::command]
fn list_references(state: tauri::State<'_, AppState>) -> Result<Vec<ReferenceInfo>, String> {
    project::references(&current_root(&state)?)
}

#[tauri::command]
fn list_unused_symbols(state: tauri::State<'_, AppState>) -> Result<UnusedSymbols, String> {
    project::unused_symbols(&current_root(&state)?)
}

#[tauri::command]
fn list_todos(state: tauri::State<'_, AppState>) -> Result<Vec<TodoHit>, String> {
    project::list_todos(&current_root(&state)?)
}

#[tauri::command]
fn count_project_words(state: tauri::State<'_, AppState>) -> Result<WordCount, String> {
    texcount::count_project(&current_root(&state)?)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_project_manifest(
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
    project::update_manifest_settings(
        &current_root(&state)?,
        engine,
        default_root,
        trusted,
        words,
        pages,
    )
}

#[tauri::command]
fn add_root_document(
    state: tauri::State<'_, AppState>,
    path: String,
    name: Option<String>,
    make_default: Option<bool>,
) -> Result<ProjectManifest, String> {
    project::add_root_document(
        &current_root(&state)?,
        &path,
        name,
        make_default.unwrap_or(false),
    )
}

#[tauri::command]
fn remove_root_document(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<ProjectManifest, String> {
    project::remove_root_document(&current_root(&state)?, &path)
}

#[tauri::command]
fn preview_replace_in_project(
    state: tauri::State<'_, AppState>,
    query: String,
    paths: Option<Vec<String>>,
    match_case: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplacePreview, String> {
    project::preview_replace_in_project(
        &current_root(&state)?,
        &query,
        paths,
        match_case.unwrap_or(true),
        use_regex.unwrap_or(false),
    )
}

#[tauri::command]
fn replace_in_project(
    state: tauri::State<'_, AppState>,
    query: String,
    replacement: String,
    paths: Option<Vec<String>>,
    match_case: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplaceResult, String> {
    project::replace_in_project(
        &current_root(&state)?,
        &query,
        &replacement,
        paths,
        match_case.unwrap_or(true),
        use_regex.unwrap_or(false),
    )
}

#[tauri::command]
fn find_label_occurrences(
    state: tauri::State<'_, AppState>,
    label: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    project::find_label_occurrences(&current_root(&state)?, &label)
}

#[tauri::command]
fn find_citation_occurrences(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    project::find_citation_occurrences(&current_root(&state)?, &key)
}

#[tauri::command]
fn rename_label(
    state: tauri::State<'_, AppState>,
    old_label: String,
    new_label: String,
) -> Result<RenameSymbolResult, String> {
    project::rename_label(&current_root(&state)?, &old_label, &new_label)
}

#[tauri::command]
fn rename_citation_key(
    state: tauri::State<'_, AppState>,
    old_key: String,
    new_key: String,
) -> Result<RenameSymbolResult, String> {
    project::rename_citation_key(&current_root(&state)?, &old_key, &new_key)
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
fn create_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    kind: String,
) -> Result<String, String> {
    project::create_entry(&current_root(&state)?, &path, &kind)
}

#[tauri::command]
fn delete_project_entry(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    project::delete_entry(&current_root(&state)?, &path)
}

#[tauri::command]
fn rename_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    project::rename_entry(&current_root(&state)?, &path, &new_name)
}

#[tauri::command]
fn import_project_assets(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    target_directory: String,
) -> Result<Vec<String>, String> {
    project::import_assets(&current_root(&state)?, &paths, &target_directory)
}

#[tauri::command]
fn import_clipboard_image(
    state: tauri::State<'_, AppState>,
    target_directory: String,
    file_name: String,
    base64_data: String,
) -> Result<String, String> {
    project::import_image_bytes(
        &current_root(&state)?,
        &target_directory,
        &file_name,
        &base64_data,
    )
}

#[tauri::command]
fn resolve_citation_query(query: String) -> Result<ResolvedCitation, String> {
    project::resolve_citation_query(&query)
}

#[tauri::command]
fn read_project_asset(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<AssetPreview, String> {
    project::read_asset(&current_root(&state)?, &path)
}

#[tauri::command]
fn write_project_bytes(
    state: tauri::State<'_, AppState>,
    path: String,
    base64_data: String,
) -> Result<(), String> {
    project::write_bytes(&current_root(&state)?, &path, &base64_data)
}

#[tauri::command]
fn prepare_latex_figure(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    project::prepare_latex_figure(&current_root(&state)?, &path)
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
fn run_doctor(state: tauri::State<'_, AppState>) -> DoctorReport {
    let root = state.root.lock().ok().and_then(|guard| guard.clone());
    doctor::run(
        root.as_deref(),
        &state.agent_runtime.executable,
        &state.agent_runtime.assets,
    )
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
fn format_latex(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
) -> Result<String, String> {
    format_latex::format_document(&current_root(&state)?, &path, &text)
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
fn git_status(state: tauri::State<'_, AppState>) -> Result<GitStatus, String> {
    git::status(&current_root(&state)?)
}

#[tauri::command]
fn git_diff(
    state: tauri::State<'_, AppState>,
    path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    git::diff(&current_root(&state)?, &path, staged)
}

#[tauri::command]
fn git_stage(state: tauri::State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    git::stage(&current_root(&state)?, &paths)
}

#[tauri::command]
fn git_unstage(state: tauri::State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    git::unstage(&current_root(&state)?, &paths)
}

#[tauri::command]
fn git_commit(state: tauri::State<'_, AppState>, message: String) -> Result<String, String> {
    git::commit(&current_root(&state)?, &message)
}

#[tauri::command]
fn git_init(state: tauri::State<'_, AppState>) -> Result<GitStatus, String> {
    git::init(&current_root(&state)?)
}

#[tauri::command]
fn git_set_remote(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
    url: String,
) -> Result<GitStatus, String> {
    git::set_remote(
        &current_root(&state)?,
        name.as_deref().unwrap_or("origin"),
        &url,
    )
}

#[tauri::command]
fn git_push(state: tauri::State<'_, AppState>) -> Result<GitRemoteResult, String> {
    git::push(&current_root(&state)?)
}

#[tauri::command]
fn git_pull(state: tauri::State<'_, AppState>) -> Result<GitRemoteResult, String> {
    git::pull(&current_root(&state)?)
}

#[tauri::command]
fn git_fetch(state: tauri::State<'_, AppState>) -> Result<GitRemoteResult, String> {
    git::fetch(&current_root(&state)?)
}

#[tauri::command]
fn git_log(
    state: tauri::State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<models::GitLogEntry>, String> {
    git::log(&current_root(&state)?, limit.unwrap_or(200) as usize)
}

#[tauri::command]
fn git_show_diff(
    state: tauri::State<'_, AppState>,
    rev: String,
    path: String,
) -> Result<models::GitFileDiff, String> {
    git::show_diff(&current_root(&state)?, &rev, &path)
}

#[tauri::command]
fn git_restore_file(
    state: tauri::State<'_, AppState>,
    rev: String,
    path: String,
) -> Result<(), String> {
    git::restore_file(&current_root(&state)?, &rev, &path)
}

#[tauri::command]
fn git_restore_project(
    state: tauri::State<'_, AppState>,
    rev: String,
) -> Result<String, String> {
    git::restore_project(&current_root(&state)?, &rev)
}

#[tauri::command]
fn git_auto_commit(
    state: tauri::State<'_, AppState>,
    message: String,
    author: Option<String>,
) -> Result<Option<String>, String> {
    git::auto_commit(&current_root(&state)?, &message, author.as_deref())
}

#[tauri::command]
fn list_pdf_annotations(state: tauri::State<'_, AppState>) -> Result<Vec<PdfMark>, String> {
    project::read_pdf_marks(&current_root(&state)?)
}

#[tauri::command]
fn save_pdf_annotations(
    state: tauri::State<'_, AppState>,
    annotations: Vec<PdfMark>,
) -> Result<(), String> {
    project::write_pdf_marks(&current_root(&state)?, annotations)
}

#[tauri::command]
fn list_editor_comments(state: tauri::State<'_, AppState>) -> Result<Vec<EditorComment>, String> {
    project::read_editor_comments(&current_root(&state)?)
}

#[tauri::command]
fn save_editor_comments(
    state: tauri::State<'_, AppState>,
    comments: Vec<EditorComment>,
) -> Result<(), String> {
    project::write_editor_comments(&current_root(&state)?, comments)
}

#[tauri::command]
fn save_compiled_pdf(path: String, pdf_base64: String) -> Result<String, String> {
    latex::save_pdf(Path::new(&path), &pdf_base64)
}

#[tauri::command]
fn synctex_edit(
    state: tauri::State<'_, AppState>,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SyncTexTarget, String> {
    latex::inverse_search(&current_root(&state)?, page, x, y)
}

#[tauri::command]
async fn synctex_view(
    state: tauri::State<'_, AppState>,
    path: String,
    line: u32,
    column: u32,
) -> Result<PdfSyncTarget, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || latex::forward_search(&root, &path, line, column))
        .await
        .map_err(|error| format!("The SyncTeX lookup stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn import_arxiv(
    state: tauri::State<'_, AppState>,
    input: String,
) -> Result<ImportResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::import_arxiv(&root, &input))
        .await
        .map_err(|error| format!("The paper import task stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn list_papers(state: tauri::State<'_, AppState>) -> Result<Vec<PaperSummary>, String> {
    papers::list_papers(&current_root(&state)?)
}

#[tauri::command]
fn read_paper(state: tauri::State<'_, AppState>, arxiv_id: String) -> Result<String, String> {
    papers::read_paper(&current_root(&state)?, &arxiv_id)
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
fn rename_paper(
    state: tauri::State<'_, AppState>,
    arxiv_id: String,
    title: String,
) -> Result<PaperSummary, String> {
    papers::rename_paper(&current_root(&state)?, &arxiv_id, &title)
}

#[tauri::command]
fn delete_paper(
    state: tauri::State<'_, AppState>,
    arxiv_id: Option<String>,
    citation_key: Option<String>,
) -> Result<(), String> {
    papers::delete_paper(
        &current_root(&state)?,
        arxiv_id.as_deref(),
        citation_key.as_deref(),
    )
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
fn save_api_key(provider: String, key: String) -> Result<(), String> {
    agents::save_api_key(&provider, &key)
}

#[tauri::command]
fn delete_api_key(provider: String) -> Result<(), String> {
    agents::delete_api_key(&provider)
}

#[tauri::command]
fn api_key_status() -> Vec<(String, bool)> {
    agents::api_key_status()
}

#[tauri::command]
fn list_history(state: tauri::State<'_, AppState>) -> Result<Vec<HistoryItem>, String> {
    project::history(&current_root(&state)?)
}

#[tauri::command]
fn get_history_entry(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<TransactionRecord, String> {
    project::get_history_entry(&current_root(&state)?, &transaction_id)
}

#[tauri::command]
fn revert_transaction(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<String, String> {
    let record = project::revert(&current_root(&state)?, &transaction_id)?;
    Ok(record.id)
}

#[tauri::command]
fn revert_history_file(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
    path: String,
) -> Result<String, String> {
    let record = project::revert_file(&current_root(&state)?, &transaction_id, &path)?;
    Ok(record.id)
}

#[tauri::command]
fn delete_history_entry(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<(), String> {
    project::delete_history(&current_root(&state)?, &transaction_id)
}

#[tauri::command]
fn create_agent_session(
    state: tauri::State<'_, AppState>,
    provider: String,
    model: String,
    reasoning_effort: String,
) -> Result<AgentSession, String> {
    sessions::create(&current_root(&state)?, &provider, &model, &reasoning_effort)
}

#[tauri::command]
fn list_agent_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentSessionSummary>, String> {
    sessions::list(&current_root(&state)?)
}

#[tauri::command]
fn search_agent_sessions(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<AgentSessionSearchResult>, String> {
    sessions::search(&current_root(&state)?, &query)
}

#[tauri::command]
fn read_agent_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<AgentSession, String> {
    sessions::read(&current_root(&state)?, &session_id)
}

#[tauri::command]
fn save_agent_session(
    state: tauri::State<'_, AppState>,
    session: AgentSession,
) -> Result<AgentSession, String> {
    sessions::save(&current_root(&state)?, session)
}

#[tauri::command]
fn save_agent_checkpoint(
    state: tauri::State<'_, AppState>,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    project::save_conversation_checkpoint(&current_root(&state)?, &session_id, &message_id)
}

#[tauri::command]
fn delete_agent_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    sessions::delete(&current_root(&state)?, &session_id)
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
fn start_tex_install(kind: String) -> Result<(), String> {
    tex_setup::start_tex_install(&kind)
}

/// Align macOS traffic lights to a web-measured titlebar control center.
#[tauri::command]
fn align_traffic_lights(
    app: tauri::AppHandle,
    center_y: f64,
    titlebar_height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is unavailable.".to_string())?;
        macos_window::align_traffic_lights_to(&window, center_y, titlebar_height);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, center_y, titlebar_height);
        Ok(())
    }
}

#[tauri::command]
fn list_agent_skills(state: tauri::State<'_, AppState>) -> Result<Vec<AgentSkill>, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone()
        .unwrap_or_else(|| state.agent_runtime.config.join("no-project"));
    skill_store::list(&root, &state.agent_runtime)
}

#[tauri::command]
fn save_agent_skill(
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
    skill_store::save(&root, &state.agent_runtime, request)
}

#[tauri::command]
fn set_agent_skill_enabled(
    state: tauri::State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    skill_store::set_enabled(&state.agent_runtime, &name, enabled)
}

#[tauri::command]
fn delete_agent_skill(
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
    skill_store::delete(&root, &state.agent_runtime, &name, &scope)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            #[cfg(target_os = "macos")]
            {
                macos_window::clear_launch_quarantine();
                if let Some(window) = app.get_webview_window("main") {
                    macos_window::apply_traffic_light_position(&window);
                }
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
            list_pdf_annotations,
            save_pdf_annotations,
            list_editor_comments,
            save_editor_comments,
            save_compiled_pdf,
            synctex_edit,
            synctex_view,
            import_arxiv,
            list_papers,
            read_paper,
            read_paper_blog,
            rename_paper,
            delete_paper,
            run_agent,
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
            start_tex_install,
            align_traffic_lights,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
