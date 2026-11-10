//! Which TeX Live package provides a missing file, from `tlmgr search
//! --global --file` output.

use super::installer::is_safe_name;

/// What `tlmgr search --global --file` says provides a missing file.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum TexLiveProviders {
    /// The package to install.
    One(String),
    /// Still several after ranking, in repository order: the writer picks.
    Several(Vec<String>),
}

/// The package in `tlmgr search --global --file` output that provides
/// `missing_file`. Several packages often list a file of that name, so they
/// are ranked rather than refused (IEEEtran.cls is in `ieeetran`, and again
/// in `xtuthesis`, but only as a documentation example):
/// 1. a package with the file where the engines load it beats one that only
///    ships it under `doc/`, `source/`, `tex/latex-dev/` (the `-dev` formats)
///    or another format's tree (`tex/cslatex/`);
/// 2. then the package named after the file (`IEEEtran.cls` → `ieeetran`);
/// 3. then the package keeping the file in a folder of its own name, not in
///    a bundle's (`tex/latex/ieeetran/` rather than `tex/latex/thesis/`).
///
/// Whatever is still tied comes back as `Several`, never a guess. No
/// provider at all is an error.
pub(super) fn tex_live_package_for_file(
    search_output: &str, missing_file: &str,
) -> Result<TexLiveProviders, String> {
    let mut current_package: Option<&str> = None;
    let mut owners: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in search_output.lines() {
        let trimmed = line.trim();
        if !line.starts_with(char::is_whitespace) {
            current_package = trimmed.strip_suffix(':').filter(|package| is_safe_name(package));
        } else if trimmed.ends_with(&format!("/{missing_file}")) {
            let Some(package) = current_package else { continue };
            match owners.iter_mut().find(|(owner, _)| *owner == package) {
                Some((_, paths)) => paths.push(trimmed),
                None => owners.push((package, vec![trimmed])),
            }
        }
    }
    if owners.is_empty() {
        return Err(format!(
            "No TeX Live package provides {missing_file}. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder."
        ));
    }
    let stem = missing_file.rsplit_once('.').map_or(missing_file, |(stem, _)| stem);
    let rules: [&ProviderRule<'_>; 3] = [
        &|_, paths| paths.iter().any(|path| is_loaded_path(path, missing_file)),
        &|package, _| package.eq_ignore_ascii_case(stem),
        &|package, paths| {
            paths.iter().any(|path| {
                path.split('/')
                    .rev()
                    .nth(1)
                    .is_some_and(|folder| folder.eq_ignore_ascii_case(package))
            })
        },
    ];
    for rule in rules {
        if owners.len() == 1 {
            break;
        }
        let preferred: Vec<_> =
            owners.iter().filter(|(package, paths)| rule(package, paths)).cloned().collect();
        // A rule no candidate meets says nothing about them.
        if !preferred.is_empty() {
            owners = preferred;
        }
    }
    let mut packages: Vec<String> = owners.into_iter().map(|(package, _)| package.into()).collect();
    Ok(if packages.len() == 1 {
        TexLiveProviders::One(packages.remove(0))
    } else {
        TexLiveProviders::Several(packages)
    })
}

/// A ranking rule: does this package, with these paths to the file, win?
type ProviderRule<'a> = dyn Fn(&str, &[&str]) -> bool + 'a;

