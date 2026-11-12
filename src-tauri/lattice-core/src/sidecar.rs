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
        let executable = standalone_bin.join(if cfg!(windows) { "node.exe" } else { "node" });
        Self { executable: node_script_path(&executable) }
    }

    /// Run the entry point in a fresh process group, so
    /// [`terminate_process_group`] also reaches every descendant.
    pub(crate) fn configure(&self, command: &mut Command) {
        in_new_process_group(command);
    }
}

/// Node 24.20's JS realpath walk mishandles namespaced drive roots during
/// entry-point resolution (lstat reports EISDIR on `D:`). Pass ordinary drive
/// or UNC paths to Node, preserving UTF-16 and leaving other namespaces alone.
pub(crate) fn node_script_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let units: Vec<u16> = path.as_os_str().encode_wide().collect();
        let prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
        let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
        if units.starts_with(&unc) {
            let mut normal = vec![92, 92];
            normal.extend_from_slice(&units[unc.len()..]);
            return PathBuf::from(OsString::from_wide(&normal));
        }
        if units.starts_with(&prefix) && units.get(5) == Some(&58) {
            return PathBuf::from(OsString::from_wide(&units[prefix.len()..]));
        }
    }
    path.to_path_buf()
}

/// SIGTERM a sidecar's process group, allow a two-second grace period, then
/// SIGKILL whatever is left.
pub(crate) fn terminate_process_group(child: &mut Child) {
    signal_process_group(child.id(), crate::commands::TERM_SIGNAL);
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    signal_process_group(child.id(), crate::commands::KILL_SIGNAL);
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
        assert_eq!(
            runtime.executable,
            Path::new("/resources/synara-runtime/bin").join(if cfg!(windows) {
                "node.exe"
            } else {
                "node"
            })
        );
    }
}

#[cfg(all(test, windows))]
mod windows_path_tests {
    use super::node_script_path;
    use std::path::Path;

    #[test]
    fn node_entry_paths_preserve_unicode_and_unc_without_verbatim_roots() {
        for (source, expected) in [
            (r"\\?\D:\Lattice é 中文\server.mjs", r"D:\Lattice é 中文\server.mjs"),
            (r"\\?\UNC\server\share\server.mjs", r"\\server\share\server.mjs"),
            (r"D:\Lattice\server.mjs", r"D:\Lattice\server.mjs"),
            (r"\\?\Volume{abc}\server.mjs", r"\\?\Volume{abc}\server.mjs"),
        ] {
            assert_eq!(node_script_path(Path::new(source)), Path::new(expected));
        }
    }
}
