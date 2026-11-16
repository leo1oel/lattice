//! Upgrading preprints in the primary bibliography to their publications.
//!
//! bibcite's `upgrade` rewrites the whole file it is given, every entry
//! reformatted (sorted, lowercased, rebraced fields; comments wrapped in
//! `@comment`), and drops fields it considers preprint-only from the entries
//! it upgrades. The bibliography is shared — on Overleaf, co-authors' entries
//! sit beside the writer's — so its output is only a proposal: an entry it did
//! not change keeps its original bytes, and an upgraded entry keeps its own
//! text, with the changed values rewritten in place and new fields appended.
//! No field the writer had is dropped. The ones bibcite would have removed
//! are reported, so the agent can tell the writer, who decides.
//!
//! Each preprint is checked on its own (`batch`), so one entry's rejected
//! proposal is reported for that entry instead of discarding the rest, and a
//! deadline can stop the batch between entries: what was confirmed by then is
//! saved, and the rest is reported pending for the next call.

use super::citation::validate_resolved_identity;
use crate::util::err;
use crate::{commands, project};
use batch::{Candidate, Outcome};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::ops::Range;
use std::path::Path;
use std::time::{Duration, Instant};

mod batch;

#[cfg(test)]
pub(super) use batch::forget_checks;
pub(crate) use batch::{entry_fields, is_preprint, publishes};

/// Kept free before the request's deadline for saving the result and
/// answering it.
const COMMIT_MARGIN: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    pub dry_run: bool,
    pub changed: bool,
    /// bibcite's report shape: `upgraded`, `matched`, and one row per
    /// preprint with its `status`.
    pub report: Value,
    /// Per upgraded entry, the fields bibcite left out that were kept.
    pub retained_fields: Vec<RetainedFields>,
    /// False when the deadline came before every preprint was checked.
    pub complete: bool,
    /// The preprints not checked yet; calling again continues with them.
    pub pending: Vec<String>,
    /// What happened, in words, for the Agent.
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedFields {
    pub key: String,
    pub fields: Vec<String>,
}

/// Upgrade preprints to their publications. Only the agent asks for this, and
/// its turn records the history entry itself. With a `deadline`, the batch
/// stops checking in time to answer before it (see `batch`).
pub fn upgrade_bibliography(
    root: &Path, dry_run: bool, deadline: Option<Instant>,
) -> Result<UpgradeResult, String> {
    let manifest = project::read_manifest(root)?;
    let path = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = fs::read_to_string(&path).unwrap_or_default();
    let candidates = batch::candidates(&before);
    let budget = deadline.map(|deadline| deadline.checked_sub(COMMIT_MARGIN).unwrap_or(deadline));
    let mut outcomes = batch::check_all(&candidates, dry_run, budget);
    let mut changed = false;
    if !dry_run {
        // The file may have changed during the lookups: apply each upgrade to
        // the entry as it is now, and only if it is still the text checked.
        let current = fs::read_to_string(&path).unwrap_or_default();
        let mut after = current.clone();
        for (candidate, outcome) in candidates.iter().zip(outcomes.iter_mut()) {
            let Some(Outcome::Upgraded { entry, .. }) = outcome else { continue };
            match replace_entry(&after, candidate, entry) {
                Some(next) => after = next,
                None => {
                    *outcome = Some(Outcome::Rejected(
                        "The entry changed while it was being upgraded. Retry.".into(),
                    ))
                }
            }
        }
        if after != current {
            validate_bibliography_upgrade(&current, &after)?;
            fs::write(project::safe_path(root, &manifest.primary_bibliography)?, &after)
                .map_err(err)?;
            changed = true;
        }
    }
    Ok(summarize(dry_run, changed, &candidates, &outcomes))
}

/// `bibliography` with `candidate`'s entry replaced by `entry`, or `None`
/// when that entry is no longer exactly the text that was checked.
fn replace_entry(bibliography: &str, candidate: &Candidate, entry: &str) -> Option<String> {
    let spans: Vec<_> = project::bibliography_entry_spans(bibliography)
        .into_iter()
        .filter(|(key, _, _)| *key == candidate.key)
        .collect();
    let [(_, start, end)] = spans[..] else { return None };
    (bibliography[start..end] == candidate.text)
        .then(|| format!("{}{entry}{}", &bibliography[..start], &bibliography[end..]))
}

