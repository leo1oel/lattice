//! Check references (`bibliography-audit.tsx`, `audit-groups.ts`,
//! `audit-carry-over.ts`): every reference the project's `.bib` files and
//! inline reference lists hold, checked against the published record through
//! lattice-core's `citation_audit`, and sorted by what each asks of the
//! writer: a fix to apply, an unverified candidate to review, a check that
//! could not finish, one not checked yet, a candidate the writer kept their
//! own entry over, and a verified one.
//!
//! - Opening reads the references (`scan`) and the last report, carrying a
//!   result over while its entry says the same thing; nothing is checked
//!   until the writer asks.
//! - Check all runs twenty at a time: Semantic Scholar's batch first, then
//!   each reference the batch could not answer on its own, two at once.
//!   Stop drains the group under way.
//! - Apply writes a fix through `citation_audit::apply`, which refuses an
//!   entry that changed since it was read; Apply all takes every fix that
//!   only fills in or publishes the entry, leaving disputed values for the
//!   writer. An inline reference is checked, never rewritten.
//! - The report is saved per project beside the app's other state, so it
//!   comes back next time.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use gpui::{
    App, AppContext as _, Context, EventEmitter, FocusHandle, Focusable, ScrollHandle, Task,
};
use lattice_core::{
    citation_audit::{self, AuditEntry},
    citation_health::CitationHealth,
};
use serde::{Deserialize, Serialize};

mod groups;
mod messages;
mod view;

pub use groups::{Bucket, FixGroup, fix_group};

/// References checked per group.
const GROUP: usize = 20;

pub enum AuditEvent {
    Dismiss,
    /// Open a file (project-relative) at a 1-based line.
    OpenSource {
        path: String,
        line: u32,
    },
    /// Files were rewritten: open editors reload what changed.
    Applied,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub bibtex: String,
    #[serde(default)]
    pub changes: Vec<Change>,
    #[serde(default)]
    pub reasons: Vec<String>,
}

/// A check's finding, as lattice-core's `AuditResult` serializes it (and the
/// saved report keeps it).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub status: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_reason: Option<String>,
    pub before: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default)]
    pub changes: Vec<Change>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<Candidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<CitationHealth>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disagreements: Vec<String>,
}

impl Finding {
    fn from_core(result: &impl Serialize) -> Option<Self> {
        let mut finding: Finding =
            serde_json::from_value(serde_json::to_value(result).ok()?).ok()?;
        finding.checked_at = Some(chrono_now());
        Some(finding)
    }

    fn failed(message: String, before: &str) -> Self {
        Finding {
            status: "unavailable".into(),
            message,
            checked_at: Some(chrono_now()),
            before: before.to_string(),
            ..Default::default()
        }
    }

    /// A publisher's notice (a retraction, an expression of concern) on the
    /// work itself.
    pub fn has_notice(&self) -> bool {
        self.health
            .as_ref()
            .is_some_and(|health| !matches!(health.kind.as_str(), "unknown" | "unavailable"))
    }
}

fn chrono_now() -> String {
    // Seconds since the epoch, as the report only orders and shows dates.
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    format!("{seconds}")
}

/// What the saved report keeps of a reference.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    snapshot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    result: Finding,
    applied: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    kept: bool,
}

fn audit_key(entry: &AuditEntry) -> String {
    format!("{}\0{}", entry.path, entry.key)
}

/// The reference's title as a reader sees it, else its key
/// (`auditEntryTitle`).
pub(super) fn entry_title(entry: &AuditEntry) -> String {
    let title = lattice_core::bib_document::bib_text_to_plain(&entry.title);
    if title.trim().is_empty() {
        entry.key.clone()
    } else {
        title
    }
}

/// The order the reports were asked for in, and the newest written of each
/// project's report: a save that reaches the disk after a newer one of the
/// same project is dropped.
static REPORTS_ASKED: AtomicU64 = AtomicU64::new(0);
static REPORT_WRITTEN: LazyLock<Mutex<HashMap<PathBuf, u64>>> = LazyLock::new(Default::default);

/// What a check says when the tools it runs are not installed
/// (`PAPER_TOOLS_MISSING`): every later check would fail the same way.
const PAPER_TOOLS_MISSING: &str = "Lattice's paper tools are not installed.";

