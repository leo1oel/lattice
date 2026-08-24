//! Production Chromium renderer supervision.
//!
//! Lattice keeps Tauri as the installed application and privileged backend so
//! its updater, native commands, and bundled Synara runtime retain one owner.
//! The visible workspace runs in the fixed Electron/Chromium build staged in
//! the app resources. A newline-delimited control pipe lets the backend open
//! authenticated workspace URLs without putting bridge tokens in argv or
//! handing them to the user's default browser.

use serde::Serialize;
use std::{
    io::Write,
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex,
    },
};
use tauri::Manager;

const RUNTIME_EXECUTABLE: &str = "chromium-runtime/Lattice Chromium.app/Contents/MacOS/Electron";

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

#[cfg(test)]
fn encode_open_url(url: &str) -> Result<String, String> {
    encode_message(&ShellMessage::OpenUrl { url })
}

impl ChromiumRuntime {
    pub(crate) fn is_packaged(&self, app: &tauri::AppHandle) -> bool {
        if cfg!(debug_assertions) {
            return false;
        }
        self.executable(app).is_ok_and(|path| path.is_file())
    }

    pub(crate) fn is_running(&self) -> bool {
        self.pid.load(Ordering::Acquire) != 0
    }

    pub(crate) fn launch(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        let executable = self.executable(app)?;
        if !executable.is_file() {
            return Err(format!(
                "The bundled Chromium runtime is missing at {}.",
                executable.display()
            ));
        }

        let mut child = Command::new(&executable)
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
        self.shutting_down.store(false, Ordering::Release);
        self.pid.store(pid, Ordering::Release);
        *self
            .input
            .lock()
            .map_err(|_| "The Chromium control pipe is unavailable.".to_string())? = Some(input);

        let app = app.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let runtime = app.state::<ChromiumRuntime>();
            runtime
                .pid
                .compare_exchange(pid, 0, Ordering::AcqRel, Ordering::Acquire)
                .ok();
            if let Ok(mut input) = runtime.input.lock() {
                *input = None;
            }
            if !runtime.shutting_down.load(Ordering::Acquire) {
                match status {
                    Ok(status) if !status.success() => log::error!(
                        target: "lattice::chromium",
                        "Chromium renderer exited unexpectedly with {status}"
                    ),
                    Err(error) => log::error!(
                        target: "lattice::chromium",
                        "could not wait for Chromium renderer: {error}"
                    ),
                    _ => {}
                }
                // Command-Q belongs to the visible Chromium application. Exit
                // its native owner too so the port, Synara, and updater do not
                // survive an application quit as disconnected background work.
                app.exit(0);
            }
        });
        Ok(())
    }

    /// Open or focus a Chromium workspace. False means no packaged shell owns
    /// the request, so explicit browser-access mode may use the system browser.
    pub(crate) fn open_url(&self, url: &str) -> Result<bool, String> {
        self.send(&ShellMessage::OpenUrl { url })
    }

    /// Hide a workspace while its system-browser peer is active, then reveal
    /// the same Chromium window after that peer disconnects.
    pub(crate) fn set_window_visibility(&self, label: &str, visible: bool) -> Result<bool, String> {
        self.send(&ShellMessage::SetWindowVisibility { label, visible })
    }

    fn send(&self, message: &ShellMessage<'_>) -> Result<bool, String> {
        if !self.is_running() {
            return Ok(false);
        }
        let message = encode_message(message)?;
        let mut input = self
            .input
            .lock()
            .map_err(|_| "The Chromium control pipe is unavailable.".to_string())?;
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
        #[cfg(target_os = "macos")]
        if pid != 0 {
            // Electron's main process owns its Chromium helpers; terminating it
            // makes those helpers exit through their normal parent-death path.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = pid;
    }

    fn executable(&self, app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        app.path()
            .resource_dir()
            .map(|resources| resources.join(RUNTIME_EXECUTABLE))
            .map_err(|error| format!("Could not locate the Chromium runtime: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{encode_message, encode_open_url, ShellMessage};

    #[test]
    fn control_messages_keep_authenticated_urls_out_of_process_arguments() {
        let encoded = encode_open_url(
            "http://127.0.0.1:18452/#token=secret&bridgePort=18452&label=browser-test",
        )
        .unwrap();
        assert_eq!(
            encoded,
            "{\"type\":\"open-url\",\"url\":\"http://127.0.0.1:18452/#token=secret&bridgePort=18452&label=browser-test\"}\n"
        );
    }

    #[test]
    fn control_messages_can_hide_and_restore_one_workspace() {
        let encoded = encode_message(&ShellMessage::SetWindowVisibility {
            label: "browser-test",
            visible: false,
        })
        .unwrap();
        assert_eq!(
            encoded,
            "{\"type\":\"set-window-visibility\",\"label\":\"browser-test\",\"visible\":false}\n"
        );
    }

    #[test]
    fn red_close_keeps_the_macos_chromium_owner_alive() {
        let shell = include_str!("../../scripts/chromium-shell.mjs");
        assert!(shell.contains("app.on(\"window-all-closed\""));
        assert!(shell.contains("process.platform !== \"darwin\""));
    }
}
