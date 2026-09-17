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
            let mut checked = batch_comparison(&entry.bibtex, paper, bibtex, venue.as_deref())?;
            checked.sources.push(SourceCheck {
                source: "semanticscholar".into(),
                outcome: "selected".into(),
            });
            Some(checked)
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
        if batch_id(before)? != format!("ARXIV:{}", unversioned_arxiv(arxiv))
            || !metadata_identity_matches(before, &remote)
        {
            return None;
        }
        let venue = canonical_venue?.trim();
        if venue.is_empty()
            || ["arxiv", "corr", "preprint", "biorxiv", "medrxiv"]
                .iter()
                .any(|v| venue.to_ascii_lowercase().contains(v))
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
        return Ok(annotate_s2(
            upgrade_preprint(&before, s2_batch_status)?,
            s2_batch_status,
        ));
    }
    let Some(doi) = doi else {
        return Ok(annotate_s2(
            result(
                "skipped",
                "No DOI or arXiv identifier is available for an exact check.",
                before,
            ),
            s2_batch_status,
        ));
    };
    let health = citation_health::lookup(root, [doi.clone()]).remove(&doi);
    let metadata = audit_command(s2_batch_status)
        .and_then(|command| run_bibcite(&["get", "--json", &doi], Some(command)));
    let mut checked = match metadata.and_then(|o| parse_get_output(&o)) {
        Ok(remote) => compare_doi_entry(&before, &remote),
        Err(error) => result(
            "unavailable",
            &format!("Metadata check incomplete: {error}"),
            before,
        ),
    };
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
    if !metadata_identity_matches(before, after) {
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
        checked.sources = publication_sources(&String::from_utf8_lossy(&output.stderr));
        return Ok(checked);
    }
    // `upgrade` preserves the input author field, so comparing that output to
    // the input cannot verify the authors. Dereference the candidate DOI and
    // check independent metadata before offering an applicable replacement.
    let remote = fields(&after)
        .get("doi")
        .and_then(|doi| normalize_doi(doi))
        .filter(|doi| !doi.starts_with("10.48550/"))
        .ok_or_else(|| "No publication DOI for independent verification.".to_string())
        .and_then(|doi| {
            run_bibcite(
                &["get", "--json", &doi],
                Some(audit_command(s2_batch_status)?),
            )
            .and_then(|output| parse_get_output(&output))
        });
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
        _ => identity_conflict(before),
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    checked.sources = publication_sources(&stderr);
    if let Some(source) = record.get("source").and_then(|value| value.as_str()) {
        checked.sources.retain(|row| row.source != source);
        checked.sources.push(SourceCheck {
            source: source.into(),
            outcome: if stderr.lines().any(|line| line.starts_with("[cache] hit:")) {
                "selected_cached"
            } else {
                "selected"
            }
            .into(),
        });
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
        } else if detail.contains("server error") {
            "server_error"
        } else if detail.contains("no publication found") {
            "no_match"
        } else if detail.contains("failure")
            || detail.contains("disabled")
            || detail.contains("error")
        {
            "unavailable"
        } else {
            continue;
        };
        sources.insert(source.to_string(), outcome.to_string());
    }
    sources
        .into_iter()
        .map(|(source, outcome)| SourceCheck { source, outcome })
        .collect()
}

fn compare_doi_entry(before: &str, remote: &str) -> AuditResult {
    let local = fields(before);
    let other = fields(remote);
    let doi = local.get("doi").and_then(|v| normalize_doi(v));
    if doi.is_none() || doi != other.get("doi").and_then(|v| normalize_doi(v)) {
        return result(
            "unavailable",
            "The retrieved record did not confirm the requested DOI.",
            before.into(),
        );
    }
    if !metadata_identity_matches(before, remote) {
        return identity_conflict(before);
    }
    merge_metadata(before, remote, false)
}

fn identity_conflict(before: &str) -> AuditResult {
    result("unavailable", "Paper identity could not be confirmed. Review the title, authors, identifiers, year, and venue manually; no replacement is offered.", before.into())
}

fn unversioned_arxiv(id: &str) -> &str {
    id.rsplit_once('v')
        .filter(|(_, version)| !version.is_empty() && version.chars().all(|c| c.is_ascii_digit()))
        .map(|(id, _)| id)
        .unwrap_or(id)
}

