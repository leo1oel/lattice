//! Home folders and diagnostic path spelling across desktop hosts.
use std::path::PathBuf;

pub(crate) fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    return windows_home(
        std::env::var_os("USERPROFILE"),
        std::env::var_os("HOMEDRIVE"),
        std::env::var_os("HOMEPATH"),
    );
    #[cfg(not(windows))]
    std::env::var_os("HOME").filter(|value| !value.is_empty()).map(PathBuf::from)
}

#[cfg(any(windows, test))]
fn windows_home(
    profile: Option<std::ffi::OsString>, drive: Option<std::ffi::OsString>,
    path: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    profile
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let mut drive = drive.filter(|value| !value.is_empty())?;
            drive.push(path.filter(|value| !value.is_empty())?);
            Some(drive)
        })
        .map(PathBuf::from)
}

/// Redact both path separators and Windows' extended-length spelling, also
/// when a diagnostic was serialized once already and escaped its backslashes.
pub(crate) fn redact_home(text: &str, home: &str) -> String {
    if home.len() <= 1 {
        return text.to_string();
    }
    let windows = home.contains('\\') || home.as_bytes().get(1) == Some(&b':');
    if !windows {
        return text.replace(home, "~");
    }
    let normal = home
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or_else(|| home.strip_prefix(r"\\?\").unwrap_or(home).to_string());
    let back = normal.replace('/', r"\");
    let extended = if let Some(unc) = back.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{unc}")
    } else {
        format!(r"\\?\{back}")
    };
    let mut spellings = [
        extended.replace('\\', r"\\"),
        extended,
        back.replace('\\', r"\\"),
        back,
        normal.replace('\\', "/"),
    ];
    spellings.sort_by_key(|path| std::cmp::Reverse(path.len()));
    let pattern = format!(
        "(?i){}",
        spellings.iter().map(|path| regex::escape(path)).collect::<Vec<_>>().join("|")
    );
    regex::Regex::new(&pattern).expect("escaped path spellings").replace_all(text, "~").into_owned()
}

#[cfg(any(windows, test))]
pub(crate) fn tex_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    let normal = if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
    };
    normal.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_home_works_without_a_unix_home_variable() {
        assert_eq!(
            windows_home(Some(r"C:\Users\Ada".into()), None, None),
            Some(PathBuf::from(r"C:\Users\Ada"))
        );
        assert_eq!(
            windows_home(None, Some("H:".into()), Some(r"\Users\Ada".into())),
            Some(PathBuf::from(r"H:\Users\Ada"))
        );
        assert_eq!(windows_home(None, None, None), None);
    }
    #[test]
    fn logs_redact_windows_native_slash_extended_and_escaped_paths() {
        for path in [
            r"C:\Users\Ada\paper.tex",
            "c:/users/ada/paper.tex",
            r"\\?\C:\Users\Ada\paper.tex",
            r"C:\\Users\\Ada\\paper.tex",
        ] {
            let redacted = redact_home(path, r"C:\Users\Ada");
            assert!(!redacted.to_lowercase().contains("ada"), "{redacted}");
            assert!(redacted.starts_with('~'), "{redacted}");
        }
        assert_eq!(redact_home("/home/ada/paper.tex", "/home/ada"), "~/paper.tex");
    }
    #[test]
    fn tex_paths_preserve_unc_shares() {
        assert_eq!(
            tex_path(std::path::Path::new(r"\\?\UNC\server\share\paper")),
            "//server/share/paper"
        );
        assert_eq!(tex_path(std::path::Path::new(r"\\?\C:\Users\Ada\paper")), "C:/Users/Ada/paper");
    }
}
