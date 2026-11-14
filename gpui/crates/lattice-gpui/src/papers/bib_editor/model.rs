//! What the `.bib` visual form reads off the file and the library
//! (`bib-visual-editor.tsx`, `bib-entry-paper.ts`, `bib-entry.ts`): its
//! references as rows, the list's filter and order, where the manuscript
//! cites each key, what opening a reference's paper does, and a new entry as
//! the file will hold it.

use std::{cmp::Ordering, collections::HashMap, sync::LazyLock};

use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};

use lattice_core::{
    bib_document::{self, BibEdit, BibEntry, BibSummary},
    models::SymbolOccurrence,
    papers::PaperSummary,
};
use lattice_i18n::t;

use crate::papers::{
    FetchState,
    model::{can_download, paper_key},
};

/// One reference of the file: the entry as parsed, what the list shows of
/// it, and its place in the file.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub entry: BibEntry,
    pub summary: BibSummary,
    pub index: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BibFilter {
    #[default]
    All,
    Cited,
    Unused,
}

impl BibFilter {
    pub fn label(self) -> &'static str {
        match self {
            BibFilter::All => t!("All"),
            BibFilter::Cited => t!("Cited"),
            BibFilter::Unused => t!("Unused"),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BibSort {
    #[default]
    File,
    Year,
    Author,
    Title,
}

impl BibSort {
    pub const ALL: [BibSort; 4] = [
        BibSort::File,
        BibSort::Year,
        BibSort::Author,
        BibSort::Title,
    ];

    pub fn label(self) -> &'static str {
        match self {
            BibSort::File => t!("File order"),
            BibSort::Year => t!("Newest first"),
            BibSort::Author => t!("Author"),
            BibSort::Title => t!("Title"),
        }
    }
}

/// Where the manuscript cites each key (lower-cased), and whether a
/// `\nocite{*}` takes every entry in, which leaves nothing unused.
#[derive(Clone, Debug, Default)]
pub struct Usages {
    pub by_key: HashMap<String, Vec<SymbolOccurrence>>,
    pub everything: bool,
}

impl Usages {
    pub fn group(list: Vec<SymbolOccurrence>) -> Self {
        let mut usages = Usages::default();
        for usage in list {
            if usage.symbol == "*" {
                usages.everything = true;
                continue;
            }
            usages
                .by_key
                .entry(usage.symbol.to_lowercase())
                .or_default()
                .push(usage);
        }
        usages
    }

    pub fn of(&self, key: &str) -> &[SymbolOccurrence] {
        self.by_key
            .get(&key.to_lowercase())
            .map_or(&[], Vec::as_slice)
    }
}

/// Without the scan nothing is flagged unused, rather than everything.
pub fn is_unused(usages: Option<&Usages>, key: &str) -> bool {
    usages.is_some_and(|usages| {
        !usages.everything && !usages.by_key.contains_key(&key.to_lowercase())
    })
}

/// The first surname of an author list, for sorting by author.
fn sort_surname(summary: &BibSummary) -> String {
    summary
        .authors
        .split(',')
        .next()
        .and_then(|first| first.split_whitespace().last())
        .unwrap_or("")
        .to_lowercase()
}

/// Two names in the order the Tauri app's `localeCompare` puts them: by
/// letter before accent, so "Über" sorts with the U's.
fn locale_compare(a: &str, b: &str) -> Ordering {
    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        Collator::try_new(Default::default(), CollatorOptions::default())
            .expect("the root collation is compiled in")
    });
    COLLATOR.compare(a, b)
}

/// The rows the list shows: those the filter keeps whose text holds every
/// word of the query, in the order chosen (file order breaks ties).
pub fn shown<'a>(
    rows: &'a [Row],
    query: &str,
    filter: BibFilter,
    sort: BibSort,
    usages: Option<&Usages>,
) -> Vec<&'a Row> {
    let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let mut matching: Vec<&Row> = rows
        .iter()
        .filter(|row| {
            (filter == BibFilter::All
                || (filter == BibFilter::Unused) == is_unused(usages, &row.entry.key))
                && terms
                    .iter()
                    .all(|term| row.summary.haystack.contains(term.as_str()))
        })
        .collect();
    match sort {
        BibSort::File => {}
        BibSort::Year => matching.sort_by(|a, b| {
            b.summary
                .year
                .cmp(&a.summary.year)
                .then(a.index.cmp(&b.index))
        }),
        BibSort::Author => matching.sort_by(|a, b| {
            locale_compare(&sort_surname(&a.summary), &sort_surname(&b.summary))
                .then(a.index.cmp(&b.index))
        }),
        BibSort::Title => matching.sort_by(|a, b| {
            locale_compare(&a.summary.title, &b.summary.title).then(a.index.cmp(&b.index))
        }),
    }
    matching
}

