//! Entries sharing a key, picked by their place.

use super::*;

/// Two entries under one key, as a merged bibliography has them: the
/// second, picked by its place, is the one a delete takes away.
#[test]
fn the_second_of_two_entries_sharing_a_key_is_the_one_acted_on() {
    let text = "@article{smith2020,\n  title = {First}\n}\n\n@inproceedings{smith2020,\n  title = {Second}\n}\n";
    let parsed = parse_rows(text.to_string());
    let second = model::row_at(&parsed.rows, "smith2020", 1).unwrap();
    assert_eq!(second.summary.title, "Second");
    let edit = bib_document::delete_entry_edit(text, &second.entry);
    let left = bib_document::apply_edit(text, &edit);
    assert_eq!(left, "@article{smith2020,\n  title = {First}\n}\n");
    // A place no longer under that key falls back to its first entry.
    assert_eq!(
        model::row_at(&parsed.rows, "smith2020", 7).unwrap().index,
        0
    );
}

/// The second of two `smith2020` entries, picked by its place: a field
/// written lands in it, and once it is deleted and the first edited,
/// it goes back between the first and `other`, where it stood.
#[test]
fn the_second_of_a_shared_key_is_edited_deleted_and_restored_in_place() {
    let first = "@article{smith2020,\n  title = {First}\n}\n\n";
    let second = "@inproceedings{smith2020,\n  title = {Second}\n}\n\n";
    let other = "@misc{other,\n  title = {Other}\n}\n";
    let text = format!("{first}{second}{other}");
    let rows = parse_rows(text.clone()).rows;
    let picked = model::row_at(&rows, "smith2020", 1).unwrap();
    let title = &picked.entry.fields[0];
    let edited = bib_document::apply_edit(
        &text,
        &bib_document::replace_value_edit(title, "{Second, revised}"),
    );
    assert_eq!(edited, text.replace("{Second}", "{Second, revised}"));

    let rows = parse_rows(edited.clone()).rows;
    let picked = model::row_at(&rows, "smith2020", 1).unwrap();
    let change = bib_document::delete_entry_edit(&edited, &picked.entry);
    let left = bib_document::apply_edit(&edited, &change);
    let deleted = Deleted {
        id: 1,
        transaction: None,
        text: left.clone(),
        removed: edited[change.from..change.to].to_string(),
        next: Some(("other".into(), 0)),
        previous: Some(("smith2020".into(), 0)),
        key: "smith2020".into(),
        from: change.from,
        copies: 0,
    };
    let since = left.replace("{First}", "{First, edited}");
    let at = restore_at(&since, &deleted).unwrap();
    let mut restored = since.clone();
    restored.insert_str(at, &deleted.removed);
    assert_eq!(
        restored,
        format!(
            "{}{}{other}",
            first.replace("{First}", "{First, edited}"),
            second.replace("{Second}", "{Second, revised}")
        )
    );
}

/// The form built for an entry finds it again by what it read, never by
/// guessing the first entry under its key.
#[test]
fn a_form_writes_only_to_the_entry_it_was_built_for() {
    let other = "@misc{other,\n  title = {Other}\n}\n\n";
    let first = "@article{smith2020,\n  title = {First}\n}\n\n";
    let second = "@inproceedings{smith2020,\n  title = {Second}\n}\n";
    let text = format!("{other}{first}{second}");
    let rows = parse_rows(text.clone()).rows;
    let shown = model::row_at(&rows, "smith2020", 2).unwrap();
    let signature = text[shown.entry.from..shown.entry.to].to_string();
    let after = |deleted: usize| {
        let edit = bib_document::delete_entry_edit(&text, &rows[deleted].entry);
        let left = bib_document::apply_edit(&text, &edit);
        (parse_rows(left.clone()).rows, left)
    };

    // The second smith2020 deleted, its form open: nothing to write to,
    // though the first is now the only one under that key.
    let (left_rows, left) = after(2);
    assert!(model::form_row(&left_rows, &left, "smith2020", 2, &signature).is_none());

    // An entry above deleted: the second smith2020 is now at place 1, where
    // the first used to stand, and the form still finds the second.
    let (left_rows, left) = after(0);
    let found = model::form_row(&left_rows, &left, "smith2020", 2, &signature);
    assert_eq!(found.map(|row| row.summary.title.as_str()), Some("Second"));

    // The entry edited since the form read it: its place still names it.
    let edited = text.replace("{Second}", "{Second, revised}");
    let edited_rows = parse_rows(edited.clone()).rows;
    let found = model::form_row(&edited_rows, &edited, "smith2020", 2, &signature);
    assert_eq!(
        found.map(|row| row.summary.title.as_str()),
        Some("Second, revised")
    );
}

/// The caret right after an entry's closing brace still sits in it, as the
/// Tauri app's `rowAt` reads `from <= offset <= to`; a blank line between
/// entries holds none.
#[test]
fn the_caret_follows_the_entry_up_to_its_closing_brace() {
    let text = "@article{a,\n  title = {A}\n}\n\n@misc{b,\n  title = {B}\n}\n";
    let rows = parse_rows(text.to_string()).rows;
    let key_at = |offset| model::row_holding(&rows, offset).map(|row| row.entry.key.as_str());
    let first_close = text.find("}\n\n").unwrap() + 1;
    assert_eq!(key_at(0), Some("a"));
    assert_eq!(key_at(first_close), Some("a"));
    assert_eq!(key_at(first_close + 1), None);
    assert_eq!(key_at(text.find("@misc").unwrap() + 3), Some("b"));
}

/// Two entries with nothing between them: the offset where `a` closes is
/// also where `b` opens, and the caret there follows `b`, the last entry
/// starting at or before it (`rowAt`'s binary search).
#[test]
fn the_caret_between_touching_entries_follows_the_second() {
    let text = "@misc{a}@misc{b}";
    let rows = parse_rows(text.to_string()).rows;
    let key_at = |offset| model::row_holding(&rows, offset).map(|row| row.entry.key.as_str());
    assert_eq!(key_at(8), Some("b"));
    assert_eq!(key_at(7), Some("a"));
    assert_eq!(key_at(16), Some("b"));
}

/// File `z`, then `smith{A}` and `smith{B}`: with `z` deleted the second
/// smith is at place 1, and once ⌘Z puts `z` back the reference in front
/// is still that one (now at place 2), never the first smith that took
/// place 1.
#[test]
fn the_reference_in_front_follows_its_entry_when_one_before_it_returns() {
    let z = "@misc{z,\n  title = {Z}\n}\n\n";
    let a = "@article{smith,\n  title = {A}\n}\n\n";
    let b = "@inproceedings{smith,\n  title = {B}\n}\n";
    let without = format!("{a}{b}");
    let with = format!("{z}{a}{b}");
    let before = parse_rows(without.clone()).rows;
    let after = parse_rows(with.clone()).rows;
    let place = model::follow_row(&before, &without, &after, &with, "smith", 1).unwrap();
    assert_eq!(place, 2);
    assert_eq!(after[place].summary.title, "B");
    // Deleted again: back to place 1, still the second smith.
    let place = model::follow_row(&after, &with, &before, &without, "smith", 2).unwrap();
    assert_eq!(before[place].summary.title, "B");
    // Its own text edited: its place still names it.
    let edited = without.replace("{B}", "{B, revised}");
    let edited_rows = parse_rows(edited.clone()).rows;
    let place = model::follow_row(&before, &without, &edited_rows, &edited, "smith", 1).unwrap();
    assert_eq!(edited_rows[place].summary.title, "B, revised");
}
