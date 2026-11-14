//! The app's log, as the Tauri app keeps it (`src/telemetry/app-log-store.ts`):
//! every notice the window shows, newest first, at most 300 entries of at
//! most 4,000 characters of detail, with common credential forms redacted
//! before anything is kept, shown or written. A notice that replaces one
//! still showing under the same key updates that entry, moved to the front
//! with a new time, rather than adding a copy.
//!
//! The entries outlive the app in the state folder (`app-log.json`, the
//! Tauri app's `localStorage` key), and each is also written as one line to
//! `logs/lattice.log` there, the file Settings › Logs › Open log folder shows
//! and the support bundle reads (lattice-core's `diagnostic_logs::collect`).
//! A run with no state folder (a scripted one) keeps them in memory only.
//!
//! Settings › Logs (`crate::settings::logs_pane`) reads and clears them;
//! Export and Help ▸ Report a Problem… go through [`export`], which keeps
//! only allowlisted metadata unless raw text is asked for.

pub mod export;
pub mod groups;
pub mod trace;

use std::{collections::HashMap, path::PathBuf, sync::LazyLock, time::Duration};

use gpui::{App, AppContext as _, Context, Entity, Global, Task};
use regex::Regex;
use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 300;
const MAX_DETAIL_CHARS: usize = 4_000;
/// The file log is cut back to its newest half past this size.
const MAX_FILE_BYTES: u64 = 1_000_000;
/// How long a change waits before the entries are written, so a burst of
/// notices is one write.
const PERSIST_DELAY: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Success,
    Warning,
    Error,
}

impl Level {
    pub const ALL: [Level; 4] = [Level::Info, Level::Success, Level::Warning, Level::Error];

    pub fn tag(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Success => "success",
            Level::Warning => "warning",
            Level::Error => "error",
        }
    }
}

/// An operation's metadata (`AppLogContext`): counts and flags only, never
/// a document's text or a credential.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OperationContext {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_request_id: Option<String>,
    pub operation: String,
    /// `started`, `progress` or `completed`.
    pub phase: String,
    /// `success`, `error` or `cancelled`, once completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    /// ISO 8601 in UTC to the millisecond, as `Date.toISOString` writes it.
    pub timestamp: String,
    pub level: Level,
    pub source: String,
    pub title: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<OperationContext>,
}

/// What a caller logs.
pub struct NewEntry {
    pub level: Level,
    pub source: String,
    pub title: String,
    pub detail: String,
    pub context: Option<OperationContext>,
}

static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(Bearer\s+)\S+").expect("the bearer pattern compiles"));
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)((?:["']?)(?:authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]+"#)
        .expect("the header pattern compiles")
});
static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|ticket|password|secret)["']?\s*[:=]\s*["']?)[^\s&"',;}]+"#,
    )
    .expect("the secret pattern compiles")
});
static TRANSFER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(/binary/(?:uploads|downloads)/)[^\s/?#"']+"#)
        .expect("the transfer pattern compiles")
});
static CORRELATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|\n)#[0-9a-f]{6}$").expect("the correlation pattern compiles")
});

/// Remove common credential forms (`redactLogText`): defense in depth for
/// diagnostic strings, not a guarantee that arbitrary output is safe to
/// share. Local paths and compiler messages are kept.
pub fn redact(text: &str) -> String {
    let text = BEARER.replace_all(text, "${1}[redacted]");
    let text = HEADER.replace_all(&text, "${1}[redacted]");
    let text = SECRET.replace_all(&text, "${1}[redacted]");
    TRANSFER.replace_all(&text, "${1}[redacted]").into_owned()
}

/// A detail without the correlation id an operation's notice ends with,
/// which belongs in the log, not in what a notice says (`visibleToastDetail`).
pub fn visible_detail(detail: &str) -> String {
    CORRELATION.replace(detail, "").trim().to_string()
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_DETAIL_CHARS).collect()
}

fn sanitize(context: Option<OperationContext>) -> Option<OperationContext> {
    context.map(|context| OperationContext {
        operation: redact(&context.operation),
        trigger: context.trigger.map(|trigger| clip(&redact(&trigger))),
        error_type: context.error_type.map(|kind| redact(&kind)),
        ..context
    })
}

fn now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Read kept entries, dropping any that do not have an entry's shape and
/// redacting the rest again, as a legacy record may predate a pattern.
fn read_entries(text: &str) -> Vec<Entry> {
    let Ok(serde_json::Value::Array(values)) = serde_json::from_str::<serde_json::Value>(text)
    else {
        return Vec::new();
    };
    values
        .into_iter()
        .take(MAX_ENTRIES)
        .filter_map(|value| serde_json::from_value::<Entry>(value).ok())
        .map(|entry| Entry {
            source: redact(&entry.source),
            title: redact(&entry.title),
            detail: clip(&redact(&entry.detail)),
            context: sanitize(entry.context),
            ..entry
        })
        .collect()
}

pub struct AppLog {
    entries: Vec<Entry>,
    /// The entry a notice still showing under each key logged.
    keyed: HashMap<String, String>,
    folder: Option<PathBuf>,
    _persist: Option<Task<()>>,
}

struct AppLogGlobal(Entity<AppLog>);

impl Global for AppLogGlobal {}

/// Make the app's log, reading what an earlier run kept in `folder`.
pub fn install(folder: Option<PathBuf>, cx: &mut App) -> Entity<AppLog> {
    if let Some(log) = cx.try_global::<AppLogGlobal>() {
        return log.0.clone();
    }
    let entries = folder
        .as_ref()
        .and_then(|folder| std::fs::read_to_string(folder.join("app-log.json")).ok())
        .map(|text| read_entries(&text))
        .unwrap_or_default();
    let log = cx.new(|_| AppLog {
        entries,
        keyed: HashMap::new(),
        folder,
        _persist: None,
    });
    cx.set_global(AppLogGlobal(log.clone()));
    log
}

