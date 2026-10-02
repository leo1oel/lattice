//! Reference import and the paper library.
//!
//! A reference is an entry in the project's primary bibliography plus, when a
//! full text can be fetched, a bundle under `.research/papers/<key>/`, keyed by
//! arXiv id or, for a captured webpage or PDF, by a digest of its URL.
//!
//! - `import` turns what the user typed (arXiv id, DOI, URL, title, BibTeX)
//!   into a citation and attaches full text; `citation` resolves and checks the
//!   records it commits; `ids` is the arXiv identifier grammar.
//! - `bundle` builds, validates and reuses bundles; `convert` turns an arXiv
//!   paper into markdown; `markdown` cleans the converters' output.
//! - `library` lists, searches and reads what the bibliography cites;
//!   `bibliography` runs bibcite and removes or upgrades entries.

use reqwest::blocking::{RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::Output;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

mod bibliography;
mod bundle;
mod citation;
mod convert;
mod ids;
mod import;
mod library;
mod markdown;
#[cfg(test)]
mod test_support;
mod web_citation;

pub(crate) use bibliography::ScratchBibliography;
pub use bibliography::{
    remove_reference, upgrade_bibliography, CitationRemovalMode, HistoryMode, RemoveResult,
};
pub use bundle::{fetch_paper, fetch_web_reference, FetchResult};
pub(crate) use citation::{
    official_arxiv_citation, validate_resolved_identity, verify_title_citation,
};
pub(crate) use ids::{arxiv_base_id, explicit_arxiv_id};
pub use import::import_reference;
pub use library::{list_library, list_papers, read_paper, read_paper_blog_local, search_library};
pub(crate) use web_citation::alphaxiv_bibtex;

/// How Lattice identifies itself to arXiv, alphaXiv and cited webpages.
pub(crate) const LITERATURE_USER_AGENT: &str =
    "Lattice/0.1 (research writing; mailto:lattice@local)";

/// Without this, arxiv2md caches its source HTML relative to its working
/// directory, which is the bundle being built — every paper carried ~500 KB of
/// its own raw HTML into the project. (A `commands` test reads this file for
/// the variable's name.)
const ARXIV2MD_CACHE_ENV: &str = "ARXIV2MD_CACHE_PATH";

/// A blocking client for the literature services, identified as Lattice's
/// literature agent; callers differ only in the deadline.
pub(crate) fn http_client(timeout_secs: u64) -> reqwest::Result<reqwest::blocking::Client> {
    crate::http::blocking_as(LITERATURE_USER_AGENT, Duration::from_secs(timeout_secs)).build()
}

/// Send `request`, reporting a transport failure as `"{failed}: {error}"` and
/// a non-success status through `status_error`.
pub(crate) fn send_checked(
    request: RequestBuilder, failed: &str, status_error: impl FnOnce(u16) -> String,
) -> Result<Response, String> {
    let response = request.send().map_err(|error| format!("{failed}: {error}"))?;
    if !response.status().is_success() {
        return Err(status_error(response.status().as_u16()));
    }
    Ok(response)
}

/// A response body of at most `limit` bytes, or `None` when the server
/// declared or sent more.
fn read_capped(response: Response, limit: usize) -> std::io::Result<Option<Vec<u8>>> {
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    response.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() <= limit).then_some(bytes))
}

fn check_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("Paper import cancelled.".to_string());
    }
    Ok(())
}

fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// A citation's title, or its key when the entry has none.
fn title_or_key(title: String, key: &str) -> String {
    if title.trim().is_empty() {
        key.to_string()
    } else {
        title
    }
}

fn ensure_success(name: &str, output: &Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "{name} failed.\n{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

/// Importing arXiv papers shells out to `uvx` for the pinned literature tools.
/// When uv isn't installed the raw spawn error ("No such file or directory") is
/// baffling, so point the user straight at the installer.
pub(crate) fn uv_tool_spawn_error(tool: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "Lattice's required `uv` tool is not available yet. \
Open Settings → TeX doctor → Install required tools, then try again."
            .to_string()
    } else {
        format!("Could not start {tool}: {error}")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub arxiv_id: String,
    pub title: String,
    pub paper_path: String,
    pub citation_key: Option<String>,
    pub citation_output: String,
    pub already_imported: bool,
    /// Why the full text is absent although the work has an arXiv id. The
    /// citation itself succeeded; readers (UI notice, agent) decide whether
    /// to mention it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetch_error: Option<String>,
    /// The user stopped enrichment. A citation committed before cancellation
    /// remains valid and is deliberately never rolled back.
    #[serde(default)]
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSummary {
    pub arxiv_id: String,
    /// Normalized DOI from the authoritative bibliography entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    /// The cited page for webpage references — how the row offers a download
    /// when there is no arXiv id to fetch by.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub title: String,
    pub authors: String,
    pub citation_key: Option<String>,
    /// False for works that are only cited — the reader has nothing to open.
    pub has_full_text: bool,
    /// True only when an overview is already present in the local paper cache.
    pub has_blog: bool,
    /// Converter-owned files needed to render figures in the paper reader.
    #[serde(default)]
    pub asset_paths: Vec<String>,
    /// Crossref's DOI-exact update metadata. This is advisory: citations are
    /// never removed or blocked based on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_health: Option<crate::citation_health::CitationHealth>,
}
