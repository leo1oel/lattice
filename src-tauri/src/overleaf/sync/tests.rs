use super::*;
use crate::overleaf::link::{load_state, record_relocation, set_permission, state_path};
use crate::overleaf::test_support::*;

const NO_LIVE: &BTreeSet<String> = &BTreeSet::new();

fn entity(id: &str, path: &str, kind: &str) -> EntityEntry {
    EntityEntry { id: id.into(), path: path.into(), kind: kind.into() }
}

fn remote_version(root: &Path) -> Option<i64> {
    load_state(root).unwrap().remote_version
}

fn text(root: &Path, rel: &str) -> String {
    String::from_utf8(read_local(root, rel).unwrap()).unwrap()
}

// ---- classification ---------------------------------------------------------

#[test]
fn overleaf_sync_pulls_remote_changes_and_new_files() {
    let (base, same) = (b"old body".as_slice(), b"untouched".as_slice());
    let remote: Files = &[
        ("figures/fig2.pdf", b"%PDF new figure"),
        ("main.tex", b"new remote body"),
        ("notes.tex", same),
    ];
    let local: Files = &[("main.tex", base), ("notes.tex", same)];
    let (server, root, result) = run_sync(Mock::project(remote), local, local);
    assert_eq!(result.pulled, vec!["figures/fig2.pdf", "main.tex"]);
    assert!(result.pushed.is_empty() && result.conflicts.is_empty());
    for (rel, data) in remote {
        assert_eq!(read_local(&root, rel).as_deref(), Some(*data), "{rel}");
    }
    assert_eq!(state_files(&root)["main.tex"], sha256_hex(b"new remote body"));
    assert!(server.uploads().is_empty());
}

#[test]
fn overleaf_sync_pushes_local_edits_and_new_nested_files_from_the_project_root() {
    let base = b"shared body".as_slice();
    let local: Files =
        &[("main.tex", b"locally edited body"), ("nested/new-chapter.tex", b"\\section{New}")];
    let (server, root, result) =
        run_sync(Mock::project(&[("main.tex", base)]), local, &[("main.tex", base)]);
    assert_eq!(result.pushed, vec!["main.tex", "nested/new-chapter.tex"]);
    assert!(result.pulled.is_empty());

    // Uploading through the real root id requires no temporary folder, and
    // the relative path is project-relative and contains no traversal.
    assert!(server.recorded().iter().all(|r| r.url != "/project/proj-1/folder"));
    assert!(server.with_method("DELETE").is_empty());
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 2);
    for (upload, (rel, data)) in uploads.iter().zip(local) {
        assert!(upload.url.starts_with("/project/proj-1/upload"));
        // Root-level and nested files alike use the root id learned from
        // joinProject. Sending a temporary folder plus `../` is rejected by
        // current Overleaf Cloud as path traversal.
        assert!(upload.url.contains("folder_id=root-folder-1"));
        assert!(upload.url.contains(&format!("_csrf={CSRF}")));
        assert_eq!(upload.csrf_header.as_deref(), Some(CSRF));
        let body = upload.body_text();
        let file_name = rel.rsplit('/').next().unwrap();
        for expected in [
            format!("name=\"qqfile\"; filename=\"{file_name}\""),
            String::from_utf8_lossy(data).into_owned(),
            "name=\"relativePath\"".to_string(),
            format!("\r\n\r\n{rel}\r\n"),
        ] {
            assert!(body.contains(&expected), "{expected}");
        }
        assert!(!body.contains(&format!("../{rel}")));
        assert_eq!(state_files(&root)[*rel], sha256_hex(data));
    }
}

