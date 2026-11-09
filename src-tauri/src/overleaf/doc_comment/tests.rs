use super::*;
use crate::overleaf::account::SessionFile;
use crate::overleaf::link::SyncState;
use crate::overleaf_rt::mock_server::{
    refuse_updates, sent_event_names, sent_updates, set_doc, start_mock_serving, type_after_join,
};
use crate::overleaf_rt::OtOp;
use serde_json::{json, Value};
use std::cell::Cell;

const ABSTRACT: &str =
    "\\begin{abstract}\nWe show that it works. We show that it scales.\n\\end{abstract}\n";

fn at(text: &str, needle: &str) -> usize {
    text[..text.find(needle).unwrap()].encode_utf16().count()
}

#[test]
fn the_passage_is_where_lattice_found_it_when_both_copies_agree() {
    let from = at(ABSTRACT, "it scales");
    assert_eq!(place(ABSTRACT, from, "it scales", ABSTRACT), Some(from));
    // Lattice's copy must read the quote where it says it does.
    assert_eq!(place(ABSTRACT, from + 1, "it scales", ABSTRACT), None);
    assert_eq!(place(ABSTRACT, from, "", ABSTRACT), None);
}

#[test]
fn a_repeated_passage_is_carried_through_edits_elsewhere_to_the_same_occurrence() {
    // "We show that it" twice: the second one is meant, and Overleaf's copy
    // gained a line above it and lost a word between the two.
    let from = at(ABSTRACT, "We show that it scales");
    let held = ABSTRACT
        .replace("\\begin{abstract}\n", "\\begin{abstract}\n% typed by a co-author\n")
        .replace("it works.", "works.");
    let placed = place(ABSTRACT, from, "We show that it", &held).unwrap();
    assert_eq!(placed, at(&held, "We show that it scales"));
    // And edits after it leave it where it was.
    let held = ABSTRACT.replace("\\end{abstract}", "More.\n\\end{abstract}");
    assert_eq!(place(ABSTRACT, from, "We show that it", &held), Some(from));
}

#[test]
fn a_passage_the_edit_rewrote_is_found_only_where_it_occurs_once() {
    // A co-author typed inside the passage, so the edit cannot carry it, but
    // the words commented on are still there once: that is where it goes.
    let held = "Alpha Alpha beta.\n";
    assert_eq!(place("Alpha beta.\n", 0, "Alpha beta", held), Some(6));
    // Overleaf's copy holds them twice and the edit touched the passage: no
    // single place, so nothing is guessed.
    let ours = "One two three. Four.\n";
    let held = "One two three. One two three.\n";
    assert_eq!(place(ours, at(ours, "Four"), "Four", held), None);
    assert_eq!(place("x one y\n", 2, "one", "x 1 y one one\n"), None);
    // Gone altogether.
    assert_eq!(place(ours, 0, "One", "Nothing alike.\n"), None);
}

#[test]
fn a_rewritten_passage_lattice_reads_twice_is_not_moved_onto_its_twin() {
    // The second "We show A" is meant; a co-author rewrote it on Overleaf, so
    // the one "We show A" Overleaf still holds is the first sentence, not it.
    let ours = "We show A. Then B. We show A.\n";
    let held = "We show A. Then B. We prove A.\n";
    let second = ours.rfind("We show A").unwrap();
    assert_eq!(place(ours, second, "We show A", held), None);
}

#[test]
fn positions_count_utf16_units_as_overleaf_does() {
    let ours = "😀 é text here\n";
    let from = at(ours, "text");
    assert_eq!(from, 5);
    let held = "😀😀 é text here\n";
    assert_eq!(place(ours, from, "text", held), Some(7));
}

/// The abstract and the main text, each a document.
fn project() -> Value {
    json!({
        "_id": "proj-1",
        "name": "Paper",
        "rootFolder": [{
            "_id": "root-1",
            "name": "rootFolder",
            "docs": [{"_id": "doc-main", "name": "main.tex"}, {"_id": "doc-abstract", "name": "abstract.tex"}],
            "fileRefs": [],
            "folders": []
        }]
    })
}

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
        state: SyncState { host: host.into(), project_id: "proj-1".into(), ..Default::default() },
        host: host.into(),
    }
}

/// Comment on `quote` at `from` of `ours`, counting the messages posted.
fn comment(
    host: &str, ours: &str, from: usize, quote: &str, posted: &Cell<usize>,
) -> Result<CommentPlacement, String> {
    let (client, events) = connect_channel(&remote(host))?;
    let post = || {
        posted.set(posted.get() + 1);
        Ok(())
    };
    let placed = anchor(&client, &events, "doc-abstract", ours, from, quote, "thread-9", post);
    client.shutdown();
    placed
}

#[test]
fn a_comment_on_a_file_not_open_joins_it_anchors_at_the_joined_version_and_leaves() {
    let (host, state) = start_mock_serving(project(), &[]);
    set_doc(&state, "doc-main", "\\input{abstract}\n");
    // Overleaf's copy has a line Lattice's lacks, and a co-author types above
    // the passage after we join: the anchor still goes at the version joined.
    let held = ABSTRACT.replace("\\begin{abstract}\n", "\\begin{abstract}\n% note\n");
    set_doc(&state, "doc-abstract", &held);
    let typed = OtOp { p: 0, i: Some("% hi\n".into()), d: None, u: None };
    type_after_join(&state, "doc-abstract", vec![typed]);
    let posted = Cell::new(0);
    let from = at(ABSTRACT, "it scales");
    assert_eq!(comment(&host, ABSTRACT, from, "it scales", &posted), Ok(CommentPlacement::Placed));
    assert_eq!(posted.get(), 1);
    let updates = sent_updates(&state);
    assert_eq!(updates.len(), 1, "{updates:?}");
    assert_eq!(updates[0]["doc"], "doc-abstract");
    assert_eq!(updates[0]["v"], 42);
    let position = at(&held, "it scales");
    assert_eq!(updates[0]["op"], json!([{"p": position, "c": "it scales", "t": "thread-9"}]));
    let names = sent_event_names(&state);
    let order: Vec<&str> = (names.iter().map(String::as_str))
        .filter(|name| ["joinDoc", "applyOtUpdate", "leaveDoc"].contains(name))
        .collect();
    assert_eq!(order, ["joinDoc", "applyOtUpdate", "leaveDoc"]);
}

#[test]
fn a_passage_overleaf_does_not_hold_posts_nothing() {
    let (host, state) = start_mock_serving(project(), &[]);
    set_doc(&state, "doc-abstract", "\\begin{abstract}\nRewritten entirely.\n\\end{abstract}\n");
    let posted = Cell::new(0);
    let from = at(ABSTRACT, "it scales");
    assert_eq!(
        comment(&host, ABSTRACT, from, "it scales", &posted),
        Ok(CommentPlacement::NotFound)
    );
    assert_eq!(posted.get(), 0);
    assert!(sent_updates(&state).is_empty());
}

#[test]
fn an_anchor_overleaf_refuses_is_an_error_not_a_placed_comment() {
    let (host, state) = start_mock_serving(project(), &[]);
    set_doc(&state, "doc-abstract", ABSTRACT);
    refuse_updates(&state);
    let posted = Cell::new(0);
    let from = at(ABSTRACT, "it scales");
    assert!(comment(&host, ABSTRACT, from, "it scales", &posted).is_err());
}
