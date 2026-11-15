//! What a round asks about, and the order its proposals are walked in.

use super::*;

fn note(id: &str, number: u32, path: &str, from: u32, state: Option<&str>) -> EditorComment {
    let mut comment: EditorComment = serde_json::from_value(serde_json::json!({
        "id": id, "number": number, "path": path, "from": from, "to": from + 4,
        "quote": "text", "body": "note", "authorId": "a", "authorName": "A",
        "createdAt": "1", "updatedAt": "1"
    }))
    .unwrap();
    comment.revision = state.map(|state| AnnotationRevision {
        round: 1,
        state: state.into(),
        original: None,
        text: None,
        reason: None,
        question: None,
        answer: None,
        error: None,
    });
    comment
}

// annotation-rounds.ts's `revisable`: a numbered, open note with no
// proposal waiting and no unanswered question.
#[test]
fn what_a_round_asks_about() {
    let none = |_: &str| false;
    assert!(revisable(&note("a", 1, "a.tex", 0, None), &none));
    assert!(!revisable(&note("a", 0, "a.tex", 0, None), &none));
    assert!(!revisable(&note("a", 1, "a.tex", 0, Some("proposed")), &none));
    assert!(!revisable(&note("a", 1, "a.tex", 0, Some("asked")), &none));
    assert!(revisable(&note("a", 1, "a.tex", 0, Some("rejected")), &none));
    assert!(!revisable(&note("a", 1, "a.tex", 0, None), &|id| id == "a"));
    let mut answered = note("a", 1, "a.tex", 0, Some("asked"));
    answered.revision.as_mut().unwrap().answer = Some("yes".into());
    assert!(revisable(&answered, &none));
}

#[test]
fn proposals_are_walked_by_file_then_place() {
    let notes = [
        note("c", 3, "b.tex", 0, Some("proposed")),
        note("b", 2, "a.tex", 9, Some("proposed")),
        note("a", 1, "a.tex", 2, Some("proposed")),
        note("d", 4, "a.tex", 1, Some("rejected")),
    ];
    let refs: Vec<&EditorComment> = notes.iter().collect();
    let order: Vec<String> = pending_proposals(&refs).into_iter().map(|comment| comment.id).collect();
    assert_eq!(order, ["a", "b", "c"]);
}
