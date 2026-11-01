//! Downloading, verifying and removing the pinned rtex release.

use super::{home, RTEX_VERSION};
use crate::tex_setup::{create_private_file, download_pinned, PinnedDownload};
use crate::util::{swap_in_dir, DirSwapError};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError, TryLockError};
use std::time::Duration;
use tauri::ipc::Channel;

/// The Apple Silicon build of rtex, the only Macs Lattice runs on. The digest
/// is the one the release's SHA256SUMS lists.
const RTEX: PinnedDownload = PinnedDownload {
    url: "https://github.com/HenryXiaoYang/realtime-tex/releases/download/v0.0.6/rtex-aarch64-apple-darwin.tar.gz",
    sha256: "99f56b8cde472de0c4c3b4814f7453e97f789ace9e3114a9d7e9f9df2cb68864",
    timeout: Duration::from_secs(10 * 60),
    name: "rtex",
    source: "the rtex live preview engine",
    artifact: "rtex archive",
};
/// The folder the archive unpacks into.
const ARCHIVE_ROOT: &str = "rtex-0.0.6-aarch64-apple-darwin";

/// Where the verified release lives: `bin/rtex`, and `share/rtex/tex` beside
/// it, where rtex looks for its TeX and Lua support files.
fn install_dir() -> Option<PathBuf> {
    home().map(|home| home.join(format!("rtex-{RTEX_VERSION}")))
}

/// The installed `rtex` executable, when the release is complete.
pub(super) fn installed_executable() -> Option<PathBuf> {
    let dir = install_dir()?;
    is_complete(&dir).then(|| dir.join("bin/rtex"))
}

