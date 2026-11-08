//! The dry run shows exactly what the sync then does.

use super::*;

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
    // Documents Overleaf holds go up first, one at a time, each between two
    // reads of the project's version (see `send`); new files come after.
    let upload_of = |rel: &str| format!("\r\n\r\n{rel}\r\n");
    assert!(uploads[0].body_text().contains(&upload_of("main.tex")));
    assert!(uploads[1].body_text().contains(&upload_of("outgoing.tex")));
    assert!(uploads[2].body_text().contains(&upload_of("nested/new-chapter.tex")));
    for rel in &result.pushed {
        let upload = (uploads.iter())
            .find(|upload| upload.body_text().contains(&format!("\r\n\r\n{rel}\r\n")))
            .unwrap_or_else(|| panic!("no upload of {rel}"));
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
