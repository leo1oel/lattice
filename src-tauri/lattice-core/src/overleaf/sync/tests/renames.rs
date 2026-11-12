//! Renames a co-author makes on Overleaf (audit F5): an edit here carried
//! along one plain rename, every other case holding the edited file, and
//! renames in letter case only.

use super::*;

const MAIN: &[u8] = b"\\documentclass{article}\n\\input{sections/method}\n";
const METHOD: &[u8] = b"\\section{Method}\nWe train a model.\n\nWe evaluate it.\n";
/// The co-author's refinement of the first paragraph.
const REFINED: &[u8] =
    b"\\section{Method}\nWe train a model, refined by the co-author.\n\nWe evaluate it.\n";
/// The agent's paragraph, added at the end.
const AGENT: &[u8] = b"\\section{Method}\nWe train a model.\n\nWe evaluate it.\n\nA new paragraph the agent wrote.\n";
/// The co-author's refinement and the agent's paragraph, merged.
const MERGED: &[u8] = b"\\section{Method}\nWe train a model, refined by the co-author.\n\nWe evaluate it.\n\nA new paragraph the agent wrote.\n";
const OLD: &[u8] = b"\\section{Old approach}\n";
const NOTES: &[u8] = b"Notes.\n";

fn rename(at: i64, from: &str, to: &str) -> Value {
    json!({ "atV": at, "rename": { "pathname": from, "newPathname": to } })
}

fn with_main<'a>(files: &[(&'a str, &'a [u8])]) -> Vec<(&'a str, &'a [u8])> {
    [("main.tex", MAIN)].into_iter().chain(files.iter().copied()).collect()
}

/// Overleaf at version 43 holding `main.tex` and `theirs`, its history since
/// version 41 one update made of `ops`.
fn overleaf_after(ops: Vec<Value>, theirs: Files) -> Mock {
    let update = json!({ "fromV": 41, "toV": 43, "pathnames": [],
        "project_ops": ops, "meta": { "end_ts": 0 } });
    Mock { versions: vec![43], history: vec![update], ..Mock::project(&with_main(theirs)) }
}

/// Overleaf at version 42, after a co-author renamed `sections/method.tex`
/// to `sections/approach.tex` holding `approach`; the last sync agreed on
/// version 41. `grouped` lists the rename as Overleaf groups a co-author's
/// run of changes: in one update with the ones before 41 the agreed copy
/// already has, here the file removed and restored.
fn renamed_on_overleaf(approach: &'static [u8], grouped: bool) -> Mock {
    let renamed = rename(41, "sections/method.tex", "sections/approach.tex");
    let (from_v, ops) = if grouped {
        let removed = json!({ "atV": 39, "remove": { "pathname": "sections/method.tex" } });
        let restored = json!({ "atV": 40, "add": { "pathname": "sections/method.tex" } });
        (39, json!([removed, restored, renamed]))
    } else {
        (41, json!([renamed]))
    };
    let update = json!({ "fromV": from_v, "toV": 42, "pathnames": ["sections/approach.tex"],
        "project_ops": ops, "meta": { "end_ts": 0 } });
    let remote: Files = &[("main.tex", MAIN), ("sections/approach.tex", approach)];
    Mock { versions: vec![42], history: vec![update], ..Mock::project(remote) }
}

fn agreed_at_41(root: &Path) {
    edit_state(root, |state| (state.remote_version, state.agreed_version) = (Some(41), Some(41)));
}

/// What went up as whole files, by file name.
fn uploaded_names(server: &MockServer) -> Vec<String> {
    let name =
        |body: String| body.split("filename=\"").nth(1)?.split('"').next().map(str::to_string);
    server.uploads().into_iter().filter_map(|upload| name(upload.body_text())).collect()
}

/// Whether `path` is on disk spelled exactly so, every folder included: a
/// disk that ignores letter case opens it under any spelling.
fn spelled_on_disk(root: &Path, path: &str) -> bool {
    let mut at = root.to_path_buf();
    path.split('/').all(|part| {
        let names: Vec<_> = fs::read_dir(&at).unwrap().map(|e| e.unwrap().file_name()).collect();
        at.push(part);
        names.iter().any(|name| name == part)
    })
}

