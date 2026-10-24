//! Searching the paper library: the agent's `search_library` tool and the
//! Find dialog's paper hits (flat, capped hits) and the Papers panel (papers
//! with their best lines), all through the project's paper index
//! (`search_index`). The bibliography stays authoritative as in
//! `list_papers`: the index holds exactly the cited papers with cached text,
//! synced before each search, so text the agent fetched but never cited is
//! not searched. When the index cannot be used, a linear scan of the same
//! files answers instead.

use super::library::{library_entries, LibraryPaper};
use super::search_index::{self, Limits, LineHit, PaperFile, PaperText, PaperTextMatch};
use crate::models::ProjectSearchResult;
use crate::project;
use crate::util::truncate_chars;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// The agent's and the Find dialog's caps: hits in all, and per paper
/// (a title match counts as one).
const MAX_HITS: usize = 60;
const MAX_HITS_PER_PAPER: usize = 5;
/// The Papers panel shows a few lines per paper and the rest on request.
const PANEL_LIMITS: Limits = Limits { papers: 100, hits_per_paper: 10 };

/// The index's view of the library: each cited paper with cached text.
fn indexed_papers(root: &Path, entries: &[LibraryPaper]) -> Vec<PaperText> {
    entries
        .iter()
        .filter(|entry| !entry.arxiv_id.is_empty())
        .map(|entry| PaperText {
            key: entry.arxiv_id.clone(),
            title: entry.title.clone(),
            files: [&entry.full_text_path, &entry.overview_path]
                .into_iter()
                .flatten()
                .filter_map(|path| {
                    let absolute = project::safe_path(root, path).ok()?;
                    Some(PaperFile { path: path.clone(), absolute })
                })
                .collect(),
        })
        .filter(|paper| !paper.files.is_empty())
        .collect()
}

/// Matching papers, best first, each with its best lines; a scan's answer
/// when the index is unavailable.
fn search_papers(
    root: &Path, entries: &[LibraryPaper], query: &str, limits: Limits,
) -> Vec<PaperTextMatch> {
    let papers = indexed_papers(root, entries);
    let dir = search_index::project_index_dir(root);
    search_index::search(&dir, &papers, query, limits).unwrap_or_else(|error| {
        log::warn!("Paper search falls back to a scan: {error}");
        scan_matches(root, entries, &project::search_terms(query), limits)
    })
}

/// The agent's `search_library` and the Find dialog's paper hits: cited
/// papers' titles and lines, papers by relevance, at most `MAX_HITS`.
pub fn search_library(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    if project::search_terms(query).is_empty() {
        return Ok(Vec::new());
    }
    let entries = library_entries(root)?;
    let limits = Limits { papers: MAX_HITS, hits_per_paper: MAX_HITS_PER_PAPER };
    let by_key: HashMap<&str, &LibraryPaper> =
        entries.iter().map(|entry| (entry.arxiv_id.as_str(), entry)).collect();
    let mut results = Vec::new();
    for found in search_papers(root, &entries, query, limits) {
        let Some(paper) = by_key.get(found.key.as_str()) else { continue };
        let first_readable = paper.full_text_path.as_deref().or(paper.overview_path.as_deref());
        let title = found.title_match.then_some(first_readable).flatten();
        let title_hit = title.map(|path| library_hit(paper, path, None, &paper.title));
        let line_hits =
            found.hits.iter().map(|hit| library_hit(paper, &hit.path, Some(hit.line), &hit.text));
        results.extend(title_hit.into_iter().chain(line_hits).take(MAX_HITS_PER_PAPER));
    }
    results.truncate(MAX_HITS);
    Ok(results)
}

/// The Papers panel's search: matching papers by relevance, with their lines.
pub fn search_library_text(root: &Path, query: &str) -> Result<Vec<PaperTextMatch>, String> {
    if project::search_terms(query).is_empty() {
        return Ok(Vec::new());
    }
    Ok(search_papers(root, &library_entries(root)?, query, PANEL_LIMITS))
}

/// Sync the project's paper index off the calling thread, so the search
/// after a listing, an import, a download or a removal finds it current.
pub fn refresh_search_index(root: &Path) {
    let root = root.to_path_buf();
    search_index::sync_in_background(search_index::project_index_dir(&root), move || {
        Ok(indexed_papers(&root, &library_entries(&root)?))
    });
}

