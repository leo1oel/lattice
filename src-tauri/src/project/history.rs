//! Undoable project edits. Every content change is a transaction: the files
//! are written atomically, the before/after text lands in
//! `.research/history/<id>.json` (`HISTORY_SCHEMA_VERSION`), and the search
//! index is refreshed. Also here: restoring and deleting history entries, and
//! pruning conversation checkpoints.

use super::manifest::write_pretty_json;
use super::paths::{is_plain_segment, safe_path, validate_transaction_path};
use crate::models::{FileChange, HistoryItem, TransactionRecord};
use crate::project_fs::ProjectDir;
use crate::util::err;
use chrono::Utc;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use uuid::Uuid;

const HISTORY_SCHEMA_VERSION: u32 = 2;
const MAX_HISTORY_ENTRIES: usize = 100;
pub(super) const MAX_CHECKPOINTS_PER_SESSION: usize = 100;
pub(super) const MAX_CHECKPOINT_BYTES: u64 = 256 * 1024 * 1024;
/// Consecutive saves of one file within this window merge into one entry.
const EDIT_COALESCE_SECS: i64 = 45;

/// Who made a change and through which surface, recorded on each transaction.
pub(super) struct HistoryContext {
    actor: &'static str,
    kind: &'static str,
    source: &'static str,
    thread_id: Option<String>,
    checkpoint_ref: Option<String>,
    undo_of: Option<String>,
}

impl HistoryContext {
    pub(super) fn user(kind: &'static str, source: &'static str) -> Self {
        Self { actor: "user", kind, source, thread_id: None, checkpoint_ref: None, undo_of: None }
    }

    fn citation() -> Self {
        Self { actor: "citation", ..Self::user("citation", "citation") }
    }

    fn restore(source: &TransactionRecord) -> Self {
        Self {
            thread_id: source.thread_id.clone(),
            checkpoint_ref: source.checkpoint_ref.clone(),
            undo_of: Some(source.id.clone()),
            ..Self::user("restore", "history")
        }
    }
}

pub(super) fn new_transaction(
    label: &str, changes: Vec<FileChange>, context: HistoryContext,
) -> TransactionRecord {
    TransactionRecord {
        schema_version: HISTORY_SCHEMA_VERSION,
        id: format!("{}-{}", Utc::now().format("%Y%m%dT%H%M%S%.3fZ"), Uuid::new_v4()),
        label: label.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        actor: Some(context.actor.to_string()),
        kind: Some(context.kind.to_string()),
        source: Some(context.source.to_string()),
        thread_id: context.thread_id,
        checkpoint_ref: context.checkpoint_ref,
        undo_of: context.undo_of,
        changes,
    }
}

/// `(actor, kind, source)` of a record; records written before these fields
/// existed get them inferred from their label.
fn history_metadata(record: &TransactionRecord) -> (&str, &str, &str) {
    if let (Some(actor), Some(kind), Some(source)) =
        (record.actor.as_deref(), record.kind.as_deref(), record.source.as_deref())
    {
        return (actor, kind, source);
    }
    let label = record.label.to_ascii_lowercase();
    if label.starts_with("agent:") || label == "agent edit" {
        ("agent", "agent", "agent")
    } else if label.starts_with("cite ")
        || label.starts_with("remove ")
        || label == "upgrade bibliography"
    {
        ("citation", "citation", "citation")
    } else if label.starts_with("restore ") {
        ("user", "restore", "history")
    } else if label.starts_with("edit ") {
        ("user", "edit", "editor")
    } else {
        ("user", "project", "project")
    }
}

fn file_change_has_effect(change: &FileChange) -> bool {
    change.before != change.after
}

/// Current text of a project file, or `None` when it does not exist.
pub(super) fn current_text(path: &Path) -> Result<Option<String>, String> {
    path.exists().then(|| fs::read_to_string(path).map_err(err)).transpose()
}

pub fn apply_transaction(
    root: &Path, label: &str, edits: Vec<(String, String)>,
) -> Result<Option<TransactionRecord>, String> {
    let context = if label.starts_with("Edit ") {
        HistoryContext::user("edit", "editor")
    } else {
        HistoryContext::user("project", "project")
    };
    commit_transaction_changes(root, label, changes_from_disk(root, unchecked(edits))?, context)
}

