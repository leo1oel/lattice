use crate::literature_service;
use crate::models::OpenAlexWork;
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Deserialize)]
struct WorksResponse {
    results: Vec<WorkPayload>,
}

#[derive(Debug, Deserialize)]
struct WorkPayload {
    id: Option<String>,
    title: Option<String>,
    publication_year: Option<u32>,
    cited_by_count: Option<u32>,
    doi: Option<String>,
    ids: Option<WorkIds>,
    authorships: Option<Vec<Authorship>>,
    primary_location: Option<PrimaryLocation>,
}

#[derive(Debug, Deserialize)]
struct WorkIds {
    openalex: Option<String>,
    doi: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Authorship {
    author: Option<Author>,
}

#[derive(Debug, Deserialize)]
struct Author {
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PrimaryLocation {
    landing_page_url: Option<String>,
}

/// OpenAlex results per page; `page` is 1-indexed.
pub const PER_PAGE: u32 = 25;
const SELECT: &str =
    "id,title,publication_year,cited_by_count,ids,doi,authorships,primary_location";
const USER_AGENT: &str = "Lattice/0.1 (research writing)";

pub fn search_works(query: &str, precise: bool, page: u32) -> Result<Vec<OpenAlexWork>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let search = if precise { "filter=title_and_abstract.search:" } else { "search=" };
    let url = format!(
        "https://api.openalex.org/works?{search}{}&per_page={PER_PAGE}&page={}&select={SELECT}",
        urlencoding(query),
        page.max(1)
    );
    let key = crate::literature_credentials::openalex_key()?;
    let client = literature_service::client(Duration::from_secs(20), Some(USER_AGENT))
        .map_err(|_| "Could not create OpenAlex client.".to_string())?;
    let mut request = literature_service::request(&client, &url, None, key.is_none())?;
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let response = request.send().map_err(|_| "OpenAlex request failed.".to_string())?;
    if !response.status().is_success() {
        return Err(format!("OpenAlex returned HTTP {}.", response.status().as_u16()));
    }
    let payload: WorksResponse =
        response.json().map_err(|error| format!("Could not parse OpenAlex response: {error}"))?;
    Ok(payload.results.into_iter().filter_map(map_work).collect())
}

fn map_work(work: WorkPayload) -> Option<OpenAlexWork> {
    let title = work.title?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let doi = work
        .doi
        .or_else(|| work.ids.as_ref().and_then(|ids| ids.doi.clone()))
        .and_then(|value| crate::project::normalize_doi(&value));
    let arxiv_id = doi.as_ref().and_then(|value| arxiv_id_from_doi(value));
    let authors = work
        .authorships
        .unwrap_or_default()
        .into_iter()
        .filter_map(|authorship| authorship.author?.display_name)
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .take(8)
        .collect();
    Some(OpenAlexWork {
        id: work
            .ids
            .as_ref()
            .and_then(|ids| ids.openalex.clone())
            .or(work.id)
            .unwrap_or_else(|| title.clone()),
        title,
        year: work.publication_year,
        cited_by_count: work.cited_by_count.unwrap_or(0),
        doi,
        arxiv_id,
        landing_url: work.primary_location.and_then(|location| location.landing_page_url),
        authors,
    })
}

fn arxiv_id_from_doi(doi: &str) -> Option<String> {
    let start = doi.to_ascii_lowercase().find("arxiv.")? + "arxiv.".len();
    let id = doi[start..].split(['?', '#', '/']).next()?.trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// Form encoding: `util::url_encode`, with `+` for a space.
pub(crate) fn urlencoding(value: &str) -> String {
    crate::util::url_encode(value).replace("%20", "+")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_work_payload() {
        let payload = serde_json::from_value(serde_json::json!({
            "id": "https://openalex.org/W123",
            "title": "Attention Is All You Need",
            "publication_year": 2017,
            "cited_by_count": 100,
            "doi": "https://doi.org/10.48550/arXiv.1706.03762",
            "ids": {"openalex": "https://openalex.org/W123", "doi": "https://doi.org/10.48550/arXiv.1706.03762"},
            "authorships": [{"author": {"display_name": "Ashish Vaswani"}}],
            "primary_location": {"landing_page_url": "https://arxiv.org/abs/1706.03762"},
        }))
        .unwrap();
        let work = map_work(payload).unwrap();
        assert_eq!(work.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(work.authors, vec!["Ashish Vaswani".to_string()]);
        assert_eq!(work.doi.as_deref(), Some("10.48550/arxiv.1706.03762"));
        assert_eq!(arxiv_id_from_doi("10.1145/123"), None);
        // Form encoding, as every provider query in the crate sends it.
        assert_eq!(urlencoding("a b+c/é~"), "a+b%2Bc%2F%C3%A9~");
    }
}
