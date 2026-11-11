//! Finding TeX programs the way Lattice does: a GUI launch's `PATH` rarely
//! includes `/Library/TeX/texbin` or a TeX Live tree, so known TeX locations
//! are searched first and handed to every child process.

use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// A `Command` for `name`, resolved against the TeX-aware search path, whose
/// children inherit that same path.
pub fn command(name: &str) -> Command {
    let mut command = Command::new(resolve(name));
    command.env("PATH", child_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The executable `name` resolves to, or the bare name when none is found.
pub fn resolve(name: &str) -> PathBuf {
    let names = executable_names(name);
    command_directories()
        .into_iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| is_executable(path))
        .unwrap_or_else(|| PathBuf::from(name))
}

/// Whether `name` resolves to an executable.
pub fn available(name: &str) -> bool {
    is_executable(&resolve(name))
}

/// The search path children are started with.
pub fn child_path() -> OsString {
    env::join_paths(command_directories()).unwrap_or_default()
}

fn executable_names(name: &str) -> Vec<String> {
    if cfg!(windows) && Path::new(name).extension().is_none() {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|extension| format!("{name}.{extension}"))
            .chain([name.to_string()])
            .collect()
    } else {
        vec![name.to_string()]
    }
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn command_directories() -> Vec<PathBuf> {
    let mut directories = tex_directories();
    #[cfg(unix)]
    {
        directories
            .extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            directories.push(home.join(".local/bin"));
        }
    }
    #[cfg(windows)]
    {
        if let Some(root) = env::var_os("SystemRoot") {
            directories.push(PathBuf::from(root).join("System32"));
        }
    }
    if let Some(path) = env::var_os("PATH") {
        directories.extend(env::split_paths(&path));
    }
    directories.extend(macos_path_helper_directories());

    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

/// Where TeX distributions install their programs.
pub fn tex_directories() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        windows_tex_directories()
    }
    #[cfg(not(windows))]
    {
        let mut directories = vec![PathBuf::from("/Library/TeX/texbin")];
        directories.extend(discover_texlive_bins(Path::new("/usr/local/texlive")));
        directories.extend(discover_texlive_bins(Path::new("/opt/homebrew/texlive")));
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            directories.extend(discover_texlive_bins(&home.join("Library/TinyTeX")));
        }
        directories
    }
}

#[cfg(windows)]
fn windows_tex_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for name in ["ProgramFiles", "LOCALAPPDATA"] {
        if let Some(root) = env::var_os(name).map(PathBuf::from) {
            directories.push(root.join("MiKTeX/miktex/bin/x64"));
            directories.push(root.join("Programs/MiKTeX/miktex/bin/x64"));
            directories.push(root.join("Programs/TinyTeX/bin/windows"));
        }
    }
    if let Some(root) = env::var_os("APPDATA") {
        directories.push(PathBuf::from(root).join("TinyTeX/bin/windows"));
    }
    if let Some(root) = env::var_os("ProgramData") {
        directories.push(PathBuf::from(root).join("MiKTeX/miktex/bin/x64"));
    }
    let drive = env::var_os("SystemDrive").unwrap_or_else(|| "C:".into());
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
    {
        Vec::new()
    }
    #[cfg(target_os = "macos")]
    {
        let Ok(output) = Command::new("/usr/libexec/path_helper").arg("-s").output() else {
            return Vec::new();
        };
        // PATH="/a:/b:/c"; export PATH;
        let text = String::from_utf8_lossy(&output.stdout);
        match text
            .split_once("PATH=\"")
            .and_then(|(_, rest)| rest.split_once('"'))
        {
            Some((path, _)) if output.status.success() => env::split_paths(path).collect(),
            _ => Vec::new(),
        }
    }
}