pub fn apply_citation_transaction(
    root: &Path, label: &str, edits: Vec<(String, String)>,
) -> Result<Option<TransactionRecord>, String> {
    let changes = changes_from_disk(root, unchecked(edits))?;
    commit_transaction_changes(root, label, changes, HistoryContext::citation())
}

/// Apply citation edits only if every source file still has the contents from
/// which the edits were calculated. This prevents a delayed bibliography
/// action from replacing manuscript changes made while its confirmation was
/// open.
pub fn apply_citation_transaction_checked(
    root: &Path, label: &str, edits: Vec<(String, String, String)>,
) -> Result<Option<TransactionRecord>, String> {
    let edits = edits.into_iter().map(|(path, before, after)| (path, Some(before), after));
    let changes = changes_from_disk(root, edits.collect())?;
    commit_transaction_changes(root, label, changes, HistoryContext::citation())
}

fn unchecked(edits: Vec<(String, String)>) -> Vec<(String, Option<String>, String)> {
    edits.into_iter().map(|(path, after)| (path, None, after)).collect()
}

/// What each `(path, expected, after)` edit changes against the file's current
/// text, dropping no-ops. An edit that names the text it was computed from is
/// refused once the file no longer has it.
fn changes_from_disk(
    root: &Path, edits: Vec<(String, Option<String>, String)>,
) -> Result<Vec<FileChange>, String> {
    if edits.is_empty() {
        return Err("The transaction contains no edits.".to_string());
    }
    let mut changes = Vec::with_capacity(edits.len());
    for (relative, expected, after) in edits {
        validate_transaction_path(&relative)?;
        // This path only captures the previous contents. Parent creation and
        // the mutation itself are descriptor-relative in the commit.
        let before = current_text(&root.join(&relative))?;
        if expected.is_some_and(|expected| before.as_deref() != Some(expected.as_str())) {
            return Err(format!(
                "Cannot remove the reference because {relative} changed. Try again."
            ));
        }
        if before.as_ref() != Some(&after) {
            changes.push(FileChange { path: relative, before, after: Some(after) });
        }
    }
    Ok(changes)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorWriteResult {
    pub content: String,
    pub transaction_id: String,
    pub external_changes_merged: bool,
    pub had_conflicts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TextMergeResult {
    content: String,
    had_conflicts: bool,
}

/// Merge one edit against the exact content it observed, without touching disk.
fn merge_text_snapshots(base: &str, edited: &str, current: &str) -> TextMergeResult {
    if edited == base || edited == current {
        return TextMergeResult { content: current.to_string(), had_conflicts: false };
    }
    if current == base {
        return TextMergeResult { content: edited.to_string(), had_conflicts: false };
    }
    match diffy::MergeOptions::new().merge(base, edited, current) {
        Ok(content) => TextMergeResult { content, had_conflicts: false },
        Err(content) => TextMergeResult { content, had_conflicts: true },
    }
}

/// Save an editor buffer against the exact disk contents it was loaded from.
/// Agent and filesystem edits bypass React, so an ordinary last-writer-wins
/// save can otherwise replace a complete external edit with the stale open
/// buffer. A three-way merge preserves both sides, including explicit conflict
/// markers when they touched the same span.
pub fn apply_editor_transaction(
    root: &Path, path: String, content: String, base_content: Option<String>,
    expected_content: Option<String>,
) -> Result<EditorWriteResult, String> {
    validate_transaction_path(&path)?;
    let current = current_text(&root.join(&path))?;
    if current.is_none() && base_content.is_some() {
        return Err(format!("Cannot save {path} because it was deleted outside the editor."));
    }
    let current_content = current.as_deref().unwrap_or_default();

    // Live Overleaf deliveries know the exact disk version they may replace,
    // not the common ancestor needed to merge an arbitrary join snapshot.
    // Fail closed and let normal sync reconcile any external/agent edit.
    if expected_content.is_some_and(|expected| current.as_deref() != Some(expected.as_str())) {
        return Err(format!(
            "Cannot apply the live update because {path} changed outside live editing."
        ));
    }

    let (next, external_changes_merged, had_conflicts) = match base_content {
        Some(base) if current_content != base => {
            let merged = merge_text_snapshots(&base, &content, current_content);
            (merged.content, true, merged.had_conflicts)
        }
        _ => (content, false, false),
    };
    let changes = if current.as_deref() == Some(next.as_str()) {
        Vec::new()
    } else {
        vec![FileChange { path: path.clone(), before: current, after: Some(next.clone()) }]
    };
    let context = HistoryContext::user("edit", "editor");
    let transaction = commit_transaction_changes(root, &format!("Edit {path}"), changes, context)?;
    Ok(EditorWriteResult {
        content: next,
        transaction_id: transaction.map(|record| record.id).unwrap_or_default(),
        external_changes_merged,
        had_conflicts,
    })
}

/// Undo the already-written `changes`, newest first, after `error`; the
/// message names `what` and every file the rollback itself could not restore.
fn rolled_back(
    error: String, root: &Path, project: &ProjectDir, changes: &[FileChange], what: &str,
) -> String {
    let failures = changes
        .iter()
        .rev()
        .filter_map(|change| {
            let result = match &change.before {
                Some(before) => project.atomic_write(&change.path, before.as_bytes()),
                None if root.join(&change.path).exists() => project.remove(&change.path),
                None => Ok(()),
            };
            result.err().map(|failure| format!("{}: {failure}", change.path))
        })
        .collect::<Vec<_>>();
    if failures.is_empty() {
        error
    } else {
        format!("{error} The {what} could not be rolled back: {}", failures.join("; "))
    }
}

fn commit_transaction_changes(
    root: &Path, label: &str, changes: Vec<FileChange>, context: HistoryContext,
) -> Result<Option<TransactionRecord>, String> {
    if changes.is_empty() {
        return Ok(None);
    }

    // Recheck all inputs immediately before the first write. In particular,
    // checked citation edits may have spent time in bibcite after reading the
    // manuscript and must not commit against a newer version.
    for change in &changes {
        if current_text(&root.join(&change.path))? != change.before {
            return Err(format!(
                "Cannot apply the change because {} changed. Try again.",
                change.path
            ));
        }
    }

    let project = ProjectDir::open(root)?;
    let mut applied = 0usize;
    for change in &changes {
        if let Some(after) = &change.after {
            if let Err(error) = project.atomic_write(&change.path, after.as_bytes()) {
                let changes = &changes[..applied];
                return Err(rolled_back(error, root, &project, changes, "partial change"));
            }
            applied += 1;
        }
    }

    let changed = changes
        .iter()
        .filter(|change| file_change_has_effect(change))
        .map(|change| root.join(&change.path))
        .collect::<Vec<_>>();
    let rollback = |error, changes: &[FileChange]| {
        rolled_back(error, root, &project, &changes[..applied], "file changes")
    };
    let record = match coalesce_edit_transaction(root, label, &changes, &context)
        .map_err(|error| rollback(error, &changes))?
    {
        Coalesced::Updated(record) => Some(*record),
        Coalesced::Removed => None,
        Coalesced::No => {
            let record = new_transaction(label, changes, context);
            if let Err(error) = persist_transaction(root, &record) {
                // `persist_transaction` may have written the record before a later
                // pruning failure. Do not leave history claiming a rolled-back edit.
                let _ = fs::remove_file(transaction_path(root, &record.id)?);
                forget_latest_history(root);
                return Err(rollback(error, &record.changes));
            }
            Some(record)
        }
    };
    refresh_search_index(root, &changed);
    Ok(record)
}

pub(super) fn refresh_search_index(root: &Path, paths: &[PathBuf]) {
    if let Err(error) = crate::fts::update_paths(root, paths) {
        eprintln!("Could not update the project search index: {error}");
    }
}

/// What folding a save into the newest history entry did.
enum Coalesced {
    /// Not a quick follow-up save of the same file: it gets its own entry.
    No,
    /// The edit returned the file to where the previous entry started.
    Removed,
    Updated(Box<TransactionRecord>),
}

/// Fold a quick follow-up save of the same file into the newest history entry.
fn coalesce_edit_transaction(
    root: &Path, label: &str, changes: &[FileChange], context: &HistoryContext,
) -> Result<Coalesced, String> {
    let [change] = changes else {
        return Ok(Coalesced::No);
    };
    if !label.starts_with("Edit ") {
        return Ok(Coalesced::No);
    }
    let Some(mut previous) = latest_history_record(root)? else {
        return Ok(Coalesced::No);
    };
    let recent = chrono::DateTime::parse_from_rfc3339(&previous.timestamp).is_ok_and(|time| {
        Utc::now().signed_duration_since(time.with_timezone(&Utc)).num_seconds()
            <= EDIT_COALESCE_SECS
    });
    if previous.label != label
        || previous.changes.len() != 1
        || history_metadata(&previous) != (context.actor, context.kind, context.source)
        || previous.changes[0].path != change.path
        || !recent
    {
        return Ok(Coalesced::No);
    }
    if previous.changes[0].before == change.after {
        fs::remove_file(transaction_path(root, &previous.id)?).map_err(err)?;
        // The next-newest record is unknown without a scan; drop the memo and
        // let the next read rediscover it lazily.
        forget_latest_history(root);
        return Ok(Coalesced::Removed);
    }
    previous.changes[0].after = change.after.clone();
    previous.timestamp = Utc::now().to_rfc3339();
    write_pretty_json(&transaction_path(root, &previous.id)?, &previous)?;
    remember_latest_history(root, &previous);
    Ok(Coalesced::Updated(Box::new(previous)))
}

/// Newest-history record id per project root.
///
/// `coalesce_edit_transaction` needs the newest record on every save, and
/// rediscovering it parses every history file (up to MAX_HISTORY_ENTRIES, each
/// embedding full file contents) — tens of megabytes on the save path. Every
/// in-process mutation (`persist_transaction`, `coalesce_edit_transaction`,
/// `delete_history`) keeps the memo honest; a hit still re-reads that one record
/// and falls back to the full scan on any surprise. A second app process
/// mutating the same project is a pre-existing race this memo does not widen.
static LATEST_HISTORY: LazyLock<Mutex<HashMap<PathBuf, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember_latest_history(root: &Path, record: &TransactionRecord) {
    LATEST_HISTORY.lock().unwrap().insert(root.to_path_buf(), record.id.clone());
}

fn forget_latest_history(root: &Path) {
    LATEST_HISTORY.lock().unwrap().remove(root);
}

fn latest_history_record(root: &Path) -> Result<Option<TransactionRecord>, String> {
    let memoized = LATEST_HISTORY.lock().unwrap().get(root).cloned();
    if let Some(id) = memoized {
        let record = transaction_path(root, &id)
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<TransactionRecord>(&raw).ok())
            .filter(|record| record.changes.iter().any(file_change_has_effect));
        if record.is_some() {
            return Ok(record);
        }
        // The memoized record vanished or no longer parses: rediscover it.
        forget_latest_history(root);
    }
    // On equal timestamps the first record read stays the newest.
    let newest = history_records(root)?.into_iter().reduce(|newest, record| {
        if record.timestamp > newest.timestamp {
            record
        } else {
            newest
        }
    });
    if let Some(record) = &newest {
        remember_latest_history(root, record);
    }
    Ok(newest)
}

/// Every readable record in `.research/history` that still changes a file.
fn history_records(root: &Path) -> Result<Vec<TransactionRecord>, String> {
    let directory = root.join(".research/history");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let raw = fs::read_to_string(&path).map_err(err)?;
        if let Ok(record) = serde_json::from_str::<TransactionRecord>(&raw) {
            if record.changes.iter().any(file_change_has_effect) {
                records.push(record);
            }
        }
    }
    Ok(records)
}

