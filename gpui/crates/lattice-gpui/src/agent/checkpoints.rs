//! The Agent's checkpoint history, as the Tauri app's
//! `src/app/use-agent-checkpoints.ts` keeps it from the snapshots Synara
//! streams (`lattice:project-history`, parsed as `synara-runtime.ts`'s
//! `parseAgentProjectHistorySnapshot` parses it).
//!
//! An Agent turn edits files on disk without passing through the editor, so
//! no save builds the PDF for it. The snapshots re-arrive on every update of
//! the panel's thread (and stream while a turn is still editing), so a
//! rebuild follows only the entries whose files actually changed, and never
//! the first snapshot of a thread, which replays its history. Undo clears a
//! turn's diff, so Synara leaves that entry out of the next snapshot: that is
//! disk work too, and rebuilds at once.
//!
//! Each build credits the checkpoints present at the start of its pass to
//! itself, and the Agent hears how it went (`lattice:agent-compile-result`,
//! `parseAgentCompileResultMessage`'s shape). The kept entries are the
//! History panel's checkpoint rows; only the open thread's can be undone.
//!
//! This is the model alone: the shell (`shell/agent_flow.rs`) feeds it the
//! page's snapshots and runs what it decides.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::LazyLock,
    time::Duration,
};

use regex::Regex;
use serde_json::{Value, json};

/// `LATTICE_PROJECT_HISTORY` (`synara-runtime.ts`).
const PROJECT_HISTORY: &str = "lattice:project-history";
/// `LATTICE_RESTORE_AGENT_CHECKPOINT`.
pub const RESTORE_AGENT_CHECKPOINT: &str = "lattice:restore-agent-checkpoint";
/// `LATTICE_AGENT_COMPILE_RESULT`.
const AGENT_COMPILE_RESULT: &str = "lattice:agent-compile-result";

/// How long fresh Agent edits must rest before the PDF is built for them.
pub const QUIET: Duration = Duration::from_millis(1_500);

/// One file a checkpoint changed, with its line counts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSummary {
    pub path: String,
    /// `added`, `modified`, `deleted` or `renamed`, as Synara names it.
    pub kind: String,
    pub additions: u64,
    pub deletions: u64,
}

/// One checkpoint of an Agent turn (`AgentCheckpointHistoryEntry`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub timestamp: String,
    pub thread_id: String,
    pub thread_title: String,
    pub turn_id: String,
    pub turn_count: u64,
    pub checkpoint_ref: String,
    pub files: Vec<FileSummary>,
}

impl Entry {
    fn key(&self) -> (String, String) {
        (self.thread_id.clone(), self.id.clone())
    }

    /// A file outside Lattice's records and Git's own: an input of the build.
    fn touches_build(&self) -> bool {
        self.files.iter().any(|file| is_build_input(&file.path))
    }
}

fn is_build_input(path: &str) -> bool {
    !path.starts_with(".research/") && !path.starts_with(".git/")
}

/// One snapshot of the panel's thread (`AgentProjectHistorySnapshot`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub active_thread_id: String,
    pub entries: Vec<Entry>,
}

/// A checkpoint a build will report to (`AgentCompileAssociation`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Association {
    pub thread_id: String,
    pub turn_id: String,
    pub checkpoint_ref: String,
}

/// What one snapshot asks of the window.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// Build the PDF after this long, the timer restarted.
    pub build: Option<Duration>,
    /// Files an Undo put back, to look for the conflict markers it leaves
    /// where newer edits overlap the Agent's change.
    pub undone: Vec<String>,
}

/// The Agent's checkpoints in one window, for the project it shows.
#[derive(Default)]
pub struct Checkpoints {
    by_thread: BTreeMap<String, Vec<Entry>>,
    active_thread: Option<String>,
    /// Every entry seen, by thread and id, for what changed.
    seen: HashMap<(String, String), Entry>,
    /// Threads whose first snapshot (their history replayed) has arrived.
    primed: HashSet<String>,
    /// The checkpoints the next build will report to, in arrival order.
    pending: Vec<((String, String), Association)>,
}

