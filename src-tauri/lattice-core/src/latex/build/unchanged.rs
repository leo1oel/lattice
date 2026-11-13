//! A failing document that nothing changed in, built again unasked.
//!
//! latexmk answers a build of a document that failed and has not changed
//! since with "Nothing to do … gave an error in previous invocation", and
//! writes nothing. Lattice took that answer for stale and typeset again (the
//! stale rule cleaned and forced; the preamble format's retry forced), so
//! every automatic build of a failing document rewrote every output. Anything
//! that picks up changed files as they appear then made the project watcher
//! report a change, which built again, without end: Google Drive, backing up
//! ~/Documents, hard-links each changed file before uploading it, and a
//! NeurIPS paper with a table error rebuilt every five seconds for as long as
//! it stayed open.
//!
//! So a build Lattice starts on its own (autosave, the watcher) takes
//! latexmk's word: it restates the failure from the TeX log that build left
//! (beside the document, or in the hidden build folder), and writes nothing. A build the writer asks for still
//! cleans and typesets again, which is what a package installed in Terminal
//! needs.

use super::super::aux_files;
use super::super::build_log::{log_conference_template, pages_written, trim_log};
use super::diagnose;
use crate::latex::BuildResult;
use std::fs;
use std::path::Path;

/// `skipped`, latexmk's answer, with the errors of the build it remembers.
/// Unchanged when that build's TeX log is gone or names no error (BibTeX or
/// latexmk itself failed): its advice to rebuild clean then stands.
pub(super) fn restate(root: &Path, skipped: BuildResult) -> BuildResult {
    let document = skipped.root_document.clone();
    let Ok(tex_log) = fs::read_to_string(aux_files::file(root, &document, "log")) else {
        return skipped;
    };
    let (diagnostics, _) = diagnose(root, &document, &tex_log, None, None);
    if !diagnostics.iter().any(|diagnostic| diagnostic.level == "error") {
        return BuildResult { unchanged: true, ..skipped };
    }
    let mut log = trim_log(&tex_log);
    log.push_str("\n\nNothing changed since the last build, which failed: this is its log.");
    BuildResult {
        diagnostics,
        log,
        pages: pages_written(&tex_log),
        venue: log_conference_template(&tex_log).or(skipped.venue),
        unchanged: true,
        ..skipped
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::test_support::TempDir;
    use std::collections::BTreeMap;
    use std::time::{Duration, SystemTime};

    const FAILING: &str = "\\documentclass{article}\n\\begin{document}\nOne.\n\\newpage\nTwo, \\undefinedtwo.\n\\newpage\nThree, \\undefinedthree.\n\\end{document}\n";

    /// Every file under `root`, the app's own `.research` included, with
    /// when it was last written and its size.
    fn files(root: &Path) -> BTreeMap<String, (SystemTime, u64)> {
        let mut files = BTreeMap::new();
        let mut folders = vec![root.to_path_buf()];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(&folder).unwrap().flatten() {
                let metadata = entry.metadata().unwrap();
                if metadata.is_dir() {
                    folders.push(entry.path());
                } else {
                    let name = entry.path().strip_prefix(root).unwrap().display().to_string();
                    files.insert(name, (metadata.modified().unwrap(), metadata.len()));
                }
            }
        }
        files
    }

    fn errors(result: &BuildResult) -> Vec<(Option<String>, Option<u32>, String)> {
        let errors = result.diagnostics.iter().filter(|diagnostic| diagnostic.level == "error");
        errors.map(|error| (error.file.clone(), error.line, error.message.clone())).collect()
    }

    /// The ThinkMorph loop (Drive re-uploading every rebuild's output, each
    /// upload reaching the watcher as a change): with or without the
    /// preamble format, which a `.latexmkrc` turns off, an unasked build of a
    /// failing document that nothing changed in writes nothing and reports
    /// the same errors, and the writer's own Build still typesets again.
    #[test]
    #[ignore = "requires latexmk, pdfLaTeX and mylatexformat"]
    fn an_unasked_build_of_an_unchanged_failing_document_writes_nothing() {
        for rc in [None, Some("# no rules\n")] {
            let root = TempDir::new("latex");
            project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
            root.write("main.tex", FAILING);
            if let Some(rc) = rc {
                root.write(".latexmkrc", rc);
            }
            let build = |unattended| {
                build(
                    &root,
                    false,
                    unattended,
                    &ActiveBuild::default(),
                    None,
                    &BuildSteps::silent(),
                    AuxFiles::Beside,
                )
                .unwrap()
            };
            let failed = build(false);
            assert!(!failed.success && failed.has_pdf && !failed.unchanged, "{}", failed.log);
            assert_eq!(errors(&failed).len(), 2, "{:?}", failed.diagnostics);
            let written = files(&root);
            // A rewrite inside the same second would keep the time.
            std::thread::sleep(Duration::from_millis(1100));

            let again = build(true);
            assert!(again.unchanged && !again.success && again.has_pdf, "{}", again.log);
            assert_eq!(errors(&again), errors(&failed));
            assert_eq!(again.synctex, Some(true));
            assert_eq!(files(&root), written, "{rc:?}: an unasked build wrote to the project");

            let asked = build(false);
            assert!(!asked.unchanged && !asked.success, "{}", asked.log);
            assert_eq!(errors(&asked), errors(&failed));
            assert_ne!(files(&root).get("main.pdf"), written.get("main.pdf"), "{rc:?}");
        }
    }
}
