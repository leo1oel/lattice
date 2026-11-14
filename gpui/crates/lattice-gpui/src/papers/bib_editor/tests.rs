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
