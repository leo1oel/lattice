//! Restarting Lattice into an update: which window installs it, and what a
//! restart would stop.
//!
//! Every window runs its own updater, and each one checks for releases. Two
//! windows installing the same release at once replace the app bundle twice
//! without a lock between them, and the first to finish ends the process
//! halfway through the other's replacement. `UpdateInstall` lets one window
//! install; the others hear that it is under way, or done.
//!
//! A restart also ends terminal commands, builds and agent turns. The window
//! offering it asks `restart_impact` first and warns about what is running.
//! Terminals and builds are the backend's own; an agent turn runs in a
//! window's agent panel, which reports it (`set_agent_turn_running`).

use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};

use tauri::{State, WebviewWindow};

use crate::app_state::AppState;

#[derive(Debug, Default, PartialEq, Eq)]
enum Install {
    #[default]
    Idle,
    Installing(String),
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

#[derive(Default)]
pub struct AppRestart {
    install: Mutex<Install>,
    /// Windows whose agent panel has a turn running or waiting on the writer.
    agent_turns: Mutex<HashSet<String>>,
}

impl AppRestart {
    fn claim(&self, version: &str) -> UpdateClaim {
        let mut install = self.install.lock().unwrap_or_else(PoisonError::into_inner);
        match &*install {
            Install::Installing(_) => UpdateClaim::Busy,
            Install::Installed(installed) if installed == version => UpdateClaim::Installed,
            // Nothing under way, or a newer release than the one installed.
            _ => {
                *install = Install::Installing(version.to_string());
                UpdateClaim::Claimed
            }
        }
    }

    fn finish(&self, version: &str, installed: bool) {
        let mut install = self.install.lock().unwrap_or_else(PoisonError::into_inner);
        if *install == Install::Installing(version.to_string()) {
            *install =
                if installed { Install::Installed(version.to_string()) } else { Install::Idle };
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

    /// The window's page went away, and its agent panel with it.
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
    state.claim(&version)
}

/// The install this window claimed ended: `installed`, or failed (and another
/// window may try).
#[tauri::command]
pub fn finish_update_install(state: State<'_, AppRestart>, version: String, installed: bool) {
    state.finish(&version, installed);
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
    use super::{AppRestart, UpdateClaim};

    #[test]
    fn one_window_installs_a_release_and_the_others_hear_it_is_installed() {
        let restart = AppRestart::default();
        assert_eq!(restart.claim("0.13.1"), UpdateClaim::Claimed);
        // Before, a second window's Update now ran a second install alongside.
        assert_eq!(restart.claim("0.13.1"), UpdateClaim::Busy);
        restart.finish("0.13.1", true);
        assert_eq!(restart.claim("0.13.1"), UpdateClaim::Installed);
        // A release published after that one installs over it.
        assert_eq!(restart.claim("0.13.2"), UpdateClaim::Claimed);
    }

    #[test]
    fn a_failed_install_lets_another_window_try() {
        let restart = AppRestart::default();
        assert_eq!(restart.claim("0.13.1"), UpdateClaim::Claimed);
        // Only the install under way can be ended.
        restart.finish("0.13.0", false);
        assert_eq!(restart.claim("0.13.1"), UpdateClaim::Busy);
        restart.finish("0.13.1", false);
        assert_eq!(restart.claim("0.13.1"), UpdateClaim::Claimed);
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
