//! Adding a work to the bibliography, with its full text when it can be had.
//!
//! Every kind of input (arXiv id, DOI, URL, title, BibTeX) resolves through
//! the same path; the arXiv and webpage branches exist because those sources
//! can also bring a full text. A work without one is still a full citation,
//! and the writer may ask for the citation alone (`FullText::Skip`): then
//! only the metadata is resolved, and nothing is downloaded or converted.
//!
//! Resolving (the network) and committing (the file) are separate steps, so
//! several imports can resolve at once: each merges into the bibliography as
//! it is when it commits, one at a time (`commit_merged`).
//!
//! `progress` receives a stage id ("resolving", "fulltext", "overview")
//! whenever the pipeline enters a network-bound step, so the UI can say what
//! the spinner is waiting on. The agent path and tests pass a no-op.

use super::bibliography::{
    bibcite_report_field, commit_merged, run_bibcite_input, HistoryMode, MergedText,
};
use super::bundle::{fetch_arxiv_bundle, fetch_web_bundle, is_pdf_url};
use super::citation::{
    official_arxiv_citation, resolve_arxiv_title, unused_key, validate_resolved_identity,
    verify_title_citation,
};
use super::ids::{
    arxiv_base_id, explicit_arxiv_id, parse_arxiv_id, same_arxiv_work, validate_arxiv_id,
};
use super::is_web_url;
use super::web_citation::{
    alphaxiv_bibtex, merge_supplied_bibtex, resolve_web_citation, WebCitation,
};
use crate::papers::ImportResult;
use crate::util::err;
use crate::{alphaxiv, project};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

/// The JSON report an import returns, in bibcite's shape.
pub(super) fn import_report(key: &str, source: &str, action: &str) -> String {
    json!({"key": key, "source": source, "action": action}).to_string()
}

/// An import the user stopped before any citation was committed.
pub(super) fn cancelled(title: &str) -> ImportResult {
    ImportResult {
        arxiv_id: String::new(),
        title: title.to_string(),
        paper_path: String::new(),
        citation_key: None,
        citation_output: String::new(),
        already_imported: false,
        fetch_error: None,
        cancelled: true,
    }
}

/// Whether an import also saves the work's full text (its Markdown and the
/// overview) or adds only the citation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FullText {
    Save,
    Skip,
}