/// Whether `path` (`texmf-dist/tex/latex/…`) is where pdfLaTeX, XeLaTeX or
/// LuaLaTeX find `missing_file`: BibTeX styles under `bibtex/bst/`, the rest
/// under the LaTeX, generic and engine trees of `tex/`.
fn is_loaded_path(path: &str, missing_file: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let trees: &[&str] = if missing_file.ends_with(".bst") {
        &["bibtex/bst"]
    } else {
        &["tex/latex", "tex/generic", "tex/xelatex", "tex/xetex", "tex/lualatex", "tex/luatex"]
    };
    parts.windows(2).any(|pair| trees.contains(&pair.join("/").as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependency_installer_looks_up_the_owning_tex_live_package() {
        use TexLiveProviders::One;
        let search_output = "newtx:\n    texmf-dist/tex/latex/newtx/newtxmath.sty\n    \
            texmf-dist/tex/latex/newtx/newtxtext.sty\nother-package:\n    \
            texmf-dist/tex/latex/other/other.sty\n";
        assert_eq!(
            tex_live_package_for_file(search_output, "newtxmath.sty"),
            Ok(One("newtx".into()))
        );
        let error =
            tex_live_package_for_file("unrelated:\n    texmf-dist/other.sty\n", "custom.sty")
                .unwrap_err();
        assert!(error.contains("conference-template file"), "{error}");
    }

    /// Real `tlmgr search --global --file '/<name>$'` output (TeX Live 2026,
    /// tab-indented as tlmgr prints it) for files several packages list.
    #[test]
    fn several_listed_providers_are_ranked_before_the_writer_is_asked() {
        use TexLiveProviders::{One, Several};
        let cases: [(&str, &str, &[&str]); 7] = [
            // xtuthesis only ships a documentation example copy.
            (
                "IEEEtran.cls",
                "tlmgr: package repository https://mirror.ctan.org/systems/texlive/tlnet (verified)\n\
                 ieeetran:\n\ttexmf-dist/tex/latex/ieeetran/IEEEtran.cls\n\
                 xtuthesis:\n\ttexmf-dist/doc/latex/xtuthesis/reference/IEEEtran.cls\n",
                &["ieeetran"],
            ),
            // BibTeX styles load from bibtex/bst/, not tex/.
            (
                "IEEEtran.bst",
                "confproc:\n\ttexmf-dist/doc/latex/confproc/example/IEEEtran.bst\n\
                 \ttexmf-dist/doc/latex/confproc/example/papers/IEEEtran.bst\n\
                 ieeetran:\n\ttexmf-dist/bibtex/bst/ieeetran/IEEEtran.bst\n",
                &["ieeetran"],
            ),
            // The -dev formats' tree is only read by pdflatex-dev and friends.
            (
                "varioref.sty",
                "latex-tools-dev:\n\ttexmf-dist/tex/latex-dev/tools/varioref.sty\n\
                 tools:\n\ttexmf-dist/tex/latex/tools/varioref.sty\n",
                &["tools"],
            ),
            // cslatex's copy is for its own format.
            (
                "czech.sty",
                "babel:\n\ttexmf-dist/tex/generic/babel/czech.sty\n\
                 cslatex:\n\ttexmf-dist/tex/cslatex/base/czech.sty\n",
                &["babel"],
            ),
            // Neither tree is LaTeX's, so the file's own package wins.
            (
                "ocherokee.sty",
                "lambda:\n\ttexmf-dist/tex/lambda/base/ocherokee.sty\n\
                 ocherokee:\n\ttexmf-dist/tex/lambda/ocherokee/ocherokee.sty\n",
                &["ocherokee"],
            ),
            // A package keeping the file in a folder of its own name beats a
            // bundle vendoring a copy (made-up names: no real case is left
            // once the rules above have run).
            (
                "widget.sty",
                "bundle:\n\ttexmf-dist/tex/latex/bundle/vendor/widget.sty\n\
                 widgets:\n\ttexmf-dist/tex/latex/widgets/widget.sty\n",
                &["widgets"],
            ),
            // Two real, loadable providers: the writer picks.
            (
                "afoot.sty",
                "arabtex:\n\ttexmf-dist/tex/latex/arabtex/afoot.sty\n\
                 ledmac:\n\ttexmf-dist/tex/latex/ledmac/afoot.sty\n",
                &["arabtex", "ledmac"],
            ),
        ];
        for (file, output, expected) in cases {
            let expected = match expected {
                [package] => One(package.to_string()),
                packages => Several(packages.iter().map(|package| package.to_string()).collect()),
            };
            assert_eq!(tex_live_package_for_file(output, file), Ok(expected), "{file}");
        }
    }
}
