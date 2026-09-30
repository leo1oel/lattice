//! Resolving what a writer typed (DOI, arXiv id, URL, or title) into a
//! citation snapshot the review dialog can show before anything is saved.

use super::bibliography::{normalize_doi, parse_bibliography, parse_bibliography_fields_raw};
use crate::commands;
use crate::models::ResolvedCitation;

pub fn resolve_citation_query(query: &str) -> Result<ResolvedCitation, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Enter a DOI, arXiv id, or paper title.".to_string());
    }
    if !query.starts_with("http://")
        && !query.starts_with("https://")
        && normalize_doi(query).is_none()
        && crate::papers::explicit_arxiv_id(query).is_none()
    {
        // Title ranking is not identity: Crossref can index different works
        // under the exact same title. Keep both DOI-exact snapshots for review.
        let client = crate::papers::http_client("Lattice citation title lookup", 20)
            .map_err(|error| error.to_string())?;
        let report: serde_json::Value = client
            .get("https://api.crossref.org/works")
            .query(&[("query.title", query), ("rows", "10")])
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.json())
            .map_err(|error| {
                format!("Could not check for same-title records: {error}. Retry or supply a DOI.")
            })?;
        let dois = same_title_dois(query, &report);
        if dois.len() > 1 {
            let mut result = citation_from_bibtex("", "");
            for doi in dois {
                result.candidates.push(resolve_citation_query(&doi)?);
            }
            return Ok(result);
        }
        if dois.is_empty() {
            // AlphaXiv indexes technical reports that have neither DOI nor
            // arXiv record. Keep the exact resolved snapshot in the existing
            // review dialog; saving it must not perform a second title search.
            if let Ok(Some(paper)) = crate::alphaxiv::resolve_title(query) {
                if let Ok(raw) = crate::papers::alphaxiv_bibtex(&paper) {
                    return Ok(citation_from_bibtex(&raw, ""));
                }
            }
        }
    }
    if let Some(id) = crate::alphaxiv::paper_id_from_url(query) {
        if let Some(paper) = crate::alphaxiv::resolve_paper(&id)? {
            let raw = crate::papers::alphaxiv_bibtex(&paper)?;
            return Ok(citation_from_bibtex(&raw, ""));
        }
    }
    if let Some(raw) = crate::papers::official_arxiv_citation(query)? {
        crate::papers::validate_resolved_identity(query, &raw)?;
        let raw = crate::citation_audit::prepare_import(&raw)?;
        return Ok(citation_from_bibtex(&raw, ""));
    }
    let output = run_bibcite_get(query)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let result = parse_citation_resolution(&stdout, output.status.code(), &stderr)?;
    if !result.candidates.is_empty() {
        for candidate in &result.candidates {
            crate::papers::validate_resolved_identity(query, &candidate.bibtex)?;
        }
        return Ok(result);
    }
    crate::papers::validate_resolved_identity(query, &result.bibtex)?;
    crate::papers::verify_title_citation(query, &result.bibtex)?;
    let raw = crate::citation_audit::prepare_import(&result.bibtex)?;
    let mut resolved = citation_from_bibtex(&raw, &result.key);
    resolved.evidence = result.evidence;
    Ok(resolved)
}

