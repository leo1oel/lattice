//! Sending: documents over the live channel, as operations Overleaf transforms
//! against a co-author's concurrent typing, and everything else by upload,
//! only while Overleaf holds still.

use super::*;
use crate::overleaf_rt::mock_server::{
    doc_text, realtime_state, sent_updates, set_doc, type_after_join, MockState,
};
use crate::overleaf_rt::OtOp;
use std::sync::{Arc, Mutex};

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
        // Standing down keeps the copy it planned against, so the very next
        // sync re-detects the local edit and sends it merged with theirs.
        let agreed: &[u8] = if uploaded { b"locally edited" } else { base };
        assert_eq!(recorded, Some(sha256_hex(agreed)));
    }
}

/// The project as the live channel has it: three documents and a figure.
fn live_project() -> Arc<Mutex<MockState>> {
    let project = json!({
        "_id": "proj-1",
        "name": "Paper",
        "rootFolder": [{
            "_id": "root-1",
            "name": "rootFolder",
            "docs": [
                {"_id": "doc-main", "name": "main.tex"},
                {"_id": "doc-other", "name": "other.tex"},
                {"_id": "doc-data", "name": "data.csv"}
            ],
            "fileRefs": [{"_id": "file-1", "name": "figure.png"}],
            "folders": []
        }]
    });
    realtime_state(project, &[])
}

const BASE: &str = "Intro.\n\nMiddle.\n\nEnd.\n";
/// A co-author's edit Overleaf already had when the sync downloaded it.
const THEIRS: &str = "Intro.\n\nMiddle, edited on Overleaf.\n\nEnd.\n";
/// The agent's edit on disk, to other paragraphs.
const AGENTS: &str = "Intro, by the agent.\n\nMiddle.\n\nEnd, by the agent.\n";
const MERGED: &str = "Intro, by the agent.\n\nMiddle, edited on Overleaf.\n\nEnd, by the agent.\n";

fn insert_after(text: &str, anchor: &str, typed: &str) -> (String, OtOp) {
    let at = text.find(anchor).unwrap() + anchor.len();
    let op = OtOp { p: at, i: Some(typed.into()), d: None, u: None };
    (format!("{}{typed}{}", &text[..at], &text[at..]), op)
}

#[test]
fn a_merge_goes_up_as_operations_and_a_co_author_typing_meanwhile_keeps_every_keystroke() {
    let live = live_project();
    set_doc(&live, "doc-main", THEIRS);
    set_doc(&live, "doc-other", "Para, theirs.\n");
    set_doc(&live, "doc-data", "x,y\n");
    // They keep typing after we join, before our operations land.
    let (_, typing) = insert_after(THEIRS, "Overleaf", ", still typing");
    type_after_join(&live, "doc-main", vec![typing]);
    let remote: Files = &[
        ("main.tex", THEIRS.as_bytes()),
        ("other.tex", b"Para, theirs.\n"),
        ("data.csv", b"x,y\n"),
    ];
    let mock =
        Mock { realtime: Some(live.clone()), versions: vec![11, 12], ..Mock::project(remote) };
    let local: Files = &[
        ("main.tex", AGENTS.as_bytes()),
        ("other.tex", b"Para, ours.\n"),
        ("data.csv", b"x,y\n1,2\n"),
    ];
    let base: Files =
        &[("main.tex", BASE.as_bytes()), ("other.tex", b"Para.\n"), ("data.csv", b"x,y\n")];
    let (server, root, result) = run_sync(mock, local, base);

    assert_eq!(result.merged, ["main.tex"]);
    assert_eq!(result.pushed, ["data.csv", "main.tex"]);
    // No upload: nothing replaced a document, so nobody was told one was
    // updated externally, and the moving project version stood nothing down.
    assert!(server.uploads().is_empty(), "{:?}", server.uploads());
    let (expected, _) = insert_after(MERGED, "Overleaf", ", still typing");
    assert_eq!(doc_text(&live, "doc-main").0, expected);
    assert_eq!(doc_text(&live, "doc-data").0, "x,y\n1,2\n");
    // The conflict never left this machine.
    assert_eq!(result.conflicts.len(), 1);
    assert!(sent_updates(&live).iter().all(|update| update["doc"] != "doc-other"));
    assert_eq!(doc_text(&live, "doc-other"), ("Para, theirs.\n".to_string(), 42));
    // What we sent is the new base; their keystrokes come down next time.
    assert_eq!(read_local(&root, "main.tex").unwrap(), MERGED.as_bytes());
    assert_eq!(state_files(&root)["main.tex"], sha256_hex(MERGED.as_bytes()));
}

#[test]
fn a_merge_overleaf_moved_past_sends_nothing_and_merges_again_on_the_next_sync() {
    let live = live_project();
    // They typed after the download and before the join: the merge was
    // planned against text Overleaf no longer holds.
    let (moved, _) = insert_after(THEIRS, "Overleaf", ", typed since");
    set_doc(&live, "doc-main", &moved);
    let mock = Mock {
        realtime: Some(live.clone()),
        later_zip: Some(build_zip(&[("main.tex", moved.as_bytes())])),
        ..Mock::project(&[("main.tex", THEIRS.as_bytes())])
    };
    let server = mock.serve();
    let (config, root) =
        linked(&server, &[("main.tex", AGENTS.as_bytes())], &[("main.tex", BASE.as_bytes())]);
    let first = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(first.merged, ["main.tex"]);
    assert!(first.pushed.is_empty());
    assert!(sent_updates(&live).is_empty() && server.uploads().is_empty());
    assert_eq!(doc_text(&live, "doc-main"), (moved.clone(), 42));

    // The merge stays a local edit on the copy it merged with, so the next
    // sync folds in only what they typed since: no conflict, nothing lost.
    let second = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(second.conflicts.is_empty(), "{:?}", second.conflicts);
    assert_eq!(second.pushed, ["main.tex"]);
    let (expected, _) = insert_after(MERGED, "Overleaf", ", typed since");
    assert_eq!(doc_text(&live, "doc-main").0, expected);
    assert_eq!(read_local(&root, "main.tex").unwrap(), expected.as_bytes());
    assert!(server.uploads().is_empty());
}

#[test]
fn a_new_file_and_a_binary_one_are_still_uploaded_next_to_documents_sent_live() {
    let live = live_project();
    set_doc(&live, "doc-main", BASE);
    let remote: Files = &[("main.tex", BASE.as_bytes()), ("figure.png", b"\x89PNG old")];
    let mock = Mock { realtime: Some(live.clone()), ..Mock::project(remote) };
    let local: Files = &[
        ("main.tex", AGENTS.as_bytes()),
        ("figure.png", b"\x89PNG new"),
        ("new.tex", b"\\section{New}\n"),
    ];
    let (server, _root, result) = run_sync(mock, local, remote);
    assert_eq!(result.pushed, ["figure.png", "main.tex", "new.tex"]);
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 2, "{uploads:?}");
    assert!(uploads.iter().all(|upload| !upload.body_text().contains("main.tex")));
    assert_eq!(doc_text(&live, "doc-main").0, AGENTS);
}
