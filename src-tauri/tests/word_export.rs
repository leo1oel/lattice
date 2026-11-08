#[path = "../src/export.rs"]
mod export;
#[path = "../src/test_support.rs"]
mod test_support;
#[path = "../src/word_export.rs"]
mod word_export;
mod commands {
    pub fn command(_: &str) -> std::process::Command {
        let path = std::env::var_os("LATTICE_TEST_PANDOC").unwrap_or_else(|| "pandoc".into());
        let command = std::process::Command::new(path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let mut command = command;
            command.creation_flags(0x08000000);
            command
        }
        #[cfg(not(windows))]
        command
    }
}
use std::{fs, io::Read};
use test_support::TempDir;

#[test]
fn editable_docx_contains_included_chapter_math_image_and_citation() {
    let project = TempDir::new("Word été 中文");
    project.write(
        "main.tex",
        r"\documentclass{article}
\title{Supervisor Review}\author{Ada}\begin{document}\maketitle
\section{Introduction}Editable prose with \textbf{emphasis} and $E=mc^2$.
\input{chapters/method}
\includegraphics{pixel.png}
Evidence \cite{lovelace1843}.
\bibliography{refs}
\end{document}",
    );
    project.write("chapters/method.tex", r"\section{Methods}Included chapter text.");
    project.write("refs.bib", r"@article{lovelace1843,author={Ada Lovelace},title={Notes on the Analytical Engine},year={1843},journal={Scientific Memoirs}}");
    // A real 1x1 PNG, embedded in the Word package.
    use base64::Engine;
    project.write("pixel.png", base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=").unwrap());
    let destination = project.join("review.docx");
    let result = word_export::export_word(&project, "main.tex", "refs.bib", &destination).unwrap();
    assert_eq!(std::path::Path::new(&result.path), destination);
    let mut archive = zip::ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
    let mut xml = String::new();
    archive.by_name("word/document.xml").unwrap().read_to_string(&mut xml).unwrap();
    for expected in [
        "Supervisor Review",
        "Editable prose",
        "Included chapter text",
        "oMath",
        "Notes on the Analytical Engine",
        "Lovelace",
    ] {
        assert!(xml.contains(expected), "Missing {expected}: {}", result.warnings);
    }
    assert!(archive.file_names().any(|name| name.starts_with("word/media/")));
}

#[test]
fn failures_preserve_existing_document_and_reject_escape_and_wrong_extension() {
    let project = TempDir::new("word-failure");
    let destination = project.write("review.docx", "previous export");
    project.write("bad.tex", "\\begin{document}\\input{missing-chapter}\\end{document}");
    assert!(word_export::export_word(&project, "missing.tex", "", &destination).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"previous export");
    assert!(word_export::export_word(&project, "bad.tex", "", &project.join("review.exe")).is_err());
    let outside = TempDir::new("word-outside");
    let source = outside.write("outside.tex", "private");
    assert!(word_export::export_word(&project, source.to_str().unwrap(), "", &destination).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"previous export");
    assert!(export::save(&destination, b"PK invalid", &export::DOCX).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"previous export");
}
