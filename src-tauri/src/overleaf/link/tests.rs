use super::*;
use crate::overleaf::files::read_base_copy;
use crate::overleaf::test_support::*;

/// `last_sync` and conflict-copy stamps are written with chrono; both
/// must parse back into the instant they were taken.
#[test]
fn sync_timestamps_round_trip_through_chrono() {
    let before = chrono::Utc::now();
    let iso = now_iso();
    let stamp = crate::overleaf::sync::sync_stamp();
    let after = chrono::Utc::now();

    assert!(iso.ends_with('Z'), "{iso}");
    let parsed = chrono::DateTime::parse_from_rfc3339(&iso).unwrap().with_timezone(&chrono::Utc);
    assert_eq!(parsed.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), iso);
    assert!(parsed.timestamp() >= before.timestamp() && parsed.timestamp() <= after.timestamp());

    let local = chrono::NaiveDateTime::parse_from_str(&stamp, "%Y%m%d-%H%M").unwrap();
    assert_eq!(local.format("%Y%m%d-%H%M").to_string(), stamp);
    let minute = |t: chrono::DateTime<chrono::Utc>| {
        t.with_timezone(&chrono::Local).naive_local().format("%Y%m%d-%H%M").to_string()
    };
    assert!(stamp == minute(before) || stamp == minute(after), "{stamp}");
}

/// Pausing, and recording what the realtime channel learned, keep what a
/// resumed sync needs to merge.
///
/// The whole reason to pause rather than unlink: the file table is the
/// common ancestor, and without it reconnecting can only offer a conflict
/// copy of every file that differs.
#[test]
fn pausing_and_realtime_metadata_keep_the_link_and_its_common_ancestor() {
    let base = b"the copy from the last sync\n";
    let root = linked_root(&[], &[("main.tex", base)]);
    edit_state(&root, |state| state.remote_version = Some(42));
    let keeps_the_base = || {
        let state = load_state(&root).unwrap();
        assert_eq!(state.files.get("main.tex"), Some(&sha256_hex(base)));
        assert_eq!(state.remote_version, Some(42));
        let copy = read_base_copy(&root, "main.tex").map(String::into_bytes);
        assert_eq!(copy, Some(base.to_vec()));
    };

    set_paused(&root, true).unwrap();
    let link = project_link(&root).unwrap().expect("still linked");
    assert!(link.paused);
    assert_eq!(link.project_id, "proj-1");
    keeps_the_base();
    set_paused(&root, false).unwrap();
    assert!(!project_link(&root).unwrap().unwrap().paused);

    set_realtime_metadata(&root, "new-root-folder", "owner").unwrap();
    let state = load_state(&root).unwrap();
    assert_eq!(state.root_folder_id.as_deref(), Some("new-root-folder"));
    assert_eq!(state.permission.as_deref(), Some("owner"));
    keeps_the_base();
}

/// Stop syncing, edit, then open the project from Overleaf again.
///
/// Unlinking deletes the state file, so the folder is no longer
/// recognisable as that project; it must be offered for relinking, not
/// downloaded again into `Name (2)` with the edits stranded beside it. An
/// absent or empty folder is a plain download.
#[test]
fn a_folder_left_by_unlinking_is_offered_for_relinking_not_duplicated() {
    let (parent, config) = (TempDir::new("adopt"), signed_in("https://www.overleaf.com"));
    let root = parent.join("Attention Paper");
    let kind = |project_id: &str| clone_target(project_id, "Attention Paper", &parent).unwrap();
    assert_eq!(kind("proj-1").kind, "fresh");
    fs::create_dir_all(&root).unwrap();
    assert_eq!(kind("proj-1").kind, "fresh");
    fs::write(root.join("main.tex"), b"edited after unlinking\n").unwrap();

    // Files present, no link: the state Stop syncing leaves behind.
    let target = kind("proj-1");
    assert_eq!((target.kind.as_str(), target.folder.as_str()), ("occupied", "Attention Paper"));

    let adopted =
        adopt_project(&config, "proj-1", "Attention Paper", &root, Some("readAndWrite")).unwrap();
    assert_eq!(adopted, root);
    // The edit is untouched — adopting links, it does not download over it.
    assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "edited after unlinking\n");
    // No common ancestor is claimed, which is what makes the first sync
    // treat a file that differs as a conflict instead of picking a winner.
    let state = load_state(&root).unwrap();
    assert_eq!(state.project_id, "proj-1");
    assert!(state.files.is_empty());
    assert_eq!((state.remote_version, state.last_sync), (None, None));

    // Now that it is linked, opening it again just opens it; a different
    // project of the same name is still a separate folder.
    assert_eq!(kind("proj-1").kind, "open");
    assert_eq!(kind("proj-2").kind, "occupied");
}