/// The audit's case: the agent edited `method.tex` while a co-author renamed
/// it on Overleaf. The edit used to go back up as a fresh `method.tex` beside
/// an `approach.tex` without it.
#[test]
fn a_remote_rename_carries_the_local_edit_to_the_new_name() {
    for grouped in [false, true] {
        let server = renamed_on_overleaf(REFINED, grouped).serve();
        let base: Files = &[("main.tex", MAIN), ("sections/method.tex", METHOD)];
        let (config, root) =
            linked(&server, &[("main.tex", MAIN), ("sections/method.tex", AGENT)], base);
        agreed_at_41(&root);

        // The preview shows what the sync then does.
        let rows = preview(&config, &root, NO_LIVE).unwrap().changes;
        let rows: Vec<_> = rows.iter().map(|row| (row.path.as_str(), row.kind.as_str())).collect();
        let expected = [("sections/approach.tex", "merge"), ("sections/method.tex", "deleteLocal")];
        assert_eq!(rows, expected, "grouped: {grouped}");
        let result = sync(&config, &root, NO_LIVE, None).unwrap();
        let approach = read_local(&root, "sections/approach.tex");
        assert_eq!(approach.as_deref(), Some(MERGED), "grouped: {grouped}");
        assert_eq!(read_local(&root, "sections/method.tex"), None);
        assert_eq!(result.merged, ["sections/approach.tex"]);
        assert_eq!(result.pushed, ["sections/approach.tex"]);
        assert_eq!(result.deleted_local, ["sections/method.tex"]);
        assert!(result.conflicts.is_empty() && result.held_renames.is_empty());
        assert_eq!(uploaded_names(&server), ["approach.tex"], "the old name never goes up");
        let files = state_files(&root);
        assert_eq!(files.get("sections/approach.tex"), Some(&sha256_hex(MERGED)));
        assert!(!files.contains_key("sections/method.tex"));
        assert_eq!(read_base_copy(&root, "sections/approach.tex").unwrap().as_bytes(), MERGED);
        assert_eq!(read_base_copy(&root, "sections/method.tex"), None);
    }
}

/// Nothing changed here: the file simply takes its new name, with nothing
/// uploaded, as comparing paths always did.
#[test]
fn a_remote_rename_with_no_local_edit_renames_the_file_here() {
    for (label, approach) in [("renamed", METHOD), ("renamed and edited", REFINED)] {
        let server = renamed_on_overleaf(approach, false).serve();
        let base: Files = &[("main.tex", MAIN), ("sections/method.tex", METHOD)];
        let (config, root) = linked(&server, base, base);
        agreed_at_41(&root);

        let result = sync(&config, &root, NO_LIVE, None).unwrap();
        let renamed = read_local(&root, "sections/approach.tex");
        assert_eq!(renamed.as_deref(), Some(approach), "{label}");
        assert_eq!(read_local(&root, "sections/method.tex"), None, "{label}");
        assert_eq!(result.pulled, ["sections/approach.tex"], "{label}");
        assert_eq!(result.deleted_local, ["sections/method.tex"], "{label}");
        assert!(result.pushed.is_empty() && server.uploads().is_empty(), "{label}");
        let files = state_files(&root);
        assert_eq!(files.get("sections/approach.tex"), Some(&sha256_hex(approach)), "{label}");
        assert!(!files.contains_key("sections/method.tex"), "{label}");
    }
}

