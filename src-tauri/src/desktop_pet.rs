//! An optional companion window. Imported art is copied into app data; a pet
//! never reads projects, runs a script, or talks to a provider.
mod launch;
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
    launches: Mutex<launch::Launches>,
}

impl DesktopPet {
    pub fn load(app: &tauri::AppHandle) -> Result<Self, String> {
        let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("desktop-pet.json");
        let config = package::read_limited(&path, package::MAX_IMAGE * 2)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Ok(Self { config: Mutex::new(config), path, launches: Mutex::default() })
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
    error: Option<String>,
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
    let (enabled, name, version) = {
        let config = pet.config.lock().unwrap_or_else(PoisonError::into_inner);
        (
            config.enabled,
            config.pet.as_ref().map(|pet| pet.name.clone()),
            config.pet.as_ref().map(|pet| pet.version),
        )
    };
    let error = pet.launches.lock().unwrap_or_else(PoisonError::into_inner).error.clone();
    Snapshot {
        enabled,
        name,
        version,
        activity: activity(app.running_builds(), restart.agent_turns()),
        error,
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
pub async fn desktop_pet_import(
    app: tauri::AppHandle, window: WebviewWindow, path: String,
) -> Result<(), String> {
    workspace(&window)?;
    let imported =
        tauri::async_runtime::spawn_blocking(move || package::import(std::path::Path::new(&path)))
            .await
            .map_err(|error| error.to_string())??;
    let pet = app.state::<DesktopPet>();
    {
        let mut launches = pet.launches.lock().unwrap_or_else(PoisonError::into_inner);
        let previous = pet.get();
        pet.save(Config {
            enabled: previous.enabled,
            pet: Some(imported),
            locale: previous.locale,
        })?;
        launches.cancel();
        if let Some(window) = app.get_webview_window(LABEL) {
            window.destroy().map_err(|e| e.to_string())?;
        }
    }
    restore(&app)?;
    let _ = app.emit(CHANGED, ());
    Ok(())
}

#[tauri::command]
pub async fn desktop_pet_set_enabled(
    app: tauri::AppHandle, window: WebviewWindow, enabled: bool, locale: Option<String>,
) -> Result<(), String> {
    if window.label() != LABEL {
        workspace(&window)?;
    }
    let pet = app.state::<DesktopPet>();
    if !enabled {
        let mut launches = pet.launches.lock().unwrap_or_else(PoisonError::into_inner);
        let mut config = pet.get();
        // Persist first: a disk failure leaves the existing pet untouched.
        config.enabled = false;
        pet.save(config)?;
        launches.cancel();
        if let Some(window) = app.get_webview_window(LABEL) {
            window.destroy().map_err(|e| e.to_string())?;
        }
        let _ = app.emit(CHANGED, ());
        return Ok(());
    }
    let locale = if locale.as_deref() == Some("zh-CN") { "zh-CN" } else { "en" };
    let mut ticket = prepare(&app, locale)?;
    ticket.wait().await?;
    {
        let mut launches = pet.launches.lock().unwrap_or_else(PoisonError::into_inner);
        if !launches.owns(&ticket.generation) {
            return Err(launch::CANCELLED.into());
        }
        let mut config = pet.get();
        config.enabled = true;
        config.locale = locale.into();
        if let Err(reason) = pet.save(config) {
            launches.abandon(&ticket.generation, &reason, true);
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.destroy();
            }
            return Err(reason);
        }
    }
    let _ = app.emit(CHANGED, ());
    Ok(())
}

/// The native window stays hidden until its actual page decoded the artwork
/// and prepared a frame. Only that window's current generation may reveal it.
#[tauri::command]
pub async fn desktop_pet_ready(
    window: WebviewWindow, pet: State<'_, DesktopPet>, generation: String, failed: bool,
) -> Result<(), String> {
    if window.label() != LABEL {
        return Err(launch::CANCELLED.into());
    }
    if failed {
        let launches = pet.launches.lock().unwrap_or_else(PoisonError::into_inner);
        if !launches.owns(&generation) {
            return Err(launch::CANCELLED.into());
        }
        drop(launches);
        failed_load(window.app_handle(), &generation, launch::ARTWORK_FAILED);
        return Err(launch::ARTWORK_FAILED.into());
    }
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        let (done, ready) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |platform| {
                let pet = app.state::<DesktopPet>();
                let mut launches = pet.launches.lock().unwrap_or_else(PoisonError::into_inner);
                if !launches.owns(&generation) {
                    let _ = done.send(Err(launch::CANCELLED.into()));
                    return;
                }
                // Tauri's show() calls makeKeyAndOrderFront on macOS. Ordering an
                // already prepared companion forward keeps the editor's key window.
                // SAFETY: with_webview supplies its live NSWindow on the main thread.
                let result = unsafe {
                    match platform.ns_window().cast::<objc2_app_kit::NSWindow>().as_ref() {
                        Some(native) => {
                            // Borderless windows are absent from Window by
                            // default. Provide an explicit keyboard route,
                            // without selecting the pet when it first appears.
                            native.setExcludedFromWindowsMenu(false);
                            if let Some(main) = objc2::MainThreadMarker::new() {
                                objc2_app_kit::NSApplication::sharedApplication(main)
                                    .addWindowsItem_title_filename(native, &native.title(), false);
                            }
                            native.orderFrontRegardless();
                            Ok(())
                        }
                        None => Err(launch::CANCELLED.into()),
                    }
                };
                if launches.loading(&generation) {
                    launches.finish(&generation, result.clone());
                }
                let _ = done.send(result);
            })
            .map_err(|error| error.to_string())?;
        ready.await.map_err(|_| launch::CANCELLED.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut launches = pet.launches.lock().unwrap_or_else(PoisonError::into_inner);
        if !launches.owns(&generation) {
            return Err(launch::CANCELLED.into());
        }
        let result = window.show().map_err(|error| error.to_string());
        if launches.loading(&generation) {
            launches.finish(&generation, result.clone());
        }
        result
    }
}

pub fn restore(app: &tauri::AppHandle) -> Result<(), String> {
    let config = app.state::<DesktopPet>().get();
    if config.enabled && config.pet.is_some() {
        if let Err(reason) = prepare(app, &config.locale) {
            let mut config = config;
            config.enabled = false;
            app.state::<DesktopPet>().save(config)?;
            let _ = app.emit(CHANGED, ());
            return Err(reason);
        }
    }
    Ok(())
}

/// The companion owns its fixed chrome and readiness; the generic plugin's
/// restore path would show and focus it before its page is ready.
pub fn window_state_tracks(label: &str) -> bool {
    label != LABEL
}

/// A floating companion must not prevent a Dock/Finder reopen after the last
/// workspace closes. Other visible windows keep the existing Cocoa behavior.
pub fn reopen_needed<'a>(
    has_visible_windows: bool, windows: impl IntoIterator<Item = (&'a str, bool)>,
) -> bool {
    !has_visible_windows || !windows.into_iter().any(|(label, visible)| visible && label != LABEL)
}

fn prepare(app: &tauri::AppHandle, locale: &str) -> Result<launch::Ticket, String> {
    let pet = app.state::<DesktopPet>();
    let mut launches = pet.launches.lock().unwrap_or_else(PoisonError::into_inner);
    if pet.get().pet.is_none() {
        return Err("Import a pet package first".into());
    }
    if let Some(ticket) = launches.current() {
        if app.get_webview_window(LABEL).is_some() {
            return Ok(ticket);
        }
        launches.cancel();
    }
    // A cancelled window can still be completing native destruction. Never
    // reuse its generation or build another window with its label yet.
    if app.get_webview_window(LABEL).is_some() {
        return Err(launch::CANCELLED.into());
    }
    let ticket = launches.begin();
    let generation = ticket.generation.clone();
    let script = format!(
        "window.__LATTICE_PET_GENERATION__ = {};",
        serde_json::to_string(&generation).map_err(|error| error.to_string())?
    );
    let result = WebviewWindowBuilder::new(
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
    .visible(false)
    .initialization_script(script)
    .on_navigation(|url| {
        url.scheme() == "tauri"
            || url.host_str() == Some("tauri.localhost")
            || (cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
    })
    .build();
    let window = match result {
        Ok(window) => window,
        Err(error) => {
            let reason = error.to_string();
            launches.abandon(&generation, &reason, true);
            return Err(reason);
        }
    };
    let closed_app = app.clone();
    let closed_generation = generation.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let handle = closed_app.clone();
            let generation = closed_generation.clone();
            tauri::async_runtime::spawn(async move {
                retire(&handle, &generation, launch::CANCELLED, false);
            });
        }
    });
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let origin = monitor.position();
        let scale = monitor.scale_factor();
        let _ = window.set_position(tauri::PhysicalPosition::new(
            origin.x + size.width as i32 - (180.0 * scale) as i32,
            origin.y + size.height as i32 - (240.0 * scale) as i32,
        ));
    }
    drop(launches);
    let mut observed = ticket.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), observed.wait())
            .await
            .unwrap_or_else(|_| Err(launch::TIMED_OUT.into()));
        if let Err(reason) = outcome {
            failed_load(&handle, &generation, &reason);
        }
    });
    Ok(ticket)
}

fn failed_load(app: &tauri::AppHandle, generation: &str, reason: &str) {
    retire(app, generation, reason, true);
}

fn retire(app: &tauri::AppHandle, generation: &str, reason: &str, remember: bool) {
    let pet = app.state::<DesktopPet>();
    let mut launches = pet.launches.lock().unwrap_or_else(PoisonError::into_inner);
    if !launches.abandon(generation, reason, remember) {
        return;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
    let mut config = pet.get();
    config.enabled = false;
    if let Err(error) = pet.save(config) {
        log::warn!(target: "lattice::pet", "could not save companion load failure: {error}");
    }
    if remember {
        log::warn!(target: "lattice::pet", "companion load failed: {reason}");
    }
    let _ = app.emit(CHANGED, ());
}
