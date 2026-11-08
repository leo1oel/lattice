use super::*;
use crate::overleaf::account::{load_session, save_session, SessionFile};
use crate::overleaf::link::{save_state, SyncState};
use crate::overleaf_rt::mock_server::{
    doc_text, refuse_updates, sent_updates as updates, serve_http, set_doc, start_mock_serving,
    type_after_join, MOCK_USER_ID,
};
use crate::test_support::TempDir;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn remote(host: &str) -> Remote {
    Remote {
        session: SessionFile {
            host: host.into(),
            cookie: "overleaf_session2=test-cookie".into(),
            email: None,
            name: None,
            user_id: Some("user-1".into()),
            expired: false,
        },
        state: SyncState {
            host: host.into(),
            project_id: "proj-1".into(),
            root_folder_id: Some("root-1".into()),
            ..Default::default()
        },
        host: host.into(),
    }
}

/// The main text, a data file made with New file in the browser (so a
/// document), and a figure description uploaded as a binary file.
fn project(track_changes: Value) -> Value {
    json!({
        "_id": "proj-1",
        "name": "Paper",
        "trackChangesState": track_changes,
        "rootFolder": [{
            "_id": "root-1",
            "name": "rootFolder",
            "docs": [{"_id": "doc-main", "name": "main.tex"}, {"_id": "doc-data", "name": "data.csv"}],
            "fileRefs": [{"_id": "file-1", "name": "plot.json"}],
            "folders": []
        }]
    })
}

fn files(entries: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
    entries.iter().map(|(path, text)| (path.to_string(), text.as_bytes().to_vec())).collect()
}

#[test]
fn an_upload_is_trusted_with_a_document_only_when_its_name_reads_as_text() {
    for (path, risky) in [
        ("main.tex", false),
        ("sections/Intro.TEX", false),
        ("refs.bib", false),
        ("data.csv", true),
        ("results/table.dat", true),
        ("plot.json", true),
        ("latexmkrc", true),
        (".latexmkrc", true),
    ] {
        assert_eq!(may_become_a_file(path), risky, "{path}");
    }
}

#[test]
fn the_edit_is_positioned_in_utf16_units_and_never_splits_a_character() {
    // 😀 counts two units, so "b" starts at 3.
    assert_eq!(
        edit_ops("a😀b\nx", "a😀B\nx"),
        vec![op(3, None, Some("b")), op(3, Some("B"), None)]
    );
    // é and è share their first UTF-8 byte; the edit still takes the whole character.
    assert_eq!(edit_ops("café", "cafè"), vec![op(3, None, Some("é")), op(3, Some("è"), None)]);
    assert_eq!(edit_ops("x,y", "x,y\n1,2"), vec![op(3, Some("\n1,2"), None)]);
    assert_eq!(edit_ops("same", "same"), vec![]);
}

fn op(p: usize, i: Option<&str>, d: Option<&str>) -> OtOp {
    OtOp { p, i: i.map(str::to_string), d: d.map(str::to_string), u: None }
}

#[test]
fn each_changed_run_of_words_is_its_own_operation_placed_where_the_last_left_off() {
    let before = "One.\nTwo.\nThree.\nFour.\n";
    let after = "One!\nTwo.\nThree.\nAdded.\nFour, longer.\n";
    assert_eq!(
        edit_ops(before, after),
        vec![
            op(3, None, Some(".")),
            op(3, Some("!"), None),
            op(17, Some("Added.\n"), None),
            op(28, Some(", longer"), None),
        ]
    );
}

#[test]
fn the_operations_always_turn_one_text_into_the_other() {
    let texts = [
        "",
        "\n",
        "a",
        "a\n",
        "a\nb",
        "a\nb\n",
        "b\na\n",
        "a\n\n\nb\n",
        "x😀y\nzé\n",
        "\\section{Intro}\nOld sentence one. Old sentence two.\n\nEnd.\n",
        "\\section{Intro}\nThe agent rewrote this.\n\nEnd.\nCoda.",
        "lead\n\\section{Intro}\nOld sentence one. Old sentence two.\n\nEnd.\n",
        "One sentence, then another; a third — and é😀 too.\n",
        "One sentence then, another: a fourth — and è😀 two.\n",
    ];
    for before in texts {
        for after in texts {
            let ops = edit_ops(before, after);
            assert_eq!(applied(before, &ops).as_deref(), Some(after), "{before:?} → {after:?}");
            assert!(ops.iter().all(|op| op.i.is_some() != op.d.is_some()), "{ops:?}");
        }
    }
}