/// The co-author renamed the edited `method.tex` in a way that is not one
/// plain rename to a free name. Comparing paths would upload it again
/// beside a renamed file without the edit; carrying it would be a guess. So
/// that file alone is held: not sent, not deleted, on its agreed copy, and
/// named in the result, on this sync and the next, while everything else
/// Overleaf changed arrives, so the edit can be copied where it belongs.
#[test]
fn an_edited_file_renamed_any_other_way_is_held_and_named() {
    let method_to = |to: &str| rename(42, "sections/method.tex", to);
    let cases: [(&str, Vec<Value>, Files, Files); 4] = [
        (
            "renamed twice",
            vec![rename(41, "sections/method.tex", "sections/draft.tex"), {
                rename(42, "sections/draft.tex", "sections/approach.tex")
            }],
            &[("sections/approach.tex", REFINED)],
            &[],
        ),
        (
            "renamed onto a name vacated first",
            vec![
                rename(41, "sections/approach.tex", "sections/old.tex"),
                method_to("sections/approach.tex"),
            ],
            &[("sections/old.tex", OLD), ("sections/approach.tex", REFINED)],
            &[("sections/approach.tex", OLD)],
        ),
        (
            "removed and restored, then renamed",
            vec![
                json!({ "atV": 41, "remove": { "pathname": "sections/method.tex" } }),
                json!({ "atV": 41, "add": { "pathname": "sections/method.tex" } }),
                method_to("sections/approach.tex"),
            ],
            &[("sections/approach.tex", REFINED)],
            &[],
        ),
        (
            "renamed onto a name here but for case",
            vec![
                rename(41, "sections/Approach.tex", "sections/old.tex"),
                method_to("sections/approach.tex"),
            ],
            &[("sections/old.tex", OLD), ("sections/approach.tex", REFINED)],
            &[("sections/Approach.tex", OLD)],
        ),
    ];
    for (label, ops, theirs, others) in cases {
        let server = overleaf_after(ops, theirs).serve();
        let base = with_main(&[others, &[("sections/method.tex", METHOD)]].concat());
        let local = with_main(&[others, &[("sections/method.tex", AGENT)]].concat());
        let (config, root) = linked(&server, &local, &base);
        agreed_at_41(&root);

        let rows = preview(&config, &root, NO_LIVE).unwrap().changes;
        assert!(!rows.iter().any(|row| row.path == "sections/method.tex"), "{label}: {rows:?}");
        for round in ["first", "next"] {
            let result = sync(&config, &root, NO_LIVE, None).unwrap();
            assert_eq!(result.held_renames, ["sections/method.tex"], "{label}, {round} sync");
            let deleted = result.deleted_local.iter().any(|path| path == "sections/method.tex");
            assert!(result.pushed.is_empty() && !deleted, "{label}");
            assert!(server.uploads().is_empty(), "{label}: the old name never goes up");
            let method = read_local(&root, "sections/method.tex");
            assert_eq!(method.as_deref(), Some(AGENT), "{label}");
            let state = load_state(&root).unwrap();
            let agreed = state.files.get("sections/method.tex");
            assert_eq!(agreed, Some(&sha256_hex(METHOD)), "{label}: on its agreed copy");
            assert_eq!(state.agreed_version, Some(43), "{label}: the agreed version moves on");
            let held = Unsettled::Held(Some(HistoryFrom::Version(41)));
            let unsettled = BTreeMap::from([("sections/method.tex".to_string(), held)]);
            assert_eq!(state.unsettled, Some(unsettled), "{label}: the rename stays in view");
        }
        for (path, bytes) in with_main(theirs) {
            assert!(spelled_on_disk(&root, path), "{label}: {path} spelled as on Overleaf");
            assert_eq!(read_local(&root, path).as_deref(), Some(bytes), "{label}: {path}");
        }
    }
}

/// The co-author removed the edited `method.tex`, and the history shows no
/// rename of it: nothing to split, so the edit goes back up, as an edit to a
/// file removed on Overleaf always has.
#[test]
fn an_edited_file_only_removed_on_overleaf_still_goes_back_up() {
    let removed = json!({ "atV": 41, "remove": { "pathname": "sections/method.tex" } });
    let server = overleaf_after(vec![removed], &[]).serve();
    let base: Files = &[("main.tex", MAIN), ("sections/method.tex", METHOD)];
    let (config, root) =
        linked(&server, &[("main.tex", MAIN), ("sections/method.tex", AGENT)], base);
    agreed_at_41(&root);

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.held_renames.is_empty());
    assert_eq!(result.pushed, ["sections/method.tex"]);
    assert_eq!(uploaded_names(&server), ["method.tex"]);
}

