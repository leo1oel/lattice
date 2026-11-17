//! Settings › Plugins and the palette's plugin commands, over lattice-core's
//! plugin host (one per app process, built from the app's `Resources`).
//!
//! A plugin runs code and holds secrets, so every command here first checks
//! its caller as the terminal does (ipc/terminal/caller.rs): a workspace
//! window's own page on Lattice's frontend. A browser-host tab, an embedded
//! frame or the Overleaf sign-in window never reaches a plugin.
//!
//! The page names each run (`run_id`) so Escape can cancel it, and a window
//! cancels only the runs it started. Installs, enables and removes emit
//! `plugins-changed` to every window, so open palettes and Settings refresh.

use super::{channel_sink, current_root, pinned_root, run_blocking, terminal::caller_window};
use crate::app_state::AppState;
use lattice_core::plugins::protocol::{Cursor, Selection, MAX_SELECTION_CHARS};
use lattice_core::plugins::{
    CancelToken, CommandResult, PluginCommand, PluginError, PluginHost, PluginInfo, ProjectInput,
    RunEvent, RunRequest, AVAILABLE,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, Request};
use tauri::{AppHandle, Emitter, Runtime, State, Webview, Window};

/// What every window hears after the installed plugins changed.
const CHANGED_EVENT: &str = "plugins-changed";
const REFUSED: &str = "Plugins are only available in a Lattice window.";

pub(crate) struct Plugins {
    host: Arc<PluginHost>,
    /// Runs under way: the page's run id → the window that started it.
    runs: Mutex<HashMap<String, (String, CancelToken)>>,
}

impl Plugins {
    pub(crate) fn new(resources: &lattice_core::host::Resources) -> Self {
        Self { host: Arc::new(PluginHost::new(resources)), runs: Mutex::default() }
    }
}

fn checked<R: Runtime>(webview: &Webview<R>, request: &Request<'_>) -> Result<Window<R>, String> {
    caller_window(webview, request).map_err(|_| REFUSED.to_string())
}

fn changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(CHANGED_EVENT, ());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginList {
    /// False where plugins cannot run (off macOS): listed, never run.
    available: bool,
    plugins: Vec<PluginInfo>,
}

#[tauri::command]
pub async fn plugins_list<R: Runtime>(
    plugins: State<'_, Plugins>, webview: Webview<R>, request: Request<'_>,
) -> Result<PluginList, String> {
    checked(&webview, &request)?;
    let host = plugins.host.clone();
    let plugins = run_blocking("Plugin list", move || host.list()).await?;
    Ok(PluginList { available: AVAILABLE, plugins })
}

/// The palette's rows: enabled, still-granted commands (none off macOS).
#[tauri::command]
pub async fn plugins_commands<R: Runtime>(
    plugins: State<'_, Plugins>, webview: Webview<R>, request: Request<'_>,
) -> Result<Vec<PluginCommand>, String> {
    checked(&webview, &request)?;
    let host = plugins.host.clone();
    run_blocking("Plugin commands", move || Ok(host.commands())).await
}

#[tauri::command]
pub async fn plugins_install_folder<R: Runtime>(
    app: AppHandle<R>, plugins: State<'_, Plugins>, webview: Webview<R>, request: Request<'_>,
    path: String,
) -> Result<PluginInfo, String> {
    checked(&webview, &request)?;
    let host = plugins.host.clone();
    let info =
        run_blocking("Plugin install", move || host.install_folder(Path::new(&path))).await?;
    changed(&app);
    Ok(info)
}

#[tauri::command]
pub async fn plugins_install_url<R: Runtime>(
    app: AppHandle<R>, plugins: State<'_, Plugins>, webview: Webview<R>, request: Request<'_>,
    url: String, sha256: String,
) -> Result<PluginInfo, String> {
    checked(&webview, &request)?;
    let host = plugins.host.clone();
    let info =
        run_blocking("Plugin install", move || host.install_url(url.trim(), sha256.trim())).await?;
    changed(&app);
    Ok(info)
}

