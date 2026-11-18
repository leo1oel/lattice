//! A project renamed on Overleaf (Leo, 2026-11-18: "overleaf里面把title改了，
//! 那lattice和overleaf的同步会失效"). The title is only what the app shows:
//! the link, every request and the folder go by the project id, so a rename
//! changes the stored title and nothing else.

use super::*;
use crate::overleaf::sync::sync;
use serde_json::json;
use std::collections::BTreeSet;

const NO_LIVE: &BTreeSet<String> = &BTreeSet::new();

const BASE: &[u8] = b"base body";
const THEIRS: &[u8] = b"body edited on Overleaf";
const MINE: &[u8] = b"body edited in Lattice";

/// A state file as a Lattice from before this fix wrote it, still holding the
/// title the project had when it was cloned.
fn link_as_an_older_lattice_did(root: &Path, host: &str) {
    fs::write(root.join("main.tex"), BASE).unwrap();
    write_base_copy(root, "main.tex", BASE).unwrap();
    let state = json!({
        "host": host,
        "projectId": "proj-1",
        "projectName": "Paper",
        "rootFolderId": "root-folder-1",
        "lastSync": "2026-07-01T00:00:00Z",
        "permission": "readAndWrite",
        "files": { "main.tex": sha256_hex(BASE) },
        "paused": false,
        "pendingRelocations": []
    });
    fs::write(state_path(root), serde_json::to_string_pretty(&state).unwrap()).unwrap();
}

#[test]
fn a_project_renamed_on_overleaf_still_pulls_and_pushes() {
    let mock = Mock { versions: vec![11], ..Mock::project(&[("main.tex", THEIRS)]) };
    let server = mock.serve();
    let config = signed_in(&server.base);
    let root = TempDir::new("Paper");
    fs::create_dir_all(root.join(".research")).unwrap();
    link_as_an_older_lattice_did(&root, &server.base);

    // The live channel's join names the project by its new title.
    set_realtime_metadata(&root, "root-folder-1", "readAndWrite", Some("Paper (camera ready)"))
        .unwrap();
    let link = project_link(&root).unwrap().unwrap();
    assert_eq!(
        (link.project_id.as_str(), link.project_name.as_str()),
        ("proj-1", "Paper (camera ready)")
    );

    // Pull: Overleaf's edit lands in the same folder.
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.pulled, ["main.tex"]);
    assert_eq!(read_local(&root, "main.tex").unwrap(), THEIRS);

    // Push: a local edit goes up to the same project.
    fs::write(root.join("main.tex"), MINE).unwrap();
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.pushed, ["main.tex"]);
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 1);
    assert!(uploads[0].url.starts_with("/project/proj-1/upload"), "{}", uploads[0].url);
    assert!(server.recorded().iter().all(|request| !request.url.contains("camera")));

    // The folder is never renamed or moved to follow the title.
    assert!(root.join("main.tex").is_file());
    assert_eq!(load_state(&root).unwrap().project_name, "Paper (camera ready)");
}

/// A join that names no title, or an empty one, keeps the stored title.
#[test]
fn a_join_without_a_title_keeps_the_stored_one() {
    let root = linked_root(&[("main.tex", BASE)], &[("main.tex", BASE)]);
    for title in [None, Some(""), Some("  ")] {
        set_realtime_metadata(&root, "root-folder-1", "readAndWrite", title).unwrap();
        assert_eq!(load_state(&root).unwrap().project_name, "Test Project");
    }
}
