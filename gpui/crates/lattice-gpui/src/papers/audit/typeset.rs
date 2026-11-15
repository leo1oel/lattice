//! Check references' findings drawn as the reader meets them
//! (`reference-typeset.ts`): a reference as it prints, with a proposed fix
//! marked in place (struck and inserted words, which `fix.rs` draws through
//! the app's inline edits), and two versions of a field with only the words
//! that differ marked.
//!
//! The reference and the names of its fields are English whatever the
//! interface language: they are what the `.bib` file holds and what the
//! bibliography prints, so "et al.", "vol." and "pp." are never translated.

use std::{collections::HashMap, sync::LazyLock};

use lattice_core::bib_document::{self, author_names, bib_text_to_plain, entry_values};
use regex::Regex;

use super::Change;

/// One edit of a printed reference: `[from, to)` of its text (bytes)
/// becomes `insert`, tagged with the lowercase names of the fields it
/// changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub from: usize,
    pub to: usize,
    pub insert: String,
    pub tag: String,
}

/// A printed reference and the edits that turn it into the verified one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TypesetFix {
    pub text: String,
    pub edits: Vec<Edit>,
    /// Changed fields a printed reference does not show (entry type, DOI,
    /// publisher).
    pub unprinted: Vec<String>,
}

/// A field's name where the reference itself is shown (`bibFieldName`).
pub fn bib_field_name(field: &str) -> &str {
    match field {
        "title" => "Title",
        "author" => "Authors",
        "year" => "Year",
        "journal" => "Journal",
        "booktitle" => "Booktitle",
        "publisher" => "Publisher",
        "volume" => "Volume",
        "number" => "Number",
        "pages" => "Pages",
        "doi" => "DOI",
        "url" => "URL",
        "ENTRYTYPE" => "Entry type",
        "venue" => "Venue",
        other => other,
    }
}

/// An edit's tag: the lowercase names of the fields it changes, each once.
fn tag_of<'a>(fields: impl IntoIterator<Item = &'a str>) -> String {
    let mut names: Vec<String> = Vec::new();
    for field in fields {
        let name = bib_field_name(field).to_lowercase();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.join(", ")
}

/// The pieces a reference prints, in print order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Piece {
    Author,
    Title,
    Venue,
    Volume,
    Pages,
    Year,
}

const PIECES: [Piece; 6] = [
    Piece::Author,
    Piece::Title,
    Piece::Venue,
    Piece::Volume,
    Piece::Pages,
    Piece::Year,
];
const VENUE_FIELDS: [&str; 4] = ["journal", "journaltitle", "booktitle", "howpublished"];

impl Piece {
    fn name(self) -> &'static str {
        match self {
            Piece::Author => "author",
            Piece::Title => "title",
            Piece::Venue => "venue",
            Piece::Volume => "volume",
            Piece::Pages => "pages",
            Piece::Year => "year",
        }
    }

    fn of(field: &str) -> Option<Piece> {
        let name = field.to_lowercase();
        if VENUE_FIELDS.contains(&name.as_str()) || name == "venue" {
            return Some(Piece::Venue);
        }
        PIECES.into_iter().find(|piece| piece.name() == name)
    }
}

static AND_OTHERS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\band\s+others\s*$").expect("the pattern compiles"));

/// Every person's name, read as printed: "Alec Radford, Jong Wook Kim et
/// al.", the first three unless `all`.
fn printed_authors(raw: &str, all: bool) -> String {
    let people = author_names(raw);
    if people.is_empty() {
        return String::new();
    }
    let others = AND_OTHERS.is_match(raw);
    let shown = if all {
        &people[..]
    } else {
        &people[..people.len().min(3)]
    };
    let names = shown.join(", ");
    if others || names.len() < people.join(", ").len() {
        format!("{names} et al.")
    } else {
        names
    }
}

