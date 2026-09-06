use crate::citation_health::CitationHealth;
use crate::{citation_health, commands, project};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

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
            let mut local = Vec::new();
            for required in ["title", "author", "year"] {
                if fields.get(required).is_none_or(|v| v.trim().is_empty()) {
                    local.push(format!("Missing {required} field."));
                }
            }
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
pub fn check_batch(
    root: &Path,
    entries: Vec<AuditEntry>,
) -> Result<Vec<Option<AuditResult>>, String> {
    if entries.len() > crate::citation_batch::BATCH_SIZE {
        return Err("Too many entries in an audit batch.".into());
    }
    let ids = entries
        .iter()
        .map(|entry| batch_id(&entry.bibtex))
        .collect::<Vec<_>>();
    let requested = ids.iter().flatten().cloned().collect::<Vec<_>>();
    let papers = crate::citation_batch::lookup(&requested)?;
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
            batch_comparison(&entry.bibtex, paper)
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
    Ok(results)
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
    let id = id
        .rsplit_once('v')
        .filter(|(_, v)| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
        .map(|(id, _)| id)
        .unwrap_or(&id);
    Some(format!("ARXIV:{id}"))
}

fn batch_comparison(before: &str, paper: &crate::citation_batch::Paper) -> Option<AuditResult> {
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
    let mut remote = paper.citation_styles.as_ref()?.bibtex.trim().to_string();
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
        let venue = paper.venue.as_deref()?.trim().to_ascii_lowercase();
        if venue.is_empty()
            || ["arxiv", "corr", "preprint", "biorxiv", "medrxiv"]
                .iter()
                .any(|v| venue.contains(v))
        {
            return None;
        }
        if !["journal", "booktitle"].iter().any(|name| {
            other
                .get(*name)
                .is_some_and(|v| normalize_text(v) == normalize_text(&venue))
        }) {
            return None;
        }
        let year = local.get("year")?.parse::<u32>().ok()?;
        let author_tokens = |authors: &str| {
            let normalized = normalize_text(authors);
            let mut tokens = normalized
                .split(" and ")
                .next()
                .unwrap_or("")
                .split(|c: char| !c.is_alphanumeric())
                .filter(|s| !s.is_empty() && *s != "and")
                .map(str::to_string)
                .collect::<Vec<_>>();
            tokens.sort();
            tokens
        };
        let first_author = author_tokens(local.get("author")?);
        if year.abs_diff(paper.year?) > 2
            || first_author.is_empty()
            || first_author != author_tokens(other.get("author")?)
        {
            return None;
        }
        let merged = merge_metadata(before, &remote, true);
        let after = merged.after?;
        return Some(proposal(before, after, "A published version is available."));
    }
    Some(compare_doi_entry(before, &remote))
}

pub fn check_entry(root: &Path, request: AuditEntry) -> Result<AuditResult, String> {
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
        return Ok(result(
            "skipped",
            "Kept as a preprint because pubstate is explicitly preprint.",
            before,
        ));
    }
    let published_venue = ["journal", "booktitle"].iter().any(|f| {
        local
            .get(*f)
            .is_some_and(|v| !v.trim().is_empty() && !v.to_ascii_lowercase().contains("arxiv"))
    });
    if arxiv && !published_venue {
        return upgrade_preprint(&before);
    }
    let Some(doi) = doi else {
        return Ok(result(
            "skipped",
            "No DOI or arXiv identifier is available for an exact check.",
            before,
        ));
    };
    let health = citation_health::lookup(root, [doi.clone()]).remove(&doi);
    let metadata = run_bibcite(&["get", "--json", &doi], None);
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
    Ok(checked)
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

