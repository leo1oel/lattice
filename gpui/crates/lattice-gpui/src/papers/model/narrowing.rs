//! How the list narrows and orders the library (`paper-library-view.ts`,
//! `paper-library-search.ts`): what the manuscript and bibliography say of a
//! paper, the filters, sorts and groups the toolbar offers, and how a query
//! ranks the library, metadata first, then the full-text index's papers.

use std::{cmp::Ordering, collections::HashMap};

use lattice_core::{models::SymbolOccurrence, papers::PaperSummary};

use super::identity::{
    ReadingState, TOKEN_ARXIV, base_arxiv_id, is_flagged, readable, reading_state, search_identity,
    short_authors,
};

// What the manuscript and bibliography say of a paper.

/// The venue each citation key's entry names, and where the manuscript
/// cites each key (lowercased, as LaTeX matches them). `uses` is `None`
/// until the manuscript has been scanned, so a paper is never called
/// uncited on no evidence.
#[derive(Clone, Default)]
pub struct Facts {
    pub venues: HashMap<String, String>,
    pub uses: Option<HashMap<String, Vec<SymbolOccurrence>>>,
}

impl Facts {
    pub fn group_uses(usages: Vec<SymbolOccurrence>) -> HashMap<String, Vec<SymbolOccurrence>> {
        let mut uses: HashMap<String, Vec<SymbolOccurrence>> = HashMap::new();
        for usage in usages {
            // `\nocite{*}` lists every entry without citing any of them.
            if usage.symbol == "*" {
                continue;
            }
            uses.entry(usage.symbol.to_lowercase())
                .or_default()
                .push(usage);
        }
        uses
    }

    pub fn venue(&self, paper: &PaperSummary) -> &str {
        paper
            .citation_key
            .as_deref()
            .and_then(|key| self.venues.get(key))
            .map(String::as_str)
            .unwrap_or("")
    }

    pub fn uses(&self, paper: &PaperSummary) -> Option<usize> {
        let uses = self.uses.as_ref()?;
        Some(
            paper
                .citation_key
                .as_deref()
                .and_then(|key| uses.get(&key.to_lowercase()))
                .map_or(0, Vec::len),
        )
    }

    pub fn usages(&self, paper: &PaperSummary) -> Option<&[SymbolOccurrence]> {
        let uses = self.uses.as_ref()?;
        Some(
            paper
                .citation_key
                .as_deref()
                .and_then(|key| uses.get(&key.to_lowercase()))
                .map_or(&[][..], Vec::as_slice),
        )
    }
}

/// "title" is the library's own order (by title), or best match first
/// while searching.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Sort {
    #[default]
    Title,
    Year,
    Author,
    Venue,
    Cited,
}

impl Sort {
    pub const ALL: [Sort; 5] = [
        Sort::Title,
        Sort::Year,
        Sort::Author,
        Sort::Venue,
        Sort::Cited,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Sort::Title => "Title",
            Sort::Year => "Newest first",
            Sort::Author => "First author",
            Sort::Venue => "Venue",
            Sort::Cited => "Most cited here",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Filter {
    #[default]
    All,
    Cited,
    Uncited,
    FullText,
    Flagged,
}

impl Filter {
    pub const ALL: [Filter; 5] = [
        Filter::All,
        Filter::Cited,
        Filter::Uncited,
        Filter::FullText,
        Filter::Flagged,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Filter::All => "All papers",
            Filter::Cited => "Cited in this paper",
            Filter::Uncited => "Not cited yet",
            Filter::FullText => "With full text",
            Filter::Flagged => "Flagged",
        }
    }

    /// The cited filters need the manuscript's citations scanned.
    pub fn needs_uses(self) -> bool {
        matches!(self, Filter::Cited | Filter::Uncited)
    }

    pub fn keeps(self, paper: &PaperSummary, facts: &Facts) -> bool {
        match self {
            Filter::All => true,
            Filter::Cited => facts.uses(paper).unwrap_or(0) > 0,
            Filter::Uncited => facts.uses(paper) == Some(0),
            Filter::FullText => readable(paper),
            Filter::Flagged => is_flagged(paper),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Group {
    #[default]
    None,
    Year,
    Venue,
    State,
}

impl Group {
    pub const ALL: [Group; 4] = [Group::None, Group::Year, Group::Venue, Group::State];

    pub fn label(self) -> &'static str {
        match self {
            Group::None => "No grouping",
            Group::Year => "Year",
            Group::Venue => "Venue",
            Group::State => "Reading state",
        }
    }
}

/// Compare numerically where both runs of digits are numbers, as
/// `localeCompare(…, { numeric: true })` does for years.
fn numeric_compare(left: &str, right: &str) -> Ordering {
    match (left.parse::<u64>(), right.parse::<u64>()) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        _ => left.to_lowercase().cmp(&right.to_lowercase()),
    }
}

fn text_compare(left: &str, right: &str) -> Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| left.cmp(right))
}

