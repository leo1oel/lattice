//! Two root documents in one folder that read each other's `.aux` through
//! `xr-hyper`: a paper and its supplement, as a CVPR submission has them.
//! The supplement builds first, and the paper reads its `.aux` only while it
//! exists, typesetting the supplement inline otherwise.

use super::*;
use crate::test_support::TempDir;

const PAPER: &str = "cvpr/main_v3.tex";
const SUPPLEMENT: &str = "cvpr/supp_v3.tex";

fn two_roots() -> TempDir {
    let root = TempDir::new("two-roots");
    let mut manifest = project::default_manifest("paper");
    manifest.engine = "xelatex".to_string();
    project::write_manifest(&root, &manifest).unwrap();
    root.write(
        PAPER,
        "\\documentclass{article}\n\\usepackage{xr-hyper}\n\\usepackage{hyperref}\n\
         \\IfFileExists{supp_v3.aux}{\\externaldocument{supp_v3}\\newcommand\\supplement{}}\
         {\\newcommand\\supplement{\\clearpage\\section{Inline supplement}\\label{sec:supp}}}\n\
         \\begin{document}\n\\section{Intro}\\label{sec:intro}\nSee \\ref{sec:supp}.\n\
         \\supplement\n\\end{document}\n",
    );
    root.write(
        SUPPLEMENT,
        "\\documentclass{article}\n\\usepackage{xr-hyper}\n\\usepackage{hyperref}\n\
         \\externaldocument{main_v3}\n\\begin{document}\n\
         \\section{Supplement}\\label{sec:supp}\nBack to \\ref{sec:intro}.\n\\end{document}\n",
    );
    root
}

fn build_open(root: &Path, document: &str, force: bool) -> BuildResult {
    let result = build(
        root,
        force,
        false,
        &ActiveBuild::default(),
        Some(document),
        &BuildSteps::silent(),
        AuxFiles::Beside,
    )
    .unwrap();
    assert!(result.success && result.has_pdf, "{document}: {}", result.log);
    assert_eq!(result.root_document, document);
    result
}

/// The report: the supplement built, then a Clean rebuild of the paper
/// cleaned the supplement (the last build's document) instead of the paper,
/// and the paper typeset the supplement inline, 27 pages instead of 12.
#[test]
#[ignore = "requires latexmk and XeLaTeX with xr-hyper"]
fn a_clean_rebuild_of_one_root_keeps_the_other_roots_aux() {
    let root = two_roots();
    let supplement_aux = root.join("cvpr/supp_v3.aux");
    build_open(&root, SUPPLEMENT, false);
    assert!(supplement_aux.is_file());
    assert_eq!(build_open(&root, PAPER, false).pages, Some(1));

    // Clean rebuild with the paper open, after a build of the supplement:
    // the clean, then a forced build, both of the paper.
    build_open(&root, SUPPLEMENT, false);
    clean(&root, Some(PAPER)).unwrap();
    assert!(supplement_aux.is_file(), "the paper's clean removed the supplement's .aux");
    assert!(!root.join("cvpr/main_v3.aux").exists(), "the paper's clean left its own .aux");
    assert_eq!(build_open(&root, PAPER, true).pages, Some(1));

    // Clean aux files with the supplement open cleans the supplement only.
    clean(&root, Some(SUPPLEMENT)).unwrap();
    assert!(!supplement_aux.exists());
    assert!(root.join("cvpr/main_v3.aux").is_file());
}