#[test]
fn overleaf_sync_leaves_live_documents_to_the_realtime_channel() {
    // Both sides differ, which would normally push or merge. The realtime
    // channel is already reconciling this file operation by operation, and a
    // REST upload would reach collaborators as an external overwrite.
    let base = b"shared body".as_slice();
    let server =
        Mock::project(&[("main.tex", b"remote body"), ("notes.tex", b"remote notes")]).serve();
    let (config, root) = linked(
        &server,
        &[("main.tex", b"local body"), ("notes.tex", base)],
        &[("main.tex", base), ("notes.tex", base)],
    );
    let live: BTreeSet<String> = ["main.tex".to_string()].into();
    let result = sync(&config, &root, &live, None).unwrap();

    assert!(result.pushed.is_empty() && result.merged.is_empty() && result.conflicts.is_empty());
    assert!(server.uploads().is_empty());
    // Untouched on disk: the editor buffer owns it while the channel is up.
    assert_eq!(read_local(&root, "main.tex").unwrap(), b"local body");
    // Its recorded base survives, so a later sync can still merge it.
    assert_eq!(state_files(&root)["main.tex"], sha256_hex(base));
    // Everything else syncs as usual.
    assert_eq!(result.pulled, vec!["notes.tex"]);
}

#[test]
fn overleaf_sync_conflict_keeps_the_local_copy_beside_the_marked_or_remote_file() {
    // Both sides rewrote the same line, so no merge can decide for us; a
    // figure cannot be merged line by line at all, so it keeps both.
    let remote: Files = &[("figures/fig.pdf", b"%PDF remote"), ("main.tex", b"remote edit")];
    let local: Files = &[("figures/fig.pdf", b"%PDF local"), ("main.tex", b"local edit")];
    let base: Files = &[("figures/fig.pdf", b"%PDF base"), ("main.tex", b"base body")];
    let (server, root, result) = run_sync(Mock::project(remote), local, base);
    let [figure, conflict] = &result.conflicts[..] else {
        panic!("expected two conflicts, got {:?}", result.conflicts);
    };
    assert_eq!(conflict.path, "main.tex");
    assert!(conflict.local_copy.starts_with("main (local conflict "));
    assert!(conflict.local_copy.ends_with(").tex"));
    // The file shows both versions where they disagree…
    let merged = text(&root, "main.tex");
    for expected in [CONFLICT_MARKER, "local edit", "remote edit"] {
        assert!(merged.contains(expected), "{expected}");
    }
    // …and the untouched local version survives beside it.
    assert_eq!(read_local(&root, &conflict.local_copy).unwrap(), b"local edit");
    // The figure: Overleaf's version takes the path, ours sits beside it.
    assert_eq!(read_local(&root, "figures/fig.pdf").unwrap(), b"%PDF remote");
    assert_eq!(read_local(&root, &figure.local_copy).unwrap(), b"%PDF local");
    // A figure has no spots to work through, so the app must not tell anyone
    // to resolve them or open a marker resolver on it.
    assert!(!figure.markers);
    // Conflicted files are never uploaded in the same round.
    assert!(server.uploads().is_empty());
    assert!(result.pushed.is_empty() && result.merged.is_empty());
}

const SECTIONS_BASE: &str = "\\section{One}\nalpha\n\n\\section{Two}\nbeta\n";
const SECTIONS_REMOTE: &str = "\\section{One}\nALPHA from Overleaf\n\n\\section{Two}\nbeta\n";
const SECTIONS_LOCAL: &str = "\\section{One}\nalpha\n\n\\section{Two}\nBETA edited locally\n";

