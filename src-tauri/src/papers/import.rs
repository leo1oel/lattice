//! Adding a work to the bibliography, with its full text when it can be had.
//!
//! Every kind of input (arXiv id, DOI, URL, title, BibTeX) resolves through
//! the same path; the arXiv and webpage branches exist because those sources
//! can also bring a full text. A work without one is still a full citation.
//!
//! `progress` receives a stage id ("resolving", "fulltext", "overview")
//! whenever the pipeline enters a network-bound step, so the UI can say what
//! the spinner is waiting on. The agent path and tests pass a no-op.

use super::bibliography::{
    bibcite_report_field, commit_bibliography, run_bibcite_input, HistoryMode, ScratchBibliography,
};
use super::bundle::{fetch_arxiv_bundle, fetch_web_bundle, is_pdf_url, PaperMetadata};
use super::citation::{
    official_arxiv_citation, resolve_arxiv_title, unused_key, validate_resolved_identity,
    verify_title_citation,
};
use super::ids::{
    arxiv_base_id, explicit_arxiv_id, parse_arxiv_id, same_arxiv_work, validate_arxiv_id,
};
use super::is_web_url;
use super::web_citation::{
    alphaxiv_bibtex, merge_supplied_bibtex, pdf_citation_bibtex, resolve_web_citation, WebCitation,
};
use crate::models::ProjectManifest;
use crate::papers::ImportResult;
use crate::util::err;
use crate::web_metadata::bib_url;
use crate::{alphaxiv, project};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

/// The JSON report an import returns, in bibcite's shape.
fn import_report(key: &str, source: &str, action: &str) -> String {
    json!({"key": key, "source": source, "action": action}).to_string()
}

