// @ratchet-files-ignore: the Windows TeX Live rules and their tests read as one table of cases.
//! TeX Live on Windows: where it goes, the profile that makes its installer
//! run unattended, what its tools print, and its pinned installer archive.
//! Plain functions, so tests cover them on every platform; `windows.rs` runs
//! them.
//!
//! One path rule shapes all of it: `install-tl-windows.bat` is `cmd` batch
//! code over a Perl that reads its command line, profile and paths in the
//! ANSI code page, so the folder it unpacks into and the folder it installs to
//! must be plain ASCII without anything `cmd` treats as syntax. A profile
//! folder named for a user called Zoë would otherwise install into a
//! mis-spelled folder, or not run.

use super::installer::create_private_file;
use super::safe_zip::zip_entry_path;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The packages Lattice needs on top of TeX Live's basic scheme: the ones
/// `basictex.sh` installs on macOS, for the same reasons (a test keeps the two
/// lists in step), plus two the Windows scheme-basic lacks: `latexindent`, which
/// a Mac gets from MacTeX (format-on-save fails without it), and `synctex`,
/// whose binary the doctor requires (BasicTeX ships it, scheme-basic does not).
pub(super) const REQUIRED_PACKAGES: [&str; 28] = [
    "latexmk",
    "biber",
    "texcount",
    "collection-latexextra",
    "collection-fontsrecommended",
    "algorithms",
    "algorithmicx",
    "tex-gyre",
    "helvetic",
    "courier",
    "times",
    "psnfss",
    "cmap",
    "csquotes",
    "newtx",
    "kastrup",
    "acmart",
    "libertine",
    "mweights",
    "inconsolata",
    "ctex",
    "xecjk",
    "zhnumber",
    "bibunits",
    "xits",
    "stix2-otf",
    "latexindent",
    "synctex",
];

/// Package files the bundled templates and the tutorial load, checked after the
/// install so a package the selection missed is named instead of failing the
/// first build. (Checked against the 2026 `texlive.tlpdb`: each file's package
/// is in the basic scheme or in `REQUIRED_PACKAGES`' collections.)
pub(super) const TEMPLATE_FILES: [&str; 16] = [
    "natbib.sty",
    "lineno.sty",
    "environ.sty",
    "nicefrac.sty",
    "microtype.sty",
    "booktabs.sty",
    "algorithm.sty",
    "algorithmic.sty",
    "newtxmath.sty",
    "pdfpages.sty",
    "cleveref.sty",
    "bibunits.sty",
    "ctex.sty",
    "xeCJK.sty",
    "zhnumber.sty",
    "unicode-math.sty",
];

/// Where the installer and `tlmgr` get their packages first: an https CTAN
/// mirror named outright, so the install never depends on where the
/// `mirror.ctan.org` multiplexer happens to redirect (see [`installer_args`]).
pub(super) const PRIMARY_REPOSITORY: &str = "https://ctan.math.illinois.edu/systems/texlive/tlnet";

/// Direct CTAN mirrors that are reachable from mainland China, tried when the
/// first one is not: the same two the macOS installer falls back to. A fallback
/// applies to one command only.
pub(super) const FALLBACK_REPOSITORIES: [&str; 2] = [
    "https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet",
    "https://mirrors.ustc.edu.cn/CTAN/systems/texlive/tlnet",
];

/// The installer's repositories in the order they are tried. All https.
pub(super) const REPOSITORIES: [&str; 3] =
    [PRIMARY_REPOSITORY, FALLBACK_REPOSITORIES[0], FALLBACK_REPOSITORIES[1]];

/// Where a new TeX Live goes, and where its installer runs from. Per user, so
/// installing needs no administrator, and where `commands::tex_directories`
/// already looks. Both folders are under the user's own `%LOCALAPPDATA%`
/// (private to the user by Windows' default permissions), never in a folder
/// every local user can write to.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Location {
    /// `<local>\Programs\texlive`.
    pub parent: PathBuf,
    /// `<parent>\<year>`, where the tree is installed.
    pub texdir: PathBuf,
    /// `<local>\Temp`: each run makes a private folder of its own here, where
    /// the verified installer is unpacked and run from.
    pub work_parent: PathBuf,
}