/// A freshly linked project has no agreed version yet, only the version it
/// was linked at. A hold must keep the rename in view from there, however
/// far the versions move, or the next sync reads the file as only removed
/// and sends the edit up under the old name beside the renamed file.
#[test]
fn a_hold_on_a_freshly_linked_project_never_sends_the_old_name() {
    let chain = vec![
        rename(41, "sections/method.tex", "sections/draft.tex"),
        rename(42, "sections/draft.tex", "sections/approach.tex"),
    ];
    let server = overleaf_after(chain, &[("sections/approach.tex", REFINED)]).serve();
    let base: Files = &[("main.tex", MAIN), ("sections/method.tex", METHOD)];
    let (config, root) =
        linked(&server, &[("main.tex", MAIN), ("sections/method.tex", AGENT)], base);
    edit_state(&root, |state| (state.remote_version, state.agreed_version) = (Some(41), None));

    for round in ["first", "next", "third"] {
        let result = sync(&config, &root, NO_LIVE, None).unwrap();
        assert_eq!(result.held_renames, ["sections/method.tex"], "{round} sync");
        assert!(result.pushed.is_empty() && server.uploads().is_empty(), "{round} sync");
        assert_eq!(read_local(&root, "sections/method.tex").as_deref(), Some(AGENT));
    }
}

/// Overleaf's history cannot be read, so the sync cannot tell whether the
/// co-author renamed `method.tex`. Unchanged here, the file is simply deleted
/// and the new one pulled, which is right either way. Edited here, that file
/// is held, and the new file waits unpulled, since it may be the held one
/// renamed, while the rest of the sync goes on. The hold keeps where it
/// began, so once the history can be read the next sync finds the rename and
/// carries the edit.
#[test]
fn an_unreadable_history_holds_the_edit_until_a_readable_one_carries_it() {
    let base: Files = &[("main.tex", MAIN), ("sections/method.tex", METHOD)];

    let server = unreadable_rename().serve();
    let (config, root) = linked(&server, base, base);
    agreed_at_41(&root);
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.deleted_local, ["sections/method.tex"], "unchanged");
    assert_eq!(read_local(&root, "sections/approach.tex").as_deref(), Some(REFINED));
    assert!(result.held_renames.is_empty() && server.uploads().is_empty());

    let (config, root) =
        linked(&server, &[("main.tex", MAIN), ("sections/method.tex", AGENT)], base);
    agreed_at_41(&root);
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.held_renames, ["sections/method.tex"]);
    assert_eq!(result.pulled, ["main.tex"], "the rest of the sync goes on");
    assert!(result.pushed.is_empty() && result.deleted_local.is_empty());
    assert!(server.uploads().is_empty());
    assert_eq!(read_local(&root, "sections/method.tex").as_deref(), Some(AGENT));
    assert_eq!(read_local(&root, "sections/approach.tex"), None, "it waits");
    let state = load_state(&root).unwrap();
    assert_eq!(state.files.get("sections/method.tex"), Some(&sha256_hex(METHOD)));
    assert!(!state.files.contains_key("sections/approach.tex"));

    // The same project, its history readable again.
    let history = renamed_on_overleaf(REFINED, false).history;
    let server = Mock { history, routes: vec![], ..unreadable_rename() }.serve();
    let config = signed_in(&server.base);
    edit_state(&root, |state| state.host = server.base.clone());
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.held_renames.is_empty());
    assert_eq!(read_local(&root, "sections/approach.tex").as_deref(), Some(MERGED));
    assert_eq!(read_local(&root, "sections/method.tex"), None);
    assert_eq!(uploaded_names(&server), ["approach.tex"]);
    let files = state_files(&root);
    assert_eq!(files.get("sections/approach.tex"), Some(&sha256_hex(MERGED)));
    assert!(!files.contains_key("sections/method.tex"));
}

