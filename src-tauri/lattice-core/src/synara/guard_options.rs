//! The writer's two opt-ins for the Linux sandbox
//! (`bibliography_guard/linux.rs`), both off until they turn them on in
//! Settings › Agent › Environment:
//!
//! - `reduced_isolation` runs the agent where the kernel cannot keep it from
//!   the host's abstract sockets (no Landlock scope: before Linux 6.12, or a
//!   setuid bubblewrap). Without it the agent stays off there.
//! - `forward_ssh_agent` binds the SSH agent's socket into the sandbox.
//!
//! They are kept in a folder of their own beside the agent's, which the
//! sandbox gets read-only (`bibliography_guard/layout.rs`): the rest of
//! Lattice's data folder is the agent's to write, and it must not turn
//! either on for itself. A platform whose guard has no options keeps them as
//! saved and reads nothing from them.

use super::{restart, SynaraRuntime};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// In Lattice's data folder, beside the agent's own.
const FOLDER: &str = "agent-guard";
const FILE: &str = "options.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GuardOptions {
    pub reduced_isolation: bool,
    pub forward_ssh_agent: bool,
}

impl GuardOptions {
    /// The folder the options are kept in, for the agent whose own folder is
    /// `agent_home`.
    pub(super) fn folder(agent_home: &Path) -> Option<PathBuf> {
        agent_home.parent().map(|app_data| app_data.join(FOLDER))
    }

    /// What the writer saved. A file that is missing or cannot be read is
    /// both off: the guard never opens further for want of an answer.
    pub(super) fn load(agent_home: &Path) -> Self {
        Self::folder(agent_home)
            .and_then(|folder| fs::read_to_string(folder.join(FILE)).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save(self, agent_home: &Path) -> Result<(), String> {
        let failed = |error: std::io::Error| format!("Could not save the agent settings: {error}");
        let folder = Self::folder(agent_home)
            .ok_or_else(|| "Could not save the agent settings: no data folder.".to_string())?;
        fs::create_dir_all(&folder).map_err(failed)?;
        let file = folder.join(FILE);
        // Whole or not at all: a half-written file would read as both off.
        let temporary = folder.join(crate::util::atomic_write_temporary(file.as_os_str()));
        let text = serde_json::to_vec_pretty(&self).map_err(|error| error.to_string())?;
        fs::write(&temporary, text).map_err(failed)?;
        fs::rename(&temporary, &file).map_err(failed)
    }
}

/// The options with what Settings needs to show them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardOptionsReport {
    /// Whether this platform's guard reads the options at all: only Linux's.
    applies: bool,
    /// This system cannot keep the sandbox from the host's abstract sockets,
    /// so the agent stays off until `reduced_isolation` is on.
    needs_reduced_isolation: bool,
    #[serde(flatten)]
    options: GuardOptions,
}

impl SynaraRuntime {
    pub fn guard_options(&self) -> GuardOptionsReport {
        GuardOptionsReport {
            applies: cfg!(target_os = "linux"),
            needs_reduced_isolation: super::bibliography_guard::lacks_socket_scope(),
            options: GuardOptions::load(&self.home_dir),
        }
    }

    /// Save the options for the next agent start. A running agent keeps the
    /// sandbox it started in until it is restarted, which stops its turns and
    /// so is the writer's to ask for. With none running, every window asks
    /// again: one showing that the agent is off may now get it.
    pub fn set_guard_options(&self, options: GuardOptions) -> Result<GuardOptionsReport, String> {
        options.save(&self.home_dir)?;
        let running = self.running.lock().is_ok_and(|mut running| {
            running.as_mut().is_some_and(|current| matches!(current.child.try_wait(), Ok(None)))
        });
        if !running {
            restart::announce(self.events.as_deref());
        }
        Ok(self.guard_options())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn options_are_off_until_saved_and_off_again_when_unreadable() {
        let app_data = TempDir::new("guard-options");
        let agent_home = app_data.join("synara");
        assert_eq!(GuardOptions::load(&agent_home), GuardOptions::default());
        assert!(!GuardOptions::default().reduced_isolation);
        assert!(!GuardOptions::default().forward_ssh_agent);

        let saved = GuardOptions { reduced_isolation: true, forward_ssh_agent: false };
        saved.save(&agent_home).unwrap();
        assert_eq!(GuardOptions::load(&agent_home), saved);
        // Beside the agent's folder, not in it: the agent writes its own.
        let file = app_data.join(FOLDER).join(FILE);
        assert_eq!(fs::read_to_string(&file).unwrap().matches("true").count(), 1);

        // A field a later version adds, or one missing, leaves the rest.
        fs::write(&file, r#"{"forwardSshAgent":true,"later":1}"#).unwrap();
        let read = GuardOptions::load(&agent_home);
        assert_eq!(read, GuardOptions { reduced_isolation: false, forward_ssh_agent: true });
        fs::write(&file, "{").unwrap();
        assert_eq!(GuardOptions::load(&agent_home), GuardOptions::default());
    }

    #[test]
    fn saving_reports_the_options_back_to_settings() {
        let app_data = TempDir::new("guard-options-runtime");
        let mut runtime = SynaraRuntime::default();
        runtime.home_dir = app_data.join("synara");
        assert_eq!(runtime.guard_options().options, GuardOptions::default());
        let options = GuardOptions { reduced_isolation: false, forward_ssh_agent: true };
        let report = runtime.set_guard_options(options).unwrap();
        assert_eq!(report.options, options);
        assert_eq!(report.applies, cfg!(target_os = "linux"));
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["forwardSshAgent"], true);
        assert_eq!(json["reducedIsolation"], false);
        assert!(json["needsReducedIsolation"].is_boolean());
    }
}
