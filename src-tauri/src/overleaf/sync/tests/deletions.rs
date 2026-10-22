//! Files deleted on one side of a sync but not the other.

use super::*;

#[test]
fn overleaf_sync_resolves_deletions_made_on_one_side_and_cleans_up_transient_files() {
    // old.tex: deleted on Overleaf, untouched here, so it goes here too,
    // with no history to confirm it: a missing file is not a hollow one.
    // edited.tex: deleted on Overleaf after an edit here, so it goes back up.
    // dropped.tex: deleted here, untouched on Overleaf. We never delete
    // remote files, but it is not downloaded again either: dropping it from
    // state is what stops it resurrecting.
    // Legacy transient files left on Overleaf are requested for silent
    // cleanup instead: never offered as a deletion, pulled or kept in state.
    let (save_error, page) =
        ("lambda_gpu_proposal.bbl-SAVE-ERROR", "tmp/pdfs/full-appendix/page-01.png");
    let (failed, preview) = (b"failed bibliography output".as_slice(), b"preview".as_slice());
    let remote: Files = &[
        ("dropped.tex", b"still on overleaf"),
        ("main.tex", b"body"),
        (save_error, failed),
        (page, preview),
        ("tmp/pdfs/gallery-page-10.png", preview),
    ];
    let local: Files = &[
        ("edited.tex", b"edited after remote delete"),
        ("main.tex", b"body"),
        ("old.tex", b"stale"),
    ];
    let base: Files = &[
        ("dropped.tex", b"still on overleaf"),
        ("edited.tex", b"original"),
        ("main.tex", b"body"),
        ("old.tex", b"stale"),
        (save_error, failed),
        (page, preview),
    ];
    let (server, root, result) = run_sync(Mock::project(remote), local, base);
    assert_eq!(result.deleted_local, vec!["old.tex"]);
    assert!(result.refused_incoming.is_empty());
    assert_eq!(result.pushed, vec!["edited.tex"]);
    assert!(result.pulled.is_empty());
    assert_eq!(result.skipped_remote_deletes, vec!["dropped.tex"]);
    assert_eq!(result.automatic_remote_deletes, vec![save_error, "tmp/pdfs"]);
    let files = state_files(&root);
    for gone in ["old.tex", "dropped.tex", save_error, page] {
        assert!(read_local(&root, gone).is_none(), "{gone}");
        assert!(!files.contains_key(gone), "{gone}");
    }
    assert!(!files.keys().any(|path| path.starts_with("tmp/pdfs/")));
    assert_eq!(read_local(&root, "edited.tex").unwrap(), b"edited after remote delete");
    assert!(files.contains_key("edited.tex"));
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 1);
    assert!(uploads[0].body_text().contains("edited after remote delete"));
    assert!(server.with_method("DELETE").is_empty());
}
