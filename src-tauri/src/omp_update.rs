//! Keeping the bundled agent runtime (Oh My Pi, and the `pi` native module it
//! loads) current without shipping a whole new app.
//!
//! The app bundle carries a known-good copy of both, but the runtime moves far
//! faster than Lattice releases, and new models appear there first. Updating
//! the copy inside the bundle is not an option — on macOS that invalidates the
//! app's signature — so a newer runtime is installed alongside, under the app's
//! own data directory, and preferred at launch. The bundled copy stays as the
//! floor, which means a bad download can always be recovered from by deleting
//! one directory.
//!
//! Both halves are verified before they are used: the executable against the
//! SHA-256 GitHub reports for the release asset, and the native module against
//! the SHA-512 integrity npm reports for the package tarball. Nothing is moved
//! into place until it matches.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const RELEASES: &str = "https://api.github.com/repos/can1357/oh-my-pi/releases/latest";
const NPM_REGISTRY: &str = "https://registry.npmjs.org";
/// The runtime is a ~125 MB executable plus a ~136 MB native module; a slow
/// connection should not be told the download failed halfway through.
const DOWNLOAD_TIMEOUT_SECS: u64 = 900;
const INSTALLED_DIR: &str = "runtime";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// What is installed, and what is available.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// The version that will actually run.
    pub current: String,
    /// The version inside the app bundle; the floor this can fall back to.
    pub bundled: String,
    /// The newest release, when the check reached GitHub.
    pub latest: Option<String>,
    /// True when `latest` is newer than `current`.
    pub update_available: bool,
    /// Why there is no `latest`, when the check could not run.
    pub detail: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    /// `sha256:<hex>` on releases published since GitHub added asset digests.
    #[serde(default)]
    digest: Option<String>,
}

/// What we recorded about a runtime we installed ourselves.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Installed {
    version: String,
}

fn client(timeout: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        // GitHub rejects requests without one, and npm rate-limits them harder.
        .user_agent("Lattice")
        .timeout(std::time::Duration::from_secs(timeout))
        .build()
        .map_err(err)
}

/// `omp-darwin-arm64`, `omp-windows-x64.exe`, … for the machine this runs on.
fn asset_name() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "omp-darwin-arm64",
        ("macos", "x86_64") => "omp-darwin-x64",
        ("linux", "aarch64") => "omp-linux-arm64",
        ("linux", "x86_64") => "omp-linux-x64",
        ("windows", "x86_64") => "omp-windows-x64.exe",
        _ => return None,
    })
}

/// The npm package holding the native module, and the file inside it.
pub fn native_platform() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("windows", "x86_64") => "win32-x64",
        _ => return None,
    })
}

fn install_root(config_dir: &Path) -> PathBuf {
    config_dir.join(INSTALLED_DIR)
}