/// The chosen sort as a comparison, or `None` for the library's own order.
/// Text sorts run A to Z, the year newest first and uses most first; a paper
/// with no value goes last.
pub fn compare(sort: Sort, facts: &Facts, a: &PaperSummary, b: &PaperSummary) -> Ordering {
    let key = |paper: &PaperSummary| -> String {
        match sort {
            Sort::Year => paper.year.as_deref().unwrap_or("").trim().to_string(),
            Sort::Venue => facts.venue(paper).to_string(),
            Sort::Author => short_authors(paper).unwrap_or_default(),
            Sort::Title | Sort::Cited => String::new(),
        }
    };
    match sort {
        Sort::Title => Ordering::Equal,
        Sort::Cited => facts.uses(b).unwrap_or(0).cmp(&facts.uses(a).unwrap_or(0)),
        _ => {
            let (left, right) = (key(a), key(b));
            left.is_empty()
                .cmp(&right.is_empty())
                .then_with(|| match sort {
                    Sort::Year => numeric_compare(&right, &left),
                    _ => text_compare(&left, &right),
                })
        }
    }
}

/// A paper the full-text index matched, with its place in the index's
/// ranking and its best lines.
#[derive(Clone, Debug)]
pub struct TextMatch {
    pub rank: usize,
    pub hits: Vec<LineHit>,
}

/// A line of a paper that matched, around its first match; `highlights` are
/// byte ranges of `text`.
#[derive(Clone, Debug, PartialEq)]
pub struct LineHit {
    pub path: String,
    pub line: u32,
    pub text: String,
    pub highlights: Vec<std::ops::Range<usize>>,
}

impl LineHit {
    /// lattice-core's hit, its UTF-16 ranges turned into byte ranges of the
    /// line, so a range never splits a character.
    pub fn from_core(hit: lattice_core::papers::LineHit) -> Self {
        let mut offsets = Vec::with_capacity(hit.text.len() + 1);
        let mut utf16 = 0u32;
        for (byte, ch) in hit.text.char_indices() {
            offsets.push((utf16, byte));
            utf16 += ch.len_utf16() as u32;
        }
        offsets.push((utf16, hit.text.len()));
        let byte_at = |unit: u32| {
            offsets
                .iter()
                .find(|(at, _)| *at >= unit)
                .map_or(hit.text.len(), |(_, byte)| *byte)
        };
        let highlights = hit
            .highlights
            .iter()
            .map(|[from, to]| byte_at(*from)..byte_at(*to))
            .filter(|range| range.start < range.end)
            .collect();
        LineHit {
            path: hit.path,
            line: hit.line,
            text: hit.text,
            highlights,
        }
    }
}

/// The query as tokens a paper's metadata must all hold: arXiv URLs and
/// versioned ids reduce to the versionless id imports store, a DOI URL to
/// the DOI.
fn query_tokens(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split_whitespace()
        .map(|token| {
            if let Some(id) = TOKEN_ARXIV.captures(token).and_then(|found| found.get(1)) {
                return base_arxiv_id(id.as_str()).to_string();
            }
            let token = token
                .strip_prefix("https://doi.org/")
                .or_else(|| token.strip_prefix("http://doi.org/"))
                .or_else(|| token.strip_prefix("https://dx.doi.org/"))
                .or_else(|| token.strip_prefix("http://dx.doi.org/"))
                .unwrap_or(token);
            token
                .strip_prefix("doi:")
                .map(str::trim_start)
                .unwrap_or(token)
                .to_string()
        })
        .collect()
}