/// Turning a plugin on grants what its manifest asks for now; the page shows
/// those permissions and asks first.
#[tauri::command]
pub async fn plugins_set_enabled<R: Runtime>(
    app: AppHandle<R>, plugins: State<'_, Plugins>, webview: Webview<R>, request: Request<'_>,
    id: String, enabled: bool,
) -> Result<PluginInfo, String> {
    checked(&webview, &request)?;
    let host = plugins.host.clone();
    let info = run_blocking("Plugin enable", move || host.set_enabled(&id, enabled)).await?;
    changed(&app);
    Ok(info)
}

#[tauri::command]
pub async fn plugins_remove<R: Runtime>(
    app: AppHandle<R>, plugins: State<'_, Plugins>, webview: Webview<R>, request: Request<'_>,
    id: String,
) -> Result<(), String> {
    checked(&webview, &request)?;
    let host = plugins.host.clone();
    run_blocking("Plugin remove", move || host.remove(&id)).await?;
    changed(&app);
    Ok(())
}

/// Save a secret (`value`), or forget it (`null` or empty).
#[tauri::command]
pub async fn plugins_set_secret<R: Runtime>(
    plugins: State<'_, Plugins>, webview: Webview<R>, request: Request<'_>, id: String,
    name: String, value: Option<String>,
) -> Result<PluginInfo, String> {
    checked(&webview, &request)?;
    let host = plugins.host.clone();
    run_blocking("Plugin secret", move || host.set_secret(&id, &name, value.as_deref())).await
}

/// What the page knows about where the writer is. Paths are
/// project-relative; the host drops anything else again.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageContext {
    #[serde(default)]
    main_document: Option<String>,
    #[serde(default)]
    active_file: Option<String>,
    #[serde(default)]
    selection: Option<Selection>,
    #[serde(default)]
    cursor: Option<Cursor>,
}

/// `path` relative to `root` with `/`, when it lies inside it: a page path
/// that is absolute is made relative, one outside the project is dropped,
/// so no absolute path reaches the plugin host.
fn project_relative(root: &Path, path: &str) -> Option<String> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Some(path.replace('\\', "/")).filter(|p| !p.is_empty());
    }
    let inside = candidate.strip_prefix(root).ok()?;
    let parts: Option<Vec<&str>> = inside.iter().map(|part| part.to_str()).collect();
    Some(parts?.join("/")).filter(|p| !p.is_empty())
}

/// The run's project: the window's root, named by its folder, with the
/// page's file, selection (at most 12,000 characters) and cursor.
fn project_input(root: PathBuf, page: PageContext) -> ProjectInput {
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let relative = |path: &str| project_relative(&root, path);
    let selection = page.selection.and_then(|mut selection| {
        selection.file = relative(&selection.file)?;
        selection.text = selection.text.chars().take(MAX_SELECTION_CHARS).collect();
        Some(selection).filter(|s| !s.text.is_empty())
    });
    let cursor = page.cursor.and_then(|mut cursor| {
        cursor.file = relative(&cursor.file)?;
        Some(cursor)
    });
    ProjectInput {
        name,
        main_document: page.main_document.as_deref().and_then(relative),
        active_file: page.active_file.as_deref().and_then(relative),
        selection,
        cursor,
        root,
    }
}

/// Run one command to its result, streaming progress and logs to
/// `on_event`. `project_root` pins the window's project: a run requested for
/// a project the window has since left is refused.
#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub async fn plugins_run<R: Runtime>(
    state: State<'_, AppState>, plugins: State<'_, Plugins>, webview: Webview<R>,
    request: Request<'_>, run_id: String, plugin_id: String, command_id: String,
    input: Option<String>, project_root: Option<String>, context: Option<PageContext>,
    locale: String, on_event: Channel<RunEvent>,
) -> Result<CommandResult, PluginError> {
    let refused = |message: String| PluginError::Launch { message };
    let window = checked(&webview, &request).map_err(refused)?;
    let project = match project_root {
        Some(root) => Some(
            pinned_root(&state, &window, &root, "the plugin could run")
                .map(|root| project_input(root, context.unwrap_or_default()))
                .map_err(refused)?,
        ),
        // The welcome screen: the plugin learns nothing about a project.
        None => current_root(&state, &window)
            .ok()
            .map(|root| project_input(root, PageContext::default())),
    };
    let cancel = CancelToken::new();
    let label = window.label().to_string();
    if let Ok(mut runs) = plugins.runs.lock() {
        runs.insert(run_id.clone(), (label, cancel.clone()));
    }
    let host = plugins.host.clone();
    let run = RunRequest { plugin_id, command_id, input, project, locale };
    let events = channel_sink(on_event);
    let outcome = tauri::async_runtime::spawn_blocking(move || host.run(run, &events, &cancel))
        .await
        .unwrap_or_else(|error| Err(PluginError::Crashed { stderr: error.to_string() }));
    if let Ok(mut runs) = plugins.runs.lock() {
        runs.remove(&run_id);
    }
    outcome
}

