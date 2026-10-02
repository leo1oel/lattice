//! arXiv's own citation records, and the checks that a resolved record is the
//! work that was asked for. Only an explicit identifier (arXiv id, DOI) or a
//! title confirmed at its source may join two records; nothing here guesses
//! that two works are the same.

use super::ids::{arxiv_base_id, explicit_arxiv_id, parse_arxiv_id, same_arxiv_work};
use super::web_citation::{fetch_web_html, supplied_citation_key};
use super::{http_client, is_web_url, send_checked};
use crate::citation_audit::{entry_fields, single_entry_key};
use crate::models::CitationInfo;
use crate::project;
use crate::web_metadata::{bib_text, meta_values};
use regex::Regex;
use scraper::Html;

const ARXIV_TITLE_SEARCH_URL: &str = "https://export.arxiv.org/api/query";

/// An explicit preprint uses arXiv's own citation metadata. Publication
/// promotion is a separate reviewed operation: a title search result must
/// never donate its authors/DOI to an unrelated but correctly numbered paper.
pub(crate) fn official_arxiv_citation(query: &str) -> Result<Option<String>, String> {
    let Some(id) = explicit_arxiv_id(query) else {
        return Ok(None);
    };
    let html = fetch_web_html(&format!("https://arxiv.org/abs/{id}"))?;
    arxiv_citation_from_html(&id, &html).map(Some)
}

fn arxiv_citation_from_html(id: &str, html: &str) -> Result<String, String> {
    let fields = meta_values(&Html::parse_document(html), &["name"]);
    let one = |name: &str| -> Result<&str, String> {
        fields
            .get(name)
            .filter(|values| values.len() == 1)
            .map(|values| values[0].as_str())
            .ok_or_else(|| {
                format!("arXiv returned missing or ambiguous {name}; no citation was added.")
            })
    };
    if !same_arxiv_work(one("citation_arxiv_id")?, id) {
        return Err("arXiv returned metadata for a different paper.".into());
    }
    let title = one("citation_title")?;
    let year = one("citation_date")?
        .get(..4)
        .filter(|year| year.chars().all(|c| c.is_ascii_digit()))
        .ok_or("arXiv returned an invalid publication date.")?;
    let authors = fields
        .get("citation_author")
        .filter(|authors| !authors.is_empty())
        .ok_or("arXiv returned no authors.")?;
    let base = arxiv_base_id(id);
    let raw = format!(
        "@misc{{arxiv,\n  title = {{{}}},\n  author = {{{}}},\n  year = {{{year}}},\n  url = {{https://arxiv.org/abs/{id}}},\n  eprint = {{{base}}},\n  archiveprefix = {{arXiv}},\n  howpublished = {{arXiv preprint arXiv:{base}}}\n}}\n",
        bib_text(title),
        authors.iter().map(|author| bib_text(author)).collect::<Vec<_>>().join(" and "),
    );
    let key = supplied_citation_key(&raw);
    Ok(raw.replacen("@misc{arxiv,", &format!("@misc{{{key},"), 1))
}

/// The arXiv id whose title is exactly `title`, from arXiv's search API.
pub(super) fn resolve_arxiv_title(title: &str) -> Result<Option<String>, String> {
    let search = format!("ti:\"{}\"", title.trim());
    let url = format!(
        "{ARXIV_TITLE_SEARCH_URL}?search_query={}&start=0&max_results=5",
        crate::openalex::urlencoding(&search)
    );
    let client =
        http_client(20).map_err(|error| format!("Could not create arXiv client: {error}"))?;
    let response = send_checked(client.get(url), "arXiv title lookup failed", |status| {
        format!("arXiv title lookup returned HTTP {status}.")
    })?;
    let feed = response
        .text()
        .map_err(|error| format!("Could not read the arXiv title lookup: {error}"))?;
    Ok(arxiv_id_from_title_feed(&feed, title))
}

/// Read only the two Atom fields needed here. Keeping this parser narrow avoids
/// shipping an XML stack for one response while still checking the returned
/// title instead of trusting the search ranking.
fn arxiv_id_from_title_feed(feed: &str, requested_title: &str) -> Option<String> {
    let entries = Regex::new(r"(?s)<entry>(.*?)</entry>").unwrap();
    let title = Regex::new(r"(?s)<title>(.*?)</title>").unwrap();
    let id = Regex::new(r"(?s)<id>(.*?)</id>").unwrap();
    let matched = entries.captures_iter(feed).find_map(|entry| {
        let body = entry.get(1)?.as_str();
        let candidate_title =
            crate::util::decode_html_entities(title.captures(body)?.get(1)?.as_str());
        if !paper_titles_match(requested_title, &candidate_title) {
            return None;
        }
        let candidate_id = parse_arxiv_id(id.captures(body)?.get(1)?.as_str())?;
        Some(arxiv_base_id(&candidate_id).to_string())
    });
    matched
}

/// `base`, or the first `base-N` (N ≥ 2) no entry already uses, compared
/// case-insensitively.
pub(super) fn unused_key(entries: &[CitationInfo], base: &str) -> String {
    let taken = |key: &str| entries.iter().any(|entry| entry.key.eq_ignore_ascii_case(key));
    std::iter::once(base.to_string())
        .chain((2..).map(|suffix| format!("{base}-{suffix}")))
        .find(|key| !taken(key))
        .unwrap()
}

