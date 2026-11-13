//! Who and what a paper is, as the list names it: its key, reading state,
//! short authors, source and links (`app-utils.ts` `paperKey`,
//! `paper-library-view.ts`, `paper-identity.ts`, `paper-source.ts`), and its
//! citation-health notice (`citation-health.ts`). Only what the bibliography
//! or bundle records is shown: a missing field yields nothing, never a guess.

use lattice_i18n::t;
use std::sync::LazyLock;

use lattice_core::{citation_health::CitationHealth, papers::PaperSummary};
use regex::Regex;

/// The library's own key for a paper: its arXiv id (or bundle key), else
/// its citation key, else its title.
pub fn paper_key(paper: &PaperSummary) -> String {
    if !paper.arxiv_id.is_empty() {
        return paper.arxiv_id.clone();
    }
    format!(
        "cite:{}",
        paper.citation_key.as_deref().unwrap_or(&paper.title)
    )
}

/// How the full-text index keys a paper (`paperSearchIdentity`).
pub fn search_identity(paper: &PaperSummary) -> String {
    if !paper.arxiv_id.is_empty() {
        return paper.arxiv_id.clone();
    }
    format!("title:{}", paper.title.trim().to_lowercase())
}

/// What a click on the row can open.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ReadingState {
    /// Its text (or overview) is in Papers.
    FullText,
    /// Its text downloads on click.
    Downloadable,
    /// A citation with nothing to open.
    Citation,
}

impl ReadingState {
    pub(super) const ORDER: [ReadingState; 3] = [
        ReadingState::FullText,
        ReadingState::Downloadable,
        ReadingState::Citation,
    ];

    pub fn group_name(self) -> &'static str {
        match self {
            ReadingState::FullText => t!("Full text"),
            ReadingState::Downloadable => t!("Not downloaded"),
            ReadingState::Citation => t!("Citation only"),
        }
    }
}

pub fn readable(paper: &PaperSummary) -> bool {
    paper.has_full_text || paper.has_blog
}

pub fn reading_state(paper: &PaperSummary) -> ReadingState {
    if readable(paper) {
        ReadingState::FullText
    } else if can_download(paper) {
        ReadingState::Downloadable
    } else {
        ReadingState::Citation
    }
}

/// Whether a click on the row opens or fetches something.
pub fn can_activate(paper: &PaperSummary) -> bool {
    readable(paper) || !paper.arxiv_id.is_empty() || paper.url.is_some()
}

pub(super) static ARXIV_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(?:v\d+)?$").unwrap()
});
pub(super) static EXPLICIT_ARXIV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:arxiv:\s*|https?://(?:www\.|export\.)?arxiv\.org/(?:abs|pdf|html)/)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?)(?:\.pdf)?(?:[?#].*)?$",
    )
    .unwrap()
});
pub(super) static DOI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/\S+)$").unwrap()
});
pub(super) static BARE_DOI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^10\.\d{4,9}/\S+$").unwrap());
pub(super) static BIBTEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@\w+\s*\{").unwrap());
pub(super) static WEB_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^https?://\S+$").unwrap());
pub(super) static TOKEN_ARXIV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?)\b").unwrap()
});

/// An arXiv id without its version.
pub fn base_arxiv_id(id: &str) -> &str {
    let id = id.trim();
    match id.rfind('v') {
        Some(at)
            if at > 0
                && at + 1 < id.len()
                && id[at + 1..].bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            &id[..at]
        }
        _ => id,
    }
}

/// An arXiv id typed or pasted on its own (or as an arXiv URL), lower-case
/// and without its version; never a title that happens to hold digits.
pub fn explicit_arxiv_id(input: &str) -> Option<String> {
    let found = EXPLICIT_ARXIV.captures(input.trim())?.get(1)?.as_str();
    Some(base_arxiv_id(&found.to_lowercase()).to_string())
}

/// A web address's parts, for what Papers shows or opens: only http(s),
/// never one carrying credentials.
struct WebUrl<'a> {
    href: &'a str,
    host: &'a str,
    path: &'a str,
}