/// Stop run `run_id`, if this window started it and it is still going.
#[tauri::command(rename_all = "camelCase")]
pub async fn plugins_cancel<R: Runtime>(
    plugins: State<'_, Plugins>, webview: Webview<R>, request: Request<'_>, run_id: String,
) -> Result<(), String> {
    let window = checked(&webview, &request)?;
    let runs = plugins.runs.lock().map_err(|_| "The plugin runs are unavailable.".to_string())?;
    if let Some((label, cancel)) = runs.get(&run_id) {
        if label == window.label() {
            cancel.cancel();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{project_input, project_relative, PageContext};
    use lattice_core::plugins::protocol::{Cursor, Position, Selection, MAX_SELECTION_CHARS};
    use std::path::{Path, PathBuf};

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\papers\thesis")
        } else {
            PathBuf::from("/papers/thesis")
        }
    }

    fn inside(relative: &str) -> String {
        root().join(relative).to_string_lossy().into_owned()
    }

    #[test]
    fn page_paths_become_project_relative_and_outside_ones_are_dropped() {
        let root = root();
        assert_eq!(
            project_relative(&root, "chapters/intro.tex").as_deref(),
            Some("chapters/intro.tex")
        );
        assert_eq!(
            project_relative(&root, &inside("chapters/intro.tex")).as_deref(),
            Some("chapters/intro.tex")
        );
        let outside =
            if cfg!(windows) { r"C:\Users\me\secret.tex" } else { "/Users/me/secret.tex" };
        assert_eq!(project_relative(&root, outside), None);
        assert_eq!(project_relative(&root, &root.to_string_lossy()), None);
        assert_eq!(project_relative(&root, ""), None);
        if !cfg!(windows) {
            assert_eq!(project_relative(Path::new("/a"), "/ab/c.tex"), None);
        }
    }

    #[test]
    fn the_project_input_is_named_by_its_folder_and_bounds_the_selection() {
        let at = |line| Position { line, column: 1 };
        let page = PageContext {
            main_document: Some("main.tex".into()),
            active_file: Some(inside("refs.bib")),
            selection: Some(Selection {
                text: "x".repeat(MAX_SELECTION_CHARS + 50),
                file: "main.tex".into(),
                from: at(1),
                to: at(3),
            }),
            cursor: Some(Cursor {
                file: if cfg!(windows) {
                    r"D:\elsewhere.tex".into()
                } else {
                    "/elsewhere.tex".into()
                },
                position: at(2),
            }),
        };
        let input = project_input(root(), page);
        assert_eq!(input.name, "thesis");
        assert_eq!(input.root, root());
        assert_eq!(input.main_document.as_deref(), Some("main.tex"));
        assert_eq!(input.active_file.as_deref(), Some("refs.bib"));
        let selection = input.selection.expect("the selection is kept");
        assert_eq!(selection.text.chars().count(), MAX_SELECTION_CHARS);
        assert!(input.cursor.is_none(), "a cursor outside the project is dropped");
    }

    #[test]
    fn an_empty_selection_or_page_sends_nothing() {
        let page = PageContext {
            selection: Some(Selection {
                text: String::new(),
                file: "main.tex".into(),
                from: Position::default(),
                to: Position::default(),
            }),
            ..PageContext::default()
        };
        let input = project_input(root(), page);
        assert!(input.selection.is_none());
        assert!(input.active_file.is_none() && input.main_document.is_none());
    }
}
