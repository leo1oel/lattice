//! Downloading and verifying the pinned FlashTeX release.

use super::{home, FLASHTEX_VERSION, UNICODE_HOST_VARIABLE};
use crate::host::Sink;
use crate::tex_setup::{create_private_file, download_pinned, PinnedDownload};
use crate::util::{swap_in_dir, DirSwapError};
use serde::Serialize;
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

/// FlashTeX publishes its command-line tools for Apple silicon only (and a
/// Linux build Lattice has no use for), so an Intel Mac gets no download.
/// The digest is the one the release's SHA256SUMS lists.
const FLASHTEX: PinnedDownload = PinnedDownload {
    url: "https://github.com/flash-tex/flashtex/releases/download/v0.2.0/flashtex-cli-0.2.0-macos-arm64.tar.gz",
    sha256: "6839bd737c82d73dd17147a806ba2117b083df45f1baae79882d711adda0bc4b",
    timeout: Duration::from_secs(10 * 60),
    name: "FlashTeX",
    source: "the FlashTeX preview engine",
    artifact: "FlashTeX archive",
    // 23,602,331 bytes, and half as much again.
    max_bytes: 35_400_000,
};
/// The folder the archive unpacks into.
const ARCHIVE_ROOT: &str = "flashtex-cli-0.2.0-macos-arm64";

/// What the spike keeps of the archive: the host, the string pool it reads
/// from beside itself, and the engine's licence and notices. The other tools
/// (the IDE's renderer and compilers) and the fonts they bundle are left out.
const KEPT: [&str; 4] = [
    "bin/flashtex-host",
    "bin/pdftex.pool",
    "share/flashtex/engine/LICENSE",
    "share/flashtex/engine/THIRD-PARTY-NOTICES",
];

fn install_dir() -> Option<PathBuf> {
    home().map(|home| home.join(format!("flashtex-{FLASHTEX_VERSION}")))
}

/// The installed pdfLaTeX host, when the release is complete.
pub(super) fn installed_host() -> Option<PathBuf> {
    let dir = install_dir()?;
    is_complete(&dir).then(|| dir.join("bin/flashtex-host"))
}

/// The developer's own XeTeX host, when they named one that exists.
pub(super) fn unicode_host() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(UNICODE_HOST_VARIABLE)?);
    (path.is_absolute() && path.is_file()).then_some(path)
}

fn is_complete(dir: &Path) -> bool {
    let regular = |path: &Path| {
        fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
    };
    KEPT.iter().all(|kept| regular(&dir.join(kept)))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    /// This Mac can run the pinned release.
    supported: bool,
    installed: bool,
    /// A XeTeX host is available for XeLaTeX projects (see `unicode_host`).
    unicode: bool,
    version: &'static str,
}

pub fn status() -> InstallStatus {
    InstallStatus {
        supported: platform_supported(),
        installed: installed_host().is_some(),
        unicode: unicode_host().is_some(),
        version: FLASHTEX_VERSION,
    }
}

fn platform_supported() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// "downloading", "verifying" or "complete".
    stage: &'static str,
    /// 0 to 1; downloads report the share of bytes received.
    progress: f64,
}

