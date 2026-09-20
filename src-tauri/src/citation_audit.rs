use crate::citation_health::CitationHealth;
use crate::project_fs::ProjectDir;
use crate::{citation_health, commands, project};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

mod proceedings;

const REPORT_DIRECTORY: &str = "bibliography-audits";

fn report_relative_path(root: &Path) -> Result<String, String> {
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    // Older reports contain proposals made before independent identity checks.
    Ok(format!("{REPORT_DIRECTORY}/v2-{digest:x}.json"))
}

pub fn load_report(
    data_dir: &Path,
    root: &Path,
) -> Result<Option<Vec<(String, serde_json::Value)>>, String> {
    let path = data_dir.join(report_relative_path(root)?);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("The saved bibliography audit report is malformed: {error}"))
}

pub fn save_report(
    data_dir: &Path,
    root: &Path,
    report: Vec<(String, serde_json::Value)>,
) -> Result<(), String> {
    let relative = report_relative_path(root)?;
    let bytes = serde_json::to_vec(&report).map_err(|error| error.to_string())?;
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    ProjectDir::open(data_dir)?.atomic_write(&relative, &bytes)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub path: String,
    pub key: String,
    pub title: String,
    pub bibtex: String,
    #[serde(default)]
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditIssue {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditScan {
    pub entries: Vec<AuditEntry>,
    pub issues: Vec<AuditIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchAudit {
    pub results: Vec<Option<AuditResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s2_failure: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditCandidate {
    pub bibtex: String,
    pub changes: Vec<FieldChange>,
    pub reasons: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditResult {
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication_reason: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<SourceCheck>,
    pub before: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<AuditCandidate>,
    pub changes: Vec<FieldChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<CitationHealth>,
}

#[derive(Debug, Serialize)]
pub struct SourceCheck {
    pub source: String,
    pub outcome: String,
}

pub fn scan(root: &Path) -> Result<AuditScan, String> {
    let sources = project::iter_bibliography_sources(root)?;
    let mut entries = Vec::new();
    let mut issues = Vec::new();
    let mut keys: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut dois: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut titles: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (path, source) in sources {
        let spans = project::bibliography_entry_spans(&source);
        let at_count = bibliography_construct_count(&source);
        if spans.len() < at_count {
            issues.push(AuditIssue {
                path: path.clone(),
                key: None,
                message: format!(
                    "Could not parse {} bibliography construct(s).",
                    at_count - spans.len()
                ),
            });
        }
        for (key, start, end) in spans {
            let bibtex = source[start..end].to_string();
            if !complete_entry(&bibtex) {
                issues.push(AuditIssue {
                    path: path.clone(),
                    key: Some(key),
                    message: "Unclosed bibliography entry; online check skipped.".into(),
                });
                continue;
            }
            let fields = fields(&bibtex);
            let title = clean(fields.get("title").map(String::as_str).unwrap_or(""));
            let local = local_validation(&bibtex);
            for message in &local {
                issues.push(AuditIssue {
                    path: path.clone(),
                    key: Some(key.clone()),
                    message: message.clone(),
                });
            }
            keys.entry(key.to_ascii_lowercase())
                .or_default()
                .push((path.clone(), key.clone()));
            if let Some(doi) = fields.get("doi").and_then(|v| normalize_doi(&clean(v))) {
                dois.entry(doi)
                    .or_default()
                    .push((path.clone(), key.clone()));
            }
            if !title.is_empty() {
                titles
                    .entry(normalize_title(&title))
                    .or_default()
                    .push((path.clone(), key.clone()));
            }
            entries.push(AuditEntry {
                path: path.clone(),
                key,
                title,
                bibtex,
                issues: local,
            });
        }
    }
    for (kind, groups) in [("citation key", keys), ("DOI", dois), ("title", titles)] {
        for members in groups.into_values().filter(|v| v.len() > 1) {
            for (path, key) in &members {
                issues.push(AuditIssue {
                    path: path.clone(),
                    key: Some(key.clone()),
                    message: format!("Duplicate {kind} across bibliography files."),
                });
            }
        }
    }
    Ok(AuditScan { entries, issues })
}

/// A bounded fast path; None means the original multi-source check is still
/// required. API misses and malformed records never count as successful checks.
pub fn check_batch(root: &Path, entries: Vec<AuditEntry>) -> Result<BatchAudit, String> {
    if entries.len() > crate::citation_batch::BATCH_SIZE {
        return Err("Too many entries in an audit batch.".into());
    }
    let ids = entries
        .iter()
        .map(|entry| batch_id(&entry.bibtex))
        .collect::<Vec<_>>();
    let requested = ids.iter().flatten().cloned().collect::<Vec<_>>();
    let papers = match crate::citation_batch::lookup(&requested) {
        Ok(papers) => papers,
        Err(failure) => {
            return Ok(BatchAudit {
                results: entries.iter().map(|_| None).collect(),
                s2_failure: Some(failure.code().into()),
            })
        }
    };
    let normalized = match normalize_s2_batch(&papers) {
        Ok(normalized) => normalized,
        Err(_) => {
            return Ok(BatchAudit {
                results: entries.iter().map(|_| None).collect(),
                s2_failure: Some("malformed".into()),
            })
        }
    };
    let mut results = entries
        .iter()
        .zip(ids)
        .map(|(entry, id)| {
            let id = id?;
            let paper = papers.get(&id)?;
            // The same snapshot guard as the individual path, before any proposal.
            if registered_entry(root, &entry.path, &entry.key)
                .ok()
                .flatten()
                .as_deref()
                != Some(&entry.bibtex)
            {
                return None;
            }
            let (bibtex, venue) = normalized.get(&id)?;
            // These proceedings have a direct authoritative check. A fast
            // index result must not bypass the formal-version author lookup.
            if venue
                .as_deref()
                .is_some_and(|venue| venue.contains("NeurIPS") || venue.contains("ICLR"))
            {
                return None;
            }
            let mut checked = batch_comparison(&entry.bibtex, paper, bibtex, venue.as_deref())?;
            if checked.candidate.is_some() {
                // A conflicting fast-path record (including a Findings DOI
                // mislabeled as ACL) still needs the independent source lookup.
                return None;
            }
            checked.sources.push(SourceCheck {
                source: "semanticscholar".into(),
                outcome: "selected".into(),
            });
            Some(cleanup_result(checked))
        })
        .collect::<Vec<_>>();
    let dois = results
        .iter()
        .flatten()
        .filter_map(|r| {
            fields(r.after.as_deref().unwrap_or(&r.before))
                .get("doi")
                .and_then(|v| normalize_doi(v))
                .filter(|v| !v.starts_with("10.48550/"))
        })
        .collect::<Vec<_>>();
    // One shared lookup loads/writes the health cache once for this group.
    // Crossref's health checks remain individual requests, not an invented batch API.
    let health = citation_health::lookup(root, dois);
    for checked in results.iter_mut().flatten() {
        let Some(doi) = fields(checked.after.as_deref().unwrap_or(&checked.before))
            .get("doi")
            .and_then(|v| normalize_doi(v))
            .filter(|v| !v.starts_with("10.48550/"))
        else {
            // A confirmed conference publication may have no DOI. Like the
            // existing preprint upgrade, this is not a Crossref health verdict.
            continue;
        };
        checked.health = health.get(&doi).cloned();
        if checked
            .health
            .as_ref()
            .is_none_or(|h| h.kind == "unavailable" || h.stale)
        {
            checked.status = "unavailable".into();
            checked.message =
                "Metadata may be available, but the citation-health check was incomplete.".into();
        }
    }
    Ok(BatchAudit {
        results,
        s2_failure: None,
    })
}

fn batch_id(before: &str) -> Option<String> {
    let local = fields(before);
    if local
        .get("pubstate")
        .is_some_and(|v| v.eq_ignore_ascii_case("preprint"))
    {
        return None;
    }
    if let Some(doi) = local
        .get("doi")
        .and_then(|v| normalize_doi(v))
        .filter(|v| !v.starts_with("10.48550/"))
    {
        return Some(format!("DOI:{doi}"));
    }
    let id = project::bibliography_arxiv_id(&local)?;
    // Versioned arXiv identifiers refer to the same S2 paper.
    Some(format!("ARXIV:{}", unversioned_arxiv(&id)))
}

fn batch_comparison(
    before: &str,
    paper: &crate::citation_batch::Paper,
    normalized_bibtex: &str,
    canonical_venue: Option<&str>,
) -> Option<AuditResult> {
    let local = fields(before);
    if normalize_title(local.get("title")?) != normalize_title(&paper.title) {
        return None;
    }
    let preprint = batch_id(before)?.starts_with("ARXIV:");
    let doi = paper
        .external_ids
        .get("DOI")
        .and_then(|v| v.as_str())
        .and_then(normalize_doi)
        .filter(|v| !v.starts_with("10.48550/"));
    if !preprint && doi.is_none() {
        return None;
    }
    let mut remote = normalized_bibtex.trim().to_string();
    let other = fields(&remote);
    if project::bibliography_entry_spans(&remote).len() != 1
        || !complete_entry(&remote)
        || other.get("doi").is_some_and(|v| normalize_doi(v) != doi)
        || normalize_title(other.get("title")?) != normalize_title(&paper.title)
    {
        return None;
    }
    // S2's generated BibTeX often omits DOI even when externalIds contains it.
    // Only add the independently confirmed identifier, never guess one from a title.
    if let Some(doi) = doi.filter(|_| !other.contains_key("doi")) {
        if doi.contains(['{', '}', '\\']) || !remote.ends_with('}') {
            return None;
        }
        remote.pop();
        remote = format!(
            "{},\n  doi = {{{doi}}}\n}}",
            remote.trim_end().trim_end_matches(',')
        );
    }
    if preprint {
        let arxiv = paper.external_ids.get("ArXiv")?.as_str()?;
        if batch_id(before)? != format!("ARXIV:{}", unversioned_arxiv(arxiv)) {
            return None;
        }
        // S2 may omit eprint in BibTeX even though externalIds confirms it.
        // Carry that checked identifier into the shared identity/apply rules.
        if project::bibliography_arxiv_id(&other).is_none() {
            if !remote.ends_with('}') {
                return None;
            }
            remote.pop();
            remote = format!(
                "{},\n  eprint = {{{arxiv}}}\n}}",
                remote.trim_end().trim_end_matches(',')
            );
        }
        if !metadata_identity_matches(before, &remote) {
            return None;
        }
        let venue = canonical_venue?.trim();
        if venue.is_empty()
            || is_preprint_venue(venue)
            || !["journal", "booktitle"].iter().any(|name| {
                other
                    .get(*name)
                    .is_some_and(|v| normalize_text(v) == normalize_text(venue))
            })
        {
            return None;
        }
        let year = local.get("year")?.parse::<u32>().ok()?;
        let published_year = other.get("year")?.parse::<u32>().ok()?;
        if year.abs_diff(published_year) > 2 || local.get("author")?.trim().is_empty() {
            return None;
        }
        let after = merge_metadata(before, &remote, true).after?;
        return Some(proposal(before, after, "A published version is available."));
    }
    Some(compare_doi_entry(before, &remote))
}

fn normalize_s2_batch(
    papers: &BTreeMap<String, crate::citation_batch::Paper>,
) -> Result<BTreeMap<String, (String, Option<String>)>, String> {
    let mut order = Vec::new();
    let mut input = String::new();
    for (id, paper) in papers {
        let Some(style) = &paper.citation_styles else {
            continue;
        };
        order.push(id.clone());
        input.push_str(&style.bibtex);
        input.push('\n');
        // Normalize the independent venue field too; the generated BibTeX
        // must agree with it before a preprint can become a publication.
        let venue = paper.venue.as_deref().unwrap_or("");
        let venue = if venue.contains(['{', '}', '\\']) {
            ""
        } else {
            venue
        };
        input.push_str(&format!(
            "@misc{{latticeVenue{}, journal = {{{venue}}}, year = {{{}}}}}\n",
            order.len(),
            paper.year.unwrap_or(0)
        ));
    }
    if order.is_empty() {
        return Ok(BTreeMap::new());
    }
    let temp = TempFile::new(&input)?;
    let output = run_bibcite(&["normalize", temp.path.to_string_lossy().as_ref()], None)?;
    if !output.status.success() {
        return Err("bibcite normalization failed".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "bibcite normalization returned invalid JSON")?;
    let values = value
        .get("bibtex")
        .and_then(|v| v.as_array())
        .ok_or("bibcite normalization returned no entries")?;
    let mut cursor = 0;
    let mut result = BTreeMap::new();
    for id in order {
        let bibtex = values
            .get(cursor)
            .and_then(|v| v.as_str())
            .ok_or("missing normalized entry")?
            .to_string();
        cursor += 1;
        let hint = values
            .get(cursor)
            .and_then(|v| v.as_str())
            .ok_or("missing normalized venue")?;
        cursor += 1;
        let normalized = fields(hint);
        let venue = normalized
            .get("journal")
            .or_else(|| normalized.get("booktitle"))
            .cloned();
        result.insert(id, (bibtex, venue));
    }
    if cursor != values.len() {
        return Err("unexpected normalized entries".into());
    }
    Ok(result)
}

pub fn check_entry(
    root: &Path,
    request: AuditEntry,
    s2_batch_status: Option<&str>,
) -> Result<AuditResult, String> {
    check_entry_metadata(root, request, s2_batch_status).map(cleanup_result)
}

fn check_entry_metadata(
    root: &Path,
    request: AuditEntry,
    s2_batch_status: Option<&str>,
) -> Result<AuditResult, String> {
    if s2_batch_status.is_some_and(|s| {
        !matches!(
            s,
            "checked"
                | "not_configured"
                | "queue_busy"
                | "daily_quota"
                | "upstream_rate_limit"
                | "rate_limited"
                | "unauthorized"
                | "timeout"
                | "network"
                | "malformed"
                | "unavailable"
        )
    }) {
        return Err("Invalid batch status.".into());
    }
    let before = match registered_entry(root, &request.path, &request.key)? {
        Some(value) if value == request.bibtex => value,
        Some(value) => {
            return Ok(result(
                "conflict",
                "The bibliography entry changed after the scan.",
                value,
            ))
        }
        None => {
            return Ok(result(
                "conflict",
                "The bibliography entry no longer exists.",
                String::new(),
            ))
        }
    };
    let local = fields(&before);
    let doi = local.get("doi").and_then(|v| normalize_doi(&clean(v)));
    let arxiv = local.contains_key("eprint")
        || local
            .values()
            .any(|v| clean(v).to_ascii_lowercase().contains("arxiv"));
    if arxiv
        && clean(local.get("pubstate").map(String::as_str).unwrap_or(""))
            .eq_ignore_ascii_case("preprint")
    {
        return Ok(annotate_s2(
            result(
                "skipped",
                "Kept as a preprint because pubstate is explicitly preprint.",
                before,
            ),
            s2_batch_status,
        ));
    }
    if arxiv {
        let checked = upgrade_preprint(&before, s2_batch_status)?;
        return Ok(annotate_s2(
            proceedings::refine(&before, checked),
            s2_batch_status,
        ));
    }
    let Some(doi) = doi else {
        let missing = identity_missing_fields(&before);
        if !missing.is_empty() {
            let mut checked = result("skipped", "A title is required for a title lookup.", before);
            checked.publication_reason = Some("missing_identity".into());
            return Ok(annotate_s2(checked, s2_batch_status));
        }
        let title = clean(local.get("title").expect("checked above")).replace(['{', '}'], "");
        let metadata = audit_command(s2_batch_status).and_then(|command| {
            run_bibcite(
                &["get", &title, "--json", "--require-published"],
                Some(command),
            )
        });
        let checked = match metadata {
            Ok(output) if is_clean_lookup_miss(&output) => {
                let mut checked =
                    result("checked", "No matching metadata record was found.", before);
                checked.publication_reason = Some("no_match".into());
                checked.sources = publication_sources(&String::from_utf8_lossy(&output.stderr));
                checked
            }
            Ok(output) => match parse_get_output(&output) {
                Ok(remote) => {
                    let mut checked = compare_title_entry(&before, &remote);
                    checked.sources = metadata_sources(&output, &checked);
                    checked
                }
                Err(error) => {
                    let mut checked = result(
                        "unavailable",
                        &format!("Metadata check incomplete: {error}"),
                        before,
                    );
                    checked.publication_reason = Some("metadata_unavailable".into());
                    checked.sources = publication_sources(&String::from_utf8_lossy(&output.stderr));
                    checked
                }
            },
            Err(error) => {
                let mut checked = result(
                    "unavailable",
                    &format!("Metadata check incomplete: {error}"),
                    before,
                );
                checked.publication_reason = Some("metadata_unavailable".into());
                checked
            }
        };
        return Ok(annotate_s2(checked, s2_batch_status));
    };
    let health = citation_health::lookup(root, [doi.clone()]).remove(&doi);
    let metadata = audit_command(s2_batch_status)
        .and_then(|command| run_bibcite(&["get", "--json", &doi], Some(command)));
    let mut checked = match metadata
        .as_ref()
        .map_err(Clone::clone)
        .and_then(parse_get_output)
    {
        Ok(remote) => compare_doi_entry(&before, &remote),
        Err(error) => result(
            "unavailable",
            &format!("Metadata check incomplete: {error}"),
            before,
        ),
    };
    if let Ok(output) = &metadata {
        checked.sources = metadata_sources(output, &checked);
    }
    checked.health = health;
    if checked
        .health
        .as_ref()
        .is_none_or(|h| h.kind == "unavailable" || h.stale)
    {
        checked.status = "unavailable".into();
        checked.message =
            "Metadata may be available, but the citation-health check was incomplete.".into();
    }
    Ok(annotate_s2(checked, s2_batch_status))
}

fn annotate_s2(mut result: AuditResult, status: Option<&str>) -> AuditResult {
    if let Some(status) = status.filter(|status| *status != "checked") {
        result
            .sources
            .retain(|source| source.source != "semanticscholar");
        result.sources.push(SourceCheck {
            source: "semanticscholar".into(),
            outcome: if status == "not_configured" {
                "not_configured".into()
            } else {
                format!("batch_{status}")
            },
        });
    }
    result
}

pub fn apply(root: &Path, path: &str, key: &str, before: &str, after: &str) -> Result<(), String> {
    let current = registered_entry(root, path, key)?
        .ok_or_else(|| "The bibliography entry no longer exists.".to_string())?;
    if current != before {
        return Err("The bibliography entry changed after the preview. Scan it again.".into());
    }
    let spans = project::bibliography_entry_spans(after);
    if spans.len() != 1
        || spans[0].0 != key
        || spans[0].1 != 0
        || spans[0].2 != after.len()
        || !complete_entry(after)
    {
        return Err(
            "The proposed replacement must be exactly one entry with the same citation key.".into(),
        );
    }
    let sources = project::iter_bibliography_sources(root)?;
    // Evidence independent of the title: a DOI that another entry already
    // claims means this proposal duplicates that paper rather than correcting
    // this one, which is the shape a wrong publication match takes.
    if let Some(conflict) = doi_owned_by_another_entry(&sources, path, key, after) {
        return Err(format!(
            "That update would give this entry the DOI already used by '{conflict}', \
             so it describes a different paper. Check the record before applying it."
        ));
    }
    if !metadata_identity_matches(before, after) && !is_safe_local_cleanup(before, after) {
        return Err("The proposed metadata conflicts with this reference's identity. Check the title, authors, identifiers, year, and venue manually.".into());
    }
    let (_, whole) = sources
        .into_iter()
        .find(|(p, _)| p == path)
        .ok_or_else(|| "That bibliography is not registered in this project.".to_string())?;
    let (_, start, end) = project::bibliography_entry_spans(&whole)
        .into_iter()
        .find(|(k, _, _)| k == key)
        .ok_or_else(|| "The bibliography entry no longer exists.".to_string())?;
    if &whole[start..end] != before {
        return Err("The bibliography file changed after the preview. Scan it again.".into());
    }
    let mut next = whole.clone();
    next.replace_range(start..end, after);
    // Audit writes bypass editor autosave formatting. Normalize only gaps so
    // pending entries still match the snapshots used by sequential bulk apply.
    // Reverse traversal keeps the original byte offsets valid after each edit.
    let separator = if whole.contains("\r\n") {
        "\r\n\r\n"
    } else {
        "\n\n"
    };
    let entries = project::bibliography_entry_spans(&next);
    for pair in entries.windows(2).rev() {
        let (_, left_start, left_end) = &pair[0];
        let (_, right_start, right_end) = &pair[1];
        if complete_entry(&next[*left_start..*left_end])
            && complete_entry(&next[*right_start..*right_end])
            && next[*left_end..*right_start]
                .bytes()
                .all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        {
            next.replace_range(*left_end..*right_start, separator);
        }
    }
    project::apply_citation_transaction_checked(
        root,
        "Audit bibliography entry",
        vec![(path.to_string(), whole, next)],
    )?;
    Ok(())
}

/// The key of a different entry that already carries `after`'s DOI, if any.
fn doi_owned_by_another_entry(
    sources: &[(String, String)],
    path: &str,
    key: &str,
    after: &str,
) -> Option<String> {
    let doi = fields(after).get("doi").and_then(|v| normalize_doi(v))?;
    sources.iter().find_map(|(other_path, source)| {
        project::bibliography_entry_spans(source)
            .into_iter()
            .find(|(other_key, start, end)| {
                !(other_path == path && other_key == key)
                    && fields(&source[*start..*end])
                        .get("doi")
                        .and_then(|v| normalize_doi(v))
                        .is_some_and(|v| v == doi)
            })
            .map(|(other_key, _, _)| other_key)
    })
}

fn registered_entry(root: &Path, path: &str, key: &str) -> Result<Option<String>, String> {
    let sources = project::iter_bibliography_sources(root)?;
    let (_, source) = sources
        .into_iter()
        .find(|(p, _)| p == path)
        .ok_or_else(|| "That bibliography is not registered in this project.".to_string())?;
    let matches = project::bibliography_entry_spans(&source)
        .into_iter()
        .filter(|(k, _, _)| k == key)
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        return Err(
            "Duplicate citation key in this file; fix it before checking or applying updates."
                .into(),
        );
    }
    Ok(matches.first().map(|(_, s, e)| source[*s..*e].to_string()))
}

fn audit_command(s2_batch_status: Option<&str>) -> Result<Command, String> {
    let mut command = commands::BIBCITE.command()?;
    if let Some(status) = s2_batch_status {
        command.env(
            "BIBCITE_S2_BATCH_STATUS",
            match status {
                "checked" => "checked",
                "not_configured" => "disabled",
                _ => "unavailable",
            },
        );
    }
    Ok(command)
}

fn upgrade_preprint(before: &str, s2_batch_status: Option<&str>) -> Result<AuditResult, String> {
    let temp = TempFile::new(before)?;
    let output = run_bibcite(
        &[
            "upgrade",
            temp.path.to_string_lossy().as_ref(),
            "--no-tidy",
            "--include-published-arxiv",
        ],
        Some(audit_command(s2_batch_status)?),
    );
    let output = match output {
        Ok(v) => v,
        Err(e) => {
            return Ok(result(
                "unavailable",
                &format!("Preprint check incomplete: {e}"),
                before.into(),
            ))
        }
    };
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Ok(result(
            "unavailable",
            &format!(
                "Preprint check incomplete: {}",
                if detail.is_empty() {
                    "bibcite did not report a match"
                } else {
                    &detail
                }
            ),
            before.into(),
        ));
    }
    let report: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(report) => report,
        Err(_) => {
            return Ok(result(
                "unavailable",
                "bibcite returned invalid upgrade JSON.",
                before.into(),
            ))
        }
    };
    let Some(record) = report
        .get("entries")
        .and_then(|v| v.as_array())
        .and_then(|v| v.first())
    else {
        return Ok(result(
            "skipped",
            "No upgrade check was performed for this entry.",
            before.into(),
        ));
    };
    if record.get("matched").and_then(|v| v.as_bool()) != Some(true) {
        let mut checked = upgrade_miss(before, record);
        // A successful CLI exit can still contain incomplete provider lookups.
        // Retain safe, structured outcomes, not raw errors containing URLs/keys.
        checked.sources = publication_sources(&String::from_utf8_lossy(&output.stderr));
        return Ok(checked);
    }
    let after = fs::read_to_string(&temp.path).map_err(|e| e.to_string())?;
    let spans = project::bibliography_entry_spans(&after);
    if spans.len() != 1 {
        return Ok(result(
            "unavailable",
            "Preprint check returned an incomplete or ambiguous result.",
            before.into(),
        ));
    }
    let after = after[spans[0].1..spans[0].2].to_string();
    if renamed_paper(before, &after) {
        let mut checked = result(
            "unavailable",
            "The published record found for this entry describes a different paper.",
            before.into(),
        );
        checked.publication_reason = Some("identity_conflict".into());
        checked.candidate = Some(AuditCandidate {
            bibtex: after.clone(),
            changes: differing_fields(before, &after),
            reasons: vec!["title".into()],
        });
        checked.sources = metadata_sources(&output, &checked);
        return Ok(checked);
    }
    // `upgrade` preserves the input author field, so comparing that output to
    // the input cannot verify the authors. Dereference the candidate DOI and
    // check independent metadata before offering an applicable replacement.
    let candidate_fields = fields(&after);
    let remote_output = candidate_fields
        .get("doi")
        .and_then(|doi| normalize_doi(doi))
        .filter(|doi| !doi.starts_with("10.48550/"))
        .map(|doi| doi.to_string())
        .map_or_else(
            || {
                candidate_fields
                    .get("title")
                    .map(|title| clean(title).replace(['{', '}'], ""))
                    .filter(|title| !title.is_empty())
                    .ok_or_else(|| "The publication has no independently searchable title.".into())
            },
            Ok,
        )
        .and_then(|identity| {
            run_bibcite(
                &["get", &identity, "--json", "--require-published"],
                Some(audit_command(s2_batch_status)?),
            )
        });
    let remote = remote_output
        .as_ref()
        .map_err(Clone::clone)
        .and_then(parse_get_output);
    let mut checked = match remote {
        Ok(remote)
            if metadata_identity_matches(before, &remote)
                && metadata_identity_matches(&after, &remote) =>
        {
            let mut checked = merge_metadata(before, &remote, true);
            if checked.after.is_some() {
                checked.message = "A published version is available.".into();
            }
            checked
        }
        Ok(remote) => {
            let mut checked = identity_conflict(before, &remote);
            if let Some(candidate) = checked.candidate.as_mut() {
                candidate
                    .reasons
                    .extend(identity_conflicts(&after, &remote));
                candidate.reasons.sort();
                candidate.reasons.dedup();
            }
            checked
        }
        Err(_) => {
            let mut checked = result(
                "unavailable",
                "Independent publication metadata was unavailable; no replacement is offered.",
                before.into(),
            );
            checked.publication_reason = Some("metadata_unavailable".into());
            checked
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    checked.sources = metadata_sources(&output, &checked);
    if let Some(source) = record.get("source").and_then(|value| value.as_str()) {
        checked.sources.retain(|row| row.source != source);
        checked.sources.push(SourceCheck {
            source: source.into(),
            outcome: if checked.status == "update" || checked.status == "checked" {
                if stderr.lines().any(|line| line.starts_with("[cache] hit:")) {
                    "selected_cached"
                } else {
                    "selected"
                }
            } else if stderr.lines().any(|line| line.starts_with("[cache] hit:")) {
                "candidate_cached"
            } else {
                "candidate"
            }
            .into(),
        });
    }
    if let Ok(output) = &remote_output {
        for source in metadata_sources(output, &checked) {
            checked.sources.retain(|row| row.source != source.source);
            checked.sources.push(source);
        }
    }
    Ok(checked)
}

/// The short name a title gives itself before a colon — "GMT" in "GMT: General
/// Motion Tracking for Humanoid Whole-Body Control". A longer head introduces
/// an ordinary subtitle instead of naming the work, so it does not count.
fn title_acronym(title: &str) -> Option<String> {
    let (head, rest) = title.split_once(':')?;
    if rest.trim().is_empty() || head.split_whitespace().count() > 3 {
        return None;
    }
    let key = head
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();
    (!key.is_empty()).then_some(key)
}

/// Whether a proposed record renamed the paper, which means it is not the same
/// paper at all.
///
/// The preprint-upgrade path is the one place a provider may legitimately
/// return a title different from the one we asked about, so unlike the batch
/// path it cannot require the titles to be equal. It can still require this:
/// a camera-ready version rewords its description, but it does not give itself
/// a new name. Without the check, a provider matching "GMT: General Motion
/// Tracking for Humanoid Whole-Body Control" onto "SONIC: Supersizing Motion
/// Tracking for Natural Humanoid Whole-Body Control" — six of eight shared
/// significant words — silently rewrites the entry into someone else's paper.
fn renamed_paper(before: &str, after: &str) -> bool {
    let name_of = |entry: &str| {
        fields(entry)
            .get("title")
            .and_then(|title| title_acronym(&clean(title)))
    };
    matches!((name_of(before), name_of(after)), (Some(a), Some(b)) if a != b)
}

fn upgrade_miss(before: &str, record: &serde_json::Value) -> AuditResult {
    let reason = record
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let mut checked = result(
        if reason == "no_published_version" {
            "checked"
        } else {
            "unavailable"
        },
        if reason == "no_published_version" {
            "No published version was found."
        } else {
            "The published version could not be confirmed."
        },
        before.into(),
    );
    checked.publication_reason = Some(reason.into());
    checked
}

fn publication_sources(stderr: &str) -> Vec<SourceCheck> {
    let mut sources = BTreeMap::new();
    for line in stderr.lines() {
        let Some((source, detail)) = line.strip_prefix('[').and_then(|s| s.split_once("] ")) else {
            continue;
        };
        let source = if source == "dblp-fuzzy" || source == "dblp-exact" {
            "dblp"
        } else {
            source
        };
        if !matches!(
            source,
            "dblp" | "semanticscholar" | "googlescholar" | "crossref" | "unpaywall" | "openalex"
        ) {
            continue;
        }
        let detail = detail.to_ascii_lowercase();
        // Intermediate retry diagnostics aren't final source outcomes.
        if detail.contains("retrying once") {
            continue;
        }
        let outcome = if detail.contains("publication matched") {
            "matched"
        } else if detail.contains("disabled by caller") {
            "not_configured"
        } else if detail.contains("batch result reused") {
            "batch_reused"
        } else if detail.contains("batch unavailable") {
            "unavailable"
        } else if detail.contains("queue_busy") || detail.contains("pacing") {
            "queue_busy"
        } else if detail.contains("daily_quota") {
            "daily_quota"
        } else if detail.contains("upstream_rate_limit") {
            "rate_limited"
        } else if detail.contains("captcha") {
            "blocked"
        } else if detail.contains("401") || detail.contains("unauthorized") {
            "unauthorized"
        } else if detail.contains("403") || detail.contains("forbidden") {
            "forbidden"
        } else if detail.contains("429") || detail.contains("rate-limit") {
            "rate_limited"
        } else if detail.contains("timeout")
            || detail.contains("timed out")
            || detail.contains("budget exhausted")
        {
            "timeout"
        } else if detail.contains("unreachable")
            || detail.contains("connecterror")
            || detail.contains("remoteprotocolerror")
        {
            "connection_failed"
        } else if detail.contains("server error")
            || ["500", "502", "503", "504"]
                .iter()
                .any(|code| detail.contains(code))
        {
            "server_error"
        } else if detail.contains("no publication found") {
            "no_match"
        } else if detail.contains("failure")
            || detail.contains("disabled")
            || detail.contains("error")
        {
            "unavailable"
        } else {
            "unknown"
        };
        sources.insert(source.to_string(), outcome.to_string());
    }
    sources
        .into_iter()
        .map(|(source, outcome)| SourceCheck { source, outcome })
        .collect()
}

fn metadata_sources(output: &Output, checked: &AuditResult) -> Vec<SourceCheck> {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut sources = publication_sources(&stderr);
    let verified = checked.status == "checked" || checked.status == "update";
    if !verified {
        for source in &mut sources {
            if source.outcome == "matched" {
                source.outcome = "candidate".into();
            }
        }
    }
    if let Some(source) = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .ok()
        .and_then(|value| {
            value
                .get("source")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
    {
        sources.retain(|row| row.source != source);
        let cached = stderr.lines().any(|line| line.starts_with("[cache] hit:"));
        sources.push(SourceCheck {
            source,
            outcome: match (verified, cached) {
                (true, false) => "selected",
                (true, true) => "selected_cached",
                (false, false) => "candidate",
                (false, true) => "candidate_cached",
            }
            .into(),
        });
    }
    sources
}

fn compare_doi_entry(before: &str, remote: &str) -> AuditResult {
    let local = fields(before);
    let other = fields(remote);
    let doi = local.get("doi").and_then(|v| normalize_doi(v));
    if doi.is_none() || doi != other.get("doi").and_then(|v| normalize_doi(v)) {
        return identity_conflict(before, remote);
    }
    if !metadata_identity_matches(before, remote) {
        return identity_conflict(before, remote);
    }
    merge_metadata(before, remote, false)
}

fn compare_title_entry(before: &str, remote: &str) -> AuditResult {
    if !metadata_identity_matches(before, remote) {
        return identity_conflict(before, remote);
    }
    merge_metadata(before, remote, false)
}

fn identity_conflict(before: &str, remote: &str) -> AuditResult {
    let mut checked = result("unavailable", "Paper identity could not be confirmed. Review the candidate manually; no replacement is offered.", before.into());
    checked.publication_reason = Some("identity_conflict".into());
    checked.candidate = Some(AuditCandidate {
        bibtex: remote.into(),
        changes: differing_fields(before, remote),
        reasons: identity_conflicts(before, remote),
    });
    checked
}

fn unversioned_arxiv(id: &str) -> &str {
    id.rsplit_once('v')
        .filter(|(_, version)| !version.is_empty() && version.chars().all(|c| c.is_ascii_digit()))
        .map(|(id, _)| id)
        .unwrap_or(id)
}

fn is_preprint_venue(venue: &str) -> bool {
    // Match markers as words, not substrings of journals such as Corrosion Science.
    venue
        .to_ascii_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| matches!(word, "arxiv" | "preprint" | "corr" | "biorxiv" | "medrxiv"))
}

fn identity_missing_fields(entry: &str) -> Vec<String> {
    let values = fields(entry);
    ["title"]
        .into_iter()
        .filter(|name| {
            values
                .get(*name)
                .is_none_or(|value| clean(value).is_empty())
        })
        .map(str::to_string)
        .collect()
}

fn is_clean_lookup_miss(output: &Output) -> bool {
    output.status.code() == Some(2)
        && publication_sources(&String::from_utf8_lossy(&output.stderr))
            .iter()
            .all(|source| {
                matches!(
                    source.outcome.as_str(),
                    "no_match" | "not_configured" | "batch_reused"
                )
            })
        && String::from_utf8_lossy(&output.stderr).lines().any(|line| {
            line.starts_with("[bibcite] No match found anywhere for:")
                || line.starts_with("[bibcite] Only an arXiv preprint was found for:")
        })
}

fn differing_fields(before: &str, remote: &str) -> Vec<FieldChange> {
    let mut a = fields(before);
    let mut b = fields(remote);
    a.insert("ENTRYTYPE".into(), entry_type(before.trim()));
    b.insert("ENTRYTYPE".into(), entry_type(remote.trim()));
    [
        "ENTRYTYPE",
        "title",
        "author",
        "year",
        "journal",
        "booktitle",
        "doi",
        "eprint",
    ]
    .into_iter()
    .filter_map(|field| {
        let before = a.get(field).map(|v| clean(v)).unwrap_or_default();
        let after = b.get(field).map(|v| clean(v)).unwrap_or_default();
        let equivalent = if field == "author" {
            author_names(&before) == author_names(&after)
        } else {
            normalize_text(&before) == normalize_text(&after)
        };
        (!equivalent).then(|| FieldChange {
            field: field.into(),
            before,
            after,
        })
    })
    .collect()
}

fn author_names(authors: &str) -> Vec<Vec<String>> {
    // Decode conventional TeX accents only for comparison. Keep the original
    // field when equivalent, and never discard accents or unknown commands.
    static ACCENT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r#"\\([`'"^~=.uvHckrbd])(?:\s*\{\s*([A-Za-z])\s*\}|\s+([A-Za-z])|([A-Za-z]))"#,
        )
        .unwrap()
    });
    let decoded = ACCENT.replace_all(authors, |captures: &regex::Captures<'_>| {
        // A letter command requires a delimiter: \unknown is not \u nknown.
        if captures.get(4).is_some() && captures[1].chars().all(|c| c.is_ascii_alphabetic()) {
            return captures[0].to_string();
        }
        let mark = match &captures[1] {
            "`" => '\u{0300}',
            "'" => '\u{0301}',
            "^" => '\u{0302}',
            "~" => '\u{0303}',
            "=" => '\u{0304}',
            "u" => '\u{0306}',
            "." => '\u{0307}',
            "\"" => '\u{0308}',
            "r" => '\u{030a}',
            "H" => '\u{030b}',
            "v" => '\u{030c}',
            "d" => '\u{0323}',
            "c" => '\u{0327}',
            "k" => '\u{0328}',
            "b" => '\u{0331}',
            _ => unreachable!("accent regex restricts the command"),
        };
        let base = captures
            .get(2)
            .or_else(|| captures.get(3))
            .or_else(|| captures.get(4))
            .unwrap()
            .as_str();
        format!("{base}{mark}")
    });
    normalize_text(&decoded.replace(['{', '}'], ""))
        .nfc()
        .collect::<String>()
        .split(" and ")
        .map(|name| {
            let mut words = name
                .split(|c: char| !c.is_alphanumeric() && !is_combining_mark(c) && c != '\\')
                .filter(|word| !word.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            words.sort();
            words
        })
        .filter(|name| !name.is_empty())
        .collect()
}

fn has_repeated_authors(authors: &[Vec<String>]) -> bool {
    authors
        .iter()
        .enumerate()
        .any(|(index, name)| authors[..index].contains(name))
}

fn is_safe_local_cleanup(before: &str, after: &str) -> bool {
    // Validate against the actual local cleanup, including every field. A
    // limited display diff would miss an unrelated URL or volume replacement.
    let expected = cleanup_result(result("checked", "", before.into()));
    expected.after.as_deref().is_some_and(|expected| {
        entry_type(expected) == entry_type(after)
            && field_expressions(expected) == field_expressions(after)
    })
}

/// Automatic replacement requires the same normalized title and full, ordered
/// author list. Equivalent BibTeX name order and TeX accent formatting remain
/// valid, but metadata lookup must not silently correct author identity.
pub(crate) fn metadata_identity_matches(before: &str, remote: &str) -> bool {
    identity_conflicts(before, remote).is_empty()
}

fn identity_conflicts(before: &str, remote: &str) -> Vec<String> {
    let remote = remote.trim();
    let spans = project::bibliography_entry_spans(remote);
    if spans.len() != 1 || spans[0].1 != 0 || spans[0].2 != remote.len() || !complete_entry(remote)
    {
        return vec!["record".into()];
    }
    let mut reasons = Vec::new();
    // A same-title paper is not a published version of an explicit book or
    // chapter. Keep this separate from legitimate preprint/type corrections.
    if matches!(
        entry_type(before.trim()).as_str(),
        "book" | "booklet" | "collection" | "inbook" | "incollection"
    ) && matches!(
        entry_type(remote).as_str(),
        "article" | "inproceedings" | "conference" | "proceedings"
    ) {
        reasons.push("ENTRYTYPE".into());
    }
    let local = fields(before);
    let other = fields(remote);
    let value = |fields: &BTreeMap<String, String>, name: &str| {
        fields.get(name).cloned().unwrap_or_default()
    };
    let title = normalize_title(&value(&local, "title"));
    let remote_title = normalize_title(&value(&other, "title"));
    if remote_title.is_empty() || (!title.is_empty() && title != remote_title) {
        reasons.push("title".into());
    }
    let local_authors = author_names(&value(&local, "author"));
    let remote_authors = author_names(&value(&other, "author"));
    let local_doi = local
        .get("doi")
        .and_then(|v| normalize_doi(v))
        .or_else(|| local.get("url").and_then(|v| normalize_doi(v)));
    let remote_doi = other
        .get("doi")
        .and_then(|v| normalize_doi(v))
        .or_else(|| other.get("url").and_then(|v| normalize_doi(v)));
    let local_arxiv = project::bibliography_arxiv_id(&local);
    let remote_arxiv = project::bibliography_arxiv_id(&other);
    let same_identifier = local_doi
        .as_ref()
        .is_some_and(|doi| Some(doi) == remote_doi.as_ref())
        || local_arxiv
            .as_deref()
            .zip(remote_arxiv.as_deref())
            .is_some_and(|(a, b)| unversioned_arxiv(a) == unversioned_arxiv(b));
    if title.is_empty() && !same_identifier {
        reasons.push("title".into());
    }
    if let Some(doi) = local_doi.as_deref().filter(|v| !v.starts_with("10.48550/")) {
        if remote_doi.as_deref() != Some(doi) {
            reasons.push("doi".into());
        }
    }
    if let (Some(a), Some(b)) = (local_arxiv.as_deref(), remote_arxiv.as_deref()) {
        if unversioned_arxiv(a) != unversioned_arxiv(b) {
            reasons.push("arxiv".into());
        }
    }
    if let (Ok(a), Ok(b)) = (
        value(&local, "year").trim().parse::<u32>(),
        value(&other, "year").trim().parse::<u32>(),
    ) {
        if a.abs_diff(b) > 2 {
            reasons.push("year".into());
        }
    }
    let venue = |fields: &BTreeMap<String, String>| {
        let venue = fields
            .get("booktitle")
            .or_else(|| fields.get("journal"))
            .or_else(|| fields.get("journaltitle"));
        let normalized = normalize_title(venue.map(String::as_str).unwrap_or(""));
        // A leading proceedings year is not part of the venue's identity.
        normalized
            .split_once(' ')
            .filter(|(head, _)| head.len() == 4 && head.chars().all(|c| c.is_ascii_digit()))
            .map(|(_, rest)| rest.to_string())
            .unwrap_or(normalized)
    };
    // ACL Anthology encodes Findings in the DOI. Never accept a source's
    // lossy conference normalization as evidence that this is the main track.
    if remote_doi
        .as_deref()
        .is_some_and(|doi| doi.starts_with("10.18653/v1/") && doi.contains(".findings-"))
        && !venue(&other)
            .split_whitespace()
            .any(|word| word == "findings")
    {
        reasons.push("venue".into());
    }
    if local_authors.is_empty()
        || remote_authors.is_empty()
        || local_authors != remote_authors
        || has_repeated_authors(&remote_authors)
    {
        reasons.push("author".into());
    }
    reasons
}

fn merge_metadata(before: &str, remote: &str, published: bool) -> AuditResult {
    let local = fields(before);
    let other = fields(remote);
    let core = [
        "title",
        "author",
        "year",
        "journal",
        "booktitle",
        "publisher",
        "volume",
        "number",
        "pages",
        "doi",
        "url",
    ];
    let changes = core
        .iter()
        .filter_map(|name| {
            let a = local.get(*name).map(|v| clean(v)).unwrap_or_default();
            let b = other.get(*name).map(|v| clean(v)).unwrap_or_default();
            let equivalent = if *name == "author" {
                author_names(&a) == author_names(&b)
            } else if *name == "title" {
                // Keep local case-protection braces when correcting metadata.
                normalize_title(&a) == normalize_title(&b)
            } else {
                normalize_text(&a) == normalize_text(&b)
            };
            (!b.is_empty() && !equivalent).then(|| FieldChange {
                field: (*name).into(),
                before: a,
                after: b,
            })
        })
        .collect::<Vec<_>>();
    let mut merged = field_expressions(before);
    if local.keys().any(|key| !merged.contains_key(key)) {
        return result(
            "unavailable",
            "Could not safely preserve this entry's BibTeX expressions.",
            before.into(),
        );
    }
    for change in &changes {
        if let Some(raw) = other.get(&change.field) {
            merged.insert(change.field.clone(), format!("{{{raw}}}"));
        }
    }
    if published || entry_type(before) != entry_type(remote) {
        for name in ["journal", "booktitle"] {
            if !other.contains_key(name) {
                merged.remove(name);
            }
        }
    }
    // Mirror bibcite.clean_publication_fields after merging local expressions;
    // normalizing remote metadata alone cannot remove obsolete local fields.
    // Keep this in-process so S2 batches don't spawn one CLI per entry.
    merged.remove("primaryclass");
    let has_publication = ["journal", "booktitle"].iter().any(|name| {
        merged.get(*name).is_some_and(|value| {
            if !value.trim_start().starts_with(['{', '"']) {
                return false;
            }
            let value = clean(value).to_lowercase();
            !value.is_empty() && !is_preprint_venue(&value)
        })
    });
    if has_publication
        && merged
            .get("pubstate")
            .is_none_or(|value| !clean(value).eq_ignore_ascii_case("preprint"))
        && merged.get("howpublished").is_some_and(|value| {
            let value = value.to_lowercase();
            value.contains("arxiv") || value.contains("preprint")
        })
    {
        merged.remove("howpublished");
    }
    // The remote record's explicit type is evidence. A booktitle alone is not:
    // chapters and conference papers both commonly carry one.
    let remote_type = remote
        .trim_start()
        .trim_start_matches('@')
        .split(['{', '('])
        .next()
        .unwrap_or("article");
    // S2 sometimes emits @article with only a conference booktitle. Correct
    // that known malformed shape, but never generalize booktitle to conference
    // for explicit chapter/book types.
    let entry_type = if remote_type.eq_ignore_ascii_case("article")
        && other.contains_key("booktitle")
        && !other.contains_key("journal")
    {
        "inproceedings"
    } else {
        remote_type
    };
    let spans = project::bibliography_entry_spans(before);
    let key = spans.first().map(|v| v.0.as_str()).unwrap_or("citation");
    let mut after = format!("@{entry_type}{{{key},\n");
    for (name, value) in merged {
        after.push_str(&format!("  {name} = {value},\n"));
    }
    after.push('}');
    proposal(before, after, "DOI metadata corrections are available.")
}

// Local repairs must remain available even when a remote candidate is rejected.
// They modify the current entry, never fields from that rejected candidate.
fn cleanup_result(checked: AuditResult) -> AuditResult {
    if checked.status == "conflict" {
        return checked;
    }
    let source = checked.after.as_deref().unwrap_or(&checked.before);
    if !complete_entry(source) {
        return checked;
    }
    let values = fields(source);
    let mut expressions = field_expressions(source);
    if values.keys().any(|key| !expressions.contains_key(key)) {
        return checked;
    }
    let mut changed = false;
    if let Some(author) = expressions
        .get("author")
        .and_then(|raw| deduplicated_authors(raw))
    {
        expressions.insert("author".into(), author);
        changed = true;
    }
    // TMLR's annual index and ICLR's proceedings export use the year as a
    // volume label. Omit that redundant label, not genuine numbered volumes
    // (including NeurIPS/PMLR or other journals with year-shaped volumes).
    let venue = normalize_text(
        values
            .get("journal")
            .or_else(|| values.get("booktitle"))
            .map(String::as_str)
            .unwrap_or(""),
    );
    let annual_venue = matches!(
        venue.as_str(),
        "tmlr"
            | "transactions on machine learning research"
            | "transactions on machine learning research (tmlr)"
            | "iclr"
            | "international conference on learning representations"
            | "international conference on learning representations (iclr)"
    );
    if annual_venue
        && values.get("year").is_some_and(|year| {
            year.len() == 4 && year.parse::<u32>().is_ok() && values.get("volume") == Some(year)
        })
    {
        expressions.remove("volume");
        changed = true;
    }
    if !changed {
        return checked;
    }
    let spans = project::bibliography_entry_spans(source);
    let Some((key, _, _)) = spans.first().filter(|_| spans.len() == 1) else {
        return checked;
    };
    let mut after = format!("@{}{{{key},\n", entry_type(source));
    for (name, value) in expressions {
        after.push_str(&format!("  {name} = {value},\n"));
    }
    after.push('}');
    let mut cleaned = proposal(&checked.before, after, "Bibliography cleanup is available. Only the proposed changes will be applied; rejected source metadata is not used.");
    cleaned.sources = checked.sources;
    cleaned.health = checked.health;
    // Keep an incomplete health verdict when combining with a remote update.
    if checked.after.is_some() && checked.status == "unavailable" {
        cleaned.status = checked.status;
        cleaned.message = checked.message;
    }
    cleaned
}

fn deduplicated_authors(raw: &str) -> Option<String> {
    let body = raw
        .strip_prefix('{')
        .and_then(|v| v.strip_suffix('}'))
        .or_else(|| raw.strip_prefix('"').and_then(|v| v.strip_suffix('"')))?;
    let mut names = Vec::new();
    let (mut depth, mut escaped, mut start) = (0i32, false, 0);
    for (index, character) in body.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == '{' {
            depth += 1;
        }
        if character == '}' {
            depth -= 1;
        }
        if depth < 0 || (depth == 0 && character == '#') {
            return None;
        }
        if depth == 0
            && body
                .get(index..index + 3)
                .is_some_and(|word| word.eq_ignore_ascii_case("and"))
            && body[..index]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace)
            && body[index + 3..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        {
            names.push(body[start..index].trim());
            start = index + 3;
        }
    }
    if depth != 0 {
        return None;
    }
    names.push(body[start..].trim());
    let mut seen = Vec::new();
    let mut kept = Vec::new();
    for name in &names {
        if name.is_empty() {
            return None;
        }
        // Preserve the order of name parts: "Li Wang" and "Wang Li" may be
        // different people. Only explicit BibTeX commas authorize reordering.
        let normalized = if !name.contains(['{', '}']) && name.matches(',').count() == 1 {
            let (family, given) = name.split_once(',').unwrap();
            normalize_text(&format!("{} {}", given.trim(), family.trim()))
        } else {
            normalize_text(name)
        };
        if !seen.contains(&normalized) {
            seen.push(normalized);
            kept.push(*name);
        }
    }
    (kept.len() < names.len()).then(|| format!("{{{}}}", kept.join(" and ")))
}

fn proposal(before: &str, after: String, message: &str) -> AuditResult {
    let a = fields(before);
    let b = fields(&after);
    let mut all = a
        .keys()
        .chain(b.keys())
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    all.insert("ENTRYTYPE".into());
    let changes: Vec<FieldChange> = all
        .iter()
        .filter_map(|field| {
            let old = a.get(field).map(|v| clean(v)).unwrap_or_default();
            let new = b.get(field).map(|v| clean(v)).unwrap_or_default();
            let (old, new) = if field == "ENTRYTYPE" {
                (entry_type(before), entry_type(&after))
            } else {
                (old, new)
            };
            (normalize_text(&old) != normalize_text(&new)).then(|| FieldChange {
                field: field.clone(),
                before: old,
                after: new,
            })
        })
        .collect();
    if changes.is_empty() {
        return result("checked", "No update found.", before.into());
    }
    AuditResult {
        status: "update".into(),
        message: message.into(),
        publication_reason: None,
        sources: vec![],
        before: before.into(),
        after: Some(after),
        candidate: None,
        changes,
        health: None,
    }
}

fn result(status: &str, message: &str, before: String) -> AuditResult {
    AuditResult {
        status: status.into(),
        message: message.into(),
        publication_reason: None,
        sources: vec![],
        before,
        after: None,
        candidate: None,
        changes: vec![],
        health: None,
    }
}
fn fields(entry: &str) -> BTreeMap<String, String> {
    entry
        .find(',')
        .map(|i| {
            let body = entry[i + 1..].trim_end();
            let body = body
                .strip_suffix('}')
                .or_else(|| body.strip_suffix(')'))
                .unwrap_or(body);
            project::parse_bibliography_fields_raw(body)
        })
        .unwrap_or_default()
}

fn local_validation(entry: &str) -> Vec<String> {
    let kind = entry_type(entry);
    let values = fields(entry);
    let syntax = field_expressions(entry);
    let mut issues = Vec::new();
    let supported = [
        "article",
        "book",
        "booklet",
        "conference",
        "inbook",
        "incollection",
        "inproceedings",
        "manual",
        "mastersthesis",
        "misc",
        "phdthesis",
        "proceedings",
        "techreport",
        "unpublished",
        "collection",
        "electronic",
        "mvbook",
        "mvcollection",
        "mvproceedings",
        "online",
        "patent",
        "periodical",
        "reference",
        "report",
        "suppbook",
        "suppcollection",
        "suppperiodical",
        "thesis",
        "www",
        // Additional BibLaTeX core and standard-style types. Their schemas are
        // intentionally not guessed below when requirements vary by style.
        "artwork",
        "audio",
        "bibnote",
        "commentary",
        "customa",
        "customb",
        "customc",
        "customd",
        "custome",
        "customf",
        "dataset",
        "entryset",
        "image",
        "jurisdiction",
        "legal",
        "legislation",
        "letter",
        "movie",
        "music",
        "performance",
        "review",
        "set",
        "software",
        "standard",
        "video",
        "xdata",
    ];
    if !supported.contains(&kind.as_str()) {
        issues.push(format!("Unknown bibliography entry type `{kind}`."));
    }

    for (name, value) in &values {
        if value.trim().is_empty() {
            issues.push(format!("Empty {name} field."));
        }
    }
    if values
        .get("author")
        .is_some_and(|value| has_repeated_authors(&author_names(value)))
    {
        issues.push("Repeated author names; verify against the publication's author list before removing duplicates.".into());
    }

    // A cross-referenced child may inherit every type-required field. Without
    // resolving the parent bibliography, reporting those fields as absent is
    // misleading; checks on fields explicitly present still apply.
    let inherits = values
        .get("crossref")
        .or_else(|| values.get("xref"))
        .or_else(|| values.get("xdata"))
        .is_some_and(|value| !value.trim().is_empty());
    if !inherits {
        let present = |name: &str| values.get(name).is_some_and(|v| !v.trim().is_empty());
        let require = |name: &str, issues: &mut Vec<String>| {
            if !present(name) {
                issues.push(format!("Missing {name} field for {kind} entry."));
            }
        };
        let contributor = |issues: &mut Vec<String>| {
            if !present("author") && !present("editor") {
                issues.push(format!("Missing author or editor field for {kind} entry."));
            }
        };
        let year = |issues: &mut Vec<String>| {
            if !present("year") && !present("date") {
                issues.push(format!("Missing year or date field for {kind} entry."));
            }
        };

        match kind.as_str() {
            "article" => {
                require("author", &mut issues);
                require("title", &mut issues);
                if !present("journaltitle") {
                    require("journal", &mut issues);
                }
                year(&mut issues);
            }
            "book" | "mvbook" | "reference" | "suppbook" => {
                contributor(&mut issues);
                require("title", &mut issues);
                require("publisher", &mut issues);
                year(&mut issues);
            }
            "inproceedings" | "conference" => {
                require("author", &mut issues);
                require("title", &mut issues);
                require("booktitle", &mut issues);
                year(&mut issues);
            }
            "incollection" | "suppcollection" => {
                require("author", &mut issues);
                require("title", &mut issues);
                require("booktitle", &mut issues);
                require("publisher", &mut issues);
                year(&mut issues);
            }
            "inbook" => {
                contributor(&mut issues);
                require("title", &mut issues);
                if !present("chapter") && !present("pages") {
                    issues.push("Missing chapter or pages field for inbook entry.".into());
                }
                require("publisher", &mut issues);
                year(&mut issues);
            }
            "mastersthesis" | "phdthesis" => {
                require("author", &mut issues);
                require("title", &mut issues);
                require("school", &mut issues);
                year(&mut issues);
            }
            "thesis" => {
                require("author", &mut issues);
                require("title", &mut issues);
                require("institution", &mut issues);
                year(&mut issues);
            }
            "techreport" | "report" => {
                require("author", &mut issues);
                require("title", &mut issues);
                require("institution", &mut issues);
                year(&mut issues);
            }
            "proceedings" | "collection" | "mvcollection" | "mvproceedings" => {
                require("title", &mut issues);
                year(&mut issues);
            }
            "unpublished" => {
                require("author", &mut issues);
                require("title", &mut issues);
                require("note", &mut issues);
            }
            "online" | "electronic" | "www" => {
                contributor(&mut issues);
                require("title", &mut issues);
                require("url", &mut issues);
                year(&mut issues);
            }
            "booklet" | "manual" | "periodical" | "suppperiodical" => {
                require("title", &mut issues);
            }
            "patent" => {
                contributor(&mut issues);
                require("title", &mut issues);
                require("number", &mut issues);
                year(&mut issues);
            }
            // BibTeX deliberately defines no required fields for misc.
            _ => {}
        }
    }

    if kind == "article"
        && !values.contains_key("journal")
        && !values.contains_key("journaltitle")
        && values.contains_key("booktitle")
    {
        issues.push("Article entry uses booktitle instead of journal.".into());
    }
    if matches!(kind.as_str(), "inproceedings" | "conference")
        && !values.contains_key("booktitle")
        && (values.contains_key("journal") || values.contains_key("journaltitle"))
    {
        let label = if kind == "conference" {
            "Conference"
        } else {
            "Inproceedings"
        };
        issues.push(format!("{label} entry uses journal instead of booktitle."));
    }

    if let Some(year) = syntax.get("year") {
        let expression = year.trim();
        let value = values.get("year").map(String::as_str).unwrap_or("");
        let literal = expression == format!("{{{value}}}")
            || expression == format!("\"{value}\"")
            || expression
                .chars()
                .all(|character| character.is_ascii_digit());
        let value = value.trim();
        if literal
            && !value.is_empty()
            && (value.len() != 4 || !value.chars().all(|character| character.is_ascii_digit()))
        {
            issues.push("Invalid literal year; expected four digits.".into());
        }
    }
    issues
}
fn clean(value: &str) -> String {
    value.trim().to_string()
}
fn normalize_text(value: &str) -> String {
    value
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn normalize_title(value: &str) -> String {
    normalize_text(value).replace(['{', '}'], "")
}
fn bibliography_construct_count(source: &str) -> usize {
    let bytes = source.as_bytes();
    let mut cursor = 0;
    let mut count = 0;
    while let Some(offset) = source[cursor..].find('@') {
        let mut position = cursor + offset + 1;
        let start = position;
        while bytes.get(position).is_some_and(u8::is_ascii_alphabetic) {
            position += 1;
        }
        let kind = source[start..position].to_ascii_lowercase();
        while bytes.get(position).is_some_and(u8::is_ascii_whitespace) {
            position += 1;
        }
        if bytes
            .get(position)
            .is_some_and(|b| matches!(b, b'{' | b'('))
            && !matches!(kind.as_str(), "comment" | "preamble" | "string")
        {
            count += 1;
        }
        cursor = (cursor + offset + 1).min(source.len());
    }
    count
}
fn normalize_doi(value: &str) -> Option<String> {
    project::normalize_doi(value)
}

fn entry_type(entry: &str) -> String {
    entry
        .trim_start_matches('@')
        .split(['{', '('])
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

pub(crate) fn complete_entry(entry: &str) -> bool {
    let Some(start) = entry.find(['{', '(']) else {
        return false;
    };
    let opening = entry.as_bytes()[start];
    let closing = if opening == b'{' { b'}' } else { b')' };
    let mut depth = 0i32;
    let mut quoted = false;
    let mut escaped = false;
    for (i, byte) in entry.bytes().enumerate().skip(start) {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }
        if byte == b'"' {
            quoted = !quoted;
        }
        if !quoted {
            if byte == opening {
                depth += 1;
            }
            if byte == closing {
                depth -= 1;
                if depth == 0 {
                    return i + 1 == entry.len();
                }
            }
        }
    }
    false
}

// Preserve raw expressions (macros, concatenation, protected capitals) in
// untouched fields rather than converting every value to a braced literal.
fn field_expressions(entry: &str) -> BTreeMap<String, String> {
    let Some(start) = entry.find(',') else {
        return BTreeMap::new();
    };
    let body = &entry[start + 1..entry.len() - 1];
    let mut fields = BTreeMap::new();
    let (mut depth, mut quoted, mut escaped, mut start) = (0i32, false, false, 0usize);
    for (i, byte) in body.bytes().chain(std::iter::once(b',')).enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }
        if byte == b'"' && depth == 0 {
            quoted = !quoted;
        }
        if !quoted {
            if byte == b'{' {
                depth += 1;
            }
            if byte == b'}' {
                depth -= 1;
            }
            if byte == b',' && depth == 0 {
                if let Some((name, value)) = body[start..i].split_once('=') {
                    let name = name.trim().to_ascii_lowercase();
                    if name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                    {
                        fields.insert(name, value.trim().into());
                    }
                }
                start = i + 1;
            }
        }
    }
    fields
}

fn parse_get_output(output: &Output) -> Result<String, String> {
    if !output.status.success() {
        let e = String::from_utf8_lossy(&output.stderr);
        return Err(if e.trim().is_empty() {
            "bibcite failed".into()
        } else {
            e.trim().into()
        });
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "bibcite returned invalid JSON")?;
    value
        .get("bibtex")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "bibcite returned no exact BibTeX record".into())
}

