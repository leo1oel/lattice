//! Where in the project a build's diagnostics point.
//!
//! TeX names each file relative to the folder it typesets in, which `-cd`
//! makes the root document's own. For `paper/main.tex` an error in
//! `paper/intro.tex` reads `./intro.tex` and one in `shared/macros.tex` reads
//! `../shared/macros.tex`. Matched against the project as they stood, the
//! first opened a root `intro.tex` instead, or any file whose name merely ends
//! in `intro.tex`, and the second opened nothing.

use crate::models::Diagnostic;
use crate::project;
use std::path::{Component, Path};

/// Rebase every diagnostic's file from the folder of `document` (relative to
/// `root`) onto the project root. One in the generated `.bbl` moves to the
/// `.bib` entry it was made from, the file the writer can fix.
pub(super) fn locate_in_project(root: &Path, document: &str, diagnostics: &mut [Diagnostic]) {
    let folder = Path::new(document).parent().unwrap_or(Path::new(""));
    for diagnostic in diagnostics {
        let Some(file) = diagnostic.file.as_deref().and_then(|file| project_path(folder, file))
        else {
            continue;
        };
        let bib = (file.ends_with(".bbl"))
            .then_some(diagnostic.line)
            .flatten()
            .and_then(|line| project::bib_target_for_bbl(root, Path::new(&file), line).ok())
            .flatten();
        match bib {
            Some(target) => {
                (diagnostic.file, diagnostic.line) = (Some(target.path), Some(target.line))
            }
            None => diagnostic.file = Some(file),
        }
    }
}

/// `file`, named from `folder`, as a path from the project root; `None` for a
/// file outside the project, such as TeX Live's own, which stays as TeX named
/// it.
fn project_path(folder: &Path, file: &str) -> Option<String> {
    if Path::new(file).is_absolute() {
        return None;
    }
    let mut parts: Vec<&str> =
        folder.components().filter_map(|part| part.as_os_str().to_str()).collect();
    for part in Path::new(file).components() {
        match part {
            Component::Normal(name) => parts.push(name.to_str()?),
            Component::ParentDir => {
                parts.pop()?;
            }
            _ => {}
        }
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::latex::build_log::diagnostic;

    fn located(
        root: &Path, document: &str, file: &str, line: u32,
    ) -> (Option<String>, Option<u32>) {
        let mut diagnostics =
            [diagnostic(Some(file.to_string()), Some(line), "error", String::new())];
        locate_in_project(root, document, &mut diagnostics);
        let [diagnostic] = diagnostics;
        (diagnostic.file, diagnostic.line)
    }

    #[test]
    fn diagnostics_of_a_subfolder_document_point_into_the_project() {
        let root = crate::test_support::TempDir::new("diagnostic-paths");
        let at = |file: &str, line| (Some(file.to_string()), Some(line));
        assert_eq!(located(&root, "paper/main.tex", "intro.tex", 1), at("paper/intro.tex", 1));
        assert_eq!(
            located(&root, "paper/main.tex", "../shared/macros.tex", 3),
            at("shared/macros.tex", 3)
        );
        assert_eq!(located(&root, "main.tex", "chapters/a.tex", 2), at("chapters/a.tex", 2));
        // Outside the project: left as TeX named it.
        assert_eq!(located(&root, "main.tex", "../elsewhere.tex", 2), at("../elsewhere.tex", 2));
        let texlive = "/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls";
        assert_eq!(located(&root, "paper/main.tex", texlive, 9), at(texlive, 9));
    }

    #[test]
    fn an_error_in_the_generated_bbl_points_at_its_bib_entry() {
        let fixture = crate::project::test_support::Fixture::project("diagnostic-bbl");
        let root = &fixture;
        root.write("paper/refs.bib", "@misc{other,\n  title={Other}\n}\n\n@article{cats,\n  title={Cats & Dogs},\n  year={2020}\n}\n");
        // What BibTeX's plain style made of it; line 5 holds the bare `&`.
        root.write(
            "paper/main.bbl",
            "\\begin{thebibliography}{1}\n\n\\bibitem{cats}\nA.~Author.\n\\newblock Cats & dogs.\n\n\\end{thebibliography}\n",
        );
        root.write("paper/main.tex", "\\bibliography{refs}\n");
        let root = &fixture.root;
        assert_eq!(
            located(root, "paper/main.tex", "main.bbl", 5),
            (Some("paper/refs.bib".into()), Some(5))
        );
        // A line no entry covers stays in the .bbl.
        assert_eq!(
            located(root, "paper/main.tex", "main.bbl", 1),
            (Some("paper/main.bbl".into()), Some(1))
        );
    }
}
