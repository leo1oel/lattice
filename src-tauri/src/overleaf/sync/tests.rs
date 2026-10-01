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

// ---- classification and preview (dry run) ----------------------------------

#[test]
fn overleaf_preview_reports_exactly_what_sync_then_does() {
    // Incoming: fig2.pdf is new on Overleaf and incoming.tex changed there.
    // Outgoing: new-chapter.tex is new here and outgoing.tex changed here.
    // Merge: a collaborator edits the top of main.tex, you edit the bottom.
    // Conflict: both sides rewrote the same line of notes.tex, so no merge
    // can decide for us; a figure cannot be merged line by line at all.
    // Live: live.tex differs on both sides too, which would normally push or
    // merge, but the realtime channel is already reconciling it operation by
    // operation, and a REST upload would reach collaborators as an external
    // overwrite.
    let sections =
        |one: &str, two: &str| format!("\\section{{One}}\n{one}\n\n\\section{{Two}}\n{two}\n");
    let (base_main, remote_main) =
        (sections("alpha", "beta"), sections("ALPHA from Overleaf", "beta"));
    let local_main = sections("alpha", "BETA edited locally");
    let merged = sections("ALPHA from Overleaf", "BETA edited locally");
    let remote: Files = &[
        ("figures/fig.pdf", b"%PDF-1.5\0remote"),
        ("figures/fig2.pdf", b"%PDF new figure"),
        ("incoming.tex", b"new remote body"),
        ("live.tex", b"remote body"),
        ("main.tex", remote_main.as_bytes()),
        ("notes.tex", b"remote edit"),
        ("outgoing.tex", b"old body"),
    ];
    let local: Files = &[
        ("figures/fig.pdf", b"%PDF-1.5\0local"),
        ("incoming.tex", b"old body"),
        ("live.tex", b"local body"),
        ("main.tex", local_main.as_bytes()),
        ("nested/new-chapter.tex", b"\\section{New}"),
        ("notes.tex", b"local edit"),
        ("outgoing.tex", b"locally edited body"),
    ];
    let base: Files = &[
        ("figures/fig.pdf", b"%PDF-1.5\0base"),
        ("incoming.tex", b"old body"),
        ("live.tex", b"shared body"),
        ("main.tex", base_main.as_bytes()),
        ("notes.tex", b"base body"),
        ("outgoing.tex", b"old body"),
    ];
    let server = Mock::project(remote).serve();
    let (config, root) = linked(&server, local, base);
    let state_before = fs::read(state_path(&root)).unwrap();
    let live: BTreeSet<String> = ["live.tex".to_string()].into();

    let preview = preview(&config, &root, &live).unwrap();

    // Conflicts sort first: they are the rows that need a decision. Figures
    // cannot be shown as text, so the UI gets a marker, not bytes.
    let rows: Vec<_> = (preview.changes.iter())
        .map(|c| (c.kind.as_str(), c.path.as_str(), c.before.as_deref(), c.binary))
        .collect();
    assert_eq!(
        rows,
        [
            ("conflict", "figures/fig.pdf", None, true),
            ("conflict", "notes.tex", Some("local edit"), false),
            ("incoming", "figures/fig2.pdf", None, false),
            ("incoming", "incoming.tex", Some("old body"), false),
            ("merge", "main.tex", Some(local_main.as_str()), false),
            ("outgoing", "nested/new-chapter.tex", None, false),
            // "Before" is what Overleaf last saw, which is the recorded base copy.
            ("outgoing", "outgoing.tex", Some("old body"), false),
        ]
    );
    assert!(preview.changes[0].after.is_none());
    for expected in [CONFLICT_MARKER, "local edit", "remote edit"] {
        assert!(preview.changes[1].after.as_ref().unwrap().contains(expected), "{expected}");
    }
    assert_eq!(preview.changes[4].after.as_deref(), Some(merged.as_str()));
    // A dry run leaves the project exactly as it found it, and never speaks
    // to Overleaf beyond reading.
    for (rel, data) in local {
        assert_eq!(read_local(&root, rel).as_deref(), Some(*data), "{rel}");
    }
    assert_eq!(fs::read(state_path(&root)).unwrap(), state_before);
    assert_eq!(read_base_copy(&root, "incoming.tex").unwrap(), "old body");
    assert!(server.recorded().iter().all(|r| r.method == "GET" || r.method == "HEAD"));

    // What was previewed is exactly what the sync then writes.
    let result = sync(&config, &root, &live, None).unwrap();
    for change in preview.changes.iter().filter(|change| !change.binary) {
        assert_eq!(Some(text(&root, &change.path)), change.after, "{}", change.path);
    }
    assert_eq!(result.pulled, vec!["figures/fig2.pdf", "incoming.tex"]);
    assert_eq!(state_files(&root)["incoming.tex"], sha256_hex(b"new remote body"));
    assert_eq!(result.merged, vec!["main.tex"]);
    let [figure, conflict] = &result.conflicts[..] else {
        panic!("expected two conflicts, got {:?}", result.conflicts);
    };
    assert_eq!(conflict.path, "notes.tex");
    assert!(conflict.local_copy.starts_with("notes (local conflict "));
    assert!(conflict.local_copy.ends_with(").tex"));
    // The untouched local version survives beside the marked file.
    assert_eq!(read_local(&root, &conflict.local_copy).unwrap(), b"local edit");
    // The figure: Overleaf's version takes the path, ours sits beside it.
    assert_eq!(read_local(&root, "figures/fig.pdf").unwrap(), b"%PDF-1.5\0remote");
    assert_eq!(read_local(&root, &figure.local_copy).unwrap(), b"%PDF-1.5\0local");
    // A figure has no spots to work through, so the app must not tell anyone
    // to resolve them or open a marker resolver on it.
    assert!(!figure.markers);
    // The live document is untouched on disk, since the editor buffer owns it
    // while the channel is up, and its recorded base survives, so a later
    // sync can still merge it.
    assert_eq!(text(&root, "live.tex"), "local body");
    assert_eq!(state_files(&root)["live.tex"], sha256_hex(b"shared body"));

    // Overleaf only had their half of main.tex, so the combined file goes
    // back up; conflicted files are never uploaded in the same round.
    assert_eq!(result.pushed, vec!["main.tex", "nested/new-chapter.tex", "outgoing.tex"]);
    // Uploading through the real root id requires no temporary folder, and
    // the relative path is project-relative and contains no traversal.
    assert!(server.recorded().iter().all(|r| r.url != "/project/proj-1/folder"));
    assert!(server.with_method("DELETE").is_empty());
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 3);
    for (upload, rel) in uploads.iter().zip(&result.pushed) {
        assert!(upload.url.starts_with("/project/proj-1/upload"));
        // Root-level and nested files alike use the root id learned from
        // joinProject. Sending a temporary folder plus `../` is rejected by
        // current Overleaf Cloud as path traversal.
        assert!(upload.url.contains("folder_id=root-folder-1"));
        assert!(upload.url.contains(&format!("_csrf={CSRF}")));
        assert_eq!(upload.csrf_header.as_deref(), Some(CSRF));
        let (body, data) = (upload.body_text(), text(&root, rel));
        let file_name = rel.rsplit('/').next().unwrap();
        for expected in [
            format!("name=\"qqfile\"; filename=\"{file_name}\""),
            data.clone(),
            "name=\"relativePath\"".to_string(),
            format!("\r\n\r\n{rel}\r\n"),
        ] {
            assert!(body.contains(&expected), "{expected}");
        }
        assert!(!body.contains(&format!("../{rel}")));
        // Both sides now agree, and that agreement is the next merge base.
        assert_eq!(state_files(&root)[rel], sha256_hex(data.as_bytes()));
    }
    assert_eq!(read_base_copy(&root, "main.tex").unwrap(), merged);
}

