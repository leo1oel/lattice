//! Files a sync leaves on this machine: too large for Overleaf, or named as
//! Overleaf refuses (`overleaf::names`).

use super::*;
#[cfg(unix)]
use crate::overleaf::{NameProblem, RejectedName};

/// A file whose name Overleaf refuses (here a TeX macro left in a `.bib`
/// path, as an earlier Papers wrote) would fail its upload with HTTP 400 and
/// take the whole sync with it. It stays here, named with why, while every
/// other file goes up; nothing records it as synced.
#[cfg(unix)]
#[test]
fn a_file_overleaf_refuses_by_name_stays_here_and_the_rest_syncs() {
    let root = TempDir::new("overleaf-project");
    let server = Mock::project(&[("main.tex", b"agreed")]).serve();
    let config = link_to(&server, &root, &[("main.tex", b"agreed")], &[("main.tex", b"agreed")]);
    fs::create_dir_all(disk_path(&root, "cvpr")).unwrap();
    fs::write(root.join(r"cvpr/\paperbib.bib"), b"@misc{a,}").unwrap();
    fs::write(disk_path(&root, "cvpr/references.bib"), b"@misc{a,}").unwrap();

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(
        result.skipped_names,
        [RejectedName { path: r"cvpr/\paperbib.bib".into(), problem: NameProblem::Backslash }]
    );
    assert_eq!(result.pushed, ["cvpr/references.bib"]);
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 1);
    assert!(!uploads[0].body_text().contains("paperbib"));
    assert!(!state_files(&root).contains_key(r"cvpr/\paperbib.bib"));
    // Still there, untouched, for the writer to rename or delete.
    assert!(root.join(r"cvpr/\paperbib.bib").is_file());
}

/// A file too large to sync is never read, so it cannot have changed during
/// the sync either: Overleaf's newer copy leaves it alone without reporting it
/// as edited, which would start another sync that does exactly the same.
#[test]
fn a_file_too_large_to_sync_is_not_reported_as_edited_during_the_sync() {
    let root = TempDir::new("overleaf-project");
    let server = Mock::project(&[("fig/big.png", b"replaced on Overleaf")]).serve();
    let config =
        link_to(&server, &root, &[("fig/big.png", b"agreed")], &[("fig/big.png", b"agreed")]);
    let big = fs::OpenOptions::new().write(true).open(disk_path(&root, "fig/big.png")).unwrap();
    big.set_len(MAX_SYNC_FILE_BYTES + 1).unwrap();

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.skipped_large, ["fig/big.png"]);
    assert!(result.edited_during_sync.is_empty());
    assert!(result.pulled.is_empty());
    assert_eq!(
        fs::metadata(disk_path(&root, "fig/big.png")).unwrap().len(),
        MAX_SYNC_FILE_BYTES + 1
    );
    assert_eq!(state_files(&root)["fig/big.png"], sha256_hex(b"agreed"));
}
