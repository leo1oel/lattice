//! Google credentials stay in the native host, never the rendered settings page.
use crate::google_workspace::{self, GoogleState, GoogleStatus, OAuthClient, WorkspaceRequest};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn google_workspace_status(
    app: AppHandle, state: State<'_, GoogleState>,
) -> Result<GoogleStatus, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate Google account storage.".to_string())?;
    google_workspace::status(&dir, &state)
}
#[tauri::command]
pub async fn google_workspace_begin(
    app: AppHandle, state: State<'_, GoogleState>, client: OAuthClient,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate Google account storage.".to_string())?;
    let url = google_workspace::begin_login(&dir, &state, client)?;
    if app.opener().open_url(url, None::<&str>).is_err() {
        google_workspace::cancel_login(&state)?;
        return Err("Could not open the default browser for Google sign-in.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn google_workspace_cancel(state: State<'_, GoogleState>) -> Result<(), String> {
    google_workspace::cancel_login(&state)
}
#[tauri::command]
pub async fn google_workspace_disconnect(
    app: AppHandle, state: State<'_, GoogleState>,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate Google account storage.".to_string())?;
    let state = state.inner().clone();
    super::run_quietly("Disconnect Google Workspace", move || {
        google_workspace::disconnect(&dir, &state)
    })
    .await
}
#[tauri::command]
pub async fn google_workspace_request(
    app: AppHandle, state: State<'_, GoogleState>, request: WorkspaceRequest,
) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate Google account storage.".to_string())?;
    let state = state.inner().clone();
    super::run_quietly("Google Workspace", move || google_workspace::request(&dir, &state, request))
        .await
}