/// The app's log, made on first use with nowhere to keep it when the app
/// did not install one.
pub fn global(cx: &mut App) -> Entity<AppLog> {
    match cx.try_global::<AppLogGlobal>() {
        Some(log) => log.0.clone(),
        None => install(None, cx),
    }
}

impl AppLog {
    /// Newest first.
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// The folder the file log is written in, where there is one.
    pub fn log_folder(&self) -> Option<PathBuf> {
        Some(self.folder.as_ref()?.join("logs"))
    }

    /// Log `new`; under a `key` whose notice is still showing (`replaces`),
    /// update that notice's entry instead.
    pub fn add(
        &mut self,
        new: NewEntry,
        key: Option<&str>,
        replaces: bool,
        cx: &mut Context<Self>,
    ) -> String {
        let existing = key
            .filter(|_| replaces)
            .and_then(|key| self.keyed.get(key).cloned())
            .filter(|id| self.entries.iter().any(|entry| entry.id == *id));
        let entry = Entry {
            id: existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            timestamp: now(),
            level: new.level,
            source: redact(&new.source),
            title: redact(&new.title),
            detail: clip(&redact(new.detail.trim())),
            context: sanitize(new.context),
        };
        let id = entry.id.clone();
        self.entries.retain(|kept| kept.id != id);
        self.entries.insert(0, entry.clone());
        self.entries.truncate(MAX_ENTRIES);
        if let Some(key) = key {
            self.keyed.insert(key.to_string(), id.clone());
        }
        self.forward(&entry, cx);
        self.persist(cx);
        cx.notify();
        id
    }

    /// Forget every entry, at once on disk too.
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.entries.clear();
        self.keyed.clear();
        self._persist = None;
        if let Some(folder) = self.folder.clone() {
            cx.background_spawn(async move { write_entries(&folder, &[]) })
                .detach();
        }
        cx.notify();
    }

    fn persist(&mut self, cx: &mut Context<Self>) {
        let Some(folder) = self.folder.clone() else {
            return;
        };
        self._persist = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PERSIST_DELAY).await;
            let Ok(entries) = this.read_with(cx, |this, _| this.entries.clone()) else {
                return;
            };
            cx.background_spawn(async move { write_entries(&folder, &entries) })
                .await;
        }));
    }

    /// One line in the file log per entry logged or updated.
    fn forward(&self, entry: &Entry, cx: &mut Context<Self>) {
        let Some(folder) = self.log_folder() else {
            return;
        };
        let Ok(line) = serde_json::to_string(entry) else {
            return;
        };
        cx.background_spawn(async move { append_line(&folder, &line) })
            .detach();
    }
}

fn write_entries(folder: &std::path::Path, entries: &[Entry]) {
    if std::fs::create_dir_all(folder).is_err() {
        return;
    }
    if let Ok(text) = serde_json::to_string(entries) {
        let temporary = folder.join("app-log.json.tmp");
        if std::fs::write(&temporary, text).is_ok() {
            std::fs::rename(&temporary, folder.join("app-log.json")).ok();
        }
    }
}

fn append_line(folder: &std::path::Path, line: &str) {
    use std::io::Write as _;
    if std::fs::create_dir_all(folder).is_err() {
        return;
    }
    let path = folder.join("lattice.log");
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_FILE_BYTES)
        && let Ok(text) = std::fs::read_to_string(&path)
    {
        let half = text.len() / 2;
        let cut = text[half..]
            .find('\n')
            .map_or(text.len(), |at| half + at + 1);
        std::fs::write(&path, &text[cut..]).ok();
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        writeln!(file, "{line}").ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_redacted_and_paths_kept() {
        assert_eq!(
            redact("Authorization: Bearer abc.def"),
            "Authorization: [redacted]"
        );
        assert_eq!(
            redact("got Bearer s3cr3t back"),
            "got Bearer [redacted] back"
        );
        assert_eq!(
            redact(r#"{"api_key": "sk-123", "user": "me"}"#),
            r#"{"api_key": "[redacted]", "user": "me"}"#
        );
        assert_eq!(
            redact("password=hunter2&next=1"),
            "password=[redacted]&next=1"
        );
        assert_eq!(
            redact("GET /binary/uploads/abcdef?x=1"),
            "GET /binary/uploads/[redacted]?x=1"
        );
        assert_eq!(
            redact("/Users/me/paper/main.tex:12: Undefined control sequence"),
            "/Users/me/paper/main.tex:12: Undefined control sequence"
        );
    }

    #[test]
    fn a_notice_keeps_its_correlation_id_out_of_sight() {
        assert_eq!(visible_detail("Build failed\n#a1b2c3"), "Build failed");
        assert_eq!(visible_detail("#a1b2c3"), "");
        assert_eq!(visible_detail("Keep #a1b2c3 inside"), "Keep #a1b2c3 inside");
    }

    #[test]
    fn kept_entries_are_read_back_checked_and_redacted() {
        let text = r#"[
            {"id":"1","timestamp":"2026-11-14T01:02:03.004Z","level":"error","source":"Build","title":"token=abc","detail":"x"},
            {"id":"2","timestamp":"t","level":"loud","source":"s","title":"t","detail":""},
            {"id":"3","timestamp":"t","level":"info","source":"s","title":"t"},
            "not an entry"
        ]"#;
        let entries = read_entries(text);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "token=[redacted]");
        assert!(read_entries("{}").is_empty());
    }
}
