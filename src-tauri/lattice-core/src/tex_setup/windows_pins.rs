//! The downloads the Windows installers pin, by exact version and SHA-256:
//! the managed uv and the TeX Live installer.

use super::installer::PinnedDownload;
use std::time::Duration;

/// The managed uv release for 64-bit Windows: one flat zip of `uv.exe`,
/// `uvx.exe` and the windowed shim `uvw.exe` (see `uv_zip`). The digest is the
/// one the release publishes beside the asset (`…zip.sha256`).
pub(super) const UV: PinnedDownload = PinnedDownload {
    url: "https://github.com/astral-sh/uv/releases/download/0.12.3/uv-x86_64-pc-windows-msvc.zip",
    sha256: "b23350c79e8ad0192b8124af13a0f17e8d4e4549524785e1aef389ae5a06990e",
    timeout: Duration::from_secs(10 * 60),
    name: "uv",
    source: "the required uv tool",
    artifact: "uv archive",
    // 19,013,455 bytes at the pinned release, and half as much again.
    max_bytes: 28_600_000,
};

/// TeX Live's own Windows installer (`install-tl-windows.bat` with the Perl it
/// runs on, `tlpkg\tlperl`), frozen at the 2026 release of 2026-03-01 on TUG's
/// historic archive. The one on CTAN's `tlnet` is rebuilt daily, so a digest
/// cannot be pinned there; this file never changes. It only bootstraps: the
/// packages come from an explicit https `tlnet` mirror (`tex_live::REPOSITORIES`),
/// verified by TeX Live's own checksums, as with BasicTeX on macOS.
pub(super) const TEX_LIVE_INSTALLER: PinnedDownload = PinnedDownload {
    url: "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2026/install-tl.zip",
    sha256: "16894548ee3812727581dde08ceb7053d0e4a64bfdbdef2e9dd152930664de93",
    timeout: Duration::from_secs(30 * 60),
    name: "TeX Live",
    source: "the TeX Live installer",
    artifact: "TeX Live installer",
    // 25,736,787 bytes at the pinned release, and half as much again.
    max_bytes: 38_700_000,
};
/// The one folder the installer archive holds everything under.
pub(super) const TEX_LIVE_ARCHIVE_ROOT: &str = "install-tl-20260301";
/// The TeX Live release the pinned installer sets up, and the one a TeX Live
/// already on the machine must be at least as new as to be used as it is.
pub(super) const TEX_LIVE_YEAR: i32 = 2026;

#[cfg(test)]
mod tests {
    use super::*;

    /// An https download from `origin`, pinned by a SHA-256 digest.
    fn assert_pinned(download: &PinnedDownload, origin: &str) {
        assert!(download.url.starts_with(origin), "{}", download.url);
        assert_eq!(download.sha256.len(), 64);
        assert!(download
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn every_windows_pin_is_an_https_download_with_a_full_lowercase_digest() {
        for pin in [&UV, &TEX_LIVE_INSTALLER] {
            assert_pinned(pin, "https://");
            assert!(pin.url.ends_with(".zip"), "{}", pin.url);
        }
    }

    #[test]
    fn every_pin_caps_its_download_at_about_one_and_a_half_times_its_size() {
        // (pin, the size of the pinned file in bytes)
        for (pin, size) in [(&UV, 19_013_455_u64), (&TEX_LIVE_INSTALLER, 25_736_787)] {
            assert!(pin.max_bytes > size, "{}", pin.name);
            assert!(pin.max_bytes <= size * 3 / 2 + size / 100, "{}", pin.name);
        }
    }

    #[test]
    fn the_uv_pin_is_the_managed_version_for_64_bit_windows() {
        assert_eq!(crate::commands::MANAGED_UV_VERSION, "0.12.3");
        assert_pinned(
            &UV,
            &format!(
                "https://github.com/astral-sh/uv/releases/download/{}/",
                crate::commands::MANAGED_UV_VERSION
            ),
        );
        assert!(UV.url.ends_with("/uv-x86_64-pc-windows-msvc.zip"));
    }

    #[test]
    fn the_tex_live_installer_is_the_frozen_release_snapshot() {
        assert_pinned(
            &TEX_LIVE_INSTALLER,
            &format!("https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/{TEX_LIVE_YEAR}/"),
        );
        // The dated folder inside the archive names the snapshot day.
        assert_eq!(TEX_LIVE_ARCHIVE_ROOT, "install-tl-20260301");
        assert_eq!(TEX_LIVE_YEAR, super::super::installer::BASIC_TEX_YEAR);
    }

    /// Downloads the pinned installer through the app's own download code
    /// (digest and size checks included), unpacks it with the app's own
    /// extractor into a scratch folder, and checks the layout the installer
    /// flow relies on. Nothing in it is run.
    /// `cargo test real_installer_archive -- --ignored` (network, ~25 MB).
    #[test]
    #[ignore = "downloads the pinned TeX Live installer"]
    fn real_installer_archive_matches_its_pin_and_layout() {
        let dir = crate::test_support::TempDir::new("real-install-tl");
        let archive = dir.join("install-tl.zip");
        crate::tex_setup::download_pinned(&TEX_LIVE_INSTALLER, &archive, |_, _| {}).unwrap();

        // Every entry name passes the one name rule, and sits under the root.
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        let mut names = Vec::new();
        for index in 0..zip.len() {
            let entry = zip.by_index(index).unwrap();
            let name = entry.name().unwrap().into_owned();
            let path = crate::tex_setup::safe_zip::zip_entry_path(&name)
                .unwrap_or_else(|| panic!("a name the extractor refuses: {name:?}"));
            assert!(path.starts_with(TEX_LIVE_ARCHIVE_ROOT), "{name}");
            names.push(name);
        }
        for expected in [
            "install-tl-windows.bat",
            "install-tl",
            "tlpkg/tlperl/bin/perl.exe",
            "tlpkg/installer/install-tl-gui.tcl",
        ] {
            let full = format!("{TEX_LIVE_ARCHIVE_ROOT}/{expected}");
            assert!(names.contains(&full), "{full} is not in the archive");
        }
        assert!(zip.len() > 2000, "{}", zip.len());

        let out = dir.join("out");
        std::fs::create_dir(&out).unwrap();
        let installer =
            super::super::tex_live::extract_installer(&archive, TEX_LIVE_ARCHIVE_ROOT, &out)
                .unwrap();
        assert!(installer.is_file());
        assert!(out.join(TEX_LIVE_ARCHIVE_ROOT).join("tlpkg/tlperl/bin/perl.exe").is_file());
    }

    /// The pinned uv zip, downloaded and unpacked by the app's own code; on
    /// Windows the unpacked programs report the pinned version.
    #[test]
    #[ignore = "downloads the pinned uv release"]
    fn real_uv_zip_matches_its_pin_and_runs() {
        let dir = crate::test_support::TempDir::new("real-uv");
        let archive = dir.join("uv.zip");
        crate::tex_setup::download_pinned(&UV, &archive, |_, _| {}).unwrap();
        let out = dir.join("out");
        std::fs::create_dir(&out).unwrap();
        super::super::uv_zip::extract_uv_zip(&archive, &out).unwrap();
        assert!(out.join("uv.exe").is_file() && out.join("uvx.exe").is_file());
        #[cfg(windows)]
        for tool in ["uv", "uvx"] {
            crate::commands::uv_tool_status_at(&out.join(format!("{tool}.exe")), tool).unwrap();
        }
    }
}