/// Said when no folder of the user's can be given the plain ASCII path the
/// TeX Live installer needs.
pub(super) const NO_SAFE_LOCATION: &str = "TeX Live cannot be installed automatically: your user folder's path has characters its installer cannot read, and Windows has no short name for it. Install TeX Live yourself (tug.org/texlive/windows.html), then recheck setup.";

/// `%LOCALAPPDATA%\Programs\texlive\<year>` when that folder's path is one the
/// installer can use. For a user whose profile folder has accents or other
/// characters it cannot read, the same folder by its 8.3 short name
/// (`short_path` is Windows' `GetShortPathName`, which gives an ASCII name for
/// any folder, unless the volume has short names switched off). If neither is
/// usable the install is refused with [`NO_SAFE_LOCATION`]: it never moves to
/// a shared folder such as `C:\texlive`, where other users could replace what
/// was verified or installed.
pub(super) fn install_location(
    local_app_data: Option<&Path>, short_path: impl Fn(&Path) -> Option<PathBuf>, year: i32,
) -> Result<Location, String> {
    let local = local_app_data
        .ok_or_else(|| crate::tex_setup::user_dirs::APP_SUPPORT_MISSING.to_string())?;
    let usable = if is_installer_safe(local) {
        local.to_path_buf()
    } else {
        short_path(local)
            .filter(|short| is_installer_safe(short))
            .ok_or_else(|| NO_SAFE_LOCATION.to_string())?
    };
    let parent = usable.join("Programs").join("texlive");
    Ok(Location { texdir: parent.join(year.to_string()), work_parent: usable.join("Temp"), parent })
}

/// The folder for downloads that are not run (the uv archive): the system's
/// temp folder when it is inside the user's profile (so private to them), else
/// `<local>\Temp`, since a temp folder shared between users would let another
/// user swap a file between its check and its use.
pub(super) fn private_temp_dir(
    temp: PathBuf, profile: Option<&Path>, local_app_data: Option<&Path>,
) -> PathBuf {
    if profile.is_some_and(|profile| temp.starts_with(profile)) {
        return temp;
    }
    local_app_data.map_or(temp, |local| local.join("Temp"))
}

/// Whether `cmd` and the installer's Perl read `path` as it is: printable
/// ASCII, nothing `cmd` makes syntax of (`% ! ^ & | < > "` and parentheses,
/// the last because the installer expands paths inside `( … )` blocks).
/// Spaces are fine: the batch file quotes what it passes on.
pub(super) fn is_installer_safe(path: &Path) -> bool {
    path.to_str().is_some_and(|text| {
        !text.is_empty()
            && text.chars().all(|c| (' '..='~').contains(&c) && !"%!^&|<>\"()".contains(c))
    })
}

/// The profile `install-tl -profile` reads to install without asking: the
/// basic scheme, for the current user, with no PATH change, no shortcuts and no
/// file associations (Lattice finds TeX itself), no change of the repository
/// to the `mirror.ctan.org` multiplexer afterwards (it stays the https one it
/// was installed from), no documentation or source trees, and the user's own
/// configuration folders where TeX Live puts them by default. Nothing here
/// asks for a registry entry, but `install-tl` may still write its own
/// uninstall entry under `HKCU` in non-admin mode: that is the installer's
/// doing, not something Lattice requests or relies on, and it is per user.
pub(super) fn install_profile(texdir: &Path, year: i32) -> String {
    let forward = |path: &Path| path.to_string_lossy().replace('\\', "/");
    let texdir_text = forward(texdir);
    let local = texdir.parent().map_or_else(
        || format!("{texdir_text}/texmf-local"),
        |parent| format!("{}/texmf-local", forward(parent)),
    );
    // A profile value runs to the end of its line, spaces included, so no
    // path is quoted.
    let lines = [
        "selected_scheme scheme-basic".to_string(),
        format!("TEXDIR {texdir_text}"),
        format!("TEXMFLOCAL {local}"),
        format!("TEXMFSYSCONFIG {texdir_text}/texmf-config"),
        format!("TEXMFSYSVAR {texdir_text}/texmf-var"),
        "TEXMFHOME ~/texmf".to_string(),
        format!("TEXMFCONFIG ~/.texlive{year}/texmf-config"),
        format!("TEXMFVAR ~/.texlive{year}/texmf-var"),
        "instopt_adjustpath 0".to_string(),
        "instopt_adjustrepo 0".to_string(),
        "instopt_letter 0".to_string(),
        "instopt_portable 0".to_string(),
        "instopt_write18_restricted 1".to_string(),
        "tlpdbopt_autobackup 0".to_string(),
        "tlpdbopt_backupdir tlpkg/backups".to_string(),
        "tlpdbopt_create_formats 1".to_string(),
        "tlpdbopt_desktop_integration 0".to_string(),
        "tlpdbopt_file_assocs 0".to_string(),
        "tlpdbopt_generate_updmap 0".to_string(),
        "tlpdbopt_install_docfiles 0".to_string(),
        "tlpdbopt_install_srcfiles 0".to_string(),
        "tlpdbopt_post_code 1".to_string(),
        "tlpdbopt_w32_multi_user 0".to_string(),
    ];
    lines.join("\r\n") + "\r\n"
}

