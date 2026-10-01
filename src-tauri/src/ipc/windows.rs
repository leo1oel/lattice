//! Windows and app-level chores (logs, restart).

use super::run_blocking;
use crate::app_state::AppState;
use crate::browser_host;
use crate::{macos_window, native_locale, project};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow, Window};
use tauri_plugin_opener::OpenerExt;

/// What `open_project_window` did, so the caller can tell "opened" from
/// "the project was already open over there".
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenedProjectWindow {
    label: String,
    /// True when an existing window was raised instead of a new one created.
    focused_existing: bool,
}

/// Pick a free `project-N` label.
///
/// Reusing the lowest free index rather than a running counter keeps the label
/// stable across close-and-reopen, which is what lets the window-state plugin
/// restore the size and position the writer last gave that slot.
fn next_project_window_label(is_taken: impl Fn(&str) -> bool) -> String {
    (1..)
        .map(|index| format!("project-{index}"))
        .find(|label| !is_taken(label))
        .expect("an unused window label always exists")
}

/// Show `root` in a new desktop window. The window is bound before it is
/// built: it asks for its project during startup, which must already resolve.
fn open_desktop_window(
    app: &AppHandle, state: &AppState, root: PathBuf,
) -> Result<(String, WebviewWindow), String> {
    let label = next_project_window_label(|label| app.get_webview_window(label).is_some());
    state.bind_window(&label, root)?;
    match crate::workspace_window(app, &label, false) {
        Ok(window) => Ok((label, window)),
        Err(error) => {
            state.abandon_window(&label);
            Err(format!("Could not open a new Lattice window: {error}"))
        }
    }
}

/// Open a project in a window of its own.
///
/// A project may only be open in one window at a time. Two windows on one
/// project would run separate builds into the same output directory, hold two
/// LaTeX language servers over the same files, and each believe its own view of
/// the file tree was current — so a request for a project that is already open
/// raises that window instead of duplicating it.
#[tauri::command]
pub async fn open_project_window(
    app: AppHandle, window: Window, state: State<'_, AppState>,
    browser: State<'_, browser_host::BrowserHost>, path: String,
) -> Result<OpenedProjectWindow, String> {
    // Opened here, before any window exists, so a project that cannot be read
    // reports the failure into the window the writer is looking at rather than
    // flashing up a broken new one.
    let snapshot = run_blocking("Project opening", move || project::open(Path::new(&path))).await?;
    let root = PathBuf::from(&snapshot.root);

    if let Some(label) = state.window_showing(&root) {
        if label.starts_with("browser-") {
            if browser.reopen_window(&app, &label)? {
                return Ok(OpenedProjectWindow { label, focused_existing: true });
            }
        } else if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            return Ok(OpenedProjectWindow { label, focused_existing: true });
        }
        // The binding outlived its window. Drop it and open a fresh one.
        state.release_window(&label);
    }

    let label = if window.label().starts_with("browser-") {
        browser.open_project(&app, &state, root)?
    } else {
        let (label, created) = open_desktop_window(&app, &state, root)
            .map_err(|error| format!("Could not open a new window: {error}"))?;
        let _ = created.set_focus();
        label
    };
    Ok(OpenedProjectWindow { label, focused_existing: false })
}

fn app_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Could not resolve the log folder: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the log folder: {error}"))?;
    Ok(dir)
}

/// Folder containing the rotating `lattice.log` files written by tauri-plugin-log.
/// Created on demand so "Open log folder" works even before the first write.
#[tauri::command]
pub fn get_app_log_dir(app: AppHandle) -> Result<String, String> {
    Ok(app_log_dir(&app)?.to_string_lossy().to_string())
}

/// Open only Lattice's log directory from the privileged side. Granting the
/// WebView opener:allow-open-path would let compromised frontend code launch
/// any local path through its registered application.
#[tauri::command]
pub fn open_app_log_dir(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_path(app_log_dir(&app)?.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("Could not open the log folder: {error}"))
}

/// Finish an installed update without relying on an event-loop restart
/// request forwarded through the browser bridge. The direct main-thread path
/// is why this command cannot return on success: it replaces this process.
#[tauri::command]
pub fn restart_after_update(app: AppHandle) -> Result<(), String> {
    let restarting = app.clone();
    app.run_on_main_thread(move || {
        crate::shutdown_child_runtimes(&restarting);
        restarting.restart();
    })
    .map_err(|error| format!("Could not schedule the updated Lattice app to restart: {error}"))
}

/// Keep native resize backing surfaces in sync with the web app theme.
#[tauri::command]
pub fn set_window_background(window: WebviewWindow, dark: bool) -> Result<(), String> {
    macos_window::apply_window_background(&window, dark);
    Ok(())
}

/// Follow the web UI's interface language natively: rebuild the menu bar with
/// its translated `menu` labels (absent from browser-hosted pages, which show
/// no native menu), and pin the bundle language AppKit and WebKit use from the
/// next launch (`None` follows the system again).
#[tauri::command]
pub fn set_native_locale(
    app: AppHandle, menu: Option<native_locale::MenuLabels>, bundle_language: Option<String>,
) -> Result<(), String> {
    let language = match bundle_language.as_deref() {
        None => None,
        Some(requested) => Some(
            native_locale::bundle_language(requested)
                .ok_or_else(|| format!("Unsupported interface language: {requested}"))?,
        ),
    };
    native_locale::set_bundle_language(language);
    // Only macOS has an app-wide menu bar; elsewhere `set_menu` would add a
    // menu bar to every window, which Lattice never had.
    #[cfg(target_os = "macos")]
    if let Some(labels) = menu {
        let menu = native_locale::build_menu(&app, &labels)
            .map_err(|error| format!("Could not build the menu bar: {error}"))?;
        app.set_menu(menu).map_err(|error| format!("Could not set the menu bar: {error}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, menu);
    Ok(())
}

#[tauri::command]
pub fn align_traffic_lights(
    window: WebviewWindow, center_from_top: f64,
) -> Result<Option<f64>, String> {
    // The window that measured its own titlebar, not "main" — a second
    // window used to move the first window's buttons and never its own.
    Ok(macos_window::align_traffic_lights_to(&window, center_from_top))
}

#[tauri::command]
pub async fn sample_screen_color(app: AppHandle) -> Result<Option<String>, String> {
    macos_window::sample_screen_color(&app).await
}

#[cfg(test)]
mod tests {
    use super::next_project_window_label;

    #[test]
    fn window_labels_reuse_the_lowest_free_slot() {
        let taken = ["project-1", "project-3"];
        let is_taken = |label: &str| taken.contains(&label);

        // Stable labels are what let the window-state plugin restore the size
        // and position the writer gave that slot.
        assert_eq!(next_project_window_label(is_taken), "project-2");
        assert_eq!(next_project_window_label(|_| false), "project-1");
    }
}
