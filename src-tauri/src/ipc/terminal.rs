//! The Terminal panel (terminal.rs): a shell per tab in the window's project
//! folder, typed into, resized and closed by id. Every command first checks
//! its caller is a Lattice window's own page (terminal/caller.rs), and names
//! that window, so a window reaches only the terminals it opened.

use super::{pinned_root, run_blocking};
use crate::app_state::AppState;
use crate::terminal::{self, Session};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody, Request};
use tauri::{Manager, State, Webview, Window};

/// The most a page may type into a shell in one request; the page splits a
/// longer paste.
const MAX_WRITE_BYTES: usize = 256 * 1024;

/// The calling window, once its page passed [`terminal::caller::check`].
fn caller_window(webview: &Webview, request: &Request<'_>) -> Result<Window, String> {
    let window = webview.window();
    let page = webview.url().map(|url| url.to_string()).unwrap_or_default();
    let origin = request.headers().get("origin").and_then(|value| value.to_str().ok());
    let caller = terminal::caller::Caller {
        window: window.label(),
        webview: webview.label(),
        page: &page,
        origin,
    };
    terminal::caller::check(&caller, &terminal::caller::local_origins(webview.app_handle()))?;
    Ok(window)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedTerminal {
    id: u32,
    /// The shell's name ("zsh").
    shell: String,
}

/// Start a login shell in the window's project folder, `cols` × `rows`.
#[tauri::command]
pub async fn terminal_open(
    state: State<'_, AppState>, webview: Webview, request: Request<'_>, project_root: String,
    cols: u16, rows: u16, on_output: Channel<InvokeResponseBody>,
) -> Result<OpenedTerminal, String> {
    let window = caller_window(&webview, &request)?;
    let root = pinned_root(&state, &window, &project_root, "the terminal could start")?;
    let label = window.label().to_string();
    let session = run_blocking("Terminal start", {
        let root = root.clone();
        move || Session::spawn(label, root, cols, rows, on_output)
    })
    .await?;
    let shell = session.name().to_string();
    let id = state.terminals.insert(session);
    // The project may have changed while the shell started; the sweep that
    // ran then could not see this one.
    if state.root_for(window.label())?.as_deref() != Some(root.as_path()) {
        state.terminals.close(window.label(), id);
        return Err("The project changed before the terminal could start.".into());
    }
    Ok(OpenedTerminal { id, shell })
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>, webview: Webview, request: Request<'_>, id: u32, data: String,
) -> Result<(), String> {
    let window = caller_window(&webview, &request)?;
    if data.len() > MAX_WRITE_BYTES {
        return Err("Too much to type into the terminal at once.".into());
    }
    state.terminals.with(window.label(), id, |session| session.write(data.into_bytes()))?
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>, webview: Webview, request: Request<'_>, id: u32, cols: u16,
    rows: u16,
) -> Result<(), String> {
    let window = caller_window(&webview, &request)?;
    state.terminals.with(window.label(), id, |session| session.resize(cols, rows))?
}

/// The window has drawn `bytes` more of terminal `id`'s output.
#[tauri::command]
pub async fn terminal_ack(
    state: State<'_, AppState>, webview: Webview, request: Request<'_>, id: u32, bytes: usize,
) -> Result<(), String> {
    let window = caller_window(&webview, &request)?;
    state.terminals.with(window.label(), id, |session| session.acknowledge(bytes))
}

/// The command running in terminal `id` ("latexmk"; empty when its name is
/// unknown), or null at the prompt: what closing it would stop.
#[tauri::command]
pub async fn terminal_running_command(
    state: State<'_, AppState>, webview: Webview, request: Request<'_>, id: u32,
) -> Result<Option<String>, String> {
    let window = caller_window(&webview, &request)?;
    state.terminals.with(window.label(), id, Session::running_command)
}

/// End terminal `id`: its shell and whatever it runs.
#[tauri::command]
pub async fn terminal_close(
    state: State<'_, AppState>, webview: Webview, request: Request<'_>, id: u32,
) -> Result<(), String> {
    let window = caller_window(&webview, &request)?;
    state.terminals.close(window.label(), id);
    Ok(())
}