fn summarize(
    dry_run: bool, changed: bool, candidates: &[Candidate], outcomes: &[Option<Outcome>],
) -> UpgradeResult {
    let mut rows = Vec::new();
    let mut retained_fields = Vec::new();
    let mut pending = Vec::new();
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (candidate, outcome) in candidates.iter().zip(outcomes) {
        let mut row = json!({"key": candidate.key, "title": candidate.title});
        let status = match outcome {
            None => {
                pending.push(candidate.key.clone());
                "pending"
            }
            Some(Outcome::Upgraded { retained, venue, source, .. }) => {
                row["venue"] = json!(venue);
                row["source"] = json!(source);
                if !retained.is_empty() {
                    retained_fields.push(RetainedFields {
                        key: candidate.key.clone(),
                        fields: retained.clone(),
                    });
                }
                if dry_run {
                    "would_upgrade"
                } else {
                    "upgraded"
                }
            }
            Some(Outcome::Current) => "current",
            Some(Outcome::NoPublishedVersion) => "no_published_version",
            Some(Outcome::Unavailable(reason)) => {
                row["reason"] = json!(reason);
                "sources_unavailable"
            }
            Some(Outcome::Rejected(reason)) => {
                row["reason"] = json!(reason);
                "rejected"
            }
        };
        row["status"] = json!(status);
        *counts.entry(status).or_default() += 1;
        rows.push(row);
    }
    let count = |status: &str| counts.get(status).copied().unwrap_or(0);
    let upgraded = count("upgraded") + count("would_upgrade");
    let report = json!({
        "upgraded": upgraded,
        "matched": upgraded + count("current"),
        "entries": rows,
    });
    let summary = summary_text(dry_run, candidates.len(), &counts, &pending);
    UpgradeResult {
        dry_run,
        changed,
        report,
        retained_fields,
        complete: pending.is_empty(),
        pending,
        summary,
    }
}

fn summary_text(
    dry_run: bool, total: usize, counts: &BTreeMap<&str, usize>, pending: &[String],
) -> String {
    if total == 0 {
        return "The bibliography has no preprints to upgrade.".into();
    }
    let checked = total - pending.len();
    let mut parts = Vec::new();
    for (status, label) in [
        ("upgraded", "upgraded"),
        ("would_upgrade", "would be upgraded"),
        ("current", "already match their publication"),
        ("no_published_version", "have no published version yet"),
        ("sources_unavailable", "could not be checked now (sources unavailable; retry later)"),
        ("rejected", "were not changed because the proposal failed a safety check (see reason)"),
    ] {
        if let Some(count) = counts.get(status).filter(|count| **count > 0) {
            parts.push(format!("{count} {label}"));
        }
    }
    let mut text = if pending.is_empty() {
        format!("Checked all {total} preprints: {}.", parts.join(", "))
    } else {
        format!(
            "Checked {checked} of {total} preprints before this request's time limit{}{}. \
             {} saved; call upgrade_bibliography again to continue with the {} pending: {}.",
            if parts.is_empty() { "" } else { ": " },
            parts.join(", "),
            if dry_run { "Nothing was" } else { "Upgrades so far are" },
            pending.len(),
            pending.join(", ")
        )
    };
    if let Some(note) = commands::public_service_note() {
        text.push(' ');
        text.push_str(&note);
    }
    text
}

/// `before` with bibcite's proposed upgrades applied entry by entry: every
/// byte outside an upgraded entry stays as it was.
fn merge_upgrade(before: &str, proposed: &str) -> Result<(String, Vec<RetainedFields>), String> {
    let proposals = project::bibliography_entry_spans(proposed);
    let entries = project::bibliography_entry_spans(before);
    if entries.len() != proposals.len() {
        return Err("An upgrade cannot add or remove citations.".into());
    }
    let mut merged = String::with_capacity(before.len());
    let mut retained = Vec::new();
    let mut cursor = 0;
    for (key, start, end) in entries {
        let matches: Vec<_> =
            proposals.iter().filter(|(candidate, _, _)| *candidate == key).collect();
        let [(_, proposal_start, proposal_end)] = matches[..] else {
            return Err(format!("An upgrade must preserve the unique citation key '{key}'."));
        };
        let (entry, kept) = merge_entry(
            &before[start..end],
            &proposed[*proposal_start..*proposal_end],
        )
        .ok_or_else(|| {
            format!("The upgrade of '{key}' could not be applied safely. No changes were saved.")
        })?;
        merged.push_str(&before[cursor..start]);
        merged.push_str(&entry);
        cursor = end;
        if !kept.is_empty() {
            retained.push(RetainedFields { key, fields: kept });
        }
    }
    merged.push_str(&before[cursor..]);
    Ok((merged, retained))
}

