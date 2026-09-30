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

/// A blocking client for the literature services; callers differ only in the
/// agent string and the deadline.
pub(crate) fn http_client(
    user_agent: &str, timeout_secs: u64,
) -> reqwest::Result<reqwest::blocking::Client> {
    crate::http::blocking_as(user_agent, Duration::from_secs(timeout_secs)).build()
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

pub(crate) use crate::util::collapse_whitespace;

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

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
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
