//! A linked library (`linked-library.ts`): a `.bib` file a reference manager
//! keeps outside the project (a Zotero or Paperpile export), whose changes
//! come into the project's own `.bib` only once the writer has seen them.
//!
//! Three texts are compared. The base is the library as it was when its
//! changes were last taken in (lattice-core keeps it with the link); the
//! library is the file now; local is the project's `.bib`. A field the
//! library changed since the base, which the writer left alone here, is an
//! update. One the writer changed here too is theirs until they choose
//! otherwise. A field only the writer changed is never offered.
//!
//! An entry is the same paper in each text by its citation key, or else by
//! its DOI or arXiv id, or as a last resort by its title and year, and keeps
//! the key it has here: a library that renamed its keys does not break a
//! `\cite`. Nothing is deleted unless the writer ticks it, and never an
//! entry the paper cites. Every change is a splice into the local text, so
//! whatever it does not touch stays byte for byte as written. A value naming
//! an `@string` of the library is written out, since the project's `.bib`
//! may not define it.

use std::collections::{HashMap, HashSet};

use lattice_core::bib_document::{self, BibDocument, BibEdit, BibEntry};
use lattice_i18n::t;

mod view;

pub use view::{LinkedLibrary, LinkedLibraryEvent};

/// The pseudo-field for the entry type, which a published preprint changes
/// (`@misc` → `@inproceedings`).
pub const ENTRY_TYPE_FIELD: &str = "@type";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldChange {
    /// Lower-cased field name, or `ENTRY_TYPE_FIELD`.
    pub name: String,
    /// The value here, expanded but still LaTeX; none when absent.
    pub local: Option<String>,
    pub library: Option<String>,
    /// The writer changed this field here too (or, before the first
    /// update, it differs).
    pub conflict: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChangeKind {
    New,
    Updated,
    Conflict,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryChange {
    /// Stable within one comparison.
    pub id: String,
    pub kind: ChangeKind,
    /// The key here (for a new entry, the library's).
    pub key: String,
    /// The library entry it comes from, by its key there; none for a
    /// removed entry.
    pub library_key: Option<String>,
    pub title: String,
    /// What would change, for an update and a conflict.
    pub fields: Vec<FieldChange>,
    /// A removed entry the paper cites: it cannot be removed here.
    pub cited: bool,
}

struct Indexed {
    document: BibDocument,
    source: String,
    by_key: HashMap<String, usize>,
    by_identity: HashMap<String, Vec<usize>>,
}

/// Read a `.bib`, or say why not with `name` in the message.
fn index(source: &str, name: &str) -> Result<Indexed, String> {
    let document = bib_document::parse(source).map_err(|error| {
        t!(
            "{name} can't be read. {reason}",
            name = name,
            reason = crate::papers::bib_editor::unreadable_reason(&error)
        )
    })?;
    let mut by_key = HashMap::new();
    let mut by_identity: HashMap<String, Vec<usize>> = HashMap::new();
    for (at, entry) in document.entries.iter().enumerate() {
        by_key.entry(entry.key.to_lowercase()).or_insert(at);
        for identity in identities(source, entry, &document) {
            by_identity.entry(identity).or_default().push(at);
        }
    }
    Ok(Indexed {
        document,
        source: source.to_string(),
        by_key,
        by_identity,
    })
}

/// Ways to tell the paper apart from its key, surest first, each with its
/// tier's prefix.
fn identities(source: &str, entry: &BibEntry, document: &BibDocument) -> Vec<String> {
    let summary = bib_document::summarize_entry(source, entry, &document.macros);
    let mut words = String::new();
    for ch in summary.title.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            words.push(ch);
        } else if !words.ends_with(' ') {
            words.push(' ');
        }
    }
    let words = words.trim();
    let arxiv = match summary.arxiv_id.rsplit_once('v') {
        Some((base, version))
            if !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit()) =>
        {
            base
        }
        _ => summary.arxiv_id.as_str(),
    };
    [
        (!summary.doi.is_empty()).then(|| format!("doi:{}", summary.doi.to_lowercase())),
        (!arxiv.is_empty()).then(|| format!("arxiv:{arxiv}")),
        (!words.is_empty()).then(|| format!("title:{words}|{}", summary.year)),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The text's entries, each key's first only.
fn firsts(text: &Indexed) -> Vec<usize> {
    (0..text.document.entries.len())
        .filter(|at| {
            text.by_key
                .get(&text.document.entries[*at].key.to_lowercase())
                == Some(at)
        })
        .collect()
}

/// Each of `from`'s entries paired with the same paper in `other`, one to
/// one, the surest match first across all of them: every key, then every
/// DOI, then every arXiv id, then every title and year.
fn pair(from: &Indexed, other: &Indexed) -> HashMap<usize, usize> {
    let mut pairs = HashMap::new();
    let mut taken = HashSet::new();
    let entries = firsts(from);
    let mut claim = |entry: usize, found: Option<usize>, pairs: &mut HashMap<usize, usize>| {
        if let Some(found) = found
            && !pairs.contains_key(&entry)
            && taken.insert(found)
        {
            pairs.insert(entry, found);
        }
    };
    for entry in &entries {
        let key = from.document.entries[*entry].key.to_lowercase();
        claim(*entry, other.by_key.get(&key).copied(), &mut pairs);
    }
    let known: HashMap<usize, Vec<String>> = entries
        .iter()
        .map(|entry| {
            (
                *entry,
                identities(&from.source, &from.document.entries[*entry], &from.document),
            )
        })
        .collect();
    for tier in ["doi:", "arxiv:", "title:"] {
        for entry in &entries {
            if pairs.contains_key(entry) {
                continue;
            }
            let Some(identity) = known[entry]
                .iter()
                .find(|candidate| candidate.starts_with(tier))
            else {
                continue;
            };
            let found = other.by_identity.get(identity).and_then(|candidates| {
                candidates
                    .iter()
                    .find(|candidate| !pairs.values().any(|v| v == *candidate))
                    .copied()
            });
            claim(*entry, found, &mut pairs);
        }
    }
    pairs
}

/// The entry's fields by lower-cased name in their order, and its type,
/// whitespace runs read as one space.
fn fields_of(text: &Indexed, at: usize) -> Vec<(String, String)> {
    let entry = &text.document.entries[at];
    let mut values = vec![(ENTRY_TYPE_FIELD.to_string(), entry.kind.clone())];
    for field in &entry.fields {
        let name = field.name.to_lowercase();
        if values.iter().any(|(each, _)| *each == name) {
            continue;
        }
        let raw = &text.source[field.value_from..field.value_to];
        let value = bib_document::expand_value(raw, &text.document.macros)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        values.push((name, value));
    }
    values
}

fn lookup<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a String> {
    fields
        .iter()
        .find(|(each, _)| each == name)
        .map(|(_, value)| value)
}

fn title_of(text: &Indexed, at: usize) -> String {
    let entry = &text.document.entries[at];
    let title = bib_document::summarize_entry(&text.source, entry, &text.document.macros).title;
    if title.is_empty() {
        entry.key.clone()
    } else {
        title
    }
}

/// What taking in the library would change here, entry by entry. `base` is
/// none before the first update: every difference then is the writer's to
/// settle. `cited` is none when the citations could not be read: then
/// every removed entry counts as cited.
pub fn compare_library(
    base: Option<&str>,
    library: &str,
    local: &str,
    library_name: &str,
    local_name: &str,
    cited: Option<&HashSet<String>>,
) -> Result<Vec<LibraryChange>, String> {
    let theirs = index(library, library_name)?;
    let ours = index(local, local_name)?;
    // A base that no longer parses (edited by hand) is as good as none.
    let before = base.and_then(|base| index(base, library_name).ok());
    let mut changes = Vec::new();
    let to_local = pair(&theirs, &ours);
    let to_base = before
        .as_ref()
        .map(|before| pair(&theirs, before))
        .unwrap_or_default();
    let base_to_local = before
        .as_ref()
        .map(|before| pair(before, &ours))
        .unwrap_or_default();
    let mut seen: HashSet<usize> = to_local.values().copied().collect();
    for entry in firsts(&theirs) {
        let was = to_base.get(&entry).copied();
        // The library changed what told the paper apart here; the base
        // still has it.
        let through = was.and_then(|was| base_to_local.get(&was).copied());
        let here = to_local
            .get(&entry)
            .copied()
            .or_else(|| through.filter(|through| !seen.contains(through)));
        let library_entry = &theirs.document.entries[entry];
        let Some(here) = here else {
            // In the base but gone from here: removed, or declined already.
            if was.is_none() {
                changes.push(LibraryChange {
                    id: format!("new:{}", library_entry.key),
                    kind: ChangeKind::New,
                    key: library_entry.key.clone(),
                    library_key: Some(library_entry.key.clone()),
                    title: title_of(&theirs, entry),
                    fields: Vec::new(),
                    cited: false,
                });
            }
            continue;
        };
        seen.insert(here);
        let now = fields_of(&theirs, entry);
        let then = match (was, &before) {
            (Some(was), Some(before)) => Some(fields_of(before, was)),
            _ => None,
        };
        let mine = fields_of(&ours, here);
        let mut names: Vec<&String> = now.iter().map(|(name, _)| name).collect();
        for (name, _) in then.iter().flatten() {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        let mut fields = Vec::new();
        for name in names {
            let library = lookup(&now, name).cloned();
            let local = lookup(&mine, name).cloned();
            if library == local {
                continue;
            }
            match &then {
                Some(then) => {
                    let previous = lookup(then, name).cloned();
                    if library == previous {
                        continue;
                    }
                    let conflict = local != previous;
                    fields.push(FieldChange {
                        name: name.clone(),
                        local,
                        library,
                        conflict,
                    });
                }
                // Before the first update a field only here is the writer's
                // own; one only in the library is new to the entry.
                None if library.is_some() => {
                    let conflict = local.is_some();
                    fields.push(FieldChange {
                        name: name.clone(),
                        local,
                        library,
                        conflict,
                    });
                }
                None => {}
            }
        }
        let key = ours.document.entries[here].key.clone();
        let title = title_of(&ours, here);
        let (conflicts, updates): (Vec<FieldChange>, Vec<FieldChange>) =
            fields.into_iter().partition(|field| field.conflict);
        for (kind, fields, prefix) in [
            (ChangeKind::Updated, updates, "entry"),
            (ChangeKind::Conflict, conflicts, "conflict"),
        ] {
            if !fields.is_empty() {
                changes.push(LibraryChange {
                    id: format!("{prefix}:{key}"),
                    kind,
                    key: key.clone(),
                    library_key: Some(library_entry.key.clone()),
                    title: title.clone(),
                    fields,
                    cited: false,
                });
            }
        }
    }
    if let Some(before) = &before {
        let kept: HashSet<usize> = to_base.values().copied().collect();
        for was in firsts(before) {
            if kept.contains(&was) {
                continue;
            }
            let Some(here) = base_to_local
                .get(&was)
                .copied()
                .filter(|here| !seen.contains(here))
            else {
                continue;
            };
            seen.insert(here);
            let key = ours.document.entries[here].key.clone();
            changes.push(LibraryChange {
                id: format!("removed:{key}"),
                kind: ChangeKind::Removed,
                cited: cited
                    .is_none_or(|cited| cited.iter().any(|each| each.eq_ignore_ascii_case(&key))),
                key,
                library_key: None,
                title: title_of(&ours, here),
                fields: Vec::new(),
            });
        }
    }
    Ok(changes)
}

/// The library's value for `name`, readable without its `@string` macros.
fn library_raw(theirs: &Indexed, entry: &BibEntry, name: &str) -> Option<String> {
    let field = entry
        .fields
        .iter()
        .find(|field| field.name.to_lowercase() == name)?;
    Some(bib_document::self_contained_value(
        &theirs.source[field.value_from..field.value_to],
        &theirs.document.macros,
    ))
}

/// A new entry's text as the library writes it, its values readable
/// without the library's `@string` macros.
fn library_entry_text(theirs: &Indexed, entry: &BibEntry) -> String {
    let mut text = theirs.source[entry.from..entry.to].to_string();
    for field in entry.fields.iter().rev() {
        let edit = BibEdit {
            from: field.value_from - entry.from,
            to: field.value_to - entry.from,
            insert: bib_document::self_contained_value(
                &theirs.source[field.value_from..field.value_to],
                &theirs.document.macros,
            ),
        };
        text = bib_document::apply_edit(&text, &edit);
    }
    text
}

/// The splice giving `entry` the library's `name`, or none when neither has
/// it.
fn field_edit(
    text: &str,
    entry: &BibEntry,
    theirs: &Indexed,
    source: &BibEntry,
    name: &str,
) -> Option<BibEdit> {
    if name == ENTRY_TYPE_FIELD {
        return Some(bib_document::change_type_edit(entry, &source.entry_type));
    }
    let field = entry
        .fields
        .iter()
        .find(|field| field.name.to_lowercase() == name);
    match (library_raw(theirs, source, name), field) {
        (None, Some(field)) => Some(bib_document::remove_field_edit(text, entry, field)),
        (None, None) => None,
        (Some(raw), Some(field)) => Some(bib_document::replace_value_edit(field, &raw)),
        (Some(raw), None) => {
            let written = source
                .fields
                .iter()
                .find(|field| field.name.to_lowercase() == name)
                .map_or(name, |field| field.name.as_str());
            Some(bib_document::add_field_edit(text, entry, written, &raw))
        }
    }
}

/// The entry's text with the library's side of `fields`, one splice at a
/// time.
fn updated_entry(
    mut text: String,
    theirs: &Indexed,
    source: &BibEntry,
    fields: &[FieldChange],
) -> String {
    for change in fields {
        let Some(entry) = bib_document::parse(&text)
            .ok()
            .and_then(|document| document.entries.into_iter().next())
        else {
            return text;
        };
        if let Some(edit) = field_edit(&text, &entry, theirs, source, &change.name) {
            text = bib_document::apply_edit(&text, &edit);
        }
    }
    text
}

/// The project's `.bib` with the chosen changes taken in: updated entries
/// keep their keys and place, removed ones go (never one the paper cites),
/// and new ones are added at the end as the library writes them.
pub fn apply_library_changes(
    local: &str,
    library: &str,
    chosen: &[LibraryChange],
) -> Result<String, String> {
    let theirs = index(library, "library")?;
    let ours = index(local, "bibliography")?;
    let mut edits: Vec<BibEdit> = Vec::new();
    let mut added: Vec<String> = Vec::new();
    // An entry's update and its conflict, both ticked, are one splice.
    let mut updates: Vec<(usize, usize, Vec<FieldChange>)> = Vec::new();
    for change in chosen {
        let source = change
            .library_key
            .as_ref()
            .and_then(|key| theirs.by_key.get(&key.to_lowercase()).copied());
        if change.kind == ChangeKind::New {
            if let Some(source) = source
                && !ours.by_key.contains_key(&change.key.to_lowercase())
            {
                added.push(library_entry_text(
                    &theirs,
                    &theirs.document.entries[source],
                ));
            }
            continue;
        }
        let Some(here) = ours.by_key.get(&change.key.to_lowercase()).copied() else {
            continue;
        };
        if change.kind == ChangeKind::Removed {
            if !change.cited {
                edits.push(bib_document::delete_entry_edit(
                    local,
                    &ours.document.entries[here],
                ));
            }
            continue;
        }
        let Some(source) = source else {
            continue;
        };
        match updates.iter_mut().find(|(each, _, _)| *each == here) {
            Some((_, _, fields)) => fields.extend(change.fields.iter().cloned()),
            None => updates.push((here, source, change.fields.clone())),
        }
    }
    for (here, source, fields) in updates {
        let entry = &ours.document.entries[here];
        edits.push(BibEdit {
            from: entry.from,
            to: entry.to,
            insert: updated_entry(
                local[entry.from..entry.to].to_string(),
                &theirs,
                &theirs.document.entries[source],
                &fields,
            ),
        });
    }
    edits.sort_by(|a, b| b.from.cmp(&a.from));
    let mut next = edits.iter().fold(local.to_string(), |text, edit| {
        bib_document::apply_edit(&text, edit)
    });
    for entry in added {
        let trimmed = next.trim_end();
        next = if trimmed.is_empty() {
            format!("{entry}\n")
        } else {
            format!("{trimmed}\n\n{entry}\n")
        };
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "@article{a,\n  title = {Alpha},\n  year = {2020}\n}\n\n@misc{b,\n  title = {Beta},\n  year = {2021}\n}\n";

    fn compare(
        base: Option<&str>,
        library: &str,
        local: &str,
        cited: &[&str],
    ) -> Vec<LibraryChange> {
        let cited: HashSet<String> = cited.iter().map(|key| key.to_string()).collect();
        compare_library(
            base,
            library,
            local,
            "library.bib",
            "refs.bib",
            Some(&cited),
        )
        .unwrap()
    }

    #[test]
    fn a_library_update_comes_in_and_a_field_changed_here_stays_the_writers() {
        let library = "@article{a,\n  title = {Alpha},\n  year = {2022}\n}\n\n@misc{b,\n  title = {Beta revised},\n  year = {2021}\n}\n\n@book{c,\n  title = {Gamma},\n  year = {2023}\n}\n";
        let local = BASE.replace("{Beta}", "{Beta, mine}");
        let changes = compare(Some(BASE), library, &local, &[]);
        let kinds: Vec<(ChangeKind, &str)> = changes
            .iter()
            .map(|change| (change.kind, change.key.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                (ChangeKind::Updated, "a"),
                (ChangeKind::Conflict, "b"),
                (ChangeKind::New, "c")
            ]
        );
        let next =
            apply_library_changes(&local, library, &[changes[0].clone(), changes[2].clone()])
                .unwrap();
        assert!(next.contains("year = {2022}"));
        assert!(next.contains("{Beta, mine}"));
        assert!(
            next.trim_end()
                .ends_with("@book{c,\n  title = {Gamma},\n  year = {2023}\n}")
        );
    }

    #[test]
    fn a_paper_the_library_dropped_goes_only_when_ticked_and_never_while_cited() {
        let library = "@article{a,\n  title = {Alpha},\n  year = {2020}\n}\n";
        let changes = compare(Some(BASE), library, BASE, &["B"]);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, ChangeKind::Removed);
        assert!(changes[0].cited);
        assert_eq!(
            apply_library_changes(BASE, library, &changes).unwrap(),
            BASE
        );
        let free = compare(Some(BASE), library, BASE, &[]);
        assert!(
            !apply_library_changes(BASE, library, &free)
                .unwrap()
                .contains("Beta")
        );
    }

    #[test]
    fn a_renamed_key_is_the_same_paper_by_its_doi() {
        let local = "@article{mine2020,\n  title = {Alpha},\n  doi = {10.1/x}\n}\n";
        let library =
            "@article{Alpha2020xyz,\n  title = {Alpha},\n  doi = {10.1/x},\n  pages = {1--2}\n}\n";
        let changes = compare(None, library, local, &[]);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].key, "mine2020");
        assert_eq!(changes[0].kind, ChangeKind::Updated);
        let next = apply_library_changes(local, library, &changes).unwrap();
        assert!(next.starts_with("@article{mine2020,"));
        assert!(next.contains("pages = {1--2}"));
    }
}
