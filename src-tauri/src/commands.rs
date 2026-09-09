use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

pub const MANAGED_UV_VERSION: &str = "0.12.3";

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
    requirement: "bibcite-cli==0.6.9",
    binary: "bibcite",
    override_env: "LATTICE_BIBCITE_BIN",
};

/// Converts an arXiv paper to markdown Lattice and the agent can read.
pub const ARXIV2MD: UvTool = UvTool {
    requirement: "arxiv2markdown @ git+https://github.com/leo1oel/arxiv2md.git@e19b6f6961a3df772cb6728548a7a872d438d775",
    binary: "arxiv2md",
    override_env: "LATTICE_ARXIV2MD_BIN",
};

/// Converts an arXiv TeX source archive when neither arXiv nor ar5iv could
/// render HTML. The package is a dependency-free source parser, not Pandoc or
/// a TeX distribution, so its cached environment is under 2 MB.
pub const ARXIV_SOURCE2MD: UvTool = UvTool {
    requirement: "arxiv-md==0.1.0",
    binary: "tex-to-md",
    override_env: "LATTICE_ARXIV_SOURCE2MD_BIN",
};

impl UvTool {
    /// A command that runs this tool's exact, app-tested requirement.
    pub fn command(&self) -> Result<Command, String> {
        let command =
            if let Some(path) = env::var_os(self.override_env).filter(|value| !value.is_empty()) {
                let mut command = Command::new(path);
                command.env("PATH", child_path());
                command
            } else {
                self.uvx_command()?
            };
        if self.binary == BIBCITE.binary {
            configure_bibcite(command)
        } else {
            Ok(command)
        }
    }

    fn uvx_command(&self) -> Result<Command, String> {
        // Validate the complete managed pair before every literature-tool
        // launch. Generic command resolution must never fall back to a stale
        // Homebrew/PATH uvx after setup has promised an app-owned version.
        managed_uv_tool_status("uv")?;
        let uvx = managed_uv_tool_status("uvx")?;
        Ok(self.configured_uvx_command(uvx))
    }

    fn configured_uvx_command(&self, uvx: PathBuf) -> Command {
        let mut command = Command::new(uvx);
        command
            .env("PATH", child_path())
            .env("UV_CACHE_DIR", uv_cache_dir())
            .arg("--from")
            .arg(self.requirement)
            .arg(self.binary);
        command
    }
}

fn configure_bibcite(command: Command) -> Result<Command, String> {
    let openalex = crate::literature_credentials::openalex_key()?;
    let semanticscholar = crate::literature_credentials::semanticscholar_key()?;
    let contact = crate::literature_credentials::crossref_contact()?;
    Ok(configure_bibcite_env(
        command,
        openalex,
        semanticscholar,
        contact,
    ))
}

fn configure_bibcite_env(
    mut command: Command,
    openalex: Option<String>,
    semanticscholar: Option<String>,
    contact: Option<String>,
) -> Command {
    command.env_remove("OPENALEX_API_KEY");
    command.env_remove("S2_API_KEY");
    command.env_remove("SEMANTIC_SCHOLAR_API_KEY");
    command.env_remove("BIBCITE_MAILTO");
    command.env_remove("BIBCITE_S2_BATCH_STATUS");
    command.env_remove("BIBCITE_CORE_SOURCES");
    command.env(
        "BIBCITE_PUBLIC_SERVICE_URL",
        crate::literature_service::ENDPOINT,
    );
    if let Some(key) = openalex {
        command.env("OPENALEX_API_KEY", key);
    }
    if let Some(key) = semanticscholar {
        // bibcite versions have recognized both names. Set both from the one
        // effective value so an inherited alias cannot outrank a saved key.
        command.env("S2_API_KEY", &key);
        command.env("SEMANTIC_SCHOLAR_API_KEY", key);
    } else {
        // No-key mode intentionally excludes every S2 route, including the
        // public service. Unlike an unavailable attempted batch, this does not
        // taint clean misses from the enabled publication sources.
        command.env("BIBCITE_S2_BATCH_STATUS", "disabled");
    }
    if let Some(email) = contact {
        command.env("BIBCITE_MAILTO", email);
    }
    command
}

/// Capture the command's actual keys, not the current vault (which a user may
/// have changed while this process ran). httpx can echo query-string keys in
/// errors; neither output stream may carry them into reports or app logs.
pub(crate) fn redact_bibcite_output(command: &Command, mut output: Output) -> Output {
    for (name, value) in command.get_envs() {
        if !matches!(
            name.to_str(),
            Some("OPENALEX_API_KEY" | "S2_API_KEY" | "SEMANTIC_SCHOLAR_API_KEY")
        ) {
            continue;
        }
        let Some(secret) = value.and_then(|v| v.to_str()).filter(|v| !v.is_empty()) else {
            continue;
        };
        let encoded = crate::openalex::urlencoding(secret);
        let json = serde_json::to_string(secret).unwrap_or_default();
        for stream in [&mut output.stdout, &mut output.stderr] {
            let mut text = String::from_utf8_lossy(stream).into_owned();
            for variant in [encoded.as_str(), json.trim_matches('"'), secret] {
                text = text.replace(variant, "[redacted]");
            }
            *stream = text.into_bytes();
        }
    }
    output
}

