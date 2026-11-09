use super::*;

/// Nor is a path the sync cannot read as a file — a symlink, a file in a
/// symlinked folder, or a folder where Overleaf has a file: it stays as it
/// is, and unreported.
#[test]
fn a_path_no_sync_reads_is_left_alone_and_not_reported_as_edited() {
    let root = TempDir::new("overleaf-project");
    let shared = TempDir::new("shared-bibliography");
    let server = Mock::project(&[
        ("refs.bib", b"@book{overleaf}"),
        ("fig/plot.png", b"\x89PNG"),
        ("figures/a.png", b"\x89PNG overleaf"),
    ])
    .serve();
    let config = link_to(&server, &root, &[("main.tex", b"body")], &[("main.tex", b"body")]);
    fs::write(shared.join("refs.bib"), "@book{shared}").unwrap();
    crate::test_support::symlink(shared.join("refs.bib"), disk_path(&root, "refs.bib")).unwrap();
    fs::create_dir_all(disk_path(&root, "fig/plot.png")).unwrap();
    shared.write("figures/a.png", b"\x89PNG shared");
    crate::test_support::symlink(shared.join("figures"), disk_path(&root, "figures")).unwrap();

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.edited_during_sync.is_empty());
    assert!(result.pulled.is_empty());
    assert!(fs::symlink_metadata(disk_path(&root, "refs.bib")).unwrap().is_symlink());
    assert_eq!(fs::read_to_string(shared.join("refs.bib")).unwrap(), "@book{shared}");
    assert!(disk_path(&root, "fig/plot.png").is_dir());
    assert_eq!(fs::read(shared.join("figures/a.png")).unwrap(), b"\x89PNG shared");
}
