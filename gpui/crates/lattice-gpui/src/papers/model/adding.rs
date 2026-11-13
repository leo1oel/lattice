//! What the search box or Add papers would add, and whether the library
//! already holds it (`paper-add.ts`: `referenceKind`, `identityOfInput`,
//! `findInLibrary`, `parsePastedReferences`, `recordOfResolved`), and how far
//! an import's hairline has got (`paper-import-progress.ts`).

use lattice_i18n::t;
use std::{collections::HashSet, sync::LazyLock};

use lattice_core::{bib_document, models::ResolvedCitation, papers::PaperSummary};
use regex::Regex;

use super::identity::{BIBTEX, DOI, WEB_URL, base_arxiv_id, explicit_arxiv_id};

// What the box would add.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceKind {
    Arxiv,
    Doi,
    Url,
    Bibtex,
    Title,
}

impl ReferenceKind {
    pub fn label(self) -> &'static str {
        match self {
            ReferenceKind::Arxiv => "arXiv",
            ReferenceKind::Doi => "DOI",
            ReferenceKind::Url => t!("Web page"),
            ReferenceKind::Bibtex => "BibTeX",
            ReferenceKind::Title => t!("Title"),
        }
    }
}

/// The kind of reference `input` is, or `None` for an empty box.
pub fn reference_kind(input: &str) -> Option<ReferenceKind> {
    let value = input.trim();
    if value.is_empty() {
        None
    } else if BIBTEX.is_match(value) {
        Some(ReferenceKind::Bibtex)
    } else if explicit_arxiv_id(value).is_some() {
        Some(ReferenceKind::Arxiv)
    } else if DOI.is_match(value) {
        Some(ReferenceKind::Doi)
    } else if WEB_URL.is_match(value) {
        Some(ReferenceKind::Url)
    } else {
        Some(ReferenceKind::Title)
    }
}

/// What identifies a work, lower-cased.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkIdentity {
    pub arxiv_id: Option<String>,
    pub doi: Option<String>,
    pub key: Option<String>,
    pub title: Option<String>,
}

fn normal_doi(value: &str) -> Option<String> {
    DOI.captures(value.trim())
        .and_then(|found| found.get(1))
        .map(|doi| doi.as_str().to_lowercase())
}

fn arxiv_of_doi(doi: Option<&str>) -> Option<String> {
    static ARXIV_DOI: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^10\.48550/arxiv\.(.+)$").unwrap());
    let id = ARXIV_DOI.captures(doi?)?.get(1)?.as_str();
    explicit_arxiv_id(id)
}

/// The identity a typed identifier carries on its own, before any lookup;
/// an arXiv DOI (10.48550/arXiv.…) counts as its arXiv id.
pub fn identity_of_input(input: &str) -> WorkIdentity {
    let value = input.trim();
    let doi = normal_doi(value);
    WorkIdentity {
        arxiv_id: explicit_arxiv_id(value).or_else(|| arxiv_of_doi(doi.as_deref())),
        doi,
        key: None,
        title: None,
    }
}

/// Titles compare by their letters and digits alone, case aside.
fn title_key(title: &str) -> String {
    title
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The library's paper that is this work, matched by arXiv id, DOI or
/// citation key, and by title only when the title is long enough to name
/// one work.
pub fn find_in_library<'a>(
    papers: &'a [PaperSummary],
    identity: &WorkIdentity,
) -> Option<&'a PaperSummary> {
    let arxiv = identity.arxiv_id.as_deref().map(str::to_lowercase);
    let doi = identity.doi.as_deref().map(str::to_lowercase);
    papers
        .iter()
        .find(|paper| {
            arxiv
                .as_deref()
                .is_some_and(|id| base_arxiv_id(&paper.arxiv_id).to_lowercase() == id)
                || doi.as_deref().is_some_and(|doi| {
                    paper.doi.as_deref().map(str::to_lowercase).as_deref() == Some(doi)
                })
                || identity
                    .key
                    .as_deref()
                    .is_some_and(|key| paper.citation_key.as_deref() == Some(key))
        })
        .or_else(|| {
            let title = title_key(identity.title.as_deref()?);
            (title.chars().count() >= 12)
                .then(|| papers.iter().find(|paper| title_key(&paper.title) == title))
                .flatten()
        })
}

