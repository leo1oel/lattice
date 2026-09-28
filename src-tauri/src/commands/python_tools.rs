//! The Python CLIs Lattice drives through the app-managed uvx, pinned exactly.

use super::{in_new_process_group, managed_uv_tool_status, with_child_path};
use crate::literature_credentials::{crossref_contact, openalex_key, semanticscholar_key};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

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
    requirement: "bibcite-cli==0.6.10",
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

/// The credentials bibcite reads from its environment. Only the effective
/// values Lattice passes may reach it, and none may leave in its output.
const BIBCITE_KEYS: [&str; 3] = ["OPENALEX_API_KEY", "S2_API_KEY", "SEMANTIC_SCHOLAR_API_KEY"];

impl UvTool {
    /// A command that runs this tool's exact, app-tested requirement.
    pub fn command(&self) -> Result<Command, String> {
        let command = match env::var_os(self.override_env).filter(|value| !value.is_empty()) {
            Some(path) => with_child_path(Command::new(path)),
            None => {
                // Validate the complete managed pair before every launch.
                // Generic command resolution must never fall back to a stale
                // Homebrew/PATH uvx after setup has promised an app-owned one.
                managed_uv_tool_status("uv")?;
                self.configured_uvx_command(managed_uv_tool_status("uvx")?)
            }
        };
        if self.binary != BIBCITE.binary {
            return Ok(command);
        }
        Ok(configure_bibcite_env(
            command,
            openalex_key()?,
            semanticscholar_key()?,
            crossref_contact()?,
        ))
    }

    fn configured_uvx_command(&self, uvx: PathBuf) -> Command {
        let mut command = with_child_path(Command::new(uvx));
        command.env("UV_CACHE_DIR", uv_cache_dir()).args(["--from", self.requirement, self.binary]);
        command
    }
}

