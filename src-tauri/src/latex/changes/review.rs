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
//! copied on every edit. The build's own outputs (`main-changes.*`) are never
//! linked: the export saves its PDF by that name in the project, and latexmk
//! writing through a link would overwrite it. The files review mode left out
//! (too big, or not text) have no base; the project's own copy stands in for
//! one, so they show no changes.
//!
//! The same guards hold as for the export: latexdiff and latexmk under time
//! and memory limits, `\input` loops named before latexdiff starts, and each
//! new build stopping the one before it.

use super::{
    changes_name, input_loop, mark_and_build, ChangesExports, ChangesPdfOptions, Runner, Versions,
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
    let outputs = changes_name(document.rsplit('/').next().unwrap_or(&document), "");
    let _ = fs::remove_dir_all(&older);
    mirror(&bases, &older, None)?;
    for path in project::review_excluded(root)? {
        let destination = older.join(&path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let _ = fs::copy(root.join(&path), destination);
    }
    mirror(root, &newer, Some(&outputs))?;
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
    let versions = Versions { older: &older, newer: &newer, document: &document };
    let built = mark_and_build(&run, &latexdiff, versions, OPTIONS, &manifest)?;
    fs::read(&built.pdf).map_err(|error| error.to_string())
}

/// Put `source`'s files under `target`: the paper's LaTeX copied (only when it
/// changed, so latexmk sees what did), anything else linked when `link` names
/// the build's outputs (`main-changes.`), which are neither linked nor copied.
/// Lattice's own folder, git's and other hidden folders are left out.
fn mirror(source: &Path, target: &Path, link: Option<&str>) -> Result<(), String> {
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
        if link.is_some_and(|outputs| entry.file_name().to_string_lossy().starts_with(outputs)) {
            if fs::symlink_metadata(&destination).is_ok_and(|meta| meta.file_type().is_symlink()) {
                let _ = fs::remove_file(&destination);
            }
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        // Copy resources on Windows so review builds need no symlink privilege.
        if project::is_reviewable_path(&relative.to_string_lossy())
            || link.is_none()
            || cfg!(windows)
        {
            let text = fs::read(entry.path()).map_err(|error| error.to_string())?;
            if fs::read(&destination).ok().as_deref() != Some(text.as_slice()) {
                let _ = fs::remove_file(&destination);
                fs::write(&destination, text).map_err(|error| error.to_string())?;
            }
        } else if fs::symlink_metadata(&destination).is_err() {
            #[cfg(unix)]
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
        mirror(&root, &target, Some("main-changes.")).unwrap();
        assert!(!fs::symlink_metadata(target.join("main.tex")).unwrap().file_type().is_symlink());
        assert_eq!(
            fs::symlink_metadata(target.join("figures/plot.pdf")).unwrap().file_type().is_symlink(),
            cfg!(unix)
        );
        assert_eq!(fs::read(target.join("figures/plot.pdf")).unwrap(), b"%PDF");
        assert!(!target.join(".research").exists());

        // An edit since reaches the copy on the next build.
        root.write("main.tex", "Hello again.\n");
        mirror(&root, &target, Some("main-changes.")).unwrap();
        assert_eq!(fs::read_to_string(target.join("main.tex")).unwrap(), "Hello again.\n");
    }

    #[test]
    fn the_build_never_writes_through_to_an_exported_pdf_in_the_project() {
        let root = TempDir::new("review-outputs");
        root.write("main.tex", "Hello.\n");
        // What "Export PDF with changes…" saved beside the paper.
        root.write("main-changes.pdf", "%PDF exported");
        root.write("main-changes.log", "exported log");
        let target = TempDir::new("review-outputs-target");
        // A link an earlier build left behind is taken away too.
        crate::test_support::symlink(
            root.join("main-changes.log"),
            target.join("main-changes.log"),
        )
        .unwrap();
        mirror(&root, &target, Some("main-changes.")).unwrap();
        assert!(fs::symlink_metadata(target.join("main-changes.pdf")).is_err());
        assert!(fs::symlink_metadata(target.join("main-changes.log")).is_err());

        // latexmk writes its outputs by name in the build folder.
        fs::write(target.join("main-changes.pdf"), "%PDF review build").unwrap();
        fs::write(target.join("main-changes.log"), "review log").unwrap();
        assert_eq!(fs::read_to_string(root.join("main-changes.pdf")).unwrap(), "%PDF exported");
        assert_eq!(fs::read_to_string(root.join("main-changes.log")).unwrap(), "exported log");
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
        root.write("main.tex", paper("Attention lets a decoder look at encoder states."));
        project::start_review(&root).unwrap();
        root.write("main.tex", paper("Attention lets a decoder retrieve encoder states."));
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

    /// The captain's paper: the base has no `.bbl` (review mode keeps only
    /// `.tex` and `.bib`), the project has the one its last build wrote, and
    /// latexdiff flattened that in as added text, marking natbib's
    /// `\csname urlstyle\endcsname`: "Missing \endcsname inserted", with
    /// plainer markup too. Both sides now flatten the same bibliography.
    #[test]
    #[ignore = "requires latexdiff and a working pdfLaTeX installation"]
    fn a_bibliography_the_base_lacks_is_not_marked() {
        let root = TempDir::new("review-bbl");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        let paper = |body: &str| {
            format!("\\documentclass{{article}}\n\\usepackage[numbers]{{natbib}}\n\\begin{{document}}\n{body}~\\citep{{he2016}}.\n\\bibliographystyle{{plainnat}}\n\\bibliography{{refs}}\n\\end{{document}}\n")
        };
        root.write("main.tex", paper("Residual networks train deep models"));
        root.write("refs.bib", "@article{he2016,title={Deep residual learning},author={He, Kaiming},journal={CVPR},year={2016}}\n");
        project::start_review(&root).unwrap();
        root.write("main.tex", paper("Residual networks train very deep models"));
        // What BibTeX wrote for the paper's own build, natbib's header first.
        root.write("main.bbl", "\\begin{thebibliography}{1}\n\\providecommand{\\natexlab}[1]{#1}\n\\providecommand{\\url}[1]{\\texttt{#1}}\n\\expandafter\\ifx\\csname urlstyle\\endcsname\\relax\n  \\providecommand{\\doi}[1]{doi: #1}\\else\n  \\providecommand{\\doi}{doi: \\begingroup \\urlstyle{rm}\\Url}\\fi\n\n\\bibitem[He(2016)]{he2016}\nKaiming He.\n\\newblock Deep residual learning.\n\\newblock \\emph{CVPR}, 2016.\n\n\\end{thebibliography}\n");
        let exports = ChangesExports::default();
        let pdf = review_changes_pdf(&root, &exports, exports.begin()).unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        let marked =
            fs::read_to_string(root.join(".research/review/build/newer/main-changes.tex")).unwrap();
        assert!(marked.contains(r"\DIFadd{very }"), "{marked}");
        // The bibliography is BibTeX's, so none of it is marked.
        let bibliography = &marked[marked.find("\\begin{thebibliography}").unwrap()..];
        assert!(!bibliography.contains("\\DIF"), "{bibliography}");
    }
}
