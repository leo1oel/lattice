//! Suggestions riding along with the text: a suggested deletion is a point
//! (its text has left the document), a suggested insertion is a span, and an
//! edit sent as a suggestion adds to them the way Overleaf's review panel
//! shows it. Ported case for case from the Tauri app's
//! `src/overleaf/overleaf-suggestions.test.ts`.

use super::*;
use crate::overleaf_rt::ot::{apply_ops, delete, insert};

fn ada() -> Suggester {
    Suggester { user_id: Some("ada".into()), hue: 30 }
}

fn grace() -> Suggester {
    Suggester { user_id: Some("grace".into()), hue: 250 }
}

fn change(position: i64, text: &str, by: &Suggester, id: &str, deletion: bool) -> TrackedChange {
    TrackedChange {
        id: id.into(),
        position,
        text: text.into(),
        deletion,
        user_id: by.user_id.clone(),
        timestamp: None,
        hue: by.hue,
    }
}

fn insertion(position: i64, text: &str) -> TrackedChange {
    change(position, text, &grace(), "ins", false)
}

fn deletion(position: i64, text: &str) -> TrackedChange {
    change(position, text, &grace(), "del", true)
}

/// What review shows for `changes`: each one's kind, where it sits and its
/// text, sorted as the TS test sorts them.
fn shown(changes: &[TrackedChange]) -> Vec<String> {
    let mut shown: Vec<String> = changes
        .iter()
        .map(|change| {
            let kind = if change.deletion { "-" } else { "+" };
            format!("{kind}{}:{}", change.position, change.text)
        })
        .collect();
    shown.sort();
    shown
}

/// Apply `ops` to `text` as suggestions from `by` (or as ordinary edits),
/// checking each suggested insertion still spans its text.
fn edit(
    text: &str, changes: &[TrackedChange], ops: &[OtOp], by: Option<&Suggester>,
) -> (String, Vec<TrackedChange>) {
    let after = apply_ops(text, ops).expect("ops fit the text");
    let next = changes_after(changes, ops, by, "2026-10-22T00:00:00.000Z");
    for change in next.iter().filter(|change| !change.deletion) {
        let from = change.position;
        let to = from + change.text.encode_utf16().count() as i64;
        assert_eq!(slice(&after, from, to), change.text, "{change:?} spans its text");
    }
    (after, next)
}

#[test]
fn ordinary_edits_keep_a_suggested_deletion_as_a_point() {
    // "The brown fox", with "quick " suggested away at 4: text after it moves
    // nothing, text before moves it.
    let removed = [deletion(4, "quick ")];
    let at = |op| shown(&edit("The brown fox", &removed, &[op], None).1);
    assert_eq!(at(delete(4, "brown ")), ["-4:quick "]);
    assert_eq!(at(insert(10, "red ")), ["-4:quick "]);
    assert_eq!(at(insert(0, "See: ")), ["-9:quick "]);
    assert_eq!(at(delete(0, "The ")), ["-0:quick "]);
}

#[test]
fn ordinary_edits_never_drop_a_deletion_nor_type_inside_it() {
    let removed = [deletion(4, "quick ")];
    // Used to read as a five-character span that "lost" its text and
    // vanished here while the suggestion still stood on Overleaf.
    let (_, changes) = edit("The brown fox", &removed, &[delete(2, "e brown")], None);
    assert_eq!(shown(&changes), ["-2:quick "]);
    // Typed at the point it follows the removed text, as a replacement reads.
    let (_, changes) = edit("The brown fox", &removed, &[insert(4, "fast ")], None);
    assert_eq!(shown(&changes), ["-4:quick "]);
}

#[test]
fn ordinary_edits_keep_an_insertion_in_step_and_drop_it_once_gone() {
    let added = [insertion(4, "quick ")];
    let at = |op| shown(&edit("The quick brown fox", &added, &[op], None).1);
    assert_eq!(at(delete(6, "ic")), ["+4:quk "]);
    assert_eq!(at(delete(2, "e qu")), ["+2:ick "]);
    assert_eq!(at(insert(6, "XX")), ["+4:quXXick "]);
    // Typing at either edge stays outside it.
    assert_eq!(at(insert(4, "a ")), ["+6:quick "]);
    assert_eq!(at(insert(10, "a ")), ["+4:quick "]);
    let (_, changes) = edit("The quick brown fox", &added, &[delete(3, " quick b")], None);
    assert!(changes.is_empty());
}