/// Run bibcite without pipe backpressure and stop its complete uv process tree
/// if it outlives the caller's deadline.
pub(crate) fn bibcite_output(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    let capture = BibciteCapture::new()?;
    let stdout_path = capture.path.join("stdout");
    let stderr_path = capture.path.join("stderr");
    command
        .stdout(Stdio::from(
            fs::File::create(&stdout_path).map_err(|error| error.to_string())?,
        ))
        .stderr(Stdio::from(
            fs::File::create(&stderr_path).map_err(|error| error.to_string())?,
        ));

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start bibcite: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = Output {
                    status,
                    stdout: fs::read(stdout_path).map_err(|error| error.to_string())?,
                    stderr: fs::read(stderr_path).map_err(|error| error.to_string())?,
                };
                return Ok(redact_bibcite_output(command, output));
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(
                    Duration::from_millis(25)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Ok(None) => {
                terminate_bibcite(&mut child);
                let elapsed = if timeout.subsec_nanos() == 0 {
                    format!("{} seconds", timeout.as_secs())
                } else {
                    format!("{timeout:?}")
                };
                return Err(format!("bibcite timed out after {elapsed}"));
            }
            Err(error) => {
                terminate_bibcite(&mut child);
                return Err(error.to_string());
            }
        }
    }
}

