mod agents;
mod commands;
mod latex;
mod models;
mod papers;
mod project;
mod sessions;

use models::{
    AgentMessage, AgentResult, AgentSession, AgentSessionSummary, AgentSettings, AgentStreamEvent,
    BuildResult, HistoryItem, ImportResult, PaperSummary, ProjectSnapshot, SubscriptionStatus,
};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

struct AppState {
    root: Mutex<Option<PathBuf>>,
}

impl AppState {
    fn from_environment() -> Self {
        let root = std::env::var_os("LATTICE_PROJECT")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .and_then(|path| path.canonicalize().ok());
        Self {
            root: Mutex::new(root),
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
) -> Result<ProjectSnapshot, String> {
    let root = project::create(Path::new(&parent), &name)?;
    let snapshot = project::open(&root)?;
    set_root(&state, root)?;
    Ok(snapshot)
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
fn import_project_assets(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    target_directory: String,
) -> Result<Vec<String>, String> {
    project::import_assets(&current_root(&state)?, &paths, &target_directory)
}

#[tauri::command]
async fn build_project(state: tauri::State<'_, AppState>) -> Result<BuildResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || latex::build(&root))
        .await
        .map_err(|error| format!("The LaTeX build task stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn save_compiled_pdf(path: String, pdf_base64: String) -> Result<String, String> {
    latex::save_pdf(Path::new(&path), &pdf_base64)
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
fn delete_paper(state: tauri::State<'_, AppState>, arxiv_id: String) -> Result<(), String> {
    papers::delete_paper(&current_root(&state)?, &arxiv_id)
}

#[tauri::command]
async fn run_agent(
    state: tauri::State<'_, AppState>,
    on_event: tauri::ipc::Channel<AgentStreamEvent>,
    settings: AgentSettings,
    message: String,
    active_file: Option<String>,
    selection: Option<String>,
    conversation: Vec<AgentMessage>,
) -> Result<AgentResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        agents::run(
            &root,
            &settings,
            &message,
            active_file.as_deref(),
            selection.as_deref(),
            &conversation,
            &|event| {
                let _ = on_event.send(event);
            },
        )
    })
    .await
    .map_err(|error| format!("The writing agent task stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn provider_status() -> Vec<(String, bool)> {
    agents::provider_status()
}

#[tauri::command]
async fn subscription_status() -> Result<Vec<SubscriptionStatus>, String> {
    tauri::async_runtime::spawn_blocking(agents::subscription_status)
        .await
        .map_err(|error| format!("Could not check subscription status: {error}"))
}

#[tauri::command]
fn begin_subscription_login(provider: String) -> Result<(), String> {
    agents::begin_subscription_login(&provider)
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
fn revert_transaction(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<String, String> {
    let record = project::revert(&current_root(&state)?, &transaction_id)?;
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
fn delete_agent_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    sessions::delete(&current_root(&state)?, &session_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::from_environment())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            create_project,
            initial_project,
            open_project,
            refresh_project,
            read_project_file,
            write_project_file,
            list_citation_keys,
            create_project_entry,
            delete_project_entry,
            import_project_assets,
            build_project,
            save_compiled_pdf,
            import_arxiv,
            list_papers,
            read_paper,
            delete_paper,
            run_agent,
            provider_status,
            subscription_status,
            begin_subscription_login,
            save_api_key,
            delete_api_key,
            api_key_status,
            list_history,
            revert_transaction,
            delete_history_entry,
            create_agent_session,
            list_agent_sessions,
            read_agent_session,
            save_agent_session,
            delete_agent_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
