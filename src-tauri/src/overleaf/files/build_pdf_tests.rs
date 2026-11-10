//! A root document's PDF in a subfolder (`cvpr/main.tex` builds
//! `cvpr/main.pdf`) is this copy's build, as `main.pdf` beside a top-level
//! `main.tex` is: it never goes up, a collaborator's never comes down over
//! it, and one an earlier sync agreed on is let go of on both sides.

use crate::overleaf::sync::sync;
use crate::overleaf::test_support::*;
use crate::overleaf_rt::mock_server::realtime_state;
use crate::project;
use serde_json::json;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

const PAPER: &[u8] = b"\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n";
const NO_LIVE: &BTreeSet<String> = &BTreeSet::new();

/// The manifest `project::open` leaves: `cvpr/main.tex` is what builds.
fn compile_cvpr(root: &Path) {
    let mut manifest = project::default_manifest("paper");
    manifest.root_documents[0].path = "cvpr/main.tex".into();
    project::write_manifest(root, &manifest).unwrap();
}

/// A sync of a `cvpr/main.tex` project, whose last sync agreed on `base`.
fn sync_cvpr(
    remote: Files, local: Files, base: Files,
) -> (MockServer, TempDir, crate::overleaf::OverleafSyncResult) {
    let server = Mock::project(remote).serve();
    let (config, root) = linked(&server, local, base);
    compile_cvpr(&root);
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    (server, root, result)
}

fn uploads_name(server: &MockServer, name: &str) -> bool {
    server.uploads().iter().any(|upload| upload.body_text().contains(name))
}

#[test]
fn a_subfolder_roots_pdf_never_goes_up() {
    let source: Files = &[("cvpr/main.tex", PAPER)];
    let local: Files = &[("cvpr/main.tex", PAPER), ("cvpr/main.pdf", b"%PDF mine")];
    let (server, _root, result) = sync_cvpr(source, local, source);
    assert!(result.pushed.is_empty(), "{:?}", result.pushed);
    assert!(!uploads_name(&server, "main.pdf"));
}

#[test]
fn a_collaborators_pdf_never_comes_down_over_this_copys_build() {
    // An earlier Lattice sent this copy's PDF up, and the table still holds it.
    let base: Files = &[("cvpr/main.tex", PAPER), ("cvpr/main.pdf", b"%PDF old")];
    let remote: Files = &[("cvpr/main.tex", PAPER), ("cvpr/main.pdf", b"%PDF theirs")];

    // Unchanged here since: Overleaf's would have been pulled over it.
    let (_server, root, result) = sync_cvpr(remote, base, base);
    assert!(result.pulled.is_empty() && result.conflicts.is_empty(), "{result:?}");
    assert_eq!(read_local(&root, "cvpr/main.pdf").unwrap(), b"%PDF old");

    // Rebuilt here too: Overleaf's would have won the conflict.
    let local: Files = &[("cvpr/main.tex", PAPER), ("cvpr/main.pdf", b"%PDF mine")];
    let (server, root, result) = sync_cvpr(remote, local, base);
    assert!(result.pulled.is_empty() && result.pushed.is_empty(), "{result:?}");
    assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);
    assert_eq!(read_local(&root, "cvpr/main.pdf").unwrap(), b"%PDF mine");
    assert!(!uploads_name(&server, "main.pdf"));
    // Let go of, not deleted: Overleaf's copy stays where it is.
    assert!(result.skipped_remote_deletes.is_empty() && result.deleted_local.is_empty());
    assert!(server.with_method("DELETE").is_empty());
    assert_eq!(state_files(&root).keys().collect::<Vec<_>>(), ["cvpr/main.tex"]);
}

#[test]
fn a_top_level_roots_pdf_still_stays_out_both_ways() {
    let remote: Files = &[("main.tex", PAPER), ("main.pdf", b"%PDF theirs")];
    let local: Files = &[("main.tex", PAPER), ("main.pdf", b"%PDF mine")];
    let (server, root, result) = run_sync(Mock::project(remote), local, &[("main.tex", PAPER)]);
    assert!(result.pulled.is_empty() && result.pushed.is_empty(), "{result:?}");
    assert_eq!(server.uploads().len(), 0);
    assert_eq!(read_local(&root, "main.pdf").unwrap(), b"%PDF mine");
}

/// The same through the live tree and history, which fetch only what a
/// co-author changed instead of downloading the project.
#[test]
fn a_collaborators_pdf_added_on_overleaf_is_not_fetched() {
    let files = vec![("cvpr/main.tex".to_string(), PAPER.to_vec())];
    let shared = SharedProject::new(&files, 40);
    let mock = Mock {
        realtime: Some(realtime_state(json!({}), &[])),
        shared: Some(Arc::clone(&shared)),
        ..Default::default()
    };
    let server = mock.serve();
    let source: Files = &[("cvpr/main.tex", PAPER)];
    let (config, root) = linked(&server, source, source);
    edit_state(&root, |state| {
        state.remote_version = Some(40);
        state.agreed_version = Some(40);
        state.unsettled = Some(BTreeSet::new());
    });
    compile_cvpr(&root);
    {
        let mut shared = shared.lock().unwrap();
        shared.files.insert("cvpr/main.pdf".into(), b"%PDF theirs".to_vec());
        shared.update(&[], json!([{ "add": { "pathname": "cvpr/main.pdf" } }]));
    }

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.pulled.is_empty(), "{:?}", result.pulled);
    assert_eq!(read_local(&root, "cvpr/main.pdf"), None);
    let downloads = server.recorded().iter().filter(|r| r.url.ends_with("/download/zip")).count();
    assert_eq!(downloads, 0, "fetched from the live tree, not downloaded");
}