/// The arguments of `install-tl-windows.bat` for an unattended per-user
/// install from `profile` (a plain file name, relative to the folder the
/// installer runs in: a path with spaces or accents would pass through `cmd`
/// and Perl's ANSI command line) and the explicit https `repository`. `=` is
/// never used, because `cmd` turns it into a space.
///
/// The repository is always named, even for the first attempt: without
/// `-repository` the installer asks the `mirror.ctan.org` multiplexer, which
/// redirects to any mirror, http and ftp ones included, for about a gigabyte of
/// packages that nothing in Lattice can hash (the live `tlnet` changes daily).
/// What protects those packages is TeX Live's own check of the package
/// database's checksums, which it fetches over https. Its signature check needs
/// `gpg`, and `install-tl.zip` ships no `gpg.exe`, so on most Windows machines
/// only those checksums are verified. Once TeX Live 2026 is frozen (after the 2027
/// release, when the year guard asks for a Lattice update anyway) the installer
/// should read the immutable `…/historic/systems/texlive/2026/tlnet-final`
/// instead, and its packages can be pinned as the installer archive is.
pub(super) fn installer_args(profile: &str, repository: &str) -> Vec<String> {
    ["-no-gui", "-non-admin", "-repository", repository, "-profile", profile]
        .map(String::from)
        .to_vec()
}

/// `<root>\bin\windows`, where TeX Live puts its programs.
pub(super) fn bin_dir(texdir: &Path) -> PathBuf {
    texdir.join("bin").join("windows")
}

/// `tlmgr.bat`, TeX Live's package manager, in `texdir`.
pub(super) fn tlmgr_path(texdir: &Path) -> PathBuf {
    bin_dir(texdir).join("tlmgr.bat")
}

/// `tlmgr.bat` in a TeX Live program folder.
pub(super) fn tlmgr_in_bin(bin: &Path) -> PathBuf {
    bin.join("tlmgr.bat")
}

/// Whether the TeX Live tree at `texdir` was installed to its end. `install-tl`
/// writes `tlpkg/texlive.profile` only in its final cleanup, after every
/// package and the format building, so it says "finished" where `tlmgr.bat`
/// does not: `texlive.infra.windows`, which ships `tlmgr.bat`, is package 127 of
/// 135. A cancel or failure after it leaves a tree with a package manager that
/// is still incomplete.
pub(super) fn is_finished_install(texdir: &Path) -> bool {
    texdir.join("tlpkg").join("texlive.profile").is_file()
}

/// Whether a failed run's last lines look like a network failure rather than
/// something another mirror would not fix (a missing package, no disk space, a
/// folder that cannot be written): only then is the next mirror tried.
pub(super) fn looks_like_network_failure(tail: &[String]) -> bool {
    const SIGNS: [&str; 10] = [
        "could not get texlive.tlpdb",
        "cannot contact",
        "could not resolve host",
        "could not connect",
        "connection",
        "timed out",
        "unable to download",
        "could not download",
        "failed to download",
        "tlpdb",
    ];
    tail.iter().any(|line| {
        let lower = line.to_lowercase();
        SIGNS.iter().any(|sign| lower.contains(sign))
    })
}