/// Overleaf at version 42 after a co-author renamed `sections/method.tex` to
/// `sections/approach.tex` and edited `main.tex`, its history unreadable.
fn unreadable_rename() -> Mock {
    const MAIN_EDITED: &[u8] = b"\\documentclass{article}\n\\input{sections/approach}\n";
    let remote: Files = &[("main.tex", MAIN_EDITED), ("sections/approach.tex", REFINED)];
    Mock {
        versions: vec![42],
        routes: vec![("GET", "/project/proj-1/updates", 500, String::new())],
        ..Mock::project(remote)
    }
}

/// A history that stays unreadable keeps a new file on Overleaf out of the
/// project for the first sync of the hold only: the next one pulls it, so
/// co-authors' new files are not kept out for good, while the edited file
/// stays held and named, never sent under its old name.
#[test]
fn an_unreadable_history_keeps_new_files_waiting_only_as_the_hold_begins() {
    let server = unreadable_rename().serve();
    let base: Files = &[("main.tex", MAIN), ("sections/method.tex", METHOD)];
    let (config, root) =
        linked(&server, &[("main.tex", MAIN), ("sections/method.tex", AGENT)], base);
    agreed_at_41(&root);

    let first = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(first.held_renames, ["sections/method.tex"]);
    assert_eq!(read_local(&root, "sections/approach.tex"), None, "it waits");
    let next = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(next.held_renames, ["sections/method.tex"], "still held and named");
    assert_eq!(next.pulled, ["sections/approach.tex"], "no longer kept out");
    assert_eq!(read_local(&root, "sections/approach.tex").as_deref(), Some(REFINED));
    assert_eq!(read_local(&root, "sections/method.tex").as_deref(), Some(AGENT));
    assert!(next.pushed.is_empty() && server.uploads().is_empty());
}

/// The agent created `method.tex` and the last sync uploaded it; a co-author
/// then renamed it while the agent kept editing. Lattice's own upload is in
/// the history since the agreed copy too, but it is no other name for the
/// file: the rename is the one plain operation, and the edit is carried.
#[test]
fn a_rename_of_a_file_lattice_just_uploaded_carries_the_edit() {
    let added = json!({ "fromV": 41, "toV": 42, "pathnames": ["sections/method.tex"],
        "project_ops": [{ "atV": 41, "add": { "pathname": "sections/method.tex" } }],
        "meta": { "end_ts": 0 } });
    let renamed = json!({ "fromV": 42, "toV": 43, "pathnames": ["sections/approach.tex"],
        "project_ops": [rename(42, "sections/method.tex", "sections/approach.tex")],
        "meta": { "end_ts": 0 } });
    let remote: Files = &[("main.tex", MAIN), ("sections/approach.tex", REFINED)];
    let mock = Mock { versions: vec![43], history: vec![renamed, added], ..Mock::project(remote) };
    let server = mock.serve();
    let base: Files = &[("main.tex", MAIN), ("sections/method.tex", METHOD)];
    let (config, root) =
        linked(&server, &[("main.tex", MAIN), ("sections/method.tex", AGENT)], base);
    agreed_at_41(&root);
    edit_state(&root, |state| {
        state.own_writes.insert("sections/method.tex".into(), HistoryFrom::Version(42));
    });

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.held_renames.is_empty());
    assert_eq!(read_local(&root, "sections/approach.tex").as_deref(), Some(MERGED));
    assert_eq!(read_local(&root, "sections/method.tex"), None);
    assert_eq!(uploaded_names(&server), ["approach.tex"], "the old name never goes up");
}

