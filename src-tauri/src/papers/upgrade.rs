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
//! are reported, so the agent can tell the writer, and Check references
//! proposes their removal as a reviewed edit.

use super::bibliography::{parse_report, run_bibcite, ScratchBibliography};
use super::citation::validate_resolved_identity;
use crate::util::err;
use crate::{commands, project};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::ops::Range;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    pub dry_run: bool,
    pub changed: bool,
    pub report: Value,
    /// Per upgraded entry, the fields bibcite left out that were kept.
    pub retained_fields: Vec<RetainedFields>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedFields {
    pub key: String,
    pub fields: Vec<String>,
}

/// Upgrade preprints to their publications. Only the agent asks for this, and
/// its turn records the history entry itself.
pub fn upgrade_bibliography(root: &Path, dry_run: bool) -> Result<UpgradeResult, String> {
    let manifest = project::read_manifest(root)?;
    let path = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = fs::read_to_string(&path).unwrap_or_default();
    let scratch = ScratchBibliography::new("lattice-upgrade", Some(&before))?;
    let mut command = commands::BIBCITE.command()?;
    command.arg("upgrade").arg("--no-tidy").arg(&scratch.path);
    if dry_run {
        command.arg("--dry-run");
    }
    let report = parse_report(&run_bibcite("bibcite", &mut command)?)?;
    let proposed = scratch.read()?;
    let (after, retained_fields) = if dry_run || proposed == before {
        (before.clone(), Vec::new())
    } else {
        merge_upgrade(&before, &proposed)?
    };
    if after != before {
        validate_bibliography_upgrade(&before, &after)?;
        // Upgrade preserves old author fields, so agreement with its output
        // is not independent evidence. Check each changed record at its DOI.
        let old = project::parse_bibliography(&before);
        for (key, start, end) in project::bibliography_entry_spans(&after) {
            let Some(previous) = old.iter().find(|entry| entry.key == key) else {
                continue;
            };
            let raw = &after[start..end];
            let current = project::parse_bibliography(raw).remove(0);
            if previous.doi == current.doi
                && previous.title == current.title
                && previous.year == current.year
                && previous.venue == current.venue
                && previous.authors == current.authors
            {
                continue;
            }
            let doi = current.doi.ok_or("An automatic publication upgrade requires an independently verifiable DOI. Use citation review instead.")?;
            let verified = project::resolve_citation_query(&doi)?;
            if !crate::citation_audit::metadata_identity_matches(raw, verified.bibtex.trim()) {
                return Err(format!(
                    "Publication metadata for '{key}' could not be independently confirmed."
                ));
            }
        }
        if fs::read_to_string(&path).map_err(err)? != before {
            return Err("The bibliography changed while upgrading. Retry the operation.".into());
        }
        fs::write(project::safe_path(root, &manifest.primary_bibliography)?, &after)
            .map_err(err)?;
    }
    Ok(UpgradeResult { dry_run, changed: after != before, report, retained_fields })
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