/// How far an import's or a download's hairline has got after `elapsed` in
/// `stage`, as a fraction: estimated motion, not measured bytes, through
/// most of each stage and then creeping toward its ceiling, never 100%
/// (`paperImportProgressAt`). The clock restarts at each stage, so a new
/// stage continues from the previous one's ceiling.
pub fn progress_at(stage: Option<&str>, elapsed: std::time::Duration) -> f32 {
    let (start, ceiling, millis) = match stage {
        Some("fulltext") => (0.33, 0.66, 12_000.),
        Some("overview") => (0.66, 0.95, 4_000.),
        _ => (0., 0.33, 4_000.),
    };
    let time = elapsed.as_secs_f32() * 1000. / millis;
    let fraction = if time <= 1. {
        0.9 * time
    } else {
        1. - 0.1 * (1. - time).exp()
    };
    start + (ceiling - start) * fraction
}

/// Whether this window just added `paper`.
pub fn is_just_added(paper: &PaperSummary, just_added: &HashSet<String>) -> bool {
    paper
        .citation_key
        .as_deref()
        .is_some_and(|key| just_added.contains(key))
        || (!paper.arxiv_id.is_empty() && just_added.contains(&paper.arxiv_id))
}

/// A record as a card shows it: title, "Hewitt and Liang, 2019, EMNLP", and
/// what identifies it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReferenceRecord {
    pub title: String,
    pub byline: String,
    pub identity: WorkIdentity,
}

/// The parts of a line that hold something, joined as one.
pub fn byline_of<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    parts
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// One reference the writer pasted: the text as given, and what it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PastedReference {
    /// Stable for the same text, so a re-read of the box keeps each line's
    /// lookup.
    pub id: String,
    pub kind: ReferenceKind,
    /// What the import is given: the line, or the whole BibTeX entry.
    pub input: String,
    /// The line as the card shows it (an entry's key for BibTeX).
    pub label: String,
    /// Read straight from a pasted BibTeX entry; every other kind is looked
    /// up.
    pub record: Option<ReferenceRecord>,
}

/// Everything pasted, one reference per line, with each BibTeX entry (a
/// whole .bib, say) taken whole. `%` comments and blank lines are skipped,
/// and a reference pasted twice is read once.
pub fn parse_pasted_references(text: &str) -> Vec<PastedReference> {
    let mut found: Vec<(usize, PastedReference)> = Vec::new();
    let mut rest = text.to_string();
    if Regex::new(r"@\w+\s*\{").unwrap().is_match(text)
        && let Ok(document) = bib_document::parse(text)
    {
        let mut blanked = text.as_bytes().to_vec();
        // `@string`, `@comment` and `@preamble` blocks are no references,
        // and no line inside one is either.
        for directive in &document.directives {
            for byte in &mut blanked[directive.clone()] {
                if *byte != b'\n' {
                    *byte = b' ';
                }
            }
        }
        for entry in &document.entries {
            // The entry's bytes stand blank for the line pass, keeping
            // its line breaks so offsets stay put.
            for byte in &mut blanked[entry.from..entry.to] {
                if *byte != b'\n' {
                    *byte = b' ';
                }
            }
            let source = &text[entry.from..entry.to];
            let summary = bib_document::summarize_entry(text, entry, &document.macros);
            let doi = normal_doi(&summary.doi);
            let arxiv = Some(summary.arxiv_id.clone())
                .filter(|id| !id.is_empty())
                .or_else(|| arxiv_of_doi(doi.as_deref()));
            found.push((
                entry.from,
                PastedReference {
                    id: format!("bibtex:{source}"),
                    kind: ReferenceKind::Bibtex,
                    input: source.to_string(),
                    label: entry.key.clone(),
                    record: Some(ReferenceRecord {
                        title: if summary.title.is_empty() {
                            entry.key.clone()
                        } else {
                            summary.title.clone()
                        },
                        byline: byline_of([
                            summary.short_authors.as_str(),
                            summary.year.as_str(),
                            summary.venue.as_str(),
                        ]),
                        identity: WorkIdentity {
                            arxiv_id: arxiv,
                            doi,
                            key: Some(entry.key.clone()),
                            title: Some(summary.title.clone()),
                        },
                    }),
                },
            ));
        }
        // Blanking replaced ASCII bytes inside entries only; what is
        // left outside them is the text as pasted.
        rest = String::from_utf8_lossy(&blanked).into_owned();
    }
    let mut offset = 0;
    for line in rest.split('\n') {
        let value = line.trim();
        if let Some(kind) = reference_kind(value).filter(|_| !value.starts_with('%')) {
            found.push((
                offset,
                PastedReference {
                    id: format!("{}:{value}", kind.label()),
                    kind,
                    input: value.to_string(),
                    label: value.to_string(),
                    record: None,
                },
            ));
        }
        offset += line.len() + 1;
    }
    found.sort_by_key(|(at, _)| *at);
    let mut seen = HashSet::new();
    found
        .into_iter()
        .map(|(_, reference)| reference)
        .filter(|reference| seen.insert(reference.id.clone()))
        .collect()
}

