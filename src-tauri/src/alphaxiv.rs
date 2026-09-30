//! alphaXiv gives two things this app leans on: a full-text search over the
//! arXiv corpus (body-wording matches that a title/abstract index misses) and a
//! per-paper "overview" — a readable analysis of the paper we store next to the
//! full text as the default reading view.

use crate::models::LiteratureHit;
use crate::openalex::urlencoding;
use crate::papers::{collapse_whitespace, http_client, send_checked, LITERATURE_USER_AGENT};
use crate::util::truncate_chars;
use regex::Regex;
use reqwest::blocking::RequestBuilder;
use serde::de::DeserializeOwned;
use serde::Deserialize;

const SEARCH_URL: &str = "https://api.alphaxiv.org/search/v2/paper/full-text";
const PAPER_API: &str = "https://api.alphaxiv.org/papers/v3";
/// alphaXiv's full-text endpoint has no pagination and caps `limit` at 50, so we
/// pull its whole pool once and reveal it incrementally on the client.
const SEARCH_LIMIT: usize = 50;
const OVERVIEW_BASE: &str = "https://www.alphaxiv.org/overview";
/// An overview shorter than this is alphaXiv's "not found" stub, not a report.
const MIN_OVERVIEW_LEN: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchHit {
    paper_id: Option<String>,
    title: Option<String>,
    publication_date: Option<String>,
    votes: Option<i64>,
    snippets: Option<Vec<Snippet>>,
}

#[derive(Debug, Deserialize)]
struct Snippet {
    snippet: Option<String>,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    http_client(LITERATURE_USER_AGENT, 20)
        .map_err(|error| format!("Could not create alphaXiv client: {error}"))
}

/// A JSON response, or `None` for a 404.
fn get_json<T: DeserializeOwned>(request: RequestBuilder) -> Result<Option<T>, String> {
    let response = request.send().map_err(|e| e.to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    response
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Full-text search over arXiv via alphaXiv, as Discover rows ranked as
/// alphaXiv returns them.
pub fn search_works(query: &str) -> Result<Vec<LiteratureHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{SEARCH_URL}?q={}&limit={SEARCH_LIMIT}", urlencoding(trimmed));
    let response = send_checked(client()?.get(&url), "alphaXiv request failed", |status| {
        format!("alphaXiv returned HTTP {status}.")
    })?;
    let body =
        response.bytes().map_err(|error| format!("Could not read alphaXiv response: {error}"))?;
    let hits = parse_search_hits(&body)?;
    Ok(hits.into_iter().filter_map(map_hit).collect())
}

fn parse_search_hits(body: &[u8]) -> Result<Vec<SearchHit>, String> {
    // Some indexed PDFs contain a dangling UTF-16 surrogate. alphaXiv emits
    // that verbatim as (for example) `\ud835`, which is not legal JSON and
    // made one malformed snippet discard every otherwise valid search hit.
    // Replace only unpaired surrogate escapes; preserve valid pairs and
    // escaped literal backslashes before asking serde to decode the response.
    let repaired = repair_unpaired_json_surrogates(body);
    serde_json::from_slice(&repaired)
        .map_err(|error| format!("Could not parse alphaXiv response: {error}"))
}

fn repair_unpaired_json_surrogates(body: &[u8]) -> Vec<u8> {
    let mut repaired = Vec::with_capacity(body.len());
    let mut index = 0;
    while index < body.len() {
        // How many bytes to keep verbatim: an escaped backslash stays whole so
        // its second byte never starts an escape, and a surrogate stays only
        // with its pair.
        let keep = match (body[index], body.get(index + 1)) {
            (b'\\', Some(b'\\')) => 2,
            (b'\\', Some(b'u')) => match escaped_code_unit(body, index) {
                Some(0xD800..=0xDBFF)
                    if escaped_code_unit(body, index + 6)
                        .is_some_and(|low| (0xDC00..=0xDFFF).contains(&low)) =>
                {
                    12
                }
                Some(0xD800..=0xDFFF) => {
                    repaired.extend_from_slice(br"\uFFFD");
                    index += 6;
                    continue;
                }
                Some(_) => 6,
                None => 1,
            },
            _ => 1,
        };
        repaired.extend_from_slice(&body[index..index + keep]);
        index += keep;
    }
    repaired
}

/// The UTF-16 code unit of a `\uXXXX` escape starting at `index`.
fn escaped_code_unit(body: &[u8], index: usize) -> Option<u16> {
    let escape = body.get(index..index + 6)?;
    if !escape.starts_with(br"\u") || !escape[2..].iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    u16::from_str_radix(std::str::from_utf8(&escape[2..]).ok()?, 16).ok()
}

/// AlphaXiv also hosts reports without an arXiv identity. Keep those IDs out
/// of the arXiv parser; their bundles use the existing URL-keyed cache.
pub fn paper_id_from_url(input: &str) -> Option<String> {
    let url = reqwest::Url::parse(input).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("alphaxiv.org" | "www.alphaxiv.org"))
    {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    let id =
        ["/abs/", "/pdf/", "/overview/"].iter().find_map(|prefix| path.strip_prefix(prefix))?;
    let id = id.strip_suffix(".pdf").or_else(|| id.strip_suffix(".md")).unwrap_or(id);
    valid_paper_id(id).then(|| id.to_string())
}

fn valid_paper_id(id: &str) -> bool {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9.-]*(?:/[0-9]+(?:v[0-9]+)?)?$").unwrap().is_match(id)
        && !id.contains("..")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    pub version_id: String,
    pub universal_id: String,
    pub title: String,
    pub citation_bibtex: Option<String>,
    pub publication_date: Option<i64>,
}

