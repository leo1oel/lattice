//! What a real build reports for errors in the files around its document.

use super::*;
use crate::test_support::TempDir;

/// The problems a failed build reports, for a document in `paper/`.
#[test]
#[ignore = "requires latexmk, pdfLaTeX and BibTeX"]
fn a_subfolder_documents_errors_point_at_the_files_to_fix() {
    let build = |files: &[(&str, &str)]| {
        let root = TempDir::new("latex-diagnostics");
        let mut manifest = project::default_manifest("paper");
        manifest.root_documents[0].path = "paper/main.tex".to_string();
        project::write_manifest(&root, &manifest).unwrap();
        for (path, contents) in files {
            root.write(path, contents);
        }
        let silent = BuildSteps::silent();
        let result = run_latexmk(&root, false, &ActiveBuild::default(), &silent).unwrap();
        assert!(!result.success);
        let errors = result.diagnostics.into_iter().filter(|item| item.level == "error");
        errors
            .map(|item| (item.file.unwrap_or_default(), item.line, item.message))
            .collect::<Vec<_>>()
    };
    let document = |body: &str| {
        format!("\\documentclass{{article}}\n\\input{{../shared/macros}}\n\\begin{{document}}\n{body}\n\\end{{document}}\n")
    };
    let error =
        |file: &str, line, message: &str| (file.to_string(), Some(line), message.to_string());
    let shared = ("shared/macros.tex", "\\newcommand{\\good}{x}\n");

    // A file it inputs, beside it and one folder up; and a missing one.
    let intro = [
        shared,
        ("paper/main.tex", &document("\\input{intro}")),
        ("paper/intro.tex", "Intro \\oops.\n"),
    ];
    assert_eq!(build(&intro), [error("paper/intro.tex", 1, "Undefined control sequence.")]);
    let macros = [
        ("shared/macros.tex", "\\newcommand{\\bad}{\\oops}\n\\bad\n"),
        ("paper/main.tex", &document("Hi.")),
    ];
    assert_eq!(build(&macros), [error("shared/macros.tex", 2, "Undefined control sequence.")]);
    let missing = [shared, ("paper/main.tex", &document("\\input{nosuchfile}"))];
    assert_eq!(
        build(&missing),
        [error("paper/main.tex", 4, "LaTeX Error: File `nosuchfile.tex' not found.")]
    );

    // The .bib: a bare `&` that breaks the .bbl, and an entry BibTeX
    // cannot read.
    let cited = document("See \\cite{cats}.\n\\bibliographystyle{plain}\n\\bibliography{refs}");
    let ampersand = "@article{cats,\n  title={Cats & Dogs},\n  author={A. Author},\n  journal={J},\n  year={2020}\n}\n";
    let bib = [shared, ("paper/main.tex", cited.as_str()), ("paper/refs.bib", ampersand)];
    assert_eq!(build(&bib), [error("paper/refs.bib", 1, "Misplaced alignment tab character &.")]);
    let comma =
        "@article{cats,\n  title={Cats},\n  author={A. Author}\n  journal={J},\n  year={2020}\n}\n";
    let bib = [shared, ("paper/main.tex", cited.as_str()), ("paper/refs.bib", comma)];
    assert_eq!(build(&bib), [error("paper/refs.bib", 4, "I was expecting a `,' or a `}'")]);
}
