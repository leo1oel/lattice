//! Review mode's PDF: the paper with the changes since review mode's base
//! marked (project/review_mode.rs), shown in the PDF panel beside the source
//! while the writer goes through them.
//!
//! It is the export with changes marked (the parent module) with the base as
//! the older version and the files now as the newer, and it is built where
//! review mode keeps its bases, `.research/review/build/`, so the paper's own
//! PDF, its build files and its sources are never written. The newer folder
//! is kept between builds, so latexmk reruns only what changed: the paper's
//! LaTeX is copied in, everything else (figures, styles, the bibliography's
//! style) is linked, so a project's hundreds of megabytes of figures are not
//! copied on every edit.
//!
//! The same guards hold as for the export: latexdiff and latexmk under time
//! and memory limits, `\input` loops named before latexdiff starts, and each
//! new build stopping the one before it.

use super::{
    build_marked, changes_name, input_loop, latexdiff_output, with_markup, ChangesExports,
    ChangesPdfOptions, Failed, Runner,
};
use crate::latex::default_root_document;
use crate::{commands, project};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

/// Insertions in blue and deletions struck through in red, on every page: Word's look.
const OPTIONS: ChangesPdfOptions = ChangesPdfOptions {
    colour: true,
    keep_deleted: true,
    margin_bars: false,
    only_changed_pages: false,
};

/// The PDF with the changes since review mode's base marked, as bytes; the
/// number `exports.begin()` gave this build stops it once a later one starts.
pub fn review_changes_pdf(
    root: &Path, exports: &ChangesExports, export: u64,
) -> Result<Vec<u8>, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?.path.replace('\\', "/");
    if !document.to_ascii_lowercase().ends_with(".tex") {
        return Err("Only a LaTeX document can show its changes marked.".to_string());
    }
    let bases = project::review_base_directory(root);
    if !bases.is_dir() {
        return Err("Review mode is off in this project.".to_string());
    }
    let build = root.join(project::REVIEW_DIRECTORY).join("build");
    let (older, newer) = (build.join("older"), build.join("newer"));
    let _ = fs::remove_dir_all(&older);
    mirror(&bases, &older, false)?;
    mirror(root, &newer, true)?;
    if !older.join(&document).is_file() {
        return Err(format!("{document} was made after review mode was turned on, so there is nothing to mark its changes against."));
    }
    for folder in [&newer, &older] {
        if let Some(chain) = input_loop::input_loop(folder, &document) {
            return Err(format!("{} read each other with \\input, so latexdiff would never finish. Remove the \\input that closes the loop.", chain.join(" → ")));
        }
    }
    if !commands::available("latexdiff") {
        return Err(super::LATEXDIFF_MISSING.to_string());
    }
    let latexdiff = commands::resolve("latexdiff");
    let run = Runner { exports, export, capture: &build };
    let marked = changes_name(&document, "tex");
    let mut first_failure = None;
    for simplified in [false, true] {
        let attempt =
            latexdiff_output(&run, &latexdiff, &older, &newer, &document, OPTIONS, simplified)
                .and_then(|tex| {
                    fs::write(newer.join(&marked), with_markup(&tex, OPTIONS))
                        .map_err(|error| Failed::Attempt(error.to_string()))
                })
                .and_then(|()| build_marked(&run, &newer, &marked, &manifest));
        match attempt {
            Ok(pdf) => return fs::read(&pdf).map_err(|error| error.to_string()),
            Err(Failed::Export(reason)) => return Err(reason),
            Err(Failed::Attempt(reason)) => {
                log::warn!(target: "lattice::review_pdf", "attempt (simplified: {simplified}) failed: {reason}");
                first_failure.get_or_insert(reason);
            }
        }
    }
    Err(first_failure.unwrap_or_default())
}

/// Put `source`'s files under `target`: the paper's LaTeX copied (only when it
/// changed, so latexmk sees what did), anything else linked when `link`. Lattice's
/// own folder, git's and other hidden folders are left out.
fn mirror(source: &Path, target: &Path, link: bool) -> Result<(), String> {
    let entries = WalkDir::new(source).max_depth(8).into_iter().filter_entry(|entry| {
        entry.depth() == 0
            || !(entry.file_type().is_dir() && entry.file_name().to_string_lossy().starts_with('.'))
    });
    for entry in entries.filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(source).map_err(|error| error.to_string())?;
        let destination = target.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if project::is_reviewable_path(&relative.to_string_lossy()) || !link {
            let text = fs::read(entry.path()).map_err(|error| error.to_string())?;
            if fs::read(&destination).ok().as_deref() != Some(text.as_slice()) {
                let _ = fs::remove_file(&destination);
                fs::write(&destination, text).map_err(|error| error.to_string())?;
            }
        } else if fs::symlink_metadata(&destination).is_err() {
            std::os::unix::fs::symlink(entry.path(), &destination)
                .map_err(|error| format!("Could not link {}: {error}", relative.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn the_newer_version_copies_the_latex_and_links_the_rest() {
        let root = TempDir::new("review-mirror");
        root.write("main.tex", "Hello.\n");
        root.write("figures/plot.pdf", "%PDF");
        root.write(".research/annotations.json", "{}");
        let target = TempDir::new("review-mirror-target");
        mirror(&root, &target, true).unwrap();
        assert!(!fs::symlink_metadata(target.join("main.tex")).unwrap().file_type().is_symlink());
        assert!(fs::symlink_metadata(target.join("figures/plot.pdf"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!target.join(".research").exists());

        // An edit since reaches the copy on the next build.
        root.write("main.tex", "Hello again.\n");
        mirror(&root, &target, true).unwrap();
        assert_eq!(fs::read_to_string(target.join("main.tex")).unwrap(), "Hello again.\n");
    }

    #[test]
    fn without_review_mode_there_is_nothing_to_mark_against() {
        let root = TempDir::new("review-off");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        root.write("main.tex", "\\documentclass{article}\n\\begin{document}x\\end{document}\n");
        let exports = ChangesExports::default();
        let error = review_changes_pdf(&root, &exports, exports.begin()).unwrap_err();
        assert_eq!(error, "Review mode is off in this project.");
    }

    /// The whole path: review mode on, an edit, and the marked PDF built
    /// under `.research/review/` with the paper's own files untouched.
    #[test]
    #[ignore = "requires latexdiff and a working pdfLaTeX installation"]
    fn marks_the_changes_since_review_mode_was_turned_on() {
        let root = TempDir::new("review-pdf");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        let paper = |body: &str| {
            format!("\\documentclass{{article}}\n\\begin{{document}}\n{body}\n\\end{{document}}\n")
        };
        root.write("main.tex", &paper("Attention lets a decoder look at encoder states."));
        project::start_review(&root).unwrap();
        root.write("main.tex", &paper("Attention lets a decoder retrieve encoder states."));
        let exports = ChangesExports::default();
        let pdf = review_changes_pdf(&root, &exports, exports.begin()).unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        let marked =
            fs::read_to_string(root.join(".research/review/build/newer/main-changes.tex")).unwrap();
        assert!(
            marked.contains(r"\DIFadd{retrieve") && marked.contains(r"\DIFdel{look at"),
            "{marked}"
        );
        assert!(!root.join("main-changes.pdf").exists() && !root.join("main.pdf").exists());
    }
}
