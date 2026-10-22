//! Files deleted on one side of a sync but not the other.

use super::*;

#[test]
fn overleaf_sync_resolves_deletions_made_on_one_side_and_cleans_up_transient_files() {
    // old.tex: deleted on Overleaf, untouched here, so it goes here too,
    // with no history to confirm it: a missing file is not a hollow one.
    // edited.tex: deleted on Overleaf after an edit here, so it goes back up.
    // dropped.tex: deleted here, untouched on Overleaf. A sync never deletes
    // remote files, but it is not downloaded again either, this time or on
    // any later sync: its agreed copy stays in state.
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
    let server = Mock::project(remote).serve();
    let (config, root) = linked(&server, local, base);
    let result = sync(&config, &root, &BTreeSet::new(), None).unwrap();
    assert_eq!(result.deleted_local, vec!["old.tex"]);
    assert!(result.refused_incoming.is_empty());
    assert_eq!(result.pushed, vec!["edited.tex"]);
    assert!(result.pulled.is_empty());
    assert_eq!(result.skipped_remote_deletes, vec!["dropped.tex"]);
    assert_eq!(result.automatic_remote_deletes, vec![save_error, "tmp/pdfs"]);
    let files = state_files(&root);
    for gone in ["old.tex", "dropped.tex", save_error, page] {
        assert!(read_local(&root, gone).is_none(), "{gone}");
    }
    for forgotten in ["old.tex", save_error, page] {
        assert!(!files.contains_key(forgotten), "{forgotten}");
    }
    assert_eq!(files.get("dropped.tex"), Some(&sha256_hex(b"still on overleaf")));
    assert!(!files.keys().any(|path| path.starts_with("tmp/pdfs/")));
    assert_eq!(read_local(&root, "edited.tex").unwrap(), b"edited after remote delete");
    assert!(files.contains_key("edited.tex"));
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 1);
    assert!(uploads[0].body_text().contains("edited after remote delete"));
    assert!(server.with_method("DELETE").is_empty());

    // The writer declined to delete dropped.tex on Overleaf too (the "ask"
    // setting's Cancel, or "never"). The next sync leaves it deleted here and
    // still offers the deletion, rather than downloading the file again.
    let again = sync(&config, &root, &BTreeSet::new(), None).unwrap();
    assert!(again.pulled.is_empty(), "{:?}", again.pulled);
    assert_eq!(again.skipped_remote_deletes, vec!["dropped.tex"]);
    assert!(read_local(&root, "dropped.tex").is_none());
}

#[test]
fn a_file_deleted_here_comes_back_once_overleaf_changes_it() {
    // Deleted here and left on Overleaf, then edited there by a collaborator:
    // their newer work wins over a deletion that was never carried out there.
    let base: Files = &[("main.tex", b"body"), ("notes.tex", b"kept on overleaf")];
    let server = Mock::project(base).serve();
    let (config, root) = linked(&server, &[("main.tex", b"body")], base);
    let first = sync(&config, &root, &BTreeSet::new(), None).unwrap();
    assert_eq!(first.skipped_remote_deletes, vec!["notes.tex"]);

    let edited = Mock::project(&[("main.tex", b"body"), ("notes.tex", b"edited on overleaf")]);
    let server = edited.serve();
    edit_state(&root, |state| state.host = server.base.clone());
    let second = sync(&signed_in(&server.base), &root, &BTreeSet::new(), None).unwrap();
    assert_eq!(second.pulled, vec!["notes.tex"]);
    assert!(second.skipped_remote_deletes.is_empty());
    assert_eq!(read_local(&root, "notes.tex").unwrap(), b"edited on overleaf");
}
