//! The saved report (`audit-carry-over.ts`): what it keeps of each
//! reference, how a fresh scan takes it back, and its writes, which finish
//! in any order while each project keeps the newest one asked for.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use lattice_core::citation_audit::{self, AuditEntry};
use serde::{Deserialize, Serialize};

use super::{Finding, audit_key};

/// What the saved report keeps of a reference.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Saved {
    snapshot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    result: Finding,
    applied: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    kept: bool,
}

/// A report read back, by each reference's file and key.
pub(super) type Report = HashMap<String, Saved>;

/// Each reference's results, applied fixes and kept entries.
type Marks = (HashMap<usize, Finding>, HashSet<usize>, HashSet<usize>);

pub(super) fn read(rows: Vec<(String, serde_json::Value)>) -> Report {
    rows.into_iter()
        .filter_map(|(key, value)| Some((key, serde_json::from_value(value).ok()?)))
        .collect()
}

/// The report of `entries`: each one checked, as it reads now. A duplicate
/// key in one file is the first's alone.
pub(super) fn build(
    entries: &[AuditEntry],
    results: &HashMap<usize, Finding>,
    applied: &HashSet<usize>,
    kept: &HashSet<usize>,
) -> Vec<(String, serde_json::Value)> {
    let mut seen = HashSet::new();
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let key = audit_key(entry);
            if !seen.insert(key.clone()) {
                return None;
            }
            let saved = Saved {
                snapshot: entry.bibtex.clone(),
                fingerprint: Some(entry.fingerprint.clone()).filter(|print| !print.is_empty()),
                result: results.get(&index)?.clone(),
                applied: applied.contains(&index),
                kept: kept.contains(&index),
            };
            Some((key, serde_json::to_value(saved).ok()?))
        })
        .collect()
}

/// `saved` carried over to `entries` while an entry says the same thing;
/// one that changed since reads as changed when `mark_changed`.
pub(super) fn carry(entries: &[AuditEntry], saved: &Report, mark_changed: bool) -> Marks {
    let (mut results, mut applied, mut kept) = Marks::default();
    let mut seen = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let key = audit_key(entry);
        if !seen.insert(key.clone()) {
            continue;
        }
        let Some(prior) = saved.get(&key) else {
            continue;
        };
        let same_text = prior.snapshot == entry.bibtex;
        let same_content = !entry.fingerprint.is_empty()
            && prior.fingerprint.as_deref() == Some(entry.fingerprint.as_str());
        if same_text || same_content {
            let mut result = prior.result.clone();
            if !same_text {
                result.before = entry.bibtex.clone();
            }
            results.insert(index, result);
            if prior.applied {
                applied.insert(index);
            }
            if prior.kept {
                kept.insert(index);
            }
        } else if mark_changed {
            results.insert(
                index,
                Finding {
                    status: "conflict".into(),
                    message: "Reference changed since the last check. Check this reference again."
                        .into(),
                    checked_at: prior.result.checked_at.clone(),
                    before: entry.bibtex.clone(),
                    ..Default::default()
                },
            );
        }
    }
    (results, applied, kept)
}

/// The fix `after` written over the entry at `index`: it reads and
/// fingerprints as written, and the entries below
/// it in the file move by the lines it added or took away.
pub(super) fn land_fix(entries: &mut [AuditEntry], index: usize, after: String) {
    let Some(entry) = entries.get_mut(index) else {
        return;
    };
    let lines = |text: &str| text.matches('\n').count() as isize;
    let delta = lines(&after) - lines(&entry.bibtex);
    entry.fingerprint = citation_audit::content_fingerprint(&after);
    entry.bibtex = after;
    let (path, line) = (entry.path.clone(), entry.line);
    let Some(line) = line.filter(|_| delta != 0) else {
        return;
    };
    for entry in entries.iter_mut() {
        if entry.path == path
            && let Some(below) = entry.line.as_mut()
            && *below > line
        {
            *below = below.saturating_add_signed(delta);
        }
    }
}

static ASKED: AtomicU64 = AtomicU64::new(0);
static WRITTEN: LazyLock<Mutex<HashMap<PathBuf, u64>>> = LazyLock::new(Default::default);

/// The next save's place in the order saves were asked for in.
pub(super) fn ask() -> u64 {
    ASKED.fetch_add(1, Ordering::Relaxed) + 1
}

/// Write `report` as `root`'s, the `asked`th asked for, unless a later one
/// of the same project is already written.
pub(super) fn write(
    store: &Path,
    root: &Path,
    asked: u64,
    report: Vec<(String, serde_json::Value)>,
) {
    let mut written = WRITTEN.lock().unwrap_or_else(|poison| poison.into_inner());
    let newest = written.entry(root.to_path_buf()).or_insert(0);
    if *newest > asked {
        return;
    }
    *newest = asked;
    if let Err(error) = citation_audit::save_report(store, root, report) {
        log::warn!("the reference check's report was not saved: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_project_keeps_its_newest_report_whatever_order_they_land_in() {
        let dir = std::env::temp_dir().join(format!("lattice-audit-report-{}", std::process::id()));
        let (store, a, b) = (dir.join("store"), dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let report = |key: &str| vec![(key.to_string(), serde_json::json!({ "status": key }))];
        // B's later save lands first; A's earlier one is still A's newest.
        write(&store, &b, 2, report("b"));
        write(&store, &a, 1, report("a"));
        // A save of A's that lands after a newer one of A's is dropped.
        write(&store, &a, 4, report("a-new"));
        write(&store, &a, 3, report("a-old"));
        let stored = |root: &Path| citation_audit::load_report(&store, root).unwrap();
        assert_eq!(stored(&a), Some(report("a-new")));
        assert_eq!(stored(&b), Some(report("b")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Apply's round trip as the next opening reads it: the file as
    /// lattice-core wrote it, scanned again, against the report read back.
    #[test]
    fn an_applied_fix_comes_back_applied_not_changed_since_the_check() {
        let dir =
            std::env::temp_dir().join(format!("lattice-audit-applied-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("store");
        let venue = lattice_core::project::Venue::Neurips;
        let root = lattice_core::project::create_with_venue(&dir, "Audit", venue).unwrap();
        let before = "@article{one, title={Old}, author={A}, year={2020}}";
        let after = "@article{one, title={Old}, author={A}, year={2020}, pages={1--9}}";
        std::fs::write(root.join("references.bib"), format!("{before}\n")).unwrap();
        let mut entries = citation_audit::scan(&root).unwrap().entries;
        let finding = Finding {
            status: "verified".into(),
            before: entries[0].bibtex.clone(),
            after: Some(after.into()),
            ..Default::default()
        };
        citation_audit::apply(&root, "references.bib", "one", &entries[0].bibtex, after).unwrap();
        land_fix(&mut entries, 0, after.into());
        let (results, applied) = (HashMap::from([(0, finding)]), HashSet::from([0]));
        write(
            &store,
            &root,
            ask(),
            build(&entries, &results, &applied, &HashSet::new()),
        );

        let rescanned = citation_audit::scan(&root).unwrap().entries;
        let stored = citation_audit::load_report(&store, &root).unwrap().unwrap();
        let (results, applied, _) = carry(&rescanned, &read(stored), true);
        assert_eq!(results[&0].status, "verified");
        assert!(applied.contains(&0));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
