//! The built-in agent: the Synara sidecar's supervisor (`synara`) and the
//! custom model endpoint it may use (`model_endpoint`).

use crate::model_endpoint::{self, Endpoint, EndpointStatus, KeyUpdate, ProbeReport};
use crate::synara::{EnvironmentReport, SynaraRuntime, SynaraRuntimeInfo};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Start the agent service for the window's project, `workspace_root`, when
/// it has one open: the bibliography guard has to cover that folder too.
#[tauri::command]
pub async fn synara_ensure_ready(
    app: AppHandle, workspace_root: Option<String>,
) -> Result<SynaraRuntimeInfo, String> {
    // Process launch, sandbox verification and health polling can take seconds.
    // A synchronous command occupies the native event loop before the WebView
    // can paint the loading surface that requested it.
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<SynaraRuntime>();
        match workspace_root.filter(|root| !root.is_empty()) {
            Some(root) => runtime.ensure_ready_for(std::path::Path::new(&root)),
            None => runtime.ensure_ready(),
        }
    })
    .await
    .map_err(|error| format!("Agent startup worker failed: {error}"))?
}

#[tauri::command]
pub fn synara_open_skills_folder(app: AppHandle) -> Result<(), String> {
    let skills_dir =
        app.path().app_data_dir().map_err(|error| error.to_string())?.join("synara").join("skills");
    std::fs::create_dir_all(&skills_dir).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(skills_dir.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| error.to_string())
}

/// Reveal the sidecar logs a startup failure quotes from. Nothing is created:
/// a runtime that failed before writing any has no folder to show, which is
/// `Ok(false)` so the surface can tell it apart from a failed open.
#[tauri::command]
pub fn synara_open_log_folder(
    app: AppHandle, state: State<'_, SynaraRuntime>,
) -> Result<bool, String> {
    let log_dir = state.sidecar_log_dir();
    if !log_dir.is_dir() {
        return Ok(false);
    }
    app.opener()
        .open_path(log_dir.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// [`SynaraRuntime::agent_environment`], off the main thread.
#[tauri::command]
pub async fn synara_agent_environment(app: AppHandle) -> Result<EnvironmentReport, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<SynaraRuntime>().agent_environment())
        .await
        .map_err(|error| format!("Agent environment worker failed: {error}"))
}

/// [`SynaraRuntime::restart`], off the main thread.
#[tauri::command]
pub async fn synara_restart(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<SynaraRuntime>().restart())
        .await
        .map_err(|error| format!("Agent restart worker failed: {error}"))
}

/// The agent's home, where its `models.json` lives.
fn agent_home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("synara"))
}

#[tauri::command]
pub async fn get_model_endpoint(app: AppHandle) -> Result<EndpointStatus, String> {
    model_endpoint::get_model_endpoint(agent_home(&app)?).await
}

#[tauri::command]
pub async fn save_model_endpoint(
    app: AppHandle, endpoint: Endpoint, key: KeyUpdate,
) -> Result<EndpointStatus, String> {
    model_endpoint::save_model_endpoint(agent_home(&app)?, endpoint, key).await
}

#[tauri::command]
pub async fn remove_model_endpoint(app: AppHandle) -> Result<EndpointStatus, String> {
    model_endpoint::remove_model_endpoint(agent_home(&app)?).await
}

#[tauri::command]
pub async fn test_model_endpoint(
    endpoint: Endpoint, key: Option<String>,
) -> Result<ProbeReport, String> {
    model_endpoint::test_model_endpoint(endpoint, key).await
}
