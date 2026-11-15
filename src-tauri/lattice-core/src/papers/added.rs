//! When each paper came into the library, for the Papers list's "Date added"
//! sort and grouping.
//!
//! A BibTeX entry records no such time, and papers arrive by many roads (the
//! Add papers sheet, Zotero, the agent's bibcite edits, an Overleaf
//! collaborator, a hand edit), so the library notes the first time it lists
//! each citation key, in `.research/papers-added.json`. That file is app
//! state: Overleaf sync and the file watcher leave `.research/` alone.
//!
//! A library that predates the ledger cannot say when its papers came. The
//! first listing records a paper with downloaded text at its bundle folder's
//! creation time (when the text came, which is no earlier than the citation)
//! and the rest as unknown; the list puts unknown papers last. Every key
//! listed after that is stamped with the time it first appears.
//!
//! Keys are never dropped from the ledger: a bibliography that is briefly
//! empty (a sync mid-write, a switched primary file) must not make the whole
//! library look new once it is back. A key removed and later re-added keeps
//! its first date.

use crate::papers::PaperSummary;
use crate::util::err;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const LEDGER: &str = ".research/papers-added.json";
const VERSION: u32 = 1;

/// Each lowercased citation key's first listing, in milliseconds since the
/// Unix epoch; `None` for a key already there before the ledger was.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    added: BTreeMap<String, Option<i64>>,
}

/// Set each paper's `added_at` from the ledger, recording the keys it has not
/// seen. The ledger is written only when it gains a key; a write that fails
/// (a read-only project) still returns this listing's times.
pub(super) fn stamp(root: &Path, papers: &mut [PaperSummary]) {
    stamp_at(root, papers, now_ms());
}

fn stamp_at(root: &Path, papers: &mut [PaperSummary], now: i64) {
    let (mut ledger, seeding) = match read(root) {
        Some(ledger) => (ledger, false),
        None => (Ledger { version: VERSION, ..Ledger::default() }, true),
    };
    let mut changed = seeding;
    for paper in papers.iter_mut() {
        let Some(key) = paper.citation_key.as_deref().map(str::to_lowercase) else { continue };
        let added = *ledger.added.entry(key).or_insert_with(|| {
            changed = true;
            if seeding {
                bundle_time(root, paper)
            } else {
                Some(now)
            }
        });
        paper.added_at = added;
    }
    if changed {
        if let Err(error) = write(root, &ledger) {
            log::warn!("Could not record when papers were added: {error}");
        }
    }
}

/// The ledger, or `None` when the project has none yet. A file that cannot
/// be parsed is treated as absent rather than failing the library; it is
/// then rewritten.
fn read(root: &Path) -> Option<Ledger> {
    let bytes = fs::read(root.join(LEDGER)).ok()?;
    serde_json::from_slice::<Ledger>(&bytes).ok()
}

fn write(root: &Path, ledger: &Ledger) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(ledger).map_err(err)?;
    crate::project_fs::ProjectDir::open(root)?.atomic_write(LEDGER, format!("{raw}\n").as_bytes())
}

/// When a paper's downloaded text arrived: its bundle folder's creation time
/// (its modification time where the file system keeps no birth time).
fn bundle_time(root: &Path, paper: &PaperSummary) -> Option<i64> {
    if !(paper.has_full_text || paper.has_blog) || paper.arxiv_id.is_empty() {
        return None;
    }
    let metadata = fs::metadata(root.join(".research/papers").join(&paper.arxiv_id)).ok()?;
    let time = metadata.created().or_else(|_| metadata.modified()).ok()?;
    Some(time.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn paper(key: &str) -> PaperSummary {
        PaperSummary {
            arxiv_id: String::new(),
            doi: None,
            url: None,
            title: key.into(),
            authors: String::new(),
            year: None,
            citation_key: Some(key.into()),
            has_full_text: false,
            has_blog: false,
            has_local_pdf: false,
            asset_paths: Vec::new(),
            citation_health: None,
            added_at: None,
        }
    }

    fn added(papers: &[PaperSummary]) -> Vec<Option<i64>> {
        papers.iter().map(|paper| paper.added_at).collect()
    }

    #[test]
    fn a_library_without_a_ledger_dates_only_what_it_downloaded_then_stamps_new_keys() {
        let root = TempDir::new("papers-added");
        let bundle = root.join(".research/papers/2401.00001");
        fs::create_dir_all(&bundle).unwrap();
        let mut downloaded = paper("Vaswani2017");
        downloaded.arxiv_id = "2401.00001".into();
        downloaded.has_full_text = true;
        let mut papers = vec![downloaded, paper("cited")];

        stamp_at(&root, &mut papers, 5_000);
        let seeded = added(&papers);
        assert!(
            seeded[0].is_some_and(|at| at > 0 && at != 5_000),
            "the bundle's own time: {seeded:?}"
        );
        assert_eq!(seeded[1], None, "a citation already there has no date");

        // Later listings keep those, and date a new key when it first appears.
        papers.push(paper("Fresh2026"));
        stamp_at(&root, &mut papers, 9_000);
        assert_eq!(added(&papers), vec![seeded[0], None, Some(9_000)]);
        stamp_at(&root, &mut papers, 12_000);
        assert_eq!(papers[2].added_at, Some(9_000));
    }

    #[test]
    fn keys_match_case_insensitively_and_survive_leaving_the_bibliography() {
        let root = TempDir::new("papers-added");
        stamp_at(&root, &mut [], 1_000);
        stamp_at(&root, &mut [paper("Smith2020")], 2_000);
        // Gone from the bibliography for a listing, then back with other case.
        stamp_at(&root, &mut [], 3_000);
        let mut back = [paper("smith2020")];
        stamp_at(&root, &mut back, 4_000);
        assert_eq!(back[0].added_at, Some(2_000));
    }

    #[test]
    fn an_unreadable_ledger_starts_again_without_failing_the_list() {
        let root = TempDir::new("papers-added");
        fs::create_dir_all(root.join(".research")).unwrap();
        fs::write(root.join(LEDGER), "not json").unwrap();
        let mut papers = [paper("a")];
        stamp_at(&root, &mut papers, 1_000);
        assert_eq!(papers[0].added_at, None);
        assert!(read(&root).is_some_and(|ledger| ledger.added.contains_key("a")));
    }
}