pub fn resolve_paper(id: &str) -> Result<Option<Paper>, String> {
    if !valid_paper_id(id) {
        return Err("Invalid alphaXiv paper id.".into());
    }
    let Some(paper) = get_json::<Paper>(client()?.get(format!("{PAPER_API}/{id}")))? else {
        return Ok(None);
    };
    if !valid_paper_id(&paper.universal_id) || !valid_paper_id(&paper.version_id) {
        return Err("Invalid alphaXiv response identity.".into());
    }
    Ok(Some(paper))
}

/// Exact title only: a ranked near-match must not silently become a citation.
pub fn resolve_title(title: &str) -> Result<Option<Paper>, String> {
    let response = client()?
        .get("https://api.alphaxiv.org/search/v2/paper/fast")
        .query(&[("q", title), ("includePrivate", "false")])
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let hits = parse_search_hits(&response.bytes().map_err(|e| e.to_string())?)?;
    let normalize = |s: &str| {
        s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>()
    };
    let title = normalize(title);
    let ids: std::collections::BTreeSet<_> = hits
        .into_iter()
        .filter_map(|hit| {
            (normalize(hit.title.as_deref()?) == title)
                .then_some(hit.paper_id?)
                .filter(|id| valid_paper_id(id))
        })
        .collect();
    if ids.len() != 1 {
        return Ok(None);
    }
    let paper = resolve_paper(ids.first().unwrap())?;
    Ok(paper.filter(|paper| normalize(&paper.title) == title))
}

pub fn fetch_paper_overview(paper: &Paper) -> Result<Option<String>, String> {
    let request = client()?
        .get(format!("{PAPER_API}/{}/overview-v2", paper.version_id))
        .query(&[("language", "en")]);
    let Some(body) = get_json::<serde_json::Value>(request)? else {
        return Ok(None);
    };
    let overview = &body["overview"];
    if overview["state"] != "done" {
        return Ok(None);
    }
    overview["mdxSource"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|source| overview_markdown(source, &paper.universal_id))
        .transpose()
}