/// What a reference's open control offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaperState {
    Open,
    Download,
    Downloading,
    None,
}

/// The paper for the entry `key` among `papers` (by citation key, else by
/// arXiv id or web address), else one made from the entry itself when it
/// names a source the download takes (`entryPaper`).
pub fn entry_paper(
    papers: &[PaperSummary],
    key: &str,
    summary: &BibSummary,
    fetches: &HashMap<String, FetchState>,
) -> (Option<PaperSummary>, PaperState) {
    let found = papers
        .iter()
        .find(|paper| {
            paper
                .citation_key
                .as_deref()
                .is_some_and(|own| own.eq_ignore_ascii_case(key))
        })
        .or_else(|| {
            (!summary.arxiv_id.is_empty())
                .then(|| {
                    papers
                        .iter()
                        .find(|paper| paper.arxiv_id == summary.arxiv_id)
                })
                .flatten()
        })
        .or_else(|| {
            (!summary.url.is_empty())
                .then(|| {
                    papers
                        .iter()
                        .find(|paper| paper.url.as_deref() == Some(summary.url.as_str()))
                })
                .flatten()
        })
        .cloned()
        .or_else(|| {
            (!summary.arxiv_id.is_empty() || !summary.url.is_empty()).then(|| PaperSummary {
                arxiv_id: summary.arxiv_id.clone(),
                doi: (!summary.doi.is_empty()).then(|| summary.doi.clone()),
                url: (!summary.url.is_empty()).then(|| summary.url.clone()),
                title: if summary.title.is_empty() {
                    key.to_string()
                } else {
                    summary.title.clone()
                },
                authors: summary.authors.clone(),
                year: (!summary.year.is_empty()).then(|| summary.year.clone()),
                citation_key: Some(key.to_string()),
                has_full_text: false,
                has_blog: false,
                has_local_pdf: false,
                asset_paths: Vec::new(),
                citation_health: None,
            })
        });
    let Some(paper) = found else {
        return (None, PaperState::None);
    };
    let state = if fetches.get(&paper_key(&paper)) == Some(&FetchState::Loading) {
        PaperState::Downloading
    } else if paper.has_full_text || paper.has_blog {
        PaperState::Open
    } else if can_download(&paper) {
        PaperState::Download
    } else {
        PaperState::None
    };
    (Some(paper), state)
}

/// The entry types the type menu offers; an entry of another type keeps it
/// and lists it too.
pub const ENTRY_TYPES: [&str; 14] = [
    "article",
    "inproceedings",
    "book",
    "incollection",
    "inbook",
    "proceedings",
    "phdthesis",
    "mastersthesis",
    "techreport",
    "misc",
    "online",
    "unpublished",
    "manual",
    "booklet",
];

/// Fields whose values run long enough for a box that wraps.
pub fn long_field(name: &str, text: &str) -> bool {
    const LONG: [&str; 10] = [
        "title",
        "author",
        "editor",
        "abstract",
        "note",
        "annote",
        "annotation",
        "keywords",
        "booktitle",
        "journal",
    ];
    LONG.contains(&name.to_lowercase().as_str()) || text.chars().count() > 48 || text.contains('\n')
}

/// A field name BibTeX reads: a letter, then no spaces.
pub fn valid_field_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || "_:.+-".contains(ch))
}

/// A new entry as the add dialog drafts it (`BibEntryDraft`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    pub entry_type: String,
    pub key: String,
    pub title: String,
    pub author: String,
    pub year: String,
    pub journal: String,
    pub booktitle: String,
    pub publisher: String,
    pub url: String,
    pub doi: String,
    /// A resolved record's other fields, as parsed BibTeX values.
    pub extra: Vec<(String, String)>,
}

