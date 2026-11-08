//! Running bibcite, and removing a reference from the primary bibliography
//! (optionally with its manuscript citations), which cuts out only that
//! entry's text. Upgrading preprints lives in `upgrade`.
//!
//! bibcite always works on a scratch copy; nothing reaches the project until
//! the result has been checked and is committed through `commit_bibliography`
//! or the citation transaction.

use super::{ensure_success, uv_tool_spawn_error};
use crate::models::SymbolOccurrence;
use crate::util::err;
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
pub(super) fn run_bibcite(label: &str, command: &mut Command) -> Result<Vec<u8>, String> {
    let output = command
        .output()
        .map(|output| commands::redact_bibcite_output(command, output))
        .map_err(|error| uv_tool_spawn_error("bibcite", &error))?;
    ensure_success(label, &output)?;
    Ok(output.stdout)
}

pub(super) fn parse_report(stdout: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(stdout)
        .map_err(|error| format!("bibcite returned an invalid JSON report: {error}"))
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

/// Remove the primary bibliography entry for `key` through a citation
/// transaction History can undo, retaining any downloaded cache. Only the
/// writer asks for this, from the interface.
pub fn remove_reference(
    root: &Path, key: &str, mode: CitationRemovalMode,
) -> Result<RemoveResult, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter a citation key to remove.".to_string());
    }
    let manifest = project::read_manifest(root)?;
    let path = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = fs::read_to_string(&path).unwrap_or_default();
    let (exact_key, start, end) = project::bibliography_entry_spans(&before)
        .into_iter()
        .find(|(entry, _, _)| entry.eq_ignore_ascii_case(key))
        .ok_or_else(|| format!("Citation key `{key}` is not in the primary bibliography."))?;
    let blockers = project::find_citation_usages(root, &exact_key)?;
    if mode == CitationRemovalMode::Preview
        || (!blockers.is_empty() && mode == CitationRemovalMode::Block)
    {
        return Ok(RemoveResult { key: exact_key, blockers, ..RemoveResult::default() });
    }
    let after = without_entry(&before, start, end);
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
    let transaction_id = project::apply_citation_transaction_checked(
        root,
        &format!("Remove {exact_key}"),
        file_edits,
    )?
    .map(|record| record.id);
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

/// The bibliography without the entry at `start..end` and the blank lines
/// after it; every other byte stays. Not bibcite: its `remove` rewrites every
/// entry (sorted fields, rebraced values) and its tidy drops fields such as
/// volume and pages across the whole file, so deleting one reference lost
/// metadata in the others and Check references saw every entry as changed.
fn without_entry(bibliography: &str, start: usize, end: usize) -> String {
    let rest = bibliography[end..].trim_start_matches([' ', '\t', '\r', '\n']);
    let mut kept = format!("{}{rest}", &bibliography[..start]);
    if rest.is_empty() {
        // The last entry went: so does the separator that preceded it.
        kept.truncate(kept.trim_end().len());
        if !kept.is_empty() {
            kept.push_str(if bibliography.contains("\r\n") { "\r\n" } else { "\n" });
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::test_support::TestProject;
    #[cfg(unix)]
    use crate::papers::test_support::{tool_lock, write_test_tool, ToolOverride};
    #[cfg(unix)]
    use crate::test_support::TempDir;
    use CitationRemovalMode::*;

    fn remove(project: &TestProject, key: &str, mode: CitationRemovalMode) -> RemoveResult {
        remove_reference(&project.root, key, mode).unwrap()
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

    #[test]
    fn remove_can_keep_or_delete_manuscript_citations() {
        let project = TestProject::new(concat!(
            "@article{first, title={First}}\n",
            "@article{target, title={Target}, eprint={2401.00001}}\n",
            "@article{last, title={Last}}\n",
        ));
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

    /// Removing one entry leaves every other byte as the writer wrote it:
    /// field order, spacing, bare numbers and fields bibcite's tidy drops.
    /// Check references keys its saved results on that text.
    #[test]
    fn remove_cuts_out_only_that_entry() {
        let first = "@article{vaswani2017attention,\n  title={Attention is all you need},\n  journal={NeurIPS},\n  volume={30},\n  year={2017}\n}";
        let middle = "@misc{teoh2025nextlatent,\n  title = {Next latent prediction},\n  eprint = {2501.00001}\n}";
        let last = "@inproceedings{he2016deep,\n  author = {He, Kaiming},\n  year = 2016,\n  pages = {770--778}\n}";
        for (contents, key, expected) in [
            (
                format!("% Shared library\n{first}\n\n{middle}\n\n{last}\n"),
                "teoh2025nextlatent",
                format!("% Shared library\n{first}\n\n{last}\n"),
            ),
            (format!("{first}\n\n{middle}\n"), "TEOH2025nextlatent", format!("{first}\n")),
            (format!("{middle}\n\n{last}\n"), "teoh2025nextlatent", format!("{last}\n")),
            (format!("{first}\r\n\r\n{middle}\r\n"), "teoh2025nextlatent", format!("{first}\r\n")),
            (format!("{middle}\n"), "teoh2025nextlatent", String::new()),
        ] {
            let project = TestProject::new(&contents);
            let result = remove(&project, key, Block);
            assert!(result.removed, "{contents}");
            assert_eq!(result.key, "teoh2025nextlatent");
            assert_eq!(project.bibliography(), expected, "{contents}");
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
