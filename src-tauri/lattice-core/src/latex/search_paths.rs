//! Where TeX looks for a root document's files when it sits in a subfolder.
//!
//! latexmk `-cd` typesets in the root document's folder (see `latexmk`), but
//! Overleaf typesets in the project folder, so a project written there names
//! its files from the top: `cvpr/main.tex` with `\bibliography{references}`
//! and `references.bib` beside `cvpr/`, not in it. Here BibTeX found no
//! `.bib`, wrote no `.bbl`, and every citation printed as `[?]`.
//!
//! So a root in a subfolder searches its own folder first, then the project
//! folder, for TeX's inputs (`\input`, `\includegraphics`, classes and
//! packages: `TEXINPUTS`), BibTeX's databases (`BIBINPUTS`) and styles
//! (`BSTINPUTS`). The trailing separator keeps TeX's own trees after them.
//! The project folder is named relative (`..`), which kpathsea reads from
//! the working folder, so TeX names a file found there `../references.bib`,
//! as `diagnostic_paths` already rebases, and no project path can carry a
//! character kpathsea gives meaning to (`:`, `$`, `{`). A root at the top
//! changes nothing. A name written `./` or `../` is never searched for, by
//! kpathsea or by the editor (`onTexSearchPath` in `latex-text.ts`).

use std::path::{Component, Path};
use std::process::Command;

const VARIABLES: [&str; 3] = ["TEXINPUTS", "BIBINPUTS", "BSTINPUTS"];

#[cfg(windows)]
const SEPARATOR: &str = ";";
#[cfg(not(windows))]
const SEPARATOR: &str = ":";

/// Let a build of `document` (relative to the project folder) find files
/// named from the project folder; nothing for a document at the top.
pub(super) fn search_project_folder(command: &mut Command, document: &str) {
    for (variable, value) in search_paths(document, |variable| std::env::var(variable).ok()) {
        command.env(variable, value);
    }
}

/// Each variable's value for `document`, after anything the environment
/// (`inherited`) already puts there, which stays in force.
fn search_paths(
    document: &str, inherited: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, String)> {
    let depth = Path::new(document).parent().map_or(0, |folder| {
        folder.components().filter(|part| matches!(part, Component::Normal(_))).count()
    });
    if depth == 0 {
        return Vec::new();
    }
    let project = vec![".."; depth].join("/");
    VARIABLES
        .iter()
        .map(|&variable| {
            // An inherited value already ends in the separator when it wants
            // TeX's own trees; one without means it does not, so it is kept as is.
            let rest = inherited(variable).filter(|value| !value.is_empty()).unwrap_or_default();
            (variable, format!(".{SEPARATOR}{project}{SEPARATOR}{rest}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_root_at_the_top_keeps_tex_s_own_search() {
        assert!(search_paths("main.tex", |_| None).is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn a_subfolder_root_searches_its_folder_then_the_project_folder() {
        let paths = search_paths("cvpr/main.tex", |_| None);
        assert_eq!(
            paths,
            VARIABLES.iter().map(|&variable| (variable, ".:..:".to_string())).collect::<Vec<_>>()
        );
        let deeper = search_paths("papers/cvpr/main.tex", |_| None);
        assert_eq!(deeper[0], ("TEXINPUTS", ".:../..:".to_string()));
    }

    #[cfg(not(windows))]
    #[test]
    fn an_inherited_search_path_stays_after_the_project_s() {
        let inherited =
            |variable: &str| (variable == "BIBINPUTS").then(|| "/shared/bib:".to_string());
        let paths = search_paths("cvpr/main.tex", inherited);
        assert_eq!(paths[0], ("TEXINPUTS", ".:..:".to_string()));
        assert_eq!(paths[1], ("BIBINPUTS", ".:..:/shared/bib:".to_string()));
    }
}