/// Resolve a citation and, with `FullText::Save`, attach full text when its
/// source is supported.
pub fn import_reference(
    root: &Path, query: &str, history: HistoryMode, full_text: FullText, progress: &dyn Fn(&str),
    cancel: &AtomicBool,
) -> Result<ImportResult, String> {
    let manifest = &project::read_manifest(root)?;
    // A numeric AlphaXiv URL is still an arXiv work and should retain the
    // semantic HTML/source conversion and existing arXiv cache identity.
    let arxiv_url = alphaxiv::paper_id_from_url(query.trim())
        .filter(|id| validate_arxiv_id(id).is_ok())
        .map(|id| format!("https://arxiv.org/abs/{id}"));
    let query = arxiv_url.as_deref().unwrap_or(query.trim());
    if query.is_empty() {
        return Err("Enter an arXiv id, a DOI, a URL, or a paper title.".to_string());
    }
    if cancel.load(Ordering::Acquire) {
        return Ok(cancelled(query));
    }
    let bibliography_path = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = if bibliography_path.exists() {
        fs::read_to_string(&bibliography_path).map_err(err)?
    } else {
        String::new()
    };
    if let Some(result) =
        import_existing_arxiv_citation(root, &before, query, full_text, progress, cancel)
    {
        return Ok(result);
    }
    // A bare PDF is its own only source of metadata: its citation is read
    // from its text, so it is converted whatever `full_text` asks.
    if is_pdf_url(query) && alphaxiv::paper_id_from_url(query).is_none() {
        return super::import_pdf::import_pdf_citation(
            root, manifest, query, history, progress, cancel,
        );
    }

    progress("resolving");
    let bibcite_query = bibcite_query_for_input(query, &resolve_arxiv_title);
    let preferred_arxiv = explicit_arxiv_id(&bibcite_query);
    // Sources that supply their own citation: a webpage's citation block or
    // metadata, or alphaXiv's suggested entry for an exact title.
    let mut web_error = None;
    let supplied = if preferred_arxiv.is_some()
        || project::normalize_doi(query).is_some()
        || query.starts_with('@')
    {
        None
    } else if is_web_url(query) {
        resolve_web_citation(query).unwrap_or_else(|error| {
            web_error = Some(error);
            None
        })
    } else if query.split_whitespace().count() >= 3 {
        let paper = alphaxiv::resolve_title(query).ok().flatten();
        let bibtex = paper.and_then(|paper| alphaxiv_bibtex(&paper).ok());
        bibtex.map(|bibtex| WebCitation { bibtex, page: None })
    } else {
        None
    };
    if cancel.load(Ordering::Acquire) {
        return Ok(cancelled(query));
    }
    let mut rendered_page = None;
    let resolution = if let Some(citation) = supplied {
        rendered_page = citation.page;
        Resolved::Supplied(citation.bibtex)
    } else {
        let resolution = match resolve_citation(&bibcite_query, cancel) {
            Ok(resolution) => resolution,
            Err(_) if cancel.load(Ordering::Acquire) => return Ok(cancelled(query)),
            Err(error) => {
                return Err(match &web_error {
                    Some(web_error) => format!("{web_error}\n{error}"),
                    None => error,
                })
            }
        };
        // DOI and other scholarly resolvers may succeed despite blocked HTML.
        // A generic webpage fallback must not resurrect a rejected app-shell title.
        if resolution.source() == Some("webpage") {
            if let Some(error) = web_error {
                return Err(error);
            }
        }
        resolution
    };
    if cancel.load(Ordering::Acquire) {
        return Ok(cancelled(query));
    }
    // The bibliography is the deliverable; the fetched text is enrichment.
    // Commit it before attempting any download: a work whose text cannot be
    // fetched (no HTML rendering, network trouble) is still a full citation,
    // and failing the import after bibcite already resolved the entry threw
    // the user's citation away over a download problem.
    let merged = commit_merged(root, &manifest.primary_bibliography, history, &|before| {
        resolution.merge(before)
    })?;
    let citation_key = merged.key;
    let citation_output = resolution.report(&citation_key, merged.existed);
    // Whether the work was already cited, asked of the bibliography rather
    // than of the file's bytes: bibcite may tidy an entry it decides to keep,
    // and a reformat is not a new reference.
    let already_imported = project::parse_bibliography(&merged.before)
        .iter()
        .any(|entry| entry.key.eq_ignore_ascii_case(&citation_key));
    let resolved_entry = project::parse_bibliography(&merged.after)
        .into_iter()
        .find(|entry| entry.key.eq_ignore_ascii_case(&citation_key))
        .ok_or_else(|| "bibcite reported a key absent from its bibliography.".to_string())?;
    let title = super::title_or_key(resolved_entry.title.clone(), &citation_key);
    // bibcite deliberately preserves an existing entry verbatim. If that old
    // record came from OpenReview without an eprint, retain the arXiv identity
    // found from the title so re-importing repairs the missing full text too.
    let resolved_arxiv = resolved_entry.arxiv_id.or(preferred_arxiv);
    let resolved = ImportResult {
        arxiv_id: resolved_arxiv.clone().unwrap_or_default(),
        citation_output,
        already_imported,
        cancelled: false,
        ..cancelled(&title)
    };
    let resolved = ImportResult { citation_key: Some(citation_key), ..resolved };
    if full_text == FullText::Skip || cancel.load(Ordering::Acquire) {
        return Ok(ImportResult { cancelled: cancel.load(Ordering::Acquire), ..resolved });
    }
    // A DOI/title may resolve to an entry carrying an arXiv eprint. Attach its
    // cache only after bibcite has told us the identity; fetching never edits
    // the bibliography itself.
    let fetched = match resolved_arxiv.as_deref() {
        Some(id) => Some(fetch_arxiv_bundle(root, id, progress, cancel)),
        // bibcite classifies what it resolved; only an actual webpage gets
        // scraped. A DOI'd journal article also carries a `url`, but that is
        // a publisher landing page — paywall chrome, not the work — and every
        // scrape spends shared Firecrawl quota.
        None if bibcite_report_field(&resolved.citation_output, "source").as_deref()
            == Some("webpage") =>
        {
            let entry_url = resolved_entry.url.as_deref().filter(|url| is_web_url(url));
            entry_url.or(Some(query).filter(|typed| is_web_url(typed))).map(|page_url| {
                progress("fulltext");
                fetch_web_bundle(root, page_url, rendered_page, cancel)
            })
        }
        None => None,
    };
    let fetch_error = fetched.as_ref().and_then(|fetched| fetched.as_ref().err().cloned());
    let fetched = fetched.and_then(Result::ok);
    Ok(ImportResult {
        // The fetched bundle's key when there is one — for a webpage that is
        // the digest id, which is what the UI needs to open and share it.
        arxiv_id: fetched
            .as_ref()
            .map(|item| item.arxiv_id.clone())
            .or(resolved_arxiv)
            .unwrap_or_default(),
        paper_path: fetched.map(|item| item.paper_path).unwrap_or_default(),
        fetch_error,
        cancelled: cancel.load(Ordering::Acquire),
        ..resolved
    })
}

