//! Documents that build only beside themselves.
//!
//! The hidden build folder runs TeX with `-output-directory`, and a few
//! packages do not follow it: minted 2.x hands Pygments a file TeX wrote
//! there, imakeidx and glossaries run their indexers from the document's
//! folder, pythontex reads its code from there. Such a document fails in the
//! hidden folder and builds beside itself. When a hidden build fails on a
//! file that is not there, it is built once more beside the document; if
//! that build succeeds, the document is remembered and builds beside itself
//! from then on, whatever the setting says. If it fails too, the error is the
//! document's own: the hidden build's result stands and its files go back
//! into the hidden folder.

use super::super::aux_files::{self, AuxFiles};
use super::super::build_log::advice;
use super::super::compiled_document;
use super::retire_other_layout;
use crate::latex::BuildResult;
use crate::models::Diagnostic;
use crate::{project, wide_event};
use std::fs;
use std::path::Path;

/// The documents, relative to the project root, that build only beside
/// themselves.
const RECORD: &str = ".research/cache/build-beside.json";

/// Where a build of the project's compiled document puts its intermediate
/// files: beside it when it is remembered here, else `layout`.
pub(super) fn layout_for(root: &Path, layout: AuxFiles) -> AuxFiles {
    if layout != AuxFiles::Hidden {
        return layout;
    }
    let document =
        project::read_manifest(root).and_then(|manifest| compiled_document(root, &manifest));
    match document {
        Ok(document) if remembered(root).contains(&document) => AuxFiles::Beside,
        _ => layout,
    }
}

/// Whether a failed hidden build may have failed only because of the folder:
/// TeX, or a package, could not find a file it expected. Any other error, or
/// a failure restated with nothing changed, is the document's own.
pub(super) fn worth_trying(result: &BuildResult) -> bool {
    !result.success && !result.unchanged && misses_a_file(&result.diagnostics)
}

/// Whether TeX or a package reported a file it could not find (not a missing
/// package or class, which carry their own advice).
fn misses_a_file(diagnostics: &[Diagnostic]) -> bool {
    diagnostics.iter().any(|diagnostic| {
        let message = &diagnostic.message;
        diagnostic.level == "error"
            && diagnostic.code.is_none()
            && ((message.contains("File `") && message.contains("' not found"))
                || message.contains("can't find file")
                || message.contains("Missing Pygments output"))
    })
}

/// After `hidden`, a failed hidden build: build once more beside the
/// document with `build`. Keep that build when it succeeds; otherwise keep
/// `hidden`, with the files the second build left moved back into the hidden
/// folder, so the layout on disk is the setting's.
pub(super) fn retry(
    root: &Path, hidden: BuildResult,
    build: impl FnOnce(AuxFiles) -> Result<(BuildResult, AuxFiles), String>,
) -> Result<(BuildResult, AuxFiles), String> {
    let (mut beside, _) = build(AuxFiles::Beside)?;
    wide_event::record("built_beside", beside.success);
    if beside.success {
        remember(root, &beside.root_document);
        beside.diagnostics.insert(0, note());
        return Ok((beside, AuxFiles::Beside));
    }
    aux_files::stow_synctex(root, &hidden.root_document);
    retire_other_layout(root, &hidden.root_document, AuxFiles::Hidden);
    Ok((hidden, AuxFiles::Hidden))
}

fn note() -> Diagnostic {
    advice(
        "info",
        "built-beside",
        &[],
        "This document builds beside itself rather than in the hidden build folder: it uses a package that ignores TeX's output directory, such as minted 2.x, imakeidx, glossaries or pythontex.".to_string(),
    )
}

fn remembered(root: &Path) -> Vec<String> {
    fs::read(root.join(RECORD))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn remember(root: &Path, document: &str) {
    let mut documents = remembered(root);
    if documents.iter().any(|known| known == document) {
        return;
    }
    documents.push(document.to_string());
    let path = root.join(RECORD);
    if path.parent().is_some_and(|parent| fs::create_dir_all(parent).is_ok()) {
        if let Ok(json) = serde_json::to_vec_pretty(&documents) {
            let _ = fs::write(path, json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::build_log::parse_diagnostics;
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn a_file_that_is_not_there_is_worth_a_build_beside_the_document() {
        // TeX's own wording, as `-file-line-error` prints it.
        for log in [
            "! LaTeX Error: File `main.ind' not found.\n\n./main.tex:9: Emergency stop.\n",
            "! I can't find file `main.pyg'.\n./main.tex:4: Emergency stop.\n",
            "./main.tex:12: Package minted Error: Missing Pygments output; \\inputminted was\n",
        ] {
            assert!(misses_a_file(&parse_diagnostics(log)), "{log}");
        }
        for log in [
            "./main.tex:3: Undefined control sequence.\n",
            "! LaTeX Error: File `minted.sty' not found.\n\n./main.tex:2: Emergency stop.\n",
        ] {
            assert!(!misses_a_file(&parse_diagnostics(log)), "{log}");
        }
    }

    #[test]
    fn a_remembered_document_builds_beside_itself() {
        let parent = TempDir::new("latex-beside-record");
        let root = project::create(&parent, "Beside").unwrap();
        assert_eq!(layout_for(&root, AuxFiles::Hidden), AuxFiles::Hidden);
        remember(&root, "main.tex");
        remember(&root, "main.tex");
        assert_eq!(remembered(&root), vec!["main.tex".to_string()]);
        assert_eq!(layout_for(&root, AuxFiles::Hidden), AuxFiles::Beside);
        assert_eq!(layout_for(&root, AuxFiles::Beside), AuxFiles::Beside);
    }
}