/// One entry with the upgrade's changes written into its own text, and the
/// source fields the upgrade left out (kept). `None` when the entry cannot be
/// edited safely, such as an unterminated one.
fn merge_entry(source: &str, proposal: &str) -> Option<(String, Vec<String>)> {
    let (source_type, source_body) = entry_parts(source)?;
    let (proposal_type, proposal_body) = entry_parts(proposal)?;
    let body = &source[source_body.clone()];
    let offered = &proposal[proposal_body];
    let fields = project::bibliography_field_spans(body);
    // As the parser reads a repeated field: the last one wins.
    let local: BTreeMap<_, _> =
        fields.iter().map(|field| (body[field.name.clone()].to_ascii_lowercase(), field)).collect();
    let same = |a: &str, b: &str| {
        let words = |value: &str| {
            value.replace(['{', '}'], "").split_whitespace().collect::<Vec<_>>().join(" ")
        };
        words(a) == words(b)
    };
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    let mut added = String::new();
    let mut offered_names = Vec::new();
    let last = fields.last();
    // New fields copy the source's layout: its separator and its ` = `.
    let separator = last
        .map(|field| &body[body[..field.name.start].trim_end().len()..field.name.start])
        .filter(|space| !space.is_empty())
        .unwrap_or("\n  ");
    let equals = last.map(|field| &body[field.name.end..field.value.start]).unwrap_or(" = ");
    for field in project::bibliography_field_spans(offered) {
        let name = offered[field.name.clone()].to_ascii_lowercase();
        let value = &offered[field.value.clone()];
        match local.get(&name) {
            Some(existing) if same(&existing.raw, &field.raw) => {}
            Some(existing) => {
                let at = source_body.start + existing.value.start;
                edits.push((at..source_body.start + existing.value.end, value.to_string()));
            }
            None => added.push_str(&format!(",{separator}{name}{equals}{value}")),
        }
        offered_names.push(name);
    }
    let type_changed =
        !source[source_type.clone()].eq_ignore_ascii_case(&proposal[proposal_type.clone()]);
    if edits.is_empty() && added.is_empty() && !type_changed {
        return Some((source.to_string(), Vec::new()));
    }
    if type_changed {
        edits.push((source_type, proposal[proposal_type].to_string()));
    }
    if !added.is_empty() {
        let at = source_body.start + last.map_or(0, |field| field.value.end);
        // With no field to follow, the leading comma would double the key's.
        let text = if last.is_some() { added } else { format!("{},", &added[1..]) };
        edits.push((at..at, text));
    }
    let mut merged = source.to_string();
    edits.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
    for (range, text) in edits {
        merged.replace_range(range, &text);
    }
    let kept = fields
        .iter()
        .map(|field| &body[field.name.clone()])
        .filter(|name| !offered_names.contains(&name.to_ascii_lowercase()))
        .map(str::to_string)
        .collect();
    Some((merged, kept))
}

/// The type name and body of `@type{key, body}`, as byte ranges. The entry
/// must end with its own closing delimiter and balance its braces, or an
/// unterminated entry's last value would be mistaken for its end.
fn entry_parts(entry: &str) -> Option<(Range<usize>, Range<usize>)> {
    let type_end = 1 + entry.get(1..)?.find(|c: char| !c.is_ascii_alphabetic())?;
    let opening = type_end + entry[type_end..].find(['{', '('])?;
    let closing = if entry.as_bytes()[opening] == b'{' { '}' } else { ')' };
    let comma = entry.find(',')?;
    let mut depth = 0i32;
    for byte in entry[opening..].bytes() {
        depth += i32::from(byte == b'{') - i32::from(byte == b'}');
    }
    (entry.ends_with(closing) && depth == 0).then_some((1..type_end, comma + 1..entry.len() - 1))
}

/// An upgrade may enrich records but never add, drop, re-key or swap a work.
fn validate_bibliography_upgrade(before: &str, after: &str) -> Result<(), String> {
    if project::parse_bibliography(before).len() != project::parse_bibliography(after).len() {
        return Err("An upgrade cannot add or remove citations.".into());
    }
    let after_spans = project::bibliography_entry_spans(after);
    for (key, start, end) in project::bibliography_entry_spans(before) {
        let matches: Vec<_> =
            after_spans.iter().filter(|(candidate, _, _)| *candidate == key).collect();
        let [(_, proposed_start, proposed_end)] = matches[..] else {
            return Err(format!("An upgrade must preserve the unique citation key '{key}'."));
        };
        let previous = &before[start..end];
        let proposed = &after[*proposed_start..*proposed_end];
        if previous == proposed {
            continue;
        }
        validate_resolved_identity("", proposed)?;
        if !crate::citation_audit::metadata_identity_matches(previous, proposed) {
            return Err(format!(
                "The upgrade changes the identity of '{key}'. No changes were saved."
            ));
        }
        if let Some(id) = project::parse_bibliography(previous).remove(0).arxiv_id {
            validate_resolved_identity(&id, proposed)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