fn configure_bibcite_env(
    mut command: Command, openalex: Option<String>, semanticscholar: Option<String>,
    contact: Option<String>,
) -> Command {
    for name in BIBCITE_KEYS.iter().chain(&[
        "BIBCITE_MAILTO",
        "BIBCITE_S2_BATCH_STATUS",
        "BIBCITE_CORE_SOURCES",
    ]) {
        command.env_remove(name);
    }
    // 0.6.10 caches publication matches by title without author/ID context.
    // Do not replay a cached candidate as independently verified metadata.
    command.env("BIBCITE_NO_CACHE", "1");
    command.env("BIBCITE_PUBLIC_SERVICE_URL", crate::literature_service::ENDPOINT);
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
        if !name.to_str().is_some_and(|name| BIBCITE_KEYS.contains(&name)) {
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
/// if it outlives the caller's deadline or the caller cancels.
pub(crate) fn bibcite_output_cancellable(
    command: &mut Command, timeout: Duration, cancel: &AtomicBool,
) -> Result<Output, String> {
    const CANCELLED: &str = "Paper import cancelled.";
    if cancel.load(Ordering::Acquire) {
        return Err(CANCELLED.to_string());
    }
    let capture = BibciteCapture::new()?;
    let stdout_path = capture.path.join("stdout");
    let stderr_path = capture.path.join("stderr");
    let create = |path: &PathBuf| fs::File::create(path).map_err(|error| error.to_string());
    command.stdout(Stdio::from(create(&stdout_path)?)).stderr(Stdio::from(create(&stderr_path)?));
    // uv launches the requested CLI as a descendant; its own process group
    // lets `terminate_bibcite` stop the whole tree.
    in_new_process_group(command);

    let mut child = command.spawn().map_err(|error| format!("could not start bibcite: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        let error = match child.try_wait() {
            Ok(Some(status)) => {
                let read = |path| fs::read(path).map_err(|error: std::io::Error| error.to_string());
                let output =
                    Output { status, stdout: read(stdout_path)?, stderr: read(stderr_path)? };
                return Ok(redact_bibcite_output(command, output));
            }
            Ok(None) if Instant::now() < deadline => {
                if !cancel.load(Ordering::Acquire) {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    std::thread::sleep(Duration::from_millis(25).min(remaining));
                    continue;
                }
                CANCELLED.to_string()
            }
            Ok(None) => {
                let elapsed = if timeout.subsec_nanos() == 0 {
                    format!("{} seconds", timeout.as_secs())
                } else {
                    format!("{timeout:?}")
                };
                format!("bibcite timed out after {elapsed}")
            }
            Err(error) => error.to_string(),
        };
        terminate_bibcite(&mut child);
        return Err(error);
    }
}

fn terminate_bibcite(child: &mut std::process::Child) {
    super::signal_process_group(child.id(), libc::SIGKILL);
    let _ = child.kill();
    let _ = child.wait();
}

/// A private temporary directory for one run's output, removed on drop.
struct BibciteCapture {
    path: PathBuf,
}

impl BibciteCapture {
    fn new() -> Result<Self, String> {
        let path = env::temp_dir()
            .join(format!("lattice-bibcite-output-{}", uuid::Uuid::new_v4().simple()));
        let mut builder = fs::DirBuilder::new();
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
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
        let started = Instant::now();
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
/// the day.
fn uv_cache_dir() -> PathBuf {
    app_cache_dir("uv", "/tmp/research-writer-uv-cache")
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
    app_cache_dir("arxiv2md", "/tmp/research-writer-arxiv2md-cache")
}

fn app_cache_dir(name: &str, without_home: &str) -> PathBuf {
    match env::var_os("HOME") {
        Some(home) => {
            PathBuf::from(home).join("Library/Caches/app.leo1oel.researchwriter").join(name)
        }
        None => PathBuf::from(without_home),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::Write;

    #[test]
    fn python_tools_use_their_explicit_requirements() {
        for tool in [&BIBCITE, &ARXIV2MD, &ARXIV_SOURCE2MD] {
            // Inspect the managed path directly: process-wide development
            // overrides may be active in parallel tests that exercise a
            // fixture binary, but they do not change this contract.
            let managed_uvx = PathBuf::from("/lattice-managed/uvx");
            let command = tool.configured_uvx_command(managed_uvx.clone());
            assert_eq!(command.get_program(), managed_uvx);
            let args: Vec<_> =
                command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
            assert!(args.windows(2).any(|pair| pair == ["--from", tool.requirement]));
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
        let envs = |command: Command| {
            command
                .get_envs()
                .map(|(name, value)| {
                    let value = value.map(|value| value.to_string_lossy().into_owned());
                    (name.to_string_lossy().into_owned(), value)
                })
                .collect::<BTreeMap<_, _>>()
        };
        let saved = envs(configure_bibcite_env(
            Command::new("bibcite"),
            Some("openalex-saved".into()),
            Some("semantic-saved".into()),
            Some("person@example.org".into()),
        ));
        for (name, value) in [
            ("OPENALEX_API_KEY", "openalex-saved"),
            ("BIBCITE_PUBLIC_SERVICE_URL", crate::literature_service::ENDPOINT),
            ("S2_API_KEY", "semantic-saved"),
            ("SEMANTIC_SCHOLAR_API_KEY", "semantic-saved"),
            ("BIBCITE_MAILTO", "person@example.org"),
        ] {
            assert_eq!(saved[name].as_deref(), Some(value), "{name}");
        }

        let unset = envs(configure_bibcite_env(Command::new("bibcite"), None, None, None));
        assert_eq!(unset["BIBCITE_S2_BATCH_STATUS"].as_deref(), Some("disabled"));
        assert_eq!(unset["BIBCITE_NO_CACHE"].as_deref(), Some("1"));
        assert_eq!(unset["S2_API_KEY"], None);
    }

    #[test]
    fn bibcite_output_captures_large_streams_and_redacts_credentials() {
        let mut command = bibcite_helper_command("output");
        command.env("OPENALEX_API_KEY", "test-secret");
        let output = bibcite_output(&mut command, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        for (stream, fill) in [(&output.stdout, b'o'), (&output.stderr, b'e')] {
            assert!(stream.windows(256 * 1024).any(|bytes| bytes.iter().all(|byte| *byte == fill)));
            let text = String::from_utf8_lossy(stream);
            assert!(text.contains("[redacted]") && !text.contains("test-secret"));
        }
    }

    #[test]
    fn timeout_and_cancellation_terminate_the_whole_tool_tree() {
        // The helper's grandchild writes its pid to this file.
        let pid_file = || env::temp_dir().join(format!("lattice-bibcite-{}", uuid::Uuid::new_v4()));
        let parent = |pid_file: &std::path::Path| {
            let mut command = bibcite_helper_command("parent");
            command.env("LATTICE_BIBCITE_TEST_PID_FILE", pid_file);
            command
        };

        let timed_out = pid_file();
        let error =
            bibcite_output(&mut parent(&timed_out), Duration::from_millis(500)).unwrap_err();
        assert!(error.contains("timed out after 500ms"), "{error}");
        assert_descendant_exits(&timed_out, "descendant survived the timeout");

        let cancelled = pid_file();
        let cancel = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                bibcite_output_cancellable(
                    &mut parent(&cancelled),
                    Duration::from_secs(10),
                    &cancel,
                )
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !cancelled.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            cancel.store(true, Ordering::Release);
            assert_eq!(worker.join().unwrap().unwrap_err(), "Paper import cancelled.");
        });
        assert_descendant_exits(&cancelled, "converter survived cancellation");
    }

    fn bibcite_output(command: &mut Command, timeout: Duration) -> Result<Output, String> {
        bibcite_output_cancellable(command, timeout, &AtomicBool::new(false))
    }

    /// The process whose pid is in `pid_file` must be gone within two seconds.
    fn assert_descendant_exits(pid_file: &std::path::Path, message: &str) {
        let pid: i32 = fs::read_to_string(pid_file).unwrap().parse().unwrap();
        let alive = || unsafe { libc::kill(pid, 0) } == 0;
        let deadline = Instant::now() + Duration::from_secs(2);
        while alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let survived = alive();
        let _ = fs::remove_file(pid_file);
        assert!(!survived, "{message} (pid {pid})");
    }

    fn bibcite_helper_command(mode: &str) -> Command {
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "commands::python_tools::tests::bibcite_output_helper",
                "--nocapture",
            ])
            .env("LATTICE_BIBCITE_TEST_HELPER", mode);
        command
    }

    #[test]
    fn bibcite_output_helper() {
        match env::var("LATTICE_BIBCITE_TEST_HELPER").as_deref() {
            Ok("output") => {
                std::io::stdout().write_all(&vec![b'o'; 256 * 1024]).unwrap();
                std::io::stdout().write_all(b"test-secret").unwrap();
                std::io::stderr().write_all(&vec![b'e'; 256 * 1024]).unwrap();
                std::io::stderr().write_all(b"test-secret").unwrap();
            }
            Ok("parent") => {
                let mut child = bibcite_helper_command("descendant").spawn().unwrap();
                let pid_file = env::var_os("LATTICE_BIBCITE_TEST_PID_FILE").unwrap();
                fs::write(pid_file, child.id().to_string()).unwrap();
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
            std::include_str!("../papers.rs").contains("\"ARXIV2MD_CACHE_PATH\""),
            "the fetch pipeline must point the converter's cache away from the bundle"
        );
    }
}
