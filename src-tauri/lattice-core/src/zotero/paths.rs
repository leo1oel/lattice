//! Zotero's profile directory follows the host, not the data folder the user
//! may have moved. Keep the resolver independent of the process environment
//! so Windows discovery can also be exercised on other test hosts.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub(super) fn support_dir() -> Option<PathBuf> {
    support_dir_for(
        std::env::consts::OS,
        crate::host_paths::home_dir().as_deref(),
        std::env::var_os("APPDATA").as_deref(),
    )
}

fn support_dir_for(
    platform: &str, home: Option<&Path>, roaming: Option<&OsStr>,
) -> Option<PathBuf> {
    match platform {
        "windows" => Some(
            roaming
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(|| home.map(|home| home.join("AppData").join("Roaming")))?
                .join("Zotero")
                .join("Zotero"),
        ),
        "macos" => Some(home?.join("Library").join("Application Support").join("Zotero")),
        _ => Some(home?.join(".zotero").join("zotero")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_prefers_roaming_profile_and_does_not_need_unix_home() {
        let roaming = Path::new("roaming-profile");
        assert_eq!(
            support_dir_for("windows", None, Some(roaming.as_os_str())),
            Some(roaming.join("Zotero").join("Zotero")),
        );
        let home = Path::new("user-profile");
        assert_eq!(
            support_dir_for("windows", Some(home), None),
            Some(home.join("AppData").join("Roaming").join("Zotero").join("Zotero")),
        );
        assert_eq!(support_dir_for("windows", None, None), None);
    }

    #[test]
    fn macos_and_linux_use_their_own_profile_locations() {
        let home = Path::new("home");
        assert_eq!(
            support_dir_for("macos", Some(home), None),
            Some(home.join("Library").join("Application Support").join("Zotero"))
        );
        assert_eq!(
            support_dir_for("linux", Some(home), None),
            Some(home.join(".zotero").join("zotero"))
        );
    }
}
