//! Which document a build compiles: the manifest default, or a one-off root
//! the open file names for this build alone.

use super::changes::input_loop::flattened;
use super::default_root_document;
use crate::models::ProjectManifest;
use crate::project;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// Per project, the document the last build compiled when it was a one-off
/// (`project::CompileRoot::one_off`: a `standalone` figure, a `subfiles`
/// chapter) rather than the manifest default. Its PDF is the one on screen, so
/// the build's own passes, reading that PDF and SyncTeX follow it; the default
/// stays where the writer set it, and the next build of anything else clears
/// this. Kept in memory: a new session shows the default's PDF again.
static ONE_OFF_ROOTS: LazyLock<Mutex<HashMap<PathBuf, String>>> = LazyLock::new(Default::default);

fn one_off_roots() -> std::sync::MutexGuard<'static, HashMap<PathBuf, String>> {
    ONE_OFF_ROOTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record what the build about to run compiles: `Some` for a one-off, `None`
/// for the manifest default.
fn set_one_off_root(root: &Path, document: Option<&str>) {
    match document {
        Some(document) => one_off_roots().insert(root.to_path_buf(), document.to_string()),
        None => one_off_roots().remove(root),
    };
}

pub(super) fn is_one_off_root(root: &Path) -> bool {
    one_off_roots().contains_key(root)
}

/// The document whose PDF the last build left (relative to `root`): a one-off
/// root while one stands, else the manifest default.
pub(super) fn compiled_document(root: &Path, manifest: &ProjectManifest) -> Result<String, String> {
    if let Some(document) = one_off_roots().get(root) {
        return Ok(document.clone());
    }
    default_root_document(manifest).map(|document| document.path.clone())
}

/// Overleaf's compile rule, unless the writer chose the main document (Set as
/// main document, `project::main_document_chosen`), which then always builds:
/// the file open in the editor wins when it is a compilable root itself
/// (\documentclass) or names one via `% !TEX root`. The winner is written back as the manifest default before latexmk runs, so
/// a chapter opened next still compiles this document, and everything that
/// resolves the default root (PDF preview, SyncTeX, clean) agrees on what was
/// built. A standalone figure or subfiles chapter is the exception: it
/// compiles this once and the default stays, so the chapter edited next
/// builds the paper again rather than the figure.
pub(super) fn choose_compile_root(root: &Path, open_document: Option<&str>) -> Result<(), String> {
    match open_target(root, open_document) {
        Some(target) if target.one_off => set_one_off_root(root, Some(&target.path)),
        Some(target) => {
            set_one_off_root(root, None);
            project::set_compile_root(root, &target.path)?;
        }
        None => set_one_off_root(root, None),
    }
    Ok(())
}

/// The root the open file makes a build compile, when it wins over the
/// manifest default ([`choose_compile_root`]'s rule).
fn open_target(root: &Path, open_document: Option<&str>) -> Option<project::CompileRoot> {
    let open = open_document?;
    project::resolve_compile_root(root, open)
        .or_else(|| including_root(root, open))
        .filter(|target| target.one_off || !project::main_document_chosen(root))
}

/// The root document that pastes in `open`, a chapter with no vote of its
/// own, when the manifest default does not. The default follows the last root
/// built, so with a paper and its rebuttal side by side, a section of the
/// paper saved after the rebuttal was built compiled the rebuttal: its PDF
/// came to the front and the section's edit was nowhere in it. A chapter the
/// default reads, or that no root reads, leaves the default standing.
fn including_root(root: &Path, open: &str) -> Option<project::CompileRoot> {
    let open = open.trim().replace('\\', "/");
    let manifest = project::read_manifest(root).ok()?;
    let default = &default_root_document(&manifest).ok()?.path;
    let reads = |document: &str| flattened(root, document).contains(&open);
    if reads(default) {
        return None;
    }
    let document = manifest
        .root_documents
        .iter()
        .find(|document| &document.path != default && reads(&document.path))?;
    Some(project::CompileRoot { path: document.path.clone(), one_off: false })
}