pub fn history(root: &Path) -> Result<Vec<HistoryItem>, String> {
    let mut items = history_records(root)?
        .into_iter()
        .map(|record| {
            let (actor, kind, source) = history_metadata(&record);
            HistoryItem {
                files: record
                    .changes
                    .iter()
                    .filter(|change| file_change_has_effect(change))
                    .map(|change| change.path.clone())
                    .collect(),
                actor: actor.to_string(),
                kind: kind.to_string(),
                source: source.to_string(),
                id: record.id,
                label: record.label,
                timestamp: record.timestamp,
                thread_id: record.thread_id,
                checkpoint_ref: record.checkpoint_ref,
                undo_of: record.undo_of,
            }
        })
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(items)
}

/// Put back what a history entry changed — every file, or only `only_path` —
/// as a new "restore" entry, refusing files edited since.
pub fn revert(
    root: &Path, transaction_id: &str, only_path: Option<&str>,
) -> Result<TransactionRecord, String> {
    let source = get_history_entry(root, transaction_id)?;
    let selected = source
        .changes
        .iter()
        .filter(|change| only_path.is_none_or(|relative| change.path == relative))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err("That file is not part of this history entry.".to_string());
    }

    let mut inverse = Vec::with_capacity(selected.len());
    for change in selected {
        let current = current_text(&safe_path(root, &change.path)?)?;
        if current == change.before {
            continue;
        }
        if current != change.after {
            return Err(format!(
                "Cannot restore {} because it changed after this history entry. Review the newer changes first.",
                change.path
            ));
        }
        inverse.push(FileChange {
            path: change.path.clone(),
            before: current,
            after: change.before.clone(),
        });
    }
    if inverse.is_empty() {
        return Err("The selected files are already at the requested state.".to_string());
    }

    for change in &inverse {
        let path = safe_path(root, &change.path)?;
        match &change.after {
            Some(content) => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(err)?;
                }
                fs::write(path, content).map_err(err)?;
            }
            None if path.exists() => fs::remove_file(path).map_err(err)?,
            None => {}
        }
    }

    let label = match only_path {
        Some(relative) => format!("Restore {relative} from {}", source.label),
        None => format!("Restore {}", source.label),
    };
    let record = new_transaction(&label, inverse, HistoryContext::restore(&source));
    persist_transaction(root, &record)?;
    Ok(record)
}

