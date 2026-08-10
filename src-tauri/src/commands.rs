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

/// A Python CLI Lattice drives through uvx.
///
/// Do not resolve from `PATH`: an editable or stale global install would make
/// the app behave differently on every machine. uvx owns the cached environment
/// and resolves the explicit requirement for each invocation.
pub struct UvTool {
    /// The PyPI distribution that provides the command.
    pub requirement: &'static str,
    pub binary: &'static str,
    /// Set this to an executable's path to run that instead, for working on
    /// the tool itself. Opt-in, so it cannot happen by accident the way an
    /// installed copy on `PATH` did.
    pub override_env: &'static str,
}

/// Resolves arXiv ids, DOIs and titles to verified BibTeX, and owns the
/// project's `.bib`.
/// Pinned exactly, like ARXIV2MD below: `@latest` made uvx refresh PyPI
/// metadata on every invocation, putting a network round trip (or three —
/// add, tidy, remove each spawn their own) in front of every citation even
/// when the cached environment was already current. With an exact pin a
/// cached environment is reused without touching the network; the pin is
/// bumped with app releases and `prewarm_literature_tools` rebuilds the
/// environment right after an update instead of mid-import.
pub const BIBCITE: UvTool = UvTool {
    requirement: "bibcite-cli==0.6.2",
    binary: "bibcite",
    override_env: "LATTICE_BIBCITE_BIN",
};

/// Converts an arXiv paper to markdown Lattice and the agent can read.
pub const ARXIV2MD: UvTool = UvTool {
    requirement: "arxiv2markdown @ git+https://github.com/leo1oel/arxiv2md.git@d538c37faeb5633f6f75345f63b394375dd9b946",
    binary: "arxiv2md",
    override_env: "LATTICE_ARXIV2MD_BIN",
};

impl UvTool {
    /// A command that refreshes and runs the newest stable tool release.
    pub fn command(&self) -> Command {
        if let Some(path) = env::var_os(self.override_env).filter(|value| !value.is_empty()) {
            let mut command = Command::new(path);
            command.env("PATH", child_path());
            return command;
        }
        let mut command = command("uvx");
        command
            .env("UV_CACHE_DIR", uv_cache_dir())
            .arg("--from")
            .arg(self.requirement)
            .arg(self.binary);
        command
    }
}

/// Build (or confirm) the cached environments for both literature tools so
/// the first import after install or update does not pay the download-and-
/// build cost while the user watches a spinner. Runs `--help` because it is
/// the cheapest invocation that forces uvx to materialize the environment.
/// Failures only log: the import path still builds on demand as before, and
/// a machine without `uv` gets its real error from the first import.
pub fn prewarm_literature_tools() {
    for tool in [&BIBCITE, &ARXIV2MD] {
        let started = std::time::Instant::now();
        match tool.command().arg("--help").output() {
            Ok(output) if output.status.success() => log::info!(
                target: "lattice::literature",
                "{} environment ready in {:.1}s",
                tool.binary,
                started.elapsed().as_secs_f32()
            ),
            Ok(output) => log::warn!(
                target: "lattice::literature",
                "{} prewarm exited with {}: {}",
                tool.binary,
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(error) => log::warn!(
                target: "lattice::literature",
                "{} prewarm could not run: {error}",
                tool.binary
            ),
        }
    }
}

/// Where `uvx` keeps the environments it builds for the tools above.
///
/// Under the user's cache directory rather than `/tmp`, which macOS clears:
/// from there every reboot re-downloaded both tools before the first paper of
/// the day. `@latest` still refreshes package metadata, while unchanged wheels
/// and environments continue to come from this cache.
pub fn uv_cache_dir() -> PathBuf {
    match env::var_os("HOME") {
        Some(home) => PathBuf::from(home).join("Library/Caches/app.leo1oel.researchwriter/uv"),
        None => PathBuf::from("/tmp/research-writer-uv-cache"),
    }
}

/// Where arxiv2md keeps the source HTML it caches between conversions.
///
/// It defaults to `.arxiv2md_cache` beside the working directory, and the paper
/// pipeline runs it inside the bundle it is building — so every fetched paper
/// shipped a copy of its own raw HTML into the project, unreferenced by the
/// manifest and never reused, because each fetch builds a fresh directory.
/// Pointing it at the app's cache instead both keeps bundles clean and lets the
/// cache do its job; arxiv2md expires it after a day and caps its own size.
pub fn arxiv2md_cache_dir() -> PathBuf {
    match env::var_os("HOME") {
        Some(home) => {
            PathBuf::from(home).join("Library/Caches/app.leo1oel.researchwriter/arxiv2md")
        }
        None => PathBuf::from("/tmp/research-writer-arxiv2md-cache"),
    }
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
        Vec::new()
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

    #[test]
    fn python_tools_use_their_explicit_requirements() {
        for tool in [&BIBCITE, &ARXIV2MD] {
            let command = tool.command();
            let args: Vec<_> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert!(args
                .windows(2)
                .any(|pair| pair == ["--from", tool.requirement]));
        }
        // An exact pin, never `@latest`: a floating requirement makes uvx
        // refresh PyPI metadata on every bibcite invocation, which put a
        // network round trip in front of each citation.
        assert!(BIBCITE.requirement.starts_with("bibcite-cli=="));
        assert_eq!(
            ARXIV2MD.requirement,
            "arxiv2markdown @ git+https://github.com/leo1oel/arxiv2md.git@d538c37faeb5633f6f75345f63b394375dd9b946"
        );
    }

    #[test]
    fn the_converter_caches_its_html_outside_the_project() {
        // arxiv2md defaults to `.arxiv2md_cache` beside the working directory,
        // and the paper pipeline runs it inside the bundle it is building, so
        // an unset cache path ships the raw HTML of every paper to the user.
        let cache = arxiv2md_cache_dir();
        assert!(cache.is_absolute(), "got: {cache:?}");
        assert!(!cache.ends_with(".arxiv2md_cache"), "got: {cache:?}");
        assert!(
            std::include_str!("papers.rs").contains("\"ARXIV2MD_CACHE_PATH\""),
            "the fetch pipeline must point the converter's cache away from the bundle"
        );
    }
}