/// A conservative compatibility check, not proof of identity. Never infer that
/// two people are the same from a surname or initials. Allow additional trailing
/// authors to repair truncated lists, but require every supplied author in order.
fn metadata_identity_matches(before: &str, remote: &str) -> bool {
    let remote = remote.trim();
    let spans = project::bibliography_entry_spans(remote);
    if spans.len() != 1 || spans[0].1 != 0 || spans[0].2 != remote.len() || !complete_entry(remote)
    {
        return false;
    }
    let local = fields(before);
    let other = fields(remote);
    let value = |fields: &BTreeMap<String, String>, name: &str| {
        fields.get(name).cloned().unwrap_or_default()
    };
    let title = normalize_title(&value(&local, "title"));
    let remote_title = normalize_title(&value(&other, "title"));
    if remote_title.is_empty() || (!title.is_empty() && title != remote_title) {
        return false;
    }
    let names = |authors: &str| {
        normalize_text(authors)
            .split(" and ")
            .map(|name| {
                let mut words = name
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|word| !word.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                words.sort();
                words
            })
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>()
    };
    let authors = names(&value(&local, "author"));
    let remote_authors = names(&value(&other, "author"));
    if remote_authors.is_empty()
        || (title.is_empty() && authors.is_empty())
        || !remote_authors.starts_with(&authors)
    {
        return false;
    }
    if let Some(doi) = local
        .get("doi")
        .and_then(|v| normalize_doi(v))
        .filter(|v| !v.starts_with("10.48550/"))
    {
        if other.get("doi").and_then(|v| normalize_doi(v)).as_ref() != Some(&doi) {
            return false;
        }
    }
    if let (Some(a), Some(b)) = (
        project::bibliography_arxiv_id(&local),
        project::bibliography_arxiv_id(&other),
    ) {
        if unversioned_arxiv(&a) != unversioned_arxiv(&b) {
            return false;
        }
    }
    if let (Ok(a), Ok(b)) = (
        value(&local, "year").trim().parse::<u32>(),
        value(&other, "year").trim().parse::<u32>(),
    ) {
        if a.abs_diff(b) > 2 {
            return false;
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
    let local_venue = venue(&local);
    local_venue.is_empty()
        || ["arxiv", "preprint", "corr", "biorxiv", "medrxiv"]
            .iter()
            .any(|marker| local_venue.contains(marker))
        || local_venue == venue(&other)
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
            (!b.is_empty() && normalize_text(&a) != normalize_text(&b)).then(|| FieldChange {
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
    if published {
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
            !value.is_empty()
                && !value.contains("arxiv")
                && !value.contains("preprint")
                && !value.contains("corr")
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
    let entry_type =
        if published && other.contains_key("booktitle") && !other.contains_key("journal") {
            "inproceedings"
        } else {
            (if published { remote } else { before })
                .trim_start()
                .trim_start_matches('@')
                .split(['{', '('])
                .next()
                .unwrap_or("article")
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

fn complete_entry(entry: &str) -> bool {
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
        let before = "@article{vaswani2017, title={Attention Is All You Need}, author={Vaswani, Ashish and Shazeer, Noam}, year={2017}, eprint={1706.03762}, journal={arXiv preprint arXiv:1706.03762}}";
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
        let checked = compare_batch(before, &metadata).expect("unchanged venue stays batched");
        assert_eq!(checked.status, "update");
        assert!(checked
            .changes
            .iter()
            .any(|change| change.field == "author"));
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
        // The upgrade still preserves the original authors, but the independent
        // DOI record names someone else. It must no longer yield a proposal.
        let script = fs::read_to_string(&mock).unwrap();
        fs::write(
            &mock,
            script.replace(&remote, &remote.replace("Greg Heinrich", "Someone Else")),
        )
        .unwrap();
        let rejected = upgrade_preprint(before, None).unwrap();
        unsafe { std::env::remove_var("LATTICE_BIBCITE_BIN") };
        assert!(rejected.after.is_none());
        assert_eq!(rejected.status, "unavailable");
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
    fn doi_lookup_does_not_establish_paper_author_or_venue_identity() {
        let before = "@article{mine,title={A specific paper},author={Alice Smith and Bob Jones},year={2024},journal={Journal One},doi={10.1234/a}}";
        for remote in [
            before.replace("A specific paper", "A different paper"),
            before.replace("Alice Smith", "Adam Smith"),
            before.replace("Bob Jones", "Carol Jones"),
            before.replace("Journal One", "Journal Two"),
            before.replace("2024", "2014"),
            format!("{before}\n{before}"),
        ] {
            let checked = compare_doi_entry(before, &remote);
            assert!(checked.after.is_none(), "unsafe proposal: {remote}");
            assert_eq!(checked.status, "unavailable");
        }
        let missing_author = before.replace("author={Alice Smith and Bob Jones},", "");
        assert!(compare_doi_entry(&missing_author, before).after.is_some());
        let reordered_names =
            before.replace("Alice Smith and Bob Jones", "Smith, Alice and Jones, Bob");
        assert_ne!(
            compare_doi_entry(&reordered_names, before).status,
            "unavailable"
        );
    }

    #[test]
    fn batch_rejects_wrong_arxiv_record_and_changed_coauthor() {
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
            &after.replace("author={A}", "author={Someone Else}")
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
