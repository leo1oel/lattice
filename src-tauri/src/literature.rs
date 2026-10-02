// The Discover panel's search: alphaXiv full-text first (body-wording matches),
// OpenAlex second for citation-graph reach. Results are deduped by versionless
// arXiv id, then DOI/source identity/title, with alphaXiv winning,
// so a paper both indexes know appears once, on top, as an alphaXiv row.

use crate::alphaxiv;
use crate::models::{LiteratureHit, OpenAlexWork};
use crate::openalex;
use crate::papers::arxiv_base_id;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// One page of merged results. `page` is 0-indexed. Page 0 carries alphaXiv's
/// whole full-text pool (it can't paginate) plus OpenAlex's first page; later
/// pages are OpenAlex-only (arXiv works), so the list keeps growing on scroll.
/// Cross-page de-duplication is the client's job (it tracks what it has shown).
pub fn search(query: &str, precise: bool, page: u32) -> Result<LiteraturePage, String> {
    let open = openalex::search_works(query, precise, page + 1)?;
    let has_more = open.len() as u32 >= openalex::PER_PAGE;
    let alpha = if page == 0 { alphaxiv::search_works(query) } else { Ok(Vec::new()) };
    Ok(LiteraturePage { hits: merge_available(alpha, open), has_more })
}

fn merge_available(
    alpha: Result<Vec<LiteratureHit>, String>, open: Vec<OpenAlexWork>,
) -> Vec<LiteratureHit> {
    let alpha = alpha.unwrap_or_else(|error| {
        // alphaXiv is an enrichment source. OpenAlex has already completed at
        // this point, so a malformed alphaXiv snippet must not blank the whole
        // Discover panel and hide those valid results.
        log::warn!(target: "lattice::literature", "alphaXiv search unavailable: {error}");
        Vec::new()
    });
    merge(alpha, open)
}

fn merge(alpha: Vec<LiteratureHit>, open: Vec<OpenAlexWork>) -> Vec<LiteratureHit> {
    let arxiv_identity = |id: &str| format!("arxiv:{}", arxiv_base_id(id).to_lowercase());
    let title_identity = |title: &str| format!("title:{}", title.trim().to_lowercase());
    let mut hits: Vec<LiteratureHit> = Vec::with_capacity(alpha.len() + open.len());
    let mut seen = HashSet::new();

    for hit in alpha {
        seen.insert(match hit.arxiv_id.as_deref() {
            Some(id) => arxiv_identity(id),
            None => title_identity(&hit.title),
        });
        hits.push(hit);
    }

    for work in open {
        let identity = work
            .arxiv_id
            .as_deref()
            .map(arxiv_identity)
            .or_else(|| work.doi.as_deref().map(|doi| format!("doi:{}", doi.trim().to_lowercase())))
            .unwrap_or_else(|| format!("openalex:{}", work.id.trim().to_lowercase()));
        let title = title_identity(&work.title);
        if seen.contains(&identity) || seen.contains(&title) {
            continue;
        }
        seen.extend([identity, title]);
        hits.push(from_openalex(work));
    }

    hits
}

fn from_openalex(work: OpenAlexWork) -> LiteratureHit {
    LiteratureHit {
        source: "openalex".to_string(),
        arxiv_id: work.arxiv_id,
        title: work.title,
        year: work.year,
        authors: work.authors,
        cited_by_count: Some(work.cited_by_count),
        votes: None,
        snippet: None,
        doi: work.doi,
        landing_url: work.landing_url,
    }
}

/// One page of Discover results. `has_more` means another backend page can be
/// fetched (OpenAlex has deeper pages); alphaXiv is exhausted after page 0.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteraturePage {
    pub hits: Vec<LiteratureHit>,
    pub has_more: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// An alphaXiv row as `alphaxiv::search_works` maps it.
    fn alpha(arxiv_id: &str, title: &str) -> LiteratureHit {
        let hit = json!({"source": "alphaxiv", "arxivId": arxiv_id, "title": title, "authors": []});
        serde_json::from_value(hit).unwrap()
    }

    fn open(arxiv: Option<&str>, title: &str) -> OpenAlexWork {
        let work = json!({"id": title, "title": title, "citedByCount": 3, "arxivId": arxiv, "authors": []});
        serde_json::from_value(work).unwrap()
    }

    /// alphaXiv rows lead, and an OpenAlex row naming the same work by
    /// versionless arXiv id is dropped. A malformed alphaXiv response still
    /// leaves the OpenAlex results.
    #[test]
    fn merges_alphaxiv_first_dedupes_by_arxiv_identity_and_survives_malformed_alphaxiv() {
        for (alpha_hits, open_hits, expected) in [
            (
                Ok(vec![alpha("2401.00001", "Alpha One")]),
                vec![open(None, "No arXiv here"), open(Some("2402.00002"), "Open Two")],
                vec![
                    ("alphaxiv", "Alpha One"),
                    ("openalex", "No arXiv here"),
                    ("openalex", "Open Two"),
                ],
            ),
            (
                Ok(vec![alpha("2401.00001v2", "Alpha One")]),
                vec![open(Some("2401.00001"), "Same Paper From OpenAlex")],
                vec![("alphaxiv", "Alpha One")],
            ),
            (
                Err("Could not parse alphaXiv response".to_string()),
                vec![open(Some("2402.00002"), "Open Two")],
                vec![("openalex", "Open Two")],
            ),
        ] {
            let hits = merge_available(alpha_hits, open_hits);
            let got: Vec<_> = hits.iter().map(|h| (h.source.as_str(), h.title.as_str())).collect();
            assert_eq!(got, expected);
        }
    }
}
