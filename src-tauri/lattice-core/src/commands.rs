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

#[cfg(target_os = "linux")]
mod appimage;
mod python_tools;

#[cfg(target_os = "linux")]
pub(crate) use appimage::{host_environment, outside_appimage};
#[cfg(all(test, unix))]
pub(crate) use python_tools::UvTool;
pub use python_tools::{
    arxiv2md_cache_dir, prewarm_literature_tools, ARXIV2MD, ARXIV_SOURCE2MD, BIBCITE,
};
// Tests keep the preamble formats, its only other user, out of the user's cache.
#[cfg_attr(test, allow(unused_imports))]
pub(crate) use python_tools::app_cache_dir;
pub(crate) use python_tools::{bibcite_output_cancellable, redact_bibcite_output};

pub(crate) const KILL_SIGNAL: libc::c_int = 9;
pub(crate) const TERM_SIGNAL: libc::c_int = 15;

pub const MANAGED_UV_VERSION: &str = "0.12.3";

pub fn command(name: &str) -> Command {
    with_child_path(Command::new(resolve(name)))
}

/// `command` with the search path `command()` hands its children, and the
/// host's environment rather than Lattice's AppImage's (`appimage`).
pub(crate) fn with_child_path(mut command: Command) -> Command {
    host_environment(&mut command);
    command.env("PATH", child_path());
    #[cfg(windows)]
    crate::platform_windows::configure(&mut command);
    command
}

