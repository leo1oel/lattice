//! Plugin commands accept only Lattice's local workspace page, as the terminal
//! does. Plugins can execute arbitrary code as the user; never expose these
//! operations to the browser relay or embedded remote content.
use super::{run_blocking, terminal::caller_window};
use crate::app_state::AppState;
use crate::plugins::{self, Plugin};
use std::path::PathBuf;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, State, Webview};

fn store(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(crate::util::err)?.join("plugins"))
}

#[tauri::command]
pub async fn list_plugins(
    app: AppHandle, webview: Webview, request: Request<'_>,
) -> Result<Vec<Plugin>, String> {
    caller_window(&webview, &request)?;
    let store = store(&app)?;
    run_blocking("Plugin list", move || plugins::list(&store)).await
}

#[tauri::command]
pub async fn install_plugin(
    app: AppHandle, webview: Webview, request: Request<'_>, path: String,
) -> Result<Vec<Plugin>, String> {
    caller_window(&webview, &request)?;
    let store = store(&app)?;
    run_blocking("Plugin install", move || plugins::install(&store, &PathBuf::from(path))).await
}

#[tauri::command]
pub async fn set_plugin_enabled(
    app: AppHandle, webview: Webview, request: Request<'_>, id: String, enabled: bool,
) -> Result<Vec<Plugin>, String> {
    caller_window(&webview, &request)?;
    let store = store(&app)?;
    run_blocking("Plugin enable", move || plugins::set_enabled(&store, &id, enabled)).await
}

#[tauri::command]
pub async fn remove_plugin(
    app: AppHandle, webview: Webview, request: Request<'_>, id: String,
) -> Result<Vec<Plugin>, String> {
    caller_window(&webview, &request)?;
    let store = store(&app)?;
    run_blocking("Plugin removal", move || plugins::remove(&store, &id)).await
}

#[tauri::command]
pub async fn run_plugin_command(
    app: AppHandle, state: State<'_, AppState>, webview: Webview, request: Request<'_>, id: String,
    command: String,
) -> Result<plugins::runner::ResultOutput, String> {
    let window = caller_window(&webview, &request)?;
    let project = state.root_for(window.label())?;
    let store = store(&app)?;
    run_blocking("Plugin command", move || plugins::run(&store, &id, &command, project.as_deref()))
        .await
}
