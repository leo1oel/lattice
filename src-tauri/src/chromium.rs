//! The packaged Chromium renderer, kept for one release as a fallback.
//!
//! Release builds render in the system WKWebView. Launched with
//! `LATTICE_RENDERER=chromium`, a release build shows its workspaces in the
//! fixed Electron/Chromium build staged in the app resources instead, as
//! Lattice did before; Tauri stays the installed application and privileged
//! backend either way. A newline-delimited control pipe lets the backend open
//! authenticated workspace URLs without putting bridge tokens in argv or
//! handing them to the user's default browser.

use serde::Serialize;
use std::{
    ffi::OsStr,
    io::Write,
    path::PathBuf,
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex,
    },
};
use tauri::Manager;

const RUNTIME_EXECUTABLE: &str = "chromium-runtime/Lattice Chromium.app/Contents/MacOS/Electron";
const PIPE_UNAVAILABLE: &str = "The Chromium control pipe is unavailable.";
/// `LATTICE_RENDERER=chromium` brings back the packaged Chromium window.
const RENDERER_ENV: &str = "LATTICE_RENDERER";

/// Whether a launch asked for the Chromium renderer.
fn chromium_requested(renderer: Option<&OsStr>) -> bool {
    renderer.is_some_and(|value| value.eq_ignore_ascii_case("chromium"))
}

#[derive(Default)]
pub(crate) struct ChromiumRuntime {
    input: Mutex<Option<ChildStdin>>,
    pid: AtomicU32,
    shutting_down: AtomicBool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ShellMessage<'a> {
    OpenUrl { url: &'a str },
    SetWindowVisibility { label: &'a str, visible: bool },
}

fn encode_message(message: &ShellMessage<'_>) -> Result<String, String> {
    serde_json::to_string(message)
        .map(|message| format!("{message}\n"))
        .map_err(|error| format!("Could not encode the Chromium window request: {error}"))
}

impl ChromiumRuntime {
    fn is_packaged(&self, app: &tauri::AppHandle) -> bool {
        !cfg!(debug_assertions) && executable(app).is_ok_and(|path| path.is_file())
    }

    /// The Chromium window renders this launch only when it was asked for and
    /// the runtime is packaged; otherwise the workspace is a WKWebView window.
    pub(crate) fn is_selected(&self, app: &tauri::AppHandle) -> bool {
        chromium_requested(std::env::var_os(RENDERER_ENV).as_deref()) && self.is_packaged(app)
    }

    pub(crate) fn is_running(&self) -> bool {
        self.pid.load(Ordering::Acquire) != 0
    }

    pub(crate) fn launch(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        let executable = executable(app)?;
        if !executable.is_file() {
            return Err(format!(
                "The bundled Chromium runtime is missing at {}.",
                executable.display()
            ));
        }

        let mut command = Command::new(&executable);
        // chromium-shell.mjs loads the perf lab module (synthetic input, PNG
        // writes, extra Chromium switches) whenever LATTICE_PERF_PLAN is set,
        // so only a perf-lab build may pass the lab variables through.
        #[cfg(not(feature = "perf-lab"))]
        for (name, _) in std::env::vars_os() {
            let lab = name.to_str().is_some_and(|name| {
                name == "LATTICE_PERF_PLAN"
                    || name.starts_with("LATTICE_CR_")
                    || name.starts_with("LATTICE_LAB_")
            });
            if lab {
                command.env_remove(name);
            }
        }
        let mut child = command
            .env("LATTICE_CHROMIUM_MANAGED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start the bundled Chromium renderer: {error}"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| "Could not open the Chromium control pipe.".to_string())?;
        let pid = child.id();
        #[cfg(feature = "perf-lab")]
        crate::perf_lab::trace("rust:chromium-spawned");
        self.shutting_down.store(false, Ordering::Release);
        self.pid.store(pid, Ordering::Release);
        *self.input.lock().map_err(|_| PIPE_UNAVAILABLE.to_string())? = Some(input);

        let app = app.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let runtime = app.state::<ChromiumRuntime>();
            runtime.pid.compare_exchange(pid, 0, Ordering::AcqRel, Ordering::Acquire).ok();
            if let Ok(mut input) = runtime.input.lock() {
                *input = None;
            }
            if runtime.shutting_down.load(Ordering::Acquire) {
                return;
            }
            match status {
                Ok(status) if !status.success() => log::error!(
                    target: "lattice::chromium",
                    "Chromium renderer exited unexpectedly with {status}"
                ),
                Err(error) => {
                    log::error!(target: "lattice::chromium", "could not wait for Chromium renderer: {error}")
                }
                _ => {}
            }
            // Command-Q belongs to the visible Chromium application. Exit its
            // native owner too so the port, Synara, and updater do not survive
            // an application quit as disconnected background work.
            app.exit(0);
        });
        Ok(())
    }

