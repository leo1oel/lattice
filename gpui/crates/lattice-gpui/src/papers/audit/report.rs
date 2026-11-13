//! The report's writes: they finish in any order, and each project keeps
//! the newest one asked for.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use lattice_core::citation_audit;

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
}
