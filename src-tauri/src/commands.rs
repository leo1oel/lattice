//! External processes, found the way a GUI-launched app has to find them.
//!
//! Not Tauri commands: this is the base layer every tool invocation goes
//! through. `command()` resolves an executable against Lattice's own tool
//! directories, the known TeX locations and the login shell's PATH (a Finder
//! launch inherits almost none of it), and hands children the same search
//! path. The pinned Python CLIs Lattice drives through the app-managed uv
//! live in `python_tools`.

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

mod python_tools;

#[cfg(test)]
pub(crate) use python_tools::UvTool;
pub use python_tools::{
    arxiv2md_cache_dir, prewarm_literature_tools, ARXIV2MD, ARXIV_SOURCE2MD, BIBCITE,
};
pub(crate) use python_tools::{bibcite_output_cancellable, redact_bibcite_output};

pub const MANAGED_UV_VERSION: &str = "0.12.3";

pub fn command(name: &str) -> Command {
    with_child_path(Command::new(resolve(name)))
}

/// `command` with the search path `command()` hands its children.
pub(crate) fn with_child_path(mut command: Command) -> Command {
    command.env("PATH", child_path());
    command
}

/// Start the child as the leader of a new process group, so everything it
/// launches can be signalled together with `signal_process_group`.
pub(crate) fn in_new_process_group(command: &mut Command) -> &mut Command {
    std::os::unix::process::CommandExt::process_group(command, 0);
    command
}

/// Send `signal` to a group started by `in_new_process_group`. The negative
/// pid names the group, which the child leads, so it cannot reach Lattice.
pub(crate) fn signal_process_group(pid: u32, signal: libc::c_int) {
    if let Ok(group) = i32::try_from(pid) {
        unsafe {
            libc::kill(-group, signal);
        }
    }
}

/// Stdout followed by stderr, as one log.
pub(crate) fn combined_output(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// The child's trimmed stderr, or `fallback` when it printed nothing there.
pub(crate) fn stderr_or(output: &Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        fallback.to_string()
    } else {
        stderr
    }
}

/// Lattice-owned command-line tools that should not depend on Homebrew or the
/// environment inherited by a GUI launch.
pub fn managed_tools_dir() -> Option<PathBuf> {
    app_support_dir()
        .map(|directory| directory.join("bin").join(format!("uv-{MANAGED_UV_VERSION}")))
}

/// This build's own folder under Application Support.
pub(crate) fn app_support_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library/Application Support")
            .join(crate::app_identity::identifier())
    })
}

/// The managed `uv` or `uvx`, once it runs and reports the pinned version.
pub fn managed_uv_tool_status(name: &str) -> Result<PathBuf, String> {
    let path = managed_tools_dir()
        .ok_or_else(|| "Could not locate your macOS Application Support folder.".to_string())?
        .join(name);
    uv_tool_status_at(&path, name)?;
    Ok(path)
}

