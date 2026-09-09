//! Firecrawl scrape client: webpages and blogs cited into the bibliography
//! become local markdown the reader and the agent can open.
//!
//! This is the one importer that talks to a third-party service, because the
//! open web is the one source that needs it: paywalls, JS rendering and bot
//! checks defeat local extraction. arXiv content never goes through here —
//! its HTML and PDF routes are local (see papers.rs) and per-page billing
//! would burn the shared quota on work a local converter does better.

use serde::Deserialize;

const SCRAPE_URL: &str = "https://api.firecrawl.dev/v2/scrape";
/// The shared free plan allows 2 concurrent browsers and 10 requests/minute;
/// a second Lattice user mid-scrape surfaces as 429 here. Two spaced retries
/// ride out a busy moment without holding a citation hostage for minutes.
const RETRY_DELAYS_S: [u64; 2] = [10, 20];

pub struct ScrapedPage {
    pub markdown: String,
    pub title: Option<String>,
    pub html: String,
}

#[derive(Deserialize)]
struct ScrapeResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    data: Option<ScrapeData>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct ScrapeData {
    #[serde(default)]
    markdown: Option<String>,
    #[serde(default, rename = "rawHtml")]
    html: Option<String>,
    #[serde(default)]
    metadata: Option<ScrapeMetadata>,
}

#[derive(Deserialize)]
struct ScrapeMetadata {
    #[serde(default)]
    title: Option<serde_json::Value>,
    #[serde(default, rename = "statusCode")]
    status_code: Option<u16>,
}

fn api_key() -> Result<String, String> {
    crate::literature_credentials::firecrawl_key()?.ok_or_else(|| {
        "Webpage import needs a Firecrawl API key. Add one in Settings → Literature services (this build has no shared key).".to_string()
    })
}

/// Scrape one page to markdown. Retries 429s, translates quota and
/// concurrency limits into messages a user can act on.
pub fn scrape(url: &str) -> Result<ScrapedPage, String> {
    let key = api_key()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| format!("Could not create the Firecrawl client: {error}"))?;
    let body = serde_json::json!({
        "url": url,
        "formats": ["markdown", "rawHtml"],
        "onlyMainContent": true,
    });
    let mut attempt = 0usize;
    loop {
        let response = client
            .post(SCRAPE_URL)
            .bearer_auth(&key)
            .json(&body)
            .send()
            .map_err(|error| format!("Firecrawl request failed: {error}"))?;
        let status = response.status().as_u16();
        match status {
            401 | 403 => {
                return Err("Firecrawl rejected the API key. Check it in Settings → Literature services.".into());
            }
            402 => {
                return Err(
                    "The active Firecrawl key has insufficient credits. Check its quota or change the key in Settings → Literature services."
                        .to_string(),
                )
            }
            429 if attempt < RETRY_DELAYS_S.len() => {
                std::thread::sleep(std::time::Duration::from_secs(RETRY_DELAYS_S[attempt]));
                attempt += 1;
                continue;
            }
            429 => {
                return Err(
                    "Firecrawl is rate-limiting the active key. Wait a moment and retry."
                        .to_string(),
                )
            }
            _ => {}
        }
        let parsed: ScrapeResponse = response
            .json()
            .map_err(|error| format!("Firecrawl returned an unreadable response: {error}"))?;
        if !parsed.success {
            return Err(format!(
                "Firecrawl could not scrape the page: {}",
                parsed
                    .error
                    .unwrap_or_else(|| format!("HTTP {status}"))
                    .replace(&key, "[redacted]")
            ));
        }
        let data = parsed
            .data
            .ok_or_else(|| "Firecrawl reported success with no content.".to_string())?;
        return scraped_page(data);
    }
}

fn scraped_page(data: ScrapeData) -> Result<ScrapedPage, String> {
    if let Some(status) = data
        .metadata
        .as_ref()
        .and_then(|m| m.status_code)
        .filter(|s| *s >= 400)
    {
        return Err(format!("The webpage still returned HTTP {status} after browser rendering. It may require sign-in or block access."));
    }
    let markdown = data.markdown.unwrap_or_default();
    // A bot wall or an empty shell page "succeeds" with next to nothing;
    // storing that would turn a bad scrape into a permanent bad bundle.
    if markdown.trim().len() < 200 {
        return Err(
            "The page yielded almost no content (it may require sign-in or block scraping)."
                .to_string(),
        );
    }
    Ok(ScrapedPage {
        markdown,
        title: data
            .metadata
            .and_then(|metadata| metadata.title)
            .and_then(|value| {
                value
                    .as_str()
                    .or_else(|| value.as_array()?.first()?.as_str())
                    .map(str::to_string)
            }),
        html: data.html.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_html_and_title_survive_response_parsing_but_block_pages_do_not() {
        let body = "A rendered research article with substantive contents. ".repeat(10);
        let json = serde_json::json!({"markdown":body,"rawHtml":"<h1>Rendered article</h1>","metadata":{"title":["Rendered article"],"statusCode":200}});
        let page = scraped_page(serde_json::from_value(json.clone()).unwrap()).unwrap();
        assert_eq!(page.title.as_deref(), Some("Rendered article"));
        assert_eq!(page.html, "<h1>Rendered article</h1>");
        assert_eq!(page.markdown, body);
        let mut blocked = json;
        blocked["metadata"]["statusCode"] = 567.into();
        assert!(scraped_page(serde_json::from_value(blocked).unwrap())
            .err()
            .unwrap()
            .contains("HTTP 567"));
        let empty = serde_json::json!({"markdown":"Just a moment","rawHtml":null,"metadata":{"title":"Just a moment"}});
        assert!(scraped_page(serde_json::from_value(empty).unwrap()).is_err());
    }
}
