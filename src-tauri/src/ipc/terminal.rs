//! The Terminal panel (terminal.rs): a shell per tab in the window's project
//! folder, typed into, resized and closed by id. Every command first checks
//! its caller is a Lattice window's own page (terminal/caller.rs), and names
//! that window, so a window reaches only the terminals it opened.

use super::{pinned_root, run_blocking};
use crate::app_state::AppState;
use crate::terminal::{self, Session};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody, Request};
use tauri::{Manager, Runtime, State, Webview, Window};

/// The most a page may type into a shell in one request; the page splits a
/// longer paste.
const MAX_WRITE_BYTES: usize = 256 * 1024;

/// The calling window, once its page passed [`terminal::caller::check`].
fn caller_window<R: Runtime>(
    webview: &Webview<R>, request: &Request<'_>,
) -> Result<Window<R>, String> {
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
pub async fn terminal_open<R: Runtime>(
    state: State<'_, AppState>, webview: Webview<R>, request: Request<'_>, project_root: String,
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
pub async fn terminal_write<R: Runtime>(
    state: State<'_, AppState>, webview: Webview<R>, request: Request<'_>, id: u32, data: String,
) -> Result<(), String> {
    let window = caller_window(&webview, &request)?;
    if data.len() > MAX_WRITE_BYTES {
        return Err("Too much to type into the terminal at once.".into());
    }
    state.terminals.with(window.label(), id, |session| session.write(data.into_bytes()))?
}

#[tauri::command]
pub async fn terminal_resize<R: Runtime>(
    state: State<'_, AppState>, webview: Webview<R>, request: Request<'_>, id: u32, cols: u16,
    rows: u16,
) -> Result<(), String> {
    let window = caller_window(&webview, &request)?;
    state.terminals.with(window.label(), id, |session| session.resize(cols, rows))?
}

/// The window has drawn `bytes` more of terminal `id`'s output.
#[tauri::command]
pub async fn terminal_ack<R: Runtime>(
    state: State<'_, AppState>, webview: Webview<R>, request: Request<'_>, id: u32, bytes: usize,
) -> Result<(), String> {
    let window = caller_window(&webview, &request)?;
    state.terminals.with(window.label(), id, |session| session.acknowledge(bytes))
}

/// The command running in terminal `id` ("latexmk"; empty when its name is
/// unknown), or null at the prompt: what closing it would stop.
#[tauri::command]
pub async fn terminal_running_command<R: Runtime>(
    state: State<'_, AppState>, webview: Webview<R>, request: Request<'_>, id: u32,
) -> Result<Option<String>, String> {
    let window = caller_window(&webview, &request)?;
    state.terminals.with(window.label(), id, Session::running_command)
}

/// End terminal `id`: its shell and whatever it runs.
#[tauri::command]
pub async fn terminal_close<R: Runtime>(
    state: State<'_, AppState>, webview: Webview<R>, request: Request<'_>, id: u32,
) -> Result<(), String> {
    let window = caller_window(&webview, &request)?;
    state.terminals.close(window.label(), id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::app_state::AppState;
    use crate::test_support::TempDir;
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{
        get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
    };
    use tauri::webview::InvokeRequest;
    use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    const REFUSED: &str = "The terminal is only available in a Lattice window.";
    const CLOSED: &str = "This terminal has closed.";

    fn app(project: &std::path::Path) -> App<MockRuntime> {
        let app = mock_builder()
            .manage(AppState::from_environment())
            .invoke_handler(tauri::generate_handler![
                super::terminal_open,
                super::terminal_write,
                super::terminal_resize,
                super::terminal_ack,
                super::terminal_running_command,
                super::terminal_close,
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        for label in ["main", "project-2", "browser-1"] {
            app.state::<AppState>().bind_window(label, project.to_path_buf()).unwrap();
        }
        app
    }

    fn window(app: &App<MockRuntime>, label: &str, url: WebviewUrl) -> WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(app, label, url).build().unwrap()
    }

    /// The command's error, as the page would receive it, from a request a
    /// frame on `frame_url` sent with `origin`.
    fn call(
        webview: &WebviewWindow<MockRuntime>, cmd: &str, body: Value, frame_url: &str,
        origin: Option<&str>,
    ) -> Result<(), String> {
        let mut headers = tauri::http::HeaderMap::new();
        if let Some(origin) = origin {
            headers.insert("origin", origin.parse().unwrap());
        }
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: frame_url.parse().unwrap(),
            body: InvokeBody::Json(body),
            headers,
            invoke_key: INVOKE_KEY.into(),
        };
        get_ipc_response(webview, request).map(|_| ()).map_err(|error| match error {
            Value::String(text) => text,
            other => other.to_string(),
        })
    }

    #[test]
    fn lattice_s_own_page_in_a_workspace_window_reaches_the_terminal_commands() {
        let dir = TempDir::new("terminal-ipc");
        let app = app(&dir);
        let main = window(&app, "main", WebviewUrl::App("index.html".into()));
        // Past the gate: the command itself answers (there is no terminal 99).
        let reached = call(
            &main,
            "terminal_running_command",
            json!({ "id": 99 }),
            "tauri://localhost",
            Some("tauri://localhost"),
        );
        assert_eq!(reached, Err(CLOSED.to_string()));
        assert_eq!(
            call(&main, "terminal_close", json!({ "id": 99 }), "tauri://localhost", None),
            Ok(())
        );
    }

    #[test]
    fn other_windows_pages_frames_and_origins_cannot_open_or_drive_a_shell() {
        let dir = TempDir::new("terminal-ipc");
        let app = app(&dir);
        let root = dir.to_string_lossy().into_owned();
        let open =
            json!({ "projectRoot": root, "cols": 80, "rows": 24, "onOutput": "__CHANNEL__:7" });
        let main = window(&app, "main", WebviewUrl::App("index.html".into()));
        // The hidden host that relays a browser tab.
        let browser = window(&app, "browser-1", WebviewUrl::App("index.html".into()));
        // A workspace window whose page navigated off Lattice.
        let navigated = window(
            &app,
            "project-2",
            WebviewUrl::External("https://evil.example/".parse().unwrap()),
        );
        // Any other window Lattice opens (the Overleaf sign-in).
        let other = window(
            &app,
            "overleaf-login",
            WebviewUrl::External("https://www.overleaf.com/login".parse().unwrap()),
        );
        for (webview, frame, origin) in [
            (&browser, "tauri://localhost", Some("tauri://localhost")),
            (&navigated, "tauri://localhost", Some("tauri://localhost")),
            (&other, "tauri://localhost", None),
            // A frame inside Lattice's page on another origin: the Synara
            // panel or an Open Slide deck on loopback, a sandboxed preview.
            (&main, "tauri://localhost", Some("http://127.0.0.1:51234")),
            (&main, "tauri://localhost", Some("null")),
        ] {
            for (cmd, body) in [
                ("terminal_open", open.clone()),
                ("terminal_write", json!({ "id": 1, "data": "ls\r" })),
                ("terminal_running_command", json!({ "id": 1 })),
            ] {
                let answer = call(webview, cmd, body, frame, origin);
                assert_eq!(
                    answer,
                    Err(REFUSED.to_string()),
                    "{} {cmd} {origin:?}",
                    webview.label()
                );
            }
        }
        // A request whose frame is not Lattice's never reaches the command:
        // Tauri refuses it, as no capability grants a remote URL.
        let remote = call(
            &main,
            "terminal_open",
            open,
            "http://127.0.0.1:51234/",
            Some("http://127.0.0.1:51234"),
        );
        assert!(
            remote.is_err_and(|error| error != REFUSED && error != CLOSED),
            "remote frame reached the command"
        );
        assert_eq!(app.state::<AppState>().terminals.len(), 0);
    }
}
