//! Builds that carry on past LaTeX errors, and builds that stop at the first.

use super::*;
use crate::test_support::TempDir;

/// Three pages, with an error on lines 7 and 9 (pages 2 and 3) when
/// `errors` is true. Page 1 is fine: an error before the first page is
/// written leaves the last PDF as it was, one after it deletes the PDF.
fn three_page_document(errors: bool) -> String {
    let (first, second) =
        if errors { ("\\undefinedfirst", "\\undefinedsecond") } else { ("one.", "two.") };
    format!(
        "\\documentclass{{article}}\n\\begin{{document}}\nSee Section~\\ref{{sec:second}}.\n\\newpage\n\\section{{Second}}\\label{{sec:second}}\nOn page two,\n{first}\n\\newpage\n{second}\n\\end{{document}}\n"
    )
}

fn error_lines(result: &BuildResult) -> Vec<Option<u32>> {
    result.diagnostics.iter().filter(|d| d.level == "error").map(|d| d.line).collect()
}

#[test]
#[ignore = "requires latexmk, pdfLaTeX and synctex"]
fn a_document_with_two_errors_reports_both_and_its_pdf_answers_synctex() {
    let root = TempDir::new("latex");
    project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
    root.write("main.tex", three_page_document(true));
    let result = build(&root, false, &ActiveBuild::default(), None, &BuildSteps::silent()).unwrap();
    assert!(!result.success && result.has_pdf, "{}", result.log);
    assert_eq!(result.synctex, Some(true));
    assert_eq!(error_lines(&result), [Some(7), Some(9)], "{:?}", result.diagnostics);
    // latexmk finished its passes past the errors: the reference resolved.
    let log = fs::read_to_string(root.join("main.log")).unwrap();
    assert!(!log.contains("undefined references"), "{log}");

    let target = super::super::forward_search(&root, "main.tex", 6, 1).unwrap().unwrap();
    assert_eq!(target.page, 2);
    let (x, y) = (target.x + target.width / 2.0, target.y + target.height / 2.0);
    let source = super::super::inverse_search(&root, target.page, x, y).unwrap();
    assert_eq!((source.path.as_str(), source.line), ("main.tex", 6));
}

#[test]
#[ignore = "requires latexmk, pdfLaTeX and synctex"]
fn stop_on_first_error_reports_one_and_the_pdf_on_screen_still_answers_synctex() {
    let root = TempDir::new("latex");
    project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
    let build = || build(&root, false, &ActiveBuild::default(), None, &BuildSteps::silent());
    root.write("main.tex", three_page_document(false));
    assert!(build().unwrap().success);
    let shown = fs::read(root.join("main.pdf")).unwrap();

    let stop = project::ManifestSettings {
        stop_on_first_error: Some(true),
        ..project::ManifestSettings::default()
    };
    project::update_manifest_settings(&root, stop).unwrap();
    root.write("main.tex", three_page_document(true));
    let halted = build().unwrap();
    assert!(!halted.success && !halted.has_pdf, "{}", halted.log);
    assert_eq!(error_lines(&halted), [Some(7)], "{:?}", halted.diagnostics);
    // pdfTeX deleted the PDF and its map; the PDF still on screen is back
    // beside the source, and so is the map that matches it.
    assert_eq!(fs::read(root.join("main.pdf")).unwrap(), shown);
    let target = super::super::forward_search(&root, "main.tex", 6, 1).unwrap().unwrap();
    assert_eq!(target.page, 2);
}
