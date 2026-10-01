//! Production Chromium renderer supervision.
//!
//! Lattice keeps Tauri as the installed application and privileged backend so
//! its updater, native commands, and bundled Synara runtime retain one owner.
//! The visible workspace runs in the fixed Electron/Chromium build staged in
//! the app resources. A newline-delimited control pipe lets the backend open
//! authenticated workspace URLs without putting bridge tokens in argv or
//! handing them to the user's default browser.
//!
//! The same Electron executable doubles as the Node runtime of the Synara and
//! Open Slide sidecars in release builds; see [`NodeRuntime`].

use crate::commands::{in_new_process_group, signal_process_group};
use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const RUNTIME_EXECUTABLE: &str = "chromium-runtime/Lattice Chromium.app/Contents/MacOS/Electron";
const PIPE_UNAVAILABLE: &str = "The Chromium control pipe is unavailable.";

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
    pub(crate) fn is_packaged(&self, app: &tauri::AppHandle) -> bool {
        !cfg!(debug_assertions) && executable(app).is_ok_and(|path| path.is_file())
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

/// The JavaScript runtime of the Synara and Open Slide sidecars.
///
/// Production macOS already ships Electron for the fixed Chromium renderer.
/// Its executable can run ordinary Node entry points without launching a
/// browser, so sharing it avoids bundling a second 120 MB Node binary.
/// Development keeps the independently prepared runtime so `pnpm tauri dev`
/// never has to materialize Chromium first.
#[derive(Clone, Default)]
pub(crate) struct NodeRuntime {
    pub(crate) executable: PathBuf,
    electron: bool,
}

impl NodeRuntime {
    pub(crate) fn resolve(electron_resources: &Path, standalone_bin: &Path) -> Self {
        let electron = cfg!(not(debug_assertions));
        let executable = if electron {
            electron_resources.join(RUNTIME_EXECUTABLE)
        } else {
            standalone_bin.join("node")
        };
        Self { executable, electron }
    }

    /// Run the entry point as plain Node in a fresh process group, so
    /// [`terminate_process_group`] also reaches every descendant.
    pub(crate) fn configure(&self, command: &mut Command) {
        if self.electron {
            command.env("ELECTRON_RUN_AS_NODE", "1");
        }
        in_new_process_group(command);
    }
}

/// SIGTERM a sidecar's process group, allow a two-second grace period, then
/// SIGKILL whatever is left.
pub(crate) fn terminate_process_group(child: &mut Child) {
    signal_process_group(child.id(), libc::SIGTERM);
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    signal_process_group(child.id(), libc::SIGKILL);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::{encode_message, NodeRuntime, ShellMessage, RUNTIME_EXECUTABLE};
    use std::ffi::OsStr;
    use std::path::Path;
    use std::process::Command;

    fn electron_env(runtime: &NodeRuntime) -> Option<Option<String>> {
        let mut command = Command::new(&runtime.executable);
        runtime.configure(&mut command);
        command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("ELECTRON_RUN_AS_NODE"))
            .map(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
    }

    #[test]
    fn sidecar_node_is_electron_as_node_in_release_and_standalone_in_development() {
        let resources = Path::new("/resources");
        let bin = Path::new("/runtime/bin");
        let runtime = NodeRuntime::resolve(resources, bin);
        if cfg!(debug_assertions) {
            assert_eq!(runtime.executable, bin.join("node"));
            assert_eq!(electron_env(&runtime), None);
        } else {
            assert_eq!(runtime.executable, resources.join(RUNTIME_EXECUTABLE));
            assert_eq!(electron_env(&runtime), Some(Some("1".into())));
        }
        let electron =
            NodeRuntime { executable: resources.join(RUNTIME_EXECUTABLE), electron: true };
        assert_eq!(electron_env(&electron), Some(Some("1".into())));
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