fn upgrade_preprint(before: &str) -> Result<AuditResult, String> {
    let temp = TempFile::new(before)?;
    let output = run_bibcite(
        &["upgrade", temp.path.to_string_lossy().as_ref(), "--no-tidy"],
        None,
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
    Ok(proposal(before, after, "A published version is available."))
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
        if !matches!(
            source,
            "dblp" | "semanticscholar" | "googlescholar" | "crossref" | "unpaywall" | "openalex"
        ) {
            continue;
        }
        let detail = detail.to_ascii_lowercase();
        let outcome = if detail.contains("captcha") {
            "blocked"
        } else if detail.contains("429") || detail.contains("rate-limit") {
            "rate_limited"
        } else if detail.contains("timeout") || detail.contains("timed out") {
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
    if local.get("doi").and_then(|v| normalize_doi(v))
        != other.get("doi").and_then(|v| normalize_doi(v))
    {
        return result(
            "unavailable",
            "The retrieved record did not confirm the requested DOI.",
            before.into(),
        );
    }
    merge_metadata(before, remote, false)
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
    if changes.is_empty() {
        return result(
            "checked",
            "DOI metadata matches the citation.",
            before.into(),
        );
    }
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
    AuditResult {
        status: "update".into(),
        message: "DOI metadata corrections are available.".into(),
        publication_reason: None,
        sources: vec![],
        before: before.into(),
        after: Some(after),
        changes,
        health: None,
    }
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
    let changes = all
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

    fn project_root() -> PathBuf {
        let parent =
            std::env::temp_dir().join(format!("lattice-audit-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        project::create_blank(&parent, "Audit").unwrap()
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
    fn batch_preprint_upgrade_preserves_key_expressions_and_requires_identity() {
        let before = "@article{mine, title={A paper}, author={Smith, Alice and Jones, Bob}, year={2024}, eprint={2401.12345v2}, journal={arXiv}, month=jan, custom={keep}}";
        assert_eq!(batch_id(before).as_deref(), Some("ARXIV:2401.12345"));
        let mut paper: crate::citation_batch::Paper = serde_json::from_value(serde_json::json!({
            "externalIds": {"ArXiv":"2401.12345", "DOI":"10.1234/published"},
            "title":"A paper", "venue":"ICML", "year":2024,
            "citationStyles":{"bibtex":"@inproceedings{remote, title={A paper}, author={Alice Smith and Bob Jones}, year={2024}, booktitle={ICML}}"}
        })).unwrap();
        let checked = batch_comparison(before, &paper).unwrap();
        assert_eq!(checked.status, "update");
        let after = checked.after.unwrap();
        assert!(after.starts_with("@inproceedings{mine,"));
        assert!(after.contains("month = jan"));
        assert!(after.contains("custom = {keep}"));
        assert!(after.contains("doi = {10.1234/published}"));
        assert_eq!(checked.before, before);
        paper.title = "Different paper".into();
        assert!(batch_comparison(before, &paper).is_none());
        paper.title = "A paper".into();
        paper.venue = Some("CoRR".into());
        assert!(batch_comparison(before, &paper).is_none());
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
        let checked = batch_comparison(before, &paper).unwrap();
        let after = checked.after.unwrap();
        assert!(after.starts_with("@inproceedings{vaswani2017,"));
        assert!(!fields(&after).contains_key("journal"));
        assert!(!fields(&after).contains_key("doi"));
        assert_eq!(
            fields(&after)["booktitle"],
            "Neural Information Processing Systems"
        );
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
        assert!(batch_comparison(before, &paper).is_none());
    }

    #[test]
    fn metadata_merge_keeps_key_and_custom_fields() {
        let before = "@article{mine,\n title={Old},\n author={A},\n year={2020},\n doi={10.1234/x},\n custom={keep}, month=jan, note={Keep {NASA}}, howpublished={\\url{https://example.org}}\n}";
        let remote = "@article{remote, title={New}, author={A}, year={2021}, doi={10.1234/x}}";
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
                        scope.spawn(move || check_entry(root, entry.clone()).unwrap())
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
        let after = "@article{one, title={New}, author={A}, year={2020}}";
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
}
