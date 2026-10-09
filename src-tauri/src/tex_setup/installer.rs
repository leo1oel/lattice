//! What the installers run and how to read what they report: pinned
//! downloads, the privileged scripts, and parsers for tool output. Free of
//! side effects apart from archive extraction, so tests cover it everywhere.

use std::path::Path;
use std::time::Duration;

/// A download pinned by URL and SHA-256, with the words its errors use.
pub(super) struct PinnedDownload {
    pub url: &'static str,
    pub sha256: &'static str,
    pub timeout: Duration,
    /// "Could not initialize the {name} download", "Could not finish saving {name}".
    pub name: &'static str,
    /// "Could not download {source}".
    pub source: &'static str,
    /// "The downloaded {artifact} failed its security check."
    pub artifact: &'static str,
}

pub(super) const BASIC_TEX: PinnedDownload = PinnedDownload {
    url: "https://mirror.ctan.org/systems/mac/mactex/mactex-basictex-20260301.pkg",
    sha256: "19164fbfef08c30fd433f59203c8804abbbd685d3a344ef7f0ba8c1fd4157cb3",
    timeout: Duration::from_secs(30 * 60),
    name: "BasicTeX",
    source: "BasicTeX",
    artifact: "BasicTeX package",
};
pub(super) const BASIC_TEX_YEAR: i32 = 2026;

/// Tools (and the argument that proves each runs) that an existing TeX
/// installation must provide before only the required tools are installed.
pub(super) const REUSABLE_TEX_TOOLS: [(&str, &str); 3] =
    [("latexmk", "-version"), ("synctex", "help"), ("bibtex", "--version")];
/// At least one of these engines must run.
pub(super) const REUSABLE_TEX_ENGINES: [&str; 3] = ["pdflatex", "xelatex", "lualatex"];

const BASIC_SCRIPT: &str =
    concat!(include_str!("installer-prelude.sh"), "\n", include_str!("basictex.sh"));
const DEPENDENCY_SCRIPT: &str =
    concat!(include_str!("installer-prelude.sh"), "\n", include_str!("dependency.sh"));

/// The managed uv release for Apple Silicon, the only Macs Lattice runs on.
pub(super) const UV: PinnedDownload = PinnedDownload {
    url: "https://github.com/astral-sh/uv/releases/download/0.12.3/uv-aarch64-apple-darwin.tar.gz",
    sha256: "546f7f8a6c70ff13a3a9d2bc958db3427298cebf3e0cb756f9177133b7068843",
    timeout: Duration::from_secs(10 * 60),
    name: "uv",
    source: "the required uv tool",
    artifact: "uv archive",
};
/// The directory the uv archive unpacks into.
pub(super) const UV_ARCHIVE_ROOT: &str = "uv-aarch64-apple-darwin";

/// `/bin/bash -c <script>` for `do shell script … with administrator privileges`.
pub(super) fn privileged_command(script: &str) -> String {
    format!("/bin/bash -c {}", shell_quote(script))
}

/// The BasicTeX installer script: copies and re-verifies the downloaded
/// `package` when `install_base`, then installs the required packages.
pub(super) fn basic_tex_script(package: &Path, root: &Path, install_base: bool) -> String {
    BASIC_SCRIPT
        .replace("__INSTALLER_NAME__", "BasicTeX")
        .replace("__SOURCE_PACKAGE__", &shell_quote(&package.to_string_lossy()))
        .replace("__ROOT_PATH__", &shell_quote(&root.to_string_lossy()))
        .replace("__EXPECTED_SHA256__", BASIC_TEX.sha256)
        .replace("__INSTALL_BASE__", if install_base { "1" } else { "0" })
}

