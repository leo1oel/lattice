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

#[test]
fn an_agents_rewrite_of_the_paragraph_a_co_author_is_typing_in_keeps_both() {
    // The Twitter question: the agent rewrites a paragraph on disk while a
    // co-author types in that same paragraph on Overleaf. Their keystrokes
    // land after we join and before our operations do, and the project's
    // history version moves meanwhile, which used to stand an upload down
    // (or, a moment later, let it replace their words). Sent as operations,
    // Overleaf transforms ours past theirs: both survive, nothing uploads.
    let live = live_project();
    set_doc(&live, "doc-main", BASE);
    let (_, typing) = insert_after(BASE, "Middle", " (co-author typing)");
    type_after_join(&live, "doc-main", vec![typing]);
    let mock = Mock {
        realtime: Some(live.clone()),
        versions: vec![11, 12],
        ..Mock::project(&[("main.tex", BASE.as_bytes())])
    };
    let rewritten = "Intro.\n\nThe agent rewrote the middle paragraph.\n\nEnd.\n";
    let (server, root, result) =
        run_sync(mock, &[("main.tex", rewritten.as_bytes())], &[("main.tex", BASE.as_bytes())]);
    assert_eq!(result.pushed, ["main.tex"]);
    assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);
    assert!(server.uploads().is_empty(), "{:?}", server.uploads());
    let (text, _) = doc_text(&live, "doc-main");
    // Where their words land among ours is Overleaf's call; that they land
    // whole, beside every word of the rewrite, is the contract.
    assert_eq!(text.matches(" (co-author typing)").count(), 1, "{text}");
    assert_eq!(text.replacen(" (co-author typing)", "", 1), rewritten, "{text}");
    assert_eq!(read_local(&root, "main.tex").unwrap(), rewritten.as_bytes());
}

// Without the live channel (a network or proxy that blocks WebSockets), a
// document Overleaf holds goes up whole, so each one goes only while the
// project's history version still holds, read again just before it and just
// after. The mock answers one version per read, in the order a sync reads
// them: the snapshot, then before the first upload and after each one.

const COAUTHOR: &str = "Intro.\n\nMiddle.\n\nEnd, typed on Overleaf.\n";
const OURS: &str = "Intro, edited here.\n\nMiddle.\n\nEnd.\n";

#[test]
fn a_co_author_edit_landing_before_the_upload_stands_it_down_and_the_next_sync_merges_it() {
    // They typed after our snapshot and before the upload: Overleaf's copy
    // is no longer the one we planned against, so nothing goes up.
    let mock = Mock {
        versions: vec![11, 12],
        later_zip: Some(build_zip(&[("main.tex", COAUTHOR.as_bytes())])),
        ..Mock::project(&[("main.tex", BASE.as_bytes())])
    };
    let server = mock.serve();
    let (config, root) =
        linked(&server, &[("main.tex", OURS.as_bytes())], &[("main.tex", BASE.as_bytes())]);
    let first = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(first.pushed.is_empty() && server.uploads().is_empty());
    assert!(first.uploaded_over_edits.is_empty());
    assert_eq!(state_files(&root)["main.tex"], sha256_hex(BASE.as_bytes()));

    // The next sync downloads their edit, merges ours into it, and sends both.
    let second = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(second.merged, ["main.tex"]);
    assert_eq!(second.pushed, ["main.tex"]);
    assert!(second.uploaded_over_edits.is_empty());
    let both = "Intro, edited here.\n\nMiddle.\n\nEnd, typed on Overleaf.\n";
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 1);
    assert!(uploads[0].body_text().contains(both), "{}", uploads[0].body_text());
    assert_eq!(read_local(&root, "main.tex").unwrap(), both.as_bytes());
}

#[test]
fn a_co_author_edit_landing_during_the_upload_is_reported_once_for_the_sync() {
    // Two documents. Their edit lands while `a.tex` goes up: the version
    // after it moved by more than our one upload. `a.tex` may have replaced
    // their words, which is named; `b.tex` waits for the next sync.
    let base: Files = &[("a.tex", BASE.as_bytes()), ("b.tex", BASE.as_bytes())];
    let local: Files = &[("a.tex", OURS.as_bytes()), ("b.tex", OURS.as_bytes())];
    let mock = Mock { versions: vec![11, 11, 13], ..Mock::project(base) };
    let (server, root, result) = run_sync(mock, local, base);
    assert_eq!(result.pushed, ["a.tex"]);
    assert_eq!(result.uploaded_over_edits, ["a.tex"]);
    assert_eq!(server.uploads().len(), 1);
    assert_eq!(state_files(&root)["b.tex"], sha256_hex(BASE.as_bytes()));
}