fn library_hit(
    paper: &LibraryPaper, path: &str, line: Option<u32>, text: &str,
) -> ProjectSearchResult {
    ProjectSearchResult {
        kind: "paper".to_string(),
        path: path.to_string(),
        title: paper.title.clone(),
        snippet: truncate_chars(text.trim(), 180),
        line,
        arxiv_id: (!paper.arxiv_id.is_empty()).then(|| paper.arxiv_id.clone()),
        file_kind: None,
    }
}

/// Every word of the query as a substring of one line, papers in library
/// order: what answered before the index, kept for when it cannot.
fn scan_matches(
    root: &Path, entries: &[LibraryPaper], terms: &[String], limits: Limits,
) -> Vec<PaperTextMatch> {
    let mut found = Vec::new();
    for paper in indexed_papers(root, entries) {
        let title_match = project::matches_search(&paper.title, terms);
        let mut hits = Vec::new();
        let mut matched = false;
        for file in &paper.files {
            let content = fs::read_to_string(&file.absolute).unwrap_or_default();
            for (index, line) in content.lines().enumerate() {
                if line.trim().is_empty() || !project::matches_search(line, terms) {
                    continue;
                }
                matched = true;
                if hits.len() < limits.hits_per_paper {
                    let text = truncate_chars(line.trim(), 200);
                    hits.push(LineHit {
                        path: file.path.clone(),
                        line: index as u32 + 1,
                        text,
                        highlights: Vec::new(),
                    });
                }
            }
        }
        if title_match || matched {
            found.push(PaperTextMatch { key: paper.key, title_match, hits });
        }
        if found.len() >= limits.papers {
            break;
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::test_support::TestProject;

    const ATTENTION_BIB: &str = "@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  eprint = {1706.03762}\n}\n";
    const ATTENTION_PAPER: &str = ".research/papers/1706.03762/paper.md";

    /// `search_library` reads the cached text itself so the agent gets line
    /// hits, and honors the same bibliography boundary as the listing.
    #[test]
    fn searches_cached_library_text_but_not_uncited_caches() {
        let project = TestProject::new(ATTENTION_BIB);
        project.write(
            ATTENTION_PAPER,
            "Title: Attention Is All You Need\n\nThe scaled dot-product attention mechanism.\n",
        );
        project.write(
            ".research/papers/1706.03762/blog.md",
            "# Overview\n\nA residual stream explanation for practitioners.\n",
        );
        // An uncited cache mentioning the same phrase must stay invisible.
        project
            .write(".research/papers/2401.00001/paper.md", "Another scaled dot-product variant.\n");

        let hits = search_library(&project.root, "scaled dot-product").unwrap();
        assert_eq!(hits.len(), 1, "got: {hits:?}");
        assert_eq!(hits[0].path, ATTENTION_PAPER);
        assert_eq!(hits[0].line, Some(3));
        assert!(hits[0].snippet.contains("scaled dot-product"));

        let blog_hits = search_library(&project.root, "residual stream").unwrap();
        assert_eq!(blog_hits.len(), 1, "got: {blog_hits:?}");
        assert_eq!(blog_hits[0].path, ".research/papers/1706.03762/blog.md");
        assert_eq!(blog_hits[0].line, Some(3));

        // A title match reports the readable file without a line number.
        let title_hits = search_library(&project.root, "attention is all you need").unwrap();
        assert!(title_hits.iter().any(|hit| hit.line.is_none()), "got: {title_hits:?}");
    }

    /// The panel gets papers with their lines; the scan that stands in for an
    /// unusable index finds the same lines.
    #[test]
    fn groups_panel_hits_by_paper_and_scans_when_the_index_is_unusable() {
        let project = TestProject::new(ATTENTION_BIB);
        project.write(
            ATTENTION_PAPER,
            "Title: Attention Is All You Need\n\nThe scaled dot-product attention mechanism.\n",
        );
        let found = search_library_text(&project.root, "dot-product").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].key.as_str(), found[0].hits[0].line), ("1706.03762", 3));
        assert!(!found[0].hits[0].highlights.is_empty());

        let entries = library_entries(&project.root).unwrap();
        let scanned = scan_matches(
            &project.root,
            &entries,
            &project::search_terms("dot-product"),
            PANEL_LIMITS,
        );
        assert_eq!((scanned[0].key.as_str(), scanned[0].hits[0].line), ("1706.03762", 3));
    }
}
