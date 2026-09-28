//! Running bibcite, and the edits it makes to the primary bibliography:
//! removing a reference (optionally with its manuscript citations) and
//! upgrading preprints to their publications.
//!
//! bibcite always works on a scratch copy; nothing reaches the project until
//! the result has been checked and is committed through `commit_bibliography`
//! or the citation transaction.

use super::citation::validate_resolved_identity;
use super::{ensure_success, err, uv_tool_spawn_error};
use crate::models::SymbolOccurrence;
use crate::{commands, project};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum HistoryMode {
    /// Commit through a citation transaction the history panel can undo.
    Record,
    /// Write directly; the caller (an agent turn) records history itself.
    Defer,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    pub dry_run: bool,
    pub changed: bool,
    pub report: Value,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub key: String,
    pub removed: bool,
    pub blockers: Vec<SymbolOccurrence>,
    pub changed_files: Vec<String>,
    pub removed_citations: u32,
    pub transaction_id: Option<String>,
    pub changes: Vec<ReferenceFileChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceFileChange {
    pub path: String,
    pub before: String,
    pub after: String,
}

/// A private temporary directory holding one `.bib` file for bibcite to read
/// or edit, removed on drop. It is owner-only on Unix because provider stderr
/// captured beside it may carry credentials until it has been redacted.
pub(crate) struct ScratchBibliography {
    pub(crate) dir: PathBuf,
    pub(crate) path: PathBuf,
}

impl ScratchBibliography {
    pub(crate) fn new(prefix: &str, contents: Option<&str>) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&dir).map_err(err)?;
        let scratch = Self { path: dir.join("references.bib"), dir };
        if let Some(contents) = contents {
            fs::write(&scratch.path, contents).map_err(err)?;
        }
        Ok(scratch)
    }

    pub(super) fn read(&self) -> Result<String, String> {
        fs::read_to_string(&self.path).map_err(err)
    }
}

impl Drop for ScratchBibliography {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// `bibcite add --no-tidy`, returning its JSON report. Import must retain the
/// identifiers reference audits need, and the CLI's tidy profile omits DOI and
/// other metadata across the entire file — so tidying here would also
/// silently strip unrelated, existing references.
pub(super) fn run_bibcite_input(
    path: &Path, query: &str, supplied: bool, cancel: &AtomicBool,
) -> Result<String, String> {
    let mut command = commands::BIBCITE.command()?;
    command.arg("add").arg("--no-tidy").arg(path);
    if supplied {
        command.arg("--bibtex");
    }
    command.arg(query);
    let output =
        commands::bibcite_output_cancellable(&mut command, Duration::from_secs(60), cancel)?;
    ensure_success("bibcite", &output)?;
    let report = String::from_utf8(output.stdout).map_err(err)?;
    serde_json::from_str::<Value>(&report)
        .map_err(|error| format!("bibcite returned an invalid JSON report: {error}"))?;
    Ok(report)
}

/// Run a bibcite subcommand to completion, with credentials redacted from
/// whatever it prints.
fn run_bibcite(label: &str, command: &mut Command) -> Result<Vec<u8>, String> {
    let output = command
        .output()
        .map(|output| commands::redact_bibcite_output(command, output))
        .map_err(|error| uv_tool_spawn_error("bibcite", &error))?;
    ensure_success(label, &output)?;
    Ok(output.stdout)
}

fn parse_report(stdout: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(stdout)
        .map_err(|error| format!("bibcite returned an invalid JSON report: {error}"))
}

fn run_bibcite_tidy(path: &Path) -> Result<(), String> {
    run_bibcite("bibcite tidy", commands::BIBCITE.command()?.arg("tidy").arg(path)).map(drop)
}

/// A string field of bibcite's report ("key", or "source": what it resolved —
/// "arxiv", "doi", "webpage", …). bibcite prints one indented JSON object on
/// stdout among its diagnostics, so no single line parses; each balanced
/// object is tried, newest first, so a run that reports several entries still
/// yields the last one.
pub(super) fn bibcite_report_field(output: &str, field: &str) -> Option<String> {
    json_objects(output).into_iter().rev().find_map(|chunk| {
        serde_json::from_str::<Value>(&chunk).ok()?.get(field)?.as_str().map(ToString::to_string)
    })
}

/// Every brace-balanced `{…}` in the text, in order. Braces inside strings do
/// not count, or a title containing one would end the object early.
fn json_objects(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = index;
                }
                depth += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    found.push(text[start..index + character.len_utf8()].to_string());
                }
            }
            _ => {}
        }
    }
    found
}

