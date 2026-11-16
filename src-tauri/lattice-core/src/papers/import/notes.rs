//! What a cite tells the Agent in words beyond its key.
//!
//! cite never rewrites an entry the bibliography already has (see
//! `merge_resolved_citation`): the entry may carry the writer's or a
//! co-author's edits, and a metadata change is a reviewed operation. Before
//! this note, a cite of an already-cited work answered only
//! `alreadyImported: true`, so an Agent that asked for a DOI's published
//! record got the old preprint entry back and could not tell that nothing had
//! been applied, nor which tool would apply it.

use super::super::upgrade;
use crate::project;

/// The fields compared between the entry and the record a cite resolved.
const COMPARED: [&str; 6] = ["title", "author", "year", "journal", "booktitle", "doi"];

/// The note for a work the bibliography already cites under `key`.
/// `existing` is that entry's text; `resolved` the record this cite resolved,
/// or `None` when the arXiv id alone matched the entry and nothing was looked
/// up.
pub(super) fn already_cited(key: &str, existing: &str, resolved: Option<&str>) -> String {
    let mut note = format!(
        "'{key}' was already in the bibliography, so cite returned its key and left the \
         entry unchanged."
    );
    let differing = resolved.map(|resolved| differing_fields(existing, resolved));
    if let Some(differing) = differing.filter(|fields| !fields.is_empty()) {
        note.push_str(&format!(
            " The record it resolved differs in {}; cite never overwrites an existing entry.",
            differing.join(", ")
        ));
    }
    let preprint =
        upgrade::entry_fields(existing).is_some_and(|fields| upgrade::is_preprint(&fields));
    note.push_str(if preprint {
        " The entry is a preprint: upgrade_bibliography replaces it with its published version, \
          keeping the key and every field already in it."
    } else {
        " Any other change to it is the writer's, in Lattice's citation review."
    });
    note
}

/// Join the notes that apply, in order.
pub(super) fn join(notes: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let notes: Vec<String> = notes.into_iter().flatten().collect();
    (!notes.is_empty()).then(|| notes.join(" "))
}

fn entry_type(bibtex: &str) -> Option<String> {
    let (_, start, _) = project::bibliography_entry_spans(bibtex).into_iter().next()?;
    let rest = &bibtex[start + 1..];
    Some(rest[..rest.find(['{', '('])?].trim().to_ascii_lowercase())
}

/// The compared fields `resolved` has a value for that `existing` lacks or
/// spells differently (braces, spacing and case aside), plus `type`.
fn differing_fields(existing: &str, resolved: &str) -> Vec<String> {
    let (Some(old), Some(new)) = (upgrade::entry_fields(existing), upgrade::entry_fields(resolved))
    else {
        return Vec::new();
    };
    let words = |value: &str| {
        value
            .replace(['{', '}'], "")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    let same = |name: &str, a: &str, b: &str| match name {
        "doi" => project::normalize_doi(a) == project::normalize_doi(b),
        _ => words(a) == words(b),
    };
    let mut differing: Vec<String> = COMPARED
        .iter()
        .filter(|name| {
            new.get(**name).filter(|value| !words(value).is_empty()).is_some_and(|value| {
                old.get(**name).is_none_or(|current| !same(name, current, value))
            })
        })
        .map(|name| name.to_string())
        .collect();
    if entry_type(existing) != entry_type(resolved) {
        differing.push("type".into());
    }
    differing
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREPRINT: &str = "@misc{he2015deep,\n  title = {Deep Residual Learning for Image Recognition},\n  author = {He, Kaiming and Zhang, Xiangyu},\n  journal = {arXiv preprint arXiv:1512.03385},\n  year = {2015}\n}";

    #[test]
    fn an_already_cited_preprint_names_what_differs_and_the_tool_that_applies_it() {
        let published = "@inproceedings{he2016deep,\n  title = {Deep residual learning for image recognition},\n  author = {He, Kaiming and Zhang, Xiangyu},\n  booktitle = {CVPR},\n  doi = {10.1109/CVPR.2016.90},\n  year = {2016}\n}\n";
        let note = already_cited("he2015deep", PREPRINT, Some(published));
        assert!(note.starts_with("'he2015deep' was already in the bibliography"), "{note}");
        // Title case alone is not a difference.
        assert!(note.contains("differs in year, booktitle, doi, type;"), "{note}");
        assert!(note.contains("upgrade_bibliography"), "{note}");

        // Nothing resolved (an arXiv id matched), and a published entry.
        let note = already_cited("he2015deep", PREPRINT, None);
        assert!(!note.contains("differs") && note.contains("upgrade_bibliography"), "{note}");
        let note = already_cited("he2016deep", published, Some(published));
        assert!(!note.contains("differs") && note.contains("citation review"), "{note}");
    }

    #[test]
    fn notes_join_in_order_and_vanish_when_none_apply() {
        assert_eq!(join([None, None]), None);
        assert_eq!(join([Some("A.".into()), None, Some("B.".into())]).as_deref(), Some("A. B."));
    }
}