impl Checkpoints {
    /// Every thread's checkpoints, the History panel's rows.
    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.by_thread.values().flatten()
    }

    /// Whether `thread` is the panel's, so its checkpoints can be undone.
    pub fn restorable(&self, thread: &str) -> bool {
        self.active_thread.as_deref() == Some(thread)
    }

    /// Take one snapshot in; `automatic` is the Automatic build setting.
    pub fn handle(&mut self, snapshot: Snapshot, automatic: bool) -> Outcome {
        let thread = snapshot.active_thread_id.clone();
        let incoming: HashSet<(String, String)> = snapshot.entries.iter().map(Entry::key).collect();
        let mut removed = Vec::new();
        self.seen.retain(|key, entry| {
            if entry.thread_id != thread || incoming.contains(key) {
                return true;
            }
            removed.push(entry.clone());
            false
        });
        self.pending
            .retain(|(key, _)| !removed.iter().any(|entry| entry.key() == *key));
        let mut changed = Vec::new();
        for entry in &snapshot.entries {
            let previous = self.seen.insert(entry.key(), entry.clone());
            // Equal line counts do not mean equal content: a regenerated
            // checkpoint moves its time and ref too.
            if previous.as_ref().is_none_or(|previous| {
                previous.timestamp != entry.timestamp
                    || previous.checkpoint_ref != entry.checkpoint_ref
                    || previous.files != entry.files
            }) {
                changed.push(entry.clone());
            }
        }
        self.by_thread.insert(thread.clone(), snapshot.entries);
        self.active_thread = Some(thread.clone());
        if self.primed.insert(thread) {
            return Outcome::default();
        }
        let undone = unique(
            removed
                .iter()
                .flat_map(|entry| entry.files.iter().map(|file| file.path.clone()))
                .filter(|path| is_build_input(path)),
        );
        let built: Vec<&Entry> = changed
            .iter()
            .filter(|entry| entry.touches_build())
            .collect();
        let restored: Vec<&Entry> = removed
            .iter()
            .filter(|entry| entry.touches_build())
            .collect();
        let mut outcome = Outcome {
            build: None,
            undone,
        };
        if restored.is_empty() && (built.is_empty() || !automatic) {
            return outcome;
        }
        for entry in built {
            let key = entry.key();
            let association = Association {
                thread_id: entry.thread_id.clone(),
                turn_id: entry.turn_id.clone(),
                checkpoint_ref: entry.checkpoint_ref.clone(),
            };
            match self.pending.iter_mut().find(|(pending, _)| *pending == key) {
                Some(slot) => slot.1 = association,
                None => self.pending.push((key, association)),
            }
        }
        outcome.build = Some(if restored.is_empty() {
            QUIET
        } else {
            Duration::ZERO
        });
        outcome
    }

    /// The associations for the checkpoints the build starting now covers.
    pub fn take_pending(&mut self) -> Vec<Association> {
        std::mem::take(&mut self.pending)
            .into_iter()
            .map(|(_, association)| association)
            .collect()
    }
}

fn unique(paths: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    paths.filter(|path| seen.insert(path.clone())).collect()
}

/// How a build went, for the turns it covers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Compiled {
    pub success: bool,
    pub duration_ms: Option<u64>,
    pub root_document: Option<String>,
    pub errors: usize,
    pub warnings: usize,
}

impl Compiled {
    pub fn of(result: &lattice_core::latex::BuildResult) -> Self {
        let count = |level: &str| {
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.level == level)
                .count()
        };
        Self {
            success: result.success,
            duration_ms: Some(u64::try_from(result.duration_ms).unwrap_or(u64::MAX)),
            root_document: Some(result.root_document.replace('\\', "/"))
                .filter(|path| is_workspace_relative(path, 1_024)),
            errors: count("error"),
            warnings: count("warning"),
        }
    }
}

/// The message that tells the Agent how the build crediting `association`
/// went; `compiled` is `None` for one that never ran or could not finish.
pub fn compile_result(association: &Association, compiled: Option<&Compiled>, now: &str) -> Value {
    let compiled = compiled.cloned().unwrap_or_default();
    json!({
        "type": AGENT_COMPILE_RESULT,
        "version": 1,
        "threadId": association.thread_id,
        "turnId": association.turn_id,
        "checkpointRef": association.checkpoint_ref,
        "compiledAt": now,
        "success": compiled.success,
        "durationMs": compiled.duration_ms,
        "rootDocument": compiled.root_document,
        "diagnostics": { "errors": compiled.errors, "warnings": compiled.warnings },
    })
}

/// The Agent's Undo of one turn, from its History row.
pub fn restore(entry: &Entry) -> Value {
    json!({
        "type": RESTORE_AGENT_CHECKPOINT,
        "threadId": entry.thread_id,
        "turnCount": entry.turn_count,
    })
}

/// The time now as JavaScript's `toISOString` writes it.
pub fn now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

static CORRELATION_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$").expect("the correlation id pattern compiles")
});
static UTC_TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$")
        .expect("the timestamp pattern compiles")
});
static URL_SCHEME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z][A-Za-z0-9+.-]*:").expect("the scheme pattern compiles")
});

/// `boundedCorrelationId`.
fn correlation_id(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (!text.is_empty() && text.encode_utf16().count() <= 512 && CORRELATION_ID.is_match(text))
        .then(|| text.to_string())
}