#[test]
fn documents_uploaded_while_overleaf_holds_still_report_nothing() {
    let base: Files = &[("a.tex", BASE.as_bytes()), ("b.tex", BASE.as_bytes())];
    let local: Files =
        &[("a.tex", OURS.as_bytes()), ("b.tex", OURS.as_bytes()), ("new.tex", b"New.\n")];
    // Each of our uploads moves the version by one, or Overleaf reports it
    // late and the version stays put: neither is anyone else's edit.
    for versions in [vec![11, 11, 12, 13], vec![11]] {
        let mock = Mock { versions, ..Mock::project(base) };
        let (server, _root, result) = run_sync(mock, local, base);
        assert_eq!(result.pushed, ["a.tex", "b.tex", "new.tex"]);
        assert!(result.uploaded_over_edits.is_empty(), "{:?}", result.uploaded_over_edits);
        assert_eq!(server.uploads().len(), 3);
    }
}

// A history that keeps its versions per document reports, for the project,
// only the newest edit's timestamp in milliseconds. Our own upload moves that
// as far as anyone's edit would, so it can tell only whether Overleaf moved
// before the first upload.

/// A moment in milliseconds, as `meta.end_ts` reports it.
const AT: i64 = 1_700_000_000_000;

#[test]
fn a_history_of_timestamps_sends_every_document_in_one_sync_without_a_false_report() {
    let base: Files = &[("a.tex", BASE.as_bytes()), ("b.tex", BASE.as_bytes())];
    let local: Files =
        &[("a.tex", OURS.as_bytes()), ("b.tex", OURS.as_bytes()), ("new.tex", b"New.\n")];
    // The snapshot, before the first upload, and after each: the stamp jumps
    // by seconds with each of our own uploads.
    let versions = vec![AT, AT, AT + 4_000, AT + 9_000];
    let mock = Mock { versions, stamped: true, ..Mock::project(base) };
    let (server, root, result) = run_sync(mock, local, base);
    assert_eq!(result.pushed, ["a.tex", "b.tex", "new.tex"]);
    assert!(result.uploaded_over_edits.is_empty(), "{:?}", result.uploaded_over_edits);
    assert_eq!(server.uploads().len(), 3);
    assert_eq!(state_files(&root)["b.tex"], sha256_hex(OURS.as_bytes()));
}

#[test]
fn a_history_of_timestamps_still_stands_down_when_overleaf_moved_before_the_uploads() {
    let base: Files = &[("a.tex", BASE.as_bytes())];
    let local: Files = &[("a.tex", OURS.as_bytes()), ("new.tex", b"New.\n")];
    let mock = Mock { versions: vec![AT, AT + 3_000], stamped: true, ..Mock::project(base) };
    let (server, root, result) = run_sync(mock, local, base);
    assert!(result.pushed.is_empty(), "{:?}", result.pushed);
    assert!(result.uploaded_over_edits.is_empty());
    assert!(server.uploads().is_empty());
    assert_eq!(state_files(&root)["a.tex"], sha256_hex(BASE.as_bytes()));
}

#[test]
fn text_overleaf_keeps_as_a_file_goes_up_beside_a_document_without_a_false_report() {
    // Overleaf replaces a file entity by adding a fresh one and renaming the
    // old one away, two history updates for one upload; a document's
    // upload is one. Nobody else edits, so nothing may be reported.
    let fig = b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n".as_slice();
    let base: Files = &[("fig.eps", fig), ("main.tex", BASE.as_bytes())];
    let local: Files =
        &[("fig.eps", b"%!PS-Adobe-3.0 EPSF-3.0\n%regenerated\n"), ("main.tex", OURS.as_bytes())];
    let moves = |name: &str| if name == "fig.eps" { 2 } else { 1 };
    let mock = Mock { versions: vec![11], upload_moves: Some(moves), ..Mock::project(base) };
    let (server, root, result) = run_sync(mock, local, base);
    assert_eq!(result.pushed, ["fig.eps", "main.tex"]);
    assert!(result.uploaded_over_edits.is_empty(), "{:?}", result.uploaded_over_edits);
    assert_eq!(server.uploads().len(), 2);
    assert_eq!(state_files(&root)["main.tex"], sha256_hex(OURS.as_bytes()));
}