pub(super) fn commit_bibliography(
    root: &Path, relative: &str, contents: &str, label: &str, history: HistoryMode,
) -> Result<(), String> {
    match history {
        HistoryMode::Record => {
            let edit = vec![(relative.to_string(), contents.to_string())];
            project::apply_citation_transaction(root, label, edit)?;
        }
        HistoryMode::Defer => {
            fs::write(project::safe_path(root, relative)?, contents).map_err(err)?;
        }
    }
    Ok(())
}

/// What a removal does about manuscript citations of the key.
#[derive(Clone, Copy, PartialEq)]
pub enum CitationRemovalMode {
    /// Refuse while the manuscript still cites the key.
    Block,
    /// Report the blockers without changing anything.
    Preview,
    /// Remove the entry and leave the citations unresolved.
    Keep,
    /// Remove the entry and its citations.
    Remove,
}

/// Remove the primary bibliography entry for `key`, retaining any downloaded
/// cache.
pub fn remove_reference(
    root: &Path, key: &str, history: HistoryMode, mode: CitationRemovalMode,
) -> Result<RemoveResult, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter a citation key to remove.".to_string());
    }
    let blockers = project::find_citation_usages(root, key)?;
    if mode == CitationRemovalMode::Preview
        || (!blockers.is_empty() && mode == CitationRemovalMode::Block)
    {
        return Ok(RemoveResult { key: key.to_string(), blockers, ..RemoveResult::default() });
    }
    let manifest = project::read_manifest(root)?;
    let path = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = fs::read_to_string(&path).unwrap_or_default();
    let exact_key = project::parse_bibliography(&before)
        .into_iter()
        .find(|entry| entry.key.eq_ignore_ascii_case(key))
        .map(|entry| entry.key)
        .ok_or_else(|| format!("Citation key `{key}` is not in the primary bibliography."))?;
    let after = {
        let scratch = ScratchBibliography::new("lattice-remove", Some(&before))?;
        let mut command = commands::BIBCITE.command()?;
        let stdout = run_bibcite(
            "bibcite",
            command.arg("remove").arg("--no-tidy").arg(&scratch.path).arg(&exact_key),
        )?;
        parse_report(&stdout)?;
        run_bibcite_tidy(&scratch.path)?;
        scratch.read()?
    };
    let (mut file_edits, removed_citations) = if mode == CitationRemovalMode::Remove {
        project::remove_citation_usages(root, &exact_key)?
    } else {
        (Vec::new(), 0)
    };
    file_edits.push((manifest.primary_bibliography.clone(), before, after));
    let changes = file_edits
        .iter()
        .map(|(relative, before, after)| ReferenceFileChange {
            path: relative.clone(),
            before: before.clone(),
            after: after.clone(),
        })
        .collect::<Vec<_>>();
    let changed_files = changes.iter().map(|change| change.path.clone()).collect();
    let transaction_id = match history {
        HistoryMode::Record => project::apply_citation_transaction_checked(
            root,
            &format!("Remove {exact_key}"),
            file_edits,
        )?
        .map(|record| record.id),
        HistoryMode::Defer => {
            for (relative, before, _) in &file_edits {
                let current =
                    fs::read_to_string(project::safe_path(root, relative)?).map_err(err)?;
                if current != *before {
                    return Err(format!(
                        "Cannot remove the reference because {relative} changed. Try again."
                    ));
                }
            }
            for (relative, _, contents) in file_edits {
                fs::write(project::safe_path(root, &relative)?, contents).map_err(err)?;
            }
            None
        }
    };
    Ok(RemoveResult {
        key: exact_key,
        removed: true,
        blockers: Vec::new(),
        changed_files,
        removed_citations,
        transaction_id,
        changes,
    })
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
    let mut after = scratch.read()?;
    if !dry_run && after != before {
        run_bibcite_tidy(&scratch.path)?;
        after = scratch.read()?;
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
    Ok(UpgradeResult { dry_run, changed: after != before, report })
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
mod tests {
    use super::*;
    use crate::papers::test_support::TestProject;
    #[cfg(unix)]
    use crate::papers::test_support::{fake_bibcite, tool_lock, write_test_tool, ToolOverride};
    #[cfg(unix)]
    use crate::test_support::TempDir;
    use CitationRemovalMode::*;

    fn remove(project: &TestProject, key: &str, mode: CitationRemovalMode) -> RemoveResult {
        remove_reference(&project.root, key, HistoryMode::Record, mode).unwrap()
    }

    #[test]
    fn reads_fields_out_of_bibcites_report() {
        let evidence = serde_json::json!({
            "action": "added",
            "key": "smith2024paper",
            "source": "crossref",
            "evidence": {
                "source": "crossref",
                "title": "A {Paper}",
                "author_match": "matched",
                "doi": "10.1234/paper"
            }
        })
        .to_string();
        for (output, key) in [
            // One indented object among diagnostics: no single line parses.
            (
                "{\n  \"query\": \"10.1109/CVPR.2016.90\",\n  \"action\": \"added\",\n  \
                 \"key\": \"he2016deep\",\n  \"title\": \"Deep Residual Learning\",\n  \
                 \"published\": true\n}\n[bibcite] query understood as doi: 10.1109/CVPR.2016.90\n",
                Some("he2016deep"),
            ),
            // Several reported entries: the last key wins.
            (
                "{\"key\": \"first2020\"}\nnoise\n{\n  \"key\": \"second2021\"\n}\n",
                Some("second2021"),
            ),
            // A brace inside a title must not close the object early.
            (
                "{\n  \"title\": \"On {NP}-hardness\",\n  \"key\": \"karp1972\"\n}\n",
                Some("karp1972"),
            ),
            ("[bibcite] No match found anywhere for: x\n", None),
            (r#"{"action":"ambiguous","candidates":[{"doi":"10.1234/a"}]}"#, None),
            // Evidence blocks do not disturb the import report contract.
            (evidence.as_str(), Some("smith2024paper")),
        ] {
            assert_eq!(bibcite_report_field(output, "key").as_deref(), key, "{output}");
        }
        assert_eq!(bibcite_report_field(&evidence, "source").as_deref(), Some("crossref"));
    }

    /// Only a manuscript citation blocks removal — `\nocite` included — and a
    /// blocked removal keeps the downloaded cache.
    #[test]
    fn remove_is_blocked_by_nocite_and_preserves_the_cache() {
        for nocite in ["\\nocite{KEEP}\n", "\\nocite{*}\n"] {
            let project =
                TestProject::new("@article{keep, title={Keep me}, eprint={2401.00001}}\n");
            assert!(project::find_citation_usages(&project.root, "keep").unwrap().is_empty());
            project.write("main.tex", nocite);
            let cache = project.write(".research/papers/2401.00001/paper.md", "cached");

            let result = remove(&project, "keep", Block);
            assert!(!result.removed, "{nocite}");
            assert!(!result.blockers.is_empty());
            assert!(cache.is_file());
            assert!(project.bibliography().contains("keep"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn remove_can_keep_or_delete_manuscript_citations() {
        let _lock = tool_lock();
        let project = TestProject::new(concat!(
            "@article{first, title={First}}\n",
            "@article{target, title={Target}, eprint={2401.00001}}\n",
            "@article{last, title={Last}}\n",
        ));
        let _bibcite = ToolOverride::set(&commands::BIBCITE, &fake_bibcite(&project.parent));
        let manuscript = concat!(
            "% Example only: \\cite{target}\n",
            "Inline example: \\verb|\\cite{target}|.\n",
            "\\begin{verbatim}\n\\cite{target}\n\\end{verbatim}\n",
            "Before \\citep[see][p. 2]{first, TARGET, last} after.\n",
            "Solo \\textcite*{target} remains grammatical.\n",
        );
        let main = project.write("main.tex", manuscript);
        let cache = project.write(".research/papers/2401.00001/paper.md", "cached");

        let preview = remove(&project, "target", Preview);
        assert!(!preview.removed);
        assert_eq!(preview.blockers.len(), 2);
        assert_eq!(fs::read_to_string(&main).unwrap(), manuscript);

        let result = remove(&project, "target", Remove);
        assert!(result.removed);
        assert_eq!(result.removed_citations, 2);
        assert_eq!(result.changed_files, ["main.tex", "references.bib"]);
        let edited = fs::read_to_string(&main).unwrap();
        for kept in [
            "% Example only: \\cite{target}",
            "\\verb|\\cite{target}|",
            "\\begin{verbatim}\n\\cite{target}\n\\end{verbatim}",
            "\\citep[see][p. 2]{first, last}",
            "Solo remains grammatical.",
        ] {
            assert!(edited.contains(kept), "{kept}");
        }
        assert!(!project.bibliography().contains("target"));
        assert!(cache.is_file());
        let history = project::history(&project.root).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].files, vec!["main.tex", "references.bib"]);

        let kept = remove(&project, "first", Keep);
        assert!(kept.removed);
        assert_eq!(kept.removed_citations, 0);
        assert_eq!(kept.changed_files, ["references.bib"]);
        assert_eq!(fs::read_to_string(&main).unwrap(), edited);
        assert!(!project.bibliography().contains("first"));
    }

    #[test]
    fn bulk_upgrade_cannot_change_paper_identity_or_citation_keys() {
        let before = "@misc{old,title={Exact Title},author={Alice Smith and Bob Jones},year={2025},eprint={2510.14979}}";
        let after = before
            .replace("@misc", "@article")
            .replace("year={2025}", "year={2026},doi={10.1234/published}");
        assert!(validate_bibliography_upgrade(before, &after).is_ok());
        for invalid in [
            after.replace("Alice", "Ann"),
            after.replace("Exact Title", "Similar Title"),
            after.replace("2510.14979", "2605.28820"),
            after.replace("{old,", "{new,"),
            format!("{after}\n{after}"),
        ] {
            assert!(validate_bibliography_upgrade(before, &invalid).is_err(), "{invalid}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn citation_import_does_not_strip_existing_identifiers_with_global_tidy() {
        let _lock = tool_lock();
        let parent = TempDir::new("papers");
        let tool = parent.join("bibcite");
        write_test_tool(
            &tool,
            concat!(
                "#!/bin/sh\nset -eu\n",
                "[ \"$1\" = add ] && [ \"$2\" = --no-tidy ] || exit 23\n",
                "printf '\n@article{new2024, title={New paper}, year={2024}}\n' >> \"$3\"\n",
                "printf '{\"key\":\"new2024\"}\n'\n",
            ),
        );
        let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);
        let existing =
            "@article{jumper2021, title={AlphaFold}, doi={10.1038/s41586-021-03819-2}}\n";
        let path = parent.write("references.bib", existing);
        run_bibcite_input(&path, "New paper", false, &AtomicBool::new(false)).unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.starts_with(existing));
        assert!(after.contains("new2024"));
    }
}