/// An explicit arXiv import can be joined to an existing citation without
/// asking bibcite to resolve it again. Match only the bibliography's recorded
/// arXiv identity: titles are intentionally excluded because this path must
/// never guess that two works are the same.
fn existing_explicit_arxiv_citation(
    bibliography: &str, query: &str,
) -> Option<(String, String, String)> {
    let requested = explicit_arxiv_id(query)?;
    let base = arxiv_base_id(&requested);
    project::parse_bibliography(bibliography)
        .into_iter()
        .find(|entry| entry.arxiv_id.as_deref().is_some_and(|cited| same_arxiv_work(cited, base)))
        .map(|entry| (base.to_string(), entry.key, entry.title))
}

fn import_existing_arxiv_citation(
    root: &Path, bibliography: &str, query: &str, full_text: FullText, progress: &dyn Fn(&str),
    cancel: &AtomicBool,
) -> Option<ImportResult> {
    let (arxiv_id, citation_key, entry_title) =
        existing_explicit_arxiv_citation(bibliography, query)?;
    let citation_output = import_report(&citation_key, "arxiv", "already-present");
    let title = super::title_or_key(entry_title, &citation_key);
    if full_text == FullText::Skip {
        return Some(ImportResult {
            arxiv_id,
            citation_key: Some(citation_key),
            citation_output,
            already_imported: true,
            cancelled: false,
            ..cancelled(&title)
        });
    }
    // Ask for the canonical id so any complete bundle for another version is
    // reusable. If the bundle is absent or incomplete, the normal fetch path
    // repairs it without allowing bibcite to rewrite the existing entry.
    let fetched = fetch_arxiv_bundle(root, &arxiv_id, progress, cancel);
    Some(ImportResult {
        arxiv_id,
        title,
        paper_path: fetched.as_ref().map(|item| item.paper_path.clone()).unwrap_or_default(),
        citation_key: Some(citation_key),
        citation_output,
        already_imported: true,
        fetch_error: fetched.err(),
        cancelled: cancel.load(Ordering::Acquire),
    })
}

