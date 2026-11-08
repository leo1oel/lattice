//! Restarting Lattice into an update: which window installs it, and what a
//! restart would stop.
//!
//! Every window runs its own updater, and each one checks for releases. Two
//! windows installing the same release at once replace the app bundle twice
//! without a lock between them, and the first to finish ends the process
//! halfway through the other's replacement. `UpdateInstall` lets one window
//! install; the others hear that it is under way, or done.
//!
//! The install itself runs here (`install_update`), not in the page: closing
//! or reloading the window that started it does not stop a download already
//! replacing the app bundle, so only the install's own end may release the
//! claim. A claim whose end never arrives lapses after `INSTALL_LEASE`.
//!
//! A restart also ends terminal commands, builds and agent turns. The window
//! offering it asks `restart_impact` first and warns about what is running.
//! Terminals and builds are the backend's own; an agent turn runs in a
//! window's agent panel, which reports it (`set_agent_turn_running`).

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{Manager, ResourceId, State, Webview, WebviewWindow};

use crate::app_state::AppState;

/// How long a claimed install may go without ending before another window may
/// claim it: far past any real download and install, short of "until quit".
const INSTALL_LEASE: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Default, PartialEq, Eq)]
enum Install {
    #[default]
    Idle,
    /// A release being installed, under claim `id`, since `since`.
    Installing {
        version: String,
        id: u64,
        since: Instant,
    },
    Installed(String),
}

/// What a window asking to install a release hears.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateClaim {
    /// This window installs it.
    Claimed,
    /// Another window is installing an update now.
    Busy,
    /// This release is already installed; restarting finishes it.
    Installed,
}

/// The updater plugin's progress events, as `@tauri-apps/plugin-updater` reports them.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

#[derive(Default)]
pub struct AppRestart {
    install: Mutex<Install>,
    claims: AtomicU64,
    /// Windows whose agent panel has a turn running or waiting on the writer.
    agent_turns: Mutex<HashSet<String>>,
}

impl AppRestart {
    fn claim(&self, version: &str, now: Instant) -> UpdateClaim {
        let mut install = self.install.lock().unwrap_or_else(PoisonError::into_inner);
        match &*install {
            Install::Installing { since, .. } if now.duration_since(*since) < INSTALL_LEASE => {
                UpdateClaim::Busy
            }
            Install::Installed(installed) if installed == version => UpdateClaim::Installed,
            // Nothing under way, a lapsed claim, or a newer release than the one installed.
            _ => {
                let id = self.claims.fetch_add(1, Ordering::Relaxed);
                *install = Install::Installing { version: version.to_string(), id, since: now };
                UpdateClaim::Claimed
            }
        }
    }

    /// The claim an install of `version` runs under, if it was claimed.
    fn claimed(&self, version: &str) -> Option<u64> {
        match &*self.install.lock().unwrap_or_else(PoisonError::into_inner) {
            Install::Installing { version: under_way, id, .. } if under_way == version => Some(*id),
            _ => None,
        }
    }

    /// The install under claim `id` ended; one that lapsed and was claimed
    /// again leaves the newer claim alone.
    fn finish(&self, id: u64, installed: bool) {
        let mut install = self.install.lock().unwrap_or_else(PoisonError::into_inner);
        if let Install::Installing { version, id: under_way, .. } = &*install {
            if *under_way == id {
                *install = if installed { Install::Installed(version.clone()) } else { Install::Idle };
            }
        }
    }

    fn set_agent_turn(&self, label: &str, running: bool) {
        let mut turns = self.agent_turns.lock().unwrap_or_else(PoisonError::into_inner);
        if running {
            turns.insert(label.to_string());
        } else {
            turns.remove(label);
        }
    }

    fn agent_turns(&self) -> usize {
        self.agent_turns.lock().unwrap_or_else(PoisonError::into_inner).len()
    }

    /// The window's page went away, and its agent panel with it. An install it
    /// started carries on here and releases its claim when it ends.
    pub fn forget(&self, label: &str) {
        self.set_agent_turn(label, false);
    }
}

/// What restarting Lattice now would stop, across every window.
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartImpact {
    terminal_commands: usize,
    builds: usize,
    agent_turns: usize,
}

/// Ask to install release `version`; see `UpdateClaim`.
#[tauri::command]
pub fn claim_update_install(state: State<'_, AppRestart>, version: String) -> UpdateClaim {
    state.claim(&version, Instant::now())
}