#[test]
fn the_hash_is_the_one_overleaf_computes() {
    // An ASCII document's UTF-16 length is its byte length, which makes it
    // git's blob id.
    assert_eq!(doc_hash(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    assert_eq!(doc_hash("abc"), "f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f");
    // 😀 is two UTF-16 units, four bytes.
    let mut hasher = Sha1::new();
    hasher.update("blob 2\0😀".as_bytes());
    let expected: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(doc_hash("😀"), expected);
}

/// Open the channel for `files` against `held` and send what it takes; the
/// outcome and the paths left to the upload.
fn push(
    remote: &Remote, files: &BTreeMap<String, Vec<u8>>, held: &BTreeMap<String, Vec<u8>>,
) -> Result<(LivePush, BTreeSet<String>), String> {
    let Some(live) = LiveDocs::open(remote, files, held) else {
        return Ok((LivePush::default(), files.keys().cloned().collect()));
    };
    let uploads = files.keys().filter(|path| !live.takes(path)).cloned().collect();
    Ok((live.push(files, held)?, uploads))
}

fn sent(paths: &[&str]) -> LivePush {
    LivePush { sent: paths.iter().map(|p| p.to_string()).collect(), ..LivePush::default() }
}

#[test]
fn every_document_takes_its_edit_over_the_live_channel_and_everything_else_is_left_to_the_upload() {
    let (host, state) = start_mock_serving(project(json!(false)), &["x,y", "1,2"]);
    let ours = files(&[
        ("data.csv", "x,y\n1,2\n3,4"),
        ("main.tex", "x,y\n1,2\n\\end"),
        ("plot.json", "{}"),
        ("new.dat", "1 2"),
    ]);
    let held = files(&[("data.csv", "x,y\n1,2"), ("main.tex", "x,y\n1,2"), ("plot.json", "[]")]);
    let (pushed, uploads) = push(&remote(&host), &ours, &held).unwrap();
    assert_eq!(pushed, sent(&["data.csv", "main.tex"]));
    let expected_uploads = BTreeSet::from(["new.dat".to_string(), "plot.json".to_string()]);
    assert_eq!(uploads, expected_uploads);
    let updates = updates(&state);
    assert_eq!(updates.len(), 2, "{updates:?}");
    assert_eq!(updates[0]["doc"], "doc-data");
    assert_eq!(updates[0]["v"], 42);
    assert_eq!(updates[0]["op"], json!([{"p": 7, "i": "\n3,4"}]));
    assert_eq!(updates[0]["hash"], doc_hash("x,y\n1,2\n3,4"));
    assert!(updates[0].get("meta").is_none(), "{:?}", updates[0]);
    assert_eq!(updates[1]["doc"], "doc-main");
    assert_eq!(doc_text(&state, "doc-data"), ("x,y\n1,2\n3,4".to_string(), 43));
    assert_eq!(doc_text(&state, "doc-main"), ("x,y\n1,2\n\\end".to_string(), 43));
}

const BASE: &str = "\\section{Intro}\nOld intro.\n\nOld body sentence.\n\nOld end.\n";

#[test]
fn a_collaborator_typing_while_the_edit_is_on_its_way_keeps_every_keystroke() {
    let (host, state) = start_mock_serving(project(json!(false)), &[]);
    set_doc(&state, "doc-main", BASE);
    // They type into the paragraph between the two we change, after we have
    // joined and before our operations land, so Overleaf must transform them.
    let at = BASE.find("sentence.").unwrap() + "sentence".len();
    type_after_join(&state, "doc-main", vec![op(at, Some(" Typed meanwhile"), None)]);
    let ours = "\\section{Intro}\nNew intro.\n\nOld body sentence.\n\nNew end.\n";
    let held = files(&[("main.tex", BASE)]);
    let (pushed, _) = push(&remote(&host), &files(&[("main.tex", ours)]), &held).unwrap();
    assert_eq!(pushed, sent(&["main.tex"]));
    let expected =
        "\\section{Intro}\nNew intro.\n\nOld body sentence Typed meanwhile.\n\nNew end.\n";
    assert_eq!(doc_text(&state, "doc-main"), (expected.to_string(), 44));
    // Sent at the version joined, before their edit: Overleaf moved ours past it.
    assert_eq!(updates(&state)[0]["v"], 42);
}

#[test]
fn typing_inside_the_very_line_being_rewritten_is_kept_too() {
    let (host, state) = start_mock_serving(project(json!(false)), &[]);
    set_doc(&state, "doc-main", BASE);
    let at = BASE.find("body").unwrap();
    type_after_join(&state, "doc-main", vec![op(at, Some("TYPED "), None)]);
    let ours = "\\section{Intro}\nOld intro.\n\nThe agent rewrote this.\n\nOld end.\n";
    let held = files(&[("main.tex", BASE)]);
    push(&remote(&host), &files(&[("main.tex", ours)]), &held).unwrap();
    // Where it lands among words that are all new is Overleaf's call; that
    // it lands, whole, beside ours, is the point.
    let (text, _) = doc_text(&state, "doc-main");
    assert!(text.contains("TYPED "), "{text}");
    assert_eq!(text.replacen("TYPED ", "", 1), ours, "{text}");
}

#[test]
fn a_document_that_moved_past_the_copy_planned_against_is_left_for_the_next_sync() {
    let (host, state) = start_mock_serving(project(json!(false)), &[]);
    // Someone typed after the sync read Overleaf's copy and before the join.
    set_doc(&state, "doc-main", &BASE.replace("Old end.", "Old end. Typed since."));
    let ours = BASE.replace("Old intro.", "New intro.");
    let held = files(&[("main.tex", BASE)]);
    let (pushed, uploads) = push(&remote(&host), &files(&[("main.tex", &ours)]), &held).unwrap();
    let stale = BTreeSet::from(["main.tex".to_string()]);
    assert_eq!(pushed, LivePush { stale, ..LivePush::default() });
    assert!(uploads.is_empty());
    assert!(updates(&state).is_empty());
    assert_eq!(doc_text(&state, "doc-main").0, BASE.replace("Old end.", "Old end. Typed since."));
    // So is a document that was not there at all when the sync looked.
    let (pushed, _) = push(&remote(&host), &files(&[("data.csv", "1")]), &BTreeMap::new()).unwrap();
    assert_eq!(pushed.stale, BTreeSet::from(["data.csv".to_string()]));
    assert!(updates(&state).is_empty());
}

#[test]
fn an_edit_overleaf_refuses_fails_rather_than_counting_as_sent() {
    let (host, state) = start_mock_serving(project(json!(false)), &["x,y"]);
    refuse_updates(&state);
    let held = files(&[("main.tex", "x,y")]);
    let error = push(&remote(&host), &files(&[("main.tex", "x,z")]), &held).unwrap_err();
    assert!(error.starts_with("Failed to send \"main.tex\" to Overleaf"), "{error}");
}

#[test]
fn what_overleaf_would_not_store_as_sent_goes_up_as_before_unless_the_upload_loses_the_document() {
    let (host, state) = start_mock_serving(project(json!(false)), &["x,y"]);
    let held = files(&[("main.tex", "x,y"), ("data.csv", "x,y")]);
    for (path, text) in [("main.tex", "x,y 😀"), ("main.tex", "x,y\r\nz")] {
        let (pushed, uploads) = push(&remote(&host), &files(&[(path, text)]), &held).unwrap();
        assert_eq!((pushed, uploads), (LivePush::default(), BTreeSet::from([path.to_string()])));
    }
    // Overleaf will store U+FFFD in its place, so no hash goes with it.
    let (pushed, _) = push(&remote(&host), &files(&[("data.csv", "x,y 😀")]), &held).unwrap();
    assert_eq!(pushed, sent(&["data.csv"]));
    assert!(updates(&state)[0].get("hash").is_none(), "{:?}", updates(&state));
}

#[test]
fn the_edit_is_a_suggestion_when_the_project_tracks_this_accounts_changes() {
    let (host, state) = start_mock_serving(project(json!({"user-1": true})), &["x,y"]);
    push(&remote(&host), &files(&[("data.csv", "x,z")]), &files(&[("data.csv", "x,y")])).unwrap();
    let updates = updates(&state);
    assert!(updates[0]["meta"]["tc"].is_string(), "{updates:?}");
}

#[test]
fn a_session_stored_without_its_account_id_still_suggests_when_tracked() {
    let (host, state) = start_mock_serving(project(json!({MOCK_USER_ID: true})), &["x,y"]);
    let (config, root) = (TempDir::new("doc-push-config"), TempDir::new("doc-push-project"));
    let session = SessionFile { user_id: None, ..remote(&host).session };
    save_session(&config, &session).unwrap();
    save_state(&root, &remote(&host).state).unwrap();
    let linked = Remote::open_for_sync(&config, &root).unwrap();
    push(&linked, &files(&[("data.csv", "x,z")]), &files(&[("data.csv", "x,y")])).unwrap();
    let updates = updates(&state);
    assert!(updates[0]["meta"]["tc"].is_string(), "{updates:?}");
    // Looked up once: the next sync reads it from the stored session.
    assert_eq!(load_session(&config).unwrap().user_id.as_deref(), Some(MOCK_USER_ID));
}

#[test]
fn without_the_live_channel_everything_is_left_to_the_upload_as_before() {
    let hits = Arc::new(Mutex::new(0));
    let seen = Arc::clone(&hits);
    let host = serve_http(move |request| {
        *seen.lock().unwrap() += 1;
        let _ = request.respond(tiny_http::Response::empty(404));
    });
    let remote = remote(&host);
    // Nothing that could be a document: the live channel is not even tried.
    let binary = BTreeMap::from([("figure.pdf".to_string(), vec![0xff, 0xfe])]);
    assert!(LiveDocs::open(&remote, &binary, &BTreeMap::new()).is_none());
    assert_eq!(*hits.lock().unwrap(), 0);
    let text = files(&[("main.tex", "x,z")]);
    assert!(LiveDocs::open(&remote, &text, &files(&[("main.tex", "x,y")])).is_none());
    assert!(*hits.lock().unwrap() > 0);
}