fn metadata_matches(paper: &PaperSummary, tokens: &[String]) -> bool {
    if tokens.is_empty() {
        return true;
    }
    // Author braces only group names ("{V}aswani"); a query never types them.
    let haystack = [
        Some(paper.title.as_str()),
        Some(&paper.authors.replace(['{', '}'], "")[..]),
        paper.citation_key.as_deref(),
        Some(paper.arxiv_id.as_str()),
        paper.doi.as_deref(),
        paper.url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();
    tokens.iter().all(|token| haystack.contains(token.as_str()))
}

/// A paper added from this window, which a search for what was typed keeps
/// first.
#[derive(Clone, Debug)]
pub struct RecentImport {
    pub query: String,
    pub citation_key: Option<String>,
    pub arxiv_id: String,
}

/// The library as a query ranks it: the just-added paper first, then the
/// title matches (exact, then prefix, then anywhere), the other metadata
/// matches, and the papers only their text matched; within each, the
/// index's relevance order, then library order. A sort the writer chose
/// replaces that ranking; the import still leads.
pub fn rank<'a>(
    papers: &'a [PaperSummary],
    input: &str,
    text: &HashMap<String, TextMatch>,
    recent: Option<&RecentImport>,
    sort: Sort,
    facts: &Facts,
) -> Vec<&'a PaperSummary> {
    let query = input.trim();
    let lowered = query.to_lowercase();
    let tokens = query_tokens(input);
    let is_recent = |paper: &PaperSummary| {
        recent.is_some_and(|recent| {
            recent.query == query
                && match &recent.citation_key {
                    Some(key) => paper.citation_key.as_deref() == Some(key.as_str()),
                    None => {
                        !recent.arxiv_id.is_empty()
                            && base_arxiv_id(&recent.arxiv_id) == base_arxiv_id(&paper.arxiv_id)
                    }
                }
        })
    };
    let text_rank = |paper: &PaperSummary| {
        text.get(&search_identity(paper))
            .map_or(usize::MAX, |hit| hit.rank)
    };
    let mut kept: Vec<(usize, &PaperSummary, bool, u8, bool)> = papers
        .iter()
        .enumerate()
        .filter_map(|(index, paper)| {
            let metadata = metadata_matches(paper, &tokens);
            let recent = is_recent(paper);
            let in_text = text.contains_key(&search_identity(paper));
            if !(metadata || in_text || recent) {
                return None;
            }
            let title = paper.title.trim().to_lowercase();
            // Relevance, doubled so the text-only tier sits between 0 and 1.
            let relevance = if title == lowered {
                8
            } else if title.starts_with(&lowered) {
                6
            } else if title.contains(&lowered) {
                4
            } else if metadata {
                2
            } else if in_text {
                1
            } else {
                0
            };
            Some((index, paper, recent, relevance, metadata))
        })
        .collect();
    kept.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then_with(|| {
                if sort == Sort::Title {
                    b.3.cmp(&a.3)
                        .then_with(|| text_rank(a.1).cmp(&text_rank(b.1)))
                } else {
                    compare(sort, facts, a.1, b.1)
                }
            })
            .then_with(|| a.0.cmp(&b.0))
    });
    kept.into_iter().map(|(_, paper, ..)| paper).collect()
}

/// A section of the shown papers: its heading, and its papers in the order
/// they were given.
pub struct Section<'a> {
    pub name: String,
    pub papers: Vec<&'a PaperSummary>,
}