/// The first entry's fields of `bibtex`, expanded but still LaTeX.
fn values_of(bibtex: &str) -> HashMap<String, String> {
    match bib_document::parse(bibtex) {
        Ok(document) => document
            .entries
            .first()
            .map(|entry| entry_values(bibtex, entry, &document.macros))
            .unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// One record's printed pieces, each with the punctuation that follows it.
fn printed_pieces(bibtex: &str, all_authors: bool) -> HashMap<Piece, String> {
    let values = values_of(bibtex);
    let plain = |name: &str| bib_text_to_plain(values.get(name).map_or("", String::as_str));
    let eprint = plain("eprint");
    let archive = format!("{} {}", plain("archiveprefix"), plain("eprinttype"));
    let preprint = if !eprint.is_empty() && archive.to_lowercase().contains("arxiv") {
        format!("arXiv:{eprint}")
    } else {
        String::new()
    };
    let venue = VENUE_FIELDS
        .iter()
        .map(|name| plain(name))
        .find(|value| !value.is_empty())
        .unwrap_or(preprint);
    let (volume, pages) = (plain("volume"), plain("pages"));
    let year = Some(plain("year"))
        .filter(|year| !year.is_empty())
        .unwrap_or_else(|| {
            values
                .get("date")
                .map(|date| date.chars().take(4).collect())
                .unwrap_or_default()
        });
    let author = values
        .get("author")
        .or_else(|| values.get("editor"))
        .map_or(String::new(), |raw| printed_authors(raw, all_authors));
    let mut pieces = HashMap::from([
        (Piece::Author, author),
        (Piece::Title, plain("title")),
        (Piece::Venue, venue),
        (
            Piece::Volume,
            if volume.is_empty() {
                volume
            } else {
                format!("vol. {volume}")
            },
        ),
        (
            Piece::Pages,
            if pages.is_empty() {
                pages
            } else {
                format!("pp. {pages}")
            },
        ),
        (Piece::Year, year),
    ]);
    for (piece, text) in pieces.iter_mut() {
        if text.is_empty() {
            continue;
        }
        // "et al." and a title ending in "?" already close their sentence.
        let closed = text.ends_with(['.', '?', '!']);
        text.push_str(match piece {
            Piece::Year => ".",
            Piece::Author | Piece::Title if closed => " ",
            Piece::Author | Piece::Title => ". ",
            _ => ", ",
        });
    }
    pieces
}

/// The reference `before` as it prints, each run of pieces the verified
/// `after` prints differently one edit, tagged with the fields it changes
/// (`typesetBibFix`). A run is whole pieces, so the marks fall on whole
/// words.
pub fn typeset_bib_fix(before: &str, after: &str, changes: &[Change]) -> TypesetFix {
    let changed: Vec<Option<Piece>> = changes
        .iter()
        .map(|change| Piece::of(&change.field))
        .collect();
    let authors = changed.contains(&Some(Piece::Author));
    let (old, next) = (
        printed_pieces(before, authors),
        printed_pieces(after, authors),
    );
    let tags_of = |pieces: &[Piece]| {
        let fields: Vec<&str> = changes
            .iter()
            .filter(|change| Piece::of(&change.field).is_some_and(|piece| pieces.contains(&piece)))
            .map(|change| change.field.as_str())
            .collect();
        if fields.is_empty() {
            tag_of(pieces.iter().map(|piece| piece.name()))
        } else {
            tag_of(fields)
        }
    };
    let mut text = String::new();
    let mut edits = Vec::new();
    // The run of differing pieces under way: where it starts, its old and
    // new words, and its pieces.
    let mut run: Option<(usize, String, String, Vec<Piece>)> = None;
    let mut close = |run: &mut Option<(usize, String, String, Vec<Piece>)>, text: &mut String| {
        if let Some((from, old, new, pieces)) = run.take() {
            edits.push(Edit {
                from,
                to: from + old.len(),
                insert: new,
                tag: tags_of(&pieces),
            });
            text.push_str(&old);
        }
    };
    for piece in PIECES {
        if old[&piece] == next[&piece] {
            close(&mut run, &mut text);
            text.push_str(&old[&piece]);
            continue;
        }
        let (_, was, will, pieces) =
            run.get_or_insert_with(|| (text.len(), String::new(), String::new(), Vec::new()));
        was.push_str(&old[&piece]);
        will.push_str(&next[&piece]);
        pieces.push(piece);
    }
    close(&mut run, &mut text);
    let unprinted = changes
        .iter()
        .filter(|change| Piece::of(&change.field).is_none())
        .map(|change| bib_field_name(&change.field).to_string())
        .collect();
    // A reference without a year ends on its last piece's comma and space.
    let printed = text.trim_end().to_string();
    let end = printed.len();
    let edits = edits
        .into_iter()
        .map(|edit| Edit {
            from: edit.from.min(end),
            to: edit.to.min(end),
            ..edit
        })
        .collect();
    TypesetFix {
        text: printed,
        edits,
        unprinted,
    }
}

/// Where `needle` first appears in `text`, exactly or ignoring case, as a
/// byte range of `text`.
fn locate(text: &str, needle: &str) -> Option<(usize, usize)> {
    if needle.is_empty() {
        return None;
    }
    if let Some(at) = text.find(needle) {
        return Some((at, at + needle.len()));
    }
    let wanted: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    text.char_indices().find_map(|(start, _)| {
        let mut want = wanted.iter();
        for (at, c) in text[start..].char_indices() {
            for lower in c.to_lowercase() {
                if want.next() != Some(&lower) {
                    return None;
                }
            }
            if want.len() == 0 {
                return Some((start, start + at + c.len_utf8()));
            }
        }
        None
    })
}

/// A `\bibitem` as written, as it prints, each difference from the verified
/// record marked where the item states it (`typesetInlineFix`). A
/// difference the item does not state word for word (an abbreviated author
/// list) is listed instead.
pub fn typeset_inline_fix(written: &str, changes: &[Change]) -> TypesetFix {
    let text = bib_text_to_plain(written);
    let mut edits: Vec<Edit> = Vec::new();
    let mut unprinted = Vec::new();
    for change in changes {
        let before = bib_text_to_plain(&change.before);
        let found = locate(&text, &before)
            .filter(|(from, to)| !edits.iter().any(|edit| *from < edit.to && *to > edit.from));
        match found {
            Some((from, to)) => edits.push(Edit {
                from,
                to,
                insert: bib_text_to_plain(&change.after),
                tag: tag_of([change.field.as_str()]),
            }),
            None => unprinted.push(bib_field_name(&change.field).to_string()),
        }
    }
    edits.sort_by_key(|edit| edit.from);
    TypesetFix {
        text,
        edits,
        unprinted,
    }
}

fn escape_latex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '&' | '%' | '#' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The `\bibitem` with the verified record's corrections
/// (`correctedBibitem`). When the item states every differing field word
/// for word, only those words change and the rest stays as the writer
/// wrote it; otherwise the item is written afresh from the verified record.
pub fn corrected_bibitem(key: &str, written: &str, record: &str, changes: &[Change]) -> String {
    let places: Option<Vec<(usize, &Change)>> = changes
        .iter()
        .map(|change| {
            (!change.before.is_empty())
                .then(|| written.find(&change.before))
                .flatten()
                .map(|at| (at, change))
        })
        .collect();
    if let Some(mut places) = places {
        places.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
        // Two places that overlap cannot both be rewritten in place.
        let apart = places
            .windows(2)
            .all(|pair| pair[1].0 + pair[1].1.before.len() <= pair[0].0);
        if apart {
            let mut body = written.to_string();
            for (at, change) in places {
                body.replace_range(at..at + change.before.len(), &escape_latex(&change.after));
            }
            return format!("\\bibitem{{{key}}} {body}");
        }
    }
    let values = values_of(record);
    let raw = |name: &str| values.get(name).cloned().unwrap_or_default();
    let authors = author_names(&raw("author")).join(", ");
    let venue = VENUE_FIELDS
        .iter()
        .map(|name| raw(name))
        .find(|value| !value.is_empty());
    let (volume, pages, year) = (raw("volume"), raw("pages"), raw("year"));
    let details: Vec<String> = [
        venue.map(|venue| format!("\\emph{{{venue}}}")),
        (!volume.is_empty()).then(|| format!("vol.~{volume}")),
        (!pages.is_empty()).then(|| format!("pp.~{pages}")),
        (!year.is_empty()).then_some(year),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut lines = vec![
        format!("\\bibitem{{{key}}}"),
        format!("{authors}."),
        format!("\\newblock {}.", raw("title")),
    ];
    if !details.is_empty() {
        lines.push(format!("\\newblock {}.", details.join(", ")));
    }
    lines.join("\n")
}

/// A word, or the space between words, and whether only its side has it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Word {
    pub word: String,
    pub differs: bool,
}

/// `text` as words and the runs of space between them, in order.
fn words(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut space = None;
    for (at, c) in text.char_indices() {
        let is_space = c.is_whitespace();
        if space.is_some_and(|was| was != is_space) {
            out.push(&text[start..at]);
            start = at;
        }
        space = Some(is_space);
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// The words of `ours` and `theirs`, each marked where only that side has
/// it, a longest common run of words shared (`wordDifference`).
pub fn word_difference(ours: &str, theirs: &str) -> (Vec<Word>, Vec<Word>) {
    let (a, b) = (words(ours), words(theirs));
    let mut table = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            table[i][j] = if a[i] == b[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    let word = |word: &str, differs: bool| Word {
        word: word.to_string(),
        differs,
    };
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            left.push(word(a[i], false));
            right.push(word(b[j], false));
            i += 1;
            j += 1;
        } else if j >= b.len() || (i < a.len() && table[i + 1][j] >= table[i][j + 1]) {
            left.push(word(a[i], !a[i].trim().is_empty()));
            i += 1;
        } else {
            right.push(word(b[j], !b[j].trim().is_empty()));
            j += 1;
        }
    }
    (left, right)
}

#[cfg(test)]
mod tests;