#[test]
fn a_resolved_bibliography_conflict_uploads_exactly_the_kept_side() {
    // Overleaf emptied references.bib while Papers had appended entries
    // locally. The merge leaves diff3 markers (with the base section the
    // resolver must drop) and records Overleaf's side as the new base.
    let root = temp_dir("resolved-bib-conflict");
    let base = b"@misc{a,\n  title = {A},\n}\n".as_slice();
    let ours = b"@misc{a,\n  title = {A},\n}\n\n@misc{b,\n  title = {B},\n}\n".as_slice();
    let theirs = b"".as_slice();
    let host = "https://www.overleaf.com";
    seed_linked_project(&root, host, &[("references.bib", ours)], &[("references.bib", base)]);
    let state = load_state(&root).unwrap();
    let remote = BTreeMap::from([("references.bib".to_string(), theirs.to_vec())]);
    let plan = |state: &SyncState, local: &[u8]| {
        let local = BTreeMap::from([("references.bib".to_string(), local.to_vec())]);
        plan_sync(&root, state, &remote, &local, NO_LIVE, "test").unwrap()
    };
    let conflicted = plan(&state, ours);
    assert_eq!(conflicted.conflict.len(), 1);
    let markers = String::from_utf8(conflicted.conflict[0].resolved.clone()).unwrap();
    assert!(markers.contains("\n||||||| original\n"), "{markers}");
    assert_eq!(conflicted.files["references.bib"], sha256_hex(theirs));

    // What the next sync sees for each choice in the resolver.
    let after = SyncState { files: conflicted.files.clone(), ..state.clone() };
    write_base_copy(&root, "references.bib", theirs).unwrap();
    let kept_local = plan(&after, ours);
    assert_eq!(kept_local.push, vec!["references.bib"]);
    assert!(kept_local.pull.is_empty() && kept_local.conflict.is_empty());
    let kept_overleaf = plan(&after, theirs);
    assert!(kept_overleaf.push.is_empty());
    assert!(kept_overleaf.pull.is_empty() && kept_overleaf.conflict.is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn overleaf_sync_merges_edits_to_different_parts_of_one_file() {
    // A collaborator edits the top, you edit the bottom: no sidecar file.
    let (server, root, result) = run_sync(
        Mock::project(&[("main.tex", SECTIONS_REMOTE.as_bytes())]),
        &[("main.tex", SECTIONS_LOCAL.as_bytes())],
        &[("main.tex", SECTIONS_BASE.as_bytes())],
    );

    assert!(result.conflicts.is_empty());
    assert_eq!(result.merged, vec!["main.tex"]);
    let merged = text(&root, "main.tex");
    assert!(merged.contains("ALPHA from Overleaf") && merged.contains("BETA edited locally"));
    assert!(!merged.contains(CONFLICT_MARKER));

    // Overleaf only had their half, so the combined file goes back up.
    assert_eq!(result.pushed, vec!["main.tex"]);
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 1);
    let body = uploads[0].body_text();
    assert!(body.contains("ALPHA from Overleaf") && body.contains("BETA edited locally"));

    // Both sides now agree, and that agreement is the next merge base.
    assert_eq!(state_files(&root)["main.tex"], sha256_hex(merged.as_bytes()));
    assert_eq!(read_base_copy(&root, "main.tex").unwrap(), merged);
}

#[test]
fn overleaf_sync_uploads_only_while_overleaf_holds_still() {
    // Someone typed in the Overleaf editor between our snapshot (the first
    // history read) and our upload (the second). Uploading would replace
    // their words, so nothing goes up and the file stays marked as a local
    // edit for the next round; an unchanged version must not block it.
    let base = b"base body".as_slice();
    for (versions, uploaded) in [(vec![11, 12], false), (vec![11], true)] {
        let mock = Mock { versions, ..Mock::project(&[("main.tex", base)]) };
        let (server, root, result) =
            run_sync(mock, &[("main.tex", b"locally edited")], &[("main.tex", base)]);
        let expected: &[&str] = if uploaded { &["main.tex"] } else { &[] };
        assert_eq!(result.pushed, expected);
        assert_eq!(server.uploads().len(), expected.len());
        assert_eq!(read_local(&root, "main.tex").unwrap(), b"locally edited");
        let recorded = state_files(&root).get("main.tex").cloned();
        // Dropped from state when standing down, so the very next sync
        // re-detects the local edit and sends it merged with theirs.
        assert_eq!(recorded, uploaded.then(|| sha256_hex(b"locally edited")));
    }
}

#[test]
fn overleaf_sync_keeps_a_version_when_the_history_recheck_fails() {
    // This mock answers 404 for /updates while the project download
    // succeeds, matching an intermittent best-effort history failure during
    // an otherwise successful sync.
    let base: Files = &[("main.tex", b"shared body")];
    let server = Mock::project(base).serve();
    let (config, root) = linked(&server, base, base);
    edit_state(&root, |state| state.remote_version = Some(42));

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.pulled.is_empty() && result.pushed.is_empty());
    assert_eq!(remote_version(&root), Some(42));

    // A successful probe made immediately before the sync is stronger
    // evidence than the older saved value and becomes the new baseline.
    sync(&config, &root, NO_LIVE, Some(43)).unwrap();
    assert_eq!(remote_version(&root), Some(43));
}

