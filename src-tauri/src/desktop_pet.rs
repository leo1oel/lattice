//! An optional companion window. Imported art is copied into app data; a pet
//! never reads projects, runs a script, or talks to a provider.
mod package;
#[cfg(test)]
mod tests;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, PoisonError},
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "desktop-pet";
const CHANGED: &str = "desktop-pet-changed";

#[derive(Clone, Default, Deserialize, Serialize)]
struct Config {
    enabled: bool,
    pet: Option<package::Pet>,
    #[serde(default)]
    locale: String,
}

pub struct DesktopPet {
    config: Mutex<Config>,
    path: PathBuf,
}

impl DesktopPet {
    pub fn load(app: &tauri::AppHandle) -> Result<Self, String> {
        let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("desktop-pet.json");
        let config = package::read_limited(&path, package::MAX_IMAGE * 2)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Ok(Self { config: Mutex::new(config), path })
    }

    fn get(&self) -> Config {
        self.config.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn save(&self, config: Config) -> Result<(), String> {
        let mut current = self.config.lock().unwrap_or_else(PoisonError::into_inner);
        fs::create_dir_all(self.path.parent().ok_or("Pet settings have no folder")?)
            .map_err(|e| e.to_string())?;
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec(&config).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        fs::rename(&temp, &self.path).map_err(|e| e.to_string())?;
        *current = config;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    enabled: bool,
    name: Option<String>,
    version: Option<u8>,
    activity: &'static str,
}

fn activity(builds: usize, turns: usize) -> &'static str {
    if builds > 0 {
        "building"
    } else if turns > 0 {
        "working"
    } else {
        "idle"
    }
}

#[tauri::command]
pub fn desktop_pet_status(
    pet: State<'_, DesktopPet>, app: State<'_, crate::app_state::AppState>,
    restart: State<'_, crate::app_restart::AppRestart>,
) -> Snapshot {
    let config = pet.config.lock().unwrap_or_else(PoisonError::into_inner);
    Snapshot {
        enabled: config.enabled,
        name: config.pet.as_ref().map(|pet| pet.name.clone()),
        version: config.pet.as_ref().map(|pet| pet.version),
        activity: activity(app.running_builds(), restart.agent_turns()),
    }
}

#[tauri::command]
pub fn desktop_pet_asset(
    pet: State<'_, DesktopPet>, window: WebviewWindow,
) -> Result<String, String> {
    if window.label() != LABEL {
        return Err("Pet artwork is available only to its companion window".into());
    }
    let imported = pet.get().pet.ok_or("Import a pet package first")?;
    // Older/corrupt settings do not get to introduce an active image format.
    if !["image/png", "image/webp"].contains(&imported.mime.as_str())
        || STANDARD.decode(&imported.image).is_err()
    {
        return Err("The saved pet artwork is invalid; import its package again".into());
    }
    Ok(format!("data:{};base64,{}", imported.mime, imported.image))
}

fn workspace(window: &WebviewWindow) -> Result<(), String> {
    if crate::is_workspace_window(window.label()) {
        Ok(())
    } else {
        Err("Open a desktop workspace to import a pet".into())
    }
}

#[tauri::command]
pub fn desktop_pet_import(
    app: tauri::AppHandle, window: WebviewWindow, pet: State<'_, DesktopPet>, path: String,
) -> Result<(), String> {
    workspace(&window)?;
    let imported = package::import(std::path::Path::new(&path))?;
    let previous = pet.get();
    pet.save(Config { enabled: previous.enabled, pet: Some(imported), locale: previous.locale })?;
    // A newly imported package must replace the old texture even when names match.
    if let Some(window) = app.get_webview_window(LABEL) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    restore(&app)?;
    let _ = app.emit(CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn desktop_pet_set_enabled(
    app: tauri::AppHandle, window: WebviewWindow, pet: State<'_, DesktopPet>, enabled: bool,
    locale: Option<String>,
) -> Result<(), String> {
    if window.label() != LABEL {
        workspace(&window)?;
    }
    let previous = pet.get();
    let mut config = previous.clone();
    if let Some(locale) = locale {
        config.locale = if locale == "zh-CN" { "zh-CN" } else { "en" }.into();
    }
    if enabled && config.pet.is_none() {
        return Err("Import a pet package first".into());
    }
    if enabled {
        // Save only after successful construction, so a failed window never
        // leaves a checked switch claiming the companion is visible.
        show(&app, &config.locale)?;
    } else if let Some(window) = app.get_webview_window(LABEL) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    config.enabled = enabled;
    if let Err(reason) = pet.save(config) {
        // A filesystem failure must leave both the saved switch and visible
        // window as they were before this request.
        if previous.enabled {
            let _ = show(&app, &previous.locale);
        } else if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.destroy();
        }
        return Err(reason);
    }
    let _ = app.emit(CHANGED, ());
    Ok(())
}

pub fn restore(app: &tauri::AppHandle) -> Result<(), String> {
    let config = app.state::<DesktopPet>().get();
    if config.enabled && config.pet.is_some() {
        show(app, &config.locale)?;
    }
    Ok(())
}

fn show(app: &tauri::AppHandle, locale: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return window.show().map_err(|e| e.to_string());
    }
    let window = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App(
            format!("pet.html?locale={}", if locale == "zh-CN" { "zh-CN" } else { "en" }).into(),
        ),
    )
    .title("Lattice companion")
    .inner_size(160.0, 196.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .on_navigation(|url| {
        url.scheme() == "tauri"
            || url.host_str() == Some("tauri.localhost")
            || (cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
    })
    .build()
    .map_err(|e| e.to_string())?;
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let origin = monitor.position();
        let scale = monitor.scale_factor();
        let _ = window.set_position(tauri::PhysicalPosition::new(
            origin.x + size.width as i32 - (180.0 * scale) as i32,
            origin.y + size.height as i32 - (240.0 * scale) as i32,
        ));
    }
    Ok(())
}
