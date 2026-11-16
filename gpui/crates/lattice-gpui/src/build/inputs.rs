//! What a build reads, told apart from what it writes, as the Tauri app's
//! `build-inputs.ts` tells them: the project watcher reports both, and a
//! pass rewriting its own `.aux` must never start the next pass.

/// Extensions only a LaTeX run writes. latexmk compiles in the project root,
/// so every build lands these beside the sources: the document's own
/// outputs, and an `.aux` per `\include`d chapter.
const GENERATED_EXTENSIONS: &[&str] = &[
    "aux",
    "log",
    "fls",
    "fdb_latexmk",
    "synctex",
    "synctex.gz",
    "synctex(busy)",
    "synctex.gz(busy)",
    "out",
    "toc",
    "lof",
    "lot",
    "blg",
    "bcf",
    "run.xml",
    "nav",
    "snm",
    "vrb",
    "xdv",
    "dvi",
    "brf",
    "ilg",
    "glg",
    "auxlock",
    "figlist",
    "makefile",
    "dpth",
    "md5",
];

/// What a build writes under its root document's own name, beyond
/// `GENERATED_EXTENSIONS`: `main.pdf`, the bibliography and index it
/// generates, and biblatex's `main-blx.bib`. A writer's `main.bib` is a
/// source.
const GENERATED_FOR_DOCUMENT: &[&str] = &[
    ".pdf",
    ".bbl",
    ".idx",
    ".ind",
    ".ist",
    ".glo",
    ".gls",
    ".acn",
    ".acr",
    ".alg",
    ".loa",
    ".thm",
    ".nlo",
    ".nls",
    ".tdo",
    ".pytxcode",
    "-blx.bib",
];

/// A project-relative path as the watcher's reports and the manifest may
/// spell it (`./a`, `a\b`, `a//b`), in one spelling; `None` for the root or
/// a path leaving the project.
pub(crate) fn normalize(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in path.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => return None,
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn ends_with_ignore_case(text: &str, suffix: &str) -> bool {
    text.len() >= suffix.len()
        && text.is_char_boundary(text.len() - suffix.len())
        && text[text.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// Folders a package fills while compiling (minted's cache, the svg
/// package's conversions).
fn in_generated_folder(file: &str) -> bool {
    let first = file.split('/').next().unwrap_or_default();
    first.starts_with("_minted") || first == "svg-inkscape"
}

/// The temporary `ProjectFs::atomic_write` writes beside a file and renames
/// over it (`.lattice-<uuid>.tmp`, `.bib` kept for a bibliography's).
fn is_atomic_write_temporary(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or_default();
    let lower = name.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix(".lattice-") else {
        return false;
    };
    let rest = rest.strip_suffix(".bib").unwrap_or(rest);
    let Some(id) = rest.strip_suffix(".tmp") else {
        return false;
    };
    !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Whether a change the project watcher reported at `path` cannot have
/// changed what a build compiles: a file a LaTeX run itself writes, the
/// app's own atomic-write temporary, or Git's own state. Anything not known
/// to be one counts as an input, so an unfamiliar package's output costs an
/// extra (quick) latexmk run, never a stale PDF.
pub(crate) fn is_build_output(path: &str, root_documents: &[String]) -> bool {
    let Some(file) = normalize(path) else {
        return false;
    };
    if file == ".git"
        || file.starts_with(".git/")
        || in_generated_folder(&file)
        || is_atomic_write_temporary(&file)
        || GENERATED_EXTENSIONS
            .iter()
            .any(|extension| ends_with_ignore_case(&file, &format!(".{extension}")))
    {
        return true;
    }
    root_documents.iter().any(|document| {
        let Some(document) = normalize(document) else {
            return false;
        };
        let stem = if ends_with_ignore_case(&document, ".tex") {
            &document[..document.len() - 4]
        } else {
            document.as_str()
        };
        if stem.is_empty() {
            return false;
        }
        if file.starts_with(stem)
            && GENERATED_FOR_DOCUMENT
                .iter()
                .any(|suffix| file[stem.len()..].eq_ignore_ascii_case(suffix))
        {
            return true;
        }
        // achemso (the ACS journals' class) writes `acs-main.bib` beside the
        // document on every compile: a prefix, not a suffix, of the name.
        let (folder, name) = stem.rsplit_once('/').unwrap_or(("", stem));
        let acs = if folder.is_empty() {
            format!("acs-{name}.bib")
        } else {
            format!("{folder}/acs-{name}.bib")
        };
        file == acs
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> Vec<String> {
        vec!["main.tex".into(), "./chapters\\thesis.tex".into()]
    }

    #[test]
    fn what_latex_writes_is_not_an_input() {
        for path in [
            "main.aux",
            "chapters/intro.aux",
            "main.synctex.gz",
            "main.synctex.gz(busy)",
            "main.run.xml",
            "MAIN.LOG",
            "main.pdf",
            "main.bbl",
            "main-blx.bib",
            "acs-main.bib",
            "chapters/acs-thesis.bib",
            "chapters/thesis.pdf",
            "_minted-main/default.pygstyle",
            "svg-inkscape/plot_svg-tex.pdf",
            ".git/index",
            ".lattice-0f3a-9b.tmp",
            "refs/.lattice-0f3a.tmp.bib",
        ] {
            assert!(is_build_output(path, &roots()), "{path} is build output");
        }
    }

    #[test]
    fn sources_and_other_documents_outputs_are_inputs() {
        for path in [
            "main.tex",
            "main.bib",
            "acs-refs.bib",
            "acs-thesis.bib",
            "figures/plot.pdf",
            "appendix.pdf",
            "chapters/intro.tex",
            "styles/paper.sty",
            ".lattice-notes.tmp",
            "notes.md",
        ] {
            assert!(!is_build_output(path, &roots()), "{path} is an input");
        }
    }

    #[test]
    fn paths_are_spelled_one_way() {
        assert_eq!(normalize("./a//b\\c").as_deref(), Some("a/b/c"));
        assert_eq!(normalize("."), None);
        assert_eq!(normalize("../outside.tex"), None);
    }
}