pub(crate) fn uv_tool_status_at(path: &Path, name: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{} is not installed: {error}", path.display()))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || !is_executable(path)
    {
        return Err(format!("{} is not a regular executable file.", path.display()));
    }
    let output = Command::new(path)
        .arg("--version")
        .output()
        .map_err(|error| format!("{} could not run: {error}", path.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} exited with {}: {}",
            path.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version_line =
        stdout.lines().find(|line| !line.trim().is_empty()).unwrap_or_default().trim();
    let mut fields = version_line.split_whitespace();
    if fields.next() != Some(name) || fields.next() != Some(MANAGED_UV_VERSION) {
        return Err(format!(
            "{} reported {version_line:?}; Lattice requires {name} {MANAGED_UV_VERSION}.",
            path.display()
        ));
    }
    Ok(())
}

pub fn resolve(name: &str) -> PathBuf {
    command_directories()
        .into_iter()
        .map(|directory| directory.join(name))
        .find(|path| is_executable(path))
        .unwrap_or_else(|| PathBuf::from(name))
}

pub fn available(name: &str) -> bool {
    is_executable(&resolve(name))
}

fn is_executable(path: &Path) -> bool {
    path.is_file() && rustix::fs::access(path, rustix::fs::Access::EXEC_OK).is_ok()
}

fn child_path() -> OsString {
    env::join_paths(command_directories())
        .unwrap_or_else(|_| env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin")))
}

/// Executable launchers shipped with Lattice's JavaScript runtime.
///
/// `bibcite` finds its formatter through PATH. During development that launcher
/// uses the adjacent standalone Node; the packaged macOS app resolves the same
/// directory under Resources, beside the same standalone Node.
fn bundled_tools_dir() -> Option<PathBuf> {
    if tauri::is_dev() {
        return Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("synara-runtime/bin"));
    }
    let contents = env::current_exe().ok()?.parent()?.parent()?.to_path_buf();
    Some(contents.join("Resources/synara-runtime/bin"))
}

fn command_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    // App-owned tools must win over stale Homebrew, shell PATH, and any
    // unrelated executable that happens to live in a TeX tree.
    directories.extend(managed_tools_dir());
    directories.extend(bundled_tools_dir());
    // Known TeX locations next: a GUI launch's PATH rarely includes
    // /Library/TeX/texbin, even after MacTeX/BasicTeX install. Rediscovered on
    // every call so Recheck works without quitting after a fresh install.
    directories.push(PathBuf::from("/Library/TeX/texbin"));
    directories.extend(discover_texlive_bins(Path::new("/usr/local/texlive")));
    directories.extend(discover_texlive_bins(Path::new("/opt/homebrew/texlive")));
    directories
        .extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        directories.extend([home.join(".local/bin"), home.join(".cargo/bin")]);
        directories.extend(discover_texlive_bins(&home.join("Library/TinyTeX")));
    }
    if let Some(path) = env::var_os("PATH") {
        directories.extend(env::split_paths(&path));
    }
    directories.extend(macos_path_helper_directories());

    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

/// `<root>/<year>/bin/<arch>` directories, newest tree first (year names sort
/// lexicographically: 2025, 2025basic, 2024).
fn discover_texlive_bins(root: &Path) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|year| fs::read_dir(year.path().join("bin")).ok())
        .flat_map(|archs| archs.flatten().map(|arch| arch.path()))
        .filter(|path| path.is_dir())
        .collect();
    directories.sort_by(|left, right| right.cmp(left));
    directories
}

/// The login PATH macOS assembles from /etc/paths and /etc/paths.d.
fn macos_path_helper_directories() -> Vec<PathBuf> {
    let Ok(output) = Command::new("/usr/libexec/path_helper").arg("-s").output() else {
        return Vec::new();
    };
    // PATH="/a:/b:/c"; export PATH;
    let text = String::from_utf8_lossy(&output.stdout);
    match text.split_once("PATH=\"").and_then(|(_, rest)| rest.split_once('"')) {
        Some((path, _)) if output.status.success() => env::split_paths(path).collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn resolves_only_executable_files() {
        assert!(available("sh"));
        let latexmk = Path::new("/Library/TeX/texbin/latexmk");
        if latexmk.is_file() {
            assert_eq!(resolve("latexmk"), latexmk, "the MacTeX tree wins over Homebrew");
            assert!(available("latexmk"));
        }
        let directory = crate::test_support::TempDir::new("command-permission");
        let script = directory.write("tool", "#!/bin/sh\nexit 0\n");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!is_executable(&script));
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(is_executable(&script));
    }

    #[test]
    fn child_commands_can_find_mactex_tools() {
        let command = command("sh");
        let path = command
            .get_envs()
            .find_map(|(name, value)| (name == "PATH").then_some(value).flatten())
            .unwrap();
        assert_eq!(
            env::split_paths(path).next(),
            managed_tools_dir(),
            "Lattice-owned tools must have PATH precedence"
        );
        assert!(env::split_paths(path).any(|entry| Some(entry) == bundled_tools_dir()));
        assert!(env::split_paths(path).any(|entry| entry == Path::new("/Library/TeX/texbin")));
    }
}
