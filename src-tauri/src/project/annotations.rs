//! Local annotations (`.research/annotations.json`): the writer's notes on the
//! source or the PDF, the agent's proposal or question for each, and the
//! revision rounds that asked for them. Each round keeps the text of every
//! file it touched, before and after, under `.research/annotation-rounds/`,
//! so any two rounds can be compared or restored after the project history
//! has pruned its own entries; a settled round is also recorded there as one
//! labelled entry.
//!
//! The file replaces `.research/editor-comments.json`: a project that only has
//! the older file reads it as source annotations, numbered in the order they
//! were made, and the first save writes the new file. The older file is left
//! as it was, so an earlier Lattice still finds the comments it knew.

use super::history::{new_transaction, persist_transaction, HistoryContext};
use super::manifest::write_pretty_json;
use super::paths::validate_transaction_path;
use crate::models::FileChange;
use crate::util::err;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};

const ANNOTATIONS_PATH: &str = ".research/annotations.json";
const LEGACY_COMMENTS_PATH: &str = ".research/editor-comments.json";
const ROUNDS_DIRECTORY: &str = ".research/annotation-rounds";
/// 1 was `editor-comments.json`; 2 adds numbers, intents, PDF anchors,
/// revisions and rounds.
const ANNOTATIONS_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCommentReply {
    pub id: String,
    pub author_id: String,
    pub author_name: String,
    pub body: String,
    pub created_at: String,
}

/// A box on a PDF page, as fractions of the page's width and height.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where on the compiled PDF an annotation was made.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnchor {
    pub page: u32,
    pub rects: Vec<PdfRect>,
    pub text: String,
}

/// The agent's answer to an annotation in a round: a proposed replacement
/// for the quoted text with its reason, or a question for the writer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRevision {
    pub round: u32,
    /// `proposed`, `accepted`, `rejected`, `asked` or `failed`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorComment {
    pub id: String,
    /// The pin's number, kept for the annotation's life. Older comments have
    /// none until they are read as annotations.
    #[serde(default)]
    pub number: u32,
    pub path: String,
    pub from: u32,
    pub to: u32,
    pub quote: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf: Option<PdfAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<AnnotationRevision>,
    pub author_id: String,
    pub author_name: String,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub replies: Vec<EditorCommentReply>,
    pub created_at: String,
    pub updated_at: String,
}

/// One revision round: when it started and settled, what became of each
/// annotation it asked about, and its entry in the project history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRound {
    pub number: u32,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<String>,
    /// Annotation id to its outcome in this round, as `AnnotationRevision::state`.
    #[serde(default)]
    pub outcomes: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotations {
    #[serde(default)]
    pub annotations: Vec<EditorComment>,
    #[serde(default)]
    pub rounds: Vec<AnnotationRound>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationsFile<'a> {
    schema_version: u32,
    annotations: &'a [EditorComment],
    rounds: &'a [AnnotationRound],
}

#[derive(Deserialize)]
struct LegacyCommentsFile {
    comments: Vec<EditorComment>,
}

/// The project's annotations; the older comments file when only it exists.
pub fn read_annotations(root: &Path) -> Result<Annotations, String> {
    let path = root.join(ANNOTATIONS_PATH);
    if path.is_file() {
        let mut annotations: Annotations =
            serde_json::from_str(&fs::read_to_string(path).map_err(err)?).map_err(err)?;
        number_unnumbered(&mut annotations.annotations);
        return Ok(annotations);
    }
    let legacy = root.join(LEGACY_COMMENTS_PATH);
    if !legacy.is_file() {
        return Ok(Annotations { annotations: Vec::new(), rounds: Vec::new() });
    }
    let raw = fs::read_to_string(legacy).map_err(err)?;
    let mut annotations = serde_json::from_str::<LegacyCommentsFile>(&raw).map_err(err)?.comments;
    number_unnumbered(&mut annotations);
    Ok(Annotations { annotations, rounds: Vec::new() })
}

/// The newest save written for each project: saves are sent as the writer
/// makes changes and run on the blocking pool, so two can finish out of order.
static WRITTEN_SAVES: LazyLock<Mutex<HashMap<PathBuf, u64>>> = LazyLock::new(Default::default);

/// Forget the newest saves of projects no window has open.
pub(crate) fn retain_open_annotation_saves(open: &HashSet<PathBuf>) {
    WRITTEN_SAVES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .retain(|root, _| open.contains(root));
}

/// Write the annotations and rounds as save `save` (counting up within this
/// session); a save older than the last one written is dropped, since the
/// state it carries is already superseded.
pub fn write_annotations(
    root: &Path, annotations: Vec<EditorComment>, rounds: Vec<AnnotationRound>, save: u64,
) -> Result<(), String> {
    let mut written = WRITTEN_SAVES.lock().unwrap_or_else(PoisonError::into_inner);
    if written.get(root).is_some_and(|newest| *newest >= save) {
        return Ok(());
    }
    let file = AnnotationsFile {
        schema_version: ANNOTATIONS_SCHEMA_VERSION,
        annotations: &annotations,
        rounds: &rounds,
    };
    write_pretty_json(&root.join(ANNOTATIONS_PATH), &file)?;
    written.insert(root.to_path_buf(), save);
    Ok(())
}

/// Number every annotation without one after the highest in use, oldest
/// first, so pins read in the order the notes were written.
fn number_unnumbered(annotations: &mut [EditorComment]) {
    let mut next = annotations.iter().map(|annotation| annotation.number).max().unwrap_or(0);
    let mut unnumbered =
        annotations.iter_mut().filter(|annotation| annotation.number == 0).collect::<Vec<_>>();
    unnumbered.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    for annotation in unnumbered {
        next += 1;
        annotation.number = next;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoundSnapshot {
    number: u32,
    files: Vec<FileChange>,
}

fn round_path(root: &Path, number: u32) -> PathBuf {
    root.join(ROUNDS_DIRECTORY).join(format!("round-{number}.json"))
}

/// Keep round `number`'s files: their text when it started (`before`) and,
/// once it settled, after (`after`). A settled round with changes is also
/// recorded in the project history as one entry; its id is returned.
pub fn save_annotation_round(
    root: &Path, number: u32, files: Vec<FileChange>, settled: bool,
) -> Result<Option<String>, String> {
    if number == 0 {
        return Err("A revision round is numbered from 1.".to_string());
    }
    for file in &files {
        validate_transaction_path(&file.path)?;
    }
    write_pretty_json(&round_path(root, number), &RoundSnapshot { number, files: files.clone() })?;
    let changes = files
        .into_iter()
        .filter(|file| file.after.is_some() && file.before != file.after)
        .collect::<Vec<_>>();
    if !settled || changes.is_empty() {
        return Ok(None);
    }
    // The files already hold these changes (the writer accepted each in the
    // editor, which saved it); the entry records the round as one version,
    // so restoring it puts back the text from before the round.
    let record = new_transaction(
        &format!("Annotation round {number}"),
        changes,
        HistoryContext::annotations(),
    );
    persist_transaction(root, &record)?;
    Ok(Some(record.id))
}

/// Round `number`'s files, as `save_annotation_round` kept them; empty when
/// the round kept none.
pub fn read_annotation_round(root: &Path, number: u32) -> Result<Vec<FileChange>, String> {
    let path = round_path(root, number);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(err)?;
    Ok(serde_json::from_str::<RoundSnapshot>(&raw).map_err(err)?.files)
}