/// A key from the first author's surname, the year and the title's first
/// word: `vaswani2017attention` (`slugifyCitationKey`).
pub fn slug_key(title: &str, author: &str, year: &str) -> String {
    let lower = author.to_ascii_lowercase();
    let first_author = &author[..lower.find(" and ").unwrap_or(author.len())];
    let last = first_author
        .split(',')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .last()
        .unwrap_or("");
    let word = title
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .find(|word| !word.is_empty())
        .unwrap_or("work");
    let year = year
        .as_bytes()
        .windows(4)
        .find(|window| window.iter().all(u8::is_ascii_digit))
        .map_or("0000".to_string(), |digits| {
            String::from_utf8_lossy(digits).into_owned()
        });
    let surname: String = last
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    format!("{surname}{year}{}", word.to_lowercase())
}

/// The entry `key` at `index`, else the first under that key: the place
/// tells apart entries sharing a key while it still names one.
pub fn row_at<'a>(rows: &'a [Row], key: &str, index: usize) -> Option<&'a Row> {
    rows.iter()
        .find(|row| row.index == index && row.entry.key == key)
        .or_else(|| rows.iter().find(|row| row.entry.key == key))
}

/// A DOI as the form links it: `10.`, four to nine digits, a slash and no
/// space after (`/^10\.\d{4,9}\/\S+$/`).
pub fn is_doi(doi: &str) -> bool {
    let Some(rest) = doi.strip_prefix("10.") else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let suffix = &rest[digits..];
    (4..=9).contains(&digits)
        && suffix
            .strip_prefix('/')
            .is_some_and(|suffix| !suffix.is_empty() && !suffix.contains(char::is_whitespace))
}

/// Braces that do not pair are dropped (`escapeBibValue`). An escaped one
/// (`\{`) counts too: BibTeX pairs every brace in a value, so a lone one
/// kept would leave the file unreadable.
fn escape_value(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut unmatched = std::collections::HashSet::new();
    let mut openings = Vec::new();
    for (index, ch) in chars.iter().enumerate() {
        if *ch == '{' {
            openings.push(index);
        } else if *ch == '}' && openings.pop().is_none() {
            unmatched.insert(index);
        }
    }
    unmatched.extend(openings);
    chars
        .iter()
        .enumerate()
        .filter(|(index, _)| !unmatched.contains(index))
        .map(|(_, ch)| ch)
        .collect()
}

impl Draft {
    /// The key the entry is saved under: the one typed, else the slug.
    pub fn key(&self) -> String {
        let typed = self.key.trim();
        if typed.is_empty() {
            slug_key(&self.title, &self.author, &self.year)
        } else {
            typed.to_string()
        }
    }

    /// The DOI without a resolver's address.
    pub fn doi(&self) -> String {
        let doi = self.doi.trim();
        let lower = doi.to_lowercase();
        [
            "https://doi.org/",
            "http://doi.org/",
            "https://dx.doi.org/",
            "http://dx.doi.org/",
        ]
        .iter()
        .find(|prefix| lower.starts_with(*prefix))
        .map_or(doi, |prefix| &doi[prefix.len()..])
        .trim()
        .to_string()
    }