pub struct Audit {
    root: PathBuf,
    /// Where the report is saved; none keeps it for this window only.
    store: Option<PathBuf>,
    pub(super) entries: Vec<AuditEntry>,
    /// Files the scan read references from: path, kind and how many.
    pub(super) coverage: Vec<(String, String, usize)>,
    pub(super) results: HashMap<usize, Finding>,
    pub(super) applied: HashSet<usize>,
    pub(super) kept: HashSet<usize>,
    pub(super) loading: bool,
    pub(super) busy: bool,
    pub(super) stopping: bool,
    /// The references being checked right now.
    pub(super) checking: HashSet<usize>,
    /// The run under way: how many it checks, and those it has answered.
    pub(super) run_total: usize,
    pub(super) run_done: HashSet<usize>,
    pub(super) applying: bool,
    pub(super) error: Option<String>,
    pub(super) view: Option<Bucket>,
    /// The reference whose finding is open; `set_entries` keeps it on the
    /// same reference when a rescan renumbers them.
    pub(super) open: Option<usize>,
    pub(super) scroll: ScrollHandle,
    generation: u64,
    focus: FocusHandle,
    _task: Option<Task<()>>,
}

impl EventEmitter<AuditEvent> for Audit {}

impl Audit {
    pub fn new(root: PathBuf, cx: &mut Context<Self>) -> Self {
        let store = crate::shell::workspaces::state_dir(false).map(|dir| dir.join("audits"));
        let mut this = Self {
            root,
            store,
            entries: Vec::new(),
            coverage: Vec::new(),
            run_total: 0,
            run_done: HashSet::new(),
            results: HashMap::new(),
            applied: HashSet::new(),
            kept: HashSet::new(),
            loading: true,
            busy: false,
            stopping: false,
            checking: HashSet::new(),
            applying: false,
            error: None,
            view: None,
            open: None,
            scroll: ScrollHandle::new(),
            generation: 0,
            focus: cx.focus_handle(),
            _task: None,
        };
        this.load(cx);
        this
    }