#[test]
fn a_resolved_bibliography_conflict_uploads_exactly_the_kept_side() {
    // Overleaf emptied references.bib while Papers had appended entries
    // locally. The merge leaves diff3 markers (with the base section the
    // resolver must drop) and records Overleaf's side as the new base.
    let base = b"@misc{a,\n  title = {A},\n}\n".as_slice();
    let ours = b"@misc{a,\n  title = {A},\n}\n\n@misc{b,\n  title = {B},\n}\n".as_slice();
    let theirs = b"".as_slice();
    let root = linked_root(&[("references.bib", ours)], &[("references.bib", base)]);
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
fn overleaf_sync_records_only_a_remote_version_that_precedes_its_snapshot() {
    // - "recheck fails": /updates answers 404 while the download succeeds, an
    //   intermittent best-effort history failure; the saved 42 survives, but a
    //   successful probe made immediately before the sync is stronger evidence
    //   and becomes the new baseline.
    // - "pull": the zip contains version 11 and a collaborator reaches 12
    //   while the sync is finishing. Recording 12 would make the next probe
    //   say the stale local copy is current.
    // - "push": the first two reads prove the remote stayed at 11 until
    //   upload, but the server does not say which version belongs to that
    //   upload, so a later 12 must be verified rather than silently claimed.
    let (base, edited) = (b"base body".as_slice(), b"edited".as_slice());
    for (label, versions, remote, local, observed, recorded, moved, next) in [
        ("recheck fails", vec![], base, base, None, Some(42), (0, 0), None),
        ("recheck fails after a probe", vec![], base, base, Some(43), Some(43), (0, 0), None),
        ("pull", vec![11, 12], edited, base, None, Some(11), (1, 0), Some(12)),
        ("push", vec![11, 11, 12], base, edited, None, None, (0, 1), Some(12)),
    ] {
        let server = Mock { versions, ..Mock::project(&[("main.tex", remote)]) }.serve();
        let (config, root) = linked(&server, &[("main.tex", local)], &[("main.tex", base)]);
        edit_state(&root, |state| state.remote_version = Some(42));
        let result = sync(&config, &root, NO_LIVE, observed).unwrap();
        assert_eq!((result.pulled.len(), result.pushed.len()), moved, "{label}");
        assert_eq!(remote_version(&root), recorded, "{label}");
        if let Some(next) = next {
            let probed = probe(&config, &root, None).unwrap();
            assert_eq!((probed.changed, probed.remote_version), (true, Some(next)), "{label}");
        }
    }
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
fn overleaf_sync_never_uploads_excluded_files_or_unresolved_conflict_markers() {
    // A file still carrying markers must not be published to collaborators.
    let marked = format!("{CONFLICT_MARKER} ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
    let base: Files = &[("main.tex", b"body"), ("notes.tex", b"alpha\n")];
    let (server, root, result) = run_sync(
        Mock::project(base),
        &[
            ("main.tex", b"body"),
            ("notes.tex", marked.as_bytes()),
            ("main.log", b"latexmk noise"),
            (".DS_Store", b"finder noise"),
            ("main.pdf", b"%PDF compiled output"),
            ("main.synctex.gz", b"synctex"),
            ("tmp/pdfs/full-appendix/render-1.png", b"temporary preview"),
        ],
        base,
    );
    assert!(result.pushed.is_empty() && result.pulled.is_empty());
    assert!(server.uploads().is_empty());
    // Excluded files never enter state, and the marked file is left out so
    // it uploads as soon as the markers are gone.
    assert_eq!(state_files(&root).keys().collect::<Vec<_>>(), vec!["main.tex"]);
    // Both stay untouched on disk.
    assert_eq!(read_local(&root, "notes.tex").unwrap(), marked.as_bytes());
    for rel in ["main.log", "main.pdf", "tmp/pdfs/full-appendix/render-1.png"] {
        assert!(read_local(&root, rel).is_some(), "{rel}");
    }
}

#[test]
fn overleaf_sync_resolves_deletions_made_on_one_side_and_cleans_up_transient_files() {
    // old.tex: deleted on Overleaf, untouched here, so it goes here too —
    // Overleaf's history records the removal, which a deletion needs.
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
    let removal = json!({ "fromV": 9, "toV": 10, "meta": { "end_ts": 1_800_000_000_000i64 },
        "pathnames": [], "project_ops": [{ "atV": 9, "remove": { "pathname": "old.tex" } }] });
    let mock = Mock { history: vec![removal], ..Mock::project(remote) };
    let (server, root, result) = run_sync(mock, local, base);
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

// ---- downloads that would wipe out local work ---------------------------------

/// Overleaf history entries as `/updates` lists them, newest first: one doc
/// edit, one file removal and one folder rename, all after the project's last
/// sync (2026-07-01), and an older edit from before it.
fn incident_history() -> Vec<Value> {
    let at = |day: u32| {
        chrono::NaiveDate::from_ymd_opt(2026, 7, day)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis()
    };
    vec![
        json!({ "fromV": 40, "toV": 41, "meta": { "end_ts": at(3) }, "pathnames": ["iclr.sty"] }),
        json!({ "fromV": 39, "toV": 40, "meta": { "end_ts": at(2) }, "pathnames": [],
            "project_ops": [{ "atV": 39, "remove": { "pathname": "legacy/old.tex" } }] }),
        json!({ "fromV": 38, "toV": 39, "meta": { "end_ts": at(2) }, "pathnames": [],
            "project_ops": [{ "atV": 38, "rename": { "pathname": "figures", "newPathname": "figs" } }] }),
        // Before the last sync: that edit was already in the copy both sides
        // agreed on, so it cannot vouch for today's empty notes.md.
        json!({ "fromV": 1, "toV": 2, "meta": { "end_ts": at(1) - 86_400_000 },
            "pathnames": ["notes.md"] }),
    ]
}

/// The 2026-10-01 "Native VLM" incident on the real sync path: Overleaf's
/// project download carried 0-byte entries for files nobody had touched, and
/// the sync wrote them over the intact local copies, because "changed there,
/// untouched here" is an ordinary pull. A download that would empty, gut or
/// drop a file is now applied only when Overleaf's own history records a
/// change to that path since the last sync; otherwise it is refused and the
/// local file is kept, while genuine edits beside it still land.
#[test]
fn overleaf_sync_never_lets_a_hollow_download_wipe_out_unchanged_local_files() {
    let style = "%% ICLR style\n".repeat(700);
    let notes = "Notes kept only in this project.\n".repeat(60);
    let figure: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
    let script = "import plotly\n".repeat(100);
    let base: Files = &[
        ("fig.png", &figure),
        ("figures/a.png", b"\x89PNG moved with its folder"),
        ("iclr.sty", style.as_bytes()),
        ("legacy/old.tex", b"\\section{Removed on Overleaf}\n"),
        ("main.tex", b"\\documentclass{article}\n\\usepackage{iclr}\n"),
        ("notes.md", notes.as_bytes()),
        ("scripts/plot.py", script.as_bytes()),
    ];
    let stub = b"\\input{iclr2027/iclr.sty}\n".as_slice();
    let hollow: Files = &[
        // Emptied in the download only; no history entry says anyone did it.
        ("fig.png", b""),
        ("notes.md", b""),
        // scripts/plot.py is simply missing from it.
        // Genuine changes made on Overleaf since the last sync.
        ("figs/a.png", b"\x89PNG moved with its folder"),
        ("iclr.sty", stub),
        ("main.tex", b"\\documentclass{article}\n\\usepackage{iclr2027/iclr}\n"),
    ];
    let server = Mock { history: incident_history(), ..Mock::project(hollow) }.serve();
    let (config, root) = linked(&server, base, base);
    let kept = ["fig.png", "notes.md", "scripts/plot.py"];

    // The review shows the refusal before anything happens.
    let preview = preview(&config, &root, NO_LIVE).unwrap();
    let rows: Vec<_> =
        (preview.changes.iter()).map(|c| (c.kind.as_str(), c.path.as_str())).collect();
    assert_eq!(
        rows,
        [
            ("refusedIncoming", "fig.png"),
            ("refusedIncoming", "notes.md"),
            ("refusedIncoming", "scripts/plot.py"),
            ("incoming", "figs/a.png"),
            ("incoming", "iclr.sty"),
            ("incoming", "main.tex"),
            ("deleteLocal", "figures/a.png"),
            ("deleteLocal", "legacy/old.tex"),
        ]
    );

    for round in ["first", "repeat of the same download"] {
        let result = sync(&config, &root, NO_LIVE, None).unwrap();
        assert_eq!(result.refused_incoming, kept, "{round}");
        let files = state_files(&root);
        for (rel, data) in base.iter().filter(|(rel, _)| kept.contains(rel)) {
            assert_eq!(read_local(&root, rel).as_deref(), Some(*data), "{round}: {rel}");
            // The agreed state still says "unchanged here", so nothing of
            // ours goes up and the next sync looks at Overleaf's copy again.
            assert_eq!(files.get(*rel), Some(&sha256_hex(data)), "{round}: {rel}");
        }
        // Held since the last sync before the first refusal, so a history
        // entry the first check could not see still counts later.
        let since = load_state(&root).unwrap().refused_since;
        assert_eq!(since.keys().collect::<Vec<_>>(), kept, "{round}");
        assert!(since.values().all(|at| at == "2026-07-01T00:00:00Z"), "{round}: {since:?}");
        if round == "first" {
            assert_eq!(result.pulled, ["figs/a.png", "iclr.sty", "main.tex"]);
            assert_eq!(result.deleted_local, ["figures/a.png", "legacy/old.tex"]);
            assert_eq!(read_local(&root, "iclr.sty").as_deref(), Some(stub));
        } else {
            assert!(result.pulled.is_empty() && result.deleted_local.is_empty());
        }
        assert!(result.pushed.is_empty() && server.uploads().is_empty());
    }

    // Overleaf serves the files whole again: nothing to do, nothing held.
    let mut whole: Vec<(&str, &[u8])> =
        hollow.iter().filter(|(rel, _)| !kept.contains(rel)).copied().collect();
    whole.extend(base.iter().filter(|(rel, _)| kept.contains(rel)).copied());
    let healed = Mock::project(&whole).serve();
    let config = signed_in(&healed.base);
    edit_state(&root, |state| state.host = healed.base.clone());
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.refused_incoming.is_empty() && result.pulled.is_empty());
    assert!(load_state(&root).unwrap().refused_since.is_empty());
}

#[test]
fn only_emptying_gutting_or_dropping_a_file_needs_overleafs_history() {
    // (local, remote) → whether the pull must be confirmed first.
    let kb = |n: usize| vec![b'x'; n * 1024];
    for (label, local, remote, destructive) in [
        ("emptied", b"x".to_vec(), Some(Vec::new()), true),
        ("missing", b"x".to_vec(), None, true),
        ("cut to a fifth", kb(5), Some(kb(1)), true),
        ("cut to a third", kb(3), Some(kb(1)), false),
        ("small file shortened", vec![b'x'; 1000], Some(b"x".to_vec()), false),
        ("empty here already", Vec::new(), None, false),
        ("grown", b"x".to_vec(), Some(kb(1)), false),
    ] {
        assert_eq!(wipes_out(&local, remote.as_deref()), destructive, "{label}");
    }
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
    let config = signed_in(&second_server.base);

    let merged = sync(&config, &root, NO_LIVE, None).unwrap();

    assert_eq!(merged.merged, vec!["main.tex"]);
    assert!(merged.conflicts.is_empty());
    assert_eq!(text(&root, "main.tex"), "alpha revised remotely\nshared middle\nbeta locally\n");
    assert_eq!(second_server.uploads().len(), 1);
}

#[test]
fn base_copy_finalization_uses_the_hash_agreement_and_retains_held_ancestors() {
    let root = TempDir::new("base-finalization");
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

// ---- relocations -------------------------------------------------------------------

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
