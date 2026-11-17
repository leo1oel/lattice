//! The process a plugin runs in: a Seatbelt profile built from its grant, and
//! an environment that holds nothing of the writer's.
//!
//! The profile denies by default. A plugin may read the system libraries
//! every process needs, its own folder and its runtime; read and write its
//! own data folder; execute only its entry point (and, for `exec` plugins,
//! files in its own folder); and connect only to the loopback ports its
//! manifest declares. Seatbelt cannot name remote hosts (`host must be * or
//! localhost`), so remote network access goes through the host's
//! `http/fetch`, checked against the declared origins.
//!
//! Metadata (a file's existence, size and dates) stays readable only for the
//! folders above the plugin, data and runtime folders, which path resolution
//! needs; contents are never readable outside the list above.
//!
//! The environment is cleared, not filtered: a plugin sees `PATH`, `HOME`
//! (its data folder), `TMPDIR`, `LANG` and `LATTICE_PLUGIN_*`, so an API key
//! in the writer's shell profile never reaches it. #697 passed the whole
//! environment, which is how JetBrains' 2026 key-stealing plugins worked.
//!
//! Only macOS has this boundary. Elsewhere plugins do not run (`AVAILABLE`),
//! as the agent does not run without its bibliography guard.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Whether plugins can run here: only where the sandbox exists.
pub const AVAILABLE: bool = cfg!(target_os = "macos");
/// Why they cannot, in English for logs; the shells localize the state.
pub const MISSING: &str =
    "Plugins run only on macOS for now, where Lattice can sandbox them to what they declare.";

/// Everything the launch needs, already resolved by the caller.
pub(crate) struct Launch<'a> {
    pub(crate) plugin_id: &'a str,
    /// The process to start: the runtime's Node, or an `exec` plugin's
    /// executable.
    pub(crate) program: &'a Path,
    pub(crate) args: Vec<OsString>,
    pub(crate) plugin_dir: &'a Path,
    pub(crate) data_dir: &'a Path,
    /// Folders a runtime needs to read besides `program` (none for the
    /// standalone Node Lattice ships).
    pub(crate) runtime_reads: &'a [PathBuf],
    /// Whether the plugin may start other executables from its own folder.
    pub(crate) exec_in_plugin_dir: bool,
    pub(crate) network_local: &'a [u16],
    pub(crate) locale: &'a str,
}

/// The sandboxed command for `launch`, with a clean environment, its data
/// folder as the working directory, and in a process group of its own.
pub(crate) fn command(launch: &Launch<'_>) -> Result<Command, String> {
    if !AVAILABLE {
        return Err(MISSING.into());
    }
    std::fs::create_dir_all(launch.data_dir.join("tmp"))
        .map_err(|e| format!("Cannot create the plugin's data folder: {e}"))?;
    // Seatbelt matches resolved paths, so the plugin is told the resolved
    // ones: `/var/folders/…` would be refused where `/private/var/…` is not.
    let data_dir = launch.data_dir.canonicalize().map_err(|e| e.to_string())?;
    let profile = profile(launch)?;
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command.arg("-p").arg(profile).arg(launch.program).args(&launch.args);
    command.current_dir(&data_dir).env_clear();
    for (key, value) in environment(launch, &data_dir) {
        command.env(key, value);
    }
    crate::commands::in_new_process_group(&mut command);
    Ok(command)
}

/// The variables a plugin sees, and nothing else.
fn environment(launch: &Launch<'_>, data_dir: &Path) -> Vec<(&'static str, OsString)> {
    let lang = if launch.locale.starts_with("zh") { "zh_CN.UTF-8" } else { "en_US.UTF-8" };
    vec![
        ("PATH", "/usr/bin:/bin".into()),
        ("HOME", data_dir.into()),
        ("TMPDIR", data_dir.join("tmp").into()),
        ("LANG", lang.into()),
        ("LATTICE_PLUGIN_ID", launch.plugin_id.into()),
        ("LATTICE_PLUGIN_API_LEVEL", super::protocol::API_LEVEL.to_string().into()),
        ("LATTICE_PLUGIN_DATA_DIR", data_dir.into()),
    ]
}