/// The resolver's record, as a card shows it.
pub fn record_of_resolved(resolved: &ResolvedCitation) -> ReferenceRecord {
    let venue = [&resolved.journal, &resolved.booktitle, &resolved.publisher]
        .into_iter()
        .find(|venue| !venue.is_empty())
        .map(|venue| bib_document::bib_text_to_plain(venue))
        .unwrap_or_default();
    let doi = normal_doi(&resolved.doi);
    let title = bib_document::bib_text_to_plain(&resolved.title);
    let short = bib_document::short_authors(&resolved.author)
        .map(|authors| bib_document::bib_text_to_plain(&authors))
        .unwrap_or_default();
    ReferenceRecord {
        byline: byline_of([short.as_str(), resolved.year.as_str(), venue.as_str()]),
        identity: WorkIdentity {
            arxiv_id: explicit_arxiv_id(&resolved.url).or_else(|| arxiv_of_doi(doi.as_deref())),
            doi,
            key: None,
            title: Some(title.clone()),
        },
        title,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::model::test_support::{paper, with};

    #[test]
    fn the_box_says_what_it_would_add() {
        assert_eq!(reference_kind("  "), None);
        assert_eq!(reference_kind("1706.03762"), Some(ReferenceKind::Arxiv));
        assert_eq!(
            reference_kind("https://arxiv.org/abs/1706.03762v5"),
            Some(ReferenceKind::Arxiv)
        );
        assert_eq!(
            reference_kind("doi:10.1145/3442188.3445922"),
            Some(ReferenceKind::Doi)
        );
        assert_eq!(
            reference_kind("https://example.com/a"),
            Some(ReferenceKind::Url)
        );
        assert_eq!(
            reference_kind("@article{x, title={y}}"),
            Some(ReferenceKind::Bibtex)
        );
        assert_eq!(
            reference_kind("Attention is all you need"),
            Some(ReferenceKind::Title)
        );
        assert_eq!(
            identity_of_input("10.48550/arXiv.1706.03762")
                .arxiv_id
                .as_deref(),
            Some("1706.03762")
        );
    }

    #[test]
    fn the_library_finds_a_work_it_holds() {
        let papers = vec![
            with(paper("Attention Is All You Need"), |p| {
                p.arxiv_id = "1706.03762".into()
            }),
            with(paper("Other"), |p| p.doi = Some("10.1000/ABC".into())),
        ];
        let found = find_in_library(&papers, &identity_of_input("arXiv:1706.03762v7"));
        assert_eq!(
            found.map(|p| p.title.as_str()),
            Some("Attention Is All You Need")
        );
        let found = find_in_library(&papers, &identity_of_input("https://doi.org/10.1000/abc"));
        assert_eq!(found.map(|p| p.title.as_str()), Some("Other"));
        let short = WorkIdentity {
            title: Some("Other".into()),
            ..Default::default()
        };
        assert!(find_in_library(&papers, &short).is_none());
    }

    #[test]
    fn a_paste_reads_one_reference_per_line_and_bibtex_whole() {
        let pasted = "10.1038/s41586-021-03819-2\n% skipped\n\n@article{vaswani2017,\n  title = {Attention Is All You Need},\n  author = {Vaswani, Ashish},\n  year = {2017},\n  eprint = {1706.03762}\n}\nAttention is all you need\n10.1038/s41586-021-03819-2\n";
        let references = parse_pasted_references(pasted);
        let kinds: Vec<ReferenceKind> = references.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            [
                ReferenceKind::Doi,
                ReferenceKind::Bibtex,
                ReferenceKind::Title
            ]
        );
        let bibtex = &references[1];
        assert_eq!(bibtex.label, "vaswani2017");
        let record = bibtex.record.as_ref().unwrap();
        assert_eq!(record.title, "Attention Is All You Need");
        assert_eq!(record.byline, "Vaswani, 2017, arXiv");
        assert_eq!(record.identity.arxiv_id.as_deref(), Some("1706.03762"));
    }

    #[test]
    fn a_pasted_bib_s_strings_and_comments_are_no_references() {
        let pasted = "@string{nips = \"NeurIPS\"}\n@comment{\n10.1038/s41586-021-03819-2\n}\n@inproceedings{a,\n  title = {A},\n  booktitle = nips\n}\n";
        let references = parse_pasted_references(pasted);
        let labels: Vec<(ReferenceKind, &str)> = references
            .iter()
            .map(|reference| (reference.kind, reference.label.as_str()))
            .collect();
        assert_eq!(labels, [(ReferenceKind::Bibtex, "a")]);
    }
}
