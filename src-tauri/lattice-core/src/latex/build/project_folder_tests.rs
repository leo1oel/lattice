//! A root document in a subfolder finds files named from the project
//! folder, as Overleaf, which typesets there, finds them (`search_paths`).

use super::*;
use crate::test_support::TempDir;

fn build(files: &[(&str, &str)]) -> (TempDir, BuildResult) {
    let root = TempDir::new("latex-project-folder");
    let mut manifest = project::default_manifest("paper");
    manifest.root_documents[0].path = "cvpr/main.tex".to_string();
    project::write_manifest(&root, &manifest).unwrap();
    for (path, contents) in files {
        root.write(path, contents);
    }
    let result =
        run_latexmk(&root, false, &ActiveBuild::default(), &BuildSteps::silent(), AuxFiles::Beside)
            .unwrap();
    (root, result)
}

const MAIN: &str = "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\input{sections/intro}\n\\includegraphics{figures/plot}\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n";
const CATS: &str =
    "@article{cats,\n  title={Cats},\n  author={A. Author},\n  journal={J},\n  year={2020}\n}\n";
// The smallest PDF pdfTeX includes: one empty 10 x 10 page.
const PLOT: &str = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n";

#[test]
#[ignore = "requires latexmk, pdfLaTeX and BibTeX"]
fn a_subfolder_root_finds_the_bibliography_inputs_and_figures_at_the_project_s_top() {
    let (root, result) = build(&[
        ("cvpr/main.tex", MAIN),
        ("sections/intro.tex", "See \\cite{cats}.\n"),
        ("figures/plot.pdf", PLOT),
        ("references.bib", CATS),
    ]);
    let problems: Vec<_> = result
        .diagnostics
        .iter()
        .filter(|item| item.level != "info")
        .map(|item| &item.message)
        .collect();
    assert!(result.success, "{problems:?}\n{}", result.log);
    assert!(problems.iter().all(|message| !message.contains("undefined")), "{problems:?}");
    let bbl = fs::read_to_string(root.join("cvpr/main.bbl")).unwrap();
    assert!(bbl.contains("\\bibitem{cats}"), "{bbl}");
}

#[test]
#[ignore = "requires latexmk, pdfLaTeX and BibTeX"]
fn the_subfolder_s_own_file_wins_and_errors_point_at_the_project_s_top() {
    // The same name beside the root and at the top: TeX reads the root's.
    let (_root, result) = build(&[
        ("cvpr/main.tex", MAIN),
        ("cvpr/sections/intro.tex", "Beside \\oops.\n"),
        ("sections/intro.tex", "Top.\n"),
        ("figures/plot.pdf", PLOT),
        ("references.bib", CATS),
    ]);
    let errors: Vec<_> = result
        .diagnostics
        .iter()
        .filter(|item| item.level == "error")
        .map(|item| (item.file.clone().unwrap_or_default(), item.line))
        .collect();
    assert_eq!(errors, [("cvpr/sections/intro.tex".to_string(), Some(1))]);

    // A file found at the top names it from the project folder.
    let (_root, result) = build(&[
        ("cvpr/main.tex", MAIN),
        ("sections/intro.tex", "Top \\oops.\n"),
        ("figures/plot.pdf", PLOT),
        ("references.bib", CATS),
    ]);
    let errors: Vec<_> = result
        .diagnostics
        .iter()
        .filter(|item| item.level == "error")
        .map(|item| (item.file.clone().unwrap_or_default(), item.line))
        .collect();
    assert_eq!(errors, [("sections/intro.tex".to_string(), Some(1))]);
}

const PAPER: &str = "\\documentclass{article}\n\\begin{document}\nMine.\n\\end{document}\n";
const THEIRS: &[u8] = b"%PDF-1.5 a collaborator's build";

fn build_open(root: &Path, open: Option<&str>) -> BuildResult {
    let result = super::build(
        root,
        false,
        false,
        &ActiveBuild::default(),
        open,
        &BuildSteps::silent(),
        AuxFiles::Beside,
    )
    .unwrap();
    assert!(result.success, "{}", result.log);
    result
}

fn assert_built_here(root: &Path, pdf: &str) {
    let shown = fs::read(root.join(pdf)).unwrap();
    assert!(shown.starts_with(b"%PDF-") && shown != THEIRS, "{}", String::from_utf8_lossy(&shown));
}

/// A collaborator's PDF that an Overleaf sync or a `git pull` writes over
/// this copy's leaves the sources unchanged, so latexmk has nothing to do;
/// the build must still put this copy's own PDF back before it is shown.
#[test]
#[ignore = "requires latexmk and pdfLaTeX"]
fn a_pdf_written_over_by_someone_else_is_built_again() {
    let (root, _) = build(&[("cvpr/main.tex", PAPER)]);
    // The build that leaves this copy's PDF on screen (`shown_pdf`).
    build_open(&root, None);

    fs::write(root.join("cvpr/main.pdf"), THEIRS).unwrap();
    build_open(&root, None);
    assert_built_here(&root, "cvpr/main.pdf");
}

/// Opening and building `arxiv/main.tex` makes it the default, and hands
/// `cvpr/main.pdf` back to Overleaf sync; a collaborator's that comes down
/// over it is still found when `cvpr/main.tex` is built again.
#[test]
#[ignore = "requires latexmk and pdfLaTeX"]
fn a_pdf_written_over_after_switching_roots_is_built_again() {
    let (root, _) = build(&[("cvpr/main.tex", PAPER), ("arxiv/main.tex", PAPER)]);
    build_open(&root, Some("cvpr/main.tex"));
    assert_eq!(build_open(&root, Some("arxiv/main.tex")).root_document, "arxiv/main.tex");

    fs::write(root.join("cvpr/main.pdf"), THEIRS).unwrap();
    assert_eq!(build_open(&root, Some("cvpr/main.tex")).root_document, "cvpr/main.tex");
    assert_built_here(&root, "cvpr/main.pdf");
}

/// A standalone figure built once in between leaves the paper the default,
/// and the paper's PDF still known.
#[test]
#[ignore = "requires latexmk and pdfLaTeX"]
fn a_pdf_written_over_after_a_one_off_build_is_built_again() {
    const FIGURE: &str = "\\documentclass{standalone}\n\\begin{document}x\\end{document}\n";
    let (root, _) = build(&[("cvpr/main.tex", PAPER), ("figures/plot.tex", FIGURE)]);
    build_open(&root, None);
    let figure = build_open(&root, Some("figures/plot.tex"));
    assert!(figure.one_off && figure.root_document == "figures/plot.tex", "{figure:?}");

    fs::write(root.join("cvpr/main.pdf"), THEIRS).unwrap();
    assert_eq!(build_open(&root, None).root_document, "cvpr/main.tex");
    assert_built_here(&root, "cvpr/main.pdf");
}
