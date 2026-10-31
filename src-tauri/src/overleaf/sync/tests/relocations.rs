//! Local moves replayed on Overleaf by entity id before a content sync.

use super::*;
use crate::overleaf::link::record_relocation;
use crate::overleaf_rt::EntityEntry;
use serde_json::json;

fn entity(id: &str, path: &str, kind: &str) -> EntityEntry {
    EntityEntry { id: id.into(), path: path.into(), kind: kind.into() }
}

#[test]
fn moving_a_linked_file_is_not_a_remote_deletion() {
    let parent = TempDir::new("move-linked");
    let root = crate::project::create_blank(&parent, "paper").unwrap();
    fs::remove_file(root.join("references.bib")).unwrap();
    // The download reflects the remote tree after the move endpoint.
    let server = Mock::project(&[("chapters/main.tex", b"body")]).serve();
    let config = link_to(&server, &root, &[("main.tex", b"body")], &[("main.tex", b"body")]);
    fs::create_dir_all(root.join("chapters")).unwrap();
    crate::project::move_entry(&root, "main.tex", "chapters").unwrap();

    sync_relocations(&config, &root, Some(vec![entity("main-id", "main.tex", "doc")])).unwrap();
    let result = sync(&config, &root, NO_LIVE, None).unwrap();

    assert!(result.skipped_remote_deletes.is_empty(), "a move must not prompt to delete main.tex");
    assert!(!root.join("main.tex").exists());
    assert_eq!(read_local(&root, "chapters/main.tex").as_deref(), Some(b"body".as_slice()));
    assert_posts(
        &server,
        &[
            (
                "/project/proj-1/folder",
                json!({"name": "chapters", "parent_folder_id": "root-folder-1"}),
            ),
            ("/project/proj-1/doc/main-id/move", json!({"folder_id": "anchor-folder-1"})),
        ],
    );
    assert!(server.uploads().is_empty());
    assert!(server.with_method("DELETE").is_empty());
    assert!(load_state(&root).unwrap().pending_relocations.is_empty());
}

/// Every POST the mock received, in order, as `(url, JSON body)`.
fn assert_posts(server: &MockServer, expected: &[(&str, Value)]) {
    let posts: Vec<_> =
        (server.with_method("POST").iter()).map(|r| (r.url.clone(), r.json())).collect();
    let expected: Vec<_> =
        expected.iter().map(|(url, body)| (url.to_string(), body.clone())).collect();
    assert_eq!(posts, expected);
}

#[test]
fn relocation_keeps_folder_descendants_and_their_merge_ancestors() {
    let parent = TempDir::new("move-folder");
    let root = crate::project::create_blank(&parent, "paper").unwrap();
    let base = b"original heading\n\noriginal ending\n".as_slice();
    let local = b"local heading\n\noriginal ending\n".as_slice();
    let remote = b"original heading\n\nremote ending\n".as_slice();
    let server = Mock::project(&[]).serve();
    let files = |main: &'static [u8]| -> [(&'static str, &'static [u8]); 3] {
        [
            ("chapter/main.tex", main),
            ("chapter/plot.png", b"\0binary"),
            ("chapter-extra.tex", b"unrelated"),
        ]
    };
    let config = link_to(&server, &root, &files(local), &files(base));
    crate::project::rename_entry(&root, "chapter", "renamed").unwrap();
    fs::create_dir_all(root.join("archive")).unwrap();
    crate::project::move_entry(&root, "renamed", "archive").unwrap();

    let tree = vec![
        entity("folder-id", "chapter", "folder"),
        entity("main-id", "chapter/main.tex", "doc"),
        entity("plot-id", "chapter/plot.png", "file"),
        entity("archive-id", "archive", "folder"),
    ];
    sync_relocations(&config, &root, Some(tree)).unwrap();

    let state = load_state(&root).unwrap();
    assert_eq!(state.files["archive/renamed/main.tex"], sha256_hex(base));
    assert_eq!(state.files["archive/renamed/plot.png"], sha256_hex(b"\0binary"));
    assert!(state.files.contains_key("chapter-extra.tex"));
    assert!(!state.files.contains_key("chapter/main.tex"));
    assert_eq!(read_base_copy(&root, "archive/renamed/main.tex").unwrap().as_bytes(), base);
    let moved = "archive/renamed/main.tex".to_string();
    let (remote, local) =
        [remote, local].map(|bytes| BTreeMap::from([(moved.clone(), bytes.to_vec())])).into();
    let plan = plan_sync(&root, &state, &remote, &local, NO_LIVE, "stamp").unwrap();
    assert_eq!(plan.merge, vec![(moved, b"local heading\n\nremote ending\n".to_vec())]);
    assert!(plan.conflict.is_empty());
    assert_posts(
        &server,
        &[
            ("/project/proj-1/folder/folder-id/rename", json!({"name": "renamed"})),
            ("/project/proj-1/folder/folder-id/move", json!({"folder_id": "archive-id"})),
        ],
    );
}