/// An import the user stopped before any citation was committed.
fn cancelled(title: &str) -> ImportResult {
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

/// Resolve a citation and attach full text when its source is supported.
pub fn import_reference(
    root: &Path, query: &str, history: HistoryMode, progress: &dyn Fn(&str), cancel: &AtomicBool,
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
    if let Some(result) = import_existing_arxiv_citation(root, &before, query, progress, cancel) {
        return Ok(result);
    }
    if is_pdf_url(query) && alphaxiv::paper_id_from_url(query).is_none() {
        return import_pdf_citation(root, manifest, query, &before, history, progress, cancel);
    }
    let scratch = ScratchBibliography::new("research-writer-cite", Some(&before))?;

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
    let citation_output = if let Some(citation) = supplied {
        rendered_page = citation.page;
        let (bibliography, key, already_imported) =
            merge_supplied_bibtex(&before, &citation.bibtex)?;
        fs::write(&scratch.path, bibliography).map_err(err)?;
        import_report(&key, "webpage", if already_imported { "exists" } else { "added" })
    } else {
        let output = match add_citation(&scratch.path, &bibcite_query, cancel) {
            Ok(output) => output,
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
        if bibcite_report_field(&output, "source").as_deref() == Some("webpage") {
            if let Some(error) = web_error {
                return Err(error);
            }
        }
        output
    };
    let bibliography = scratch.read()?;
    let citation_key = bibcite_report_field(&citation_output, "key")
        .ok_or_else(|| "bibcite did not return a citation key.".to_string())?;
    // Whether the work was already cited, asked of the bibliography rather
    // than of the file's bytes: bibcite may tidy an entry it decides to keep,
    // and a reformat is not a new reference.
    let already_imported = project::parse_bibliography(&before)
        .iter()
        .any(|entry| entry.key.eq_ignore_ascii_case(&citation_key));
    let resolved_entry = project::parse_bibliography(&bibliography)
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
        ..cancelled(&title)
    };
    if cancel.load(Ordering::Acquire) {
        return Ok(resolved);
    }
    // The bibliography is the deliverable; the fetched text is enrichment.
    // Commit it before attempting any download: a work whose text cannot be
    // fetched (no HTML rendering, network trouble) is still a full citation,
    // and failing the import after bibcite already resolved the entry threw
    // the user's citation away over a download problem.
    if bibliography != before {
        if fs::read_to_string(&bibliography_path).unwrap_or_default() != before {
            return Err(
                "The bibliography changed while resolving the citation. Retry the import.".into()
            );
        }
        let label = format!("Cite {citation_key}");
        commit_bibliography(root, &manifest.primary_bibliography, &bibliography, &label, history)?;
    }
    let resolved = ImportResult { citation_key: Some(citation_key), ..resolved };
    if cancel.load(Ordering::Acquire) {
        return Ok(resolved);
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
    root: &Path, bibliography: &str, query: &str, progress: &dyn Fn(&str), cancel: &AtomicBool,
) -> Option<ImportResult> {
    let (arxiv_id, citation_key, entry_title) =
        existing_explicit_arxiv_citation(bibliography, query)?;
    // Ask for the canonical id so any complete bundle for another version is
    // reusable. If the bundle is absent or incomplete, the normal fetch path
    // repairs it without allowing bibcite to rewrite the existing entry.
    let fetched = fetch_arxiv_bundle(root, &arxiv_id, progress, cancel);
    let citation_output = import_report(&citation_key, "arxiv", "already-present");
    Some(ImportResult {
        arxiv_id,
        title: super::title_or_key(entry_title, &citation_key),
        paper_path: fetched.as_ref().map(|item| item.paper_path.clone()).unwrap_or_default(),
        citation_key: Some(citation_key),
        citation_output,
        already_imported: true,
        fetch_error: fetched.err(),
        cancelled: cancel.load(Ordering::Acquire),
    })
}

/// Import the report itself, enriching its citation from explicitly supplied
/// metadata rather than treating a binary URL as an HTML webpage.
fn import_pdf_citation(
    root: &Path, manifest: &ProjectManifest, url: &str, before: &str, history: HistoryMode,
    progress: &dyn Fn(&str), cancel: &AtomicBool,
) -> Result<ImportResult, String> {
    progress("fulltext");
    let url = bib_url(url);
    let fetched = match fetch_web_bundle(root, &url, None, cancel) {
        Ok(fetched) => fetched,
        Err(_) if cancel.load(Ordering::Acquire) => return Ok(cancelled(&url)),
        Err(error) => return Err(error),
    };
    let metadata_path =
        project::safe_path(root, &format!(".research/papers/{}/metadata.json", fetched.arxiv_id))?;
    let metadata: PaperMetadata =
        serde_json::from_slice(&fs::read(metadata_path).map_err(err)?).map_err(err)?;
    let markdown =
        fs::read_to_string(project::safe_path(root, &fetched.paper_path)?).map_err(err)?;
    progress("resolving");
    let raw = pdf_citation_bibtex(&markdown, &metadata.title, &url);
    let (bibliography, key, already_imported) = merge_supplied_bibtex(before, &raw)?;
    let captured = ImportResult {
        arxiv_id: fetched.arxiv_id,
        paper_path: fetched.paper_path,
        ..cancelled(&metadata.title)
    };
    if cancel.load(Ordering::Acquire) {
        return Ok(captured);
    }
    if bibliography != before {
        let label = format!("Cite {key}");
        commit_bibliography(root, &manifest.primary_bibliography, &bibliography, &label, history)?;
    }
    Ok(ImportResult {
        citation_output: import_report(
            &key,
            "pdf",
            if already_imported { "already-present" } else { "added" },
        ),
        citation_key: Some(key),
        already_imported,
        cancelled: false,
        ..captured
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

/// Resolve `query` into the bibliography at `path`, returning a bibcite-style
/// JSON report.
fn add_citation(path: &Path, query: &str, cancel: &AtomicBool) -> Result<String, String> {
    let before = fs::read_to_string(path).map_err(err)?;
    if query.trim_start().starts_with('@') {
        // The title resolver (or the user's review) already chose this exact
        // record. Keep its fields and identity; no second network resolution.
        validate_resolved_identity("", query)?;
        let entry = project::parse_bibliography(query).remove(0);
        let webpage = entry.url.as_deref().is_some_and(|url| {
            is_web_url(url)
                && project::normalize_doi(url).is_none()
                && (entry.doi.is_none()
                    || is_pdf_url(url)
                    || alphaxiv::paper_id_from_url(url).is_some())
        });
        let source = if webpage { "webpage" } else { "bibtex" };
        let (merged, key, exists) = merge_resolved_citation(&before, query, &entry.key)?;
        fs::write(path, merged).map_err(err)?;
        return Ok(import_report(&key, source, if exists { "exists" } else { "added" }));
    }
    // Never give bibcite existing entries: its fuzzy upsert can overwrite a
    // different paper while retaining the old key used in the manuscript.
    let isolated = path.with_extension(format!("{}.bib", Uuid::new_v4()));
    let result = (|| {
        let output = if let Some(raw) = official_arxiv_citation(query)? {
            let key = project::parse_bibliography(&raw)[0].key.clone();
            fs::write(&isolated, raw).map_err(err)?;
            import_report(&key, "arxiv", "added")
        } else {
            run_bibcite_input(&isolated, query, false, cancel)?
        };
        let bibliography = fs::read_to_string(&isolated).map_err(err)?;
        let bibliography = crate::citation_audit::prepare_import(&bibliography)?;
        let key = bibcite_report_field(&output, "key")
            .ok_or_else(|| "bibcite did not return a citation key.".to_string())?;
        validate_resolved_identity(query, &bibliography)?;
        verify_title_citation(query, &bibliography)?;
        let (merged, new_key, exists) = merge_resolved_citation(&before, &bibliography, &key)?;
        fs::write(path, merged).map_err(err)?;
        let mut report: Value = serde_json::from_str(&output).map_err(err)?;
        report["key"] = Value::String(new_key);
        report["action"] = Value::String(if exists { "exists" } else { "added" }.into());
        report["file"] = json!(path);
        Ok(report.to_string())
    })();
    let _ = fs::remove_file(isolated);
    result
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
mod tests {
    use super::*;
    use crate::commands;
    use crate::papers::library::{list_papers, read_paper, read_paper_blog_local};
    #[cfg(unix)]
    use crate::papers::test_support::{
        fake_bibcite, fake_raw_bibcite, tool_lock, write_test_tool, ToolOverride,
    };
    use crate::papers::test_support::{serve_once, TestProject};

    fn import(root: &Path, input: &str) -> Result<ImportResult, String> {
        import_reference(root, input, HistoryMode::Record, &|_| {}, &AtomicBool::new(false))
    }

    #[test]
    fn title_imports_prefer_a_resolved_arxiv_id_but_other_queries_fall_back() {
        let title = "A Single Transformer for Scalable Vision-Language Modeling";
        let resolved = bibcite_query_for_input(title, &|query| {
            assert_eq!(query, title);
            Ok(Some("2407.06438v3".to_string()))
        });
        assert_eq!(resolved, "https://arxiv.org/abs/2407.06438");
        assert_eq!(bibcite_query_for_input(title, &|_| Err("offline".to_string())), title);
        // URLs go straight to bibcite, and direct (also legacy) arXiv ids take
        // the URL shape its resolver recognizes, all without a title search.
        for (query, expected) in [
            (
                "https://openreview.net/forum?id=nuzFG0Rbhy",
                "https://openreview.net/forum?id=nuzFG0Rbhy",
            ),
            ("2609.01607", "https://arxiv.org/abs/2609.01607"),
            ("cs/9901002v1", "https://arxiv.org/abs/cs/9901002v1"),
        ] {
            let resolved =
                bibcite_query_for_input(query, &|_| panic!("{query} ran the title resolver"));
            assert_eq!(resolved, expected);
        }
    }

    #[test]
    fn duplicate_arxiv_detection_uses_canonical_identity_only() {
        let bibliography = concat!(
            "@article{existingKey, title={Exact paper}, eprint={2609.01147v2}}\n",
            "@article{sameTitle, title={A tempting title match}}\n",
        );
        assert_eq!(
            existing_explicit_arxiv_citation(bibliography, "https://arxiv.org/pdf/2609.01147v5"),
            Some(("2609.01147".to_string(), "existingKey".to_string(), "Exact paper".to_string()))
        );
        for query in [
            "2609.01148",
            "A tempting title match",
            "https://example.org/2609.01147",
            "A study of 2609.01147",
        ] {
            assert_eq!(existing_explicit_arxiv_citation(bibliography, query), None, "{query}");
        }
    }

    /// Existing entries are kept byte for byte. An incoming record joins one
    /// only with the same full title and ordered authors plus the same year or
    /// identifier (a DOI URL counts); otherwise it is added under its own key,
    /// and a shared identifier with conflicting metadata needs review.
    #[test]
    fn merging_joins_only_the_same_work_and_never_rewrites_existing_entries() {
        let shared =
            "@misc{old,title={A Shared Title},author={Alice Smith and Bob Jones},year={2025}}";
        let incoming = shared.replace("{old,", "{new,");
        let ids = "@misc{old,title={Shared Title},author={Alice Smith},year={2025},eprint={2510.14979},doi={10.1234/a}}";
        let doi_url = "@article{old,title={Shared Title},author={Alice Smith},year={2025},url={https://doi.org/10.1234/a}}";
        let doi =
            "@article{new,title={Shared Title},author={Alice Smith},year={2025},doi={10.1234/a}}";
        let other_ids = ids.replace("{old,", "{new,").replace("2510.14979", "2605.28820");
        let mut cases = vec![
            (shared, incoming.clone(), true),
            (doi_url, doi.to_string(), true),
            (doi_url, doi.replace("10.1234/a", "10.1234/b"), false),
            (ids, other_ids.replace("10.1234/a", "10.1234/b"), false),
        ];
        for changed in [
            incoming.replace("Shared", "Similar"),
            incoming.replace("Alice", "Ann"),
            incoming.replace("Bob Jones", "Carol Doe"),
            incoming.replace("Alice Smith and Bob Jones", "Bob Jones and Alice Smith"),
            incoming.replace("Alice Smith and Bob Jones", "Alice Smith and others"),
            incoming.replace("2025", "2024"),
        ] {
            cases.push((shared, changed, false));
        }
        for (before, raw, joined) in cases {
            let (merged, key, exists) = merge_resolved_citation(before, &raw, "new").unwrap();
            assert_eq!(exists, joined, "{raw}");
            if joined {
                assert_eq!((merged.as_str(), key.as_str()), (before, "old"));
            } else {
                assert_eq!(key, "new");
                assert!(merged.starts_with(before));
                assert_eq!(project::parse_bibliography(&merged).len(), 2);
            }
        }
        for (before, raw) in [
            (ids.to_string(), ids.replace("{old,", "{new,").replace("Alice", "Bob")),
            (doi_url.to_string(), doi.replace("Alice", "Bob")),
            (doi_url.replace("Shared Title", ""), doi.to_string()),
        ] {
            assert!(merge_resolved_citation(&before, &raw, "new").is_err(), "{before}\n{raw}");
        }
        // A new work whose key is taken gets a suffixed one.
        let different = shared.replace("Shared", "Different");
        assert_eq!(merge_resolved_citation(shared, &different, "old").unwrap().1, "old-2");
        assert!(crate::citation_audit::metadata_identity_matches(doi_url, doi));
        let other_doi = doi.replace("10.1234/a", "10.1234/b");
        assert!(!crate::citation_audit::metadata_identity_matches(doi_url, &other_doi));
    }

    #[test]
    fn resolved_snapshot_skips_search_and_preserves_metadata() {
        let raw = "@article{chosen, title={A Verified Study}, author={Smith, Ada}, year={2026}, doi={10.1234/chosen}, url={https://doi.org/10.1234/chosen}, month={September}, note={Preserve {nested} details}}";
        let resolved =
            bibcite_query_for_input(raw, &|_| panic!("a resolved snapshot must not search again"));
        assert_eq!(resolved, raw);
        let before =
            "@misc{chosen, title={An unrelated work}, author={Other, Author}, year={2020}}\n";
        let project = TestProject::new(before);
        let imported = import(&project.root, raw).unwrap();
        assert_eq!(imported.citation_key.as_deref(), Some("chosen-2"));
        assert!(imported.fetch_error.is_none());
        assert!(imported.paper_path.is_empty());
        let bibliography = project.bibliography();
        assert!(bibliography.starts_with(before));
        assert!(bibliography.contains("month={September}"));
        assert!(bibliography.contains("note={Preserve {nested} details}"));
        let repeated = import(&project.root, raw).unwrap();
        assert!(repeated.already_imported);
        assert_eq!(repeated.citation_key, imported.citation_key);
        assert_eq!(project.bibliography(), bibliography);
        let path = project.root.join("references.bib");
        assert!(add_citation(&path, &format!("{raw}\n{raw}"), &AtomicBool::new(false)).is_err());
        // A snapshot of an alphaXiv work keeps its webpage download routing.
        let mimo = "@misc{mimo, title={MiMo report}, author={MiMo Team}, year={2026}, url={https://www.alphaxiv.org/abs/2609.mimo-scaling-reinforcement-learning}}";
        let report = add_citation(&path, mimo, &AtomicBool::new(false)).unwrap();
        assert_eq!(bibcite_report_field(&report, "source").as_deref(), Some("webpage"));
        assert_eq!(bibcite_report_field(&report, "key").as_deref(), Some("mimo"));
    }

    #[cfg(unix)]
    #[test]
    fn resolver_never_receives_existing_citations_or_controls_duplicate_keys() {
        let _lock = tool_lock();
        let parent = crate::test_support::TempDir::new("papers");
        // Also collide with the new paper's generated key: neither old entry
        // may be replaced, even when resolution in isolation succeeds.
        let before = concat!(
            "@misc{diao2026pixels, title={Native One-Vision Models}, eprint={2605.28820}}\n",
            "@misc{diao2025pixels, title={An unrelated citation}}\n",
        );
        let path = parent.write("references.bib", before);
        let tool = parent.join("bibcite");
        write_test_tool(&tool, concat!(
            "#!/bin/sh\nset -eu\n",
            "if grep -q diao2026pixels \"$3\" 2>/dev/null; then\n",
            "  echo '{\"key\":\"diao2026pixels\",\"action\":\"exists\",\"source\":\"arxiv\"}'\n",
            "else\n",
            "  echo '@misc{diao2025pixels, title={Native Vision-Language Primitives}, author={Haiwen Diao}, year={2025}, doi={10.1234/primitives}, eprint={2510.14979v2}}' > \"$3\"\n",
            "  echo '{\"key\":\"diao2025pixels\",\"action\":\"added\",\"source\":\"arxiv\"}'\n",
            "fi\n",
        ));
        let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);
        let output = add_citation(&path, "10.1234/primitives", &AtomicBool::new(false)).unwrap();
        let bibliography = fs::read_to_string(&path).unwrap();
        assert!(bibliography.starts_with(before));
        assert_eq!(bibcite_report_field(&output, "key").as_deref(), Some("diao2025pixels-2"));
        let entries = project::parse_bibliography(&bibliography);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[2].arxiv_id.as_deref(), Some("2510.14979v2"));
    }

    #[cfg(unix)]
    #[test]
    fn conflicting_doi_resolution_never_commits_a_different_paper() {
        let _lock = tool_lock();
        let before =
            "@misc{diao2026pixels, title={Native One-Vision Models}, eprint={2605.28820}}\n";
        let project = TestProject::new(before);
        let tool = project.parent.join("bibcite");
        write_test_tool(
            &tool,
            concat!(
                "#!/bin/sh\nset -eu\n",
                "echo '@misc{diao2026pixels, title={Wrong paper}, eprint={2605.28820}}' > \"$3\"\n",
                "echo '{\"key\":\"diao2026pixels\",\"source\":\"arxiv\"}'\n",
            ),
        );
        let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);
        let error = import(&project.root, "10.1234/requested").unwrap_err();
        assert!(error.contains("requested DOI 10.1234/requested"), "{error}");
        assert_eq!(project.bibliography(), before);
    }

    #[cfg(unix)]
    #[test]
    fn duplicate_pdf_url_reuses_complete_version_equivalent_cache_without_resolution() {
        let _lock = tool_lock();
        let bibliography =
            "@article{vaswani2017attention, title={Attention Is All You Need}, eprint={1706.03762v7}}\n";
        let project = TestProject::new(bibliography);
        let markdown = "Title: Attention Is All You Need\n";
        let title = "Attention Is All You Need".to_string();
        let converter = commands::ARXIV2MD.requirement;
        project.write_bundle(
            markdown,
            &PaperMetadata::new("1706.03762", "1706.03762v7", title, converter, "", "", markdown),
        );

        let bibcite = project.parent.join("bibcite-must-not-run");
        write_test_tool(&bibcite, "#!/bin/sh\nexit 91\n");
        let _bibcite = ToolOverride::set(&commands::BIBCITE, &bibcite);
        let stages = std::cell::RefCell::new(Vec::new());
        let result = import_reference(
            &project.root,
            "https://arxiv.org/pdf/1706.03762v3",
            HistoryMode::Record,
            &|stage| stages.borrow_mut().push(stage.to_string()),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(result.already_imported);
        assert_eq!(result.arxiv_id, "1706.03762");
        assert_eq!(result.citation_key.as_deref(), Some("vaswani2017attention"));
        assert_eq!(result.paper_path, ".research/papers/1706.03762/paper.md");
        assert!(stages.borrow().is_empty(), "got: {:?}", stages.borrow());
        assert_eq!(project.bibliography(), bibliography);
    }

    /// A download failure is a note on the citation, never its undoing: the
    /// entry must land in the bibliography exactly as it would for a work
    /// with no full text at all. Cancelling while resolving leaves nothing
    /// behind; cancelling once the full-text download starts keeps the
    /// committed citation and never runs the converter.
    #[cfg(unix)]
    #[test]
    fn a_committed_citation_survives_a_failed_or_cancelled_full_text_download() {
        let _lock = tool_lock();
        for (label, mode, cancel_stage, cited) in [
            ("download fails", HistoryMode::Defer, None, true),
            ("cancelled resolving", HistoryMode::Record, Some("resolving"), false),
            ("cancelled downloading", HistoryMode::Record, Some("fulltext"), true),
        ] {
            let project = TestProject::new("");
            let tools = &project.parent;
            let _bibcite = ToolOverride::set(&commands::BIBCITE, &fake_bibcite(tools));
            let converter = tools.join("converter");
            write_test_tool(
                &converter,
                "#!/bin/sh\ntouch \"$0.called\"\necho 'fixture conversion failure' >&2\nexit 1\n",
            );
            let _converter = ToolOverride::set(&commands::ARXIV2MD, &converter);
            let cancel = AtomicBool::new(false);
            let cancel_at = |reached: &str| {
                if Some(reached) == cancel_stage {
                    cancel.store(true, Ordering::Release);
                }
            };
            let result =
                import_reference(&project.root, "10.1234/example", mode, &cancel_at, &cancel)
                    .unwrap();
            assert_eq!(result.cancelled, cancel_stage.is_some(), "{label}");
            assert_eq!(result.citation_key.as_deref(), cited.then_some("stub2024"), "{label}");
            assert!(result.paper_path.is_empty(), "{label}");
            let bibliography = project.bibliography();
            assert_eq!(bibliography.contains("stub2024"), cited, "{label}");
            assert_eq!(bibliography.is_empty(), !cited, "{label}");
            if cancel_stage.is_some() {
                assert!(!tools.join("converter.called").exists(), "{label}");
            } else {
                assert_eq!(result.arxiv_id, "2401.99999");
                let error = result.fetch_error.expect("the failed download is reported");
                assert!(error.contains("fixture conversion failure"), "got: {error}");
            }
        }
    }

    /// A complete one-page PDF, with asymmetric title/body and enough text to
    /// distinguish successful conversion from an empty placeholder.
    fn one_page_pdf() -> Vec<u8> {
        let stream = format!(
            "BT /F1 22 Tf 50 750 Td (Direct PDF Study) Tj /F1 12 Tf {} ET",
            "0 -18 Td (Evidence from the imported report remains readable.) Tj ".repeat(8)
        );
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
        ];
        let mut pdf = "%PDF-1.4\n".to_string();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
        }
        let xref = pdf.len();
        pdf.push_str("xref\n0 6\n0000000000 65535 f \n");
        for offset in offsets {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"));
        pdf.into_bytes()
    }

    #[cfg(unix)]
    #[test]
    fn direct_pdf_import_creates_readable_citation_and_reuses_it_offline() {
        let _lock = tool_lock();
        let (url, server) = serve_once(one_page_pdf());
        // A key collision must preserve the unrelated citation verbatim.
        let key = "anonymousXXXXdirect";
        let before = format!("@article{{{key}, title={{Keep me}}, doi={{10.1234/existing}}}}\n");
        let project = TestProject::new(&before);
        let _bibcite = ToolOverride::set(&commands::BIBCITE, &fake_raw_bibcite(&project.parent));
        let imported = import(&project.root, &url).unwrap();
        server.join().unwrap();
        assert!(!imported.already_imported);
        assert_eq!(imported.citation_key.as_deref(), Some(format!("{key}-2").as_str()));
        let markdown = read_paper(&project.root, &imported.arxiv_id).unwrap();
        assert!(markdown.contains("Evidence from the imported report remains readable."));
        assert!(markdown.contains("pdf-text-layer"));
        let bibliography = project.bibliography();
        assert!(bibliography.starts_with(&before));
        let entries = project::parse_bibliography(&bibliography);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].url.as_deref(), Some(url.as_str()));
        let listed = list_papers(&project.root).unwrap();
        assert!(listed.iter().any(|paper| paper.arxiv_id == imported.arxiv_id
            && paper.has_full_text
            && !paper.has_blog));
        let again = import(&project.root, &url).unwrap();
        assert!(again.already_imported);
        assert_eq!(again.citation_key, imported.citation_key);
        assert_eq!(project.bibliography(), bibliography);
        // Only arXiv bundles may be joined by title. A generic PDF must not
        // get attached to a different citation just because titles coincide.
        project.write(
            "references.bib",
            &format!("@misc{{decoy, title={{{}}}}}\n{bibliography}", imported.title),
        );
        let listed = list_papers(&project.root).unwrap();
        let full_text = |key: Option<&str>| {
            listed.iter().find(|paper| paper.citation_key.as_deref() == key).unwrap().has_full_text
        };
        assert!(!full_text(Some("decoy")));
        assert!(full_text(imported.citation_key.as_deref()));
    }

    #[test]
    fn direct_pdf_import_rejects_html_without_writing_a_citation() {
        let (url, server) = serve_once(b"<html><title>Not a PDF</title></html>".to_vec());
        let project = TestProject::new("");
        let error = import(&project.root, &url).unwrap_err();
        server.join().unwrap();
        assert!(error.contains("did not return a PDF"), "{error}");
        assert_eq!(project.bibliography(), "");
    }

    #[test]
    #[ignore = "requires arxiv.org network access"]
    fn pixels_import_live_preserves_both_distinct_papers() {
        let before = "@misc{diao2026pixels,title={From Pixels to Words -- Towards Native One-Vision Models at Scale},author={Haiwen Diao},year={2026},eprint={2605.28820}}";
        let raw = official_arxiv_citation("https://arxiv.org/abs/2510.14979").unwrap().unwrap();
        let entry = project::parse_bibliography(&raw).remove(0);
        assert_eq!(
            entry.title,
            "From Pixels to Words -- Towards Native Vision-Language Primitives at Scale"
        );
        assert_eq!(entry.authors.split(" and ").count(), 9);
        assert_eq!(entry.year, "2025");
        assert_eq!(entry.arxiv_id.as_deref(), Some("2510.14979"));
        let (merged, _, exists) = merge_resolved_citation(before, &raw, &entry.key).unwrap();
        assert!(!exists);
        assert!(merged.starts_with(before));
        assert_eq!(project::parse_bibliography(&merged).len(), 2);
    }

    #[test]
    #[ignore = "Live AlphaXiv import and PDF conversion smoke test"]
    fn live_mimo_import_downloads_blog_and_pdf_without_arxiv() {
        let project = TestProject::new("");
        let root = &project.root;
        let result = import_reference(
            root,
            "https://www.alphaxiv.org/abs/2609.mimo-scaling-reinforcement-learning",
            HistoryMode::Record,
            &|stage| println!("{stage}"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(result.fetch_error.is_none(), "{:?}", result.fetch_error);
        let papers = list_papers(root).unwrap();
        assert_eq!(papers.len(), 1);
        assert!(papers[0].has_blog);
        assert!(papers[0].has_full_text);
        assert!(read_paper_blog_local(root, &papers[0].arxiv_id)
            .unwrap()
            .unwrap()
            .contains("[p8]"));
        assert!(read_paper(root, &papers[0].arxiv_id).unwrap().contains("reinforcement"));
        let resolved = project::resolve_citation_query(&papers[0].title).unwrap();
        assert_eq!(resolved.url, papers[0].url.as_deref().unwrap());
        assert_eq!(resolved.year, "2026");
        let from_title = import(root, &papers[0].title).unwrap();
        assert!(from_title.already_imported);
        assert_eq!(from_title.arxiv_id, papers[0].arxiv_id);
    }

    #[test]
    #[ignore = "requires network access"]
    fn direct_pdf_import_live_s_space() {
        let project = TestProject::new("");
        let url = "https://mirros.ai/report/s-space.pdf";
        let result = import(&project.root, url).unwrap();
        let markdown = read_paper(&project.root, &result.arxiv_id).unwrap();
        assert!(markdown.contains("S-Space"), "expected the actual report text");
        assert!(markdown.len() > 10_000);
        assert!(result.citation_key.is_some());
        assert!(result.fetch_error.is_none());
        let bib = project.bibliography();
        let entry = project::parse_bibliography(&bib)
            .into_iter()
            .find(|entry| Some(&entry.key) == result.citation_key.as_ref())
            .unwrap();
        assert_eq!(entry.authors, "MirroS Team");
        assert_eq!(entry.year, "2026");
        assert_eq!(entry.url.as_deref(), Some(url));
        assert!(!bib.contains("needs review"));
        assert!(!bib.contains("Blog post"));
        eprintln!("Imported title: {}; {} bytes of Markdown", result.title, markdown.len());
    }

    #[test]
    #[ignore = "requires network access"]
    fn imports_markdown_and_a_real_citation() {
        let project = TestProject::new("");
        let result = import(&project.root, "1706.03762").unwrap();
        assert_eq!(result.arxiv_id, "1706.03762");
        assert_eq!(result.title, "Attention Is All You Need");
        // --frontmatter leads the full text with a YAML block.
        let paper = fs::read_to_string(project.root.join(&result.paper_path)).unwrap();
        assert!(paper.starts_with("---"));
        // The alphaXiv overview is fetched and stored as the blog view.
        assert!(project.root.join(".research/papers/1706.03762/blog.md").exists());
        assert!(!project.bibliography().is_empty());
    }
}