/// Prefer an arXiv identity for a title before asking bibcite to choose the
/// canonical publication record. Published DBLP/OpenReview records often omit
/// their preprint id; once bibcite writes that record there is no reliable way
/// to join a downloaded arXiv bundle back to it. Resolving the title first lets
/// bibcite keep the published venue while carrying `eprint` and the arXiv URL.
fn bibcite_query_for_input(
    query: &str, resolver: &dyn Fn(&str) -> Result<Option<String>, String>,
) -> String {
    if is_web_url(query) || query.trim_start().starts_with('@') {
        return query.to_string();
    }
    // bibcite's URL resolver recognizes arXiv reliably, while its free-text
    // resolver can reject a bare id such as `2609.01607`. Give direct ids the
    // canonical URL shape without changing DOI and short-title queries.
    if parse_arxiv_id(query).as_deref() == Some(query.trim()) {
        return format!("https://arxiv.org/abs/{}", query.trim());
    }
    if query.split_whitespace().count() < 3 {
        return query.to_string();
    }
    match resolver(query) {
        Ok(Some(arxiv_id)) => format!("https://arxiv.org/abs/{}", arxiv_base_id(&arxiv_id)),
        Ok(None) => query.to_string(),
        Err(error) => {
            // arXiv lookup is enrichment. A transient API failure must not
            // prevent bibcite from adding a DOI, book, or web-only work.
            log::debug!(
                target: "lattice::literature",
                "arXiv title lookup failed; falling back to bibcite: {error}"
            );
            query.to_string()
        }
    }
}

/// A resolved work, not yet merged: it merges into the bibliography as it is
/// when the import commits, which may be after other imports committed.
enum Resolved {
    /// A webpage's or alphaXiv's own entry, kept field for field.
    Supplied(String),
    /// The one entry a resolver (or a supplied snapshot) gave, its key, and
    /// the report it came with.
    Entry { raw: String, key: String, report: Value },
}

impl Resolved {
    /// The merged bibliography, the entry's key, and whether it already existed.
    fn merge(&self, before: &str) -> Result<MergedText, String> {
        match self {
            Self::Supplied(bibtex) => merge_supplied_bibtex(before, bibtex),
            Self::Entry { raw, key, .. } => merge_resolved_citation(before, raw, key),
        }
    }

    /// What resolved it: "arxiv", "doi", "webpage", ….
    fn source(&self) -> Option<&str> {
        match self {
            Self::Supplied(_) => Some("webpage"),
            Self::Entry { report, .. } => report["source"].as_str(),
        }
    }

    /// The bibcite-style JSON report for the entry as merged under `key`.
    fn report(&self, key: &str, existed: bool) -> String {
        let action = if existed { "exists" } else { "added" };
        match self {
            Self::Supplied(_) => import_report(key, "webpage", action),
            Self::Entry { report, .. } => {
                let mut report = report.clone();
                report["key"] = Value::String(key.into());
                report["action"] = Value::String(action.into());
                report.to_string()
            }
        }
    }
}

/// Resolve `query` to exactly one checked entry, touching no bibliography.
fn resolve_citation(query: &str, cancel: &AtomicBool) -> Result<Resolved, String> {
    if query.trim_start().starts_with('@') {
        // A chosen record keeps its identity; its fields are only verified.
        validate_resolved_identity("", query)?;
        let raw = crate::citation_audit::prepare_supplied(query);
        let mut entries = project::parse_bibliography(&raw);
        if entries.is_empty() {
            return Err("Invalid citation entry.".into());
        }
        let entry = entries.remove(0);
        let webpage = entry.url.as_deref().is_some_and(|url| {
            is_web_url(url)
                && project::normalize_doi(url).is_none()
                && (entry.doi.is_none()
                    || is_pdf_url(url)
                    || alphaxiv::paper_id_from_url(url).is_some())
        });
        let source = if webpage { "webpage" } else { "bibtex" };
        let report = json!({"key": entry.key, "source": source, "action": "added"});
        return Ok(Resolved::Entry { raw, key: entry.key, report });
    }
    // Never give bibcite existing entries: its fuzzy upsert can overwrite a
    // different paper while retaining the old key used in the manuscript.
    let scratch = std::env::temp_dir().join(format!("lattice-cite-{}.bib", Uuid::new_v4()));
    let result = (|| {
        let output = if let Some(raw) = official_arxiv_citation(query)? {
            let key = project::parse_bibliography(&raw)[0].key.clone();
            fs::write(&scratch, raw).map_err(err)?;
            import_report(&key, "arxiv", "added")
        } else {
            run_bibcite_input(&scratch, query, false, cancel)?
        };
        let bibliography = fs::read_to_string(&scratch).map_err(err)?;
        let bibliography = crate::citation_audit::prepare_import(&bibliography)?;
        let key = bibcite_report_field(&output, "key")
            .ok_or_else(|| "bibcite did not return a citation key.".to_string())?;
        validate_resolved_identity(query, &bibliography)?;
        verify_title_citation(query, &bibliography)?;
        let report: Value = serde_json::from_str(&output).map_err(err)?;
        Ok(Resolved::Entry { raw: bibliography, key, report })
    })();
    let _ = fs::remove_file(scratch);
    result
}