/// The TeX Live root a `<root>\bin\<platform>` folder belongs to.
pub(crate) fn root_of_bin(bin: &Path) -> Option<PathBuf> {
    let root = bin.parent()?.parent()?;
    (bin.parent()?.file_name()? == "bin").then(|| root.to_path_buf())
}

/// The `[done/total` an installer or `tlmgr` line reports: `install-tl` writes
/// `Installing [001/107, time/total: ??:??/??:??]: name [12k]`, `tlmgr`
/// `[1/4, ??:??/??:??] install: name [12k]`.
pub(super) fn progress_of_line(line: &str) -> Option<(u32, u32)> {
    let rest = line.trim_start();
    let rest = rest.strip_prefix("Installing").map_or(rest, str::trim_start);
    let rest = rest.strip_prefix('[')?;
    let (done, rest) = rest.split_once('/')?;
    let (total, _) = rest.split_once(',')?;
    let (done, total) = (done.trim().parse().ok()?, total.trim().parse().ok()?);
    (total > 0 && done <= total).then_some((done, total))
}

/// The lines of a failed run that say why, at most `LIMIT`: the ones that name
/// a failure (as the macOS installer picks them), or the last few lines when
/// none does.
pub(super) fn telling_lines(tail: &[String]) -> String {
    const LIMIT: usize = 4;
    const SIGNS: [&str; 13] = [
        "not present",
        "not found",
        "failed",
        "failure",
        "error",
        "cannot",
        "could not",
        "unavailable",
        "older than",
        "no space",
        "denied",
        "not permitted",
        "read-only",
    ];
    const NOISE: [&str; 3] = ["an error has occurred", "see above messages", "exiting"];
    let clean = |line: &&String| !line.trim().is_empty();
    let telling: Vec<&String> = tail
        .iter()
        .filter(clean)
        .filter(|line| {
            let lower = line.to_lowercase();
            SIGNS.iter().any(|sign| lower.contains(sign))
                && !NOISE.iter().any(|noise| lower.contains(noise))
        })
        .collect();
    let chosen: Vec<&String> = if telling.is_empty() {
        let all: Vec<&String> = tail.iter().filter(clean).collect();
        all[all.len().saturating_sub(8)..].to_vec()
    } else {
        telling[telling.len().saturating_sub(LIMIT)..].to_vec()
    };
    chosen.iter().map(|line| line.trim()).collect::<Vec<_>>().join("\n")
}

/// Why the TeX Live installer failed: a first line the app translates, then
/// the installer's own words.
pub(super) fn installer_failure(tail: &[String]) -> String {
    let detail = telling_lines(tail);
    if detail.is_empty() {
        "TeX Live installation failed. Please try again.".into()
    } else {
        format!("TeX Live installation failed.\n{detail}")
    }
}

/// Why installing the required packages failed once TeX Live itself was in.
pub(super) fn packages_failure(tail: &[String]) -> String {
    let detail = telling_lines(tail);
    format!(
        "TeX Live is installed, but Lattice could not finish installing the required LaTeX packages.\n{detail}"
    )
}

