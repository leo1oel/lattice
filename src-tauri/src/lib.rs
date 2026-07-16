mod agents;
mod commands;
mod latex;
mod models;
mod papers;
mod project;

use models::{AgentResult, BuildResult, HistoryItem, ImportResult, ProjectSnapshot};
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
fn build_project(state: tauri::State<'_, AppState>) -> Result<BuildResult, String> {
    latex::build(&current_root(&state)?)
}

#[tauri::command]
fn import_arxiv(state: tauri::State<'_, AppState>, input: String) -> Result<ImportResult, String> {
    papers::import_arxiv(&current_root(&state)?, &input)
}

#[tauri::command]
fn list_papers(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    papers::list_papers(&current_root(&state)?)
}

#[tauri::command]
fn read_paper(state: tauri::State<'_, AppState>, arxiv_id: String) -> Result<String, String> {
    papers::read_paper(&current_root(&state)?, &arxiv_id)
}

#[tauri::command]
fn run_agent(
    state: tauri::State<'_, AppState>,
    provider: String,
    message: String,
    active_file: Option<String>,
    selection: Option<String>,
) -> Result<AgentResult, String> {
    agents::run(
        &current_root(&state)?,
        &provider,
        &message,
        active_file.as_deref(),
        selection.as_deref(),
    )
}

#[tauri::command]
fn provider_status() -> Vec<(String, bool)> {
    agents::provider_status()
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
            build_project,
            import_arxiv,
            list_papers,
            read_paper,
            run_agent,
            provider_status,
            save_api_key,
            delete_api_key,
            api_key_status,
            list_history,
            revert_transaction,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