    /// Open or focus a Chromium workspace. False means no packaged shell owns
    /// the request, so explicit browser-access mode may use the system browser.
    pub(crate) fn open_url(&self, url: &str) -> Result<bool, String> {
        self.send(&ShellMessage::OpenUrl { url })
    }

    /// Hide a workspace while a browser tab holds it, then show the same
    /// Chromium window again when the tab gives it back or closes.
    pub(crate) fn set_window_visibility(&self, label: &str, visible: bool) -> Result<bool, String> {
        self.send(&ShellMessage::SetWindowVisibility { label, visible })
    }

    fn send(&self, message: &ShellMessage<'_>) -> Result<bool, String> {
        if !self.is_running() {
            return Ok(false);
        }
        let message = encode_message(message)?;
        let mut input = self.input.lock().map_err(|_| PIPE_UNAVAILABLE.to_string())?;
        let Some(input) = input.as_mut() else {
            return Ok(false);
        };
        input
            .write_all(message.as_bytes())
            .and_then(|_| input.flush())
            .map_err(|error| format!("Could not open the Chromium workspace: {error}"))?;
        Ok(true)
    }

    pub(crate) fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        if let Ok(mut input) = self.input.lock() {
            *input = None;
        }
        let pid = self.pid.swap(0, Ordering::AcqRel);
        if pid != 0 {
            // Electron's main process owns its Chromium helpers; terminating it
            // makes those helpers exit through their normal parent-death path.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
    }
}

fn executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|resources| resources.join(RUNTIME_EXECUTABLE))
        .map_err(|error| format!("Could not locate the Chromium runtime: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{chromium_requested, encode_message, ShellMessage};
    use std::ffi::OsStr;

    #[test]
    fn only_an_explicit_request_selects_the_chromium_renderer() {
        for (value, selected) in [
            (None, false),
            (Some(""), false),
            (Some("webkit"), false),
            (Some("chromium"), true),
            (Some("Chromium"), true),
        ] {
            assert_eq!(chromium_requested(value.map(OsStr::new)), selected, "{value:?}");
        }
    }

    #[test]
    fn control_messages_keep_authenticated_urls_out_of_process_arguments() {
        let url = "http://127.0.0.1:18452/#token=secret&bridgePort=18452&label=browser-test";
        for (message, expected) in [
            (ShellMessage::OpenUrl { url }, format!(r#"{{"type":"open-url","url":"{url}"}}"#)),
            (
                ShellMessage::SetWindowVisibility { label: "browser-test", visible: false },
                r#"{"type":"set-window-visibility","label":"browser-test","visible":false}"#
                    .to_string(),
            ),
        ] {
            assert_eq!(encode_message(&message).unwrap(), format!("{expected}\n"));
        }
    }

    #[test]
    fn chromium_shell_keeps_its_macos_owner_alive_and_accepts_activation_clicks() {
        let shell = include_str!("../../scripts/chromium-shell.mjs");
        // Red close must not quit the macOS owner; an inactive window must
        // accept the click that activates it.
        for expected in [
            "app.on(\"window-all-closed\"",
            "process.platform !== \"darwin\"",
            "acceptFirstMouse: true",
        ] {
            assert!(shell.contains(expected), "{expected}");
        }
    }
}