fn installed_record(config_dir: &Path) -> Option<Installed> {
    let raw = fs::read_to_string(install_root(config_dir).join("installed.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn version_dir(config_dir: &Path, version: &str) -> PathBuf {
    install_root(config_dir).join(version)
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "omp.exe"
    } else {
        "omp"
    }
}

/// The runtime that should actually run: the newest installed copy that is
/// still on disk and newer than the bundle, else the bundled one.
pub fn resolve_executable(bundled: &Path, config_dir: &Path, bundled_version: &str) -> PathBuf {
    let Some(installed) = installed_record(config_dir) else {
        return bundled.to_path_buf();
    };
    if compare_versions(&installed.version, bundled_version) != std::cmp::Ordering::Greater {
        return bundled.to_path_buf();
    }
    let candidate = version_dir(config_dir, &installed.version).join(executable_name());
    if candidate.is_file() {
        candidate
    } else {
        bundled.to_path_buf()
    }
}

/// The native module belonging to whichever runtime is in use, if we have it.
pub fn resolve_native(config_dir: &Path, version: &str) -> Option<PathBuf> {
    let platform = native_platform()?;
    let path = version_dir(config_dir, version)
        .join("natives")
        .join(format!("pi_natives.{platform}.node"));
    path.is_file().then_some(path)
}

/// The version that will run, which is the installed one when it wins.
pub fn current_version(config_dir: &Path, bundled_version: &str) -> String {
    match installed_record(config_dir) {
        Some(installed)
            if compare_versions(&installed.version, bundled_version)
                == std::cmp::Ordering::Greater
                && version_dir(config_dir, &installed.version)
                    .join(executable_name())
                    .is_file() =>
        {
            installed.version
        }
        _ => bundled_version.to_string(),
    }
}

/// Compare `17.1.2`-style versions numerically, so 17.10.0 beats 17.9.0.
///
/// String comparison gets that backwards, and getting it backwards means
/// offering an "update" that installs an older runtime.
pub fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parts = |value: &str| -> Vec<u64> {
        value
            .trim_start_matches('v')
            .split(['.', '-'])
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (left, right) = (parts(left), parts(right));
    for index in 0..left.len().max(right.len()) {
        let ordering = left
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right.get(index).copied().unwrap_or(0));
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    std::cmp::Ordering::Equal
}

/// What is installed now, and whether a newer runtime is published.
pub fn status(config_dir: &Path, bundled_version: &str) -> RuntimeStatus {
    let current = current_version(config_dir, bundled_version);
    match latest_release() {
        Ok(release) => {
            let latest = release.tag_name.trim_start_matches('v').to_string();
            RuntimeStatus {
                update_available: compare_versions(&latest, &current)
                    == std::cmp::Ordering::Greater,
                current,
                bundled: bundled_version.to_string(),
                latest: Some(latest),
                detail: None,
            }
        }
        Err(detail) => RuntimeStatus {
            current,
            bundled: bundled_version.to_string(),
            latest: None,
            update_available: false,
            detail: Some(detail),
        },
    }
}

fn latest_release() -> Result<Release, String> {
    let response = client(30)?
        .get(RELEASES)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub returned {} when checking for an agent update.",
            response.status()
        ));
    }
    response.json::<Release>().map_err(err)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Download, verify and install the newest runtime. Answers with its version.
///
/// Everything lands in a temporary directory and is only renamed into place
/// once both halves have been verified, so an interrupted update leaves the
/// previous runtime — bundled or installed — untouched and still working.
pub fn install_latest(config_dir: &Path) -> Result<String, String> {
    let asset_name = asset_name()
        .ok_or_else(|| "Oh My Pi does not publish a runtime for this machine.".to_string())?;
    let release = latest_release()?;
    let version = release.tag_name.trim_start_matches('v').to_string();
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == asset_name)
        .ok_or_else(|| format!("Release {version} has no {asset_name} to install."))?;

    let root = install_root(config_dir);
    fs::create_dir_all(&root).map_err(err)?;
    let staging = root.join(format!("{version}.partial"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(staging.join("natives")).map_err(err)?;

    let binary = download(&asset.browser_download_url, "the agent runtime")?;
    if let Some(expected) = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
    {
        let actual = sha256_hex(&binary);
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_dir_all(&staging);
            return Err("The downloaded agent runtime failed its checksum.".to_string());
        }
    }
    let executable = staging.join(executable_name());
    fs::write(&executable, &binary).map_err(err)?;
    make_executable(&executable)?;

    // The native module is versioned in lockstep with the runtime and is not
    // part of the GitHub release, so it comes from npm.
    if let Some(platform) = native_platform() {
        let file = format!("pi_natives.{platform}.node");
        let native = fetch_native(platform, &version, &file)?;
        fs::write(staging.join("natives").join(&file), native).map_err(err)?;
    }

    let target = version_dir(config_dir, &version);
    let _ = fs::remove_dir_all(&target);
    fs::rename(&staging, &target).map_err(err)?;
    fs::write(
        root.join("installed.json"),
        serde_json::to_string_pretty(&Installed {
            version: version.clone(),
        })
        .map_err(err)?
            + "\n",
    )
    .map_err(err)?;

    // Keep only what is in use; each runtime is a quarter of a gigabyte.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if entry.path().is_dir() && name != version {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(version)
}

