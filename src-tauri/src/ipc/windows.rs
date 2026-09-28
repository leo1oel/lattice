//! Windows, the browser handoff, and app-level chores (logs, restart).

use super::{current_root, run_blocking};
use crate::app_state::AppState;
use crate::browser_host::{self, DesktopReturnTarget};
use crate::{chromium, macos_window, project};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow, Window};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
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

/// Show `root` in a new desktop window. The window is bound (and handed its
/// instruction) before it is built: it asks for both during startup, and both
/// must already resolve.
fn open_desktop_window(
    app: &AppHandle, state: &AppState, root: PathBuf, pending: Option<String>,
) -> Result<(String, WebviewWindow), String> {
    let label = next_project_window_label(|label| app.get_webview_window(label).is_some());
    state.bind_window(&label, root)?;
    if let Some(pending) = pending {
        state.set_pending_action(&label, pending);
    }
    match crate::workspace_window(app, &label, false) {
        Ok(window) => Ok((label, window)),
        Err(error) => {
            state.abandon_window(&label);
            Err(format!("Could not open a new Lattice window: {error}"))
        }
    }
}

/// Take the one-shot instruction left for this window, if any.
#[tauri::command]
pub fn take_pending_window_action(state: State<'_, AppState>, window: Window) -> Option<String> {
    state.take_pending_action(window.label())
}

#[tauri::command]
pub async fn open_paper_lookup(
    app: AppHandle, window: Window, title: String,
) -> Result<(), String> {
    let label = format!("paper-lookup-{}", window.label());
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|error| error.to_string())?;
        return existing.set_focus().map_err(|error| error.to_string());
    }
    // The owner is an application-generated window label, never a path or URL
    // supplied by the renderer. Lookup windows do not bind a second project.
    let url = format!("index.html?paper-lookup={}", window.label());
    let builder = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(390.0, 600.0)
        .min_inner_size(320.0, 340.0)
        .always_on_top(false)
        .disable_drag_drop_handler();
    let created = crate::overlay_title_bar(builder).build().map_err(|error| error.to_string())?;
    macos_window::install_traffic_light_alignment(&created);
    Ok(())
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
    browser: State<'_, browser_host::BrowserHost>, path: String, pending: Option<String>,
) -> Result<OpenedProjectWindow, String> {
    // Opened here, before any window exists, so a project that cannot be read
    // reports the failure into the window the writer is looking at rather than
    // flashing up a broken new one.
    let snapshot = run_blocking("Project opening", move || project::open(Path::new(&path))).await?;
    let root = PathBuf::from(&snapshot.root);

    if let Some(label) = state.window_showing(&root) {
        if label.starts_with("browser-") {
            if browser.reopen_window(&app, &label, false)? {
                return Ok(OpenedProjectWindow { label, focused_existing: true });
            }
        } else if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            // The window is already up, so it will not run startup again. The
            // caller is told nothing was opened and acts on the instruction
            // itself rather than having it silently dropped here.
            return Ok(OpenedProjectWindow { label, focused_existing: true });
        }
        // The binding outlived its window. Drop it and open a fresh one.
        state.release_window(&label);
    }

    let label = if window.label().starts_with("browser-") {
        browser.open_project(&app, &state, root, pending)?
    } else {
        let (label, created) = open_desktop_window(&app, &state, root, pending)
            .map_err(|error| format!("Could not open a new window: {error}"))?;
        let _ = created.set_focus();
        label
    };
    Ok(OpenedProjectWindow { label, focused_existing: false })
}

/// Move a browser-hosted project back into an ordinary desktop window. The
/// browser relay is retired only after this command's response has crossed the
/// bridge, so the caller never hangs waiting on a socket we just closed.
#[tauri::command]
pub fn return_to_desktop(
    app: AppHandle, state: State<'_, AppState>, browser: State<'_, browser_host::BrowserHost>,
    window: Window,
) -> Result<String, String> {
    if !window.label().starts_with("browser-") {
        return Err("This workspace is already open in the desktop app.".to_string());
    }
    if browser.has_bundled_chromium(window.label())? {
        // The fixed Chromium build already owns this workspace and is merely
        // parked while the system-browser peer is connected. Resume that same
        // renderer instead of creating a slower WebKit desktop window.
        browser.return_to_desktop(&app, window.label(), DesktopReturnTarget::Bundled)?;
        return Ok(window.label().to_string());
    }
    let root = current_root(&state, &window)?;
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|error| format!("Could not show Lattice in the Dock: {error}"))?;
    let (label, desktop) = open_desktop_window(&app, &state, root, None)?;
    if let Err(reason) =
        browser.return_to_desktop(&app, window.label(), DesktopReturnTarget::Native)
    {
        let _ = desktop.destroy();
        state.abandon_window(&label);
        return Err(reason);
    }
    let _ = desktop.set_focus();
    Ok(label)
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

/// Hand the current workspace to a browser tab while this installed app keeps
/// every native capability behind a loopback-only, token-authenticated bridge.
#[tauri::command]
pub fn open_in_browser(
    app: AppHandle, browser: State<'_, browser_host::BrowserHost>, state: State<'_, AppState>,
    window: Window,
) -> Result<String, String> {
    let project_root = state.root_for(window.label())?;
    // Fail before changing login startup when another process owns the fixed
    // entry. The setting should not look enabled after an unsuccessful open.
    browser.start(&app, false)?;
    // Opening the fixed browser entry opts into its defining behavior: after
    // the next login, a windowless Lattice process keeps the bookmarked local
    // address available without making the writer open the desktop UI first.
    let access_was_enabled = browser_access_enabled(app.clone())?;
    if !access_was_enabled {
        app.autolaunch()
            .enable()
            .map_err(|error| format!("Could not keep browser access ready after login: {error}"))?;
    }
    let resident_was_present = app.get_window(browser_host::SERVICE_WINDOW_LABEL).is_some();
    let opened = browser.keep_resident(&app).and_then(|()| {
        browser.open(&app, window.label(), project_root).inspect_err(|_| {
            if !resident_was_present {
                browser.stop_resident(&app);
            }
        })
    });
    if opened.is_err() && !access_was_enabled {
        let _ = app.autolaunch().disable();
    }
    opened
}

/// Open the bundled-Chromium workspace in the user's default browser without
/// tearing down its desktop surface. The browser host parks that surface while
/// the external tab is connected and restores it when the tab closes.
#[tauri::command]
pub fn open_in_system_browser(
    app: AppHandle, browser: State<'_, browser_host::BrowserHost>, window: Window,
) -> Result<(), String> {
    if browser.reopen_window(&app, window.label(), true)? {
        Ok(())
    } else {
        Err("This Lattice workspace is no longer available.".to_string())
    }
}

#[tauri::command]
pub fn browser_access_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("Could not read the browser access setting: {error}"))
}

#[tauri::command]
pub fn set_browser_access_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let result = if enabled { app.autolaunch().enable() } else { app.autolaunch().disable() };
    result.map_err(|error| format!("Could not update browser access: {error}"))?;
    let browser = app.state::<browser_host::BrowserHost>();
    if enabled {
        return browser.keep_resident(&app);
    }
    // Packaged Chromium is still the running desktop application after its
    // last window closes on macOS. Its small native owner must stay alive
    // until the user explicitly quits so the Dock can reopen it and the
    // loopback browser address does not disappear.
    if !app.state::<chromium::ChromiumRuntime>().is_running() {
        browser.stop_resident(&app);
    }
    Ok(())
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