/// System folders whose contents every process may need: libraries, the
/// dyld cache, zone info, locale data.
const SYSTEM_READS: &[&str] = &[
    "/usr/lib",
    "/usr/share",
    "/System/Library",
    "/System/Volumes/Preboot/Cryptexes/OS",
    "/private/var/db/timezone",
    "/Library/Apple/usr/lib",
];
const SYSTEM_READ_FILES: &[&str] = &[
    "/",
    "/dev/null",
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/autofs_nowait",
    "/dev/dtracehelper",
    "/private/etc/localtime",
    "/private/etc/hosts",
    // The links to /private, so a path through them still resolves.
    "/var",
    "/tmp",
    "/etc",
];

/// The Seatbelt profile for `launch`.
pub(crate) fn profile(launch: &Launch<'_>) -> Result<String, String> {
    let real = |path: &Path| {
        path.canonicalize().map_err(|e| format!("Cannot resolve {}: {e}", path.display()))
    };
    let program = real(launch.program)?;
    let plugin_dir = real(launch.plugin_dir)?;
    let data_dir = real(launch.data_dir)?;
    let runtime_reads =
        launch.runtime_reads.iter().map(|p| real(p)).collect::<Result<Vec<_>, _>>()?;

    let mut p = String::from("(version 1)\n(deny default)\n");
    p += &format!("(allow process-exec (literal {}))\n", quote(&program)?);
    if launch.exec_in_plugin_dir {
        p += &format!("(allow process-exec (subpath {}))\n", quote(&plugin_dir)?);
    }
    p += "(allow process-fork)\n(allow signal (target same-sandbox))\n(allow sysctl-read)\n";
    p += "(allow mach-priv-task-port (target self))\n";

    let mut metadata: Vec<PathBuf> = Vec::new();
    for path in [&program, &plugin_dir, &data_dir].into_iter().chain(&runtime_reads) {
        metadata.extend(path.ancestors().map(Path::to_path_buf));
    }
    metadata.sort();
    metadata.dedup();
    p += "(allow file-read-metadata";
    for path in &metadata {
        p += &format!(" (literal {})", quote(path)?);
    }
    for dir in SYSTEM_READS {
        p += &format!(" (subpath \"{dir}\")");
    }
    p += ")\n(allow file-read*";
    for dir in SYSTEM_READS {
        p += &format!(" (subpath \"{dir}\")");
    }
    for file in SYSTEM_READ_FILES {
        p += &format!(" (literal \"{file}\")");
    }
    p += &format!(" (literal {}) (subpath {})", quote(&program)?, quote(&plugin_dir)?);
    for dir in &runtime_reads {
        p += &format!(" (subpath {})", quote(dir)?);
    }
    p += ")\n";
    p += &format!("(allow file-read* file-write* (subpath {}))\n", quote(&data_dir)?);
    p += "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))\n";
    for port in launch.network_local {
        p += &format!("(allow network-outbound (remote ip \"localhost:{port}\"))\n");
    }
    Ok(p)
}

/// `path` as an SBPL string literal. A path that cannot be written as one
/// (a newline, a NUL, not UTF-8) is refused rather than escaped.
fn quote(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or_else(|| format!("Unsupported path {}", path.display()))?;
    if text.chars().any(|c| c.is_control()) {
        return Err(format!("Unsupported path {}", path.display()));
    }
    Ok(format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\"")))
}

// Windows refuses a folder name with a quote in it; the profile is only ever
// used on macOS.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn the_profile_quotes_paths_and_allows_only_declared_ports() {
        let root = crate::test_support::TempDir::new("plugin-profile");
        let plugin = root.join("odd \"dir\"");
        let data = root.join("data");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let program = root.write("odd \"dir\"/main", "");
        let launch = Launch {
            plugin_id: "dev.test.p",
            program: &program,
            args: vec![],
            plugin_dir: &plugin,
            data_dir: &data,
            runtime_reads: &[],
            exec_in_plugin_dir: false,
            network_local: &[23119],
            locale: "en",
        };
        let profile = profile(&launch).unwrap();
        assert!(profile.contains("(deny default)"));
        assert!(profile.contains("odd \\\"dir\\\""), "{profile}");
        assert!(profile.contains("(remote ip \"localhost:23119\")"));
        assert_eq!(profile.matches("network-outbound").count(), 1);
        assert!(!profile.contains("(allow default)"));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests;
