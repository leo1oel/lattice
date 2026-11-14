//! What Settings › Logs lists (`groupLogs` and the filter in
//! `src/telemetry/app-log.tsx`): an operation's entries under one row, the
//! others each a row of their own, oldest first so the list reads like a
//! terminal with the newest at the bottom. A group stays when any of its
//! entries is at the chosen level and matches the search.

use std::collections::HashMap;

use super::{Entry, Level};

pub struct Group {
    /// `operation:<id>` or `entry:<id>`.
    pub key: String,
    pub operation_id: Option<String>,
    /// Oldest first.
    pub entries: Vec<Entry>,
    /// The entry the row shows: the operation's newest completion, else its
    /// newest entry not tied to a request, else its newest.
    pub summary: Entry,
}

/// The groups of `entries` (newest first, as kept), oldest group first.
pub fn group(entries: &[Entry]) -> Vec<Group> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Group> = HashMap::new();
    // Chronologically, so entries with the same millisecond keep their order.
    for entry in entries.iter().rev() {
        let operation_id = entry
            .context
            .as_ref()
            .map(|context| context.operation_id.clone())
            .filter(|id| !id.is_empty());
        let key = match &operation_id {
            Some(id) => format!("operation:{id}"),
            None => format!("entry:{}", entry.id),
        };
        match groups.get_mut(&key) {
            Some(group) => group.entries.push(entry.clone()),
            None => {
                order.push(key.clone());
                groups.insert(
                    key.clone(),
                    Group {
                        key,
                        operation_id,
                        entries: vec![entry.clone()],
                        summary: entry.clone(),
                    },
                );
            }
        }
    }
    let mut out: Vec<Group> = order
        .into_iter()
        .filter_map(|key| groups.remove(&key))
        .map(|mut group| {
            group.entries.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
            let newest = || group.entries.iter().rev();
            let unrequested = |entry: &&Entry| {
                entry
                    .context
                    .as_ref()
                    .is_none_or(|context| context.request_id.is_none())
            };
            group.summary = newest()
                .filter(unrequested)
                .find(|entry| {
                    entry
                        .context
                        .as_ref()
                        .is_some_and(|context| context.phase == "completed")
                })
                .or_else(|| newest().find(unrequested))
                .or_else(|| newest().next())
                .cloned()
                .unwrap_or(group.summary);
            group
        })
        .collect();
    out.sort_by(|a, b| a.summary.timestamp.cmp(&b.summary.timestamp));
    out
}

/// Whether `entry` is at `level` (any, when none) and holds `query`
/// (lowercased, trimmed; empty matches all) in its source, title, detail,
/// level or operation fields.
pub fn matches(entry: &Entry, level: Option<Level>, query: &str) -> bool {
    if level.is_some_and(|level| entry.level != level) {
        return false;
    }
    if query.is_empty() {
        return true;
    }
    let context = entry.context.as_ref();
    [
        Some(entry.source.as_str()),
        Some(entry.title.as_str()),
        Some(entry.detail.as_str()),
        Some(entry.level.tag()),
        context.map(|context| context.operation.as_str()),
        context.map(|context| context.operation_id.as_str()),
        context.map(|context| context.phase.as_str()),
        context.and_then(|context| context.outcome.as_deref()),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.to_lowercase().contains(query))
}

/// The groups the page lists for `level` and `query`.
pub fn visible(entries: &[Entry], level: Option<Level>, query: &str) -> Vec<Group> {
    let query = query.trim().to_lowercase();
    group(entries)
        .into_iter()
        .filter(|group| {
            group
                .entries
                .iter()
                .any(|entry| matches(entry, level, &query))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_log::OperationContext;

    fn entry(id: &str, at: &str, level: Level, title: &str, op: Option<(&str, &str)>) -> Entry {
        Entry {
            id: id.into(),
            timestamp: format!("2026-11-14T01:00:{at}.000Z"),
            level,
            source: "Build".into(),
            title: title.into(),
            detail: String::new(),
            context: op.map(|(operation_id, phase)| OperationContext {
                operation_id: operation_id.into(),
                operation: "Build".into(),
                phase: phase.into(),
                ..OperationContext::default()
            }),
        }
    }

    #[test]
    fn an_operations_entries_share_one_row_summarised_by_its_completion() {
        // Newest first, as the log keeps them.
        let kept = [
            entry("e4", "04", Level::Info, "Saved", None),
            entry(
                "e3",
                "03",
                Level::Error,
                "Build failed",
                Some(("op", "completed")),
            ),
            entry(
                "e2",
                "02",
                Level::Info,
                "Building",
                Some(("op", "progress")),
            ),
            entry(
                "e1",
                "01",
                Level::Info,
                "Build started",
                Some(("op", "started")),
            ),
        ];
        let groups = group(&kept);
        let keys: Vec<&str> = groups.iter().map(|group| group.key.as_str()).collect();
        assert_eq!(keys, ["operation:op", "entry:e4"]);
        assert_eq!(groups[0].summary.title, "Build failed");
        let titles: Vec<&str> = groups[0].entries.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, ["Build started", "Building", "Build failed"]);
    }

    #[test]
    fn a_group_stays_when_any_entry_matches_the_level_and_search() {
        let kept = [
            entry(
                "e3",
                "03",
                Level::Error,
                "Build failed",
                Some(("7f3a", "completed")),
            ),
            entry(
                "e1",
                "01",
                Level::Info,
                "Build started",
                Some(("7f3a", "started")),
            ),
            entry("e0", "00", Level::Info, "Opened main.tex", None),
        ];
        assert_eq!(visible(&kept, Some(Level::Error), "").len(), 1);
        assert_eq!(visible(&kept, None, "  MAIN ").len(), 1);
        assert_eq!(
            visible(&kept, None, "7F3A").len(),
            1,
            "an operation id matches"
        );
        assert_eq!(visible(&kept, Some(Level::Warning), "").len(), 0);
        assert_eq!(visible(&kept, None, "").len(), 2);
    }
}