fn is_complete(dir: &Path) -> bool {
    let executable = dir.join("bin/rtex");
    let regular = |path: &Path| {
        fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
    };
    regular(&executable)
        && fs::metadata(&executable)
            .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
        && regular(&dir.join("share/rtex/tex/rtex-serve.lua"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallStatus {
    /// This Mac can run the pinned release.
    supported: bool,
    /// The user's `lualatex` runs; rtex has nothing to drive without it. Not
    /// checked where the release cannot run.
    lualatex: bool,
    installed: bool,
    version: &'static str,
}

/// Runs a `lualatex --version` until one succeeds: call it off the main thread.
pub(crate) fn status() -> InstallStatus {
    let supported = platform_supported();
    InstallStatus {
        supported,
        lualatex: supported && lualatex_runs(),
        installed: installed_executable().is_some(),
        version: RTEX_VERSION,
    }
}

fn platform_supported() -> bool {
    cfg!(target_os = "macos") && std::env::consts::ARCH == "aarch64"
}

/// A `lualatex` on the search path builds use that answers `--version`. Only
/// a yes is remembered, so TeX installed while Lattice runs is found the next
/// time a LuaLaTeX project opens.
fn lualatex_runs() -> bool {
    static RUNS: AtomicBool = AtomicBool::new(false);
    if RUNS.load(Ordering::Relaxed) {
        return true;
    }
    let runs = crate::commands::command("lualatex")
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .is_ok_and(|output| output.status.success());
    RUNS.fetch_or(runs, Ordering::Relaxed);
    runs
}

/// Why this Mac does not download rtex, if it does not: the window offers
/// live preview by default, so the host refuses rather than trusting it to ask.
fn refusal(supported: bool, lualatex: bool) -> Option<&'static str> {
    if !supported {
        Some("Live preview needs a Mac with Apple silicon.")
    } else if !lualatex {
        Some("Live preview needs LuaLaTeX, and Lattice could not run it.")
    } else {
        None
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallProgress {
    /// "downloading", "verifying" or "complete".
    stage: &'static str,
    /// 0 to 1; downloads report the share of bytes received.
    progress: f64,
}

/// One download or removal at a time across every window: two would race to
/// swap the same folder in. Live preview is on by default, so two windows
/// opening LuaLaTeX projects at once is ordinary: the second install waits
/// for the first and then finds rtex in place.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// Download, verify and unpack the pinned release unless it is already in
/// place.
pub(crate) fn install(on_progress: &Channel<InstallProgress>) -> Result<InstallStatus, String> {
    let supported = platform_supported();
    if let Some(reason) = refusal(supported, supported && lualatex_runs()) {
        return Err(reason.into());
    }
    let _guard = INSTALL_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let send = |stage, progress| {
        let _ = on_progress.send(InstallProgress { stage, progress });
    };
    if installed_executable().is_some() {
        send("complete", 1.0);
        return Ok(status());
    }
    let home = home().ok_or("Could not locate your macOS Application Support folder.")?;
    let destination = install_dir().ok_or("Could not locate the live preview folder.")?;
    fs::create_dir_all(&home)
        .map_err(|error| format!("Could not create {}: {error}", home.display()))?;
    let staging = home.join(format!(".rtex-install-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&staging)
        .map_err(|error| format!("Could not prepare the rtex download: {error}"))?;
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not secure the rtex download: {error}"))?;
    let result = (|| {
        let archive = staging.join("rtex.tar.gz");
        send("downloading", 0.0);
        let mut last_step = 0;
        download_pinned(&RTEX, &archive, |downloaded, total| {
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
            .map_err(|error| format!("Could not unpack the rtex archive: {error}"))?;
        extract_release(&archive, &unpacked, ARCHIVE_ROOT)?;
        if !is_complete(&unpacked) {
            return Err("The rtex archive did not contain the live preview engine.".to_string());
        }
        activate(&unpacked, &destination)
    })();
    let _ = fs::remove_dir_all(&staging);
    result?;
    log::info!(
        target: "lattice::live-preview",
        "Installed rtex {RTEX_VERSION} in {}",
        destination.display()
    );
    send("complete", 1.0);
    Ok(status())
}

fn activate(staged: &Path, destination: &Path) -> Result<(), String> {
    match swap_in_dir(staged, destination, "lattice-backup") {
        Ok(()) => Ok(()),
        // The new copy is in; only the old one could not be deleted.
        Err(DirSwapError::RemoveBackup(error)) => {
            log::warn!(target: "lattice::live-preview", "Could not remove the old rtex: {error}");
            Ok(())
        }
        Err(DirSwapError::Inspect(error)) => {
            Err(format!("Could not inspect the installed rtex: {error}"))
        }
        Err(DirSwapError::Backup(error)) => {
            Err(format!("Could not replace the installed rtex: {error}"))
        }
        Err(DirSwapError::Activate { error, .. }) => {
            Err(format!("Could not install rtex: {error}"))
        }
    }
}

/// Delete the release and every build folder. Sessions must be stopped first.
pub(crate) fn remove() -> Result<InstallStatus, String> {
    // Not behind a download that can take minutes: say so instead.
    let _guard = match INSTALL_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => {
            return Err("rtex is still downloading. Remove it once the download finishes.".into())
        }
    };
    if let Some(home) = home() {
        match fs::remove_dir_all(&home) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not remove rtex: {error}")),
        }
    }
    Ok(status())
}

/// Unpack `bin/rtex`, `share/rtex/tex/**` and `LICENSE` from `archive_root/`
/// into `destination`. The C library, headers and readme are left out, and
/// anything that is not a plain file or folder, or that would land outside
/// `destination`, is refused.
fn extract_release(archive: &Path, destination: &Path, archive_root: &str) -> Result<(), String> {
    let file = fs::File::open(archive)
        .map_err(|error| format!("Could not read the rtex archive: {error}"))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let inspect = |error: std::io::Error| format!("Could not inspect the rtex archive: {error}");
    for entry in archive.entries().map_err(inspect)? {
        let mut entry = entry.map_err(inspect)?;
        let path = entry
            .path()
            .map_err(|error| format!("The rtex archive contained an invalid path: {error}"))?
            .into_owned();
        let Ok(relative) = path.strip_prefix(archive_root) else {
            return Err(format!(
                "The rtex archive contained an unexpected entry: {}",
                path.display()
            ));
        };
        if relative.components().any(|part| !matches!(part, Component::Normal(_))) {
            return Err(format!("The rtex archive contained an unsafe path: {}", path.display()));
        }
        let wanted = relative == Path::new("bin/rtex")
            || relative == Path::new("LICENSE")
            || relative.starts_with("share/rtex/tex");
        let entry_type = entry.header().entry_type();
        // Folders come into being with the files under them.
        if entry_type.is_dir() {
            continue;
        }
        if !wanted {
            continue;
        }
        if !entry_type.is_file() {
            return Err(format!("The rtex archive contained a link at {}", path.display()));
        }
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not unpack the rtex archive: {error}"))?;
        }
        let mut output = create_private_file(&target)?;
        std::io::copy(&mut entry, &mut output)
            .and_then(|_| output.flush())
            .map_err(|error| format!("Could not unpack {}: {error}", relative.display()))?;
        let mode = if relative == Path::new("bin/rtex") { 0o755 } else { 0o644 };
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
        let path = dir.join("rtex.tar.gz");
        let file = fs::File::create(&path).unwrap();
        let mut builder =
            tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::fast()));
        for (name, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, *data).unwrap();
        }
        if let Some((name, target)) = link {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            builder.append_link(&mut header, name, target).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
        path
    }

    #[test]
    fn the_pin_is_an_https_github_release_with_a_full_digest() {
        assert!(RTEX.url.starts_with(&format!(
            "https://github.com/HenryXiaoYang/realtime-tex/releases/download/v{RTEX_VERSION}/"
        )));
        assert!(RTEX.url.ends_with("/rtex-aarch64-apple-darwin.tar.gz"));
        assert_eq!(ARCHIVE_ROOT, format!("rtex-{RTEX_VERSION}-aarch64-apple-darwin"));
        assert_eq!(RTEX.sha256.len(), 64);
        assert!(RTEX.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn downloads_only_where_rtex_can_drive_lualatex() {
        assert!(refusal(false, false).unwrap().contains("Apple silicon"));
        assert!(refusal(false, true).unwrap().contains("Apple silicon"));
        assert!(refusal(true, false).unwrap().contains("LuaLaTeX"));
        assert_eq!(refusal(true, true), None);
    }

    #[test]
    fn unpacks_only_the_executable_and_its_tex_files() {
        let dir = TempDir::new("rtex-extract");
        let root = ARCHIVE_ROOT;
        let path = archive(
            &dir,
            &[
                (&format!("{root}/bin/rtex"), b"#!/bin/sh\n"),
                (&format!("{root}/lib/librtex_core.dylib"), b"lib"),
                (&format!("{root}/include/rtex.h"), b"h"),
                (&format!("{root}/README.md"), b"readme"),
                (&format!("{root}/LICENSE"), b"MIT"),
                (&format!("{root}/share/rtex/tex/rtex-serve.lua"), b"lua"),
                (&format!("{root}/share/rtex/tex/latex/rtex-capture.sty"), b"sty"),
            ],
            None,
        );
        let out = dir.join("out");
        fs::create_dir(&out).unwrap();
        extract_release(&path, &out, root).unwrap();
        assert!(is_complete(&out));
        assert!(out.join("share/rtex/tex/latex/rtex-capture.sty").is_file());
        assert!(out.join("LICENSE").is_file());
        assert!(!out.join("lib").exists());
        assert!(!out.join("README.md").exists());
        assert_eq!(fs::metadata(out.join("bin/rtex")).unwrap().permissions().mode() & 0o777, 0o755);
    }

    #[test]
    fn refuses_links_and_entries_outside_the_release_folder() {
        let dir = TempDir::new("rtex-extract-bad");
        let out = dir.join("out");
        fs::create_dir(&out).unwrap();
        let stray = archive(&dir, &[("elsewhere/bin/rtex", b"x")], None);
        assert!(extract_release(&stray, &out, ARCHIVE_ROOT).unwrap_err().contains("unexpected"));
        fs::remove_file(&stray).unwrap();
        let link = archive(&dir, &[], Some((&format!("{ARCHIVE_ROOT}/bin/rtex"), "/bin/sh")));
        assert!(extract_release(&link, &out, ARCHIVE_ROOT).unwrap_err().contains("link"));
    }
}
