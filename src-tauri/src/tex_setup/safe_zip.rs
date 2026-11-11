//! Names inside a downloaded zip archive. A pinned archive is trusted to be
//! the release Lattice expects, but extraction still never lets a name decide
//! where a file lands: only plain relative paths pass, whatever the platform.

use std::path::PathBuf;

/// The relative path a zip entry `name` stands for, or `None` for any spelling
/// that could leave the folder it is joined to or that Windows reads as
/// something else: absolute and drive paths (`/x`, `C:x`), `..` and `.`
/// components, backslashes (a separator to Windows, a plain character to the
/// zip format, so `..\x` is both), alternate data streams (`x:y`), characters
/// no Windows file name can hold, names that end in a dot or space (Windows
/// drops them, so `a.` and `a` collide), and DOS device names (`NUL`, `COM1.txt`,
/// which open the device instead of creating a file). A trailing `/` marks a
/// folder and is dropped.
pub(crate) fn zip_entry_path(name: &str) -> Option<PathBuf> {
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return None;
    }
    let mut path = PathBuf::new();
    for part in trimmed.split('/') {
        if !is_plain_component(part) {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

fn is_plain_component(part: &str) -> bool {
    if part.is_empty() || part == "." || part == ".." {
        return false;
    }
    if part.ends_with('.') || part.ends_with(' ') {
        return false;
    }
    if part.chars().any(|character| {
        character.is_control()
            || character == '\u{FFFD}'
            || matches!(character, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
    }) {
        return false;
    }
    !is_device_name(part)
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`, the console
/// handles, and the same with any extension: Windows treats all of them as the
/// device. The superscript digits `COM¹` and the like are devices too.
fn is_device_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part).trim_end().to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()) {
        return true;
    }
    ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|digit| {
            let digits: Vec<char> = digit.chars().collect();
            matches!(digits.as_slice(), [d] if ('1'..='9').contains(d) || matches!(*d, '¹' | '²' | '³'))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_relative_names_pass_and_folders_lose_their_slash() {
        assert_eq!(zip_entry_path("uv.exe"), Some(PathBuf::from("uv.exe")));
        assert_eq!(
            zip_entry_path("install-tl-20260301/tlpkg/tlperl/bin/perl.exe"),
            Some(["install-tl-20260301", "tlpkg", "tlperl", "bin", "perl.exe"].iter().collect())
        );
        assert_eq!(zip_entry_path("bin/"), Some(PathBuf::from("bin")));
        // Spaces inside a name and non-ASCII letters are ordinary names.
        assert_eq!(
            zip_entry_path("My Docs/Zoë Å.txt"),
            Some(["My Docs", "Zoë Å.txt"].iter().collect())
        );
    }

    #[test]
    fn names_that_could_leave_the_destination_are_refused() {
        for name in [
            "",
            "/",
            "/etc/passwd",
            "../evil.exe",
            "a/../../evil.exe",
            "a/./b",
            "a//b",
            r"..\evil.exe",
            r"a\b.exe",
            "C:/Windows/evil.exe",
            "C:evil.exe",
            "uv.exe:stream",
            "a/b.",
            "a/b ",
            "bad|name",
            "what?",
            "star*",
            "a\0b",
            "line\nbreak",
        ] {
            assert_eq!(zip_entry_path(name), None, "{name:?}");
        }
    }

    #[test]
    fn dos_device_names_are_refused_with_any_extension_and_case() {
        for name in [
            "NUL",
            "nul",
            "nul.txt",
            "dir/CON",
            "aux.tar.gz",
            "Prn",
            "com1",
            "COM9.exe",
            "LPT3",
            "lpt1.log",
            "COM¹",
            "CONIN$",
            "con.",
            "nul /x",
        ] {
            assert_eq!(zip_entry_path(name), None, "{name:?}");
        }
        // Near misses are ordinary files.
        for name in ["console", "nullable.txt", "com10", "COM0", "lpt", "auxiliary", "cmd.exe"] {
            assert!(zip_entry_path(name).is_some(), "{name:?}");
        }
    }
}
