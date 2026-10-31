//! Overleaf paths that differ only in letter case, which a Mac's disk cannot
//! keep apart. Each test holds on any volume: the sync sets the clash aside
//! before touching the disk, so whether the volume would have merged the two
//! never comes into it.

use super::*;
use crate::overleaf::link::clone_project;

const PLOT: &[u8] = b"AAAA original Plot.png bytes";
const OTHER: &[u8] = b"BBBB a different plot.png";

fn clash(kept: &str, skipped: &str) -> CaseCollision {
    CaseCollision { kept: kept.into(), skipped: skipped.into() }
}

/// Neither Overleaf file was uploaded over or offered for deletion.
fn assert_overleaf_untouched(server: &MockServer, result: &OverleafSyncResult) {
    assert!(result.pushed.is_empty(), "{:?}", result.pushed);
    assert!(result.skipped_remote_deletes.is_empty(), "{:?}", result.skipped_remote_deletes);
    assert!(server.uploads().is_empty());
    assert!(server.with_method("DELETE").is_empty());
}

#[test]
fn two_overleaf_files_that_differ_only_in_case_sync_one_and_name_the_other() {
    // The audit's reproduction: the second spelling found the first already
    // on disk, so the sync left it, recorded nothing and reported nothing,
    // and every later sync agreed with itself that all was well.
    let remote: Files = &[("fig/Plot.png", PLOT), ("fig/plot.png", OTHER), ("main.tex", b"x")];
    let server = Mock { versions: vec![11], ..Mock::project(remote) }.serve();
    let (config, root) = linked(&server, &[], &[]);

    // What the preview offers is what the sync then does.
    let preview = preview(&config, &root, NO_LIVE).unwrap();
    let rows: Vec<_> =
        (preview.changes.iter()).map(|c| (c.kind.as_str(), c.path.as_str())).collect();
    assert_eq!(rows, [("incoming", "fig/Plot.png"), ("incoming", "main.tex")]);

    let first = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(first.pulled, ["fig/Plot.png", "main.tex"]);
    assert_eq!(first.case_collisions, [clash("fig/Plot.png", "fig/plot.png")]);
    assert_eq!(read_local(&root, "fig/Plot.png").as_deref(), Some(PLOT));
    assert_eq!(fs::read_dir(root.join("fig")).unwrap().count(), 1);
    assert!(!state_files(&root).contains_key("fig/plot.png"));
    assert_overleaf_untouched(&server, &first);

    // Nothing changed on Overleaf, yet the next sync still names the clash:
    // it downloads rather than trusting an agreed copy that lacks the file.
    let second = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(second.pulled.is_empty(), "{:?}", second.pulled);
    assert_eq!(second.case_collisions, first.case_collisions);
    assert_eq!(read_local(&root, "fig/Plot.png").as_deref(), Some(PLOT));
    assert_overleaf_untouched(&server, &second);
}

#[test]
fn two_overleaf_folders_that_differ_only_in_case_never_upload_a_duplicate() {
    // Written into Figures/, figures/b.png read back as Figures/b.png: a new
    // file to upload, while Overleaf's figures/b.png looked deleted here.
    let remote: Files = &[("Figures/a.png", PLOT), ("figures/b.png", OTHER), ("main.tex", b"x")];
    let server = Mock { versions: vec![11], ..Mock::project(remote) }.serve();
    let (config, root) = linked(&server, &[], &[]);

    let first = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(first.pulled, ["Figures/a.png", "main.tex"]);
    assert_eq!(first.case_collisions, [clash("Figures", "figures")]);
    assert!(read_local(&root, "Figures/b.png").is_none());
    assert_overleaf_untouched(&server, &first);

    let second = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(second.case_collisions, first.case_collisions);
    assert_overleaf_untouched(&server, &second);

    // A project synced before this check has b.png on disk under the other
    // spelling, and Overleaf's spelling in its table. It stays here, unsent,
    // and Overleaf's copy is not offered for deletion.
    let base: Files = &[("Figures/a.png", PLOT), ("figures/b.png", OTHER), ("main.tex", b"x")];
    let local: Files = &[("Figures/a.png", PLOT), ("Figures/b.png", OTHER), ("main.tex", b"x")];
    let server = Mock { versions: vec![11], ..Mock::project(remote) }.serve();
    let (config, root) = linked(&server, local, base);
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.case_collisions, [clash("Figures", "figures")]);
    assert_eq!(read_local(&root, "Figures/b.png").as_deref(), Some(OTHER));
    assert_overleaf_untouched(&server, &result);
}

#[test]
fn the_spelling_already_here_keeps_syncing_when_overleaf_gains_its_twin() {
    // fig/plot.png has synced all along; a collaborator then adds
    // fig/Plot.png. The file here stays as it is, and the rest of the project
    // syncs as ever: the local edit to main.tex goes up.
    let remote: Files = &[("fig/Plot.png", PLOT), ("fig/plot.png", OTHER), ("main.tex", b"old")];
    let base: Files = &[("fig/plot.png", OTHER), ("main.tex", b"old")];
    let local: Files = &[("fig/plot.png", OTHER), ("main.tex", b"edited here")];
    let server = Mock { versions: vec![11], ..Mock::project(remote) }.serve();
    let (config, root) = linked(&server, local, base);

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.case_collisions, [clash("fig/plot.png", "fig/Plot.png")]);
    assert!(result.pulled.is_empty(), "{:?}", result.pulled);
    assert_eq!(result.pushed, ["main.tex"]);
    assert_eq!(read_local(&root, "fig/plot.png").as_deref(), Some(OTHER));
    assert_eq!(state_files(&root)["fig/plot.png"], sha256_hex(OTHER));
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 1);
    assert!(uploads[0].body_text().contains("edited here"));
}

#[test]
fn a_clone_writes_one_spelling_and_its_first_sync_names_the_other() {
    // Cloning wrote both, the second over the first: the file here held the
    // other's bytes under the first's name, and the next sync uploaded them
    // over Overleaf's Plot.png and offered plot.png for deletion.
    let remote: Files = &[("fig/Plot.png", PLOT), ("fig/plot.png", OTHER), ("main.tex", b"x")];
    let server = Mock { versions: vec![11], ..Mock::project(remote) }.serve();
    let (config, parent) = (signed_in(&server.base), TempDir::new("clone-parent"));
    let root = clone_project(&config, "proj-1", "Clash", &parent, Some("owner")).unwrap();
    assert_eq!(read_local(&root, "fig/Plot.png").as_deref(), Some(PLOT));
    assert_eq!(fs::read_dir(root.join("fig")).unwrap().count(), 1);
    assert!(!state_files(&root).contains_key("fig/plot.png"));
    // Unknown, so the first probe asks for the sync that names the clash.
    assert_eq!(remote_version(&root), None);

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.case_collisions, [clash("fig/Plot.png", "fig/plot.png")]);
    assert!(result.pulled.is_empty(), "{:?}", result.pulled);
    assert_eq!(read_local(&root, "fig/Plot.png").as_deref(), Some(PLOT));
    assert_overleaf_untouched(&server, &result);
}