#[test]
fn overleaf_sync_records_the_downloaded_snapshot_not_a_later_remote_version() {
    // The zip contains version 11. A collaborator reaches version 12 while
    // this pull-only sync is finishing. Recording 12 would make the next
    // probe say the stale local copy is current.
    let (base, remote) = (b"old body".as_slice(), b"version eleven".as_slice());
    let server = Mock { versions: vec![11, 12], ..Mock::project(&[("main.tex", remote)]) }.serve();
    let (config, root) = linked(&server, &[("main.tex", base)], &[("main.tex", base)]);

    let result = sync(&config, &root, NO_LIVE, None).unwrap();

    assert_eq!(result.pulled, vec!["main.tex"]);
    assert_eq!(read_local(&root, "main.tex").unwrap(), remote);
    assert_eq!(remote_version(&root), Some(11));
    let next = probe(&config, &root, None).unwrap();
    assert!(next.changed);
    assert_eq!(next.remote_version, Some(12));
}

#[test]
fn overleaf_sync_leaves_an_uploaded_version_unverified() {
    // The first two reads prove the remote stayed at 11 until upload. The
    // server does not tell us which history version belongs to that upload,
    // so a later 12 must be verified rather than silently claimed.
    let base = b"base body".as_slice();
    let server =
        Mock { versions: vec![11, 11, 12], ..Mock::project(&[("main.tex", base)]) }.serve();
    let (config, root) = linked(&server, &[("main.tex", b"locally edited")], &[("main.tex", base)]);

    let result = sync(&config, &root, NO_LIVE, None).unwrap();

    assert_eq!(result.pushed, vec!["main.tex"]);
    assert_eq!(remote_version(&root), None);
    let next = probe(&config, &root, None).unwrap();
    assert!(next.changed);
    assert_eq!(next.remote_version, Some(12));
}

#[test]
fn overleaf_sync_does_not_commit_local_state_after_a_partial_upload_failure() {
    // Overleaf's file API is not transactional: the first upload may have
    // succeeded before a later one fails. In that case the local sync state
    // must remain at the old common ancestor. Claiming the edited hashes
    // here would hide the ambiguous partial remote result on the next run.
    let base: Files = &[("a.tex", b"base a"), ("b.tex", b"base b")];
    let local: Files = &[("a.tex", b"edited a"), ("b.tex", b"edited b")];
    let server =
        Mock { versions: vec![11], fail_upload_at: Some(2), ..Mock::project(base) }.serve();
    let (config, root) = linked(&server, local, base);

    assert!(sync(&config, &root, NO_LIVE, None).is_err());
    assert_eq!(server.uploads().len(), 2);
    let files = state_files(&root);
    for ((rel, edited), (_, original)) in local.iter().zip(base) {
        assert_eq!(read_local(&root, rel).as_deref(), Some(*edited), "{rel}");
        assert_eq!(read_base_copy(&root, rel).as_deref().map(str::as_bytes), Some(*original));
        assert_eq!(files.get(*rel), Some(&sha256_hex(original)), "{rel}");
    }
}