pub(super) fn normalized_paper_title(value: &str) -> String {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn paper_titles_match(requested: &str, candidate: &str) -> bool {
    let requested = normalized_paper_title(requested);
    !requested.is_empty() && normalized_paper_title(candidate) == requested
}

/// A resolved record must be exactly one complete entry whose identifiers
/// agree with each other and with what `query` named explicitly.
pub(crate) fn validate_resolved_identity(query: &str, raw: &str) -> Result<(), String> {
    let entries = project::parse_bibliography(raw);
    let raw = raw.trim();
    if entries.len() != 1 || single_entry_key(raw).is_none() {
        return Err("Citation resolution must return exactly one complete record.".into());
    }
    let entry = &entries[0];
    let ids: Vec<_> = entry_fields(raw)
        .into_iter()
        .filter_map(|field| project::bibliography_arxiv_id(&[field].into_iter().collect()))
        .collect();
    if ids.iter().any(|id| !same_arxiv_work(id, &ids[0])) {
        return Err("The citation contains conflicting arXiv identifiers.".into());
    }
    let doi_url = entry.url.as_deref().and_then(project::normalize_doi);
    if entry.doi.as_ref().zip(doi_url.as_ref()).is_some_and(|(a, b)| a != b) {
        return Err("The citation DOI conflicts with its DOI URL.".into());
    }
    if let Some(requested) = explicit_arxiv_id(query) {
        if !entry.arxiv_id.as_deref().is_some_and(|id| same_arxiv_work(id, &requested)) {
            return Err(format!("Citation resolution returned a different paper than arXiv:{requested}. No citation was added."));
        }
    } else if let Some(doi) = project::normalize_doi(query) {
        if entry.doi.as_ref().or(doi_url.as_ref()) != Some(&doi) {
            return Err(format!("Citation resolution did not return the requested DOI {doi}."));
        }
    }
    Ok(())
}

/// A title result is only a candidate. Confirm its metadata independently by
/// the returned identifier instead of trusting publication enrichment.
pub(crate) fn verify_title_citation(query: &str, raw: &str) -> Result<(), String> {
    if explicit_arxiv_id(query).is_some()
        || project::normalize_doi(query).is_some()
        || is_web_url(query)
    {
        return Ok(());
    }
    let entry =
        project::parse_bibliography(raw).into_iter().next().ok_or("No citation was returned.")?;
    if normalized_paper_title(query) != normalized_paper_title(&entry.title) {
        return Err("The resolved title differs from the requested title. Supply its DOI or arXiv URL instead.".into());
    }
    let verified = if let Some(id) = entry.arxiv_id {
        official_arxiv_citation(&id)?.ok_or("Invalid arXiv identity.")?
    } else if let Some(doi) = entry.doi {
        project::resolve_citation_query(&doi)?.bibtex
    } else {
        return Err("This title has no independently verifiable identifier. Supply its official BibTeX or URL instead.".into());
    };
    if !crate::citation_audit::metadata_identity_matches(raw.trim(), verified.trim()) {
        return Err("The candidate's title or authors conflict with its source metadata. No citation was added.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_arxiv_metadata_cannot_mix_papers_or_use_the_revision_year() {
        let html = concat!(
            "<meta name='citation_arxiv_id' content='2510.14979'>",
            "<meta name='citation_title' content='Pixels &amp; Words'>",
            "<meta name='citation_author' content='Diao, Haiwen'>",
            "<meta name='citation_author' content='Li, Mingxuan'>",
            "<meta name='citation_date' content='2025/10/16'>",
            "<meta name='citation_online_date' content='2026/02/21'>",
        );
        let raw = arxiv_citation_from_html("2510.14979", html).unwrap();
        let entry = project::parse_bibliography(&raw).remove(0);
        assert_eq!(entry.year, "2025");
        assert_eq!(entry.authors, "Diao, Haiwen and Li, Mingxuan");
        assert!(raw.contains(r"Pixels \& Words"));
        assert_eq!(entry.arxiv_id.as_deref(), Some("2510.14979"));
        assert!(arxiv_citation_from_html("2605.28820", html).is_err());
        for broken in [
            html.replace("citation_author", "ignored"),
            format!("{html}<meta name='citation_arxiv_id' content='2605.28820'>"),
        ] {
            assert!(arxiv_citation_from_html("2510.14979", &broken).is_err());
        }
    }

    #[test]
    fn resolves_a_publication_title_to_its_arxiv_record() {
        let feed = concat!(
            "<feed>",
            "<entry><id>http://arxiv.org/abs/2501.00001v1</id>",
            "<title>A Different Paper</title></entry>",
            "<entry><id>http://arxiv.org/abs/2407.06438v3</id>",
            "<title>SOLO: A Single Transformer for Scalable Vision-Language Modeling</title>",
            "</entry></feed>",
        );
        for (title, expected) in [
            (
                "SOLO: A Single Transformer for Scalable Vision-Language Modeling",
                Some("2407.06438"),
            ),
            ("A Different Transformer", None),
            ("A Single Transformer for Scalable Vision-Language Modeling", None),
        ] {
            assert_eq!(arxiv_id_from_title_feed(feed, title).as_deref(), expected, "{title}");
        }
    }

    #[test]
    fn resolved_identity_rejects_conflicting_or_foreign_identifiers() {
        let a = "@misc{old,title={Shared Title},author={Alice Smith},year={2025},eprint={2510.14979},doi={10.1234/a}}";
        let broken = a.replace(
            "eprint={2510.14979}",
            "eprint={2510.14979},url={https://arxiv.org/abs/2605.28820}",
        );
        for (query, raw, valid) in [
            ("2510.14979", broken.as_str(), false),
            ("2605.28820", a, false),
            ("https://doi.org/10.1234/ab", a, false),
            ("https://doi.org/10.1234/A", a, true),
            ("https://arxiv.org/pdf/2510.14979v2", a, true),
            ("2510.14979", "@misc{x,title={No identity}}", false),
            ("", "@misc{x,title={Incomplete}", false),
        ] {
            assert_eq!(validate_resolved_identity(query, raw).is_ok(), valid, "{query}: {raw}");
        }
    }
}
