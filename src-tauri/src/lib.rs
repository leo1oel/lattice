mod agents;
mod commands;
mod latex;
mod models;
mod papers;
mod project;
mod sessions;
mod skill_store;

use models::{
    AgentResult, AgentRunRequest, AgentSession, AgentSessionSearchResult, AgentSessionSummary,
    AgentSkill, AgentSkillSaveRequest, AgentStreamEvent, AssetPreview, BuildResult, HistoryItem,
    ImportResult, PaperSummary, ProjectSnapshot, SubscriptionStatus, SyncTexTarget,
};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

struct AppState {
    root: Mutex<Option<PathBuf>>,
    agent_runtime: agents::AgentRuntime,
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
fn read_project_asset(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<AssetPreview, String> {
    project::read_asset(&current_root(&state)?, &path)
}

#[tauri::command]
fn prepare_latex_figure(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    project::prepare_latex_figure(&current_root(&state)?, &path)
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
fn synctex_edit(
    state: tauri::State<'_, AppState>,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SyncTexTarget, String> {
    latex::inverse_search(&current_root(&state)?, page, x, y)
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
fn rename_paper(
    state: tauri::State<'_, AppState>,
    arxiv_id: String,
    title: String,
) -> Result<PaperSummary, String> {
    papers::rename_paper(&current_root(&state)?, &arxiv_id, &title)
}

#[tauri::command]
fn delete_paper(state: tauri::State<'_, AppState>, arxiv_id: String) -> Result<(), String> {
    papers::delete_paper(&current_root(&state)?, &arxiv_id)
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
    project::save_conversation_checkpoint(
        &current_root(&state)?,
        &session_id,
        &message_id,
    )
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config = app
                .path()
                .app_config_dir()
                .map_err(|error| error.to_string())?
                .join("pi");
            let (executable, assets) = agent_runtime_paths(app)?;
            app.manage(AppState::from_environment(agents::AgentRuntime {
                executable,
                assets,
                config,
            }));
            Ok(())
        })
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
            rename_project_entry,
            import_project_assets,
            read_project_asset,
            prepare_latex_figure,
            build_project,
            save_compiled_pdf,
            synctex_edit,
            import_arxiv,
            list_papers,
            read_paper,
            rename_paper,
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
            return Err("This development target is not configured for the Pi sidecar.".into());
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
            manifest.join("pi-assets"),
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
    Ok((executable, app.path().resource_dir()?.join("pi-assets")))
}
