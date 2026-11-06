//! Overleaf's main document (`rootDoc_id`), kept for the one case where this
//! copy needs a pick of its own: a linked project whose root went missing
//! (`project::open`). The document builds compile is otherwise the writer's
//! choice (`Set as main document`), and Overleaf's never switches it.

use super::link::{load_state, save_state};
use std::path::Path;

/// `None` when `root` is not linked to Overleaf; else Overleaf's main document
/// as the live channel last reported it.
pub fn reported_root_document(root: &Path) -> Option<Option<String>> {
    Some(load_state(root).ok()?.root_document)
}

/// Record Overleaf's main document `path` as the live channel reports it (on
/// joining and with each tree change), whether or not the sync has brought the
/// file here yet. A main document that is not a `.tex` file is never compiled,
/// so it records none.
pub fn record_root_document(root: &Path, path: Option<&str>) -> Result<(), String> {
    let path = path
        .map(|path| path.trim().replace('\\', "/"))
        .filter(|path| path.to_ascii_lowercase().ends_with(".tex"));
    let mut state = load_state(root)?;
    if state.root_document == path {
        return Ok(());
    }
    state.root_document = path;
    save_state(root, &state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overleaf::sync::sync;
    use crate::overleaf::test_support::*;
    use crate::project;
    use std::collections::BTreeSet;

    const PAPER: &[u8] = b"\\documentclass{article}\n\\begin{document}\nv2\n\\end{document}\n";

    fn roots(root: &Path) -> Vec<(String, bool)> {
        let manifest = project::read_manifest(root).unwrap();
        (manifest.root_documents.into_iter())
            .map(|document| (document.path, document.is_default))
            .collect()
    }

    fn default_root(root: &Path) -> String {
        roots(root).into_iter().find(|(_, is_default)| *is_default).unwrap().0
    }

    #[test]
    fn overleafs_main_document_never_switches_a_root_that_is_still_here() {
        let both: Files = &[("main.tex", PAPER), ("main_v2.tex", PAPER)];
        let root = linked_root(both, both);
        project::open(&root).unwrap();
        assert_eq!(default_root(&root), "main.tex");

        record_root_document(&root, Some("main_v2.tex")).unwrap();
        assert_eq!(reported_root_document(&root), Some(Some("main_v2.tex".into())));
        project::open(&root).unwrap();
        assert_eq!(default_root(&root), "main.tex", "the writer decides what builds compile");

        // A main document that is not a .tex file is never compiled.
        record_root_document(&root, Some("notes.md")).unwrap();
        assert_eq!(reported_root_document(&root), Some(None));
    }

    #[test]
    fn a_main_document_not_downloaded_yet_is_recorded() {
        let root = linked_root(&[("main.tex", PAPER)], &[("main.tex", PAPER)]);
        project::open(&root).unwrap();
        record_root_document(&root, Some("main_v2.tex")).unwrap();
        assert_eq!(reported_root_document(&root), Some(Some("main_v2.tex".into())));
        assert_eq!(roots(&root), [("main.tex".to_string(), true)]);
    }

    /// The captain's report: main.tex renamed to main_v2.tex on Overleaf. The
    /// sync deletes main.tex here, and the manifest kept naming it, so the next
    /// open restored it into the editor and read a file that was gone: "No
    /// such file or directory (os error 2)".
    #[test]
    fn a_root_renamed_on_overleaf_is_replaced_when_the_project_opens_again() {
        let server = Mock::project(&[("main_v2.tex", PAPER)]).serve();
        let (config, root) = linked(&server, &[("main.tex", PAPER)], &[("main.tex", PAPER)]);
        project::open(&root).unwrap();
        assert_eq!(default_root(&root), "main.tex");

        let result = sync(&config, &root, &BTreeSet::new(), None).unwrap();
        assert_eq!(
            (result.deleted_local, result.pulled),
            (vec!["main.tex".into()], vec!["main_v2.tex".into()])
        );

        let snapshot = project::open(&root).unwrap();
        let roots: Vec<_> = (snapshot.manifest.root_documents.iter())
            .map(|document| (document.path.as_str(), document.is_default))
            .collect();
        assert_eq!(roots, [("main_v2.tex", true)], "the missing main.tex is dropped");
        assert!(project::read_file(&root, "main_v2.tex").is_ok());
    }

    /// Detection would pick paper.tex (a conventional name); the main document
    /// Overleaf named last comes first.
    #[test]
    fn a_missing_root_falls_back_to_overleafs_main_document_before_detection() {
        let files: Files = &[("main.tex", PAPER), ("paper.tex", PAPER), ("main_v2.tex", PAPER)];
        let root = linked_root(files, files);
        project::open(&root).unwrap();
        record_root_document(&root, Some("main_v2.tex")).unwrap();
        assert_eq!(default_root(&root), "main.tex");

        std::fs::remove_file(root.join("main.tex")).unwrap();
        project::open(&root).unwrap();
        assert_eq!(default_root(&root), "main_v2.tex");
    }

    /// A root that is not the default and went with a sync is dropped too, so
    /// a restore cannot open it from the manifest.
    #[test]
    fn a_missing_root_that_is_not_the_default_is_dropped() {
        let both: Files = &[("main.tex", PAPER), ("main_v2.tex", PAPER)];
        let root = linked_root(both, both);
        project::open(&root).unwrap();
        project::set_compile_root(&root, "main_v2.tex").unwrap();
        assert_eq!(
            roots(&root),
            [("main.tex".to_string(), false), ("main_v2.tex".to_string(), true)]
        );

        std::fs::remove_file(root.join("main.tex")).unwrap();
        project::open(&root).unwrap();
        assert_eq!(roots(&root), [("main_v2.tex".to_string(), true)]);
    }
}
