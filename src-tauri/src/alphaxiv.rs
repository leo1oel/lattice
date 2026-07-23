// alphaXiv gives two things this app leans on: a full-text search over the
// arXiv corpus (body-wording matches that a title/abstract index misses) and a
// per-paper "overview" — a readable analysis of the paper we store next to the
// full text as the default reading view. Both are plain HTTPS GETs; we mirror
// the inline reqwest::blocking pattern in openalex.rs rather than share a
// client, since these are the only two callers.

use crate::openalex::urlencoding;
use serde::Deserialize;

const SEARCH_URL: &str = "https://api.alphaxiv.org/search/v2/paper/full-text";
/// alphaXiv's full-text endpoint has no pagination and caps `limit` at 50, so we
/// pull its whole pool once and reveal it incrementally on the client.
const SEARCH_LIMIT: usize = 50;
const OVERVIEW_BASE: &str = "https://www.alphaxiv.org/overview";
const USER_AGENT: &str = "Lattice/0.1 (research writing; mailto:lattice@local)";
/// An overview shorter than this is alphaXiv's "not found" stub, not a report.
const MIN_OVERVIEW_LEN: usize = 200;

/// A full-text search hit, normalized from the alphaXiv JSON.
#[derive(Debug, Clone)]
pub struct AlphaxivWork {
    pub paper_id: String,
    pub title: String,
    pub year: Option<u32>,
    pub votes: Option<u32>,
    pub snippet: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchHit {
    #[serde(rename = "paperId")]
    paper_id: Option<String>,
    title: Option<String>,
    #[serde(rename = "publicationDate")]
    publication_date: Option<String>,
    votes: Option<i64>,
    snippets: Option<Vec<Snippet>>,
}

#[derive(Debug, Deserialize)]
struct Snippet {
    snippet: Option<String>,
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not create alphaXiv client: {error}"))
}

/// Full-text search over arXiv via alphaXiv. Ranked as alphaXiv returns them.
pub fn search_works(query: &str) -> Result<Vec<AlphaxivWork>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!(
        "{SEARCH_URL}?q={}&limit={SEARCH_LIMIT}",
        urlencoding(trimmed)
    );
    let response = http_client()?
        .get(&url)
        .send()
        .map_err(|error| format!("alphaXiv request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("alphaXiv returned HTTP {}.", response.status().as_u16()));
    }
    let hits: Vec<SearchHit> = response
        .json()
        .map_err(|error| format!("Could not parse alphaXiv response: {error}"))?;
    Ok(hits.into_iter().filter_map(map_hit).collect())
}

/// Fetch the alphaXiv overview markdown for a paper. `Ok(None)` when alphaXiv
/// has no report for the id (404, or a too-short stub body).
pub fn fetch_overview(arxiv_id: &str) -> Result<Option<String>, String> {
    let url = format!("{OVERVIEW_BASE}/{arxiv_id}.md");
    let response = http_client()?
        .get(&url)
        .send()
        .map_err(|error| format!("alphaXiv overview request failed: {error}"))?;
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "alphaXiv overview returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let body = response
        .text()
        .map_err(|error| format!("Could not read alphaXiv overview: {error}"))?;
    if body.trim().len() < MIN_OVERVIEW_LEN {
        return Ok(None);
    }
    Ok(Some(body))
}

fn map_hit(hit: SearchHit) -> Option<AlphaxivWork> {
    let paper_id = hit.paper_id?.trim().to_string();
    let title = hit.title?.trim().to_string();
    if paper_id.is_empty() || title.is_empty() {
        return None;
    }
    let year = hit
        .publication_date
        .as_deref()
        .and_then(|date| date.get(0..4))
        .and_then(|year| year.parse::<u32>().ok());
    let votes = hit.votes.and_then(|value| u32::try_from(value).ok());
    let snippet = hit
        .snippets
        .and_then(|snippets| snippets.into_iter().find_map(|item| item.snippet))
        .map(|text| collapse_whitespace(&text))
        .filter(|text| !text.is_empty())
        .map(|text| truncate(&text, 240));
    Some(AlphaxivWork {
        paper_id,
        title,
        year,
        votes,
        snippet,
    })
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max_chars).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_a_search_hit() {
        let hit = SearchHit {
            paper_id: Some("2401.12345".into()),
            title: Some("  A Great Paper  ".into()),
            publication_date: Some("2024-06-26T06:08:44.000Z".into()),
            votes: Some(7),
            snippets: Some(vec![
                Snippet { snippet: None },
                Snippet {
                    snippet: Some("some\n  matching   text".into()),
                },
            ]),
        };
        let work = map_hit(hit).unwrap();
        assert_eq!(work.paper_id, "2401.12345");
        assert_eq!(work.title, "A Great Paper");
        assert_eq!(work.year, Some(2024));
        assert_eq!(work.votes, Some(7));
        assert_eq!(work.snippet.as_deref(), Some("some matching text"));
    }

    #[test]
    fn drops_a_hit_without_an_id_or_title() {
        let hit = SearchHit {
            paper_id: Some("2401.12345".into()),
            title: Some("   ".into()),
            publication_date: None,
            votes: None,
            snippets: None,
        };
        assert!(map_hit(hit).is_none());
    }
}