    /// Read the references and the saved report; checks stay the writer's
    /// to ask for.
    fn load(&mut self, cx: &mut Context<Self>) {
        let (root, store) = (self.root.clone(), self.store.clone());
        let read = cx.background_spawn(async move {
            let scan = citation_audit::scan(&root)?;
            let saved = match &store {
                Some(dir) => citation_audit::load_report(dir, &root)
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                None => Vec::new(),
            };
            Ok::<_, String>((scan, saved))
        });
        let generation = self.generation;
        self._task = Some(cx.spawn(async move |this, cx| {
            let read = read.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match read {
                    Ok((scan, saved)) => {
                        this.coverage = scan
                            .coverage
                            .iter()
                            .map(|file| (file.path.clone(), file.kind.to_string(), file.entries))
                            .collect();
                        this.set_entries(scan.entries);
                        let saved: HashMap<String, Saved> = saved
                            .into_iter()
                            .filter_map(|(key, value)| {
                                Some((key, serde_json::from_value(value).ok()?))
                            })
                            .collect();
                        this.carry_over(&saved, true);
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Carry results over to a fresh scan while an entry says the same thing;
    /// one that changed since reads as changed when `mark_changed`.
    fn carry_over(&mut self, saved: &HashMap<String, Saved>, mark_changed: bool) {
        self.results.clear();
        self.applied.clear();
        self.kept.clear();
        // The report keys a reference by its file and key: a duplicate key
        // in one file is the first's alone.
        let mut seen = HashSet::new();
        for (index, entry) in self.entries.iter().enumerate() {
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
                self.results.insert(index, result);
                if prior.applied {
                    self.applied.insert(index);
                }
                if prior.kept {
                    self.kept.insert(index);
                }
            } else if mark_changed {
                self.results.insert(
                    index,
                    Finding {
                        status: "conflict".into(),
                        message:
                            "Reference changed since the last check. Check this reference again."
                                .into(),
                        checked_at: prior.result.checked_at.clone(),
                        before: entry.bibtex.clone(),
                        ..Default::default()
                    },
                );
            }
        }
    }

    fn report(&self) -> Vec<(String, serde_json::Value)> {
        let mut seen = HashSet::new();
        self.entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let key = audit_key(entry);
                if !seen.insert(key.clone()) {
                    return None;
                }
                let result = self.results.get(&index)?;
                let saved = Saved {
                    snapshot: entry.bibtex.clone(),
                    fingerprint: Some(entry.fingerprint.clone()).filter(|print| !print.is_empty()),
                    result: result.clone(),
                    applied: self.applied.contains(&index),
                    kept: self.kept.contains(&index),
                };
                Some((key, serde_json::to_value(saved).ok()?))
            })
            .collect()
    }

    fn save(&self, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let (root, report) = (self.root.clone(), self.report());
        let asked = REPORTS_ASKED.fetch_add(1, Ordering::Relaxed) + 1;
        cx.background_spawn(async move {
            let mut written = REPORT_WRITTEN
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let newest = written.entry(root.clone()).or_insert(0);
            if *newest > asked {
                return;
            }
            *newest = asked;
            if let Err(error) = citation_audit::save_report(&store, &root, report) {
                log::warn!("the reference check's report was not saved: {error}");
            }
        })
        .detach();
    }

    pub(super) fn bucket(&self, index: usize) -> Bucket {
        groups::bucket(
            self.results.get(&index),
            self.applied.contains(&index),
            self.kept.contains(&index),
        )
    }

    /// The fixes Apply all takes: verified updates that only fill in or
    /// publish the entry, never an inline reference's.
    /// The references new or edited since the last check: no result
    /// carried over, or one marked changed. Checking these brings the
    /// report up to date.
    pub(super) fn outdated(&self) -> Vec<usize> {
        if self.busy || self.results.is_empty() {
            return Vec::new();
        }
        (0..self.entries.len())
            .filter(|index| {
                self.results
                    .get(index)
                    .is_none_or(|result| result.status == "conflict")
            })
            .collect()
    }

    pub(super) fn updates(&self) -> Vec<usize> {
        let mut updates: Vec<usize> = self
            .results
            .iter()
            .filter(|(index, result)| {
                result.after.is_some()
                    && result.candidate.is_none()
                    && result.status != "conflict"
                    && !self.applied.contains(index)
                    && self
                        .entries
                        .get(**index)
                        .is_some_and(|entry| entry.inline.is_none())
                    && fix_group(&result.changes) != FixGroup::Disputed
            })
            .map(|(index, _)| *index)
            .collect();
        updates.sort_unstable();
        updates
    }

    /// Check every reference, or only `only`.
    pub(super) fn check(&mut self, only: Option<Vec<usize>>, cx: &mut Context<Self>) {
        if self.loading || self.busy || self.applying {
            return;
        }
        let requested: Option<HashSet<String>> = only.map(|indexes| {
            indexes
                .iter()
                .filter_map(|index| self.entries.get(*index).map(audit_key))
                .collect()
        });
        self.generation += 1;
        let generation = self.generation;
        self.busy = true;
        self.stopping = false;
        self.error = None;
        // Until the rescan says how many it checks, the last run's count
        // would read as this one's.
        self.run_total = 0;
        self.run_done.clear();
        let root = self.root.clone();
        let saved: HashMap<String, Saved> = self
            .report()
            .into_iter()
            .filter_map(|(key, value)| Some((key, serde_json::from_value(value).ok()?)))
            .collect();
        self._task = Some(cx.spawn(async move |this, cx| {
            let scan_root = root.clone();
            let scan = cx
                .background_spawn(async move { citation_audit::scan(&scan_root) })
                .await;
            let indexes = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return None;
                }
                match scan {
                    Ok(scan) => {
                        this.set_entries(scan.entries);
                        this.carry_over(&saved, false);
                        cx.notify();
                        Some(
                            this.entries
                                .iter()
                                .enumerate()
                                .filter(|(_, entry)| {
                                    requested
                                        .as_ref()
                                        .is_none_or(|keys| keys.contains(&audit_key(entry)))
                                })
                                .map(|(index, _)| index)
                                .collect::<Vec<_>>(),
                        )
                    }
                    Err(error) => {
                        this.error = Some(error);
                        None
                    }
                }
            });
            let Some(indexes) = indexes.ok().flatten() else {
                this.update(cx, |this, cx| this.finish(generation, cx)).ok();
                return;
            };
            let total = indexes.len();
            this.update(cx, |this, cx| {
                this.run_total = total;
                this.run_done.clear();
                cx.notify();
            })
            .ok();
            // A Semantic Scholar batch that failed is not asked again this
            // run; each reference's own check is told why.
            let mut s2_failure: Option<String> = None;
            for group in indexes.chunks(GROUP) {
                let (entries, live) = match this.update(cx, |this, cx| {
                    for index in group {
                        this.checking.insert(*index);
                    }
                    cx.notify();
                    let entries: Vec<AuditEntry> = group
                        .iter()
                        .map(|index| this.entries[*index].clone())
                        .collect();
                    (entries, this.generation == generation && !this.stopping)
                }) {
                    Ok(state) => state,
                    Err(_) => return,
                };
                if !live {
                    break;
                }
                // The batch answers what it can; a lone reference has no batch.
                let mut answered: Vec<Option<Finding>> = vec![None; entries.len()];
                let mut s2_status = s2_failure.clone();
                if s2_failure.is_none() && total > 1 {
                    let (batch_root, batch_entries) = (root.clone(), entries.clone());
                    let batch = cx
                        .background_spawn(async move {
                            citation_audit::check_batch(&batch_root, batch_entries)
                        })
                        .await;
                    match batch {
                        Ok(batch) if batch.results.len() == entries.len() => {
                            answered = batch
                                .results
                                .iter()
                                .map(|result| result.as_ref().and_then(Finding::from_core))
                                .collect();
                            s2_failure = batch.s2_failure;
                            s2_status =
                                Some(s2_failure.clone().unwrap_or_else(|| "checked".into()));
                        }
                        _ => {
                            s2_failure = Some("unavailable".into());
                            s2_status = s2_failure.clone();
                        }
                    }
                }
                // What the batch left, two at a time; Stop lets them finish.
                let remaining: Vec<usize> = (0..entries.len())
                    .filter(|at| answered[*at].is_none())
                    .collect();
                for pair in remaining.chunks(2) {
                    let stopped = this
                        .update(cx, |this, _| this.stopping || this.generation != generation)
                        .unwrap_or(true);
                    if stopped {
                        break;
                    }
                    let checks: Vec<_> = pair
                        .iter()
                        .map(|at| {
                            let (entry_root, entry, status) =
                                (root.clone(), entries[*at].clone(), s2_status.clone());
                            cx.background_spawn(async move {
                                let before = entry.bibtex.clone();
                                match citation_audit::check_entry(
                                    &entry_root,
                                    entry,
                                    status.as_deref(),
                                ) {
                                    Ok(result) => {
                                        Finding::from_core(&result).unwrap_or_else(|| {
                                            Finding::failed(
                                                "The check's answer could not be read.".into(),
                                                &before,
                                            )
                                        })
                                    }
                                    Err(error) => Finding::failed(error, &before),
                                }
                            })
                        })
                        .collect();
                    let mut missing_tools = false;
                    for (at, check) in pair.iter().zip(checks) {
                        let finding = check.await;
                        missing_tools |= finding.message.contains(PAPER_TOOLS_MISSING);
                        answered[*at] = Some(finding);
                    }
                    if missing_tools {
                        this.update(cx, |this, _| this.stopping = true).ok();
                    }
                    let partial: Vec<(usize, Finding)> = pair
                        .iter()
                        .filter_map(|at| Some((group[*at], answered[*at].clone()?)))
                        .collect();
                    this.update(cx, |this, cx| this.record(generation, partial, cx))
                        .ok();
                }
                let all: Vec<(usize, Finding)> = answered
                    .into_iter()
                    .enumerate()
                    .filter_map(|(at, finding)| Some((group[at], finding?)))
                    .collect();
                this.update(cx, |this, cx| {
                    this.record(generation, all, cx);
                    for index in group {
                        this.checking.remove(index);
                    }
                })
                .ok();
            }
            this.update(cx, |this, cx| this.finish(generation, cx)).ok();
        }));
        cx.notify();
    }