/// Lattice's last write to `method.tex` was a live-editor checkpoint, placed
/// only by time, so it reaches over every update of the co-author's around
/// it. Only an add of the file can be Lattice's own upload: the co-author's
/// rename and removal still count, so a plain rename carries the edit, a
/// removal and restore before the rename holds it, and neither sends the
/// old name up.
#[test]
fn lattices_own_write_never_hides_a_co_authors_rename_or_removal() {
    let restored_then_renamed = vec![
        json!({ "atV": 41, "remove": { "pathname": "sections/method.tex" } }),
        json!({ "atV": 41, "add": { "pathname": "sections/method.tex" } }),
        rename(42, "sections/method.tex", "sections/approach.tex"),
    ];
    let cases = [
        ("renamed", renamed_on_overleaf(REFINED, false), Some(MERGED)),
        (
            "restored, then renamed",
            { overleaf_after(restored_then_renamed, &[("sections/approach.tex", REFINED)]) },
            None,
        ),
    ];
    for (label, mock, carried) in cases {
        let server = mock.serve();
        let base: Files = &[("main.tex", MAIN), ("sections/method.tex", METHOD)];
        let (config, root) =
            linked(&server, &[("main.tex", MAIN), ("sections/method.tex", AGENT)], base);
        agreed_at_41(&root);
        edit_state(&root, |state| {
            state.own_writes.insert("sections/method.tex".into(), HistoryFrom::Time(0));
        });

        let result = sync(&config, &root, NO_LIVE, None).unwrap();
        assert!(!uploaded_names(&server).contains(&"method.tex".to_string()), "{label}");
        match carried {
            Some(merged) => {
                assert!(result.held_renames.is_empty(), "{label}");
                let approach = read_local(&root, "sections/approach.tex");
                assert_eq!(approach.as_deref(), Some(merged), "{label}");
                assert_eq!(uploaded_names(&server), ["approach.tex"], "{label}");
            }
            None => {
                assert_eq!(result.held_renames, ["sections/method.tex"], "{label}");
                let method = read_local(&root, "sections/method.tex");
                assert_eq!(method.as_deref(), Some(AGENT), "{label}");
            }
        }
    }
}

/// `method.tex` has been held since version 5, longer ago than Lattice reads
/// Overleaf's history at once. Meanwhile a co-author plainly renamed the
/// edited `intro.tex`, which is either only now gone or held itself since
/// version 40, when the history could not be read. Its own window reads, so
/// the rename is carried, while `method.tex` stays held, its old name unsent.
#[test]
fn a_long_held_file_does_not_hold_back_another_files_rename() {
    for intro_held_since in [None, Some(40)] {
        let renamed = json!({ "fromV": 41, "toV": 42, "pathnames": ["sections/introduction.tex"],
            "project_ops": [rename(41, "sections/intro.tex", "sections/introduction.tex")],
            "meta": { "end_ts": 0 } });
        let older =
            json!({ "fromV": 10, "toV": 11, "pathnames": ["main.tex"], "meta": { "end_ts": 0 } });
        let remote: Files = &[("main.tex", MAIN), ("sections/introduction.tex", REFINED)];
        let mock = Mock {
            versions: vec![42],
            history: vec![renamed, older],
            endless_history: true,
            ..Mock::project(remote)
        };
        let server = mock.serve();
        let base = with_main(&[("sections/intro.tex", METHOD), ("sections/method.tex", NOTES)]);
        let local = with_main(&[("sections/intro.tex", AGENT), ("sections/method.tex", OLD)]);
        let (config, root) = linked(&server, &local, &base);
        agreed_at_41(&root);
        edit_state(&root, |state| {
            let held = |since| Unsettled::Held(Some(HistoryFrom::Version(since)));
            let mut unsettled = BTreeMap::from([("sections/method.tex".into(), held(5))]);
            if let Some(since) = intro_held_since {
                unsettled.insert("sections/intro.tex".into(), held(since));
            }
            state.unsettled = Some(unsettled);
        });

        let label = format!("intro.tex held since {intro_held_since:?}");
        let result = sync(&config, &root, NO_LIVE, None).unwrap();
        assert_eq!(result.held_renames, ["sections/method.tex"], "{label}");
        let introduction = read_local(&root, "sections/introduction.tex");
        assert_eq!(introduction.as_deref(), Some(MERGED), "{label}: the rename is carried");
        assert_eq!(read_local(&root, "sections/intro.tex"), None, "{label}");
        assert_eq!(read_local(&root, "sections/method.tex").as_deref(), Some(OLD), "{label}");
        assert_eq!(uploaded_names(&server), ["introduction.tex"], "{label}: no old name");
    }
}