pub fn delete_history(root: &Path, transaction_id: &str) -> Result<(), String> {
    fs::remove_file(transaction_path(root, transaction_id)?).map_err(err)?;
    // Only the newest record is memoized; deleting any other leaves it valid.
    let mut memo = LATEST_HISTORY.lock().unwrap();
    if memo.get(root).is_some_and(|id| id == transaction_id) {
        memo.remove(root);
    }
    Ok(())
}

pub fn get_history_entry(root: &Path, transaction_id: &str) -> Result<TransactionRecord, String> {
    let history_path = transaction_path(root, transaction_id)?;
    if !history_path.is_file() {
        return Err("That history entry no longer exists.".to_string());
    }
    let raw = fs::read_to_string(history_path).map_err(err)?;
    let mut record: TransactionRecord = serde_json::from_str(&raw).map_err(err)?;
    record.changes.retain(file_change_has_effect);
    Ok(record)
}

fn transaction_path(root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    if !is_plain_segment(transaction_id) {
        return Err("Invalid transaction id.".to_string());
    }
    Ok(root.join(".research/history").join(format!("{transaction_id}.json")))
}

pub(super) fn persist_transaction(root: &Path, record: &TransactionRecord) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(record).map_err(err)?;
    let project = ProjectDir::open(root)?;
    project.atomic_write(
        &format!(".research/history/{}.json", record.id),
        format!("{raw}\n").as_bytes(),
    )?;
    project.prune_json_files(".research/history", MAX_HISTORY_ENTRIES)?;
    // Every caller builds the record via new_transaction (timestamp = now),
    // so it is by construction the newest; pruning only drops the oldest.
    remember_latest_history(root, record);
    Ok(())
}