/// The script that installs one TeX Live `package`, from `repository` when
/// the configured one could not be searched.
pub(super) fn dependency_script(
    root: &Path, tlmgr: &Path, package: &str, repository: Option<&str>,
) -> String {
    DEPENDENCY_SCRIPT
        .replace("__INSTALLER_NAME__", "LaTeX package")
        .replace("__ROOT_PATH__", &shell_quote(&root.to_string_lossy()))
        .replace("__TLMGR_PATH__", &shell_quote(&tlmgr.to_string_lossy()))
        .replace("__PACKAGE_NAME__", &shell_quote(package))
        .replace("__REPOSITORY__", &repository.map(shell_quote).unwrap_or_else(|| "''".into()))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// The progress an installer status line (`<stage> [<done> <total>]`) stands for.
pub(super) fn installer_stage_progress(stage: &str) -> Option<f64> {
    let mut parts = stage.split_whitespace();
    let stage = parts.next()?;
    let mut count = || parts.next().and_then(|value| value.parse::<f64>().ok());
    let fraction = match (count(), count()) {
        (Some(completed), Some(total)) if total > 0.0 => (completed / total).clamp(0.0, 1.0),
        _ => 0.0,
    };
    match stage {
        "installing-base" => Some(0.68),
        "installing-packages" => Some(0.72 + fraction * 0.21),
        "installing-dependency" => Some(0.42 + fraction * 0.48),
        "verifying" => Some(0.95),
        "complete" => Some(1.0),
        _ => None,
    }
}

/// The installer's own words from an `osascript` failure: without the
/// AppleScript prefix and exit code, at most eight lines. `do shell script`
/// ends the script's lines with carriage returns.
fn install_error_detail(stderr: &str) -> String {
    let stderr = stderr.replace("\r\n", "\n").replace('\r', "\n");
    let raw_detail = stderr.trim();
    let detail =
        raw_detail.split_once("execution error:").map_or(raw_detail, |(_, detail)| detail).trim();
    let detail = detail
        .rsplit_once(" (")
        .filter(|(_, status)| {
            status
                .strip_suffix(')')
                .is_some_and(|code| code.bytes().all(|byte| byte.is_ascii_digit() || byte == b'-'))
        })
        .map_or(detail, |(detail, _)| detail);
    detail.lines().filter(|line| !line.trim().is_empty()).take(8).collect::<Vec<_>>().join("\n")
}

fn cancelled_authorization(stderr: &str) -> bool {
    stderr.contains("User canceled") || stderr.contains("(-128)")
}

pub(super) fn install_error(stderr: &str) -> String {
    if cancelled_authorization(stderr) {
        return "Administrator approval is required to install BasicTeX.".into();
    }
    let detail = install_error_detail(stderr);
    if detail.is_empty() {
        "BasicTeX installation failed. Please try again.".into()
    } else if detail.starts_with("Updating the TeX Live package manager failed.")
        || detail.starts_with("Installing the required LaTeX packages failed.")
    {
        format!(
            "BasicTeX is installed, but Lattice could not finish installing the required LaTeX packages.\n{detail}"
        )
    } else {
        format!("BasicTeX installation failed.\n{detail}")
    }
}

/// Why a missing-package install failed: a first line the app translates
/// (`DEPENDENCY_INSTALL_CANCELLED` or a `DEPENDENCY_INSTALL_FAILURES` summary),
/// then the installer's own words.
pub(super) fn dependency_install_error(stderr: &str) -> String {
    if cancelled_authorization(stderr) {
        return DEPENDENCY_INSTALL_CANCELLED.into();
    }
    let detail = install_error_detail(stderr);
    let lowercase = detail.to_lowercase();
    let summary = DEPENDENCY_INSTALL_FAILURES
        .iter()
        .find(|(signs, _)| signs.iter().any(|sign| lowercase.contains(sign)))
        .map_or(DEPENDENCY_INSTALL_FAILED, |(_, summary)| summary);
    if detail.is_empty() {
        summary.into()
    } else {
        format!("{summary}\n{detail}")
    }
}

const DEPENDENCY_INSTALL_CANCELLED: &str =
    "Administrator approval was cancelled, so nothing was installed.";
/// What tlmgr's output (lowercased) says about a failure, first match wins,
/// and its summary. A missing package or an outdated tlmgr is checked before
/// the network because every failed repository attempt is logged, whatever
/// the cause.
const DEPENDENCY_INSTALL_FAILURES: [(&[&str], &str); 6] = [
    (
        &["no space left"],
        "There is not enough disk space to install the package. Free up some space, then try again.",
    ),
    (
        &["permission denied", "operation not permitted", "read-only file system"],
        "Lattice could not write to the TeX installation folder.",
    ),
    (
        &["is older than remote repository"],
        "This TeX Live release is older than the package repository. Install the current TeX Live release, then try again.",
    ),
    (&["not present in repository"], "The package repository does not have this package."),
    (
        &[
            "could not get texlive.tlpdb",
            "cannot contact",
            "could not resolve host",
            "connection",
            "timed out",
            "unable to download",
        ],
        "Could not reach the TeX Live package repository. Check the network connection, then try again.",
    ),
    (
        &["tlmgr itself needs to be updated", "updating the tex live package manager failed"],
        "TeX Live's package manager needs an update, and the update did not finish.",
    ),
];
const DEPENDENCY_INSTALL_FAILED: &str = "TeX Live's package manager could not install the package.";

/// The TeX Live release in `tlmgr --version` output.
pub(super) fn tex_live_year(version_output: &str) -> Option<i32> {
    version_output
        .split_once("TeX Live")?
        .1
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| part.len() == 4)
        .and_then(|year| year.parse().ok())
}