fn web_url(value: Option<&str>) -> Option<WebUrl<'_>> {
    let href = value?.trim();
    let rest = href
        .strip_prefix("https://")
        .or_else(|| href.strip_prefix("http://"))
        .or_else(|| {
            let lower = href.get(..8)?.to_ascii_lowercase();
            (lower == "https://")
                .then(|| &href[8..])
                .or_else(|| (lower.starts_with("http://")).then(|| &href[7..]))
        })?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains('@') || href.contains(char::is_whitespace) {
        return None;
    }
    let host = authority.split(':').next().unwrap_or(authority);
    let after = &rest[end..];
    let path_end = after.find(['?', '#']).unwrap_or(after.len());
    Some(WebUrl {
        href,
        host,
        path: &after[..path_end],
    })
}

/// The DOI's resolver page, each part of the DOI escaped as
/// `encodeURIComponent` does (`doiUrl`): a `#` or `<` in a DOI is part of it,
/// not of the address.
fn doi_url(doi: Option<&str>) -> Option<String> {
    let doi = doi?.trim();
    BARE_DOI.is_match(doi).then(|| {
        let path: Vec<String> = doi.split('/').map(encode_component).collect();
        format!("https://doi.org/{}", path.join("/"))
    })
}

fn encode_component(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for byte in part.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Where a paper lives on the web, to read it there: its DOI's resolver,
/// else its arXiv abstract page, else the page it was cited from.
pub fn link_url(paper: &PaperSummary) -> Option<String> {
    if let Some(doi) = doi_url(paper.doi.as_deref()) {
        return Some(doi);
    }
    let id = paper.arxiv_id.trim();
    if ARXIV_ID.is_match(id) {
        return Some(format!("https://arxiv.org/abs/{id}"));
    }
    web_url(paper.url.as_deref()).map(|url| url.href.to_string())
}

/// The paper's own PDF on the web (`paperPdfUrl`): arXiv's, alphaXiv's, or
/// a cited `.pdf`.
pub fn pdf_url(paper: &PaperSummary) -> Option<String> {
    if ARXIV_ID.is_match(&paper.arxiv_id) {
        return Some(format!("https://arxiv.org/pdf/{}", paper.arxiv_id));
    }
    let url = web_url(paper.url.as_deref())?;
    if url
        .host
        .trim_start_matches("www.")
        .eq_ignore_ascii_case("alphaxiv.org")
    {
        let id = ["/abs/", "/pdf/", "/overview/"]
            .iter()
            .find_map(|prefix| url.path.strip_prefix(prefix))?
            .trim_end_matches('/');
        let id = id
            .strip_suffix(".pdf")
            .or_else(|| id.strip_suffix(".md"))
            .unwrap_or(id);
        return (!id.is_empty()).then(|| format!("https://www.alphaxiv.org/abs/{id}.pdf"));
    }
    url.path
        .to_ascii_lowercase()
        .ends_with(".pdf")
        .then(|| url.href.to_string())
}

/// Papers has no PDF of the paper at all, neither one its bundle keeps nor
/// one on the web, so a Zotero attachment would give it one (`keepsNoPdf`).
pub fn keeps_no_pdf(paper: &PaperSummary) -> bool {
    !paper.has_local_pdf && pdf_url(paper).is_none()
}

/// DOI metadata identifies a work, not a downloadable full-text page.
pub fn can_download(paper: &PaperSummary) -> bool {
    if !paper.arxiv_id.is_empty() {
        return true;
    }
    let Some(url) = web_url(paper.url.as_deref()) else {
        return false;
    };
    let host = url.host.to_ascii_lowercase();
    if host == "doi.org" || host == "dx.doi.org" {
        return false;
    }
    url.path.to_ascii_lowercase().ends_with(".pdf") || paper.doi.is_none()
}

/// A page cited by its address: no arXiv preprint, no DOI, not a PDF.
pub fn is_web_page(paper: &PaperSummary) -> bool {
    let Some(url) = paper.url.as_deref().filter(|url| !url.is_empty()) else {
        return false;
    };
    if paper.doi.as_deref().is_some_and(|doi| !doi.is_empty()) || ARXIV_ID.is_match(&paper.arxiv_id)
    {
        return false;
    }
    !url.to_ascii_lowercase()
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .ends_with(".pdf")
}

/// Where the reading came from: the arXiv id, else the DOI, else the cited
/// page's site.
pub fn source_label(paper: &PaperSummary) -> Option<String> {
    let id = paper.arxiv_id.trim();
    if !id.is_empty() && ARXIV_ID.is_match(id) {
        return Some(format!("arXiv {id}"));
    }
    if let Some(doi) = paper.doi.as_deref().filter(|doi| !doi.is_empty()) {
        return Some(format!("DOI {doi}"));
    }
    let url = web_url(paper.url.as_deref())?;
    let host = url
        .host
        .strip_prefix("www.")
        .or_else(|| url.host.strip_prefix("WWW."))
        .unwrap_or(url.host);
    (!host.is_empty()).then(|| host.to_string())
}

// Authors, read by lattice-core as the .bib editor reads them.

/// "Vaswani", "Vaswani and Shazeer" or "Vaswani et al."; `None` without
/// authors.
pub fn short_authors(paper: &PaperSummary) -> Option<String> {
    lattice_core::bib_document::short_authors(&paper.authors)
}

/// Every author's name in reading order.
pub fn author_names(paper: &PaperSummary) -> Vec<String> {
    lattice_core::bib_document::author_names(&paper.authors)
}

// Citation health.

/// The row's visible warning in two parts (what happened, then who reported
/// it and when), or `None` when Crossref reports nothing to warn about.
pub fn health_parts(health: Option<&CitationHealth>) -> Option<(String, String)> {
    let health = health?;
    let kind = match health.kind.as_str() {
        "retracted" => t!("Retracted"),
        "expressionOfConcern" => t!("Expression of concern"),
        "corrected" => t!("Correction/update"),
        "replaced" => t!("Replacement/new version"),
        _ => return None,
    };
    let source = health.source.as_deref().map(|source| match source {
        "retraction-watch" => "Retraction Watch".to_string(),
        "publisher" => t!("Publisher").to_string(),
        other => other.to_string(),
    });
    let detail = [
        source,
        health.date.clone(),
        health.stale.then(|| "cached".into()),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(", ");
    Some((kind.to_string(), detail))
}

pub fn is_flagged(paper: &PaperSummary) -> bool {
    health_parts(paper.citation_health.as_ref()).is_some()
}

/// The full explanation, the tooltip of the notice.
pub fn health_title(health: Option<&CitationHealth>) -> Option<String> {
    let health = health?;
    let update_type = health
        .update_type
        .as_deref()
        .map(|kind| kind.replace('_', " "));
    if let Some((kind, detail)) = health_parts(Some(health)) {
        let warning = if detail.is_empty() {
            kind
        } else {
            t!("{kind}: {detail}", kind = kind, detail = detail)
        };
        return Some(match update_type {
            Some(update) => t!(
                "{warning}. Crossref type: {updateType}",
                warning = warning,
                updateType = update
            ),
            None => warning,
        });
    }
    if health.kind == "unavailable" {
        return Some(t!("Crossref citation-health metadata is currently unavailable").into());
    }
    if let Some(update) = update_type {
        return Some(t!(
            "Crossref reports update type: {updateType}",
            updateType = update
        ));
    }
    let checked = health.checked_at.get(..10).unwrap_or(&health.checked_at);
    Some(t!(
        "No Crossref update metadata found (checked {checkedDate})",
        checkedDate = checked
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::model::test_support::{paper, with};

    #[test]
    fn a_doi_link_escapes_what_a_url_would_read_otherwise() {
        let p = with(paper("x"), |p| p.doi = Some("10.1000/abc#1<2>".into()));
        assert_eq!(
            link_url(&p).as_deref(),
            Some("https://doi.org/10.1000/abc%231%3C2%3E")
        );
    }

    #[test]
    fn an_alphaxiv_page_or_an_empty_doi_still_reads_as_a_web_page() {
        let overview = with(paper("x"), |p| {
            p.url = Some("https://www.alphaxiv.org/overview/2401.00001".into());
            p.doi = Some(String::new());
        });
        assert!(is_web_page(&overview));
        let pdf = with(paper("x"), |p| {
            p.url = Some("https://example.com/a.PDF?x=1".into())
        });
        assert!(!is_web_page(&pdf));
        let preprint = with(paper("x"), |p| {
            p.arxiv_id = "1706.03762".into();
            p.url = Some("https://example.com/".into());
        });
        assert!(!is_web_page(&preprint));
    }

    #[test]
    fn authors_read_as_people() {
        let p = with(paper("x"), |p| {
            p.authors = "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki".into()
        });
        assert_eq!(short_authors(&p).as_deref(), Some("Vaswani et al."));
        assert_eq!(author_names(&p)[0], "Ashish Vaswani");
        let two = with(paper("x"), |p| {
            p.authors = "Ashish Vaswani and Noam Shazeer".into()
        });
        assert_eq!(short_authors(&two).as_deref(), Some("Vaswani and Shazeer"));
        let org = with(paper("x"), |p| {
            p.authors = "{Research and Development Institute}".into()
        });
        assert_eq!(
            short_authors(&org).as_deref(),
            Some("Research and Development Institute")
        );
        let others = with(paper("x"), |p| p.authors = "Doe, Jane and others".into());
        assert_eq!(short_authors(&others).as_deref(), Some("Doe et al."));
        assert_eq!(short_authors(&paper("x")), None);
    }

    #[test]
    fn a_paper_names_where_it_came_from() {
        let arxiv = with(paper("x"), |p| p.arxiv_id = "2010.11929v2".into());
        assert_eq!(source_label(&arxiv).as_deref(), Some("arXiv 2010.11929v2"));
        assert_eq!(
            link_url(&arxiv).as_deref(),
            Some("https://arxiv.org/abs/2010.11929v2")
        );
        let doi = with(paper("x"), |p| p.doi = Some("10.1000/xyz".into()));
        assert_eq!(
            link_url(&doi).as_deref(),
            Some("https://doi.org/10.1000/xyz")
        );
        let page = with(paper("x"), |p| {
            p.url = Some("https://www.example.com/post".into())
        });
        assert_eq!(source_label(&page).as_deref(), Some("example.com"));
        assert!(is_web_page(&page));
        let credentials = with(paper("x"), |p| {
            p.url = Some("https://me:pw@example.com/".into())
        });
        assert_eq!(link_url(&credentials), None);
    }

    #[test]
    fn reading_state_follows_what_a_click_can_do() {
        assert_eq!(
            reading_state(&with(paper("x"), |p| p.has_full_text = true)),
            ReadingState::FullText
        );
        assert_eq!(
            reading_state(&with(paper("x"), |p| p.arxiv_id = "1706.03762".into())),
            ReadingState::Downloadable
        );
        let doi_only = with(paper("x"), |p| {
            p.doi = Some("10.1/x".into());
            p.url = Some("https://doi.org/10.1/x".into());
        });
        assert_eq!(reading_state(&doi_only), ReadingState::Citation);
    }

    #[test]
    fn health_names_what_happened() {
        let health = CitationHealth {
            kind: "retracted".into(),
            update_type: Some("retraction".into()),
            source: Some("retraction-watch".into()),
            date: Some("2024-01-02".into()),
            link: None,
            checked_at: "2024-05-01T00:00:00Z".into(),
            stale: false,
        };
        assert_eq!(
            health_parts(Some(&health)),
            Some(("Retracted".into(), "Retraction Watch, 2024-01-02".into()))
        );
        assert!(
            health_title(Some(&health))
                .unwrap()
                .ends_with("Crossref type: retraction")
        );
    }
}
