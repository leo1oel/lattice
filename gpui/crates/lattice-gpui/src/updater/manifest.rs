//! What an update check reads: the release manifest the Tauri app's updater
//! reads (`latest.json`, written by the release workflow beside the
//! release's archives), its entry for this platform, and whether its version
//! is a later release than the one running (`isNewerVersion` in
//! `src/telemetry/outdated-version.ts`).

use std::collections::HashMap;

use serde::Deserialize;

/// The manifest, as tauri-plugin-updater reads it.
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub platforms: HashMap<String, Platform>,
}

/// One platform's archive and its minisign signature (the `.sig` file's
/// text, base64).
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Platform {
    pub url: String,
    pub signature: String,
}

/// A release newer than the one running, and this platform's archive of it.
#[derive(Clone, Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub platform: Platform,
}

/// The manifest's key for this platform (`darwin-aarch64`, as Tauri names
/// it), with the `-app` variant the plugin also accepts.
pub fn platform_keys() -> [String; 2] {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = std::env::consts::ARCH;
    [format!("{os}-{arch}"), format!("{os}-{arch}-app")]
}

/// The version's numeric parts, a leading `v` and any pre-release or build
/// suffix left out.
fn parts(version: &str) -> Option<Vec<u64>> {
    let version = version.trim();
    let version = version
        .strip_prefix('v')
        .or_else(|| version.strip_prefix('V'))
        .unwrap_or(version);
    let core = version.split(['-', '+']).next()?;
    core.split('.').map(|part| part.parse().ok()).collect()
}

/// Whether `candidate` is a later release than `current` ("0.16.10" after
/// "0.16.9"); false for anything that does not parse.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (Some(a), Some(b)) = (parts(candidate), parts(current)) else {
        return false;
    };
    for index in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(index).copied().unwrap_or(0),
            b.get(index).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

/// The release a manifest offers over `running`: none when it is not newer
/// or has nothing for this platform.
pub fn newer_release(text: &str, running: &str) -> Result<Option<Release>, String> {
    Ok(platform_release(text)?.filter(|release| is_newer(&release.version, running)))
}

/// This platform's release in a manifest, whatever its version: the switch
/// back to the classic version installs the Tauri app's release though it
/// carries the same number as the one running (both apps ship each version).
/// None when the manifest has nothing for this platform.
pub fn platform_release(text: &str) -> Result<Option<Release>, String> {
    let manifest: Manifest =
        serde_json::from_str(text).map_err(|error| format!("the release manifest: {error}"))?;
    let platform = platform_keys()
        .iter()
        .find_map(|key| manifest.platforms.get(key).cloned());
    Ok(platform.map(|platform| Release {
        version: manifest.version.trim_start_matches('v').to_string(),
        platform,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_releases() {
        // outdated-version.test.tsx's expectations.
        assert!(is_newer("0.16.10", "0.16.9"));
        assert!(is_newer("v1.0.0", "0.99.0"));
        assert!(is_newer("0.17", "0.16.9"));
        assert!(!is_newer("0.16.9", "0.16.9"));
        assert!(!is_newer("0.16.9-beta.1", "0.16.9"));
        assert!(!is_newer("next", "0.16.9"));
    }

    #[test]
    fn a_manifest_offers_this_platforms_archive_of_a_newer_release() {
        let [key, _] = platform_keys();
        let text = format!(
            r#"{{"version":"v9.0.0","notes":"n","platforms":{{"{key}":{{"url":"https://e/x.tar.gz","signature":"c2ln"}}}}}}"#
        );
        let release = newer_release(&text, "0.16.0").unwrap().unwrap();
        assert_eq!(release.version, "9.0.0");
        assert_eq!(release.platform.url, "https://e/x.tar.gz");
        assert_eq!(newer_release(&text, "9.0.0").unwrap(), None);
        let elsewhere =
            r#"{"version":"9.0.0","platforms":{"plan9-mips":{"url":"u","signature":"s"}}}"#;
        assert_eq!(newer_release(elsewhere, "0.1.0").unwrap(), None);
        assert!(newer_release("not json", "0.1.0").is_err());
    }

    #[test]
    fn the_classic_version_is_taken_whatever_its_version() {
        let [_, key] = platform_keys();
        let text = format!(
            r#"{{"version":"0.19.0","platforms":{{"{key}":{{"url":"https://e/c.tar.gz","signature":"c2ln"}}}}}}"#
        );
        // Not an update to the native 0.19.0 or a later one...
        assert_eq!(newer_release(&text, "0.19.0").unwrap(), None);
        assert_eq!(newer_release(&text, "0.20.0").unwrap(), None);
        // ...but the classic version all the same.
        let release = platform_release(&text).unwrap().unwrap();
        assert_eq!(release.version, "0.19.0");
        assert_eq!(release.platform.url, "https://e/c.tar.gz");
        let elsewhere =
            r#"{"version":"0.19.0","platforms":{"plan9-mips":{"url":"u","signature":"s"}}}"#;
        assert_eq!(platform_release(elsewhere).unwrap(), None);
    }
}