fn terminate_bibcite(child: &mut std::process::Child) {
    #[cfg(unix)]
    if let Ok(group) = i32::try_from(child.id()) {
        // uv launches the requested CLI as a descendant. Because each command
        // gets its own process group, a negative pid cannot affect Lattice.
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

struct BibciteCapture {
    path: PathBuf,
}

impl BibciteCapture {
    fn new() -> Result<Self, String> {
        let path = env::temp_dir().join(format!(
            "lattice-bibcite-output-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|error| error.to_string())?;
        Ok(Self { path })
    }
}

impl Drop for BibciteCapture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Build (or confirm) the cached environments for the literature tools so
/// the first import after install or update does not pay the download-and-
/// build cost while the user watches a spinner. Runs `--help` because it is
/// the cheapest invocation that forces uvx to materialize the environment.
/// Failures only log: the import path still builds on demand as before, and
/// a machine without `uv` gets its real error from the first import.
pub fn prewarm_literature_tools() {
    for tool in [&BIBCITE, &ARXIV2MD, &ARXIV_SOURCE2MD] {
        let started = std::time::Instant::now();
        let result = tool.command().and_then(|mut command| {
            command
                .arg("--help")
                .output()
                .map(|output| redact_bibcite_output(&command, output))
                .map_err(|error| error.to_string())
        });
        match result {
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

/// Lattice-owned command-line tools that should not depend on Homebrew or the
/// environment inherited by a GUI launch.
pub fn managed_tools_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library/Application Support/app.leo1oel.researchwriter/bin")
            .join(format!("uv-{MANAGED_UV_VERSION}"))
    })
}

pub fn managed_uv_tool_status(name: &str) -> Result<PathBuf, String> {
    if !matches!(name, "uv" | "uvx") {
        return Err(format!("{name} is not a managed uv executable."));
    }
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
        return Err(format!(
            "{} is not a regular executable file.",
            path.display()
        ));
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
    let version_line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .to_string();
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
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            #[cfg(unix)]
            {
                rustix::fs::access(path, rustix::fs::Access::EXEC_OK).is_ok()
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        Err(_) => false,
        _ => false,
    }
}

fn child_path() -> OsString {
    env::join_paths(command_directories())
        .unwrap_or_else(|_| env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin")))
}

/// Executable launchers shipped with Lattice's JavaScript runtime.
///
/// `bibcite` finds its formatter through PATH. During development that launcher
/// uses the adjacent standalone Node; the packaged macOS app resolves the same
/// directory under Resources and the launcher shares Chromium's Node runtime.
fn bundled_tools_dir() -> Option<PathBuf> {
    if tauri::is_dev() {
        return Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("synara-runtime")
                .join("bin"),
        );
    }

    #[cfg(target_os = "macos")]
    {
        env::current_exe()
            .ok()?
            .parent()?
            .parent()
            .map(|contents| contents.join("Resources/synara-runtime/bin"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        env::current_exe()
            .ok()?
            .parent()
            .map(|directory| directory.join("synara-runtime/bin"))
    }
}

fn command_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    // App-owned tools must win over stale Homebrew, shell PATH, and any
    // unrelated executable that happens to live in a TeX tree.
    directories.extend(managed_tools_dir());
    directories.extend(bundled_tools_dir());
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
    use std::io::Write;

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
        assert_eq!(
            env::split_paths(path).next(),
            managed_tools_dir(),
            "Lattice-owned tools must have PATH precedence"
        );
        assert!(env::split_paths(path).any(|entry| Some(entry) == bundled_tools_dir()));
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

    #[cfg(unix)]
    #[test]
    fn availability_requires_permission_to_execute() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!(
            "lattice-command-permission-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!is_executable(&path));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(is_executable(&path));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn python_tools_use_their_explicit_requirements() {
        for tool in [&BIBCITE, &ARXIV2MD, &ARXIV_SOURCE2MD] {
            // Inspect the managed path directly: process-wide development
            // overrides may be active in parallel tests that exercise a
            // fixture binary, but they do not change this contract.
            let managed_uvx = PathBuf::from("/lattice-managed/uvx");
            let command = tool.configured_uvx_command(managed_uvx.clone());
            assert_eq!(command.get_program(), managed_uvx);
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
            "arxiv2markdown @ git+https://github.com/leo1oel/arxiv2md.git@e19b6f6961a3df772cb6728548a7a872d438d775"
        );
        assert_eq!(ARXIV_SOURCE2MD.requirement, "arxiv-md==0.1.0");
    }

    #[test]
    fn bibcite_receives_one_effective_value_for_both_semantic_scholar_aliases() {
        let command = configure_bibcite_env(
            Command::new("bibcite"),
            Some("openalex-saved".into()),
            Some("semantic-saved".into()),
            Some("person@example.org".into()),
        );
        let envs = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(envs["OPENALEX_API_KEY"].as_deref(), Some("openalex-saved"));
        assert_eq!(
            envs["BIBCITE_PUBLIC_SERVICE_URL"].as_deref(),
            Some(crate::literature_service::ENDPOINT)
        );
        assert_eq!(envs["S2_API_KEY"].as_deref(), Some("semantic-saved"));
        assert_eq!(
            envs["SEMANTIC_SCHOLAR_API_KEY"].as_deref(),
            Some("semantic-saved")
        );
        assert_eq!(
            envs["BIBCITE_MAILTO"].as_deref(),
            Some("person@example.org")
        );

        let command = configure_bibcite_env(Command::new("bibcite"), None, None, None);
        let envs = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(envs["BIBCITE_S2_BATCH_STATUS"].as_deref(), Some("disabled"));
        assert_eq!(envs["S2_API_KEY"], None);
    }

    #[test]
    fn bibcite_output_captures_large_streams_and_redacts_credentials() {
        let mut command = bibcite_helper_command("output");
        command.env("OPENALEX_API_KEY", "test-secret");
        let output = bibcite_output(&mut command, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert!(output
            .stdout
            .windows(256 * 1024)
            .any(|bytes| bytes.iter().all(|byte| *byte == b'o')));
        assert!(output
            .stderr
            .windows(256 * 1024)
            .any(|bytes| bytes.iter().all(|byte| *byte == b'e')));
        assert!(String::from_utf8_lossy(&output.stdout).contains("[redacted]"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("[redacted]"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("test-secret"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("test-secret"));
    }

    #[cfg(unix)]
    #[test]
    fn bibcite_output_timeout_terminates_descendants() {
        let pid_file = env::temp_dir().join(format!(
            "lattice-bibcite-descendant-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let mut command = bibcite_helper_command("parent");
        command.env("LATTICE_BIBCITE_TEST_PID_FILE", &pid_file);
        let error = bibcite_output(&mut command, Duration::from_millis(500)).unwrap_err();
        assert!(error.contains("timed out after 500ms"), "{error}");

        let pid: i32 = fs::read_to_string(&pid_file).unwrap().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let result = unsafe { libc::kill(pid, 0) };
        let _ = fs::remove_file(pid_file);
        assert_eq!(result, -1, "descendant {pid} survived the timeout");
    }

    fn bibcite_helper_command(mode: &str) -> Command {
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "commands::tests::bibcite_output_helper",
                "--nocapture",
            ])
            .env("LATTICE_BIBCITE_TEST_HELPER", mode);
        command
    }

    #[test]
    fn bibcite_output_helper() {
        match env::var("LATTICE_BIBCITE_TEST_HELPER").as_deref() {
            Ok("output") => {
                std::io::stdout()
                    .write_all(&vec![b'o'; 256 * 1024])
                    .unwrap();
                std::io::stdout().write_all(b"test-secret").unwrap();
                std::io::stderr()
                    .write_all(&vec![b'e'; 256 * 1024])
                    .unwrap();
                std::io::stderr().write_all(b"test-secret").unwrap();
            }
            Ok("parent") => {
                let mut child = bibcite_helper_command("descendant").spawn().unwrap();
                fs::write(
                    env::var_os("LATTICE_BIBCITE_TEST_PID_FILE").unwrap(),
                    child.id().to_string(),
                )
                .unwrap();
                std::thread::sleep(Duration::from_secs(30));
                let _ = child.wait();
            }
            Ok("descendant") => std::thread::sleep(Duration::from_secs(30)),
            _ => {}
        }
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