fn run_bibcite(args: &[&str], command: Option<Command>) -> Result<Output, String> {
    let mut command = match command {
        Some(c) => c,
        None => commands::BIBCITE.command()?,
    };
    // File-backed capture cannot deadlock when a verbose provider fills a pipe
    // while the parent is polling the child's deadline.
    let capture = TempFile::new("")?;
    let stdout = capture.dir.join("stdout");
    let stderr = capture.dir.join("stderr");
    command
        .args(args)
        .stdout(Stdio::from(
            fs::File::create(&stdout).map_err(|e| e.to_string())?,
        ))
        .stderr(Stdio::from(
            fs::File::create(&stderr).map_err(|e| e.to_string())?,
        ));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| crate::papers::uv_tool_spawn_error("bibcite", &e))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(commands::redact_bibcite_output(
                &command,
                Output {
                    status,
                    stdout: fs::read(&stdout).map_err(|e| e.to_string())?,
                    stderr: fs::read(&stderr).map_err(|e| e.to_string())?,
                },
            ));
        }
        if Instant::now() >= deadline {
            #[cfg(unix)]
            if let Ok(group) = i32::try_from(child.id()) {
                // uv may launch the CLI as a child; stop the whole isolated
                // group so a timeout does not leave provider requests running.
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err("bibcite timed out after 60 seconds".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

struct TempFile {
    dir: PathBuf,
    path: PathBuf,
}
impl TempFile {
    fn new(contents: &str) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!("lattice-bib-audit-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        // Provider stderr may contain credentials until it has been redacted.
        builder.create(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("entry.bib");
        if let Err(e) = fs::write(&path, contents) {
            let _ = fs::remove_dir_all(&dir);
            return Err(e.to_string());
        }
        Ok(Self { dir, path })
    }
}
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compare_batch(before: &str, paper: &crate::citation_batch::Paper) -> Option<AuditResult> {
        let bibtex = &paper.citation_styles.as_ref()?.bibtex;
        let parsed = fields(bibtex);
        let venue = parsed.get("journal").or_else(|| parsed.get("booktitle"));
        batch_comparison(before, paper, bibtex, venue.map(String::as_str))
    }

    fn project_root() -> PathBuf {
        let parent =
            std::env::temp_dir().join(format!("lattice-audit-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        project::create_blank(&parent, "Audit").unwrap()
    }

    #[test]
    fn persisted_reports_are_project_scoped_and_preserve_unknown_fields() {
        let root = project_root();
        let parent = root.parent().unwrap();
        let other_root = project::create_blank(parent, "Other").unwrap();
        let data_dir = parent.join("app-data");
        let report = vec![(
            "citation-key".to_string(),
            serde_json::json!({
                "status": "checked",
                "checkedAt": "2026-09-07T12:00:00Z",
                "futureField": {"preserved": true}
            }),
        )];

        assert_eq!(load_report(&data_dir, &root).unwrap(), None);
        save_report(&data_dir, &root, report.clone()).unwrap();
        assert_eq!(load_report(&data_dir, &root).unwrap(), Some(report));
        assert_eq!(
            load_report(&data_dir, &root.join(".")).unwrap().unwrap()[0].1["checkedAt"],
            "2026-09-07T12:00:00Z"
        );
        assert_eq!(load_report(&data_dir, &other_root).unwrap(), None);

        save_report(&data_dir, &other_root, Vec::new()).unwrap();
        assert_eq!(
            load_report(&data_dir, &other_root).unwrap(),
            Some(Vec::new())
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn malformed_persisted_report_returns_an_error() {
        let root = project_root();
        let parent = root.parent().unwrap();
        let data_dir = parent.join("app-data");
        let relative = report_relative_path(&root).unwrap();
        fs::create_dir_all(data_dir.join(REPORT_DIRECTORY)).unwrap();
        fs::write(data_dir.join(relative), b"{not a report").unwrap();

        let error = load_report(&data_dir, &root).unwrap_err();
        assert!(error.contains("malformed"), "{error}");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn doi_normalization_is_exact() {
        assert_eq!(
            normalize_doi("https://doi.org/10.1234/ABC"),
            Some("10.1234/abc".into())
        );
        assert_eq!(normalize_doi("arxiv:1"), None);
    }

    #[test]
    #[ignore = "requires installed bibcite 0.6.8; normalizes offline without S2 requests"]
    fn installed_batch_normalizer_preserves_publication_and_venue_identity() {
        let paper = serde_json::from_value(serde_json::json!({
            "externalIds": {"ArXiv":"2401.12345", "DOI":"10.1234/published"},
            "title":"A paper", "venue":"CVPR", "year":2024,
            "citationStyles":{"bibtex":"@inproceedings{remote, title={A paper}, author={Alice Smith}, year={2024}, booktitle={CVPR}}"}
        })).unwrap();
        let mut papers = BTreeMap::from([("ARXIV:2401.12345".into(), paper)]);
        let normalized = normalize_s2_batch(&papers).unwrap();
        let (bibtex, venue) = &normalized["ARXIV:2401.12345"];
        assert_eq!(
            venue.as_deref(),
            Some("IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)")
        );
        let before = "@article{mine, title={A paper}, author={Alice Smith}, year={2024}, eprint={2401.12345}, journal={arXiv}}";
        assert!(batch_comparison(
            before,
            &papers["ARXIV:2401.12345"],
            bibtex,
            venue.as_deref()
        )
        .is_some());
        papers.get_mut("ARXIV:2401.12345").unwrap().venue = Some("ICLR".into());
        let normalized = normalize_s2_batch(&papers).unwrap();
        let (bibtex, venue) = &normalized["ARXIV:2401.12345"];
        assert!(batch_comparison(
            before,
            &papers["ARXIV:2401.12345"],
            bibtex,
            venue.as_deref()
        )
        .is_none());
    }

    #[test]
    fn batch_preprint_upgrade_preserves_key_expressions_and_requires_identity() {
        let before = "@article{mine, title={A paper}, author={Smith, Alice and Jones, Bob}, year={2024}, eprint={2401.12345v2}, journal={arXiv}, month=jan, custom={keep}}";
        assert_eq!(batch_id(before).as_deref(), Some("ARXIV:2401.12345"));
        let mut paper: crate::citation_batch::Paper = serde_json::from_value(serde_json::json!({
            "externalIds": {"ArXiv":"2401.12345", "DOI":"10.1234/published"},
            "title":"A paper", "venue":"ICML", "year":2024,
            "citationStyles":{"bibtex":"@inproceedings{remote, title={A paper}, author={Alice Smith and Bob Jones}, year={2024}, booktitle={ICML}}"}
        })).unwrap();
        let checked = compare_batch(before, &paper).expect("identity safeguards passed");
        let after = checked.after.unwrap();
        assert!(after.starts_with("@inproceedings{mine,"));
        assert!(after.contains("month = jan"));
        assert!(after.contains("custom = {keep}"));
        assert!(after.contains("doi = {10.1234/published}"));
        paper.title = "Different paper".into();
        assert!(compare_batch(before, &paper).is_none());
    }

    #[test]
    fn real_s2_conference_shape_without_doi_is_not_misclassified_as_a_journal() {
        // Shape observed from S2's ARXIV:1706.03762 endpoint: no DOI, and an
        // @Article citation containing booktitle rather than journal.
        let paper: crate::citation_batch::Paper = serde_json::from_value(serde_json::json!({
            "externalIds":{"ArXiv":"1706.03762"},
            "title":"Attention is All you Need", "venue":"Neural Information Processing Systems", "year":2017,
            "citationStyles":{"bibtex":"@Article{Vaswani2017AttentionIA, author={Ashish Vaswani and Noam Shazeer and Niki Parmar and Jakob Uszkoreit and Llion Jones and Aidan N. Gomez and Lukasz Kaiser and I. Polosukhin}, booktitle={Neural Information Processing Systems}, pages={5998-6008}, title={Attention is All you Need}, year={2017}}"}
        })).unwrap();
        let before = "@article{vaswani2017, title={Attention Is All You Need}, author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, I.}, year={2017}, eprint={1706.03762}, journal={arXiv preprint arXiv:1706.03762}}";
        let checked = compare_batch(before, &paper).expect("valid S2 publication retained");
        assert_eq!(checked.status, "update");
        assert!(checked
            .after
            .unwrap()
            .starts_with("@inproceedings{vaswani2017,"));
    }

    #[test]
    fn batch_respects_explicit_preprint_and_rejects_conflicting_bibtex_doi() {
        assert!(batch_id("@article{a, eprint={2401.12345}, pubstate={preprint}}").is_none());
        let before = "@article{mine, title={A paper}, author={A}, year={2024}, doi={10.1234/a}}";
        let paper: crate::citation_batch::Paper = serde_json::from_value(serde_json::json!({
            "externalIds":{"DOI":"10.1234/a"}, "title":"A paper",
            "citationStyles":{"bibtex":"@article{x,title={A paper},doi={10.1234/wrong}}"}
        }))
        .unwrap();
        assert!(compare_batch(before, &paper).is_none());
    }

    #[test]
    fn doi_batch_keeps_normalized_venue_and_metadata_fast_path() {
        let before = "@inproceedings{mine, title={A paper}, author={A}, year={2024}, booktitle={IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)}, doi={10.1234/a}}";
        let paper = |bibtex: &str| {
            serde_json::from_value::<crate::citation_batch::Paper>(serde_json::json!({
                "externalIds":{"DOI":"10.1234/a"}, "title":"A paper",
                "citationStyles":{"bibtex":bibtex}
            }))
            .unwrap()
        };
        let alias = paper("@inproceedings{x, title={A paper}, author={A}, year={2024}, booktitle={2024 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)}, doi={10.1234/a}}");
        assert!(compare_batch(before, &alias).is_some());

        let field_switch = paper("@article{x, title={A paper}, author={A}, year={2024}, journal={IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)}, doi={10.1234/a}}");
        assert!(compare_batch(before, &field_switch).is_some());

        let metadata = paper("@inproceedings{x, title={A paper}, author={A and B}, year={2024}, booktitle={IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)}, doi={10.1234/a}}");
        assert!(compare_batch(before, &metadata).is_none_or(|checked| checked.after.is_none()));
    }

    #[test]
    #[cfg(unix)]
    #[ignore = "sets a process-wide bibcite override; run this subprocess smoke test alone"]
    fn native_am_radio_check_preserves_canonical_conference_venue() {
        use std::os::unix::fs::PermissionsExt;

        // Copied verbatim from .tmp/native-vlm-audit/original.bib. The mock is
        // a local bibcite process, so this exercises check_entry, TempFile,
        // command setup, upgrade parsing, and proposal merging without network I/O.
        let before = "@inproceedings{ranzinger2024amradio,\n  archiveprefix = {arXiv},\n  author = {Mike Ranzinger and Greg Heinrich and Jan Kautz and Pavlo Molchanov},\n  booktitle = {IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},\n  eprint = {2312.06709},\n  primaryclass = {cs.CV},\n  title = {{AM-RADIO:} Agglomerative Vision Foundation Model Reduce All Domains Into One},\n  url = {https://arxiv.org/abs/2312.06709},\n  year = {2024}\n}";
        let root = project_root();
        fs::write(root.join("references.bib"), before).unwrap();
        let mock = root.parent().unwrap().join("mock-bibcite");
        let published = before.replace(
            "  year =",
            "  doi = {10.1234/amradio},\n  pages = {12830--12840},\n  year =",
        );
        let remote = serde_json::json!({"bibtex": published}).to_string();
        fs::write(
            &mock,
            format!("#!/bin/sh\nif [ \"$1\" = get ]; then\nprintf '%s\\n' '{remote}'\nexit 0\nfi\ncat >\"$2\" <<'EOF'\n{published}\nEOF\nprintf '%s\\n' '{{\"entries\":[{{\"matched\":true}}]}}'\n"),
        )
        .unwrap();
        fs::set_permissions(&mock, fs::Permissions::from_mode(0o700)).unwrap();
        unsafe { std::env::set_var("LATTICE_BIBCITE_BIN", &mock) };
        let checked = check_entry(
            &root,
            AuditEntry {
                path: "references.bib".into(),
                key: "ranzinger2024amradio".into(),
                title: "AM-RADIO".into(),
                bibtex: before.into(),
                issues: vec![],
            },
            None,
        )
        .unwrap();
        // The independent record confirms the same arXiv ID and title. Its
        // corrected authors may now replace the upgrade's preserved input list.
        let script = fs::read_to_string(&mock).unwrap();
        fs::write(
            &mock,
            script.replace(&remote, &remote.replace("Greg Heinrich", "Someone Else")),
        )
        .unwrap();
        let corrected = upgrade_preprint(before, None).unwrap();
        // A publication without a DOI must still be independently checked by
        // title. The mock rejects any lookup that allows a preprint fallback.
        let no_doi = published.replace("  doi = {10.1234/amradio},\n", "");
        let no_doi_json = serde_json::json!({"bibtex": no_doi, "source": "dblp"}).to_string();
        fs::write(&mock, format!("#!/bin/sh\nif [ \"$1\" = get ]; then\ncase \"$*\" in *--require-published*) ;; *) exit 3;; esac\nprintf '%s\\n' '{no_doi_json}'\nexit 0\nfi\ncat >\"$2\" <<'EOF'\n{no_doi}\nEOF\nprintf '%s\\n' '{{\"entries\":[{{\"matched\":true,\"source\":\"dblp\"}}]}}'\n")).unwrap();
        let verified = upgrade_preprint(before, None).unwrap();
        assert!(verified.after.is_some());
        assert!(verified
            .sources
            .iter()
            .any(|row| row.source == "dblp" && row.outcome == "selected"));

        let title_only =
            "@misc{titleonly, title={Safe Paper}, author={Alice Smith and Bob Jones}, year={2024}}";
        fs::write(root.join("references.bib"), title_only).unwrap();
        let title_remote = "@inproceedings{remote, title={Safe Paper}, author={Smith, Alice and Jones, Bob}, year={2024}, booktitle={ICLR}}";
        let title_json = serde_json::json!({"bibtex": title_remote, "source":"dblp"}).to_string();
        fs::write(&mock, format!("#!/bin/sh\ncase \"$*\" in *--require-published*) ;; *) exit 3;; esac\nprintf '%s\\n' '{title_json}'\n")).unwrap();
        let request = || AuditEntry {
            path: "references.bib".into(),
            key: "titleonly".into(),
            title: "Safe Paper".into(),
            bibtex: title_only.into(),
            issues: vec![],
        };
        let title_checked = check_entry(&root, request(), None).unwrap();
        assert_eq!(title_checked.status, "update");
        assert!(title_checked
            .after
            .as_ref()
            .unwrap()
            .starts_with("@inproceedings{titleonly,"));
        assert!(!title_checked
            .changes
            .iter()
            .any(|change| change.field == "author"));
        for (code, message, reason) in [
            (
                2,
                "[bibcite] No match found anywhere for: Safe Paper",
                "no_match",
            ),
            (
                3,
                "[bibcite] No match found anywhere for: Safe Paper",
                "metadata_unavailable",
            ),
            (3, "[openalex] host not found", "metadata_unavailable"),
            (2, "[dblp-fuzzy] transient failure: request timed out\n[bibcite] No match found anywhere for: Safe Paper", "metadata_unavailable"),
        ] {
            fs::write(
                &mock,
                format!("#!/bin/sh\nprintf '%s\\n' '{message}' >&2\nexit {code}\n"),
            )
            .unwrap();
            let outcome = check_entry(&root, request(), None).unwrap();
            assert_eq!(outcome.publication_reason.as_deref(), Some(reason));
            assert!(outcome.after.is_none());
        }
        let unavailable = upgrade_preprint(before, None).unwrap();
        assert!(unavailable.after.is_none());
        apply(
            &root,
            "references.bib",
            "titleonly",
            title_only,
            title_checked.after.as_ref().unwrap(),
        )
        .unwrap();
        assert!(fs::read_to_string(root.join("references.bib"))
            .unwrap()
            .contains("booktitle = {ICLR}"));
        unsafe { std::env::remove_var("LATTICE_BIBCITE_BIN") };
        assert_eq!(corrected.status, "update");
        assert!(fields(corrected.after.as_ref().unwrap())["author"].contains("Someone Else"));
        let after = checked
            .after
            .expect("mocked published metadata is proposed");
        assert_eq!(
            clean(fields(&after).get("booktitle").unwrap()),
            "IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)"
        );
        assert_eq!(clean(fields(&after).get("pages").unwrap()), "12830--12840");
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn unchanged_publication_has_no_proposal() {
        let before = "@inproceedings{lora, title={LoRA: Low-Rank Adaptation of Large Language Models}, booktitle={ICLR}, year={2022}}";
        let checked = proposal(
            before,
            before.replace(", ", ",\n  "),
            "A published version is available.",
        );
        assert_eq!(checked.status, "checked");
        assert!(checked.after.is_none());
        assert!(checked.changes.is_empty());
    }

    #[test]
    fn title_candidates_require_full_identity_and_expose_non_applicable_conflicts() {
        let before = "@inproceedings{x, title={Safe Paper}, author={Smith, Alice and Jones, Bob}, year={2024}, booktitle={ICLR}}";
        let good = "@inproceedings{r, title={Safe Paper}, author={Alice Smith and Bob Jones}, year={2024}, booktitle={ICLR}, doi={10.1234/good}}";
        let accepted = compare_title_entry(before, good);
        assert_eq!(accepted.status, "update");
        assert!(accepted.after.is_some());
        assert!(!accepted
            .changes
            .iter()
            .any(|change| change.field == "author"));

        for (remote, reason) in [
            (good.replace("Safe Paper", "Wrong Paper"), "title"),
            (good.replace("Alice Smith and Bob Jones", ""), "author"),
            (good.replace("2024", "2010"), "year"),
        ] {
            let rejected = compare_title_entry(before, &remote);
            assert!(rejected.after.is_none());
            assert_eq!(
                rejected.publication_reason.as_deref(),
                Some("identity_conflict")
            );
            assert!(rejected
                .candidate
                .unwrap()
                .reasons
                .iter()
                .any(|r| r == reason));
        }
    }

    #[test]
    fn equivalent_kernelbench_authors_preserve_local_bibtex() {
        let authors = r"Ouyang, Anne and Guo, Simon and Arora, Simran and Zhang, Alex L and Hu, William and R{\'e}, Christopher and Mirhoseini, Azalia";
        let remote_authors = "Anne Ouyang and Simon Guo and Simran Arora and Alex L. Zhang and William Hu and Christopher Ré and Azalia Mirhoseini";
        let before = format!(
            "@misc{{kernelbench, title={{KernelBench}}, author={{{authors}}}, year={{2025}}}}"
        );
        let remote = format!("@misc{{remote, title={{KernelBench}}, author={{{remote_authors}}}, year={{2025}}, doi={{10.1234/kernelbench}}}}");
        let accepted = compare_title_entry(&before, &remote);
        assert_eq!(accepted.status, "update");
        assert_eq!(fields(&accepted.after.unwrap())["author"], authors);
        assert!(!accepted
            .changes
            .iter()
            .any(|change| change.field == "author"));
        assert!(!differing_fields(&before, &remote)
            .iter()
            .any(|change| change.field == "author"));
        let corrected = compare_title_entry(&before, &remote.replace("Simon Guo", "Sam Guo"));
        assert!(corrected.after.is_none());
        assert_eq!(
            corrected.publication_reason.as_deref(),
            Some("identity_conflict")
        );
        assert!(corrected
            .candidate
            .unwrap()
            .reasons
            .contains(&"author".into()));
    }

    #[test]
    fn author_accents_are_equivalent_without_erasing_identity() {
        for tex in [
            r"R{\'e}, Christopher",
            r"R\'{e}, Christopher",
            r"R\'e, Christopher",
            "Christopher Re\u{301}",
        ] {
            assert_eq!(author_names(tex), author_names("Christopher Ré"), "{tex}");
        }
        assert_eq!(
            author_names(r#"M{\"u}ller, Alice"#),
            author_names("Alice Müller")
        );
        assert_eq!(author_names(r"\v{S}imek, Bob"), author_names("Bob Šimek"));
        assert_ne!(
            author_names("Christopher Ré"),
            author_names("Christopher Re")
        );
        assert_ne!(author_names(r"\bad{e}, Alice"), author_names("Alice Bade"));
        assert_ne!(
            author_names(r"\unknown, Alice"),
            author_names("Alice ŭnknown")
        );
    }

    #[test]
    fn books_cannot_be_replaced_by_same_title_articles() {
        let before = "@book{goodfellow2016deep, title={Deep learning}, author={Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron and Bengio, Yoshua}, volume={1}, year={2016}, publisher={MIT Press}}";
        let wrong = "@article{lecun2015deep, title={Deep learning}, author={Yann LeCun and Yoshua Bengio and Geoffrey E. Hinton}, year={2015}, journal={Nature}, doi={10.1038/nature14539}, eprint={1807.07987}, archiveprefix={arXiv}}";
        // Even matching authors and a nearby year must not turn an explicit book
        // into a paper: bibliographic identity includes this type boundary.
        let same_authors = wrong.replace(
            "Yann LeCun and Yoshua Bengio and Geoffrey E. Hinton",
            "Ian Goodfellow and Yoshua Bengio and Aaron Courville and Yoshua Bengio",
        );
        for remote in [wrong, same_authors.as_str()] {
            let rejected = compare_title_entry(before, remote);
            assert!(rejected.after.is_none());
            let candidate = rejected.candidate.unwrap();
            assert!(candidate.reasons.contains(&"ENTRYTYPE".into()));
            assert!(candidate
                .changes
                .iter()
                .any(|change| change.field == "ENTRYTYPE"
                    && change.before == "book"
                    && change.after == "article"));
            let with_id = before.replacen(", title=", ", doi={10.1234/collision}, title=", 1);
            let remote_with_id = remote.replace("10.1038/nature14539", "10.1234/collision");
            assert!(compare_doi_entry(&with_id, &remote_with_id).after.is_none());
        }
    }

    #[test]
    fn remote_type_corrects_doi_entries_without_turning_chapters_into_conferences() {
        let article = "@inproceedings{x, title={Paper}, author={A}, year={2024}, journal={Journal}, doi={10.1234/x}}";
        let remote_article =
            "@article{r, title={Paper}, author={A}, year={2024}, journal={Journal}, doi={10.1234/x}}";
        assert!(compare_doi_entry(article, remote_article)
            .after
            .unwrap()
            .starts_with("@article{x,"));

        let chapter = "@inproceedings{c, title={Chapter}, author={A}, year={2024}, booktitle={Collected Work}, doi={10.1234/c}}";
        let remote_chapter = "@incollection{r, title={Chapter}, author={A}, year={2024}, booktitle={Collected Work}, doi={10.1234/c}}";
        assert!(compare_doi_entry(chapter, remote_chapter)
            .after
            .unwrap()
            .starts_with("@incollection{c,"));
    }

    #[test]
    fn missing_identity_and_provider_outcomes_stay_distinct() {
        assert_eq!(
            identity_missing_fields("@misc{x,title={Only title}}"),
            Vec::<String>::new()
        );
        let outcomes = publication_sources("[openalex] HTTP 401 unauthorized\n[openalex] HTTP 403 forbidden\n[openalex] HTTP 503 server error");
        assert_eq!(outcomes[0].outcome, "server_error");
    }

    #[test]
    fn final_dblp_diagnostics_include_fuzzy_and_ignore_recovered_timeouts() {
        let failed = publication_sources(
            "[dblp] no publication found\n[dblp-fuzzy] skipped: DBLP lookup budget exhausted",
        );
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].outcome, "timeout");
        let recovered = publication_sources("[dblp-exact] request timed out; retrying once\n[dblp] publication matched\n[semanticscholar] disabled by caller");
        assert_eq!(recovered[0].outcome, "matched");
        assert_eq!(recovered[1].outcome, "not_configured");
    }

    #[test]
    fn cleanup_only_proposal_preserves_identifiers_and_matches_written_content() {
        let before = "@inproceedings{paper, title={Paper}, author={A}, year={2024}, booktitle={CVPR}, doi={10.1109/CVPR52733.2024.01187}, eprint={2102.08981}, archiveprefix={arXiv}, primaryclass={cs.CV}, howpublished={arXiv preprint arXiv:2102.08981}}";
        let checked = compare_doi_entry(before, before);
        assert_eq!(checked.status, "update");
        assert_eq!(checked.changes.len(), 2);
        assert!(checked
            .changes
            .iter()
            .all(
                |change| ["primaryclass", "howpublished"].contains(&change.field.as_str())
                    && change.after.is_empty()
            ));
        let after = checked.after.unwrap();
        assert_eq!(fields(&after).get("doi"), fields(before).get("doi"));
        assert_eq!(fields(&after).get("eprint"), fields(before).get("eprint"));
        assert_eq!(
            fields(&after).get("archiveprefix"),
            fields(before).get("archiveprefix")
        );
        let root = project_root();
        fs::write(root.join("references.bib"), before).unwrap();
        apply(&root, "references.bib", "paper", before, &after).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("references.bib")).unwrap(),
            after
        );
        assert_eq!(compare_doi_entry(&after, &after).status, "checked");
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn preprint_markers_are_words_not_fragments_of_journal_names() {
        assert!(is_preprint_venue("CoRR abs/2401.12345"));
        assert!(is_preprint_venue("arXiv preprint arXiv:2401.12345"));
        assert!(!is_preprint_venue("Corrosion Science"));
        assert!(!is_preprint_venue(
            "Corrosion Engineering, Science and Technology"
        ));
    }

    #[test]
    fn doi_lookup_still_rejects_conflicting_paper_metadata() {
        let before = "@article{mine,title={A specific paper},author={Alice Smith and Bob Jones},year={2024},journal={Journal One},doi={10.1234/a}}";
        for remote in [
            before.replace("A specific paper", "A different paper"),
            before.replace("10.1234/a", "10.1234/other"),
            before.replace("2024", "2014"),
            format!("{before}\n{before}"),
        ] {
            let checked = compare_doi_entry(before, &remote);
            assert!(checked.after.is_none(), "unsafe proposal: {remote}");
            assert_eq!(checked.status, "unavailable");
        }
        let missing_author = before.replace("author={Alice Smith and Bob Jones},", "");
        assert!(compare_doi_entry(&missing_author, before).after.is_none());
        let corrosion = before.replace("Journal One", "Corrosion Science");
        assert!(compare_doi_entry(&corrosion, before).after.is_some());
        let reordered_names =
            before.replace("Alice Smith and Bob Jones", "Smith, Alice and Jones, Bob");
        assert_ne!(
            compare_doi_entry(&reordered_names, before).status,
            "unavailable"
        );
    }

    #[test]
    fn batch_requires_matching_authors_even_for_the_confirmed_arxiv_record() {
        let before = "@article{mine,title={A paper},author={Alice Smith and Bob Jones},year={2024},eprint={2401.12345},journal={arXiv}}";
        let paper = |arxiv: &str, author: &str| {
            serde_json::from_value::<crate::citation_batch::Paper>(serde_json::json!({
            "externalIds":{"ArXiv":arxiv}, "title":"A paper", "venue":"ICML", "year":2024,
            "citationStyles":{"bibtex":format!("@inproceedings{{x,title={{A paper}},author={{{author}}},year={{2024}},booktitle={{ICML}}}}")}
        })).unwrap()
        };
        assert!(
            compare_batch(before, &paper("2401.12345", "Alice Smith and Carol Jones")).is_none()
        );
        assert!(compare_batch(before, &paper("2401.99999", "Alice Smith and Bob Jones")).is_none());
        assert!(compare_batch(before, &paper("2401.12345", "Alice Smith and Bob Jones")).is_some());
    }

    #[test]
    fn confirmed_identifiers_do_not_override_author_identity() {
        for id in ["doi={10.1234/exact}", "eprint={2401.12345}"] {
            let before = format!("@article{{mine,title={{A specific paper}},author={{Smith, Alice and Jones, Bob}},year={{2024}},journal={{Journal One}},{id}}}");
            let remote = before.replace(
                "Smith, Alice and Jones, Bob",
                "Bob Jones and Alicia Smith and Carol Miller",
            );
            let checked = compare_title_entry(&before, &remote);
            assert!(checked.after.is_none());
            assert!(checked
                .candidate
                .unwrap()
                .reasons
                .contains(&"author".into()));
            let without_id = before.replace(&format!(",{id}"), "");
            assert!(compare_title_entry(&without_id, &remote).after.is_none());
            let wrong_id = remote
                .replace("10.1234/exact", "10.1234/other")
                .replace("2401.12345", "2401.99999");
            assert!(compare_title_entry(&before, &wrong_id).after.is_none());
            assert!(compare_title_entry(
                &before,
                &remote.replace("A specific paper", "Another paper")
            )
            .after
            .is_none());
        }
    }

    #[test]
    fn title_matches_reject_truncated_repeated_changed_and_reordered_authors() {
        let full = "Aman Madaan and Niket Tandon and Prakhar Gupta and Skyler Hallinan";
        let remote = format!("@inproceedings{{remote,title={{Self-Refine: Iterative Refinement with Self-Feedback}},author={{{full}}},year={{2023}},booktitle={{NeurIPS}}}}");
        for authors in [
            "Madaan, Aman and Tandon, Niket and Gupta, Prakhar and others",
            "Madaan, Aman and Tandon, Niket and Aman Madaan and Gupta, Prakhar and Skyler Hallinan",
        ] {
            let before = remote.replace(full, authors).replace("{remote,", "{mine,");
            let checked = compare_title_entry(&before, &remote);
            assert!(checked.after.is_none());
            assert!(checked
                .candidate
                .unwrap()
                .reasons
                .contains(&"author".into()));
            for corrected in [
                remote.replace("Niket Tandon", "Another Person"),
                remote.replace(
                    "Aman Madaan and Niket Tandon",
                    "Niket Tandon and Aman Madaan",
                ),
                remote.replace("2023", "2024"),
                remote.replace("NeurIPS", "ICML"),
            ] {
                assert!(
                    compare_title_entry(&before, &corrected).after.is_none(),
                    "{corrected}"
                );
            }
        }
        let only_others = remote.replace(full, "others");
        assert!(compare_title_entry(&only_others, &remote).after.is_none());
    }

    #[test]
    fn reflexion_title_match_rejects_removed_or_missing_authors() {
        let before = "@inproceedings{shinn2023reflexion,title={Reflexion: Language Agents with Verbal Reinforcement Learning},author={Shinn, Noah and Cassano, Federico and Berman, Edward and Gopinath, Ashwin and Narasimhan, Karthik and Yao, Shunyu},booktitle={NeurIPS},year={2023}}";
        let authors = "Noah Shinn and Federico Cassano and Ashwin Gopinath and Karthik Narasimhan and Shunyu Yao";
        let remote = format!("@inproceedings{{source,title={{Reflexion: language agents with verbal reinforcement learning}},author={{{authors}}},booktitle={{NeurIPS}},year={{2023}}}}");
        let checked = compare_title_entry(before, &remote);
        assert!(checked.after.is_none());
        assert!(checked
            .candidate
            .unwrap()
            .reasons
            .contains(&"author".into()));
        let missing_authors = before.replace("author={Shinn, Noah and Cassano, Federico and Berman, Edward and Gopinath, Ashwin and Narasimhan, Karthik and Yao, Shunyu},", "");
        assert!(identity_missing_fields(&missing_authors).is_empty());
        let missing = compare_title_entry(&missing_authors, &remote);
        assert!(missing.after.is_none());
        assert!(missing
            .candidate
            .unwrap()
            .reasons
            .contains(&"author".into()));
        assert!(
            compare_title_entry(before, &remote.replace("Reflexion:", "Different paper:"))
                .after
                .is_none()
        );
    }

    #[test]
    fn local_author_cleanup_is_applicable_without_accepting_a_wrong_source() {
        let before = "@book{deep,title={Deep learning},author={Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron and Bengio, Yoshua},year={2016},publisher={MIT Press},volume={1},month=jan,note={Keep {NASA}}}";
        let wrong = "@article{other,title={Deep learning},author={Yann LeCun and Yoshua Bengio and Geoffrey Hinton},year={2015},journal={Nature}}";
        let checked = cleanup_result(compare_title_entry(before, wrong));
        assert_eq!(checked.status, "update");
        assert!(checked.candidate.is_none());
        assert_eq!(checked.changes.len(), 1);
        assert_eq!(checked.changes[0].field, "author");
        let after = checked.after.unwrap();
        assert_eq!(
            fields(&after)["author"],
            "Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron"
        );
        assert!(after.starts_with("@book{deep,"));
        assert!(after.contains("month = jan"));
        assert!(after.contains("note = {Keep {NASA}}"));
        assert!(!is_safe_local_cleanup(
            before,
            &after.replace("volume = {1}", "volume = {99}")
        ));
        assert!(!is_safe_local_cleanup(
            before,
            &after.replace(
                "month = jan",
                "url = {https://example.org/wrong}, month = jan"
            )
        ));
        let root = project_root();
        fs::write(root.join("references.bib"), before).unwrap();
        apply(&root, "references.bib", "deep", before, &after).unwrap();
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
        assert!(cleanup_result(result("checked", "", after)).after.is_none());
        assert!(cleanup_result(result("skipped", "", before.into()))
            .after
            .is_some());
        assert!(cleanup_result(result("conflict", "", before.into()))
            .after
            .is_none());
    }

    #[test]
    fn author_cleanup_preserves_names_order_groups_and_expressions() {
        assert_eq!(
            deduplicated_authors("{Smith, Alice and Bob Jones AND Alice Smith}"),
            Some("{Smith, Alice and Bob Jones}".into())
        );
        assert_eq!(
            deduplicated_authors(
                "{{Research and Development} and Smith, Alice and {Research and Development}}"
            ),
            Some("{{Research and Development} and Smith, Alice}".into())
        );
        for value in [
            "{Li Wang and Wang Li}",
            "{Alice Smith and Adam Smith}",
            "{A. Smith and Alice Smith}",
            "authors # { and Bob Jones}",
            "{Alice Smith} # { and Alice Smith}",
            "{Alice Smith and}",
        ] {
            assert!(deduplicated_authors(value).is_none(), "{value}");
        }
    }

    #[test]
    fn annual_volume_cleanup_removes_existing_and_reimported_labels_only() {
        for venue in [
            "Transactions on Machine Learning Research (TMLR)",
            "International Conference on Learning Representations (ICLR)",
        ] {
            let before = format!("@article{{v,title={{Voyager}},author={{Alice Smith}},journal={{{venue}}},volume={{2024}},year={{2024}}}}");
            let checked = cleanup_result(result("checked", "", before.clone()));
            assert_eq!(checked.changes.len(), 1);
            assert_eq!(checked.changes[0].field, "volume");
            assert_eq!(checked.changes[0].after, "");
            let after = checked.after.unwrap();
            assert!(!fields(&after).contains_key("volume"));
            assert_eq!(fields(&after)["year"], "2024");
            let root = project_root();
            fs::write(root.join("references.bib"), &before).unwrap();
            apply(&root, "references.bib", "v", &before, &after).unwrap();
            fs::remove_dir_all(root.parent().unwrap()).unwrap();
            assert!(cleanup_result(compare_title_entry(&after, &before))
                .after
                .is_none());
            let real_volume = before.replace("volume={2024}", "volume={38}");
            assert!(cleanup_result(result("checked", "", real_volume))
                .after
                .is_none());
        }
        let unrelated = "@article{x,title={Paper},author={Alice Smith},journal={Other Journal},year={2024},volume={2024}}";
        assert!(cleanup_result(result("checked", "", unrelated.into()))
            .after
            .is_none());
    }

    #[test]
    fn repeated_authors_are_reported_and_not_imported_from_sources() {
        let before = "@article{mine,title={Example},author={Alice Smith and Bob Jones},year={2024},journal={Journal},doi={10.1234/exact}}";
        let repeated = before.replace(
            "Alice Smith and Bob Jones",
            "Alice Smith and Bob Jones and Smith, Alice",
        );
        assert!(local_validation(&repeated)
            .iter()
            .any(|issue| issue.contains("Repeated author")));
        assert!(!local_validation(before)
            .iter()
            .any(|issue| issue.contains("Repeated author")));
        assert!(
            !local_validation(&before.replace("Bob Jones", "Adam Smith"))
                .iter()
                .any(|issue| issue.contains("Repeated author"))
        );
        assert!(compare_doi_entry(before, &repeated).after.is_none());
        assert!(compare_doi_entry(&repeated, before).after.is_none());
        assert!(cleanup_result(result("checked", "", repeated))
            .after
            .is_some());
    }

    #[test]
    fn title_matches_require_equivalent_full_ordered_authors() {
        let before = "@inproceedings{yao2023react,title={{ReAct}: Synergizing Reasoning and Acting in Language Models},author={Yao, Shunyu and Zhao, Jeffrey and Yu, Dian and Du, Nan and Shafran, Izhak and Narasimhan, Karthik and Cao, Yuan},year={2023},booktitle={ICLR}}";
        let authors = "Shunyu Yao and Jeffrey Zhao and Dian Yu and Nan Du and Izhak Shafran and Karthik Narasimhan and Yuan Cao";
        let remote = format!("@inproceedings{{remote,title={{ReAct: Synergizing Reasoning and Acting in Language Models}},author={{{authors}}},year={{2023}},booktitle={{ICLR}}}}");
        assert_ne!(compare_title_entry(before, &remote).status, "unavailable");
        for corrected in [
            remote.replace("Karthik Narasimhan", "Kumar Narasimhan"),
            remote.replace("Karthik Narasimhan", "K. Narasimhan"),
            remote.replace("Jeffrey Zhao", "Jeffrey Zhang"),
            remote.replace("Shunyu Yao and Jeffrey Zhao", "Jeffrey Zhao and Shunyu Yao"),
            remote.replace(" and Yuan Cao", ""),
        ] {
            assert!(
                compare_title_entry(before, &corrected).after.is_none(),
                "{corrected}"
            );
        }
        assert!(
            compare_title_entry(&before.replace(",booktitle={ICLR}", ""), &remote)
                .after
                .is_some()
        );
    }

    #[test]
    fn confirmed_papers_can_correct_venues_without_collapsing_findings() {
        for (before, remote) in [
            ("@inproceedings{awm,title={Agent Workflow Memory},author={Wang, Zora Zhiruo and Mao, Jiayuan and Fried, Daniel and Neubig, Graham},booktitle={ICLR},year={2025}}", "@inproceedings{x,title={Agent Workflow Memory},author={Zora Zhiruo Wang and Jiayuan Mao and Daniel Fried and Graham Neubig},booktitle={ICML},year={2025}}"),
            ("@inproceedings{memp,title={Memp: Exploring Agent Procedural Memory},author={Runnan Fang and Yuan Liang},booktitle={ACL},year={2026},doi={10.18653/v1/2026.findings-acl.866}}", "@inproceedings{x,title={Memp: Exploring Agent Procedural Memory},author={Runnan Fang and Yuan Liang},booktitle={Findings of the Association for Computational Linguistics: ACL 2026},year={2026},doi={10.18653/v1/2026.findings-acl.866}}"),
        ] {
            let after = compare_title_entry(before, remote).after.unwrap();
            assert_eq!(fields(&after)["booktitle"], fields(remote)["booktitle"]);
            if remote.contains("findings-acl") {
                assert!(compare_title_entry(&after, &remote.replace("Findings of the Association for Computational Linguistics: ACL 2026", "ACL")).after.is_none());
            }
            let root = project_root();
            fs::write(root.join("references.bib"), before).unwrap();
            let key = &project::bibliography_entry_spans(before)[0].0;
            apply(&root, "references.bib", key, before, &after).unwrap();
            fs::remove_dir_all(root.parent().unwrap()).unwrap();
            assert!(compare_title_entry(before, &remote.replace("title={", "title={Different ")).after.is_none());
        }
    }

    #[test]
    fn metadata_merge_keeps_key_and_custom_fields() {
        let before = "@article{mine,\n title={Old},\n author={A},\n year={2020},\n doi={10.1234/x},\n custom={keep}, month=jan, note={Keep {NASA}}, howpublished={\\url{https://example.org}}\n}";
        let remote = "@article{remote, title={Old}, author={A}, year={2021}, doi={10.1234/x}}";
        let got = compare_doi_entry(before, remote);
        let after = got.after.unwrap();
        assert!(after.contains("@article{mine,"));
        assert!(after.contains("custom = {keep}"), "{after}");
        assert!(after.contains("month = jan"), "{after}");
        assert!(after.contains("note = {Keep {NASA}}"), "{after}");
        assert!(
            after.contains(r"howpublished = {\url{https://example.org}}"),
            "{after}"
        );
        assert_eq!(got.status, "update");
    }

    #[test]
    fn scan_covers_all_files_and_reports_cross_file_duplicates_and_malformed_input() {
        let root = project_root();
        let primary = scan(&root)
            .unwrap()
            .entries
            .first()
            .map(|e| e.path.clone())
            .unwrap_or_else(|| "references.bib".into());
        fs::write(
            root.join(&primary),
            "@article{same, title={One}, author={A}, year={2020}, doi={10.1234/x}}\n@broken{",
        )
        .unwrap();
        fs::write(
            root.join("other.bib"),
            "@article{same, title={One}, author={B}, year={2021}, doi={10.1234/x}}",
        )
        .unwrap();
        let audit = scan(&root).unwrap();
        assert_eq!(audit.entries.len(), 2);
        assert!(audit
            .issues
            .iter()
            .any(|i| i.message.contains("Could not parse")));
        assert!(
            audit
                .issues
                .iter()
                .filter(|i| i.message.contains("Duplicate citation key"))
                .count()
                >= 2
        );
        assert!(
            audit
                .issues
                .iter()
                .filter(|i| i.message.contains("Duplicate DOI"))
                .count()
                >= 2
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn local_validation_applies_type_specific_bibtex_rules() {
        assert!(local_validation("@misc{x, year={20#24}}")
            .contains(&"Invalid literal year; expected four digits.".to_string()));
        let issues = local_validation(
            "@article{paper, title={}, author={Ada}, year={twenty twenty}, booktitle={Proceedings}}",
        );
        assert!(issues.contains(&"Empty title field.".to_string()));
        assert!(issues.contains(&"Missing journal field for article entry.".to_string()));
        assert!(issues.contains(&"Article entry uses booktitle instead of journal.".to_string()));
        assert!(issues.contains(&"Invalid literal year; expected four digits.".to_string()));

        let issues = local_validation(
            "@inproceedings{paper, title={T}, author={A}, year={2024}, journal={J}}",
        );
        assert!(issues.contains(&"Missing booktitle field for inproceedings entry.".to_string()));
        assert!(
            issues.contains(&"Inproceedings entry uses journal instead of booktitle.".to_string())
        );
    }

    #[test]
    fn local_validation_supports_standard_and_biblatex_entry_types() {
        assert!(local_validation(
            "@Article {a, author={A}, title={T}, journaltitle={J}, date={2024-05}}"
        )
        .is_empty());
        assert!(
            local_validation("@article{a, editor={E}, title={T}, journal={J}, year={2024}}")
                .contains(&"Missing author field for article entry.".to_string())
        );
        assert!(
            local_validation("@book{b, editor={E}, title={T}, publisher={P}, year={2024}}")
                .is_empty()
        );
        assert!(local_validation(
            "@online{o, author={A}, title={T}, date={2024-05}, url={https://example.test}}"
        )
        .is_empty());
        assert!(
            local_validation("@madeup{x, title={T}, author={A}, year={2024}}")
                .contains(&"Unknown bibliography entry type `madeup`.".to_string())
        );
    }

    #[test]
    fn local_validation_avoids_inheritance_and_expression_false_positives() {
        assert!(local_validation("@incollection{x, crossref={parent}, pages={1--2}}").is_empty());
        assert!(local_validation("@misc{x, year={20} # {24}}").is_empty());
        assert!(local_validation("@misc{x, year={ 2024 }}").is_empty());
        assert!(local_validation("@misc{x, year={ bad }}")
            .contains(&"Invalid literal year; expected four digits.".to_string()));
        assert!(local_validation(
            "@article{x, title=titlemacro # { suffix}, author=authorsmacro, year=yearmacro, journal=jmacro}"
        )
        .is_empty());
    }

    #[test]
    fn unavailable_preprint_lookup_is_not_reported_as_current() {
        for reason in [
            "sources_unavailable",
            "identity_conflict",
            "ambiguous",
            "unexpected",
        ] {
            assert_eq!(
                upgrade_miss("entry", &serde_json::json!({"reason":reason})).status,
                "unavailable"
            );
        }
        assert_eq!(
            upgrade_miss(
                "entry",
                &serde_json::json!({"reason":"no_published_version"})
            )
            .status,
            "checked"
        );
        assert!(!complete_entry("@article{a,title={Broken}"));
        assert!(complete_entry("@article{a,title={Complete}}"));
    }

    #[test]
    fn publication_diagnostics_preserve_partial_results_without_raw_errors() {
        for (detail, expected) in [
            ("batch result reused", "batch_reused"),
            ("batch unavailable", "unavailable"),
            (
                "disabled: public literature service queue_busy",
                "queue_busy",
            ),
            (
                "disabled: public literature service daily_quota",
                "daily_quota",
            ),
            (
                "disabled: public literature service upstream_rate_limit",
                "rate_limited",
            ),
        ] {
            let sources = publication_sources(&format!("[semanticscholar] {detail}"));
            assert_eq!(sources.len(), 1);
            assert_eq!(sources[0].outcome, expected);
        }
        let sources = publication_sources(concat!(
            "[upgrade] matching: Private title\n",
            "[crossref] no publication found\n",
            "[semanticscholar] disabled for the rest of this run: rate-limited (429)\n",
            "[dblp] transient failure for this entry: dblp unreachable (RemoteProtocolError)\n",
            "[openalex] error: ReadTimeout: https://example.org?api_key=secret\n",
            "[unpaywall] disabled for the rest of this run: server error (500)\n",
            "[googlescholar] disabled for the rest of this run: captcha/429\n",
        ));
        let pairs: Vec<_> = sources
            .iter()
            .map(|s| (s.source.as_str(), s.outcome.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("crossref", "no_match"),
                ("dblp", "connection_failed"),
                ("googlescholar", "blocked"),
                ("openalex", "timeout"),
                ("semanticscholar", "rate_limited"),
                ("unpaywall", "server_error"),
            ]
        );
        let mut result = upgrade_miss(
            "entry",
            &serde_json::json!({"reason":"sources_unavailable"}),
        );
        result.sources = sources;
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("publicationReason"));
        assert!(!json.contains("secret"));
        assert!(!json.contains("Private title"));
        assert!(!result.message.contains("sources_unavailable"));
        assert_eq!(result.status, "unavailable");
    }

    #[test]
    fn batch_failure_replaces_only_the_s2_diagnostic() {
        let mut checked = result("unavailable", "Check incomplete", "entry".into());
        checked.sources = vec![
            SourceCheck {
                source: "dblp".into(),
                outcome: "timeout".into(),
            },
            SourceCheck {
                source: "semanticscholar".into(),
                outcome: "unavailable".into(),
            },
        ];
        let checked = annotate_s2(checked, Some("upstream_rate_limit"));
        assert_eq!(checked.sources.len(), 2);
        assert_eq!(checked.sources[0].source, "dblp");
        assert_eq!(checked.sources[0].outcome, "timeout");
        assert_eq!(checked.sources[1].outcome, "batch_upstream_rate_limit");
    }

    /// Explicit opt-in network smoke test: copy a bibliography into a disposable
    /// project and exercise the same scan/check functions as the native commands.
    #[test]
    #[ignore = "requires LATTICE_AUDIT_LIVE_BIB and LATTICE_AUDIT_LIVE_OUTPUT; calls publication services"]
    fn live_bibliography_audit_on_isolated_copy() {
        let source = std::env::var("LATTICE_AUDIT_LIVE_BIB").unwrap();
        let output = std::env::var("LATTICE_AUDIT_LIVE_OUTPUT").unwrap();
        let original = fs::read_to_string(&source).unwrap();
        let root = project_root();
        fs::write(root.join("references.bib"), &original).unwrap();
        let scan = scan(&root).unwrap();
        let started = Instant::now();
        let mut results = Vec::new();
        for entries in scan.entries.chunks(2) {
            std::thread::scope(|scope| {
                let tasks: Vec<_> = entries
                    .iter()
                    .map(|entry| {
                        let root = &root;
                        scope.spawn(move || check_entry(root, entry.clone(), None).unwrap())
                    })
                    .collect();
                for task in tasks {
                    results.push(task.join().unwrap());
                }
            });
            eprintln!("Checked {}/{} entries", results.len(), scan.entries.len());
        }
        assert_eq!(
            fs::read_to_string(root.join("references.bib")).unwrap(),
            original
        );
        for (entry, result) in scan.entries.iter().zip(&results) {
            if let Some(after) = &result.after {
                apply(&root, &entry.path, &entry.key, &result.before, after).unwrap();
                assert_eq!(
                    registered_entry(&root, &entry.path, &entry.key)
                        .unwrap()
                        .as_deref(),
                    Some(after.as_str())
                );
            }
        }
        fs::write(
            output,
            serde_json::to_vec_pretty(&serde_json::json!({
                "scan": scan, "results": results, "elapsedSeconds": started.elapsed().as_secs_f64()
            }))
            .unwrap(),
        )
        .unwrap();
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn provider_errors_redact_the_spawned_credentials() {
        let mut command = Command::new("/bin/sh");
        command.env("OPENALEX_API_KEY", "draft+secret");
        let output = run_bibcite(
            &["-c", "printf '%s' \"$OPENALEX_API_KEY\"; printf '%s' 'HTTP 401 https://api.openalex.org/works?api_key=draft%2Bsecret' >&2; exit 1"],
            Some(command),
        )
        .unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "[redacted]");
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("HTTP 401"));
        assert!(!stderr.contains("draft"));
        let capture = TempFile::new("").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&capture.dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    #[cfg(unix)]
    fn captures_more_than_a_pipe_buffer_without_deadlocking() {
        let output = run_bibcite(
            &["-c", "head -c 131072 /dev/zero"],
            Some(Command::new("/bin/sh")),
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 131072);
    }

    #[test]
    fn sequential_apply_normalizes_entry_gaps_without_invalidating_previews() {
        for newline in ["\n", "\r\n"] {
            for gap in ["", " ", newline, &newline.repeat(4)] {
                let root = project_root();
                let one = "@article{one,title={One},author={Alice},year={2024}}";
                let two = "@book{two,title={Two},author={Bob},year={2023}}";
                let three = "@misc{three,title={Three},note={Keep {NASA}}}";
                let tail = format!("{newline}% Keep this comment{newline}@string{{J = \"Journal\"}}{newline}@misc{{draft,title={{unfinished");
                fs::write(
                    root.join("references.bib"),
                    format!("{one}{gap}{two}{gap}{three}{tail}"),
                )
                .unwrap();
                let after_one = one.replace("year={2024}", "year={2024},pages={1--9}");
                let after_two = two.replace("year={2023}", "year={2023},publisher={Press}");
                apply(&root, "references.bib", "one", one, &after_one).unwrap();
                // Bulk apply reuses the original previews. Formatting must not
                // change the next entry's bytes and cause a snapshot conflict.
                apply(&root, "references.bib", "two", two, &after_two).unwrap();
                assert_eq!(
                    fs::read_to_string(root.join("references.bib")).unwrap(),
                    format!(
                        "{after_one}{newline}{newline}{after_two}{newline}{newline}{three}{tail}"
                    ),
                    "gap={gap:?} newline={newline:?}"
                );
                fs::remove_dir_all(root.parent().unwrap()).unwrap();
            }
        }
    }

    #[test]
    fn apply_is_snapshot_checked_and_preserves_other_entries() {
        let root = project_root();
        let path = "references.bib";
        let before = "@article{one, title={Old}, author={A}, year={2020}}";
        let other = "@article{two, title={Other}, author={B}, year={2021}}";
        fs::write(root.join(path), format!("{before}\n\n{other}\n")).unwrap();
        let after = "@article{one, title={Old}, author={A}, year={2020}, pages={1--9}}";
        assert!(apply(
            &root,
            path,
            "one",
            before,
            &after.replace("title={Old}", "title={Different paper}")
        )
        .is_err());
        apply(&root, path, "one", before, after).unwrap();
        let contents = fs::read_to_string(root.join(path)).unwrap();
        assert!(contents.contains(after));
        assert!(contents.contains(other));
        assert!(apply(&root, path, "one", before, after)
            .unwrap_err()
            .contains("changed"));
        assert!(root.join(".research/history").is_dir());
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_publication_match_that_renames_the_paper_is_not_a_correction() {
        let gmt = "@article{chen2025gmt, title={GMT: General Motion Tracking for Humanoid Whole-Body Control}, author={Zixuan Chen}, year={2025}}";
        let sonic = "@article{chen2025gmt, title={SONIC: Supersizing motion tracking for natural humanoid whole-body control}, author={Zixuan Chen}, year={2026}, doi={10.1126/SCIROBOTICS.AED4592}}";
        assert!(renamed_paper(gmt, sonic));
        // Camera-ready case change, or dropping a short name, is still the same paper.
        assert!(!renamed_paper(
            gmt,
            "@article{chen2025gmt, title={GMT: General motion tracking for humanoid whole-body control}, author={Zixuan Chen}, year={2025}}"
        ));
        assert!(!renamed_paper(
            "@article{a, title={HOVER: Versatile Neural Whole-Body Controller for Humanoid Robots}, author={A}, year={2024}}",
            "@article{a, title={Versatile Neural Whole-Body Controller for Humanoid Robots}, author={A}, year={2024}}"
        ));
    }

    #[test]
    fn apply_rejects_a_doi_already_claimed_by_another_entry() {
        let root = project_root();
        let gmt = "@article{chen2025gmt, title={GMT: General Motion Tracking for Humanoid Whole-Body Control}, author={Zixuan Chen}, year={2025}}";
        let sonic = "@article{luo2026sonic, title={SONIC: Supersizing Motion Tracking for Natural Humanoid Whole-Body Control}, author={Zhengyi Luo}, year={2026}, doi={10.1126/scirobotics.aed4592}}";
        fs::write(root.join("references.bib"), format!("{gmt}\n\n{sonic}\n")).unwrap();
        let proposed = "@article{chen2025gmt, title={SONIC: Supersizing motion tracking for natural humanoid whole-body control}, author={Zixuan Chen}, year={2026}, doi={10.1126/SCIROBOTICS.AED4592}}";
        let error = apply(&root, "references.bib", "chen2025gmt", gmt, proposed).unwrap_err();
        assert!(error.contains("luo2026sonic"), "{error}");
        assert_eq!(
            fs::read_to_string(root.join("references.bib")).unwrap(),
            format!("{gmt}\n\n{sonic}\n")
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }
}