/// The document a build started with `open_document` in the editor would
/// compile, without recording anything ([`choose_compile_root`] does that
/// when the build runs).
///
/// A clean ahead of a build asks this, not the last build's document: with
/// two root documents in a folder (a paper and its supplement, linked by
/// `xr-hyper`), a Clean rebuild of the paper right after a build of the
/// supplement deleted the supplement's `.aux`, which the paper reads.
pub(super) fn build_target(
    root: &Path, manifest: &ProjectManifest, open_document: Option<&str>,
) -> Result<String, String> {
    match open_target(root, open_document) {
        Some(target) => Ok(target.path),
        None => default_root_document(manifest).map(|document| document.path.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::default_root;
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn a_standalone_figure_compiles_once_and_the_paper_stays_the_default() {
        let root = TempDir::new("one-off-root");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        root.write(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\\input{sections/method}\\end{document}\n",
        );
        root.write("sections/method.tex", "\\section{Method}\n");
        root.write(
            "figures/plot.tex",
            "\\documentclass{standalone}\n\\begin{document}x\\end{document}\n",
        );
        root.write(
            "chapters/intro.tex",
            "\\documentclass[../main.tex]{subfiles}\n\\begin{document}x\\end{document}\n",
        );
        let default_path = || {
            let manifest = project::read_manifest(&root).unwrap();
            default_root(&manifest).unwrap().path.clone()
        };
        let compiled =
            || compiled_document(&root, &project::read_manifest(&root).unwrap()).unwrap();

        for one_off in ["figures/plot.tex", "chapters/intro.tex"] {
            choose_compile_root(&root, Some(one_off)).unwrap();
            // This build, its PDF and SyncTeX are the figure's ...
            assert_eq!(compiled(), one_off);
            assert!(is_one_off_root(&root));
            // ... and the project's root document is still the paper.
            assert_eq!(default_path(), "main.tex");

            // The chapter edited next builds the paper, not the figure.
            choose_compile_root(&root, Some("sections/method.tex")).unwrap();
            assert_eq!(compiled(), "main.tex");
            assert!(!is_one_off_root(&root));
        }
        assert_eq!(project::read_manifest(&root).unwrap().root_documents.len(), 1);
    }

    /// A paper and its supplement, each a root, in one folder: a clean
    /// ahead of a build names the root that build compiles, not the last
    /// build's, and records nothing.
    #[test]
    fn a_clean_names_the_root_the_next_build_compiles() {
        let root = TempDir::new("build-target");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        let root_document = "\\documentclass{article}\n\\begin{document}x\\end{document}\n";
        root.write("cvpr/main_v3.tex", root_document);
        root.write("cvpr/supp_v3.tex", root_document);
        root.write("cvpr/sec/intro.tex", "\\section{Intro}\n");
        let manifest = || project::read_manifest(&root).unwrap();
        let target = |open: Option<&str>| build_target(&root, &manifest(), open).unwrap();

        choose_compile_root(&root, Some("cvpr/supp_v3.tex")).unwrap();
        assert_eq!(compiled_document(&root, &manifest()).unwrap(), "cvpr/supp_v3.tex");
        assert_eq!(target(Some("cvpr/main_v3.tex")), "cvpr/main_v3.tex");
        // Asking moved nothing: the last build's document is still the default.
        assert_eq!(compiled_document(&root, &manifest()).unwrap(), "cvpr/supp_v3.tex");
        // A chapter, or no .tex open, builds the default.
        assert_eq!(target(Some("cvpr/sec/intro.tex")), "cvpr/supp_v3.tex");
        assert_eq!(target(None), "cvpr/supp_v3.tex");
    }

    /// A CVPR paper and its rebuttal: the rebuttal, built last, is the
    /// default, and a section only the paper reads builds the paper again.
    #[test]
    fn a_section_builds_the_root_that_reads_it_after_another_root_was_built() {
        let root = TempDir::new("section-root");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        root.write(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\n\\input{sec/experiments}\n\\end{document}\n",
        );
        root.write("rebuttal.tex", "\\documentclass{article}\n\\begin{document}x\\end{document}\n");
        root.write("sec/experiments.tex", "\\section{Experiments}\n");
        root.write("sec/notes.tex", "\\section{Notes}\n");
        let compiled =
            || compiled_document(&root, &project::read_manifest(&root).unwrap()).unwrap();

        choose_compile_root(&root, Some("main.tex")).unwrap();
        choose_compile_root(&root, Some("rebuttal.tex")).unwrap();
        assert_eq!(compiled(), "rebuttal.tex");

        choose_compile_root(&root, Some("sec/experiments.tex")).unwrap();
        assert_eq!(compiled(), "main.tex");
        assert_eq!(
            build_target(
                &root,
                &project::read_manifest(&root).unwrap(),
                Some("sec/experiments.tex")
            )
            .unwrap(),
            "main.tex"
        );

        // A file no root reads leaves the default where the last build put it.
        choose_compile_root(&root, Some("rebuttal.tex")).unwrap();
        choose_compile_root(&root, Some("sec/notes.tex")).unwrap();
        assert_eq!(compiled(), "rebuttal.tex");

        // Set as main document still holds every build.
        project::choose_root_document(&root, "rebuttal.tex").unwrap();
        choose_compile_root(&root, Some("sec/experiments.tex")).unwrap();
        assert_eq!(compiled(), "rebuttal.tex");
    }

    /// The captain's project: main.tex and main_v2.tex both declare a class.
    #[test]
    fn a_main_document_set_by_the_writer_builds_whichever_root_is_open() {
        let root = TempDir::new("chosen-root");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        let paper = "\\documentclass{article}\n\\begin{document}x\\end{document}\n";
        root.write("main.tex", paper);
        root.write("main_v2.tex", paper);
        root.write(
            "figures/plot.tex",
            "\\documentclass{standalone}\n\\begin{document}x\\end{document}\n",
        );
        let compiled =
            || compiled_document(&root, &project::read_manifest(&root).unwrap()).unwrap();

        // Nothing chosen: the open root wins and becomes the default.
        choose_compile_root(&root, Some("main_v2.tex")).unwrap();
        assert_eq!(compiled(), "main_v2.tex");

        project::choose_root_document(&root, "main.tex").unwrap();
        choose_compile_root(&root, Some("main_v2.tex")).unwrap();
        assert_eq!(compiled(), "main.tex", "Set as main document outlasts the open tab");
        // A standalone figure still builds on its own, and the choice stands.
        choose_compile_root(&root, Some("figures/plot.tex")).unwrap();
        assert_eq!(compiled(), "figures/plot.tex");
        choose_compile_root(&root, Some("main_v2.tex")).unwrap();
        assert_eq!(compiled(), "main.tex");

        // A chosen main document that is gone no longer holds the build.
        std::fs::remove_file(root.join("main.tex")).unwrap();
        choose_compile_root(&root, Some("main_v2.tex")).unwrap();
        assert_eq!(compiled(), "main_v2.tex");
        assert!(!project::main_document_chosen(&root));
    }
}
