use regex::{Captures, Regex};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_LOG_BYTES: u64 = 128 * 1024;

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

#[tauri::command]
pub fn collect_diagnostic_logs(app: tauri::AppHandle) -> Result<DiagnosticLogBundle, String> {
    let log_root = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let home = app.path().home_dir().ok();
    let specs = [
        (
            "lattice.log",
            log_root.clone(),
            PathBuf::from("lattice.log"),
        ),
        (
            "sidecar.log",
            data_root.clone(),
            PathBuf::from("synara/lattice-logs/sidecar.log"),
        ),
        (
            "sidecar-error.log",
            data_root.clone(),
            PathBuf::from("synara/lattice-logs/sidecar-error.log"),
        ),
        (
            "server.log",
            data_root,
            PathBuf::from("synara/userdata/logs/server.log"),
        ),
    ];

    Ok(DiagnosticLogBundle {
        files: specs
            .into_iter()
            .map(|(name, root, relative)| collect_file(name, &root, &relative, home.as_deref()))
            .collect(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

fn collect_file(
    name: &str,
    root: &Path,
    relative: &Path,
    home: Option<&Path>,
) -> DiagnosticLogFile {
    let path = root.join(relative);
    match read_allowed_tail(root, &path) {
        Ok((content, truncated)) => DiagnosticLogFile {
            name: name.to_string(),
            content: redact(&content, home),
            truncated,
            error: None,
        },
        Err(error) => DiagnosticLogFile {
            name: name.to_string(),
            content: String::new(),
            truncated: false,
            error: Some(redact(&error, home)),
        },
    }
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
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("log root unavailable: {error}"))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("log unavailable: {error}"))?;
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
    let skip = bytes
        .iter()
        .take(3)
        .take_while(|byte| **byte & 0xc0 == 0x80)
        .count();
    Ok((
        String::from_utf8_lossy(&bytes[skip..]).into_owned(),
        truncated,
    ))
}

fn redact(input: &str, home: Option<&Path>) -> String {
    let mut output = input.to_string();
    let keys = r"(?:[a-z0-9]+[_-])*(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|shutdown[_-]?token|api[_-]?key|password)";
    let substitutions = [
        (
            r#"(?i)(authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s,;"']+"#.to_string(),
            "$1[REDACTED]",
        ),
        (
            format!(r#"(?i)(\b{keys}["']?\s*[:=]\s*")[^"]*(")"#),
            "$1[REDACTED]$2",
        ),
        (
            format!(r#"(?i)(\b{keys}["']?\s*[:=]\s*')[^']*(')"#),
            "$1[REDACTED]$2",
        ),
        (
            format!(r#"(?i)(\b{keys}\s*=\s*)[^\s&;,"']+"#),
            "$1[REDACTED]",
        ),
        (
            r"(?i)(https?://)[^\s/@:]+:[^\s/@]+@".to_string(),
            "$1[REDACTED]@",
        ),
    ];
    for (pattern, replacement) in substitutions {
        output = Regex::new(&pattern)
            .unwrap()
            .replace_all(&output, replacement)
            .into_owned();
    }
    if let Some(home) = home.and_then(Path::to_str).filter(|home| !home.is_empty()) {
        output = output.replace(home, "~");
        let encoded = home.replace('/', "%2F");
        output = Regex::new(&regex::escape(&encoded))
            .unwrap()
            .replace_all(&output, |_captures: &Captures<'_>| "~")
            .into_owned();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("lattice-diagnostic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn tail_is_bounded_and_starts_on_a_multibyte_boundary() {
        let root = temp_dir();
        let path = root.join("log");
        let mut data = "€".as_bytes().to_vec();
        data.extend(std::iter::repeat_n(b'x', MAX_LOG_BYTES as usize - 1));
        std::fs::write(&path, data).unwrap();
        let (content, truncated) = read_allowed_tail(&root, &path).unwrap();
        assert!(truncated);
        assert!(!content.starts_with('\u{fffd}'));
        assert!(content.bytes().all(|byte| byte == b'x'));
        assert!(content.len() <= MAX_LOG_BYTES as usize);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_missing_allowlisted_files() {
        let root = temp_dir();
        let file = collect_file("missing.log", &root, Path::new("missing.log"), None);
        assert_eq!(file.error.as_deref(), Some("not found"));
        assert!(file.content.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_parent_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = temp_dir();
        let outside = temp_dir();
        std::fs::write(outside.join("secret.log"), "secret").unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        let error = read_allowed_tail(&root, &root.join("linked/secret.log")).unwrap_err();
        assert!(error.contains("outside"));
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
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
        for secret in [
            "bearer-secret",
            "env-secret",
            "json-secret",
            "url-secret",
            "query-secret",
            "header-secret",
            "inspect-secret",
            "camel-secret",
            "sidecar-secret",
            "shutdown-secret",
        ] {
            assert!(!output.contains(secret), "leaked {secret}");
        }
        for public in ["PUBLIC_TOKEN=keep", "keep-json", "mode=keep"] {
            assert!(output.contains(public), "masked unrelated value {public}");
        }
        assert!(output.contains("~/paper.tex"));
    }
}