/// Renames on Overleaf that a disk ignoring letter case could read as one
/// file deleted and the same file pulled: a file's name changed in case only
/// with no history to say so, a folder's with a file in it edited here, and
/// a file renamed away while another takes its name in other case. Each file
/// ends up under Overleaf's spelling with its text, an edit here merged in,
/// and the next sync finds nothing to delete or upload.
/// `(label, history, Overleaf's files, agreed, here, uploaded names)`.
type CaseRename = (
    &'static str,
    Vec<Value>,
    Files<'static>,
    Files<'static>,
    Files<'static>,
    &'static [&'static str],
);

#[test]
fn renames_in_letter_case_keep_every_file_here_under_overleafs_spelling() {
    let cases: [CaseRename; 3] = [
        (
            "a file renamed in case, with no history of it",
            vec![],
            &[("sections/Notes.tex", NOTES)],
            &[("sections/notes.tex", NOTES)],
            &[("sections/notes.tex", NOTES)],
            &[],
        ),
        (
            "a folder renamed in case, a file in it edited here",
            vec![rename(41, "Sections", "sections")],
            &[("sections/method.tex", REFINED), ("sections/notes.tex", NOTES)],
            &[("Sections/method.tex", METHOD), ("Sections/notes.tex", NOTES)],
            &[("Sections/method.tex", AGENT), ("Sections/notes.tex", NOTES)],
            &["method.tex"],
        ),
        (
            "a file renamed away and its name taken in other case",
            vec![
                rename(41, "sections/Approach.tex", "sections/old.tex"),
                rename(42, "sections/method.tex", "sections/approach.tex"),
            ],
            &[("sections/old.tex", OLD), ("sections/approach.tex", METHOD)],
            &[("sections/Approach.tex", OLD), ("sections/method.tex", METHOD)],
            &[("sections/Approach.tex", OLD), ("sections/method.tex", METHOD)],
            &[],
        ),
    ];
    for (label, ops, theirs, base, local, uploads) in cases {
        let server = overleaf_after(ops, theirs).serve();
        let (config, root) = linked(&server, &with_main(local), &with_main(base));
        agreed_at_41(&root);

        let result = sync(&config, &root, NO_LIVE, None).unwrap_or_else(|e| panic!("{label}: {e}"));
        assert!(result.held_renames.is_empty(), "{label}");
        let remote = with_main(theirs);
        for (path, bytes) in &remote {
            let expected = if *bytes == REFINED { MERGED } else { bytes };
            assert!(spelled_on_disk(&root, path), "{label}: {path} spelled as on Overleaf");
            assert_eq!(read_local(&root, path).as_deref(), Some(expected), "{label}: {path}");
        }
        assert_eq!(uploaded_names(&server), uploads, "{label}");
        let agreed: Vec<_> = state_files(&root).into_keys().collect();
        let mut paths: Vec<_> = remote.iter().map(|(path, _)| path.to_string()).collect();
        paths.sort();
        assert_eq!(agreed, paths, "{label}");
        let again = sync(&config, &root, NO_LIVE, None).unwrap();
        assert!(again.deleted_local.is_empty() && again.skipped_remote_deletes.is_empty());
        assert!(again.pushed.is_empty(), "{label}: {:?}", again.pushed);
    }
}

/// The backstop under the above: a plan that would delete `notes.tex` while
/// keeping `Notes.tex` is refused, since on a disk that ignores letter case
/// the deletion takes the kept file with it.
#[test]
fn a_deletion_spelled_like_a_kept_file_but_for_case_is_refused() {
    let files: Files = &[("notes.tex", NOTES)];
    let root = linked_root(files, files);
    let state = load_state(&root).unwrap();
    let remote = BTreeMap::from([("Notes.tex".to_string(), NOTES.to_vec())]);
    let local = BTreeMap::from([("notes.tex".to_string(), NOTES.to_vec())]);

    let refused = plan_sync(&root, &state, &remote, &local, NO_LIVE, NO_RENAMES, "stamp");
    let expected = "Overleaf no longer has notes.tex but has Notes.tex, a name this disk may \
                    take for the same file, so deleting notes.tex here could delete Notes.tex. \
                    Move notes.tex out of the project, then sync again. No files were changed.";
    assert_eq!(refused.err().as_deref(), Some(expected));
}