/// The one package in `tlmgr search --global --file` output that ships
/// `missing_file`; none or several is an error, never a guess.
pub(super) fn tex_live_package_for_file(
    search_output: &str, missing_file: &str,
) -> Result<String, String> {
    let mut current_package: Option<&str> = None;
    let mut owners = Vec::new();
    for line in search_output.lines() {
        let trimmed = line.trim();
        if !line.starts_with(char::is_whitespace) {
            current_package = trimmed.strip_suffix(':').filter(|package| is_safe_name(package));
        } else if trimmed.ends_with(&format!("/{missing_file}")) {
            if let Some(package) = current_package.filter(|package| !owners.contains(package)) {
                owners.push(package);
            }
        }
    }
    match owners.as_slice() {
        [package] => Ok((*package).to_string()),
        [] => Err(format!(
            "No TeX Live package provides {missing_file}. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder."
        )),
        _ => Err(format!(
            "More than one TeX Live package provides {missing_file}: {}. Nothing was installed automatically.",
            owners.join(", ")
        )),
    }
}

/// Names that pass through the privileged installer: no shell or path syntax.
fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
}

pub(super) fn valid_tex_dependency_name(missing_file: &str) -> bool {
    is_safe_name(missing_file)
        && ["sty", "cls", "bst", "bbx", "cbx"]
            .iter()
            .any(|extension| missing_file.ends_with(&format!(".{extension}")))
}

pub(super) fn create_private_file(path: &Path) -> Result<std::fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))
}

