//! Firecrawl scrape client: webpages and blogs cited into the bibliography
//! become local markdown the reader and the agent can open.
//!
//! This is the one importer that talks to a third-party service, because the
//! open web is the one source that needs it: paywalls, JS rendering and bot
//! checks defeat local extraction. arXiv content never goes through here —
//! its HTML and PDF routes are local (see papers.rs) and per-page billing
//! would burn the shared quota on work a local converter does better.

use serde::Deserialize;
use std::env;

/// The app ships a shared key so small-scale use needs no signup: baked at
/// release build time from a repo secret, overridable at runtime for
/// development and for users who bring their own. Never committed — the
/// repository is public.
const BAKED_API_KEY: Option<&str> = option_env!("LATTICE_FIRECRAWL_KEY");
const API_KEY_ENV: &str = "LATTICE_FIRECRAWL_KEY";

const SCRAPE_URL: &str = "https://api.firecrawl.dev/v2/scrape";
/// The shared free plan allows 2 concurrent browsers and 10 requests/minute;
/// a second Lattice user mid-scrape surfaces as 429 here. Two spaced retries
/// ride out a busy moment without holding a citation hostage for minutes.
const RETRY_DELAYS_S: [u64; 2] = [10, 20];

pub struct ScrapedPage {
    pub markdown: String,
    pub title: Option<String>,
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
    #[serde(default)]
    metadata: Option<ScrapeMetadata>,
}

#[derive(Deserialize)]
struct ScrapeMetadata {
    #[serde(default)]
    title: Option<String>,
}

fn api_key() -> Result<String, String> {
    env::var(API_KEY_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| BAKED_API_KEY.map(str::to_string))
        .ok_or_else(|| {
            format!(
                "Webpage import needs a Firecrawl API key. Set {API_KEY_ENV} \
                 (this build was compiled without a bundled key)."
            )
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
        "formats": ["markdown"],
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
            402 => {
                return Err(
                    "The shared Firecrawl quota for this month is used up (1,000 pages). \
                     Try again next month, or set your own key via LATTICE_FIRECRAWL_KEY."
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
                    "Firecrawl is at its concurrency limit (the free plan allows 2 at a time \
                     across everyone sharing this key). Wait a moment and retry."
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
                parsed.error.unwrap_or_else(|| format!("HTTP {status}"))
            ));
        }
        let data = parsed
            .data
            .ok_or_else(|| "Firecrawl reported success with no content.".to_string())?;
        let markdown = data.markdown.unwrap_or_default();
        // A bot wall or an empty shell page "succeeds" with next to nothing;
        // storing that would turn a bad scrape into a permanent bad bundle.
        if markdown.trim().len() < 200 {
            return Err(
                "The page yielded almost no content (it may require sign-in or block scraping)."
                    .to_string(),
            );
        }
        return Ok(ScrapedPage {
            markdown,
            title: data.metadata.and_then(|metadata| metadata.title),
        });
    }
}
