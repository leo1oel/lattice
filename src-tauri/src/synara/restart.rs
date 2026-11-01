//! Restarting the sidecar so it picks up a changed environment. Its provider
//! CLIs inherit the environment it was started with, so a proxy turned on
//! later (Clash, Surge) or an edited `~/.zshrc` reaches them only through a
//! new sidecar. Restarting stops its running turns, so it is offered, never
//! forced: a system proxy change raises `ENVIRONMENT_CHANGED_EVENT` for the
//! windows to offer it, and Settings compares the shell as it is now.

use super::environment::{self, AgentEnvironment, EnvironmentReport};
use super::shell_env::{self, ShellRead};
use super::{proxy, SynaraRuntime};
use tauri::{Emitter, Manager};

/// Payload `{ stale }`: whether the running sidecar's proxy settings now
/// differ from the system's.
const ENVIRONMENT_CHANGED_EVENT: &str = "synara-environment-changed";
/// The sidecar stopped for a restart; windows using it start it again.
const RESTARTED_EVENT: &str = "synara-runtime-restarted";

#[derive(Clone, serde::Serialize)]
struct EnvironmentChanged {
    stale: bool,
}

pub(super) fn read_login_shell() -> ShellRead {
    shell_env::read(
        &crate::terminal::login_shell(),
        shell_env::SHELL_TIMEOUT,
        environment::is_inherited,
    )
}

pub(super) fn watch_system_proxy(app: Option<tauri::AppHandle>) {
    let Some(app) = app else { return };
    proxy::watch_system_proxy(move || {
        let system = proxy::system_proxy();
        let runtime = app.state::<SynaraRuntime>();
        let Some(stale) = runtime.with_running_environment(|environment| {
            environment.system_proxy_changed(system.as_ref())
        }) else {
            return;
        };
        let _ = app.emit(ENVIRONMENT_CHANGED_EVENT, EnvironmentChanged { stale });
    });
}

impl SynaraRuntime {
    /// `inspect` of the environment the live sidecar started with; `None`
    /// while none runs.
    fn with_running_environment<T>(
        &self, inspect: impl FnOnce(&AgentEnvironment) -> T,
    ) -> Option<T> {
        let mut running = self.running.lock().ok()?;
        let current = running.as_mut()?;
        matches!(current.child.try_wait(), Ok(None)).then(|| inspect(&current.environment))
    }
}

/// The variables an agent start would use now, redacted, and whether the
/// running sidecar started with different ones. Reads the login shell, which
/// can take seconds.
#[tauri::command]
pub async fn synara_agent_environment(app: tauri::AppHandle) -> Result<EnvironmentReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let now = AgentEnvironment::resolve(read_login_shell());
        let started = app
            .state::<SynaraRuntime>()
            .with_running_environment(|started| now.differs_from(started));
        let shell = crate::terminal::login_shell()
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        now.report(shell, started.is_some(), started.unwrap_or(false))
    })
    .await
    .map_err(|error| format!("Agent environment worker failed: {error}"))
}

/// Stop the sidecar; every window using it starts a new one, which reads the
/// login shell and system proxy again.
#[tauri::command]
pub async fn synara_restart(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SynaraRuntime>().shutdown();
        let _ = app.emit(RESTARTED_EVENT, ());
    })
    .await
    .map_err(|error| format!("Agent restart worker failed: {error}"))
}
