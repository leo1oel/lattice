//! Overleaf's main document (`rootDoc_id`) and the document builds compile
//! here. A downloaded project's root is detected from its files, which picks
//! `main.tex` over a `main_v2.tex` Overleaf compiles; following Overleaf's
//! choice is what makes the two agree.

use super::link::{load_state, save_state};
use crate::models::ProjectManifest;
use crate::project;
use std::path::Path;

/// `None` when `root` is not linked to Overleaf; else Overleaf's main document
/// as this copy last followed it, for a linked project whose own root went
/// missing (`project::open`) to fall back on before guessing.
pub fn followed_root_document(root: &Path) -> Option<Option<String>> {
    Some(load_state(root).ok()?.root_document)
}

/// Follow Overleaf's main document `path` (from the live channel's join or a
/// `rootDocUpdated`) when it differs from the one last followed, making it the
/// document builds compile. Returns the manifest when it did.
///
/// Only a change is followed. A writer who chose another main document here
/// (`Set as main document`) keeps it until someone changes Overleaf's; the
/// choice made here stays local, because Overleaf's setting is every
/// collaborator's. A path not on disk yet (the sync that brings it is still to
/// run) is not recorded, so the next join follows it once it has arrived.
pub fn adopt_root_document(root: &Path, path: &str) -> Result<Option<ProjectManifest>, String> {
    let path = path.trim().replace('\\', "/");
    if !path.to_ascii_lowercase().ends_with(".tex") {
        return Ok(None);
    }
    let mut state = load_state(root)?;
    if state.root_document.as_deref() == Some(path.as_str())
        || !project::safe_path(root, &path).is_ok_and(|file| file.is_file())
    {
        return Ok(None);
    }
    let manifest = project::set_compile_root(root, &path)?;
    state.root_document = Some(path);
    save_state(root, &state)?;
    Ok(Some(manifest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overleaf::sync::sync;
    use crate::overleaf::test_support::*;
    use std::collections::BTreeSet;

    const PAPER: &[u8] = b"\\documentclass{article}\n\\begin{document}\nv2\n\\end{document}\n";

    fn default_root(root: &Path) -> String {
        let manifest = project::read_manifest(root).unwrap();
        manifest.root_documents.into_iter().find(|document| document.is_default).unwrap().path
    }

    #[test]
    fn overleafs_main_document_is_followed_when_it_changes_and_a_local_choice_stands() {
        let both: Files = &[("main.tex", PAPER), ("main_v2.tex", PAPER)];
        let root = linked_root(both, both);
        // Detection prefers main.tex, which is not what Overleaf compiles.
        project::open(&root).unwrap();
        assert_eq!(default_root(&root), "main.tex");

        let adopted = adopt_root_document(&root, "main_v2.tex").unwrap().unwrap();
        assert!(adopted.root_documents.iter().any(|d| d.is_default && d.path == "main_v2.tex"));
        assert_eq!(default_root(&root), "main_v2.tex");
        assert_eq!(followed_root_document(&root), Some(Some("main_v2.tex".into())));

        // The writer picks main.tex here; the next join, naming the same
        // main document as before, leaves that choice alone.
        project::set_compile_root(&root, "main.tex").unwrap();
        assert!(adopt_root_document(&root, "main_v2.tex").unwrap().is_none());
        assert_eq!(default_root(&root), "main.tex");
        // A main document that is not a .tex file is never compiled.
        assert!(adopt_root_document(&root, "notes.md").unwrap().is_none());
    }

    #[test]
    fn a_main_document_not_downloaded_yet_is_followed_once_it_arrives() {
        let root = linked_root(&[("main.tex", PAPER)], &[("main.tex", PAPER)]);
        project::open(&root).unwrap();
        assert!(adopt_root_document(&root, "main_v2.tex").unwrap().is_none());
        assert_eq!(followed_root_document(&root), Some(None));

        std::fs::write(root.join("main_v2.tex"), PAPER).unwrap();
        assert!(adopt_root_document(&root, "main_v2.tex").unwrap().is_some());
        assert_eq!(default_root(&root), "main_v2.tex");
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
        adopt_root_document(&root, "main_v2.tex").unwrap();
        project::set_compile_root(&root, "main.tex").unwrap();

        std::fs::remove_file(root.join("main.tex")).unwrap();
        project::open(&root).unwrap();
        assert_eq!(default_root(&root), "main_v2.tex");
    }
}
