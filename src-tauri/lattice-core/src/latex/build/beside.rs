//! Documents that build only beside themselves.
//!
//! The hidden build folder runs TeX with `-output-directory`, and a few
//! packages do not follow it: minted 2.x hands Pygments a file TeX wrote
//! there, imakeidx and glossaries run their indexers from the document's
//! folder, pythontex reads its code from there. Such a document fails in the
//! hidden folder, looking for a file named after it (`main.ind`,
//! `_minted-main/…`) that the tool never made, and builds beside itself.
//! Only that failure is built once more beside the document: a figure or
//! chapter the writer has not made yet is missing in both places. If that
//! build succeeds, the document is remembered and builds beside itself from
//! then on, whatever the setting says. If it fails too, or is stopped, the
//! hidden build's files and PDF are put back as they were, so latexmk still
//! knows that build, and the same inputs built again unasked are restated
//! (`unchanged`) rather than tried beside again.

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

/// Where the hidden build's folder waits while the document builds beside
/// itself.
const ASIDE: &str = ".research/cache/hidden-build-aside";

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
/// a package's output, named after the document, was not there. Any other
/// error, or a failure restated with nothing changed, is the document's own.
pub(super) fn worth_trying(result: &BuildResult) -> bool {
    !result.success
        && !result.unchanged
        && misses_its_own_output(&result.diagnostics, &result.root_document)
}

/// Whether TeX or a package looked for a file named after `document` (its
/// job name) and did not find it, or minted found no Pygments output.
fn misses_its_own_output(diagnostics: &[Diagnostic], document: &str) -> bool {
    let job = Path::new(document).file_stem().unwrap_or_default().to_string_lossy();
    diagnostics.iter().any(|diagnostic| {
        let message = &diagnostic.message;
        diagnostic.level == "error"
            && diagnostic.code.is_none()
            && (message.contains("Missing Pygments output")
                || missing_file(message).is_some_and(|file| named_after(file, &job)))
    })
}

/// The file in TeX's "File `x' not found" or "I can't find file `x'".
fn missing_file(message: &str) -> Option<&str> {
    if !message.contains("' not found") && !message.contains("can't find file") {
        return None;
    }
    let start = message.find('`')? + 1;
    let end = start + message[start..].find('\'')?;
    Some(&message[start..end])
}

/// Whether a part of `file`'s path is the job's name, or joins it to a
/// package's own word: `main.ind`, `main-terms.tex`, `_minted-main/x.pygtex`.
fn named_after(file: &str, job: &str) -> bool {
    file.split(['/', '\\', '.']).any(|part| {
        part == job
            || part.strip_prefix(job).is_some_and(|rest| rest.starts_with(['-', '_']))
            || part.strip_suffix(job).is_some_and(|rest| rest.ends_with(['-', '_']))
    })
}

/// After `hidden`, a failed hidden build: build once more beside the
/// document with `build`, the hidden build's folder set aside meanwhile.
/// Keep that build when it succeeds. Otherwise keep `hidden`, or the stop
/// when the writer stopped it, with its folder and PDF back as they were and
/// what the second build left beside the document gone.
pub(super) fn retry(
    root: &Path, hidden: BuildResult,
    build: impl FnOnce(AuxFiles) -> Result<(BuildResult, AuxFiles), String>,
) -> Result<(BuildResult, AuxFiles), String> {
    let document = hidden.root_document.clone();
    let pdf_path = root.join(&document).with_extension("pdf");
    let pdf = fs::read(&pdf_path).ok();
    let folder = aux_files::folder(root, &document, AuxFiles::Hidden);
    let aside = root.join(ASIDE);
    let _ = fs::remove_dir_all(&aside);
    let set_aside = aside.parent().is_some_and(|parent| fs::create_dir_all(parent).is_ok())
        && fs::rename(&folder, &aside).is_ok();
    let trial = build(AuxFiles::Beside);
    if set_aside {
        let _ = fs::remove_dir_all(&folder);
        let _ = fs::rename(&aside, &folder);
    }
    let (mut beside, _) = trial?;
    wide_event::record("built_beside", beside.success);
    if beside.success {
        remember(root, &document);
        retire_other_layout(root, &document, AuxFiles::Beside);
        beside.diagnostics.insert(0, note());
        return Ok((beside, AuxFiles::Beside));
    }
    retire_other_layout(root, &document, AuxFiles::Hidden);
    let _ = match pdf {
        Some(bytes) => fs::write(&pdf_path, bytes),
        None => fs::remove_file(&pdf_path),
    };
    let stopped = beside
        .diagnostics
        .iter()
        .any(|diagnostic| matches!(diagnostic.code, Some("build-cancelled" | "build-stalled")));
    Ok((if stopped { beside } else { hidden }, AuxFiles::Hidden))
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
    fn only_a_missing_output_named_after_the_document_is_worth_a_build_beside_it() {
        // TeX's own wording, as `-file-line-error` prints it.
        for log in [
            "! LaTeX Error: File `main.ind' not found.\n\n./main.tex:9: Emergency stop.\n",
            "! LaTeX Error: File `main-terms.tex' not found.\n\n./main.tex:9: Emergency stop.\n",
            "! I can't find file `_minted-main/default.pygstyle'.\n./main.tex:4: Emergency stop.\n",
            "./main.tex:12: Package minted Error: Missing Pygments output; \\inputminted was\n",
        ] {
            assert!(misses_its_own_output(&parse_diagnostics(log), "paper/main.tex"), "{log}");
        }
        for log in [
            "./main.tex:3: Undefined control sequence.\n",
            "! LaTeX Error: File `minted.sty' not found.\n\n./main.tex:2: Emergency stop.\n",
            "./main.tex:7: LaTeX Error: File `figures/plot.pdf' not found.\n",
            "! LaTeX Error: File `domain.tex' not found.\n\n./main.tex:5: Emergency stop.\n",
        ] {
            assert!(!misses_its_own_output(&parse_diagnostics(log), "paper/main.tex"), "{log}");
        }
    }

    #[test]
    fn a_stopped_build_beside_reports_the_stop_and_puts_the_hidden_build_back() {
        let root = TempDir::new("latex-beside-stopped");
        root.write("paper/main.pdf", "hidden build's PDF");
        root.write(".research/build/paper/main.fdb_latexmk", "latexmk's state");
        let started = std::time::Instant::now();
        let hidden = BuildResult {
            diagnostics: Vec::new(),
            ..super::super::cancelled_build(started, "failed", "paper/main.tex")
        };
        let (result, layout) = retry(&root, hidden, |layout| {
            assert_eq!(layout, AuxFiles::Beside);
            assert!(!root.join(".research/build/paper").exists());
            fs::write(root.join("paper/main.pdf"), "partial").unwrap();
            Ok((super::super::cancelled_build(started, "", "paper/main.tex"), layout))
        })
        .unwrap();
        assert_eq!(layout, AuxFiles::Hidden);
        assert!(result.diagnostics.iter().any(|item| item.code == Some("build-cancelled")));
        assert_eq!(fs::read_to_string(root.join("paper/main.pdf")).unwrap(), "hidden build's PDF");
        assert!(root.join(".research/build/paper/main.fdb_latexmk").is_file());
        assert!(remembered(&root).is_empty());
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