/// Distinct DOIs of the Crossref records whose title equals `query` once
/// case and punctuation are ignored, in report order.
fn same_title_dois(query: &str, report: &serde_json::Value) -> Vec<String> {
    let normalize = |title: &str| {
        title
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let title = normalize(query);
    let mut dois = Vec::new();
    for item in report["message"]["items"].as_array().into_iter().flatten() {
        let same_title = item["title"].as_array().is_some_and(|titles| {
            titles.iter().any(|value| value.as_str().is_some_and(|value| normalize(value) == title))
        });
        if let Some(doi) = item["DOI"].as_str().and_then(normalize_doi).filter(|_| same_title) {
            if !dois.contains(&doi) {
                dois.push(doi);
            }
        }
    }
    dois
}

fn parse_citation_resolution(
    stdout: &str, code: Option<i32>, stderr: &str,
) -> Result<ResolvedCitation, String> {
    // Exit 2 can carry usable candidate snapshots. Decode those before treating
    // the command as an error; choosing a snapshot must never rerun a search.
    let value = serde_json::from_str::<serde_json::Value>(stdout).ok();
    if code == Some(2) && value.as_ref().is_some_and(|value| value["action"] == "ambiguous") {
        let candidates = value
            .as_ref()
            .and_then(|value| value["candidates"].as_array())
            .ok_or_else(|| "bibcite returned no candidate previews.".to_string())?;
        let mut result = citation_from_bibtex("", "");
        result.candidates =
            candidates.iter().map(citation_from_report).collect::<Result<_, _>>()?;
        if result.candidates.len() < 2 {
            return Err("bibcite returned an incomplete ambiguity report.".to_string());
        }
        return Ok(result);
    }
    if code != Some(0) {
        return Err(if stderr.is_empty() {
            "bibcite could not resolve that query.".to_string()
        } else {
            stderr.to_string()
        });
    }
    citation_from_report(&value.ok_or_else(|| "bibcite returned invalid JSON.".to_string())?)
}

fn citation_from_report(value: &serde_json::Value) -> Result<ResolvedCitation, String> {
    let text = |name: &str| value.get(name).and_then(|item| item.as_str()).unwrap_or("");
    if text("bibtex").trim().is_empty() {
        return Err("bibcite did not return BibTeX for that query.".to_string());
    }
    let mut resolved = citation_from_bibtex(text("bibtex"), text("key"));
    resolved.evidence = value.get("evidence").filter(|v| v.is_object()).cloned().or_else(|| {
        value
            .get("source")
            .and_then(|v| v.as_str())
            .map(|source| serde_json::json!({ "source": source, "author_match": "not_checked" }))
    });
    Ok(resolved)
}

fn run_bibcite_get(query: &str) -> Result<std::process::Output, String> {
    let mut command = commands::BIBCITE.command()?;
    command
        .args(["get", "--json", query])
        .output()
        .map(|output| commands::redact_bibcite_output(&command, output))
        .map_err(|error| crate::papers::uv_tool_spawn_error("bibcite", &error))
}

/// Fields [`ResolvedCitation`] names; everything else lands in `extra_fields`.
const NAMED_FIELDS: &[&str] =
    &["title", "author", "year", "journal", "booktitle", "publisher", "url", "doi"];

pub(super) fn citation_from_bibtex(bibtex: &str, fallback_key: &str) -> ResolvedCitation {
    let protected = crate::citation_audit::protect_bibtex(bibtex);
    let bibtex = protected.as_str();
    let entry_type = bibtex
        .trim_start()
        .strip_prefix('@')
        .and_then(|rest| rest.split('{').next())
        .unwrap_or("article")
        .trim()
        .to_ascii_lowercase();
    let info = parse_bibliography(bibtex).into_iter().next();
    let body = bibtex
        .find(',')
        .map(|index| {
            let body = bibtex[index + 1..].trim_end();
            body.strip_suffix('}').unwrap_or(body)
        })
        .unwrap_or("");
    let fields = parse_bibliography_fields_raw(body);
    let field = |name: &str| fields.get(name).cloned().unwrap_or_default();
    ResolvedCitation {
        key: info
            .as_ref()
            .map(|item| item.key.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback_key.to_string()),
        title: field("title"),
        author: field("author"),
        year: info.as_ref().map_or_else(|| field("year"), |item| item.year.clone()),
        journal: field("journal"),
        booktitle: field("booktitle"),
        publisher: field("publisher"),
        url: field("url"),
        doi: field("doi"),
        entry_type,
        candidates: Vec::new(),
        evidence: None,
        extra_fields: fields
            .iter()
            .filter(|(name, _)| !NAMED_FIELDS.contains(&name.as_str()))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect(),
        bibtex: if bibtex.ends_with('\n') { bibtex.to_string() } else { format!("{bibtex}\n") },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_reports_keep_same_title_dois_and_bibcite_candidates() {
        let title = "Visual object processing in optic aphasia: A case of semantic access agnosia";
        let report = serde_json::json!({"message":{"items":[
            {"title":[title.to_lowercase()], "DOI":"10.1093/neucas/3.3.209-w"},
            {"title":[title], "DOI":"10.1080/02643298708252038"},
            {"title":[title], "DOI":"10.1080/02643298708252038"},
            {"title":["On optic aphasia and visual agnosia"], "DOI":"10.1080/02643299108253365"}
        ]}});
        assert_eq!(
            same_title_dois(title, &report),
            vec!["10.1093/neucas/3.3.209-w", "10.1080/02643298708252038"]
        );
        assert!(same_title_dois("A different title", &report).is_empty());

        // bibcite reports: ambiguity candidates, then a legacy success report.
        let candidate = |key: &str| {
            serde_json::json!({
                "key": key,
                "bibtex": format!("@misc{{{key}, title={{A Paper}}, author={{Alice Smith}}, year={{2024}}, eprint={{2401.01234}}, note={{Keep {{NASA}}}}, howpublished={{\\url{{https://example.org}}}}}}"),
                "evidence": {"source": "crossref", "author_match": "partial"}
            })
        };
        let report = serde_json::json!({"action": "ambiguous", "candidates": [candidate("a"), candidate("b")]}).to_string();
        let result = parse_citation_resolution(&report, Some(2), "ambiguous").unwrap();
        assert_eq!(result.candidates.len(), 2);
        let first = &result.candidates[0];
        assert_eq!(first.key, "a");
        assert_eq!(first.extra_fields["eprint"], "2401.01234");
        assert_eq!(first.extra_fields["note"], "Keep {NASA}");
        assert_eq!(first.extra_fields["howpublished"], r"\url{https://example.org}");
        assert_eq!(first.evidence.as_ref().unwrap()["author_match"], "partial");
        assert!(parse_citation_resolution(&report, Some(3), "network failure").is_err());
        let incomplete = r#"{"action":"ambiguous","candidates":[{"doi":"10.1234/no-preview"}]}"#;
        assert!(parse_citation_resolution(incomplete, Some(2), "").is_err());

        let report = serde_json::json!({"key":"a", "bibtex":"@article{a,title={A},author={B},year={2024}}", "source":"crossref"}).to_string();
        let result = parse_citation_resolution(&report, Some(0), "").unwrap();
        assert_eq!(result.title, "A");
        assert!(result.candidates.is_empty());
        assert_eq!(result.evidence.unwrap()["author_match"], "not_checked");
    }

    #[test]
    fn citation_snapshots_read_bibtex_fields_with_case_and_corporate_author_protection() {
        let resolved = citation_from_bibtex(
            "@article{lecun2015deep,\n  author = {LeCun, Yann},\n  doi = {10.1038/nature14539},\n  journal = {Nature},\n  title = {Deep learning},\n  year = {2015}\n}\n",
            "fallback",
        );
        assert_eq!(
            [resolved.key, resolved.title, resolved.doi, resolved.journal, resolved.entry_type],
            ["lecun2015deep", "Deep learning", "10.1038/nature14539", "Nature", "article"]
        );

        let resolved = citation_from_bibtex(
            "@misc{gemma,title={Gemma: Open AI Models},author={Gemma Team and Jane Doe},year={2024}}",
            "fallback",
        );
        assert_eq!(resolved.title, "{Gemma: Open AI Models}");
        assert_eq!(resolved.author, "{Gemma Team} and Jane Doe");
        assert!(resolved.bibtex.contains("author = {{Gemma Team} and Jane Doe}"));
    }
}