/// Consume the source, never the API's compiled MDX JavaScript. These are the
/// two presentation components used by overviews; citations become portable
/// PDF page links with their source anchors retained in the link title.
fn overview_markdown(source: &str, id: &str) -> Result<String, String> {
    let attributes =
        Regex::new(r#"([A-Za-z]+)\s*=\s*(?:\{\s*(\d+)\s*\}|"([^"]*)"|'([^']*)')"#).unwrap();
    let components = Regex::new(r#"(?s)<(PaperCite|ImageCaption)\b((?:"[^"]*"|'[^']*'|[^'">])*?)(?:/>|>(.*?)</(?:PaperCite|ImageCaption)>)"#).unwrap();
    let markdown = components.replace_all(source, |capture: &regex::Captures<'_>| {
        let attrs: std::collections::HashMap<_, _> = attributes.captures_iter(&capture[2]).map(|a| {
            (a[1].to_string(), crate::util::decode_html_attribute(a.get(2).or_else(|| a.get(3)).or_else(|| a.get(4)).unwrap().as_str()).into_owned())
        }).collect();
        let content = capture.get(3).map_or("", |c| c.as_str());
        if &capture[1] == "PaperCite" {
            let Some(page) = attrs.get("page").and_then(|p| p.parse::<u32>().ok()).filter(|p| *p > 0) else {
                return content.to_string();
            };
            let quote = [attrs.get("first"), attrs.get("last")].into_iter().flatten().cloned().collect::<Vec<_>>().join(" … ");
            let quote = quote.replace('\\', "\\\\").replace('"', "\\\"").replace(['\n', '\r'], " ");
            format!("{content} [p{page}](https://www.alphaxiv.org/abs/{id}.pdf#page={page} \"{quote}\")")
        } else {
            let Some(src) = attrs.get("src").filter(|src| reqwest::Url::parse(src).is_ok_and(|url| url.scheme() == "https")) else {
                return content.to_string();
            };
            let alt = attrs.get("alt").map(String::as_str).unwrap_or("").replace('[', "\\[").replace(']', "\\]");
            let src = src.replace('(', "%28").replace(')', "%29").replace(' ', "%20");
            format!("\n\n![{alt}]({src})\n\n{content}\n\n")
        }
    }).into_owned();
    if markdown.contains("<PaperCite") || markdown.contains("<ImageCaption") {
        return Err("Unsupported alphaXiv overview component syntax.".into());
    }
    Ok(markdown)
}

/// Prefer the website's citation-bearing overview. The old markdown endpoint
/// is a separate report, used only when the current overview is unavailable.
pub fn fetch_overview(arxiv_id: &str) -> Result<Option<String>, String> {
    if let Ok(Some(paper)) = resolve_paper(arxiv_id) {
        if let Ok(Some(overview)) = fetch_paper_overview(&paper) {
            return Ok(Some(overview));
        }
    }
    let response = client()?
        .get(format!("{OVERVIEW_BASE}/{arxiv_id}.md"))
        .send()
        .map_err(|error| format!("alphaXiv overview request failed: {error}"))?;
    match response.status().as_u16() {
        404 => return Ok(None),
        status if !response.status().is_success() => {
            return Err(format!("alphaXiv overview returned HTTP {status}."))
        }
        _ => {}
    }
    let body =
        response.text().map_err(|error| format!("Could not read alphaXiv overview: {error}"))?;
    if body.trim().len() < MIN_OVERVIEW_LEN {
        return Ok(None);
    }
    Ok(Some(body))
}

fn map_hit(hit: SearchHit) -> Option<LiteratureHit> {
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
        .map(|text| truncate_chars(&text, 240));
    Some(LiteratureHit {
        source: "alphaxiv".to_string(),
        arxiv_id: arxiv_shaped(&paper_id).map(str::to_string),
        title,
        year,
        authors: Vec::new(),
        cited_by_count: None,
        votes,
        snippet,
        doi: None,
        landing_url: None,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_alphaxiv_urls_without_accepting_other_hosts_or_paths() {
        for path in [
            "abs/2609.mimo-scaling-reinforcement-learning",
            "pdf/2609.mimo-scaling-reinforcement-learning",
            "overview/2609.mimo-scaling-reinforcement-learning.md",
        ] {
            assert_eq!(
                paper_id_from_url(&format!("https://www.alphaxiv.org/{path}?source=test#page=8"))
                    .as_deref(),
                Some("2609.mimo-scaling-reinforcement-learning")
            );
        }
        assert_eq!(
            paper_id_from_url("https://alphaxiv.org/abs/cs/9901002").as_deref(),
            Some("cs/9901002")
        );
        for url in [
            "https://alphaxiv.org.evil.test/abs/2609.fake",
            "https://alphaxiv.org/blog/test",
            "https://alphaxiv.org/abs/a%2fb",
            "https://alphaxiv.org/abs/a/extra",
            "https://alphaxiv.org/abs/..fake",
        ] {
            assert_eq!(paper_id_from_url(url), None, "{url}");
        }
    }

    #[test]
    fn overviews_keep_cited_prose_pages_and_captions_without_executing_mdx() {
        let source = r#"<PaperCite page={8} first="A &quot;quoted&quot; start" last="end &amp; more">**First claim**</PaperCite>.
<PaperCite page={19} first='Second' last='end'/>
<PaperCite page={34} first="Third" last="finish">Last claim</PaperCite>
<ImageCaption src="https://paper-assets.alphaxiv.org/figure(1).jpg" alt="Plot [A]">Not a controlled baseline.</ImageCaption>"#;
        let markdown = overview_markdown(source, "2609.report").unwrap();
        assert!(markdown.contains(r#"**First claim** [p8](https://www.alphaxiv.org/abs/2609.report.pdf#page=8 "A \"quoted\" start … end & more")"#));
        assert!(markdown.contains("[p19](https://www.alphaxiv.org/abs/2609.report.pdf#page=19"));
        assert!(markdown.contains("Last claim [p34]"));
        assert!(markdown
            .contains(r"![Plot \[A\]](https://paper-assets.alphaxiv.org/figure%281%29.jpg)"));
        assert!(markdown.contains("Not a controlled baseline."));
        assert!(!markdown.contains("<PaperCite"));
        assert!(!markdown.contains("<ImageCaption"));
        // MDX expressions are never executed, and invalid pages or sources
        // make no links, but their prose survives.
        let source = r#"<PaperCite page={0}>Keep this prose</PaperCite><ImageCaption src="javascript:alert(1)">Keep caption</ImageCaption>"#;
        let markdown = overview_markdown(source, "2609.report").unwrap();
        assert_eq!(markdown, "Keep this proseKeep caption");
        assert!(overview_markdown("<PaperCite {...execute()}>claim</PaperCite>", "2609.report")
            .unwrap()
            .contains("claim"));
    }

    #[test]
    #[ignore = "Live AlphaXiv API smoke test"]
    fn live_mimo_overview_contains_page_citations() {
        let paper = resolve_paper("2609.mimo-scaling-reinforcement-learning").unwrap().unwrap();
        let markdown = fetch_paper_overview(&paper).unwrap().unwrap();
        assert!(markdown.contains(
            "[p8](https://www.alphaxiv.org/abs/2609.mimo-scaling-reinforcement-learning.pdf#page=8"
        ));
        assert!(markdown.contains("[p34]"));
        assert!(!markdown.contains("<PaperCite"));
        println!("OVERVIEW_START\n{markdown}\nOVERVIEW_END");
        let matched = resolve_title(&paper.title).unwrap().unwrap();
        assert_eq!(matched.universal_id, paper.universal_id);
    }

    #[test]
    fn maps_search_hits_repairing_surrogates_and_dropping_untitled_ones() {
        let hits = parse_search_hits(
            br#"[{"paperId":"2401.12345","title":"  A Great Paper  ","publicationDate":"2024-06-26T06:08:44.000Z","votes":7,
                  "snippets":[{"snippet":null},{"snippet":"some\n  matching   text"}]},
                 {"paperId":"some-slug-id","title":"Slug Paper"},
                 {"paperId":"2401.12345","title":"   "}]"#,
        )
        .unwrap();
        let mut works = hits.into_iter().map(map_hit);
        let work = works.next().unwrap().unwrap();
        assert_eq!(work.source, "alphaxiv");
        assert_eq!(work.arxiv_id.as_deref(), Some("2401.12345"));
        assert_eq!(work.title, "A Great Paper");
        assert_eq!(work.year, Some(2024));
        assert_eq!(work.votes, Some(7));
        assert_eq!(work.snippet.as_deref(), Some("some matching text"));
        // A non-arXiv slug is kept, but without a fetchable id.
        let slug = works.next().unwrap().unwrap();
        assert_eq!((slug.title.as_str(), slug.arxiv_id), ("Slug Paper", None));
        assert!(works.next().unwrap().is_none());

        // alphaXiv emits unpaired JSON surrogates; they are repaired, not fatal.
        let body = br#"[{"paperId":"2401.12345","title":"Action + \ud835...","snippets":[{"snippet":"valid pair: \ud835\udc68; literal: \\ud835"}]}]"#;
        let hits = parse_search_hits(body).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title.as_deref(), Some("Action + �..."));
        assert_eq!(
            hits[0].snippets.as_ref().and_then(|snippets| snippets[0].snippet.as_deref()),
            Some("valid pair: 𝑨; literal: \\ud835")
        );
    }
}