    /// The entry as the file will hold it (`formatBibEntry`).
    pub fn format(&self) -> String {
        let doi = self.doi();
        let url = if self.url.trim().is_empty() && !doi.is_empty() {
            format!("https://doi.org/{doi}")
        } else {
            self.url.clone()
        };
        let mut fields: Vec<(&str, String)> = vec![
            ("title", self.title.clone()),
            ("author", self.author.clone()),
            ("year", self.year.clone()),
        ];
        match self.entry_type.as_str() {
            "article" => fields.push(("journal", self.journal.clone())),
            "inproceedings" => fields.push(("booktitle", self.booktitle.clone())),
            "book" => fields.push(("publisher", self.publisher.clone())),
            _ => {}
        }
        fields.push(("url", url));
        fields.push(("doi", doi));
        // A resolver returns only fields the form does not model; checking
        // here keeps a stale one from overriding what was typed. They are
        // parsed BibTeX values, so their braces stay as they are.
        const MODELED: [&str; 8] = [
            "title",
            "author",
            "year",
            "journal",
            "booktitle",
            "publisher",
            "url",
            "doi",
        ];
        let extra = self.extra.iter().filter(|(name, value)| {
            !MODELED.contains(&name.to_lowercase().as_str())
                && name
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_ascii_alphabetic())
                && name
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
                && !value.trim().is_empty()
        });
        let body = fields
            .iter()
            .filter(|(_, value)| !value.trim().is_empty())
            .map(|(name, value)| format!("  {name} = {{{}}}", escape_value(value.trim())))
            .chain(extra.map(|(name, value)| format!("  {name} = {{{}}}", value.trim())))
            .collect::<Vec<_>>()
            .join(",\n");
        format!("@{}{{{},\n{body}\n}}\n", self.entry_type, self.key())
    }
}

/// What a lookup query already says about the work (`fieldsFromQuery`):
/// only a query that is wholly a DOI, a link or an arXiv id fills that
/// field; anything else is taken as the title.
#[derive(Debug, PartialEq, Eq)]
pub enum QueryFill {
    Doi(String),
    Url(String),
    Title(String),
}

pub fn fields_from_query(query: &str) -> Option<QueryFill> {
    use regex::Regex;
    static DOI: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/\S+)$").unwrap()
    });
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://\S+$").unwrap());
    static ARXIV: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)^(?:arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?)$",
        )
        .unwrap()
    });
    let value = query.trim();
    if let Some(doi) = DOI.captures(value) {
        return Some(QueryFill::Doi(doi[1].to_string()));
    }
    if LINK.is_match(value) {
        return Some(QueryFill::Url(value.to_string()));
    }
    if let Some(arxiv) = ARXIV.captures(value) {
        return Some(QueryFill::Url(format!(
            "https://arxiv.org/abs/{}",
            &arxiv[1]
        )));
    }
    (!value.is_empty()).then(|| QueryFill::Title(value.to_string()))
}

