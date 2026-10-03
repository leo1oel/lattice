//! The JavaScript runtime and process lifetime shared by the Synara and Open
//! Slide sidecars.

use crate::commands::{in_new_process_group, signal_process_group};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant},
};

/// The standalone Node that `scripts/prepare-synara-sidecar.mjs` stages in
/// `synara-runtime/bin`, the same in development and release builds.
#[derive(Clone, Default)]
pub(crate) struct NodeRuntime {
    pub(crate) executable: PathBuf,
}

impl NodeRuntime {
    pub(crate) fn resolve(standalone_bin: &Path) -> Self {
        Self { executable: standalone_bin.join("node") }
    }

    /// Run the entry point in a fresh process group, so
    /// [`terminate_process_group`] also reaches every descendant.
    pub(crate) fn configure(&self, command: &mut Command) {
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
    use super::NodeRuntime;
    use std::path::Path;

    #[test]
    fn sidecars_run_on_the_standalone_node() {
        let runtime = NodeRuntime::resolve(Path::new("/resources/synara-runtime/bin"));
        assert_eq!(runtime.executable, Path::new("/resources/synara-runtime/bin/node"));
    }
}