#[test]
fn overleaf_sync_never_uploads_unresolved_conflict_markers() {
    // A file still carrying markers must not be published to collaborators.
    let base = "alpha\n";
    let local = format!("{CONFLICT_MARKER} ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
    let (server, root, result) = run_sync(
        Mock::project(&[("main.tex", base.as_bytes())]),
        &[("main.tex", local.as_bytes())],
        &[("main.tex", base.as_bytes())],
    );
    assert!(result.pushed.is_empty());
    assert!(server.uploads().is_empty());
    // Left out of state, so it uploads as soon as the markers are gone.
    assert!(!state_files(&root).contains_key("main.tex"));
    assert_eq!(read_local(&root, "main.tex").unwrap(), local.as_bytes());
}

#[test]
fn overleaf_sync_resolves_deletions_made_on_one_side() {
    // old.tex: deleted on Overleaf, untouched here, so it goes here too.
    // edited.tex: deleted on Overleaf after an edit here, so it goes back up.
    // dropped.tex: deleted here, untouched on Overleaf. We never delete
    // remote files, but it is not downloaded again either: dropping it from
    // state is what stops it resurrecting.
    let remote: Files = &[("dropped.tex", b"still on overleaf"), ("main.tex", b"body")];
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
    ];
    let (server, root, result) = run_sync(Mock::project(remote), local, base);
    assert_eq!(result.deleted_local, vec!["old.tex"]);
    assert_eq!(result.pushed, vec!["edited.tex"]);
    assert_eq!(result.skipped_remote_deletes, vec!["dropped.tex"]);
    let files = state_files(&root);
    for gone in ["old.tex", "dropped.tex"] {
        assert!(read_local(&root, gone).is_none(), "{gone}");
        assert!(!files.contains_key(gone), "{gone}");
    }
    assert_eq!(read_local(&root, "edited.tex").unwrap(), b"edited after remote delete");
    assert!(files.contains_key("edited.tex"));
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 1);
    assert!(uploads[0].body_text().contains("edited after remote delete"));
    assert!(server.with_method("DELETE").is_empty());
}

#[test]
fn overleaf_sync_never_uploads_excluded_files() {
    let base = b"body".as_slice();
    let (server, root, result) = run_sync(
        Mock::project(&[("main.tex", base)]),
        &[
            ("main.tex", base),
            ("main.log", b"latexmk noise"),
            (".DS_Store", b"finder noise"),
            ("main.pdf", b"%PDF compiled output"),
            ("main.synctex.gz", b"synctex"),
            ("tmp/pdfs/full-appendix/render-1.png", b"temporary preview"),
        ],
        &[("main.tex", base)],
    );
    assert!(result.pushed.is_empty() && result.pulled.is_empty());
    assert!(server.uploads().is_empty());
    assert_eq!(state_files(&root).keys().collect::<Vec<_>>(), vec!["main.tex"]);
    // Excluded files stay untouched on disk.
    for rel in ["main.log", "main.pdf", "tmp/pdfs/full-appendix/render-1.png"] {
        assert!(read_local(&root, rel).is_some(), "{rel}");
    }
}

#[test]
fn overleaf_sync_requests_silent_cleanup_for_legacy_transient_files() {
    let (save_error, page) =
        ("lambda_gpu_proposal.bbl-SAVE-ERROR", "tmp/pdfs/full-appendix/page-01.png");
    let (body, preview) = (b"body".as_slice(), b"temporary preview".as_slice());
    let remote: Files = &[
        (save_error, b"failed bibliography output"),
        ("main.tex", body),
        (page, preview),
        ("tmp/pdfs/gallery-page-10.png", preview),
    ];
    let (_, root, result) = run_sync(Mock::project(remote), &[("main.tex", body)], &remote[..3]);

    assert_eq!(result.automatic_remote_deletes, vec![save_error, "tmp/pdfs"]);
    assert!(result.skipped_remote_deletes.is_empty());
    assert!(result.pulled.is_empty() && result.pushed.is_empty());
    assert!(read_local(&root, save_error).is_none());
    assert!(read_local(&root, page).is_none());
    assert!(!state_files(&root).keys().any(|path| path.starts_with("tmp/pdfs/")));
}

