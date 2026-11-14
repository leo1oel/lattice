//! The timeline's lines, whichever record they came from, ported from the
//! Tauri app's `src/history/history-drawer.tsx` (`TimelineRow`,
//! `foldAutomatic`) and `history-time.ts` (`groupByDay`): Lattice's own
//! activity, the project's git versions and, for a project linked to
//! Overleaf, Overleaf's own history interleaved by time, newest first, in runs that share a day, with each run of two or more automatic
//! versions folded into one quiet line.

use std::sync::LazyLock;

use chrono::NaiveDate;
use lattice_core::git::GitLogEntry;
use lattice_core::overleaf::OverleafUpdate;
use lattice_core::project::HistoryItem;
use regex::Regex;

use super::{messages, time};

/// What the timeline shows: everything in one stream, or one record alone.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HistoryView {
    #[default]
    Everything,
    Versions,
    Activity,
    /// Overleaf's own history, for a linked project.
    Overleaf,
}

/// Which actor's activity the Activity view shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ActivityFilter {
    #[default]
    All,
    User,
    Agent,
    Citation,
}

impl ActivityFilter {
    pub fn admits(self, actor: &str) -> bool {
        match self {
            ActivityFilter::All => true,
            ActivityFilter::User => actor == "user" || actor.is_empty(),
            ActivityFilter::Agent => actor == "agent",
            ActivityFilter::Citation => actor == "citation",
        }
    }
}

/// One line of the timeline.
#[derive(Clone, Debug)]
pub enum TimelineRow {
    Activity {
        at: i64,
        item: HistoryItem,
    },
    Version {
        at: i64,
        entry: GitLogEntry,
    },
    /// A folded run of automatic versions, newest first.
    Automatic {
        at: i64,
        entries: Vec<GitLogEntry>,
    },
    /// An entry of Overleaf's own history.
    Overleaf {
        at: i64,
        update: OverleafUpdate,
    },
}

impl TimelineRow {
    pub fn at(&self) -> i64 {
        match self {
            TimelineRow::Activity { at, .. }
            | TimelineRow::Version { at, .. }
            | TimelineRow::Automatic { at, .. }
            | TimelineRow::Overleaf { at, .. } => *at,
        }
    }

    /// The row's key, which its expanded state and its fold are kept by.
    pub fn key(&self) -> String {
        match self {
            TimelineRow::Activity { item, .. } => activity_key(&item.id),
            TimelineRow::Version { entry, .. } => version_key(&entry.hash),
            TimelineRow::Automatic { entries, .. } => format!("fold:{}", entries[0].hash),
            TimelineRow::Overleaf { update, .. } => {
                super::overleaf::overleaf_key(update.to_version)
            }
        }
    }
}

pub fn activity_key(id: &str) -> String {
    format!("activity:{id}")
}

pub fn version_key(hash: &str) -> String {
    format!("version:{hash}")
}

pub fn activity_rows(items: &[HistoryItem], filter: ActivityFilter) -> Vec<TimelineRow> {
    items
        .iter()
        .filter(|item| filter.admits(&item.actor))
        .map(|item| TimelineRow::Activity {
            at: time::parse_ms(&item.timestamp).unwrap_or(0),
            item: item.clone(),
        })
        .collect()
}

pub fn overleaf_rows(updates: &[OverleafUpdate]) -> Vec<TimelineRow> {
    updates
        .iter()
        .map(|update| TimelineRow::Overleaf {
            at: update.end_ts,
            update: update.clone(),
        })
        .collect()
}

pub fn version_rows(entries: &[GitLogEntry]) -> Vec<TimelineRow> {
    entries
        .iter()
        .map(|entry| TimelineRow::Version {
            at: time::parse_ms(&entry.timestamp).unwrap_or(0),
            entry: entry.clone(),
        })
        .collect()
}

/// Runs of two or more automatic versions in a row become one folded line.
pub fn fold_automatic(rows: Vec<TimelineRow>) -> Vec<TimelineRow> {
    let mut folded: Vec<TimelineRow> = Vec::with_capacity(rows.len());
    for row in rows {
        let automatic = matches!(&row, TimelineRow::Version { entry, .. } if messages::is_automatic(&entry.message));
        if !automatic {
            folded.push(row);
            continue;
        }
        let TimelineRow::Version { entry, .. } = row else {
            unreachable!()
        };
        match folded.last_mut() {
            Some(TimelineRow::Automatic { entries, .. }) => entries.push(entry),
            Some(last @ TimelineRow::Version { .. }) => {
                let TimelineRow::Version {
                    at,
                    entry: previous,
                } = last.clone()
                else {
                    unreachable!()
                };
                if messages::is_automatic(&previous.message) {
                    *last = TimelineRow::Automatic {
                        at,
                        entries: vec![previous, entry],
                    };
                } else {
                    let at = time::parse_ms(&entry.timestamp).unwrap_or(0);
                    folded.push(TimelineRow::Version { at, entry });
                }
            }
            _ => {
                let at = time::parse_ms(&entry.timestamp).unwrap_or(0);
                folded.push(TimelineRow::Version { at, entry });
            }
        }
    }
    folded
}