/// The shown papers in sections: years newest first, venues A to Z, reading
/// states from readable to cited only, and the papers that record no year or
/// venue last.
pub fn group<'a>(papers: Vec<&'a PaperSummary>, group: Group, facts: &Facts) -> Vec<Section<'a>> {
    if group == Group::None {
        return vec![Section {
            name: String::new(),
            papers,
        }];
    }
    let value_of = |paper: &PaperSummary| -> String {
        match group {
            Group::Year => paper.year.as_deref().unwrap_or("").trim().to_string(),
            Group::Venue => facts.venue(paper).to_string(),
            Group::State => format!("{:?}", reading_state(paper)),
            Group::None => String::new(),
        }
    };
    let mut order: Vec<String> = Vec::new();
    let mut members: HashMap<String, Vec<&PaperSummary>> = HashMap::new();
    for paper in papers {
        let value = value_of(paper);
        if !members.contains_key(&value) {
            order.push(value.clone());
        }
        members.entry(value).or_default().push(paper);
    }
    let state_rank = |value: &str| {
        ReadingState::ORDER
            .iter()
            .position(|state| format!("{state:?}") == value)
            .unwrap_or(0)
    };
    order.sort_by(|a, b| {
        a.is_empty().cmp(&b.is_empty()).then_with(|| match group {
            Group::State => state_rank(a).cmp(&state_rank(b)),
            Group::Year => numeric_compare(b, a),
            _ => text_compare(a, b),
        })
    });
    order
        .into_iter()
        .map(|value| {
            let name = match group {
                Group::State => ReadingState::ORDER
                    .iter()
                    .find(|state| format!("{state:?}") == value)
                    .map_or("", |state| state.group_name())
                    .to_string(),
                _ if value.is_empty() => {
                    if group == Group::Year {
                        "No year".into()
                    } else {
                        "No venue".into()
                    }
                }
                _ => value.clone(),
            };
            let papers = members.remove(&value).unwrap_or_default();
            Section { name, papers }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::model::test_support::{paper, with};

    #[test]
    fn a_query_ranks_titles_before_other_matches() {
        let papers = vec![
            with(paper("Deep residual learning"), |p| {
                p.authors = "He, Kaiming".into()
            }),
            with(paper("Attention"), |p| p.authors = "Vaswani".into()),
            with(paper("Attention is all you need"), |p| {
                p.authors = "Vaswani".into()
            }),
            with(paper("Notes on transformers"), |p| {
                p.arxiv_id = "9999.00001".into()
            }),
        ];
        let mut text = HashMap::new();
        text.insert(
            "9999.00001".to_string(),
            TextMatch {
                rank: 0,
                hits: vec![],
            },
        );
        let facts = Facts::default();
        let ranked: Vec<&str> = rank(&papers, "attention", &text, None, Sort::Title, &facts)
            .into_iter()
            .map(|p| p.title.as_str())
            .collect();
        assert_eq!(
            ranked,
            [
                "Attention",
                "Attention is all you need",
                "Notes on transformers"
            ]
        );
        let all = rank(&papers, "", &HashMap::new(), None, Sort::Title, &facts);
        assert_eq!(all.len(), 4);
    }

    #[test]
    fn a_just_added_paper_leads_its_search() {
        let papers = vec![
            with(paper("Alpha"), |p| p.citation_key = Some("a".into())),
            with(paper("Beta"), |p| p.citation_key = Some("b".into())),
        ];
        let recent = RecentImport {
            query: "beta".into(),
            citation_key: Some("b".into()),
            arxiv_id: String::new(),
        };
        let ranked = rank(
            &papers,
            "beta",
            &HashMap::new(),
            Some(&recent),
            Sort::Title,
            &Facts::default(),
        );
        assert_eq!(ranked[0].title, "Beta");
    }

    #[test]
    fn sorts_put_missing_values_last() {
        let papers = vec![
            with(paper("a"), |p| p.year = Some("2019".into())),
            paper("b"),
            with(paper("c"), |p| p.year = Some("2021".into())),
        ];
        let facts = Facts::default();
        let mut order: Vec<&PaperSummary> = papers.iter().collect();
        order.sort_by(|a, b| compare(Sort::Year, &facts, a, b));
        assert_eq!(
            order.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
    }

    #[test]
    fn groups_order_their_sections() {
        let papers = vec![
            with(paper("a"), |p| p.year = Some("2019".into())),
            paper("b"),
            with(paper("c"), |p| p.year = Some("2021".into())),
            with(paper("d"), |p| p.year = Some("2019".into())),
        ];
        let sections = group(papers.iter().collect(), Group::Year, &Facts::default());
        let names: Vec<&str> = sections.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["2021", "2019", "No year"]);
        assert_eq!(sections[1].papers.len(), 2);
        let states = group(
            vec![&papers[0], &with(paper("e"), |p| p.has_full_text = true)]
                .into_iter()
                .collect(),
            Group::State,
            &Facts::default(),
        );
        assert_eq!(states[0].name, "Full text");
    }

    #[test]
    fn cited_filters_wait_for_the_scan() {
        let cited = with(paper("a"), |p| p.citation_key = Some("Vaswani17".into()));
        let mut facts = Facts::default();
        assert!(!Filter::Uncited.keeps(&cited, &facts));
        facts.uses = Some(Facts::group_uses(vec![SymbolOccurrence {
            kind: "citation".into(),
            symbol: "vaswani17".into(),
            role: "reference".into(),
            path: "main.tex".into(),
            line: 3,
            snippet: String::new(),
        }]));
        assert!(Filter::Cited.keeps(&cited, &facts));
        assert_eq!(facts.uses(&cited), Some(1));
        assert_eq!(facts.uses(&paper("b")), Some(0));
    }

    #[test]
    fn utf16_highlights_become_byte_ranges() {
        let hit = LineHit::from_core(lattice_core::papers::LineHit {
            path: "p.md".into(),
            line: 1,
            text: "é attention".into(),
            highlights: vec![[2, 11]],
        });
        assert_eq!(&hit.text[hit.highlights[0].clone()], "attention");
    }
}
