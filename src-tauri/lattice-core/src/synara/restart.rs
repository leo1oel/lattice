//! Restarting the sidecar so it picks up a changed environment. Its provider
//! CLIs inherit the environment it was started with, so a proxy turned on
//! later (Clash, Surge) or an edited `~/.zshrc` reaches them only through a
//! new sidecar. Restarting stops its running turns, so it is offered, never
//! forced: a system proxy change raises `ENVIRONMENT_CHANGED_EVENT` for the
//! windows to offer it, and Settings compares the shell as it is now.

use super::environment::{self, AgentEnvironment, EnvironmentReport};
#[cfg(unix)]
use super::shell_env;
use super::shell_env::ShellRead;
use super::{proxy, RunningSynara, SynaraRuntime};
use crate::host::EventSink;
use std::sync::{Arc, Mutex};

/// Payload `{ stale }`: whether the running sidecar's proxy settings now
/// differ from the system's.
const ENVIRONMENT_CHANGED_EVENT: &str = "synara-environment-changed";
/// The sidecar was restarted, on request or after it exited; windows using it
/// ask for the new one.
const RESTARTED_EVENT: &str = "synara-runtime-restarted";

pub(super) fn read_login_shell() -> ShellRead {
    #[cfg(windows)]
    return Ok(std::env::vars().filter(|(name, _)| environment::is_inherited(name)).collect());
    #[cfg(not(windows))]
    shell_env::read(
        &crate::terminal::login_shell(),
        shell_env::SHELL_TIMEOUT,
        environment::is_inherited,
    )
}

pub(super) fn watch_system_proxy(
    events: Option<Arc<dyn EventSink>>, running: Arc<Mutex<Option<RunningSynara>>>,
) {
    let Some(events) = events else { return };
    proxy::watch_system_proxy(move || {
        let system = proxy::system_proxy();
        let Some(stale) = with_running_environment(&running, |environment| {
            environment.system_proxy_changed(system.as_ref())
        }) else {
            return;
        };
        events.emit(ENVIRONMENT_CHANGED_EVENT, serde_json::json!({ "stale": stale }));
    });
}

/// `inspect` of the environment the live sidecar started with; `None` while
/// none runs.
fn with_running_environment<T>(
    running: &Mutex<Option<RunningSynara>>, inspect: impl FnOnce(&AgentEnvironment) -> T,
) -> Option<T> {
    let mut running = running.lock().ok()?;
    let current = running.as_mut()?;
    matches!(current.child.try_wait(), Ok(None)).then(|| inspect(&current.environment))
}

/// Tell every window the sidecar was restarted, so each asks for the new one.
pub(super) fn announce(events: Option<&dyn EventSink>) {
    if let Some(events) = events {
        events.emit(RESTARTED_EVENT, serde_json::Value::Null);
    }
}

impl SynaraRuntime {
    /// The variables an agent start would use now, redacted, and whether the
    /// running sidecar started with different ones. Reads the login shell,
    /// which can take seconds.
    pub fn agent_environment(&self) -> EnvironmentReport {
        let now = AgentEnvironment::resolve(read_login_shell());
        let started = with_running_environment(&self.running, |started| now.differs_from(started));
        let shell = crate::terminal::login_shell()
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        now.report(shell, started.is_some(), started.unwrap_or(false))
    }

    /// Stop the sidecar; every window using it starts a new one, which reads
    /// the login shell and system proxy again.
    pub fn restart(&self) {
        self.shutdown();
        announce(self.events.as_deref());
    }
}
