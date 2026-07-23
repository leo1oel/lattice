use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn command(name: &str) -> Command {
    let mut command = Command::new(resolve(name));
    command.env("PATH", child_path());
    command
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
    match fs::metadata(path) {
        Ok(meta) => meta.is_file(),
        Err(_) => false,
    }
}

fn child_path() -> OsString {
    env::join_paths(command_directories())
        .unwrap_or_else(|_| env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin")))
}

fn command_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    // Prefer known TeX locations first — GUI-launched apps often have a minimal PATH
    // that never includes /Library/TeX/texbin even after MacTeX/BasicTeX install.
    // Rediscover each call so Recheck works without quitting after a fresh install.
    directories.extend(discover_tex_directories());
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ]);
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        directories.push(home.join(".local/bin"));
        directories.push(home.join(".cargo/bin"));
        directories.extend(discover_texlive_bins(home.join("Library/TinyTeX")));
    }
    if let Some(path) = env::var_os("PATH") {
        directories.extend(env::split_paths(&path));
    }
    directories.extend(macos_path_helper_directories());

    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

fn discover_tex_directories() -> Vec<PathBuf> {
    let mut directories = vec![PathBuf::from("/Library/TeX/texbin")];
    directories.extend(discover_texlive_bins(PathBuf::from("/usr/local/texlive")));
    directories.extend(discover_texlive_bins(PathBuf::from(
        "/opt/homebrew/texlive",
    )));
    directories
}

fn discover_texlive_bins(root: PathBuf) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let Ok(years) = fs::read_dir(root) else {
        return directories;
    };
    for year in years.flatten() {
        let bin = year.path().join("bin");
        let Ok(archs) = fs::read_dir(&bin) else {
            continue;
        };
        for arch in archs.flatten() {
            let path = arch.path();
            if path.is_dir() {
                directories.push(path);
            }
        }
    }
    // Prefer newer trees first (lexicographic year names like 2025, 2025basic, 2024).
    directories.sort();
    directories.reverse();
    directories
}

fn macos_path_helper_directories() -> Vec<PathBuf> {
    #[cfg(not(target_os = "macos"))]
    {
        return Vec::new();
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/libexec/path_helper")
            .arg("-s")
            .output()
            .ok();
        let Some(output) = output else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&output.stdout);
        // PATH="/a:/b:/c"; export PATH;
        let Some(start) = text.find("PATH=\"") else {
            return Vec::new();
        };
        let rest = &text[start + 6..];
        let Some(end) = rest.find('"') else {
            return Vec::new();
        };
        env::split_paths(&rest[..end]).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_standard_system_command() {
        assert!(available("sh"));
    }

    #[test]
    fn child_commands_can_find_mactex_tools() {
        let command = command("sh");
        let path = command
            .get_envs()
            .find_map(|(name, value)| (name == "PATH").then_some(value).flatten())
            .unwrap();
        assert!(env::split_paths(path).any(|entry| entry == Path::new("/Library/TeX/texbin")));
    }

    #[test]
    fn prefers_library_tex_bin_when_present() {
        let latexmk = Path::new("/Library/TeX/texbin/latexmk");
        if latexmk.is_file() {
            assert_eq!(resolve("latexmk"), latexmk);
            assert!(available("latexmk"));
        }
    }
}