/// Keep at most `per_session_limit` newest checkpoints per conversation and
/// `total_byte_limit` bytes overall under `.research/checkpoints`, clearing
/// interrupted `.tmp` writes and emptied session folders.
pub(super) fn prune_conversation_checkpoints(
    root: &Path, per_session_limit: usize, total_byte_limit: u64,
) -> Result<(), String> {
    let directory = root.join(".research/checkpoints");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() => {}
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(err(error)),
        _ => return Ok(()),
    }
    let mut entries = Vec::new();
    let mut session_directories = Vec::new();
    for session in fs::read_dir(&directory).map_err(err)? {
        let session = session.map_err(err)?;
        if !session.file_type().map_err(err)?.is_dir() {
            continue;
        }
        session_directories.push(session.path());
        for checkpoint in fs::read_dir(session.path()).map_err(err)? {
            let checkpoint = checkpoint.map_err(err)?;
            let path = checkpoint.path();
            if !checkpoint.file_type().map_err(err)?.is_file() {
                continue;
            }
            match path.extension().and_then(|extension| extension.to_str()) {
                Some("tmp") => fs::remove_file(path).map_err(err)?,
                Some("json") => {
                    let metadata = checkpoint.metadata().map_err(err)?;
                    let modified = metadata.modified().map_err(err)?;
                    entries.push((modified, session.file_name(), metadata.len(), path));
                }
                _ => {}
            }
        }
    }
    // Newest first.
    entries.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.3.cmp(&left.3)));
    let mut per_session = BTreeMap::new();
    let mut kept_bytes = 0u64;
    for (_, session, size, path) in entries {
        let session_count = per_session.entry(session).or_insert(0usize);
        if *session_count < per_session_limit && kept_bytes.saturating_add(size) <= total_byte_limit
        {
            *session_count += 1;
            kept_bytes = kept_bytes.saturating_add(size);
        } else {
            fs::remove_file(path).map_err(err)?;
        }
    }
    for session in session_directories {
        if let Err(error) = fs::remove_dir(session) {
            if !matches!(error.kind(), ErrorKind::DirectoryNotEmpty | ErrorKind::NotFound) {
                return Err(err(error));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::entries::{create_entry, delete_entry};
    use crate::project::test_support::Fixture;

    fn edits(files: &[(&str, &str)]) -> Vec<(String, String)> {
        files.iter().map(|(path, content)| (path.to_string(), content.to_string())).collect()
    }

    fn editor_save(
        fixture: &Fixture, path: &str, content: &str, base: Option<&str>, expected: Option<&str>,
    ) -> Result<EditorWriteResult, String> {
        apply_editor_transaction(
            &fixture.root,
            path.to_string(),
            content.to_string(),
            base.map(str::to_string),
            expected.map(str::to_string),
        )
    }

    #[test]
    fn transactions_revert_edits_creations_and_deletions_but_never_newer_changes() {
        let fixture = Fixture::project("transaction");
        let root = &fixture.root;
        fixture.write("main.tex", "before");
        let transaction =
            apply_transaction(root, "edit", edits(&[("main.tex", "after")])).unwrap().unwrap();
        assert_eq!(fixture.read("main.tex"), "after");
        let restore = revert(root, &transaction.id, None).unwrap();
        assert_eq!(fixture.read("main.tex"), "before");
        assert_eq!(history(root).unwrap().len(), 2);
        assert!(transaction_path(root, &transaction.id).unwrap().exists());
        assert_eq!(restore.undo_of.as_deref(), Some(transaction.id.as_str()));
        assert_eq!(restore.kind.as_deref(), Some("restore"));

        // A file changed since the entry is never overwritten by a restore.
        fixture.write("main.tex", "newer");
        let error = revert(root, &transaction.id, None).unwrap_err();
        assert!(error.contains("changed after this history entry"));
        assert_eq!(fixture.read("main.tex"), "newer");
        assert_eq!(history(root).unwrap().len(), 2);

        // Deleting entries forgets them without touching the file.
        for item in history(root).unwrap() {
            delete_history(root, &item.id).unwrap();
        }
        assert_eq!(fixture.read("main.tex"), "newer");
        assert!(history(root).unwrap().is_empty());

        // Creating and deleting files revert as well.
        create_entry(root, "created.tex", "file").unwrap();
        fixture.write("removed.tex", "remove me");
        delete_entry(root, "removed.tex").unwrap();
        for item in history(root).unwrap() {
            let restore = revert(root, &item.id, None).unwrap();
            assert_eq!(restore.undo_of.as_deref(), Some(item.id.as_str()));
        }
        assert!(!fixture.path("created.tex").exists());
        assert_eq!(fixture.read("removed.tex"), "remove me");
    }

    #[test]
    fn live_editor_write_requires_the_expected_disk_snapshot() {
        let fixture = Fixture::empty("live-editor-agent-race");
        fixture.write("section.tex", "agent caption");
        for remote in ["old caption", "remote caption"] {
            let result = editor_save(&fixture, "section.tex", remote, None, Some("old caption"));
            assert!(result.unwrap_err().contains("changed outside live editing"));
            assert_eq!(fixture.read("section.tex"), "agent caption");
        }
        assert!(history(&fixture.root).unwrap().is_empty());
        fs::remove_file(fixture.path("section.tex")).unwrap();
        assert!(editor_save(&fixture, "section.tex", "remote caption", None, Some("old caption"))
            .is_err());
        assert!(!fixture.path("section.tex").exists());
        fixture.write("section.tex", "old caption");
        let result =
            editor_save(&fixture, "section.tex", "remote caption", None, Some("old caption"))
                .unwrap();
        assert_eq!(result.content, "remote caption");
        assert_eq!(fixture.read("section.tex"), "remote caption");
    }

    #[test]
    fn editor_saves_merge_against_external_agent_edits() {
        let fixture = Fixture::empty("editor-agent-merge");
        // A stale clean buffer keeps the complete external edit.
        let seed = "# Draft\n\nInitial notes\n";
        let agent_draft = "# Native VLM\n\n## Results\n\n![Result](figures/result.png)\n";
        fixture.write("draft.md", agent_draft);
        let result = editor_save(&fixture, "draft.md", seed, Some(seed), None).unwrap();
        assert_eq!(result.content, agent_draft);
        assert!(result.external_changes_merged && !result.had_conflicts);
        assert_eq!(fixture.read("draft.md"), agent_draft);
        assert!(history(&fixture.root).unwrap().is_empty());

        // Non-overlapping local and agent edits both survive.
        fixture.write("draft.md", "# Finished deck\n\nShared point\n");
        let local = "# Draft\n\nShared point\n\nLocal note\n";
        let result =
            editor_save(&fixture, "draft.md", local, Some("# Draft\n\nShared point\n"), None)
                .unwrap();
        assert!(result.external_changes_merged && !result.had_conflicts);
        assert!(
            result.content.contains("# Finished deck") && result.content.contains("Local note")
        );
        assert_eq!(fixture.read("draft.md"), result.content);

        // Overlapping edits keep both sides behind conflict markers.
        fixture.write("draft.md", "# Agent title\n");
        let result =
            editor_save(&fixture, "draft.md", "# Local title\n", Some("# Draft title\n"), None)
                .unwrap();
        assert!(result.had_conflicts);
        for side in ["<<<<<<<", "# Local title", "# Agent title"] {
            assert!(result.content.contains(side), "{side}");
        }
        assert_eq!(fixture.read("draft.md"), result.content);
    }

    #[test]
    fn transaction_rolls_back_files_written_before_a_later_write_fails() {
        let fixture = Fixture::empty("transaction-rollback");
        let outside = Fixture::empty("transaction-rollback-outside");
        fixture.write("first.tex", "first before");
        outside.write("second.tex", "second before");
        std::os::unix::fs::symlink(outside.path("second.tex"), fixture.path("second.tex")).unwrap();

        let two = edits(&[("first.tex", "first after"), ("second.tex", "second after")]);
        assert!(apply_transaction(&fixture.root, "Edit two files", two).is_err());
        assert_eq!(fixture.read("first.tex"), "first before");
        assert_eq!(outside.read("second.tex"), "second before");
        assert!(history(&fixture.root).unwrap().is_empty());
    }

    #[test]
    fn legacy_and_unchanged_history_records_are_read_without_rewriting_them() {
        let fixture = Fixture::empty("legacy-history-metadata");
        let record = |id: &str, label: &str, before: &str| {
            format!(
                r#"{{"id": "{id}", "label": "{label}", "timestamp": "2026-07-29T12:00:00Z",
                "changes": [{{"path":"main.tex","before":"{before}","after":"new"}}]}}"#
            )
        };
        fixture.write(
            ".research/history/legacy.json",
            record("legacy", "Agent: revise the abstract", "old"),
        );
        // A record whose change has no effect is hidden.
        fixture
            .write(".research/history/unchanged.json", record("unchanged", "Edit main.tex", "new"));

        let items = history(&fixture.root).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(
            (items[0].actor.as_str(), items[0].kind.as_str(), items[0].source.as_str()),
            ("agent", "agent", "agent")
        );
        assert_eq!(get_history_entry(&fixture.root, "legacy").unwrap().schema_version, 1);
    }

    #[test]
    fn conversation_checkpoints_are_pruned_by_session_and_total_size() {
        let fixture = Fixture::empty("conversation-checkpoint-limit");
        let sessions = [Uuid::new_v4(), Uuid::new_v4()];
        for session in sessions {
            for _ in 0..4 {
                fixture.write(
                    &format!(".research/checkpoints/{session}/{}.json", Uuid::new_v4()),
                    "0123456789",
                );
            }
        }

        prune_conversation_checkpoints(&fixture.root, 2, 30).unwrap();

        let remaining = walkdir::WalkDir::new(fixture.path(".research/checkpoints"))
            .into_iter()
            .flatten()
            .filter(|entry| entry.file_type().is_file())
            .count();
        assert_eq!(remaining, 3);
        for session in sessions {
            let directory = fixture.path(&format!(".research/checkpoints/{session}"));
            assert!(fs::read_dir(directory).unwrap().count() <= 2);
        }
    }

    #[test]
    fn rapid_edits_coalesce_and_multi_file_entries_restore_single_files() {
        let fixture = Fixture::project("history-coalesce");
        let root = &fixture.root;
        let original = fixture.read("main.tex");
        apply_transaction(root, "Edit main.tex", edits(&[("main.tex", "% one\n")])).unwrap();
        apply_transaction(root, "Edit main.tex", edits(&[("main.tex", "% two\n")])).unwrap();
        let items = history(root).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "Edit main.tex");
        let entry = get_history_entry(root, &items[0].id).unwrap();
        assert_eq!(entry.changes[0].after.as_deref(), Some("% two\n"));
        assert_eq!(entry.changes[0].before.as_deref(), Some(original.as_str()));
        assert!(get_history_entry(root, "../escape").is_err());

        // Returning to the original content removes the coalesced entry, and
        // saving unchanged content then records nothing.
        for _ in 0..2 {
            let transaction =
                apply_transaction(root, "Edit main.tex", edits(&[("main.tex", &original)]))
                    .unwrap();
            assert!(transaction.is_none());
            assert_eq!(fixture.read("main.tex"), original);
            assert!(history(root).unwrap().is_empty());
        }

        // One file of a multi-file entry restores on its own.
        let both = edits(&[("main.tex", "% main-new\n"), ("references.bib", "% bib-new\n")]);
        let entry = apply_transaction(root, "Edit both", both).unwrap().unwrap();
        revert(root, &entry.id, Some("main.tex")).unwrap();
        assert_eq!(fixture.read("main.tex"), original);
        assert_eq!(fixture.read("references.bib"), "% bib-new\n");
        assert!(transaction_path(root, &entry.id).unwrap().exists());
    }

    #[test]
    fn latest_history_memo_tracks_mutations() {
        let fixture = Fixture::project("history-memo");
        let root = &fixture.root;
        // Distinct labels so the two records do not coalesce.
        apply_transaction(root, "Edit main.tex", edits(&[("main.tex", "% a\n")])).unwrap();
        let refs = edits(&[("refs.bib", "@misc{x}\n")]);
        let newest = apply_transaction(root, "Update refs.bib", refs).unwrap().unwrap();
        assert_eq!(latest_history_record(root).unwrap().unwrap().id, newest.id);
        // A memo hit must agree with a cold directory scan.
        forget_latest_history(root);
        assert_eq!(latest_history_record(root).unwrap().unwrap().id, newest.id);
        // Deleting a non-newest record leaves the memo valid.
        let items = history(root).unwrap();
        let older = items.iter().find(|item| item.id != newest.id).unwrap();
        delete_history(root, &older.id).unwrap();
        assert_eq!(latest_history_record(root).unwrap().unwrap().id, newest.id);
        // Deleting the newest invalidates it; the rescan finds nothing left.
        delete_history(root, &newest.id).unwrap();
        assert!(latest_history_record(root).unwrap().is_none());
    }
}