    fn record(&mut self, generation: u64, findings: Vec<(usize, Finding)>, cx: &mut Context<Self>) {
        if self.generation != generation {
            return;
        }
        for (index, finding) in findings {
            self.run_done.insert(index);
            self.results.insert(index, finding);
            // A fresh result replaces what the writer did with the old one.
            self.applied.remove(&index);
            self.kept.remove(&index);
        }
        // Kept as it comes in: a sheet closed mid-run keeps what it heard.
        self.save(cx);
        cx.notify();
    }

    fn finish(&mut self, generation: u64, cx: &mut Context<Self>) {
        if self.generation != generation {
            return;
        }
        self.busy = false;
        self.stopping = false;
        self.checking.clear();
        self.save(cx);
        cx.notify();
    }

    pub(super) fn stop(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            self.stopping = true;
            cx.notify();
        }
    }

    /// Write the fixes at `indexes`, one after another; a refused one stops
    /// the rest and says why.
    pub(super) fn apply(&mut self, indexes: Vec<usize>, cx: &mut Context<Self>) {
        if self.loading || self.busy || self.applying || indexes.is_empty() {
            return;
        }
        let writes: Vec<(usize, String, String, String, String)> = indexes
            .iter()
            .filter_map(|index| {
                let entry = self.entries.get(*index)?;
                let result = self.results.get(index)?;
                Some((
                    *index,
                    entry.path.clone(),
                    entry.key.clone(),
                    entry.bibtex.clone(),
                    result.after.clone()?,
                ))
            })
            .collect();
        self.applying = true;
        self.error = None;
        let root = self.root.clone();
        self._task = Some(cx.spawn(async move |this, cx| {
            for (index, path, key, before, after) in writes {
                let write_root = root.clone();
                let written_after = after.clone();
                let written = cx
                    .background_spawn(async move {
                        citation_audit::apply(&write_root, &path, &key, &before, &written_after)
                    })
                    .await;
                let ok = this
                    .update(cx, |this, cx| match written {
                        Ok(()) => {
                            this.applied.insert(index);
                            this.save(cx);
                            // The entries below it in the file move by the
                            // lines the fix added or took away.
                            let moved = (index < this.entries.len()).then(|| {
                                let entry = &mut this.entries[index];
                                let lines = |text: &str| text.matches('\n').count() as isize;
                                let delta = lines(&after) - lines(&entry.bibtex);
                                entry.bibtex = after;
                                (entry.path.clone(), entry.line, delta)
                            });
                            if let Some((path, Some(line), delta)) = moved
                                && delta != 0
                            {
                                for entry in &mut this.entries {
                                    if entry.path == path
                                        && let Some(below) = entry.line.as_mut()
                                        && *below > line
                                    {
                                        *below = below.saturating_add_signed(delta);
                                    }
                                }
                            }
                            cx.emit(AuditEvent::Applied);
                            cx.notify();
                            true
                        }
                        Err(error) => {
                            this.error = Some(error);
                            false
                        }
                    })
                    .unwrap_or(false);
                if !ok {
                    break;
                }
            }
            this.update(cx, |this, cx| {
                this.applying = false;
                this.save(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Keep the writer's own entry over the candidate.
    pub(super) fn keep(&mut self, index: usize, cx: &mut Context<Self>) {
        self.kept.insert(index);
        self.save(cx);
        cx.notify();
    }

    pub(super) fn set_view(&mut self, view: Option<Bucket>, cx: &mut Context<Self>) {
        self.view = view;
        cx.notify();
    }

    pub(super) fn toggle(&mut self, index: usize, cx: &mut Context<Self>) {
        self.open = if self.open == Some(index) {
            None
        } else {
            Some(index)
        };
        cx.notify();
    }

    /// A fresh scan's references: the open one stays open by its file, key
    /// and place among references sharing both.
    fn set_entries(&mut self, entries: Vec<AuditEntry>) {
        let open = self.open.and_then(|index| {
            let key = audit_key(self.entries.get(index)?);
            let nth = self.entries[..index]
                .iter()
                .filter(|entry| audit_key(entry) == key)
                .count();
            Some((key, nth))
        });
        self.entries = entries;
        self.open = open.and_then(|(key, nth)| {
            self.entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| audit_key(entry) == key)
                .nth(nth)
                .map(|(index, _)| index)
        });
    }

    pub(super) fn open_source(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some(entry) = self.entries.get(index) {
            cx.emit(AuditEvent::OpenSource {
                path: entry.path.clone(),
                line: entry.line.unwrap_or(1) as u32,
            });
        }
    }

    pub(super) fn close(&mut self, cx: &mut Context<Self>) {
        // A check under way stops with the sheet; what it found is kept.
        self.save(cx);
        self.generation += 1;
        cx.emit(AuditEvent::Dismiss);
    }

    /// The references by key and bucket, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn rows(&self) -> Vec<(String, Bucket)> {
        (0..self.entries.len())
            .map(|index| (self.entries[index].key.clone(), self.bucket(index)))
            .collect()
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn loaded(&self) -> bool {
        !self.loading
    }
}

impl Focusable for Audit {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_reads_by_its_plain_title_else_its_key() {
        let entry = |title: &str| AuditEntry {
            path: "refs.bib".into(),
            key: "devlin2019".into(),
            title: title.into(),
            bibtex: String::new(),
            issues: Vec::new(),
            inline: None,
            line: None,
            fingerprint: String::new(),
        };
        assert_eq!(
            entry_title(&entry("{BERT}: Pre-training")),
            "BERT: Pre-training"
        );
        assert_eq!(entry_title(&entry("")), "devlin2019");
    }
}