#[test]
fn relocation_failure_blocks_content_sync_and_retry_recognizes_the_same_id() {
    let server = Mock { fail_relocation: true, ..Mock::project(&[]) }.serve();
    let (config, root) = linked(&server, &[("renamed.tex", b"edited")], &[("main.tex", b"base")]);
    record_relocation(&root, "main.tex", "renamed.tex").unwrap();
    let main = || Some(vec![entity("main-id", "main.tex", "doc")]);
    assert!(sync_relocations(&config, &root, None).is_err());
    assert!(sync_relocations(&config, &root, main()).is_err());
    let state = load_state(&root).unwrap();
    assert_eq!(state.pending_relocations[0].entity_id.as_deref(), Some("main-id"));
    let empty = BTreeMap::new();
    assert!(plan_sync(&root, &state, &empty, &empty, NO_LIVE, "stamp").is_err());

    // The server applied the rename but its response was lost. A fresh tree
    // proves completion by id, even if someone recreated the old path.
    let tree =
        vec![entity("main-id", "renamed.tex", "doc"), entity("different-id", "main.tex", "doc")];
    sync_relocations(&config, &root, Some(tree)).unwrap();
    assert!(load_state(&root).unwrap().pending_relocations.is_empty());
    assert_eq!(state_files(&root)["renamed.tex"], sha256_hex(b"base"));
    assert_eq!(server.with_method("POST").len(), 1);
    assert!(server.uploads().is_empty());
}

#[test]
fn relocation_never_overwrites_a_destination_or_writes_without_permission() {
    let server = Mock::project(&[]).serve();
    let (config, root) = linked(&server, &[], &[("main.tex", b"base")]);
    record_relocation(&root, "main.tex", "renamed.tex").unwrap();
    let taken =
        vec![entity("main-id", "main.tex", "doc"), entity("other-id", "renamed.tex", "doc")];
    assert!(sync_relocations(&config, &root, Some(taken)).is_err());
    for (permission, _, _) in
        crate::overleaf_rt::tests::ROLE_CASES.into_iter().filter(|(_, writable, _)| !writable)
    {
        edit_state(&root, |state| state.permission = permission.map(str::to_string));
        let main = vec![entity("main-id", "main.tex", "doc")];
        assert!(sync_relocations(&config, &root, Some(main)).is_err(), "{permission:?}");
        assert_eq!(load_state(&root).unwrap().pending_relocations.len(), 1);
    }
    assert!(server.recorded().iter().all(|r| r.method == "GET"));
}

#[test]
fn relocation_moves_binary_files_to_root_and_leaves_new_files_for_upload() {
    let server = Mock::project(&[]).serve();
    let (config, root) = linked(
        &server,
        &[("plot.png", b"\0binary"), ("new.tex", b"new")],
        &[("figures/plot.png", b"\0binary")],
    );
    record_relocation(&root, "figures/plot.png", "plot.png").unwrap();
    record_relocation(&root, "draft.tex", "new.tex").unwrap();
    let plot = vec![entity("plot-id", "figures/plot.png", "file")];
    sync_relocations(&config, &root, Some(plot)).unwrap();
    assert_eq!(state_files(&root)["plot.png"], sha256_hex(b"\0binary"));
    assert!(!state_files(&root).contains_key("new.tex"));
    assert!(load_state(&root).unwrap().pending_relocations.is_empty());
    let move_to_root = json!({"folder_id": "root-folder-1"});
    assert_posts(&server, &[("/project/proj-1/file/plot-id/move", move_to_root)]);
}

#[test]
fn relocation_record_failure_rolls_back_the_local_move_and_manifest() {
    let parent = TempDir::new("move-record-failure");
    let root = crate::project::create_blank(&parent, "paper").unwrap();
    let manifest = fs::read(root.join(".research/project.json")).unwrap();
    fs::write(state_path(&root), "invalid sync state").unwrap();
    fs::create_dir_all(root.join("chapters")).unwrap();
    assert!(crate::project::move_entry(&root, "main.tex", "chapters").is_err());
    assert!(root.join("main.tex").exists());
    assert!(!root.join("chapters/main.tex").exists());
    assert_eq!(fs::read(root.join(".research/project.json")).unwrap(), manifest);
}