/// Throw away every installed runtime, falling back to the app's own copy.
///
/// The bundled runtime is known to work with this version of the app; an
/// installed one is newer but not guaranteed to be, so there has to be a way
/// back that does not involve finding a directory by hand.
pub fn revert_to_bundled(config_dir: &Path) -> Result<(), String> {
    let root = install_root(config_dir);
    if !root.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&root)
        .map_err(|e| format!("Could not remove the installed agent runtime: {e}"))
}

fn download(url: &str, what: &str) -> Result<Vec<u8>, String> {
    let response = client(DOWNLOAD_TIMEOUT_SECS)?
        .get(url)
        .send()
        .map_err(|e| format!("Could not download {what}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Downloading {what} returned {}.",
            response.status()
        ));
    }
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|e| format!("Could not read {what}: {e}"))
}

/// Pull `pi_natives.<platform>.node` out of the npm package for this version.
fn fetch_native(platform: &str, version: &str, file: &str) -> Result<Vec<u8>, String> {
    let package = format!("@oh-my-pi/pi-natives-{platform}");
    let url = format!("{NPM_REGISTRY}/{}/{version}", package.replace('/', "%2f"));
    let meta: serde_json::Value = client(30)?
        .get(&url)
        .send()
        .map_err(|e| format!("Could not reach npm: {e}"))?
        .json()
        .map_err(|e| format!("npm did not describe {package}@{version}: {e}"))?;
    let tarball = meta
        .get("dist")
        .and_then(|dist| dist.get("tarball"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("npm has no download for {package}@{version}."))?;
    let integrity = meta
        .get("dist")
        .and_then(|dist| dist.get("integrity"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    let archive = download(tarball, "the agent's native module")?;
    if let Some(expected) = integrity.as_deref().and_then(|v| v.strip_prefix("sha512-")) {
        use sha2::Sha512;
        let mut hasher = Sha512::new();
        hasher.update(&archive);
        let actual = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            hasher.finalize(),
        );
        if actual != expected {
            return Err("The agent's native module failed its checksum.".to_string());
        }
    }

    let decoder = flate2::read::GzDecoder::new(&archive[..]);
    let mut tar = tar::Archive::new(decoder);
    for entry in tar.entries().map_err(err)? {
        let mut entry = entry.map_err(err)?;
        let path = entry.path().map_err(err)?.to_path_buf();
        if path.file_name().and_then(|name| name.to_str()) == Some(file) {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(err)?;
            return Ok(bytes);
        }
    }
    Err(format!("{package}@{version} does not contain {file}."))
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(err)
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically_not_as_text() {
        use std::cmp::Ordering;
        // The case that matters: as text, "17.9.0" sorts after "17.10.0", and
        // acting on that would offer an update that installs an older runtime.
        assert_eq!(compare_versions("17.10.0", "17.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("17.1.2", "17.1.2"), Ordering::Equal);
        assert_eq!(compare_versions("v17.1.2", "17.1.2"), Ordering::Equal);
        assert_eq!(compare_versions("17.0.5", "17.1.0"), Ordering::Less);
        assert_eq!(compare_versions("18.0.0", "17.99.99"), Ordering::Greater);
        // Missing parts read as zero rather than as "unknown".
        assert_eq!(compare_versions("17.1", "17.1.0"), Ordering::Equal);
        assert_eq!(compare_versions("17.1.1", "17.1"), Ordering::Greater);
    }

    /// Downloads and verifies the real runtime, then checks it actually runs.
    ///
    /// Two ~130 MB downloads and a checksum each; the point is that the asset
    /// names, the digests and the npm layout are what this code assumes, which
    /// nothing local can tell us.
    #[test]
    #[ignore = "downloads ~260 MB from GitHub and npm"]
    fn installs_the_real_runtime() {
        let root = std::env::temp_dir().join(format!("lattice-omp-e2e-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        let before = status(&root, "17.0.5");
        println!(
            "bundled {} · latest {:?} · update available {}",
            before.bundled, before.latest, before.update_available
        );
        assert!(before.latest.is_some(), "{:?}", before.detail);
        assert!(before.update_available, "17.0.5 should not be the newest");

        let version = install_latest(&root).expect("install the runtime");
        println!("installed {version}");
        let executable = resolve_executable(Path::new("/nonexistent"), &root, "17.0.5");
        assert!(executable.is_file(), "the runtime should be on disk");
        assert_eq!(current_version(&root, "17.0.5"), version);
        assert!(
            resolve_native(&root, &version).is_some_and(|path| path
                .metadata()
                .map(|meta| meta.len() > 1_000_000)
                .unwrap_or(false)),
            "the native module should be installed beside it"
        );

        // The real check: it starts, and reports the version we asked for.
        let output = std::process::Command::new(&executable)
            .arg("--version")
            .env("PI_CODING_AGENT_DIR", root.join("config"))
            .output()
            .expect("run the installed runtime");
        let reported = String::from_utf8_lossy(&output.stdout);
        println!("`omp --version` says: {}", reported.trim());
        assert!(
            reported.contains(&version),
            "expected {version} in {reported:?}"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reverting_leaves_the_bundle_in_charge() {
        let root = std::env::temp_dir().join(format!("lattice-omp-{}", uuid::Uuid::new_v4()));
        let bundled = root.join("bundled-omp");
        fs::create_dir_all(root.join("runtime/17.2.0")).unwrap();
        fs::write(&bundled, b"x").unwrap();
        fs::write(root.join("runtime/17.2.0").join(executable_name()), b"x").unwrap();
        fs::write(
            root.join("runtime/installed.json"),
            r#"{"version":"17.2.0"}"#,
        )
        .unwrap();
        assert_ne!(resolve_executable(&bundled, &root, "17.0.5"), bundled);

        revert_to_bundled(&root).unwrap();
        assert_eq!(resolve_executable(&bundled, &root, "17.0.5"), bundled);
        assert_eq!(current_version(&root, "17.0.5"), "17.0.5");
        // Reverting twice is not an error; there is simply nothing left.
        revert_to_bundled(&root).unwrap();

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn falls_back_to_the_bundle_when_nothing_better_is_installed() {
        let root = std::env::temp_dir().join(format!("lattice-omp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let bundled = root.join("bundled-omp");
        fs::write(&bundled, b"x").unwrap();

        // Nothing installed at all.
        assert_eq!(resolve_executable(&bundled, &root, "17.0.5"), bundled);
        assert_eq!(current_version(&root, "17.0.5"), "17.0.5");

        // An older install must never win over the bundle.
        fs::create_dir_all(root.join("runtime/17.0.1")).unwrap();
        fs::write(root.join("runtime/17.0.1").join(executable_name()), b"x").unwrap();
        fs::write(
            root.join("runtime/installed.json"),
            r#"{"version":"17.0.1"}"#,
        )
        .unwrap();
        assert_eq!(resolve_executable(&bundled, &root, "17.0.5"), bundled);

        // A newer one does, but only while its executable is actually there.
        fs::write(
            root.join("runtime/installed.json"),
            r#"{"version":"17.2.0"}"#,
        )
        .unwrap();
        assert_eq!(resolve_executable(&bundled, &root, "17.0.5"), bundled);
        let newer = root.join("runtime/17.2.0");
        fs::create_dir_all(&newer).unwrap();
        fs::write(newer.join(executable_name()), b"x").unwrap();
        assert_eq!(
            resolve_executable(&bundled, &root, "17.0.5"),
            newer.join(executable_name())
        );
        assert_eq!(current_version(&root, "17.0.5"), "17.2.0");

        fs::remove_dir_all(&root).unwrap();
    }
}
