// The Discover panel's search: alphaXiv full-text first (body-wording matches),
// OpenAlex second for citation-graph reach. OpenAlex hits without an arXiv id
// are dropped — you can't fetch or ground them here — while every alphaXiv hit
// is kept. Results are deduped by versionless arXiv id with alphaXiv winning,
// so a paper both indexes know appears once, on top, as an alphaXiv row.

use crate::alphaxiv::{self, AlphaxivWork};
use crate::models::{LiteratureHit, OpenAlexWork};
use crate::openalex;
use crate::papers::arxiv_base_id;

pub fn search(query: &str, precise: bool) -> Result<Vec<LiteratureHit>, String> {
    let alpha = alphaxiv::search_works(query)?;
    let open = openalex::search_works(query, precise)?;
    Ok(merge(alpha, open))
}

fn merge(alpha: Vec<AlphaxivWork>, open: Vec<OpenAlexWork>) -> Vec<LiteratureHit> {
    let mut hits: Vec<LiteratureHit> = Vec::with_capacity(alpha.len() + open.len());
    let mut seen: Vec<String> = Vec::new();

    for work in alpha {
        if let Some(id) = arxiv_shaped(&work.paper_id) {
            seen.push(arxiv_base_id(id).to_string());
        }
        hits.push(from_alphaxiv(work));
    }

    for work in open {
        // OpenAlex is citation-graph reach; a hit we can't fetch as an arXiv
        // preprint is noise in this panel, so require an arXiv id.
        let Some(arxiv_id) = work.arxiv_id.clone() else {
            continue;
        };
        let base = arxiv_base_id(&arxiv_id).to_string();
        if seen.contains(&base) {
            continue;
        }
        seen.push(base);
        hits.push(from_openalex(work));
    }

    hits
}

/// alphaXiv paperIds are almost always arXiv ids, but the corpus has occasional
/// non-arXiv slugs. Only an arXiv-shaped id is fetchable / dedupe-comparable.
fn arxiv_shaped(id: &str) -> Option<&str> {
    let bytes = id.as_bytes();
    let is_new = id.len() >= 9
        && bytes.get(4) == Some(&b'.')
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().take(4).all(u8::is_ascii_digit);
    let is_old = id.contains('/') && id.chars().any(|c| c.is_ascii_digit());
    (is_new || is_old).then_some(id)
}

fn from_alphaxiv(work: AlphaxivWork) -> LiteratureHit {
    let arxiv_id = arxiv_shaped(&work.paper_id).map(ToString::to_string);
    LiteratureHit {
        source: "alphaxiv".to_string(),
        arxiv_id,
        title: work.title,
        year: work.year,
        authors: Vec::new(),
        cited_by_count: None,
        votes: work.votes,
        snippet: work.snippet,
        doi: None,
        landing_url: None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha(id: &str, title: &str) -> AlphaxivWork {
        AlphaxivWork {
            paper_id: id.to_string(),
            title: title.to_string(),
            year: None,
            votes: None,
            snippet: None,
        }
    }

    fn open(arxiv: Option<&str>, title: &str) -> OpenAlexWork {
        OpenAlexWork {
            id: title.to_string(),
            title: title.to_string(),
            year: None,
            cited_by_count: 3,
            doi: None,
            arxiv_id: arxiv.map(ToString::to_string),
            landing_url: None,
            authors: vec![],
        }
    }

    #[test]
    fn alphaxiv_leads_and_openalex_arxiv_only_follows() {
        let hits = merge(
            vec![alpha("2401.00001", "Alpha One")],
            vec![
                open(None, "No arXiv here"),
                open(Some("2402.00002"), "Open Two"),
            ],
        );
        let sources: Vec<_> = hits.iter().map(|h| (h.source.as_str(), h.title.as_str())).collect();
        assert_eq!(
            sources,
            vec![("alphaxiv", "Alpha One"), ("openalex", "Open Two")]
        );
    }

    #[test]
    fn dedupes_by_base_id_with_alphaxiv_winning() {
        let hits = merge(
            vec![alpha("2401.00001v2", "Alpha One")],
            vec![open(Some("2401.00001"), "Same Paper From OpenAlex")],
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source, "alphaxiv");
    }

    #[test]
    fn keeps_a_non_arxiv_alphaxiv_slug_but_without_a_fetchable_id() {
        let hits = merge(vec![alpha("some-slug-id", "Slug Paper")], vec![]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].arxiv_id, None);
    }
}
