use crate::models::OpenAlexWork;
use serde::Deserialize;
use std::env;

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

pub fn search_works(query: &str, precise: bool, page: u32) -> Result<Vec<OpenAlexWork>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let page = page.max(1);
    let select = "id,title,publication_year,cited_by_count,ids,doi,authorships,primary_location";
    let mut url = if precise {
        format!(
            "https://api.openalex.org/works?filter=title_and_abstract.search:{}&per_page={PER_PAGE}&page={page}&select={select}",
            urlencoding(trimmed)
        )
    } else {
        format!(
            "https://api.openalex.org/works?search={}&per_page={PER_PAGE}&page={page}&select={select}",
            urlencoding(trimmed)
        )
    };
    if let Ok(key) = env::var("OPENALEX_API_KEY") {
        if !key.trim().is_empty() {
            url.push_str("&api_key=");
            url.push_str(&urlencoding(key.trim()));
        }
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent("Lattice/0.1 (research writing; mailto:lattice@local)")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not create OpenAlex client: {error}"))?;
    let response = client
        .get(&url)
        .send()
        .map_err(|error| format!("OpenAlex request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "OpenAlex returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let payload: WorksResponse = response
        .json()
        .map_err(|error| format!("Could not parse OpenAlex response: {error}"))?;
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
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_start_matches("https://doi.org/").to_string());
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
        landing_url: work
            .primary_location
            .and_then(|location| location.landing_page_url),
        authors,
    })
}

fn arxiv_id_from_doi(doi: &str) -> Option<String> {
    let lower = doi.to_ascii_lowercase();
    let marker = "arxiv.";
    let index = lower.find(marker)?;
    let rest = &doi[index + marker.len()..];
    let id = rest.split(['?', '#', '/']).next()?.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

pub(crate) fn urlencoding(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_arxiv_id_from_doi() {
        assert_eq!(
            arxiv_id_from_doi("10.48550/arXiv.1706.03762"),
            Some("1706.03762".to_string())
        );
        assert_eq!(arxiv_id_from_doi("10.1145/123"), None);
    }

    #[test]
    fn maps_work_payload() {
        let payload = WorkPayload {
            id: Some("https://openalex.org/W123".into()),
            title: Some("Attention Is All You Need".into()),
            publication_year: Some(2017),
            cited_by_count: Some(100),
            doi: Some("https://doi.org/10.48550/arXiv.1706.03762".into()),
            ids: Some(WorkIds {
                openalex: Some("https://openalex.org/W123".into()),
                doi: Some("https://doi.org/10.48550/arXiv.1706.03762".into()),
            }),
            authorships: Some(vec![Authorship {
                author: Some(Author {
                    display_name: Some("Ashish Vaswani".into()),
                }),
            }]),
            primary_location: Some(PrimaryLocation {
                landing_page_url: Some("https://arxiv.org/abs/1706.03762".into()),
            }),
        };
        let work = map_work(payload).unwrap();
        assert_eq!(work.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(work.authors, vec!["Ashish Vaswani".to_string()]);
        assert_eq!(work.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
    }
}