/// Download and install the release this window claimed (`rid`, the update its
/// check found), then release the claim: installed, or failed so another window
/// may try. Runs to its end even if the window closes or reloads meanwhile.
#[tauri::command]
pub async fn install_update(
    webview: Webview, version: String, rid: ResourceId, on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let restart = webview.state::<AppRestart>();
    let claim = restart
        .claimed(&version)
        .ok_or_else(|| format!("Lattice {version} is not claimed for installing."))?;
    let update = webview.resources_table().get::<tauri_plugin_updater::Update>(rid);
    let result = match update {
        Ok(update) => {
            let mut started = false;
            update
                .download_and_install(
                    |chunk_length, content_length| {
                        if !started {
                            started = true;
                            let _ = on_event.send(DownloadEvent::Started { content_length });
                        }
                        let _ = on_event.send(DownloadEvent::Progress { chunk_length });
                    },
                    || {
                        let _ = on_event.send(DownloadEvent::Finished);
                    },
                )
                .await
                .map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    };
    restart.finish(claim, result.is_ok());
    result
}

/// The window's agent panel started or ended a turn.
#[tauri::command]
pub fn set_agent_turn_running(window: WebviewWindow, state: State<'_, AppRestart>, running: bool) {
    state.set_agent_turn(window.label(), running);
}

#[tauri::command]
pub fn restart_impact(restart: State<'_, AppRestart>, app: State<'_, AppState>) -> RestartImpact {
    RestartImpact {
        terminal_commands: app.terminals.running_commands(),
        builds: app.running_builds(),
        agent_turns: restart.agent_turns(),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{AppRestart, UpdateClaim, INSTALL_LEASE};

    #[test]
    fn one_window_installs_a_release_and_the_others_hear_it_is_installed() {
        let restart = AppRestart::default();
        let now = Instant::now();
        assert_eq!(restart.claim("0.13.1", now), UpdateClaim::Claimed);
        // Before, a second window's Update now ran a second install alongside.
        assert_eq!(restart.claim("0.13.1", now), UpdateClaim::Busy);
        restart.finish(restart.claimed("0.13.1").unwrap(), true);
        assert_eq!(restart.claim("0.13.1", now), UpdateClaim::Installed);
        // A release published after that one installs over it.
        assert_eq!(restart.claim("0.13.2", now), UpdateClaim::Claimed);
    }

    #[test]
    fn a_failed_install_lets_another_window_try() {
        let restart = AppRestart::default();
        let now = Instant::now();
        assert_eq!(restart.claim("0.13.1", now), UpdateClaim::Claimed);
        // Only a claimed release can be installed.
        assert_eq!(restart.claimed("0.13.0"), None);
        restart.finish(restart.claimed("0.13.1").unwrap(), false);
        assert_eq!(restart.claim("0.13.1", now), UpdateClaim::Claimed);
    }

    #[test]
    fn an_install_outlives_the_window_that_started_it() {
        let restart = AppRestart::default();
        let now = Instant::now();
        assert_eq!(restart.claim("0.13.1", now), UpdateClaim::Claimed);
        let claim = restart.claimed("0.13.1").unwrap();
        // The installing window reloads or closes; its download carries on, so
        // the reloaded page's auto check must not start a second one.
        restart.forget("main");
        assert_eq!(restart.claim("0.13.1", now), UpdateClaim::Busy);
        // The install's own end releases the claim.
        restart.finish(claim, true);
        assert_eq!(restart.claim("0.13.1", now), UpdateClaim::Installed);
    }

    #[test]
    fn a_claim_whose_install_never_ends_lapses() {
        let restart = AppRestart::default();
        let start = Instant::now();
        assert_eq!(restart.claim("0.13.1", start), UpdateClaim::Claimed);
        let stuck = restart.claimed("0.13.1").unwrap();
        let almost = start + INSTALL_LEASE - Duration::from_secs(1);
        assert_eq!(restart.claim("0.13.1", almost), UpdateClaim::Busy);
        // Held forever, every window would hear "another window is installing" until quit.
        let later = start + INSTALL_LEASE;
        assert_eq!(restart.claim("0.13.1", later), UpdateClaim::Claimed);
        // The stuck install ending at last leaves the newer claim in place.
        restart.finish(stuck, false);
        assert_eq!(restart.claim("0.13.1", later), UpdateClaim::Busy);
    }

    #[test]
    fn agent_turns_are_counted_per_window_until_the_page_goes() {
        let restart = AppRestart::default();
        restart.set_agent_turn("main", true);
        restart.set_agent_turn("main", true);
        restart.set_agent_turn("project-2", true);
        assert_eq!(restart.agent_turns(), 2);
        restart.set_agent_turn("project-2", false);
        restart.forget("main");
        assert_eq!(restart.agent_turns(), 0);
    }
}