/// `existing` with `entry` appended after a blank line (`appendBibEntry`);
/// refused when the key is taken.
/// The keys taken are read from `existing` itself, never a list drawn from
/// an older text; a text that does not read whole is not appended to. The
/// edit touches only the file's end, so the rest keeps its place.
pub fn append_entry(existing: &str, entry: &str, key: &str) -> Result<BibEdit, String> {
    let document = bib_document::parse(existing)
        .map_err(|error| crate::papers::bib_editor::unreadable_reason(&error))?;
    if document
        .entries
        .iter()
        .any(|other| other.key.eq_ignore_ascii_case(key))
    {
        return Err(t!(
            "Citation key ''{key}'' already exists. Choose a different key or edit the existing reference.",
            key = key
        ));
    }
    let kept = existing.trim_end().len();
    let terminated = if entry.ends_with('\n') {
        entry.to_string()
    } else {
        format!("{entry}\n")
    };
    Ok(BibEdit {
        from: kept,
        to: existing.len(),
        insert: if kept == 0 {
            terminated
        } else {
            format!("\n\n{terminated}")
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::model::test_support::{paper, with};

    fn row(index: usize, key: &str, title: &str, year: &str, authors: &str) -> Row {
        Row {
            entry: BibEntry {
                key: key.into(),
                ..Default::default()
            },
            summary: BibSummary {
                title: title.into(),
                year: year.into(),
                authors: authors.into(),
                haystack: format!("{key} {title} {authors} {year}").to_lowercase(),
                ..Default::default()
            },
            index,
        }
    }

    fn usage(symbol: &str) -> SymbolOccurrence {
        SymbolOccurrence {
            kind: "citation".into(),
            symbol: symbol.into(),
            role: "use".into(),
            path: "main.tex".into(),
            line: 1,
            snippet: String::new(),
        }
    }

    #[test]
    fn the_list_filters_by_use_and_words_and_sorts_with_file_order_breaking_ties() {
        let rows = vec![
            row(0, "knuth1984", "The TeXbook", "1984", "Donald Knuth"),
            row(
                1,
                "vaswani2017",
                "Attention Is All You Need",
                "2017",
                "Ashish Vaswani",
            ),
            row(2, "lamport1994", "LaTeX", "1994", "Leslie Lamport"),
        ];
        let usages = Usages::group(vec![usage("Knuth1984")]);
        let keys = |shown: Vec<&Row>| {
            shown
                .iter()
                .map(|row| row.entry.key.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            keys(shown(
                &rows,
                "",
                BibFilter::Cited,
                BibSort::File,
                Some(&usages)
            )),
            ["knuth1984"]
        );
        assert_eq!(
            keys(shown(
                &rows,
                "",
                BibFilter::Unused,
                BibSort::Year,
                Some(&usages)
            )),
            ["vaswani2017", "lamport1994"]
        );
        assert_eq!(
            keys(shown(
                &rows,
                "att need",
                BibFilter::All,
                BibSort::File,
                None
            )),
            ["vaswani2017"]
        );
        assert_eq!(
            keys(shown(&rows, "", BibFilter::All, BibSort::Author, None)),
            ["knuth1984", "lamport1994", "vaswani2017"]
        );
        // Without the scan nothing is unused; \nocite{*} uses everything.
        assert!(!is_unused(None, "lamport1994"));
        let everything = Usages::group(vec![usage("*")]);
        assert!(!is_unused(Some(&everything), "lamport1994"));
    }

    #[test]
    fn a_reference_opens_its_paper_or_downloads_it_first() {
        let summary = BibSummary {
            arxiv_id: "1706.03762".into(),
            title: "Attention".into(),
            ..Default::default()
        };
        let none = HashMap::new();
        let (made, state) = entry_paper(&[], "vaswani2017", &summary, &none);
        assert_eq!(state, PaperState::Download);
        assert_eq!(made.unwrap().citation_key.as_deref(), Some("vaswani2017"));
        let saved = with(paper("Attention"), |paper| {
            paper.arxiv_id = "1706.03762".into();
            paper.citation_key = Some("Vaswani2017".into());
            paper.has_full_text = true;
        });
        assert_eq!(
            entry_paper(&[saved], "vaswani2017", &summary, &none).1,
            PaperState::Open
        );
        assert_eq!(
            entry_paper(&[], "x", &BibSummary::default(), &none).1,
            PaperState::None
        );
    }

    #[test]
    fn a_new_entry_is_written_as_the_tauri_app_writes_it() {
        let draft = Draft {
            entry_type: "article".into(),
            title: "Attention Is {All} You Need}".into(),
            author: "Vaswani, Ashish and Shazeer, Noam".into(),
            year: "2017".into(),
            journal: "NeurIPS".into(),
            doi: "https://doi.org/10.1/x".into(),
            ..Default::default()
        };
        assert_eq!(draft.key(), "vaswani2017attention");
        assert_eq!(
            draft.format(),
            "@article{vaswani2017attention,\n  title = {Attention Is {All} You Need},\n  author = {Vaswani, Ashish and Shazeer, Noam},\n  year = {2017},\n  journal = {NeurIPS},\n  url = {https://doi.org/10.1/x},\n  doi = {10.1/x}\n}\n"
        );
        let appended = |existing: &str, entry: &str, key: &str| {
            append_entry(existing, entry, key).map(|edit| bib_document::apply_edit(existing, &edit))
        };
        assert_eq!(
            appended("@misc{a}\n\n\n", "@misc{b}", "b").unwrap(),
            "@misc{a}\n\n@misc{b}\n"
        );
        assert_eq!(appended("", "@misc{b}", "b").unwrap(), "@misc{b}\n");
        assert!(appended("@misc{a}", "@misc{A}", "A").is_err());
        assert!(appended("@misc{a,", "@misc{b}", "b").is_err());
        let tail = append_entry("@misc{a}\n", "@misc{b}", "b").unwrap();
        assert_eq!((tail.from, tail.to), (8, 9));
    }

    // The order `localeCompare` gives in the Tauri app: accented letters
    // sort with their base letter, not after "z".
    #[test]
    fn the_author_and_title_sorts_follow_the_locale_order() {
        let rows = vec![
            row(0, "z", "Zeta", "2001", "Anna Zimmer"),
            row(1, "u", "Über Wellen", "2002", "Kari Ølberg"),
            row(2, "a", "alpha", "2003", "Rui Évora"),
            row(3, "f", "Fourier", "2004", "Hans Fischer"),
        ];
        let keys = |sort| {
            shown(&rows, "", BibFilter::All, sort, None)
                .iter()
                .map(|row| row.entry.key.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(BibSort::Title), ["a", "f", "u", "z"]);
        assert_eq!(keys(BibSort::Author), ["a", "f", "u", "z"]);
    }

    #[test]
    fn a_lone_brace_is_dropped_even_when_escaped() {
        let draft = Draft {
            entry_type: "misc".into(),
            title: r"Set \{x".into(),
            key: "k".into(),
            ..Default::default()
        };
        let entry = draft.format();
        assert!(entry.contains(r"title = {Set \x}"), "{entry}");
        assert!(lattice_core::bib_document::parse(&entry).is_ok(), "{entry}");
        let paired = Draft {
            title: r"Set \{x\}".into(),
            ..draft
        };
        assert!(paired.format().contains(r"title = {Set \{x\}}"));
    }

    #[test]
    fn a_query_fills_the_field_it_names_in_any_case() {
        assert_eq!(
            fields_from_query("DOI:10.1234/abc"),
            Some(QueryFill::Doi("10.1234/abc".into()))
        );
        assert_eq!(
            fields_from_query("https://DX.doi.org/10.1234/abc"),
            Some(QueryFill::Doi("10.1234/abc".into()))
        );
        assert_eq!(
            fields_from_query("1706.03762"),
            Some(QueryFill::Url("https://arxiv.org/abs/1706.03762".into()))
        );
        assert_eq!(
            fields_from_query("ArXiv:hep-th/9901001v2"),
            Some(QueryFill::Url(
                "https://arxiv.org/abs/hep-th/9901001v2".into()
            ))
        );
        assert_eq!(
            fields_from_query("https://example.com/p"),
            Some(QueryFill::Url("https://example.com/p".into()))
        );
        assert_eq!(
            fields_from_query(" Attention "),
            Some(QueryFill::Title("Attention".into()))
        );
        assert_eq!(fields_from_query("  "), None);
    }

    #[test]
    fn field_names_start_with_a_letter() {
        assert!(valid_field_name("eprint"));
        assert!(valid_field_name("bdsk-url-1"));
        assert!(!valid_field_name("1st"));
        assert!(!valid_field_name("two words"));
        // `/^[A-Za-z][\w:.+-]*$/` without the u flag: \w is ASCII only.
        assert!(!valid_field_name("titlé"));
        assert!(!valid_field_name(""));
    }

    /// `slugifyCitationKey` (bib-entry.ts), worked by hand: the first
    /// author's surname however "and" is cased, and nothing for no author.
    #[test]
    fn a_key_is_made_as_the_tauri_app_makes_it() {
        let title = "Attention Is All You Need";
        let authors = "Vaswani, Ashish AND Shazeer, Noam";
        assert_eq!(slug_key(title, authors, "2017"), "vaswani2017attention");
        assert_eq!(slug_key(title, "", "2017"), "2017attention");
    }

    /// A looked-up record's note is written, as `formatBibEntry` writes it
    /// when the form has no note box of its own.
    #[test]
    fn a_resolved_note_is_kept() {
        let draft = Draft {
            entry_type: "misc".into(),
            key: "k".into(),
            title: "T".into(),
            extra: vec![("note".into(), "Accepted".into())],
            ..Default::default()
        };
        assert!(
            draft.format().contains("note = {Accepted}"),
            "{}",
            draft.format()
        );
    }

    /// The Tauri form's `/^10\.\d{4,9}\/\S+$/`, case by case.
    #[test]
    fn a_doi_is_linked_as_the_tauri_form_links_it() {
        assert!(is_doi("10.1234/abc"));
        assert!(is_doi("10.123456789/x.y"));
        assert!(!is_doi("10.1234"));
        assert!(!is_doi("10.123/abc"));
        assert!(!is_doi("10.1234567890/abc"));
        assert!(!is_doi("10.1234/a b"));
        assert!(!is_doi("doi:10.1234/abc"));
    }
}