/// Resolve `query` into the bibliography at `path`, returning a bibcite-style
/// JSON report.
#[cfg(test)]
fn add_citation(path: &Path, query: &str, cancel: &AtomicBool) -> Result<String, String> {
    let resolved = resolve_citation(query, cancel)?;
    let before = fs::read_to_string(path).map_err(err)?;
    let (merged, key, exists) = resolved.merge(&before)?;
    fs::write(path, merged).map_err(err)?;
    Ok(resolved.report(&key, exists))
}

/// Preserve existing entries byte-for-byte; a metadata update is a separate,
/// reviewed operation, never a side effect of adding a reference. Returns the
/// new bibliography, the entry's key, and whether it already existed.
fn merge_resolved_citation(
    before: &str, raw: &str, key: &str,
) -> Result<(String, String, bool), String> {
    let incoming = project::parse_bibliography(raw);
    if incoming.len() != 1 || incoming[0].key != key {
        return Err(
            "Citation resolution must return exactly one entry with its reported key.".into()
        );
    }
    let incoming = &incoming[0];
    let entries = project::parse_bibliography(before);
    let spans = project::bibliography_entry_spans(before);
    let mut keys = std::collections::HashSet::new();
    if entries.iter().any(|entry| !keys.insert(entry.key.to_ascii_lowercase())) {
        return Err("The bibliography already contains duplicate citation keys. Resolve them before importing.".into());
    }
    let doi_of = |entry: &crate::models::CitationInfo| {
        entry.doi.clone().or_else(|| entry.url.as_deref().and_then(project::normalize_doi))
    };
    let incoming_doi = doi_of(incoming);
    let mut matches = Vec::new();
    for entry in &entries {
        let same_id = entry
            .arxiv_id
            .as_deref()
            .zip(incoming.arxiv_id.as_deref())
            .is_some_and(|(a, b)| same_arxiv_work(a, b))
            || doi_of(entry).zip(incoming_doi.as_ref()).is_some_and(|(a, b)| a == *b);
        let (_, start, end) = spans
            .iter()
            .find(|(key, _, _)| key == &entry.key)
            .ok_or_else(|| "Invalid existing bibliography entry.".to_string())?;
        let existing = &before[*start..*end];
        let same_metadata = !entry.title.trim().is_empty()
            && validate_resolved_identity("", existing).is_ok()
            && crate::citation_audit::metadata_identity_matches(existing, raw.trim());
        if same_id && !same_metadata {
            return Err(format!("Citation '{}' has the same identifier but conflicting metadata. Review it before importing.", entry.key));
        }
        if same_metadata && (same_id || entry.year == incoming.year) {
            matches.push(entry);
        }
    }
    if matches.len() > 1 {
        return Err("Multiple existing citations match this paper. Resolve the duplicates before importing.".into());
    }
    if let Some(existing) = matches.first() {
        return Ok((before.to_string(), existing.key.clone(), true));
    }
    let new_key = unused_key(&entries, key);
    let protected = crate::citation_audit::protect_bibtex(raw.trim());
    let raw = protected.as_str();
    let opening = raw.find(['{', '(']).ok_or("Invalid citation entry.")?;
    let comma = raw.find(',').ok_or("Invalid citation key.")?;
    Ok((format!("{before}\n{}{}{}\n", &raw[..opening + 1], new_key, &raw[comma..]), new_key, false))
}

#[cfg(test)]
mod tests;
