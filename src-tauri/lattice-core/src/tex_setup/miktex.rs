//! Finding and installing the MiKTeX package that provides a missing file.
//!
//! MiKTeX has no command that answers "which package owns this file" (it does
//! that itself, inside the engines, when it installs packages on the fly).
//! Its `miktex packages list` can print each package's run files through a
//! template, so the owner is found by reading that list, and only ever when
//! exactly one package ships the file. Installing runs in MiKTeX's user mode,
//! which needs no administrator even in a shared setup, so nothing here ever
//! asks for elevation. Plain functions; `windows.rs` runs them.

use std::path::Path;

/// `miktex packages list` printing `<id>|<run files>` per package. The files
/// are joined by `;` (Windows' path delimiter); `|` cannot occur in either.
pub(super) fn list_args() -> [&'static str; 4] {
    ["packages", "list", "--template", "{id}|{runFiles}"]
}

/// `miktex packages install <package>`.
pub(super) fn install_args(package: &str) -> [&str; 3] {
    ["packages", "install", package]
}

/// A MiKTeX package id as it can pass to a command line: letters, digits and
/// `._+-`, as CTAN names are, and starting with a letter or digit so it can
/// never read as an option (`-…`) to the command it is passed to.
pub(super) fn is_package_id(id: &str) -> bool {
    id.bytes().next().is_some_and(|first| first.is_ascii_alphanumeric())
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
}

/// The one package in `miktex packages list` output whose run files include
/// `missing_file` (compared by file name, ignoring case as Windows does);
/// none or several is an error, never a guess.
pub(super) fn package_for_file(list_output: &str, missing_file: &str) -> Result<String, String> {
    let mut owners: Vec<&str> = Vec::new();
    for line in list_output.lines() {
        let Some((id, files)) = line.trim().split_once('|') else { continue };
        let id = id.trim();
        if !is_package_id(id) || owners.contains(&id) {
            continue;
        }
        let ships = files.split(';').any(|file| {
            file.trim()
                .rsplit(['/', '\\'])
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case(missing_file))
        });
        if ships {
            owners.push(id);
        }
    }
    match owners.as_slice() {
        [package] => Ok((*package).to_string()),
        [] => Err(format!(
            "No MiKTeX package provides {missing_file}. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder."
        )),
        _ => Err(format!(
            "More than one MiKTeX package provides {missing_file}: {}. Nothing was installed automatically.",
            owners.join(", ")
        )),
    }
}

/// Whether `directory` is a MiKTeX program folder (`…\miktex\bin\x64`).
pub(crate) fn is_miktex_bin(directory: &Path) -> bool {
    let mut parts = directory.components().rev().map(|part| part.as_os_str().to_ascii_lowercase());
    parts.next().is_some_and(|last| last == "x64" || last == "x86")
        && parts.next().is_some_and(|bin| bin == "bin")
        && parts.next().is_some_and(|miktex| miktex == "miktex")
}

/// Why `miktex packages install` failed: a first line the app translates,
/// then MiKTeX's own words.
pub(super) fn install_failure(output: &str) -> String {
    let lowercase = output.to_lowercase();
    let summary = if lowercase.contains("no space left") || lowercase.contains("not enough space") {
        "There is not enough disk space to install the package. Free up some space, then try again."
    } else if lowercase.contains("access is denied") || lowercase.contains("permission denied") {
        "Lattice could not write to the TeX installation folder."
    } else if ["could not resolve", "timed out", "connection", "could not connect", "unable to"]
        .iter()
        .any(|sign| lowercase.contains(sign))
    {
        "Could not reach the MiKTeX package repository. Check the network connection, then try again."
    } else {
        "MiKTeX's package manager could not install the package."
    };
    let detail = super::tex_live::telling_lines(
        &output.lines().map(str::to_string).collect::<Vec<String>>(),
    );
    if detail.is_empty() {
        summary.into()
    } else {
        format!("{summary}\n{detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "algorithms|texmf/tex/latex/algorithms/algorithm.sty;texmf/tex/latex/algorithms/algorithmic.sty\n\
        newtx|texmf/tex/latex/newtx/newtxmath.sty;texmf/tex/latex/newtx/newtxtext.sty\n\
        other|texmf/tex/latex/other/other.sty\n\
        oldnewtx|..\\texmf\\tex\\latex\\oldnewtx\\NewTxMath.STY\n\
        no-files|\n\
        garbage line without a bar\n";

    #[test]
    fn the_list_template_is_one_argument_without_escapes() {
        assert_eq!(list_args(), ["packages", "list", "--template", "{id}|{runFiles}"]);
        assert_eq!(install_args("newtx"), ["packages", "install", "newtx"]);
    }

    #[test]
    fn the_one_owning_package_is_found_by_file_name() {
        assert_eq!(package_for_file(LIST, "algorithm.sty").unwrap(), "algorithms");
        assert_eq!(package_for_file(LIST, "other.sty").unwrap(), "other");
        assert_eq!(package_for_file(LIST, "ALGORITHMIC.STY").unwrap(), "algorithms");
    }

    #[test]
    fn none_or_several_owners_is_an_error_never_a_guess() {
        let error = package_for_file(LIST, "newtxmath.sty").unwrap_err();
        assert_eq!(
            error,
            "More than one MiKTeX package provides newtxmath.sty: newtx, oldnewtx. Nothing was installed automatically."
        );
        let error = package_for_file(LIST, "custom.sty").unwrap_err();
        assert!(error.starts_with("No MiKTeX package provides custom.sty."), "{error}");
        assert!(package_for_file("", "x.sty").is_err());
        // A package id that is not a plain name is never offered for install.
        assert!(package_for_file("evil name;calc|a/b.sty", "b.sty").is_err());
        assert!(package_for_file("evil&calc|a/b.sty", "b.sty").is_err());
    }

    #[test]
    fn package_ids_are_plain_names() {
        for id in ["newtx", "tex-gyre", "stix2-otf", "a.b", "c++"] {
            assert!(is_package_id(id), "{id}");
        }
        for id in ["", "a b", "a;b", "a&b", "../x", "a|b", "ä", "-x", "--admin", ".x", "+x", "_x"]
        {
            assert!(!is_package_id(id), "{id}");
        }
    }

    #[test]
    fn miktex_program_folders_are_recognised_by_shape() {
        for yes in [
            "C:/Users/Ada/AppData/Local/Programs/MiKTeX/miktex/bin/x64",
            "C:/Program Files/MiKTeX/miktex/bin/x64",
            "d:/miktex/MIKTEX/BIN/X64",
        ] {
            assert!(is_miktex_bin(Path::new(yes)), "{yes}");
        }
        for no in ["C:/texlive/2026/bin/windows", "C:/miktex/bin", "C:/other/bin/x64"] {
            assert!(!is_miktex_bin(Path::new(no)), "{no}");
        }
    }

    #[test]
    fn install_failures_name_the_cause_first() {
        let error = install_failure("miktex: error: Access is denied.\n");
        assert!(error.starts_with("Lattice could not write to the TeX installation folder.\n"));
        assert!(error.ends_with("Access is denied."));
        let error =
            install_failure("The remote package repository could not be reached: timed out");
        assert!(error.starts_with("Could not reach the MiKTeX package repository."), "{error}");
        assert_eq!(install_failure(""), "MiKTeX's package manager could not install the package.");
    }
}