/// Start the child as the leader of a new process group, so everything it
/// launches can be signalled together with `signal_process_group`.
pub(crate) fn in_new_process_group(command: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
        // The group is stopped with SIGTERM (`signal_process_group`), so it
        // must start able to receive it. A child inherits the spawning
        // thread's signal mask (std no longer clears it) and any signal its
        // parent ignores, and both happen: the GPUI app spawns builds from
        // libdispatch's worker threads, which block signals, and a Cocoa app
        // can ignore SIGTERM to take it as a quit. The whole group then
        // shrugged off the TERM that was to stop it, and a build that looped
        // could not be stopped.
        // SAFETY: `sigemptyset`, `pthread_sigmask` and `signal` are
        // async-signal-safe, the only calls made between fork and exec.
        unsafe {
            command.pre_exec(|| {
                let mut none = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
                libc::sigemptyset(none.as_mut_ptr());
                libc::pthread_sigmask(libc::SIG_SETMASK, none.as_ptr(), std::ptr::null_mut());
                libc::signal(libc::SIGTERM, libc::SIG_DFL);
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    crate::platform_windows::configure(command);
    command
}

/// Own the Windows job until this operation finishes. Unix already retains
/// descendants through the process-group id established before spawning.
pub(crate) struct ProcessGroup {
    #[cfg(windows)]
    _job: crate::platform_windows::TrackedGroup,
}
pub(crate) fn track_process_group(
    child: &mut std::process::Child,
) -> std::io::Result<ProcessGroup> {
    #[cfg(windows)]
    return match crate::platform_windows::track_group(child.id()) {
        Ok(job) => Ok(ProcessGroup { _job: job }),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    };
    #[cfg(unix)]
    {
        let _ = child;
        Ok(ProcessGroup {})
    }
}

/// Send `signal` to a group started by `in_new_process_group`. The negative
/// pid names the group, which the child leads, so it cannot reach Lattice.
pub(crate) fn signal_process_group(pid: u32, signal: libc::c_int) {
    #[cfg(windows)]
    {
        let _ = signal;
        crate::platform_windows::terminate_tree(pid);
    }
    #[cfg(unix)]
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
    #[cfg(windows)]
    return env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join(crate::app_identity::identifier()));
    #[cfg(not(windows))]
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
        .join(executable_name(name));
    #[cfg(windows)]
    let path = if !path.is_file() {
        bundled_tools_dir()
            .map(|root| root.join(executable_name(name)))
            .filter(|path| path.is_file())
            .unwrap_or(path)
    } else {
        path
    };
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
    let output = with_child_path(Command::new(path))
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

fn executable_name(name: &str) -> OsString {
    #[cfg(windows)]
    if Path::new(name).extension().is_none() {
        return format!("{name}.exe").into();
    }
    name.into()
}

pub fn resolve(name: &str) -> PathBuf {
    let names = {
        #[cfg(windows)]
        {
            if Path::new(name).extension().is_none() {
                vec![
                    format!("{name}.exe"),
                    format!("{name}.cmd"),
                    format!("{name}.bat"),
                    name.to_string(),
                ]
            } else {
                vec![name.to_string()]
            }
        }
        #[cfg(not(windows))]
        {
            vec![name.to_string()]
        }
    };
    command_directories()
        .into_iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| is_executable(path))
        .unwrap_or_else(|| PathBuf::from(executable_name(name)))
}

pub fn available(name: &str) -> bool {
    is_executable(&resolve(name))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        path.is_file() && rustix::fs::access(path, rustix::fs::Access::EXEC_OK).is_ok()
    }
    #[cfg(windows)]
    {
        path.is_file()
            && path.extension().is_some_and(|ext| {
                ["exe", "com", "cmd", "bat"].iter().any(|known| ext.eq_ignore_ascii_case(known))
            })
    }
}

pub(crate) fn child_path() -> OsString {
    env::join_paths(command_directories())
        .unwrap_or_else(|_| env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin")))
}

/// Only a Linux AppImage has an environment of its own to keep from children.
#[cfg(not(target_os = "linux"))]
pub(crate) fn host_environment(command: &mut Command) -> &mut Command {
    command
}

/// Off Linux, no folder is an AppImage's.
#[cfg(not(target_os = "linux"))]
pub(crate) fn outside_appimage(directories: Vec<PathBuf>) -> Vec<PathBuf> {
    directories
}

/// Executable launchers shipped with Lattice's JavaScript runtime.
///
/// `bibcite` finds its formatter through PATH. During development that launcher
/// uses the adjacent standalone Node; the packaged macOS app resolves the same
/// directory under Resources, beside the same standalone Node.
fn bundled_tools_dir() -> Option<PathBuf> {
    if let Some(bundle) = crate::host::development_bundle() {
        return Some(bundle.join("synara-runtime/bin"));
    }
    #[cfg(windows)]
    return env::current_exe().ok()?.parent().map(|root| root.join("synara-runtime/bin"));
    #[cfg(not(windows))]
    let contents = env::current_exe().ok()?.parent()?.parent()?.to_path_buf();
    #[cfg(not(windows))]
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
    directories.extend(tex_directories());
    #[cfg(unix)]
    {
        directories
            .extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            directories.extend([home.join(".local/bin"), home.join(".cargo/bin")]);
        }
    }
    #[cfg(windows)]
    {
        for (variable, suffix) in [
            ("USERPROFILE", ".cargo/bin"),
            ("USERPROFILE", ".local/bin"),
            ("APPDATA", "npm"),
            ("LOCALAPPDATA", "Programs/Git/cmd"),
            ("ProgramFiles", "Git/cmd"),
            ("ProgramFiles", "PowerShell/7"),
            ("SystemRoot", "System32"),
            ("SystemRoot", "System32/WindowsPowerShell/v1.0"),
        ] {
            if let Some(root) = env::var_os(variable) {
                directories.push(PathBuf::from(root).join(suffix));
            }
        }
    }
    if let Some(path) = env::var_os("PATH") {
        directories.extend(env::split_paths(&path));
    }
    directories.extend(macos_path_helper_directories());

    // No folder inside Lattice's AppImage, from AppRun's PATH or its own layout (`appimage`).
    let mut directories = outside_appimage(directories);
    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

/// Where TeX installs its programs, among the directories above: what a
/// terminal's shell adds to its search path (terminal/pty.rs).
pub(crate) fn tex_directories() -> Vec<PathBuf> {
    #[cfg(windows)]
    return windows_tex_directories_in(&|name| env::var_os(name));
    #[cfg(not(windows))]
    let mut directories = vec![PathBuf::from("/Library/TeX/texbin")];
    #[cfg(not(windows))]
    {
        directories.extend(discover_texlive_bins(Path::new("/usr/local/texlive")));
        directories.extend(discover_texlive_bins(Path::new("/opt/homebrew/texlive")));
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            directories.extend(discover_texlive_bins(&home.join("Library/TinyTeX")));
        }
        directories
    }
}

/// The TeX programs folders on Windows, best first. The TeX Live Lattice
/// installed itself (`tex_setup/tex_live.rs` `install_location`, under the
/// user's profile, never in the shared `C:\texlive`) comes before every other
/// distribution: the machines where the setup dialog appears are the ones whose
/// existing TeX is broken or old (a MiKTeX without Perl, a `C:\texlive\2025`
/// that is incomplete), and after the install a build must use the new one.
/// `env` reads the environment, so a test can describe any machine.
#[cfg(windows)]
fn windows_tex_directories_in(env: &dyn Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(root) = env("LOCALAPPDATA") {
        directories.extend(discover_texlive_bins(&PathBuf::from(root).join("Programs/texlive")));
    }
    for name in ["ProgramFiles", "LOCALAPPDATA"] {
        if let Some(root) = env(name).map(PathBuf::from) {
            directories.push(root.join("MiKTeX/miktex/bin/x64"));
            directories.push(root.join("Programs/MiKTeX/miktex/bin/x64"));
            directories.push(root.join("Programs/TinyTeX/bin/windows"));
        }
    }
    if let Some(root) = env("APPDATA") {
        directories.push(PathBuf::from(root).join("TinyTeX/bin/windows"));
    }
    if let Some(root) = env("ProgramData") {
        directories.push(PathBuf::from(root).join("MiKTeX/miktex/bin/x64"));
    }
    let drive = env("SystemDrive").unwrap_or_else(|| "C:".into());
    directories.extend(discover_texlive_bins(&PathBuf::from(format!(
        "{}\\texlive",
        drive.to_string_lossy()
    ))));
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
    #[cfg(not(target_os = "macos"))]
    return Vec::new();
    #[cfg(target_os = "macos")]
    {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
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
        #[cfg(target_os = "macos")]
        assert!(env::split_paths(path).any(|entry| entry == Path::new("/Library/TeX/texbin")));
    }

    /// The TeX Live Lattice installed beats a MiKTeX and an older `C:\texlive`
    /// that are already there, so a build after the install does not resolve the
    /// old, possibly broken tools.
    #[cfg(windows)]
    #[test]
    fn windows_searches_the_per_user_tex_live_before_older_installs() {
        use crate::test_support::TempDir;
        let machine = TempDir::new("tex-order");
        let local = machine.join("Local");
        let program_files = machine.join("Program Files");
        // `SystemDrive` is a drive letter on a real machine; here it names the
        // scratch folder that holds this machine's `texlive`.
        let system = machine.join("System");
        let per_user = machine.write("Local/Programs/texlive/2026/bin/windows/latexmk.exe", "");
        let old_shared = machine.write("System/texlive/2025/bin/windows/latexmk.exe", "");
        let env = |name: &str| -> Option<OsString> {
            match name {
                "LOCALAPPDATA" => Some(local.clone().into_os_string()),
                "ProgramFiles" => Some(program_files.clone().into_os_string()),
                "SystemDrive" => Some(system.clone().into_os_string()),
                _ => None,
            }
        };
        let directories = windows_tex_directories_in(&env);
        let position = |folder: &Path| {
            directories
                .iter()
                .position(|entry| entry == folder)
                .unwrap_or_else(|| panic!("{} missing from {directories:?}", folder.display()))
        };
        let miktex = program_files.join("MiKTeX/miktex/bin/x64");
        let per_user_bin = per_user.parent().unwrap();
        let old_bin = old_shared.parent().unwrap();
        assert_eq!(position(per_user_bin), 0, "the per-user TeX Live comes first");
        assert!(position(&miktex) < position(old_bin), "MiKTeX stays ahead of a shared TeX Live");
    }
}
