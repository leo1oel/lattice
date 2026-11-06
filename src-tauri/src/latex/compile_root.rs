//! Which document a build compiles: the manifest default, or a one-off root
//! the open file names for this build alone.

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
    match open_document.and_then(|open| project::resolve_compile_root(root, open)) {
        Some(target) if target.one_off => set_one_off_root(root, Some(&target.path)),
        Some(target) if !project::main_document_chosen(root) => {
            set_one_off_root(root, None);
            project::set_compile_root(root, &target.path)?;
        }
        _ => set_one_off_root(root, None),
    }
    Ok(())
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
