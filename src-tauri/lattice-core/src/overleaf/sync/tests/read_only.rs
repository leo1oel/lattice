//! A sync without write access: incoming work lands, local work stays here.

use super::*;

#[test]
fn overleaf_sync_never_uploads_without_a_writable_role() {
    // Incoming work still lands; only the upload half stands down. Trying
    // anyway would be rejected file by file and read as a broken sync. A
    // reviewer may comment but not change the text, and a role nobody recorded
    // fails closed, both exactly as the realtime channel reads them.
    let base = b"shared body".as_slice();
    for (permission, writable, _) in crate::overleaf_rt::tests::ROLE_CASES {
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
        assert_eq!(result.read_only, !writable, "{permission:?}");
        assert_eq!(result.pulled, vec!["notes.tex"], "{permission:?}");
        if writable {
            assert_eq!(result.pushed, vec!["main.tex"], "{permission:?}");
            assert_eq!(server.uploads().len(), 1, "{permission:?}");
        } else {
            assert!(result.pushed.is_empty() && server.uploads().is_empty(), "{permission:?}");
            // The local edit is still here, and still counts as unsent.
            assert_eq!(read_local(&root, "main.tex").unwrap(), b"local body");
            assert!(!state_files(&root).contains_key("main.tex"));
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