// ---- permissions ----------------------------------------------------------------

#[test]
fn overleaf_sync_never_uploads_without_a_writable_role() {
    // Incoming work still lands; only the upload half stands down. Trying
    // anyway would be rejected file by file and read as a broken sync. A role
    // nobody recorded fails closed the same way.
    let base = b"shared body".as_slice();
    for permission in [Some("readOnly"), None] {
        // Untouched over there, so the local edit is a pure upload candidate
        // rather than something to merge.
        let server =
            Mock::project(&[("main.tex", base), ("notes.tex", b"new remote notes")]).serve();
        let (config, root) = linked(
            &server,
            &[("main.tex", b"local body"), ("notes.tex", base)],
            &[("main.tex", base), ("notes.tex", base)],
        );
        edit_state(&root, |state| state.permission = permission.map(str::to_string));

        let result = sync(&config, &root, NO_LIVE, None).unwrap();
        assert!(result.read_only && result.pushed.is_empty(), "{permission:?}");
        assert!(server.uploads().is_empty());
        assert_eq!(result.pulled, vec!["notes.tex"]);
        // The local edit is still here, and still counts as unsent.
        assert_eq!(read_local(&root, "main.tex").unwrap(), b"local body");
        assert!(!state_files(&root).contains_key("main.tex"));

        // A reviewer may comment but not change the text, so the same
        // applies; an account that can write is unaffected.
        for (permission, read_only) in [("review", true), ("readAndWrite", false)] {
            set_permission(&root, permission).unwrap();
            assert_eq!(sync(&config, &root, NO_LIVE, None).unwrap().read_only, read_only);
        }
    }
}

#[test]
fn read_only_pull_refreshes_the_base_before_write_access_returns() {
    let original = b"alpha\nshared middle\nbeta\n".as_slice();
    let first_remote = b"alpha from Overleaf\nshared middle\nbeta\n".as_slice();
    let first_server = Mock::project(&[("main.tex", first_remote)]).serve();
    let (config, root) =
        linked(&first_server, &[("main.tex", original)], &[("main.tex", original)]);
    edit_state(&root, |state| state.permission = None);

    assert!(sync(&config, &root, NO_LIVE, None).unwrap().read_only);
    assert_eq!(read_base_copy(&root, "main.tex").as_deref().map(str::as_bytes), Some(first_remote));

    // Once write access returns, edits to different lines must merge against
    // the pulled snapshot, not the stale pre-permission base.
    fs::write(disk_path(&root, "main.tex"), b"alpha from Overleaf\nshared middle\nbeta locally\n")
        .unwrap();
    let second_server =
        Mock::project(&[("main.tex", b"alpha revised remotely\nshared middle\nbeta\n")]).serve();
    // The second mock server represents the same Overleaf deployment at a new
    // test address, so move the synthetic session with the link.
    edit_state(&root, |state| {
        state.host = second_server.base.clone();
        state.permission = Some("readAndWrite".to_string());
    });
    write_session_file(&config, &second_server.base);

    let merged = sync(&config, &root, NO_LIVE, None).unwrap();

    assert_eq!(merged.merged, vec!["main.tex"]);
    assert!(merged.conflicts.is_empty());
    assert_eq!(text(&root, "main.tex"), "alpha revised remotely\nshared middle\nbeta locally\n");
    assert_eq!(second_server.uploads().len(), 1);
}