/// Extract exactly `<archive_root>/`, `uv` and `uvx` into `staging`,
/// refusing anything else the archive holds.
pub(super) fn extract_uv_archive(
    archive_path: &Path, staging: &Path, archive_root: &str,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let file = std::fs::File::open(archive_path)
        .map_err(|error| format!("Could not read the uv archive: {error}"))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let root_path = Path::new(archive_root);
    let mut found_root = false;
    let mut found = [false, false];
    let inspect_error =
        |error: std::io::Error| format!("Could not inspect the uv archive: {error}");
    for entry in archive.entries().map_err(inspect_error)? {
        let mut entry = entry.map_err(inspect_error)?;
        let path = entry
            .path()
            .map_err(|error| format!("The uv archive contained an invalid path: {error}"))?
            .into_owned();
        let entry_type = entry.header().entry_type();
        if path == root_path {
            if found_root || !entry_type.is_dir() {
                return Err("The uv archive contained an invalid root entry.".into());
            }
            found_root = true;
            continue;
        }
        let Some((index, name)) =
            ["uv", "uvx"].into_iter().enumerate().find(|(_, name)| path == root_path.join(name))
        else {
            return Err(format!(
                "The uv archive contained an unexpected entry: {}",
                path.display()
            ));
        };
        if found[index] || !entry_type.is_file() {
            return Err(format!("The uv archive contained an invalid {name} entry."));
        }
        found[index] = true;
        let destination = staging.join(name);
        let mut output = create_private_file(&destination)?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Could not extract {name} from the uv archive: {error}"))?;
        output.flush().map_err(|error| format!("Could not finish extracting {name}: {error}"))?;
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("Could not make {name} executable: {error}"))?;
    }
    if !found_root || found.contains(&false) {
        return Err("The uv archive did not contain the expected executables.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// An https download from `origin`, pinned by a SHA-256 digest.
    fn assert_pinned(download: &PinnedDownload, origin: &str) {
        assert!(download.url.starts_with(origin), "{}", download.url);
        assert_eq!(download.sha256.len(), 64);
        assert!(download.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn basic_installer_is_pinned_and_reports_native_progress() {
        assert_pinned(&BASIC_TEX, "https://mirror.ctan.org/");
        assert_eq!(BASIC_TEX_YEAR, 2026);
        for expected in [
            "status installing-base",
            "status installing-packages",
            "relay_progress installing-packages",
            "shasum -a 256",
            "/bin/mkdir -m 711",
            "mirrors.tuna.tsinghua.edu.cn/CTAN",
            "mirrors.ustc.edu.cn/CTAN",
            "--repository \"${repository}\"",
            "EXPECTED_TEXMFROOT=\"/usr/local/texlive/2026basic\"",
            "[[ -L \"${EXPECTED_TEXMFROOT}\" ]]",
            "owner_uid=\"$(/usr/bin/stat -f '%u'",
            "/bin/chmod -R -P a+rX \"${EXPECTED_TEXMFROOT}\"",
            "  psnfss \\\n",
        ] {
            assert!(BASIC_SCRIPT.contains(expected), "{expected}");
        }
        for unexpected in
            ["status verifying", "status complete", "  mathptmx \\\n", "brew install", "sudo"]
        {
            assert!(!BASIC_SCRIPT.contains(unexpected), "{unexpected}");
        }
        // The package is copied privately; TeX itself is installed readable.
        let position = |text: &str| BASIC_SCRIPT.find(text).unwrap();
        let order = ["umask 077", "/bin/cp", "umask 022", "/usr/sbin/installer"].map(position);
        assert!(order.is_sorted(), "{order:?}");
        assert!(position("umask 022") < position("tlmgr_with_fallback update --self"));
    }

    #[test]
    fn installer_scripts_are_fully_filled_in() {
        let root = Path::new("/private/var/tmp/lattice-root");
        let scripts = [
            basic_tex_script(Path::new("/tmp/Ada's/BasicTeX.pkg"), root, true),
            dependency_script(root, Path::new("/Library/TeX/texbin/tlmgr"), "newtx", None),
        ];
        for script in &scripts {
            assert!(!script.contains("__"), "unfilled placeholder in:\n{script}");
            assert!(script.contains("ROOT='/private/var/tmp/lattice-root'\n"));
        }
        // Paths are single-quoted, embedded quotes included.
        assert!(scripts[0].contains("SOURCE_PACKAGE='/tmp/Ada'\"'\"'s/BasicTeX.pkg'\n"));
        assert!(scripts[0].contains(&format!("EXPECTED_SHA256={}\n", BASIC_TEX.sha256)));
        assert!(scripts[0].contains("privileged BasicTeX installer folder."));
        assert!(scripts[1].contains("TEX_REPOSITORY=''\n"));
        assert!(scripts[1].contains("CURRENT_STEP=\"Preparing the LaTeX package installation\""));
        assert!(BASIC_SCRIPT.starts_with("#!/bin/bash\n"));
        for expected in [
            "status installing-dependency",
            "tlmgr_with_fallback update --self",
            "tlmgr_with_fallback install \"${PACKAGE}\" 2>&1 | relay_progress installing-dependency",
        ] {
            assert!(DEPENDENCY_SCRIPT.contains(expected), "{expected}");
        }
        for unexpected in ["REPOSITORY_ARGS", "sudo", "Terminal"] {
            assert!(!DEPENDENCY_SCRIPT.contains(unexpected), "{unexpected}");
        }
    }

    #[test]
    fn uv_downloads_are_versioned_and_pinned_for_supported_macs() {
        assert_eq!(crate::commands::MANAGED_UV_VERSION, "0.12.3");
        assert_pinned(&UV, "https://github.com/astral-sh/uv/releases/download/0.12.3/");
        assert!(UV.url.ends_with(&format!("/{UV_ARCHIVE_ROOT}.tar.gz")));
        assert_eq!(REUSABLE_TEX_TOOLS.map(|(tool, _)| tool), ["latexmk", "synctex", "bibtex"]);
        assert_eq!(REUSABLE_TEX_ENGINES, ["pdflatex", "xelatex", "lualatex"]);
    }

    #[test]
    fn uv_archive_extraction_accepts_only_the_expected_regular_files() {
        let workspace = crate::test_support::TempDir::new("uv-archive-test");
        let archive = |name: &str, entries: &[(&str, tar::EntryType, &[u8])]| {
            let path = workspace.join(name);
            let encoder = flate2::write::GzEncoder::new(
                fs::File::create(&path).unwrap(),
                flate2::Compression::default(),
            );
            let mut builder = tar::Builder::new(encoder);
            for (entry_path, entry_type, contents) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(*entry_type);
                header.set_mode(if entry_type.is_dir() { 0o755 } else { 0o700 });
                header.set_size(contents.len() as u64);
                header.set_cksum();
                builder.append_data(&mut header, entry_path, *contents).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap();
            let staging = workspace.join(format!("{name}-staging"));
            fs::create_dir(&staging).unwrap();
            (path, staging)
        };
        use tar::EntryType::{Directory, Regular, Symlink};

        let (valid, staging) = archive(
            "valid.tar.gz",
            &[
                ("uv-test/", Directory, b""),
                ("uv-test/uvx", Regular, b"uvx"),
                ("uv-test/uv", Regular, b"uv"),
            ],
        );
        extract_uv_archive(&valid, &staging, "uv-test").unwrap();
        assert_eq!(fs::read(staging.join("uv")).unwrap(), b"uv");
        assert_eq!(fs::read(staging.join("uvx")).unwrap(), b"uvx");

        let (invalid, staging) = archive(
            "invalid.tar.gz",
            &[
                ("uv-test/", Directory, b""),
                ("uv-test/uv", Symlink, b""),
                ("uv-test/uvx", Regular, b"uvx"),
            ],
        );
        assert!(extract_uv_archive(&invalid, &staging, "uv-test").is_err());
    }

    #[test]
    fn package_install_progress_advances_with_tlmgr_output() {
        assert_eq!(installer_stage_progress("installing-packages"), Some(0.72));
        assert_eq!(installer_stage_progress("installing-packages 5 10"), Some(0.825));
        assert_eq!(installer_stage_progress("installing-packages 10 10"), Some(0.9299999999999999));
        assert_eq!(installer_stage_progress("installing-dependency 1 2"), Some(0.6599999999999999));
    }

    #[test]
    fn installer_errors_keep_the_useful_detail_without_applescript_noise() {
        let error = install_error(
            "7:75: execution error: Installing the required LaTeX packages failed.\n\
             tlmgr: package example not present in repository. (1)\n",
        );
        assert!(error.starts_with("BasicTeX is installed"));
        assert!(error.contains("package example not present in repository"));
        assert!(!error.contains("execution error"));
        assert!(!error.ends_with("(1)"));

        // A repository failure does not claim BasicTeX itself failed.
        let error = install_error(
            "7:75: execution error: Updating the TeX Live package manager failed.\n\
             /Library/TeX/texbin/tlmgr: TLPDB::from_file could not get texlive.tlpdb. (1)\n",
        );
        assert!(error.starts_with("BasicTeX is installed"));
        assert!(!error.starts_with("BasicTeX installation failed"));
        assert!(error.contains("TLPDB::from_file"));
    }

    #[test]
    fn tex_live_release_is_read_from_tlmgr_output() {
        assert_eq!(
            tex_live_year("tlmgr revision 76773 (2025-11-06 15:48:23 +0100)\nTeX Live (https://tug.org/texlive) version 2026"),
            Some(2026)
        );
        assert_eq!(tex_live_year("tlmgr is unavailable"), None);
    }

    #[test]
    fn dependency_installer_looks_up_the_one_owning_tex_live_package() {
        let search_output = "newtx:\n    texmf-dist/tex/latex/newtx/newtxmath.sty\n    \
            texmf-dist/tex/latex/newtx/newtxtext.sty\nother-package:\n    \
            texmf-dist/tex/latex/other/other.sty\n";
        assert_eq!(tex_live_package_for_file(search_output, "newtxmath.sty").unwrap(), "newtx");
        // None or several owners is an error, never a guess.
        let ambiguous = "first:\n    texmf-dist/tex/latex/first/shared.sty\nsecond:\n    \
            texmf-dist/tex/latex/second/shared.sty\n";
        for (output, file, expected) in [
            (ambiguous, "shared.sty", "More than one"),
            ("unrelated:\n    texmf-dist/other.sty\n", "custom.sty", "conference-template file"),
        ] {
            let error = tex_live_package_for_file(output, file).unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn dependency_name_validation_prevents_installer_injection() {
        assert!(valid_tex_dependency_name("algorithm.sty"));
        assert!(valid_tex_dependency_name("biblatex-authoryear.bbx"));
        for rejected in ["../../evil.sty", "evil.sty; open /tmp", "main.tex"] {
            assert!(!valid_tex_dependency_name(rejected), "{rejected}");
        }
    }
}