/// `isWorkspaceRelativePath` (`agent-protocol.ts`).
pub fn is_workspace_relative(path: &str, max: usize) -> bool {
    !path.is_empty()
        && path.encode_utf16().count() <= max
        && !path.starts_with('/')
        && !(path.len() >= 2
            && path.as_bytes()[0].is_ascii_alphabetic()
            && path.as_bytes()[1] == b':')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// `projectRelativePath`.
fn project_relative(value: &Value) -> Option<String> {
    let path = value.as_str()?;
    (is_workspace_relative(path, 1_024) && !path.contains('\0') && !URL_SCHEME.is_match(path))
        .then(|| path.to_string())
}

/// `strictUtcTimestamp`: a UTC time JavaScript would write back unchanged.
fn utc_timestamp(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    if text.len() > 32 || !UTC_TIMESTAMP.is_match(text) {
        return None;
    }
    let at = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    let canonical = at
        .with_timezone(&chrono::Utc)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    (text == canonical || text == canonical.replace(".000Z", "Z")).then(|| text.to_string())
}

fn count(value: &Value) -> Option<u64> {
    value.as_u64()
}

fn file_summary(value: &Value) -> Option<FileSummary> {
    Some(FileSummary {
        path: project_relative(value.get("path")?)?,
        kind: value.get("kind")?.as_str()?.to_string(),
        additions: count(value.get("additions")?)?,
        deletions: count(value.get("deletions")?)?,
    })
}

fn entry(value: &Value) -> Option<Entry> {
    Some(Entry {
        id: correlation_id(value.get("id")?)?,
        label: value.get("label")?.as_str()?.to_string(),
        timestamp: utc_timestamp(value.get("timestamp")?)?,
        thread_id: correlation_id(value.get("threadId")?)?,
        thread_title: value.get("threadTitle")?.as_str()?.to_string(),
        turn_id: correlation_id(value.get("turnId")?)?,
        turn_count: count(value.get("turnCount")?)?,
        checkpoint_ref: correlation_id(value.get("checkpointRef")?)?,
        files: value
            .get("files")?
            .as_array()?
            .iter()
            .map(file_summary)
            .collect::<Option<_>>()?,
    })
}

/// A snapshot as the page relays it, or `None` for anything else: one bad
/// entry refuses the whole snapshot, as the Tauri app's parser does.
pub fn parse_snapshot(value: &Value) -> Option<Snapshot> {
    if value.get("type")?.as_str()? != PROJECT_HISTORY {
        return None;
    }
    Some(Snapshot {
        active_thread_id: correlation_id(value.get("activeThreadId")?)?,
        entries: value
            .get("entries")?
            .as_array()?
            .iter()
            .map(entry)
            .collect::<Option<_>>()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(id: &str, thread: &str, at: &str, files: &[(&str, u64)]) -> Value {
        json!({
            "id": id,
            "label": format!("Turn {id}"),
            "timestamp": at,
            "threadId": thread,
            "threadTitle": "Introduction revision",
            "turnId": format!("turn-{id}"),
            "turnCount": 1,
            "checkpointRef": format!("refs/lattice/checkpoints/{id}"),
            "files": files.iter().map(|(path, added)| json!({
                "path": path, "kind": "modified", "additions": added, "deletions": 0,
            })).collect::<Vec<_>>(),
        })
    }

    fn snapshot(thread: &str, entries: Vec<Value>) -> Snapshot {
        parse_snapshot(&json!({
            "type": PROJECT_HISTORY,
            "activeThreadId": thread,
            "entries": entries,
        }))
        .expect("the snapshot parses")
    }

    const AT: &str = "2026-11-14T10:00:00.000Z";

    #[test]
    fn parses_only_what_the_tauri_parser_accepts() {
        let good = snapshot(
            "thread-1",
            vec![wire("a", "thread-1", AT, &[("main.tex", 4)])],
        );
        assert_eq!(good.entries[0].files[0].additions, 4);
        assert_eq!(good.entries[0].thread_title, "Introduction revision");
        let bad = |entry: Value| {
            parse_snapshot(&json!({
                "type": PROJECT_HISTORY, "activeThreadId": "thread-1", "entries": [entry],
            }))
        };
        assert!(bad(wire("a", "thread-1", "2026-11-14T10:00:00+01:00", &[])).is_none());
        assert!(bad(wire("a", "thread-1", AT, &[("../outside.tex", 1)])).is_none());
        assert!(bad(wire("a", "thread-1", AT, &[("/abs.tex", 1)])).is_none());
        assert!(bad(wire("-a", "thread-1", AT, &[])).is_none());
        // Synara's own seconds-only stamp is JavaScript's canonical one too.
        assert!(bad(wire("a", "thread-1", "2026-11-14T10:00:00Z", &[])).is_some());
        assert!(parse_snapshot(&json!({ "type": "other" })).is_none());
    }

    #[test]
    fn the_first_snapshot_of_a_thread_replays_history_and_builds_nothing() {
        let mut checkpoints = Checkpoints::default();
        let first = checkpoints.handle(
            snapshot("t", vec![wire("a", "t", AT, &[("main.tex", 1)])]),
            true,
        );
        assert_eq!(first, Outcome::default());
        assert_eq!(checkpoints.entries().count(), 1);
        assert!(checkpoints.restorable("t"));
        assert!(checkpoints.take_pending().is_empty());
    }

    #[test]
    fn fresh_agent_edits_build_once_they_rest_and_credit_the_build() {
        let mut checkpoints = Checkpoints::default();
        let a = wire("a", "t", AT, &[("main.tex", 1)]);
        checkpoints.handle(snapshot("t", vec![a.clone()]), true);
        // The same snapshot again changes nothing.
        assert_eq!(
            checkpoints.handle(snapshot("t", vec![a.clone()]), true),
            Outcome::default()
        );
        let b = wire(
            "b",
            "t",
            "2026-11-14T10:01:00.000Z",
            &[("chapters/intro.tex", 3)],
        );
        let outcome = checkpoints.handle(snapshot("t", vec![a.clone(), b.clone()]), true);
        assert_eq!(outcome.build, Some(QUIET));
        assert!(outcome.undone.is_empty());
        let pending = checkpoints.take_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].turn_id, "turn-b");
        assert!(checkpoints.take_pending().is_empty());
        // Manual builds: nothing builds.
        let c = wire("c", "t", "2026-11-14T10:02:00.000Z", &[("main.tex", 2)]);
        let manual = checkpoints.handle(snapshot("t", vec![a, b, c]), false);
        assert_eq!(manual.build, None);
        assert!(checkpoints.take_pending().is_empty());
    }

    #[test]
    fn an_undo_builds_at_once_even_with_manual_builds() {
        let mut checkpoints = Checkpoints::default();
        let a = wire("a", "t", AT, &[("main.tex", 1)]);
        let b = wire("b", "t", AT, &[("refs.bib", 1), (".research/notes.md", 1)]);
        checkpoints.handle(snapshot("t", vec![a.clone(), b]), false);
        let outcome = checkpoints.handle(snapshot("t", vec![a]), false);
        assert_eq!(outcome.build, Some(Duration::ZERO));
        assert_eq!(outcome.undone, vec!["refs.bib".to_string()]);
    }

    #[test]
    fn edits_to_lattices_own_records_build_nothing() {
        let mut checkpoints = Checkpoints::default();
        checkpoints.handle(snapshot("t", vec![]), true);
        let notes = wire("n", "t", AT, &[(".research/notes.md", 1)]);
        let outcome = checkpoints.handle(snapshot("t", vec![notes]), true);
        assert_eq!(outcome, Outcome::default());
    }

    #[test]
    fn another_threads_checkpoints_stay_but_only_the_open_one_restores() {
        let mut checkpoints = Checkpoints::default();
        checkpoints.handle(
            snapshot("one", vec![wire("a", "one", AT, &[("a.tex", 1)])]),
            true,
        );
        checkpoints.handle(
            snapshot("two", vec![wire("b", "two", AT, &[("b.tex", 1)])]),
            true,
        );
        assert_eq!(checkpoints.entries().count(), 2);
        assert!(!checkpoints.restorable("one"));
        assert!(checkpoints.restorable("two"));
        // Thread two's snapshot never counts thread one's entries as undone.
        let again = checkpoints.handle(
            snapshot("two", vec![wire("b", "two", AT, &[("b.tex", 1)])]),
            true,
        );
        assert!(again.undone.is_empty());
    }

    #[test]
    fn the_compile_result_has_the_tauri_messages_keys() {
        let association = Association {
            thread_id: "t".into(),
            turn_id: "turn".into(),
            checkpoint_ref: "refs/x".into(),
        };
        let compiled = Compiled {
            success: true,
            duration_ms: Some(812),
            root_document: Some("main.tex".into()),
            errors: 0,
            warnings: 2,
        };
        let message = compile_result(&association, Some(&compiled), "2026-11-14T10:00:00.000Z");
        assert_eq!(message["type"], AGENT_COMPILE_RESULT);
        assert_eq!(message["diagnostics"]["warnings"], 2);
        assert_eq!(message["rootDocument"], "main.tex");
        let failed = compile_result(&association, None, "2026-11-14T10:00:00.000Z");
        assert_eq!(failed["success"], false);
        assert_eq!(failed["durationMs"], Value::Null);
        assert!(utc_timestamp(&json!(now())).is_some());
    }
}