#[test]
fn publishes_local_project_and_records_the_uploaded_snapshot_as_its_base() {
    let server = Mock::project(&[("main.tex", b"local body")]).serve();
    let (config, root) = (signed_in(&server.base), TempDir::new("publish-project"));
    for (rel, data) in [
        ("main.tex", "local body"),
        ("figures/plot.pdf", "%PDF figure"),
        ("main.pdf", "%PDF build output"),
        (".research/private.json", "secret"),
    ] {
        root.write(rel, data);
    }

    let link = publish_project(&config, &root, "Local Paper").unwrap();

    assert_eq!(link.project_id, "published-project-1");
    assert_eq!(link.project_name, "Local Paper");
    assert_eq!(link.host, server.base);
    let request = (server.recorded().into_iter())
        .find(|request| request.method == "POST" && request.url == "/project/new/upload")
        .expect("project upload request");
    assert_eq!(request.csrf_header.as_deref(), Some(CSRF));
    assert_eq!(request.cookie_header.as_deref(), Some("overleaf_session2=fixture-cookie"));
    let body = request.body_text();
    for expected in
        ["name=\"name\"", "Local Paper.zip", "name=\"qqfile\"", "main.tex", "figures/plot.pdf"]
    {
        assert!(body.contains(expected), "{expected}");
    }
    for leaked in ["main.pdf", "private.json", "secret"] {
        assert!(!body.contains(leaked), "{leaked}");
    }

    let state = load_state(&root).unwrap();
    assert_eq!(state.permission.as_deref(), Some("owner"));
    assert_eq!(state.files.len(), 2);
    assert_eq!(state.files.get("main.tex"), Some(&sha256_hex(b"local body")));
    assert_eq!(read_base_copy(&root, "main.tex").as_deref(), Some("local body"));
    assert!(read_base_copy(&root, "figures/plot.pdf").is_none());
}

#[test]
fn overleaf_clone_project_extracts_and_writes_state() {
    let server = Mock::project(&[
        ("main.tex", b"\\documentclass{article}"),
        ("refs.bib", b"@article{a}"),
        ("figures/fig1.pdf", b"%PDF-1.5 fake"),
        ("nested/chapter.tex", b"\\section{One}"),
        ("lambda_gpu_proposal.bbl-SAVE-ERROR", b"failed bibliography output"),
        ("tmp/pdfs/full-appendix/page-01.png", b"temporary preview"),
    ])
    .serve();
    let (config, parent) = (signed_in(&server.base), TempDir::new("clone-parent"));
    let clone = |project_id: &str, role| {
        clone_project(&config, project_id, "Test: Project", &parent, role).unwrap()
    };

    let root = clone("proj-1", Some("owner"));
    assert_eq!(root, parent.join("Test- Project"));
    for (rel, data) in [
        ("main.tex", &b"\\documentclass{article}"[..]),
        ("nested/chapter.tex", b"\\section{One}"),
        ("figures/fig1.pdf", b"%PDF-1.5 fake"),
    ] {
        assert_eq!(read_local(&root, rel).as_deref(), Some(data), "{rel}");
    }
    assert!(read_local(&root, "lambda_gpu_proposal.bbl-SAVE-ERROR").is_none());
    assert!(read_local(&root, "tmp/pdfs/full-appendix/page-01.png").is_none());

    let state = load_state(&root).unwrap();
    assert_eq!(
        (state.project_id.as_str(), state.project_name.as_str()),
        ("proj-1", "Test: Project")
    );
    assert_eq!((state.host, state.permission.as_deref()), (server.base.clone(), Some("owner")));
    assert_eq!(state.files.len(), 4);
    assert_eq!(state.files.get("refs.bib"), Some(&sha256_hex(b"@article{a}")));
    let link = project_link(&root).unwrap().unwrap();
    assert_eq!((link.project_id.as_str(), link.project_name.as_str()), ("proj-1", "Test: Project"));

    // Opening the same project again opens the copy that is already there,
    // rather than refusing and asking someone to go and find it; a role
    // nobody reported clears the stale writable one.
    assert_eq!(clone("proj-1", None), root);
    assert_eq!(load_state(&root).unwrap().permission, None);
    // A different project that happens to share a name lands beside it
    // instead of being blocked by it…
    let other = clone("proj-2", None);
    assert_ne!(other, root);
    assert_eq!(load_state(&other).unwrap().project_id, "proj-2");
    // …and opening *that* one again finds it under its numbered name.
    assert_eq!(clone("proj-2", None), other);
}

#[test]
fn overleaf_clone_project_rejects_zip_slip() {
    let server = Mock { zip: build_malicious_zip(), ..Default::default() }.serve();
    let (config, parent) = (signed_in(&server.base), TempDir::new("slip-parent"));
    let message = clone_project(&config, "proj-1", "Evil", &parent, None).unwrap_err();
    assert!(message.contains("unsafe path"), "got: {message}");
    assert!(!parent.join("evil.tex").exists());
    assert!(!parent.parent().unwrap().join("evil.tex").exists());
}

/// Opening a project that is already downloaded opens it — the commonest
/// thing anyone does in the Overleaf picker.
#[test]
#[ignore = "reads overleaf.com with the signed-in session"]
fn opening_an_already_downloaded_project_opens_it() {
    let (config, existing) = crate::overleaf_rt::tests::live_project();
    let state = load_state(&existing).expect("the project is linked");
    let parent = existing.parent().expect("a parent folder");
    let opened = clone_project(
        &config,
        &state.project_id,
        &state.project_name,
        parent,
        Some("readAndWrite"),
    )
    .expect("opening an already-downloaded project should succeed");
    assert_eq!(opened, existing, "it should be the copy already on disk");
}
