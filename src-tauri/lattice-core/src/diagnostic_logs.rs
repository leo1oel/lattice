//! The support bundle: bounded, redacted tails of the app and sidecar logs,
//! and Help ▸ Report a Problem…'s saved copy of the in-app log export.

use regex::Regex;
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const MAX_LOG_BYTES: u64 = 128 * 1024;
/// Far above any real export (the in-app log keeps 300 entries of at most
/// 4,000 characters), so only a runaway page is refused.
const MAX_REPORT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogBundle {
    files: Vec<DiagnosticLogFile>,
    platform: String,
    arch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticLogFile {
    name: String,
    content: String,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// The bundle from Lattice's log folder `log_root` and app data folder
/// `data_root`, with the writer's `home` shown as `~`. Reads files: run it off
/// the main thread.
pub fn collect(log_root: &Path, data_root: &Path, home: Option<&Path>) -> DiagnosticLogBundle {
    let specs = [
        ("lattice.log", log_root, "lattice.log"),
        ("sidecar.log", data_root, "synara/lattice-logs/sidecar.log"),
        ("sidecar-error.log", data_root, "synara/lattice-logs/sidecar-error.log"),
        ("server.log", data_root, "synara/userdata/logs/server.log"),
    ];
    DiagnosticLogBundle {
        files: specs
            .into_iter()
            .map(|(name, root, relative)| collect_file(name, root, Path::new(relative), home))
            .collect(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// What a problem report's new-issue page names: the Mac it came from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemReport {
    /// The macOS version (`15.1`), or `None` where it is unknown.
    os_version: Option<String>,
    arch: String,
}

/// Save Help ▸ Report a Problem…'s redacted log export (the page builds it as
/// Settings › Logs › Export does) in `folder`, Lattice's log folder's
/// `reports/`, for the shell to show in Finder so the reporter can attach it
/// to the issue. The shell picks the folder, so the page cannot write anywhere
/// else; the contents are redacted once more here as a backstop.
pub fn save_problem_report(
    folder: &Path, contents: &str, home: Option<&Path>,
) -> Result<(PathBuf, ProblemReport), String> {
    if contents.len() > MAX_REPORT_BYTES {
        return Err("The diagnostic log is too large to save.".to_string());
    }
    let path = write_report(folder, &redact(contents, home), chrono::Local::now())?;
    Ok((path, ProblemReport { os_version: os_version(), arch: std::env::consts::ARCH.to_string() }))
}

fn write_report(
    folder: &Path, contents: &str, now: chrono::DateTime<chrono::Local>,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(folder)
        .map_err(|error| format!("Could not create the report folder: {error}"))?;
    let path = folder.join(format!("lattice-diagnostics-{}.json", now.format("%Y-%m-%d-%H%M%S")));
    std::fs::write(&path, contents)
        .map_err(|error| format!("Could not save the diagnostic log: {error}"))?;
    Ok(path)
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let output =
        std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()?;
    let version = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (output.status.success() && !version.is_empty()).then_some(version)
}

#[cfg(not(target_os = "macos"))]
fn os_version() -> Option<String> {
    None
}

fn collect_file(
    name: &str, root: &Path, relative: &Path, home: Option<&Path>,
) -> DiagnosticLogFile {
    let (content, truncated, error) = match read_allowed_tail(root, &root.join(relative)) {
        Ok((content, truncated)) => (redact(&content, home), truncated, None),
        Err(error) => (String::new(), false, Some(redact(&error, home))),
    };
    DiagnosticLogFile { name: name.to_string(), content, truncated, error }
}

fn read_allowed_tail(root: &Path, path: &Path) -> Result<(String, bool), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "not found".to_string()
        } else {
            format!("unavailable: {error}")
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("refused non-regular or symlinked log file".to_string());
    }
    let canonical_root =
        root.canonicalize().map_err(|error| format!("log root unavailable: {error}"))?;
    let canonical_path =
        path.canonicalize().map_err(|error| format!("log unavailable: {error}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("refused log path outside its allowed root".to_string());
    }

    let len = metadata.len();
    let truncated = len > MAX_LOG_BYTES;
    let mut file = File::open(&canonical_path).map_err(|error| format!("unavailable: {error}"))?;
    if truncated {
        file.seek(SeekFrom::Start(len - MAX_LOG_BYTES))
            .map_err(|error| format!("unavailable: {error}"))?;
    }
    let mut bytes = Vec::with_capacity((len.min(MAX_LOG_BYTES)) as usize);
    file.take(MAX_LOG_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("unavailable: {error}"))?;

    // A tail can begin in the middle of a UTF-8 scalar. Drop only those leading
    // continuation bytes; malformed bytes elsewhere remain visible as replacement characters.
    let skip = bytes.iter().take(3).take_while(|byte| **byte & 0xc0 == 0x80).count();
    Ok((String::from_utf8_lossy(&bytes[skip..]).into_owned(), truncated))
}

static SECRETS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let keys = r"(?:[a-z0-9]+[_-])*(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|shutdown[_-]?token|api[_-]?key|password)";
    [
        (
            r#"(?i)(authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s,;"']+"#.to_string(),
            "$1[REDACTED]",
        ),
        (format!(r#"(?i)(\b{keys}["']?\s*[:=]\s*")[^"]*(")"#), "$1[REDACTED]$2"),
        (format!(r#"(?i)(\b{keys}["']?\s*[:=]\s*')[^']*(')"#), "$1[REDACTED]$2"),
        (format!(r#"(?i)(\b{keys}\s*=\s*)[^\s&;,"']+"#), "$1[REDACTED]"),
        (r"(?i)(https?://)[^\s/@:]+:[^\s/@]+@".to_string(), "$1[REDACTED]@"),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(&pattern).expect("valid regex"), replacement))
    .collect()
});

fn redact(input: &str, home: Option<&Path>) -> String {
    let mut output = input.to_string();
    for (pattern, replacement) in SECRETS.iter() {
        output = pattern.replace_all(&output, *replacement).into_owned();
    }
    if let Some(home) = home.and_then(Path::to_str).filter(|home| !home.is_empty()) {
        output = output.replace(home, "~").replace(&home.replace('/', "%2F"), "~");
    }
    output
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// `log` as the support bundle exports it.
    pub(crate) fn exported(log: &str) -> String {
        let root = TempDir::new("diagnostic");
        root.write("lattice.log", log);
        let file = collect_file("lattice.log", &root, Path::new("lattice.log"), None);
        assert_eq!(file.error, None);
        file.content
    }

    #[test]
    fn tail_is_bounded_and_starts_on_a_multibyte_boundary() {
        let root = TempDir::new("diagnostic");
        let mut data = "€".as_bytes().to_vec();
        data.extend(std::iter::repeat_n(b'x', MAX_LOG_BYTES as usize - 1));
        let path = root.write("log", data);
        let (content, truncated) = read_allowed_tail(&root, &path).unwrap();
        assert!(truncated);
        // No partial "€" (or replacement character) survives the cut.
        assert!(content.bytes().all(|byte| byte == b'x'));
        assert!(content.len() <= MAX_LOG_BYTES as usize);
    }

    #[test]
    fn reports_missing_files_and_rejects_a_parent_symlink_escape() {
        let root = TempDir::new("diagnostic");
        let file = collect_file("missing.log", &root, Path::new("missing.log"), None);
        assert_eq!(file.error.as_deref(), Some("not found"));
        assert!(file.content.is_empty());

        let outside = TempDir::new("diagnostic");
        outside.write("secret.log", "secret");
        crate::test_support::symlink(&*outside, root.join("linked")).unwrap();
        let error = read_allowed_tail(&root, &root.join("linked/secret.log")).unwrap_err();
        assert!(error.contains("outside"));
    }

    #[test]
    fn a_problem_report_is_saved_under_its_folder_by_time() {
        let root = TempDir::new("diagnostic");
        let folder = root.join("reports");
        let now = chrono::Local::now();
        let path = write_report(&folder, "{}", now).unwrap();
        assert!(path.starts_with(&folder));
        let name = path.file_name().unwrap().to_str().unwrap().to_string();
        assert_eq!(name, format!("lattice-diagnostics-{}.json", now.format("%Y-%m-%d-%H%M%S")));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn names_the_macos_version() {
        let version = os_version().expect("sw_vers answers on macOS");
        assert!(version.split('.').all(|part| part.parse::<u32>().is_ok()), "{version}");
    }

    #[test]
    fn masks_known_secrets_without_masking_unrelated_values() {
        let input = "Authorization: Bearer bearer-secret\nAUTH_TOKEN=env-secret PUBLIC_TOKEN=keep\n\
          {\"access_token\":\"json-secret\",\"label\":\"keep-json\"}\n\
          {\"authorization\":\"Bearer header-secret\"}\n\
          { authToken: 'inspect-secret', apiKey: \"camel-secret\" }\n\
          SYNARA_AUTH_TOKEN=sidecar-secret SYNARA_SHUTDOWN_TOKEN='shutdown-secret'\n\
          https://alice:url-secret@example.test/x?api_key=query-secret&mode=keep /Users/alice/paper.tex";
        let output = redact(input, Some(Path::new("/Users/alice")));
        // Every secret value above, and nothing else, contains "secret".
        assert!(!output.contains("secret"), "leaked a secret: {output}");
        for public in ["PUBLIC_TOKEN=keep", "keep-json", "mode=keep"] {
            assert!(output.contains(public), "masked unrelated value {public}");
        }
        assert!(output.contains("~/paper.tex"));
    }
}