/// Unpack the pinned installer archive into `destination`, everything under
/// `<archive_root>/` and nothing else, and return its
/// `install-tl-windows.bat`. A name that is not a plain path under the root,
/// a link, or a second copy of a file is refused.
pub(super) fn extract_installer(
    archive_path: &Path, archive_root: &str, destination: &Path,
) -> Result<PathBuf, String> {
    let file = std::fs::File::open(archive_path)
        .map_err(|error| format!("Could not read the TeX Live installer archive: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Could not inspect the TeX Live installer archive: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            format!("Could not inspect the TeX Live installer archive: {error}")
        })?;
        let name = entry.name().map_or_else(
            |_| String::from_utf8_lossy(entry.name_raw()).into_owned(),
            |name| name.into_owned(),
        );
        let relative = zip_entry_path(&name).ok_or_else(|| {
            format!("The TeX Live installer archive contained an unsafe path: {name}")
        })?;
        if !relative.starts_with(archive_root) {
            return Err(format!(
                "The TeX Live installer archive contained an unexpected entry: {name}"
            ));
        }
        if entry.is_symlink() {
            return Err(format!("The TeX Live installer archive contained a link at {name}"));
        }
        let target = destination.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|error| format!("Could not unpack the TeX Live installer: {error}"))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not unpack the TeX Live installer: {error}"))?;
        }
        let mut output = create_private_file(&target)?;
        std::io::copy(&mut entry, &mut output)
            .and_then(|_| output.flush())
            .map_err(|error| format!("Could not unpack {name}: {error}"))?;
    }
    let installer = destination.join(archive_root).join("install-tl-windows.bat");
    if !installer.is_file() {
        return Err("The TeX Live installer archive did not contain its installer.".into());
    }
    Ok(installer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use zip::write::SimpleFileOptions;

    #[test]
    fn installer_script_quotes_paths_with_spaces() {
        // The profile has no quoting: a value is the rest of its line.
        let texdir = PathBuf::from("C:/Users/Ada Lovelace/AppData/Local/Programs/texlive/2026");
        let profile = install_profile(&texdir, 2026);
        assert!(profile
            .contains("TEXDIR C:/Users/Ada Lovelace/AppData/Local/Programs/texlive/2026\r\n"));
        assert!(profile.contains(
            "TEXMFLOCAL C:/Users/Ada Lovelace/AppData/Local/Programs/texlive/texmf-local\r\n"
        ));
        assert!(profile.contains(
            "TEXMFSYSVAR C:/Users/Ada Lovelace/AppData/Local/Programs/texlive/2026/texmf-var\r\n"
        ));
        assert!(!profile.contains('"') && !profile.contains('\\') && !profile.contains('\t'));
        assert!(profile.starts_with("selected_scheme scheme-basic\r\n"));
        // Nothing here touches the registry or the user's PATH.
        for line in [
            "instopt_adjustpath 0",
            "tlpdbopt_desktop_integration 0",
            "tlpdbopt_file_assocs 0",
            "tlpdbopt_w32_multi_user 0",
            "tlpdbopt_install_docfiles 0",
        ] {
            assert!(profile.lines().any(|candidate| candidate == line), "{line}");
        }
        for line in profile.lines() {
            let (key, value) = line.split_once(' ').expect(line);
            assert!(!key.is_empty() && !value.is_empty(), "{line}");
        }

        // The installer's arguments carry no path at all: the profile is a
        // plain file name, the repository an explicit https mirror, and
        // nothing uses `=`.
        let args = installer_args("profile.txt", PRIMARY_REPOSITORY);
        assert_eq!(
            args,
            ["-no-gui", "-non-admin", "-repository", PRIMARY_REPOSITORY, "-profile", "profile.txt"]
        );
        for repository in REPOSITORIES {
            assert!(repository.starts_with("https://"), "{repository}");
            let args = installer_args("profile.txt", repository);
            assert!(args.iter().all(|arg| !arg.contains('=') && !arg.contains(' ')), "{args:?}");
            assert_eq!(args[2..4], ["-repository", repository]);
        }
        // Every attempt names its mirror, the first one included.
        assert_eq!(
            REPOSITORIES,
            [PRIMARY_REPOSITORY, FALLBACK_REPOSITORIES[0], FALLBACK_REPOSITORIES[1]]
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_texdir_is_written_with_forward_slashes() {
        let texdir = PathBuf::from(r"C:\Users\Ada Lovelace\AppData\Local\Programs\texlive\2026");
        let profile = install_profile(&texdir, 2026);
        assert!(profile
            .contains("TEXDIR C:/Users/Ada Lovelace/AppData/Local/Programs/texlive/2026\r\n"));
        assert!(profile.contains(
            "TEXMFLOCAL C:/Users/Ada Lovelace/AppData/Local/Programs/texlive/texmf-local\r\n"
        ));
    }

    /// A stand-in for `GetShortPathName`: the 8.3 name of a profile folder.
    fn short_of(long: &'static str, short: &'static str) -> impl Fn(&Path) -> Option<PathBuf> {
        move |path| (path == Path::new(long)).then(|| PathBuf::from(short))
    }

    fn no_short_name(_: &Path) -> Option<PathBuf> {
        None
    }

    #[test]
    fn the_install_folder_is_per_user_and_the_installer_runs_from_a_private_one() {
        let plain = Path::new("C:/Users/Ada Lovelace/AppData/Local");
        let location = install_location(Some(plain), no_short_name, 2026).unwrap();
        assert_eq!(location.texdir, plain.join("Programs").join("texlive").join("2026"));
        assert_eq!(location.parent, plain.join("Programs").join("texlive"));
        // The installer is unpacked and run from the user's own Temp folder,
        // not under the install folder and never under the drive's root.
        assert_eq!(location.work_parent, plain.join("Temp"));
        assert!(!location.work_parent.starts_with(&location.parent));
    }

    #[test]
    fn a_profile_the_installer_cannot_read_installs_under_its_short_name() {
        let long = "C:/Users/Zoë Å/AppData/Local";
        let short = "C:/Users/ZOE~1/AppData/Local";
        let location =
            install_location(Some(Path::new(long)), short_of(long, short), 2026).unwrap();
        assert_eq!(location.texdir, Path::new(short).join("Programs").join("texlive").join("2026"));
        assert_eq!(location.work_parent, Path::new(short).join("Temp"));
        assert!(is_installer_safe(&location.texdir) && is_installer_safe(&location.work_parent));
        // The same for names with characters cmd reads as syntax.
        for (long, short) in [
            ("C:/Users/50%/AppData/Local", "C:/Users/50_1/AppData/Local"),
            ("C:/Users/Bob!/AppData/Local", "C:/Users/BOB_1/AppData/Local"),
            ("C:/Users/A&B/AppData/Local", "C:/Users/AB_1/AppData/Local"),
            ("C:/Users/Bob (work)/AppData/Local", "C:/Users/BOBWOR~1/AppData/Local"),
        ] {
            let location =
                install_location(Some(Path::new(long)), short_of(long, short), 2026).unwrap();
            assert_eq!(location.parent, Path::new(short).join("Programs").join("texlive"));
        }
    }

    #[test]
    fn no_safe_folder_means_an_explicit_refusal_never_a_shared_folder() {
        let long = "C:/Users/Zoë Å/AppData/Local";
        // 8.3 names switched off on the volume: no short name.
        let error = install_location(Some(Path::new(long)), no_short_name, 2026).unwrap_err();
        assert_eq!(error, NO_SAFE_LOCATION);
        assert!(error.contains("Install TeX Live yourself"), "{error}");
        // A short name that is itself unreadable (or the same long name).
        for bad in ["C:/Users/Zoë Å/AppData/Local", "C:/Users/a b!/AppData/Local"] {
            let lookup = |_: &Path| Some(PathBuf::from(bad));
            assert_eq!(
                install_location(Some(Path::new(long)), lookup, 2026).unwrap_err(),
                NO_SAFE_LOCATION
            );
        }
        // No profile folder at all.
        assert_eq!(
            install_location(None, no_short_name, 2026).unwrap_err(),
            crate::tex_setup::user_dirs::APP_SUPPORT_MISSING
        );
        // Whatever happens, nothing is ever placed under a drive's root folder.
        for local in ["C:/Users/Zoë Å/AppData/Local", "C:/Users/ada/AppData/Local"] {
            if let Ok(location) = install_location(Some(Path::new(local)), no_short_name, 2026) {
                assert!(location.parent.starts_with(local), "{location:?}");
            }
        }
    }

    #[test]
    fn downloads_that_are_not_run_stay_in_a_folder_only_the_user_can_use() {
        let profile = Path::new("C:/Users/ada");
        let local = Path::new("C:/Users/ada/AppData/Local");
        // The usual temp folder is inside the profile: kept.
        let own = PathBuf::from("C:/Users/ada/AppData/Local/Temp");
        assert_eq!(private_temp_dir(own.clone(), Some(profile), Some(local)), own);
        // A shared one (a TEMP of C:\Windows\Temp or C:\Temp) is replaced.
        for shared in ["C:/Windows/Temp", "C:/Temp", "D:/scratch"] {
            assert_eq!(
                private_temp_dir(PathBuf::from(shared), Some(profile), Some(local)),
                local.join("Temp"),
                "{shared}"
            );
        }
        // Without a profile folder there is nothing better to choose.
        assert_eq!(private_temp_dir(PathBuf::from("C:/Temp"), None, None), Path::new("C:/Temp"));
    }

    #[test]
    fn only_plain_ascii_paths_are_safe_for_the_installer() {
        for safe in
            ["C:/Users/Ada/AppData", "C:/Program Files/x", r"C:\texlive\2026", "D:/a-b_c.d+e,f;g=h"]
        {
            assert!(is_installer_safe(Path::new(safe)), "{safe}");
        }
        for unsafe_path in [
            "",
            "C:/Zoë",
            "C:/a%PATH%",
            "C:/a!b",
            "C:/a^b",
            "C:/a&b",
            "C:/a|b",
            "C:/a<b",
            "C:/a>b",
            "C:/a\"b",
            "C:/a(b)",
            "C:/tab\tname",
            "C:/日本",
        ] {
            assert!(!is_installer_safe(Path::new(unsafe_path)), "{unsafe_path}");
        }
    }

    #[test]
    fn only_network_failures_try_the_next_mirror() {
        let lines = |text: &str| text.lines().map(String::from).collect::<Vec<_>>();
        for network in [
            "tlmgr: TLPDB::from_file could not get texlive.tlpdb from: https://mirror.ctan.org",
            "curl: (28) Connection timed out after 20000 milliseconds",
            "install-tl: unable to download the installer files",
            "Could not resolve host: mirror.ctan.org",
        ] {
            assert!(looks_like_network_failure(&lines(network)), "{network}");
        }
        for other in [
            "tlmgr: package newtx not present in repository.",
            "There is not enough space on the disk.",
            "Access is denied.",
            "",
        ] {
            assert!(!looks_like_network_failure(&lines(other)), "{other}");
        }
        assert_eq!(
            tlmgr_in_bin(Path::new("C:/texlive/2026/bin/windows")),
            bin_dir(Path::new("C:/texlive/2026")).join("tlmgr.bat")
        );
    }

    #[test]
    fn the_bin_folder_and_its_root_round_trip() {
        let texdir = Path::new("C:/texlive/2026");
        let bin = bin_dir(texdir);
        assert_eq!(bin, texdir.join("bin").join("windows"));
        assert_eq!(root_of_bin(&bin), Some(texdir.to_path_buf()));
        assert_eq!(tlmgr_path(texdir), bin.join("tlmgr.bat"));
        assert_eq!(root_of_bin(Path::new("C:/tools/miktex/x64")), None);
    }

    #[test]
    fn progress_is_read_from_install_tl_and_tlmgr_lines() {
        for (line, expected) in [
            ("Installing [001/107, time/total: ??:??/??:??]: 12many [8k]", Some((1, 107))),
            ("Installing [0042/107, time/total: 01:02/04:05]: amsmath [120k]", Some((42, 107))),
            ("[1/4, ??:??/??:??] install: latexmk [92k]", Some((1, 4))),
            ("  [  12/ 30, 00:10/00:25] install: biber.windows [4000k]", Some((12, 30))),
            ("[4/4, 00:30/00:30] install: texcount [20k]", Some((4, 4))),
            ("Installing [1/0, x]", None),
            ("Installing [5/3, x]", None),
            ("[ok] done", None),
            ("tlmgr: package repository https://x (verified)", None),
            ("", None),
        ] {
            assert_eq!(progress_of_line(line), expected, "{line:?}");
        }
    }

    #[test]
    fn a_failed_installer_reports_the_lines_that_say_why() {
        let tail: Vec<String> = [
            "Installing [001/107, time/total: ??:??/??:??]: texlive.infra [1k]",
            "tlmgr: package texlive.infra not present in repository.",
            "tlmgr: An error has occurred. See above messages. Exiting.",
            "",
        ]
        .map(String::from)
        .to_vec();
        let error = installer_failure(&tail);
        assert_eq!(
            error,
            "TeX Live installation failed.\ntlmgr: package texlive.infra not present in repository."
        );
        // Nothing telling: the last lines instead.
        let plain: Vec<String> = (1..=12).map(|n| format!("line {n}")).collect();
        let error = installer_failure(&plain);
        assert!(error.starts_with("TeX Live installation failed.\nline 5\n"), "{error}");
        assert!(error.ends_with("line 12"));
        assert_eq!(installer_failure(&[]), "TeX Live installation failed. Please try again.");
        assert!(packages_failure(&tail).starts_with(
            "TeX Live is installed, but Lattice could not finish installing the required LaTeX packages.\ntlmgr: package"
        ));
    }

    #[test]
    fn the_required_packages_are_the_ones_the_mac_installer_installs() {
        // The macOS script lists them as `  name \` lines after `tlmgr_with_fallback install`.
        let script = include_str!("basictex.sh").replace("\r\n", "\n");
        let (_, list) = script.split_once("tlmgr_with_fallback install \\\n").unwrap();
        let (list, _) = list.split_once("2>&1").unwrap();
        let mac: Vec<&str> =
            list.lines().map(|line| line.trim().trim_end_matches('\\').trim()).collect();
        assert_eq!(mac, REQUIRED_PACKAGES[..26]);
        // Windows adds latexindent (a Mac's MacTeX has it) and synctex (BasicTeX has it).
        assert_eq!(REQUIRED_PACKAGES[26..], ["latexindent", "synctex"]);
    }

    /// A zip of `entries` (`None` makes a folder, `Some(Err(()))` a symlink).
    fn zip(dir: &TempDir, name: &str, entries: &[(&str, Option<&[u8]>)]) -> PathBuf {
        let path = dir.join(name);
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = SimpleFileOptions::default();
        for (entry, contents) in entries {
            match contents {
                Some(bytes) => {
                    writer.start_file(*entry, options).unwrap();
                    writer.write_all(bytes).unwrap();
                }
                None if entry.ends_with('/') => writer.add_directory(*entry, options).unwrap(),
                None => writer.add_symlink(*entry, "/elsewhere", options).unwrap(),
            }
        }
        writer.finish().unwrap();
        path
    }

    #[test]
    fn the_installer_archive_unpacks_under_its_root_and_names_the_batch_file() {
        let dir = TempDir::new("tl-installer");
        let archive = zip(
            &dir,
            "install-tl.zip",
            &[
                ("install-tl-test/", None),
                ("install-tl-test/install-tl-windows.bat", Some(b"@echo off\r\n")),
                ("install-tl-test/install-tl", Some(b"#!perl\n")),
                ("install-tl-test/tlpkg/", None),
                ("install-tl-test/tlpkg/tlperl/bin/perl.exe", Some(b"MZ")),
            ],
        );
        let destination = dir.join("Zoë Å").join("My Setup");
        std::fs::create_dir_all(&destination).unwrap();
        let installer = extract_installer(&archive, "install-tl-test", &destination).unwrap();
        assert_eq!(installer, destination.join("install-tl-test").join("install-tl-windows.bat"));
        assert_eq!(std::fs::read(&installer).unwrap(), b"@echo off\r\n");
        assert!(destination.join("install-tl-test/tlpkg/tlperl/bin/perl.exe").is_file());
    }

    #[test]
    #[allow(clippy::type_complexity)]
    fn the_installer_archive_refuses_unsafe_unexpected_and_linked_entries() {
        let dir = TempDir::new("tl-installer-refuse");
        let batch: (&str, Option<&[u8]>) = ("r/install-tl-windows.bat", Some(b"x"));
        let cases: [(&str, Vec<(&str, Option<&[u8]>)>, &str); 8] = [
            ("slip", vec![("r/../../evil.bat", Some(b"x")), batch], "unsafe path"),
            ("dotdot", vec![("../evil.bat", Some(b"x")), batch], "unsafe path"),
            ("backslash", vec![(r"r\..\evil.bat", Some(b"x")), batch], "unsafe path"),
            ("drive", vec![("C:/evil.bat", Some(b"x")), batch], "unsafe path"),
            ("device", vec![("r/NUL", Some(b"x")), batch], "unsafe path"),
            ("outside", vec![("other/file.txt", Some(b"x")), batch], "unexpected entry"),
            ("link", vec![("r/tlpkg", None), batch], "contained a link"),
            ("empty", vec![("r/readme.txt", Some(b"x"))], "did not contain its installer"),
        ];
        for (name, entries, expected) in &cases {
            let archive = zip(&dir, &format!("{name}.zip"), entries);
            let destination = dir.join(format!("{name}-out"));
            std::fs::create_dir(&destination).unwrap();
            let error = extract_installer(&archive, "r", &destination).unwrap_err();
            assert!(error.contains(expected), "{name}: {error}");
            assert!(!dir.join("evil.bat").exists(), "{name} escaped its folder");
        }
        assert!(!dir.join("r").exists());
    }
}