/// One download at a time across every window: two would race to swap the
/// same folder in.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// Download, verify and unpack the pinned release unless it is in place.
pub fn install(on_progress: &dyn Sink<InstallProgress>) -> Result<InstallStatus, String> {
    if !platform_supported() {
        return Err("The FlashTeX preview needs a Mac with Apple silicon.".into());
    }
    let _guard = INSTALL_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let send = |stage, progress| {
        let _ = on_progress.send(InstallProgress { stage, progress });
    };
    if installed_host().is_some() {
        send("complete", 1.0);
        return Ok(status());
    }
    let home = home().ok_or("Could not locate your macOS Application Support folder.")?;
    let destination = install_dir().ok_or("Could not locate the FlashTeX preview folder.")?;
    fs::create_dir_all(&home)
        .map_err(|error| format!("Could not create {}: {error}", home.display()))?;
    let staging = home.join(format!(".flashtex-install-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&staging)
        .map_err(|error| format!("Could not prepare the FlashTeX download: {error}"))?;
    #[cfg(unix)]
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not secure the FlashTeX download: {error}"))?;
    let result = (|| {
        let archive = staging.join("flashtex.tar.gz");
        send("downloading", 0.0);
        let mut last_step = 0;
        download_pinned(&FLASHTEX, &archive, |downloaded, total| {
            let fraction = (downloaded as f64 / total as f64).clamp(0.0, 1.0);
            let step = (fraction * 100.0) as u64;
            if step > last_step {
                last_step = step;
                send("downloading", fraction);
            }
        })?;
        send("verifying", 1.0);
        let unpacked = staging.join("release");
        fs::create_dir(&unpacked)
            .map_err(|error| format!("Could not unpack the FlashTeX archive: {error}"))?;
        extract_release(&archive, &unpacked, ARCHIVE_ROOT)?;
        if !is_complete(&unpacked) {
            return Err("The FlashTeX archive did not contain flashtex-host.".to_string());
        }
        match swap_in_dir(&unpacked, &destination, "lattice-backup") {
            Ok(()) | Err(DirSwapError::RemoveBackup(_)) => Ok(()),
            Err(_) => Err("Could not install FlashTeX.".to_string()),
        }
    })();
    let _ = fs::remove_dir_all(&staging);
    result?;
    log::info!(
        target: "lattice::flashtex-preview",
        "Installed FlashTeX {FLASHTEX_VERSION} in {}",
        destination.display()
    );
    send("complete", 1.0);
    Ok(status())
}

/// Unpack the `KEPT` files from `archive_root/` into `destination`. A kept
/// entry that is not a plain file, or anything that would land outside
/// `destination`, is refused; the rest of the archive is skipped.
fn extract_release(archive: &Path, destination: &Path, archive_root: &str) -> Result<(), String> {
    let file = fs::File::open(archive)
        .map_err(|error| format!("Could not read the FlashTeX archive: {error}"))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let inspect =
        |error: std::io::Error| format!("Could not inspect the FlashTeX archive: {error}");
    for entry in archive.entries().map_err(inspect)? {
        let mut entry = entry.map_err(inspect)?;
        let path = entry
            .path()
            .map_err(|error| format!("The FlashTeX archive contained an invalid path: {error}"))?
            .into_owned();
        let Ok(relative) = path.strip_prefix(archive_root) else {
            return Err(format!(
                "The FlashTeX archive contained an unexpected entry: {}",
                path.display()
            ));
        };
        if relative.components().any(|part| !matches!(part, Component::Normal(_))) {
            return Err(format!(
                "The FlashTeX archive contained an unsafe path: {}",
                path.display()
            ));
        }
        if !KEPT.iter().any(|kept| relative == Path::new(kept)) {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err(format!("The FlashTeX archive contained a link at {}", path.display()));
        }
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not unpack the FlashTeX archive: {error}"))?;
        }
        let mut output = create_private_file(&target)?;
        std::io::copy(&mut entry, &mut output)
            .and_then(|_| output.flush())
            .map_err(|error| format!("Could not unpack {}: {error}", relative.display()))?;
        #[cfg(unix)]
        let mode = if relative == Path::new(KEPT[0]) { 0o755 } else { 0o644 };
        #[cfg(unix)]
        fs::set_permissions(&target, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("Could not unpack {}: {error}", relative.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn archive(dir: &Path, entries: &[(&str, &[u8])], link: Option<(&str, &str)>) -> PathBuf {
        let path = dir.join("flashtex.tar.gz");
        let file = fs::File::create(&path).unwrap();
        let mut builder =
            tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::fast()));
        if let Some((name, target)) = link {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            builder.append_link(&mut header, name, target).unwrap();
        }
        for (name, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
        path
    }

    #[test]
    fn the_pin_is_an_https_github_release_with_a_full_digest() {
        assert!(FLASHTEX.url.starts_with(&format!(
            "https://github.com/flash-tex/flashtex/releases/download/v{FLASHTEX_VERSION}/"
        )));
        assert!(FLASHTEX.url.ends_with(&format!("/{ARCHIVE_ROOT}.tar.gz")));
        assert_eq!(ARCHIVE_ROOT, format!("flashtex-cli-{FLASHTEX_VERSION}-macos-arm64"));
        assert_eq!(FLASHTEX.sha256.len(), 64);
        assert!(FLASHTEX.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn unpacks_only_the_host_its_pool_and_its_licence() {
        let dir = TempDir::new("flashtex-extract");
        let root = ARCHIVE_ROOT;
        let path = archive(
            &dir,
            &[
                (&format!("{root}/bin/flashtex-host"), b"#!/bin/sh\n"),
                (&format!("{root}/bin/pdftex.pool"), b"pool"),
                (&format!("{root}/bin/flashtex-render"), b"renderer"),
                (&format!("{root}/share/flashtex/engine/LICENSE"), b"GPL"),
                (&format!("{root}/share/flashtex/engine/THIRD-PARTY-NOTICES"), b"notices"),
                (&format!("{root}/share/flashtex/Fonts/lmroman10-regular.otf"), b"font"),
            ],
            // The release's own links for its helper tools are skipped, not refused.
            Some((&format!("{root}/bin/texmf"), "../share/flashtex/texmf")),
        );
        let out = dir.join("out");
        fs::create_dir(&out).unwrap();
        extract_release(&path, &out, root).unwrap();
        assert!(is_complete(&out));
        assert!(!out.join("bin/flashtex-render").exists());
        assert!(!out.join("bin/texmf").exists());
        assert!(!out.join("share/flashtex/Fonts").exists());
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(out.join("bin/flashtex-host")).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn refuses_a_linked_host_and_entries_outside_the_release_folder() {
        let dir = TempDir::new("flashtex-extract-bad");
        let out = dir.join("out");
        fs::create_dir(&out).unwrap();
        let stray = archive(&dir, &[("elsewhere/bin/flashtex-host", b"x")], None);
        assert!(extract_release(&stray, &out, ARCHIVE_ROOT).unwrap_err().contains("unexpected"));
        fs::remove_file(&stray).unwrap();
        let link =
            archive(&dir, &[], Some((&format!("{ARCHIVE_ROOT}/bin/flashtex-host"), "/bin/sh")));
        assert!(extract_release(&link, &out, ARCHIVE_ROOT).unwrap_err().contains("link"));
    }
}