#[test]
fn base_copy_finalization_uses_the_hash_agreement_and_retains_held_ancestors() {
    let root = temp_dir("base-finalization");
    let conflicted = format!("{CONFLICT_MARKER} local\n=======\nremote\n>>>>>>> remote\n");
    let hashes = |entries: &[(&str, &str)]| -> BTreeMap<String, String> {
        entries.iter().map(|(rel, text)| (rel.to_string(), sha256_hex(text.as_bytes()))).collect()
    };
    // (path, on disk, previous base, Overleaf's copy — the base it must end on)
    let files = [
        ("pulled.tex", "new remote", "old", "new remote"),
        ("conflict.tex", conflicted.as_str(), "old", "remote side"),
        ("held.tex", "local edit", "old ancestor", "old ancestor"),
    ];
    for (rel, disk, base, _) in files {
        fs::write(disk_path(&root, rel), disk).unwrap();
        write_base_copy(&root, rel, base.as_bytes()).unwrap();
    }
    let previous = hashes(&files.map(|(rel, _, base, _)| (rel, base)));
    // The held local edit has no agreed hash, so the next table leaves it out.
    let next = hashes(&[("pulled.tex", "new remote"), ("conflict.tex", "remote side")]);
    let remote = files.iter().map(|(rel, _, _, copy)| (rel.to_string(), copy.as_bytes().to_vec()));

    finalize_base_copies(&root, &previous, &next, &remote.collect()).unwrap();

    for (rel, _, _, copy) in files {
        assert_eq!(read_base_copy(&root, rel).as_deref(), Some(copy), "{rel}");
    }
}

// ---- preview (dry run) ------------------------------------------------------------

#[test]
fn overleaf_preview_reports_incoming_and_outgoing_without_touching_anything() {
    let base = b"old body".as_slice();
    let server = Mock::project(&[("main.tex", b"new remote body"), ("notes.tex", base)]).serve();
    let (config, root) = linked(
        &server,
        &[("main.tex", base), ("notes.tex", b"locally edited body")],
        &[("main.tex", base), ("notes.tex", base)],
    );
    let state_before = fs::read(state_path(&root)).unwrap();

    let preview = preview(&config, &root, NO_LIVE).unwrap();

    let rows: Vec<_> = (preview.changes.iter())
        .map(|c| {
            (c.path.as_str(), c.kind.as_str(), c.before.as_deref(), c.after.as_deref(), c.binary)
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("main.tex", "incoming", Some("old body"), Some("new remote body"), false),
            // "Before" is what Overleaf last saw, which is the recorded base copy.
            ("notes.tex", "outgoing", Some("old body"), Some("locally edited body"), false),
        ]
    );
    // A dry run leaves the project exactly as it found it…
    assert_eq!(read_local(&root, "main.tex").unwrap(), base);
    assert_eq!(read_local(&root, "notes.tex").unwrap(), b"locally edited body");
    assert_eq!(fs::read(state_path(&root)).unwrap(), state_before);
    assert_eq!(read_base_copy(&root, "main.tex").unwrap(), "old body");
    // …and never speaks to Overleaf beyond reading.
    assert!(server.uploads().is_empty());
    assert!(server.recorded().iter().all(|r| r.method == "GET" || r.method == "HEAD"));
}

