//! The paper library as the agent reads it, through its `list_papers` and
//! `search_library` tools: each cited work with the workspace-relative paths
//! of its cached files, which the agent opens with its own file tools.

use super::library::{list_papers, refresh_citation_health};
use serde::Serialize;
use std::path::Path;

/// One library entry as the agent sees it: what the work is, how to cite it,
/// which cached files hold its text, and the PDF that text was converted from
/// when the bundle keeps one. Paths are workspace-relative so the agent can
/// read them directly with its own file tools.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPaper {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_key: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub arxiv_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_health: Option<crate::citation_health::CitationHealth>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_text_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overview_path: Option<String>,
    /// The paper's own pages (a Zotero attachment, attach.rs). Text converted
    /// from a PDF tells its reader to verify formulas and tables against the
    /// PDF; without this path an agent asked for the paper itself searched
    /// the project for a PDF and reported it could not open one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_path: Option<String>,
}

/// The paper library for the agent's `list_papers` tool: the same cited works
/// the Papers panel and the composer's @-picker show, with readable cache
/// paths attached. An entry without paths is cited but not downloaded; the
/// agent can fetch_paper it only when it has an arXiv id.
pub fn list_library(root: &Path) -> Result<Vec<LibraryPaper>, String> {
    // The agent asked for this list and reads its health once, so it waits
    // for the recheck the Papers panel runs in the background.
    let mut health = refresh_citation_health(root)?;
    Ok(library_entries(root)?
        .into_iter()
        .map(|entry| LibraryPaper {
            citation_health: entry
                .doi
                .as_ref()
                .and_then(|doi| health.remove(doi))
                .or(entry.citation_health),
            ..entry
        })
        .collect())
}

/// The library with paths attached and only cached citation health.
pub(super) fn library_entries(root: &Path) -> Result<Vec<LibraryPaper>, String> {
    Ok(list_papers(root)?
        .into_iter()
        .map(|paper| {
            let cached = |present: bool, file: &str| {
                (present && !paper.arxiv_id.is_empty())
                    .then(|| format!(".research/papers/{}/{file}", paper.arxiv_id))
            };
            LibraryPaper {
                full_text_path: cached(paper.has_full_text, "paper.md"),
                overview_path: cached(paper.has_blog, "blog.md"),
                pdf_path: cached(paper.has_local_pdf, super::attach::ORIGINAL_PDF),
                title: paper.title,
                citation_key: paper.citation_key,
                arxiv_id: paper.arxiv_id,
                doi: paper.doi,
                url: paper.url,
                citation_health: paper.citation_health,
            }
        })
        .collect())
}
