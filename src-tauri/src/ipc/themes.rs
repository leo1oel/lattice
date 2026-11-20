//! Settings › Appearance › Theme, over lattice-core's theme store and the
//! shared resolver (`src-tauri/lattice-theme`, `docs/themes.md`).
//!
//! The page asks for a theme resolved (`themes_resolve`) and sets the CSS
//! variables it gets back on `<html>`; the colour fitting happens here, in
//! the same code the GPUI app runs, so the two apps cannot fit a colour
//! differently. Installing or removing a theme writes files, so only a
//! workspace window's own page may (the plugin commands' caller check), and
//! every window hears `themes-changed` afterwards.

use std::path::PathBuf;

use lattice_core::registry::{Listing, Registry, Status};
use lattice_core::themes::format::{AccentChoice, Appearance, Color};
use lattice_core::themes::{ThemeInfo, ThemeStore};
use serde::{Deserialize, Serialize};
use tauri::ipc::Request;
use tauri::{AppHandle, Emitter, Runtime, State, Webview};

use super::{run_blocking, terminal::caller_window};

const CHANGED_EVENT: &str = "themes-changed";
const REFUSED: &str = "Themes can only be installed from a Lattice window.";

pub(crate) struct Themes {
    store: std::sync::Arc<ThemeStore>,
    registry: std::sync::Arc<Registry>,
}

impl Themes {
    pub(crate) fn new(resources: &lattice_core::host::Resources) -> Self {
        Self {
            store: std::sync::Arc::new(ThemeStore::new(&resources.app_data_dir)),
            registry: std::sync::Arc::new(Registry::new(&resources.app_data_dir)),
        }
    }
}

#[tauri::command]
pub async fn themes_list(themes: State<'_, Themes>) -> Result<Vec<ThemeInfo>, String> {
    let store = themes.store.clone();
    let registry = themes.registry.clone();
    run_blocking("Theme list", move || Ok(registry.list_themes(&store))).await
}

#[tauri::command]
pub async fn themes_install_file<R: Runtime>(
    themes: State<'_, Themes>, app: AppHandle<R>, webview: Webview<R>, request: Request<'_>,
    path: PathBuf,
) -> Result<ThemeInfo, String> {
    caller_window(&webview, &request).map_err(|_| REFUSED.to_string())?;
    let store = themes.store.clone();
    let info = run_blocking("Theme install", move || store.install_file(&path)).await?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(info)
}

#[tauri::command]
pub async fn themes_remove<R: Runtime>(
    themes: State<'_, Themes>, app: AppHandle<R>, webview: Webview<R>, request: Request<'_>,
    id: String,
) -> Result<(), String> {
    caller_window(&webview, &request).map_err(|_| REFUSED.to_string())?;
    let store = themes.store.clone();
    run_blocking("Theme remove", move || store.remove(&id)).await?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

/// The theme marketplace's signed list (`lattice_core::registry`): the cached
/// one, or fetched and verified first when `refresh`, with the update and
/// block state of the themes installed from it.
#[tauri::command]
pub async fn registry_index<R: Runtime>(
    themes: State<'_, Themes>, app: AppHandle<R>, refresh: bool,
) -> Result<Listing, String> {
    let (store, registry) = (themes.store.clone(), themes.registry.clone());
    let listing =
        run_blocking("Theme registry", move || Ok(registry.listing(&store, refresh))).await?;
    // A new block list can turn the chosen theme off (or back on): every
    // window lists and resolves again.
    if listing.status == Status::Fresh {
        let _ = app.emit(CHANGED_EVENT, ());
    }
    Ok(listing)
}

/// Installs or updates a theme from the cached list, by id.
#[tauri::command]
pub async fn registry_install_theme<R: Runtime>(
    themes: State<'_, Themes>, app: AppHandle<R>, webview: Webview<R>, request: Request<'_>,
    id: String,
) -> Result<ThemeInfo, String> {
    caller_window(&webview, &request).map_err(|_| REFUSED.to_string())?;
    let (store, registry) = (themes.store.clone(), themes.registry.clone());
    let info = run_blocking("Theme install", move || registry.install_theme(&store, &id)).await?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(info)
}

/// Shows the installed themes' folder in Finder, creating it first.
#[tauri::command]
pub async fn themes_reveal_folder<R: Runtime>(
    themes: State<'_, Themes>, app: AppHandle<R>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    crate::browser_host::require_desktop()?;
    let store = themes.store.clone();
    let folder = run_blocking("Themes folder", move || store.folder()).await?;
    app.opener()
        .reveal_item_in_dir(&folder)
        .map_err(|error| format!("Could not show the themes folder in Finder: {error}"))
}

/// The writer's accent as the page stores it: a preset's name (with its
/// colour in this appearance, which the page reads from its own CSS), a
/// custom `#rrggbb`, or `theme`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    theme: Option<String>,
    appearance: Appearance,
    accent: String,
    /// A preset's colour in this appearance.
    preset_color: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTheme {
    /// The theme in effect, or `None`.
    theme: Option<String>,
    /// `[name, value]` pairs to set on `<html>`.
    variables: Vec<(String, String)>,
    /// The accent in use when it is not the stylesheet's own.
    accent: Option<String>,
}

fn rgb(hex: &str) -> Option<u32> {
    Color::parse(hex).filter(|color| color.is_opaque()).map(|color| color.rgb)
}

fn choice(request: &ResolveRequest) -> AccentChoice {
    if request.accent == "theme" {
        return AccentChoice::ThemeDefault;
    }
    if let Some(custom) = rgb(&request.accent) {
        return AccentChoice::Custom(custom);
    }
    match request.preset_color.as_deref().and_then(rgb) {
        Some(preset) => AccentChoice::Preset(preset),
        None => AccentChoice::ThemeDefault,
    }
}

#[tauri::command]
pub async fn themes_resolve(
    themes: State<'_, Themes>, request: ResolveRequest,
) -> Result<ResolvedTheme, String> {
    let (store, registry) = (themes.store.clone(), themes.registry.clone());
    run_blocking("Theme resolve", move || {
        let accent = choice(&request);
        let id = request.theme.as_deref().filter(|id| !id.is_empty());
        let resolved = registry.resolve(&store, id, request.appearance, accent);
        Ok(ResolvedTheme {
            accent: resolved.accent.map(|color| color.hex()),
            variables: resolved.css_variables(),
            theme: resolved.theme,
        })
    })
    .await
}

/// A custom accent as the theme uses it without a theme, and its contrast:
/// what Settings shows beside the picker.
#[derive(Serialize)]
pub struct FittedAccent {
    color: String,
    ratio: f64,
}

#[tauri::command]
pub fn themes_fit_accent(color: String, appearance: Appearance) -> Result<FittedAccent, String> {
    let picked = rgb(&color).ok_or_else(|| format!("{color} is not a colour"))?;
    let fitted = lattice_core::themes::format::color::fit_accent(picked, appearance);
    Ok(FittedAccent {
        color: Color::opaque(fitted).hex(),
        ratio: lattice_core::themes::format::color::accent_contrast(fitted, appearance),
    })
}