#[test]
fn overleaf_preview_reports_merge_and_conflict_and_marks_binary_files() {
    let pdf = |side: &str| format!("%PDF-1.5\0{side}").into_bytes();
    let (remote_pdf, local_pdf, base_pdf) = (pdf("remote"), pdf("local"), pdf("base"));
    let server = Mock::project(&[
        ("figures/fig.pdf", &remote_pdf),
        ("main.tex", SECTIONS_REMOTE.as_bytes()),
        ("notes.tex", b"remote edit"),
    ])
    .serve();
    let (config, root) = linked(
        &server,
        &[
            ("figures/fig.pdf", &local_pdf),
            ("main.tex", SECTIONS_LOCAL.as_bytes()),
            ("notes.tex", b"local edit"),
        ],
        &[
            ("figures/fig.pdf", &base_pdf),
            ("main.tex", SECTIONS_BASE.as_bytes()),
            ("notes.tex", b"base body"),
        ],
    );
    let preview = preview(&config, &root, NO_LIVE).unwrap();

    // Conflicts sort first: they are the rows that need a decision.
    let rows: Vec<(&str, &str)> =
        preview.changes.iter().map(|c| (c.kind.as_str(), c.path.as_str())).collect();
    let expected =
        [("conflict", "figures/fig.pdf"), ("conflict", "notes.tex"), ("merge", "main.tex")];
    assert_eq!(rows, expected);

    // Figures cannot be shown as text, so the UI gets a marker, not bytes.
    let [figure, conflict, merge] = &preview.changes[..] else { unreachable!() };
    assert!(figure.binary && figure.before.is_none() && figure.after.is_none());

    assert_eq!(merge.before.as_deref(), Some(SECTIONS_LOCAL));
    let merged = merge.after.clone().unwrap();
    assert!(merged.contains("ALPHA from Overleaf") && merged.contains("BETA edited locally"));
    assert!(!merged.contains(CONFLICT_MARKER));

    assert_eq!(conflict.before.as_deref(), Some("local edit"));
    let marked = conflict.after.clone().unwrap();
    for expected in [CONFLICT_MARKER, "local edit", "remote edit"] {
        assert!(marked.contains(expected), "{expected}");
    }

    // Still a dry run: nothing merged onto disk, no sidecar, no upload.
    assert_eq!(read_local(&root, "main.tex").unwrap(), SECTIONS_LOCAL.as_bytes());
    assert_eq!(read_local(&root, "notes.tex").unwrap(), b"local edit");
    assert!(server.uploads().is_empty());
}

// ---- relocations -------------------------------------------------------------------

#[test]
fn moving_a_linked_file_is_not_a_remote_deletion() {
    let parent = temp_dir("move-linked");
    let root = crate::project::create_blank(&parent, "paper").unwrap();
    fs::remove_file(root.join("references.bib")).unwrap();
    // The download reflects the remote tree after the move endpoint.
    let server = Mock::project(&[("chapters/main.tex", b"body")]).serve();
    let config = temp_dir("move-config");
    write_session_file(&config, &server.base);
    seed_linked_project(&root, &server.base, &[("main.tex", b"body")], &[("main.tex", b"body")]);
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
    let parent = temp_dir("move-folder");
    let root = crate::project::create_blank(&parent, "paper").unwrap();
    let base = b"original heading\n\noriginal ending\n".as_slice();
    let local = b"local heading\n\noriginal ending\n".as_slice();
    let remote = b"original heading\n\nremote ending\n".as_slice();
    let server = Mock::project(&[]).serve();
    let config = temp_dir("move-folder-config");
    write_session_file(&config, &server.base);
    let files = |main: &'static [u8]| -> [(&'static str, &'static [u8]); 3] {
        [
            ("chapter/main.tex", main),
            ("chapter/plot.png", b"\0binary"),
            ("chapter-extra.tex", b"unrelated"),
        ]
    };
    seed_linked_project(&root, &server.base, &files(local), &files(base));
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
    edit_state(&root, |state| state.permission = Some("readOnly".into()));
    let main = vec![entity("main-id", "main.tex", "doc")];
    assert!(sync_relocations(&config, &root, Some(main)).is_err());
    assert_eq!(load_state(&root).unwrap().pending_relocations.len(), 1);
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
    let parent = temp_dir("move-record-failure");
    let root = crate::project::create_blank(&parent, "paper").unwrap();
    let manifest = fs::read(root.join(".research/project.json")).unwrap();
    fs::write(state_path(&root), "invalid sync state").unwrap();
    fs::create_dir_all(root.join("chapters")).unwrap();
    assert!(crate::project::move_entry(&root, "main.tex", "chapters").is_err());
    assert!(root.join("main.tex").exists());
    assert!(!root.join("chapters/main.tex").exists());
    assert_eq!(fs::read(root.join(".research/project.json")).unwrap(), manifest);
}