/// A day's heading time and its rows.
pub struct Day {
    pub key: Option<NaiveDate>,
    pub at: i64,
    pub rows: Vec<TimelineRow>,
}

/// `rows` newest first, in runs that share a day, each run's automatic
/// versions folded.
pub fn days(mut rows: Vec<TimelineRow>) -> Vec<Day> {
    rows.sort_by_key(|row| std::cmp::Reverse(row.at()));
    let mut days: Vec<Day> = Vec::new();
    for row in rows {
        let key = time::day_key(row.at());
        match days.last_mut() {
            Some(day) if day.key == key => day.rows.push(row),
            _ => days.push(Day {
                key,
                at: row.at(),
                rows: vec![row],
            }),
        }
    }
    for day in &mut days {
        day.rows = fold_automatic(std::mem::take(&mut day.rows));
    }
    days
}

/// The label lattice-core gives a file saved through Lattice (history.rs).
static EDIT_LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Edit (.+)$").expect("the edit label pattern compiles"));

/// How an activity row is titled, and the files its meta line still names:
/// a file saved through Lattice is "Edit {name}" in the interface language,
/// its path left to the meta line only when it adds a folder.
pub fn activity_title(item: &HistoryItem) -> (Option<String>, Vec<String>) {
    let edited = EDIT_LABEL
        .captures(&item.label)
        .map(|captures| captures[1].to_string());
    let edited_name = edited
        .as_ref()
        .filter(|edited| item.files.len() == 1 && &item.files[0] == *edited)
        .map(|edited| {
            edited
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(edited)
                .to_string()
        });
    let files = if edited_name.is_some() && edited_name == edited {
        Vec::new()
    } else {
        item.files.clone()
    };
    (edited_name, files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(hash: &str, message: &str, timestamp: &str) -> GitLogEntry {
        GitLogEntry {
            hash: hash.into(),
            short_hash: hash.into(),
            author_name: "Ada".into(),
            timestamp: timestamp.into(),
            message: message.into(),
            files: Vec::new(),
        }
    }

    #[test]
    fn folds_runs_of_automatic_versions() {
        let rows = version_rows(&[
            version("a", messages::AUTO_SAVED, "2026-10-10T12:00:00Z"),
            version("b", messages::OVERLEAF_SYNC, "2026-10-10T11:00:00Z"),
            version("c", messages::AUTO_SAVED, "2026-10-10T10:00:00Z"),
            version("d", "Draft", "2026-10-10T09:00:00Z"),
            version("e", messages::AUTO_SAVED, "2026-10-10T08:00:00Z"),
        ]);
        let folded = fold_automatic(rows);
        let keys: Vec<String> = folded.iter().map(TimelineRow::key).collect();
        assert_eq!(keys, vec!["fold:a", "version:d", "version:e"]);
        let TimelineRow::Automatic { entries, .. } = &folded[0] else {
            panic!()
        };
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn titles_a_saved_file_by_its_name() {
        let item = |label: &str, files: &[&str]| HistoryItem {
            id: "1".into(),
            label: label.into(),
            timestamp: "2026-10-10T12:00:00Z".into(),
            files: files.iter().map(|file| file.to_string()).collect(),
            actor: "user".into(),
            kind: "edit".into(),
            source: "editor".into(),
            thread_id: None,
            checkpoint_ref: None,
            undo_of: None,
        };
        assert_eq!(
            activity_title(&item("Edit main.tex", &["main.tex"])),
            (Some("main.tex".into()), vec![])
        );
        assert_eq!(
            activity_title(&item("Edit chapters/intro.tex", &["chapters/intro.tex"])),
            (Some("intro.tex".into()), vec!["chapters/intro.tex".into()])
        );
        assert_eq!(
            activity_title(&item("Replace in project", &["a.tex", "b.tex"])),
            (None, vec!["a.tex".into(), "b.tex".into()])
        );
    }
}