#[test]
fn ordinary_edits_move_comments_and_leave_untouched_changes_as_they_were() {
    let untouched = insertion(10, "brown");
    let comments = [CommentRange { thread_id: "t".into(), position: 16, quote: "fox".into() }];
    let ops = [insert(19, "!")];
    assert_eq!(comments_after(&comments, &ops)[0].position, 16);
    let changes = changes_after(&[untouched.clone()], &ops, None, "now");
    assert_eq!(changes[0], untouched);
    // An insert before the span moves it; a delete across its start pulls it
    // back to where the delete began.
    assert_eq!(comments_after(&comments, &[insert(0, "ab")])[0].position, 18);
    assert_eq!(comments_after(&comments, &[delete(14, "xxx")])[0].position, 14);
}

#[test]
fn suggested_deletion_records_the_removed_text_at_its_point() {
    // The report's 'quick ' case.
    let (text, changes) = edit("The quick brown fox", &[], &[delete(4, "quick ")], Some(&ada()));
    assert_eq!(text, "The brown fox");
    assert_eq!(changes.len(), 1);
    let change = &changes[0];
    assert_eq!((change.position, change.text.as_str(), change.deletion), (4, "quick ", true));
    assert_eq!((change.user_id.as_deref(), change.hue), (Some("ada"), 30));
    assert!(is_provisional(change));
}

#[test]
fn suggested_typing_extends_the_suggesters_own_insertion() {
    let (text, changes) = edit("The fox", &[], &[insert(4, "qu")], Some(&ada()));
    assert_eq!(shown(&changes), ["+4:qu"]);
    let (text, changes) = edit(&text, &changes, &[insert(6, "ick ")], Some(&ada()));
    assert_eq!(shown(&changes), ["+4:quick "]);
    // Someone else typing at its edge starts their own.
    let (_, changes) = edit(&text, &changes, &[insert(10, "brown ")], Some(&grace()));
    assert_eq!(shown(&changes), ["+10:brown ", "+4:quick "]);
}

#[test]
fn a_suggestion_inside_someone_elses_insertion_splits_it() {
    let (_, changes) =
        edit("The quick fox", &[insertion(4, "quick ")], &[insert(6, "ZZ")], Some(&ada()));
    assert_eq!(shown(&changes), ["+4:qu", "+6:ZZ", "+8:ick "]);
    let rest = changes.iter().find(|change| change.text == "ick ").unwrap();
    assert_eq!(rest.user_id.as_deref(), Some("grace"));
}

#[test]
fn deleting_suggested_text_again_withdraws_it() {
    let own = change(4, "quick ", &ada(), "ins", false);
    let (text, changes) =
        edit("The quick brown fox", &[own], &[delete(2, "e quick b")], Some(&ada()));
    assert_eq!(text, "Thrown fox");
    // Only the text that was really in the document becomes a deletion.
    assert_eq!(shown(&changes), ["-2:e b"]);
}

#[test]
fn backspacing_and_forward_deleting_read_as_one_deletion_in_order() {
    let mut state = ("The quick brown fox".to_string(), Vec::new());
    for op in [delete(8, "k"), delete(7, "c"), delete(4, "qui")] {
        state = edit(&state.0, &state.1, &[op], Some(&ada()));
    }
    assert_eq!(shown(&state.1), ["-4:quick"]);
    for op in [delete(4, " "), delete(4, "brown")] {
        state = edit(&state.0, &state.1, &[op], Some(&ada()));
    }
    assert_eq!(shown(&state.1), ["-4:quick brown"]);
}

#[test]
fn another_suggesters_deletion_stays_separate() {
    let (_, changes) =
        edit("The brown fox", &[deletion(4, "quick ")], &[delete(3, " brown")], Some(&ada()));
    assert_eq!(shown(&changes), ["-3: brown", "-3:quick "]);
    let theirs = changes.iter().find(|change| change.text == "quick ").unwrap();
    assert_eq!(theirs.id, "del");
}

#[test]
fn each_op_of_a_composed_operation_applies_to_what_the_last_left() {
    let (text, changes) = edit("abcdef", &[], &[insert(1, "XY"), delete(5, "de")], Some(&ada()));
    assert_eq!(text, "aXYbcf");
    assert_eq!(shown(&changes), ["+1:XY", "-5:de"]);
}

#[test]
fn positions_count_utf16_units() {
    // "é" is one unit, "🔵" two: an insertion after the emoji starts at 3.
    let added = [change(3, "ab", &grace(), "ins", false)];
    let (_, changes) = edit("é🔵ab!", &added, &[insert(0, "🔵")], None);
    assert_eq!(shown(&changes), ["+5:ab"]);
}
