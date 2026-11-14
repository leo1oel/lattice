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
//!   Stop drains the group under way. Closing the sheet does not stop it:
//!   the run holds its `Audit` (`running.rs`) until it finishes, and the
//!   sheet opened again for the project shows it still going, as the Tauri
//!   app's sheet stays mounted while hidden.
//! - Apply writes a fix through `citation_audit::apply`, which refuses an
//!   entry that changed since it was read; Apply all takes every fix that
//!   only fills in or publishes the entry, leaving disputed values for the
//!   writer. An inline reference is checked, never rewritten.
//! - The report is saved per project beside the app's other state, so it
//!   comes back next time.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::Duration,
};

use futures::{
    FutureExt as _,
    channel::oneshot,
    future::{Either, select},
};

use gpui::{
    App, AppContext as _, Context, EventEmitter, FocusHandle, Focusable, ScrollHandle, Task,
};
use lattice_core::citation_audit::{self, AuditEntry, AuditIssue};
use lattice_i18n::t;

mod detail;
mod finding;
mod groups;
mod issues;
mod messages;
mod report;
mod running;
mod summary;
mod view;

use finding::take_batch;
pub use finding::{Candidate, Change, Finding, Source};
pub use groups::{Bucket, FixGroup, fix_group};
pub use running::{running, stop_others};

/// References checked per group.
const GROUP: usize = 20;
/// How long a group waits on its Semantic Scholar batch before checking the
/// other sources without it: a cached batch answers in time, a queued one
/// does not hold them behind its quota wait.
const S2_HEAD_START: Duration = Duration::from_millis(250);

pub enum AuditEvent {
    Dismiss,
    /// Open a file (project-relative) at a 1-based line.
    OpenSource {
        path: String,
        line: u32,
    },
    /// Files were rewritten: open editors reload what changed.
    Applied,
    /// A check needs the paper tools, which are not installed: setup offers
    /// them (`onMissingPaperTools`).
    MissingPaperTools(String),
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

/// What a check says when the tools it runs are not installed
/// (`PAPER_TOOLS_MISSING`): every later check would fail the same way.
pub(crate) const PAPER_TOOLS_MISSING: &str = "Lattice's paper tools are not installed.";

/// Saves what the editors hold before a scan reads the files on disk,
/// answering whether every write landed (`onPrepare`).
pub type Prepare = std::rc::Rc<dyn Fn(&mut App) -> Task<bool>>;

pub struct Audit {
    /// The window's shell that opened it, which a run is held for.
    owner: gpui::EntityId,
    root: PathBuf,
    prepare: Prepare,
    /// Where the report is saved; none keeps it for this window only.
    store: Option<PathBuf>,
    pub(super) entries: Vec<AuditEntry>,
    /// Files the scan read references from: path, kind and how many.
    pub(super) coverage: Vec<(String, String, usize)>,
    /// What the scan found to tidy in the files themselves.
    pub(super) issues: Vec<AuditIssue>,
    pub(super) results: HashMap<usize, Finding>,
    pub(super) applied: HashSet<usize>,
    pub(super) kept: HashSet<usize>,
    pub(super) loading: bool,
    pub(super) busy: bool,
    pub(super) stopping: bool,
    /// The run stops scheduling checks without the writer's Stop: the paper
    /// tools are missing, so every later check would fail the same way. The
    /// button still reads Cancel check, as the Tauri app's does.
    halted: bool,
    /// The other sources have answered what they can and the group waits on
    /// its Semantic Scholar batch (`waitingForS2`).
    pub(super) waiting_for_s2: bool,
    /// The references being checked right now.
    pub(super) checking: HashSet<usize>,
    /// The run under way: how many it checks, and those it has answered.
    pub(super) run_total: usize,
    pub(super) run_done: HashSet<usize>,
    pub(super) applying: bool,
    pub(super) error: Option<String>,
    pub(super) view: Option<Bucket>,
    /// The reference whose finding is open; `set_scan` keeps it on the
    /// same reference when a rescan renumbers them.
    pub(super) open: Option<usize>,
    pub(super) scroll: ScrollHandle,
    /// The disclosures opened, by reference and name.
    pub(super) disclosed: HashSet<(usize, &'static str)>,
    generation: u64,
    /// Stop's signal to the run, which ends a wait on Semantic Scholar.
    cancel: Option<oneshot::Sender<()>>,
    focus: FocusHandle,
    _task: Option<Task<()>>,
}

impl EventEmitter<AuditEvent> for Audit {}

impl Audit {
    /// `saved`: the save of the editors made as the sheet opened, which the
    /// first scan waits for; later scans save through `prepare`.
    pub fn new(
        owner: gpui::EntityId,
        root: PathBuf,
        prepare: Prepare,
        saved: Task<bool>,
        cx: &mut Context<Self>,
    ) -> Self {
        let store = crate::shell::workspaces::state_dir(crate::settings::scripted(cx))
            .map(|dir| dir.join("audits"));
        let mut this = Self {
            owner,
            root,
            prepare,
            store,
            entries: Vec::new(),
            coverage: Vec::new(),
            issues: Vec::new(),
            run_total: 0,
            run_done: HashSet::new(),
            results: HashMap::new(),
            applied: HashSet::new(),
            kept: HashSet::new(),
            loading: true,
            busy: false,
            stopping: false,
            halted: false,
            waiting_for_s2: false,
            checking: HashSet::new(),
            applying: false,
            error: None,
            view: None,
            open: None,
            scroll: ScrollHandle::new(),
            disclosed: HashSet::new(),
            generation: 0,
            cancel: None,
            focus: cx.focus_handle(),
            _task: None,
        };
        this.load(saved, cx);
        this
    }

    /// Read the references and the saved report; checks stay the writer's
    /// to ask for.
    fn load(&mut self, prepared: Task<bool>, cx: &mut Context<Self>) {
        let (root, store) = (self.root.clone(), self.store.clone());
        let read = async move {
            let scan = citation_audit::scan(&root)?;
            let saved = match &store {
                // A save still on its way would land after this read, and the
                // next save from here would put the older report back.
                Some(dir) => report::load(dir, &root).ok().flatten().unwrap_or_default(),
                None => Vec::new(),
            };
            Ok::<_, String>((scan, saved))
        };
        let generation = self.generation;
        self._task = Some(cx.spawn(async move |this, cx| {
            let read = if prepared.await {
                cx.background_spawn(read).await
            } else {
                Err(t!("Save pending edits before checking references.").to_string())
            };
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match read {
                    Ok((scan, saved)) => {
                        this.set_scan(scan);
                        this.carry_over(&report::read(saved), true);
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
    fn carry_over(&mut self, saved: &report::Report, mark_changed: bool) {
        (self.results, self.applied, self.kept) = report::carry(&self.entries, saved, mark_changed);
    }

    fn report(&self) -> Vec<(String, serde_json::Value)> {
        report::build(&self.entries, &self.results, &self.applied, &self.kept)
    }

    fn save(&self, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let (root, report) = (self.root.clone(), self.report());
        let pending = report::Pending::begin(&root);
        let asked = report::ask();
        cx.background_spawn(async move {
            report::write(&store, &root, asked, report);
            drop(pending);
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
        self.halted = false;
        self.waiting_for_s2 = false;
        self.error = None;
        // Until the rescan says how many it checks, the last run's count
        // would read as this one's.
        self.run_total = 0;
        self.run_done.clear();
        let root = self.root.clone();
        let saved = report::read(self.report());
        let prepared = (self.prepare.clone())(cx);
        let (cancel, mut cancelled) = oneshot::channel();
        self.cancel = Some(cancel);
        running::hold(self.owner, &self.root, cx.entity(), cx);
        self._task = Some(cx.spawn(async move |this, cx| {
            let scan_root = root.clone();
            let scan = if prepared.await {
                cx.background_spawn(async move { citation_audit::scan(&scan_root) })
                    .await
            } else {
                Err(t!("Save pending edits before checking references.").to_string())
            };
            let indexes = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return None;
                }
                match scan {
                    Ok(scan) => {
                        this.set_scan(scan);
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
                this.checking = indexes.iter().copied().collect();
                cx.notify();
            })
            .ok();
            // A Semantic Scholar batch that failed is not asked again this
            // run; each reference's own check is told why.
            let mut s2_failure: Option<String> = None;
            for group in indexes.chunks(GROUP) {
                let (entries, live) = match this.update(cx, |this, _| {
                    let entries: Vec<AuditEntry> = group
                        .iter()
                        .map(|index| this.entries[*index].clone())
                        .collect();
                    (entries, this.generation == generation && !this.stopped())
                }) {
                    Ok(state) => state,
                    Err(_) => return,
                };
                if !live {
                    break;
                }
                // The batch answers what it can; a lone reference has no batch.
                // While it is pending the other sources are checked without
                // Semantic Scholar, which the batch is asking.
                let mut answered: Vec<Option<Finding>> = vec![None; entries.len()];
                let mut s2_status = s2_failure.clone();
                let mut pending = None;
                if s2_failure.is_none() && total > 1 {
                    s2_status = Some("checked".into());
                    let (batch_root, batch_entries) = (root.clone(), entries.clone());
                    let batch = cx.background_spawn(async move {
                        citation_audit::check_batch(&batch_root, batch_entries)
                    });
                    let head_start = cx.background_executor().timer(S2_HEAD_START);
                    match select(batch, select(head_start, &mut cancelled)).await {
                        Either::Left((batch, _)) => {
                            take_batch(batch, &mut answered, &mut s2_failure, &mut s2_status);
                            let early: Vec<(usize, Finding)> = answered
                                .iter()
                                .enumerate()
                                .filter_map(|(at, finding)| Some((group[at], finding.clone()?)))
                                .collect();
                            this.update(cx, |this, cx| this.record(generation, early, cx))
                                .ok();
                        }
                        Either::Right((_, batch)) => {
                            pending = Some(batch);
                            this.update(cx, |this, cx| {
                                if this.generation == generation && !this.stopped() {
                                    this.waiting_for_s2 = true;
                                    cx.notify();
                                }
                            })
                            .ok();
                        }
                    }
                }
                // What the batch left, two at a time; Stop lets them finish.
                loop {
                    if let Some(batch) = pending.as_mut().and_then(|batch| batch.now_or_never()) {
                        take_batch(batch, &mut answered, &mut s2_failure, &mut s2_status);
                        pending = None;
                    }
                    let pair: Vec<usize> = (0..entries.len())
                        .filter(|at| answered[*at].is_none())
                        .take(2)
                        .collect();
                    let stopped = this
                        .update(cx, |this, _| {
                            this.stopped() || this.generation != generation
                        })
                        .unwrap_or(true);
                    if stopped || pair.is_empty() {
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
                    let mut missing_tools = None;
                    for (at, check) in pair.iter().zip(checks) {
                        let finding = check.await;
                        if finding.message.contains(PAPER_TOOLS_MISSING) {
                            missing_tools = Some(finding.message.clone());
                        }
                        answered[*at] = Some(finding);
                    }
                    if let Some(failure) = missing_tools {
                        this.update(cx, |this, cx| {
                            if this.generation == generation {
                                if !this.stopped() {
                                    cx.emit(AuditEvent::MissingPaperTools(failure));
                                }
                                this.halted = true;
                            }
                        })
                        .ok();
                    }
                    let partial: Vec<(usize, Finding)> = pair
                        .iter()
                        .filter_map(|at| Some((group[*at], answered[*at].clone()?)))
                        .collect();
                    this.update(cx, |this, cx| this.record(generation, partial, cx))
                        .ok();
                }
                let stopped = this
                    .update(cx, |this, _| {
                        this.stopped() || this.generation != generation
                    })
                    .unwrap_or(true);
                if let Some(batch) = pending.filter(|_| !stopped)
                    && let Either::Left((batch, _)) = select(batch, &mut cancelled).await
                {
                    take_batch(batch, &mut answered, &mut s2_failure, &mut s2_status);
                }
                let stopped = this
                    .update(cx, |this, _| {
                        this.stopped() || this.generation != generation
                    })
                    .unwrap_or(true);
                let all: Vec<(usize, Finding)> = answered
                    .into_iter()
                    .enumerate()
                    .filter_map(|(at, finding)| {
                        let mut finding = finding?;
                        if let Some(failure) = &s2_failure {
                            finding
                                .sources
                                .retain(|source| source.source != "semanticscholar");
                            finding.sources.push(Source {
                                source: "semanticscholar".into(),
                                outcome: if failure == "not_configured" {
                                    failure.clone()
                                } else {
                                    format!("batch_{failure}")
                                },
                            });
                        }
                        Some((group[at], finding))
                    })
                    .collect();
                this.update(cx, |this, cx| {
                    if this.generation == generation {
                        this.waiting_for_s2 = false;
                    }
                    if !stopped {
                        this.record(generation, all, cx);
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
            self.checking.remove(&index);
            self.run_done.insert(index);
            self.results.insert(index, finding);
            // A fresh result replaces what the writer did with the old one.
            self.applied.remove(&index);
            self.kept.remove(&index);
        }
        self.save(cx);
        cx.notify();
    }

    fn finish(&mut self, generation: u64, cx: &mut Context<Self>) {
        if self.generation != generation {
            return;
        }
        self.busy = false;
        self.stopping = false;
        self.halted = false;
        self.waiting_for_s2 = false;
        self.checking.clear();
        running::release(self.owner, &self.root, cx);
        cx.notify();
    }

    /// The run is to schedule no more checks: the writer stopped it, or the
    /// paper tools are missing.
    fn stopped(&self) -> bool {
        self.stopping || self.halted
    }

    pub(super) fn stop(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            self.stopping = true;
            if let Some(cancel) = self.cancel.take() {
                cancel.send(()).ok();
            }
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
                            report::land_fix(&mut this.entries, index, after);
                            this.applied.insert(index);
                            this.save(cx);
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
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Keep the writer's own entry over the candidate, or (`kept` false)
    /// put it back for review.
    pub(super) fn keep(&mut self, index: usize, kept: bool, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if kept {
            self.kept.insert(index);
        } else {
            self.kept.remove(&index);
        }
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
        self.move_disclosed(None, None);
        cx.notify();
    }

    /// The open reference's disclosures follow it from `from` to `to`; any
    /// other reference's close, as its finding's would on unmounting.
    fn move_disclosed(&mut self, from: Option<usize>, to: Option<usize>) {
        self.disclosed = std::mem::take(&mut self.disclosed)
            .into_iter()
            .filter_map(|(index, name)| match index {
                usize::MAX => Some((index, name)),
                _ if Some(index) == from => to.map(|to| (to, name)),
                _ => None,
            })
            .collect();
    }

    /// A fresh scan's references and the files they came from: the open one
    /// stays open by its file, key and place among references sharing both.
    fn set_scan(&mut self, scan: citation_audit::AuditScan) {
        self.coverage = scan
            .coverage
            .iter()
            .map(|file| (file.path.clone(), file.kind.to_string(), file.entries))
            .collect();
        self.issues = scan.issues;
        let open = self.open.and_then(|index| {
            let key = audit_key(self.entries.get(index)?);
            let nth = self.entries[..index]
                .iter()
                .filter(|entry| audit_key(entry) == key)
                .count();
            Some((key, nth))
        });
        self.entries = scan.entries;
        let was_open = self.open;
        self.open = open.and_then(|(key, nth)| {
            self.entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| audit_key(entry) == key)
                .nth(nth)
                .map(|(index, _)| index)
        });
        self.move_disclosed(was_open, self.open);
    }

    /// Open the entry where it starts; one the scan placed nowhere offers
    /// no Go to (`goTo`), and nothing opens while fixes are written.
    pub(super) fn open_source(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.applying {
            return;
        }
        if let Some(entry) = self.entries.get(index)
            && let Some(line) = entry.line
        {
            cx.emit(AuditEvent::OpenSource {
                path: entry.path.clone(),
                line: line as u32,
            });
        }
    }

    /// Fixes are being written: the sheet stays until they land.
    pub fn is_applying(&self) -> bool {
        self.applying
    }

    /// A check under way keeps running with the sheet closed (its run holds
    /// this `Audit`), and the sheet opened again shows it. A read that has
    /// not landed stops with the sheet. Fixes being written keep it open
    /// until they land.
    pub(super) fn close(&mut self, cx: &mut Context<Self>) {
        if self.applying {
            return;
        }
        if !self.busy {
            self.generation += 1;
        }
        cx.emit(AuditEvent::Dismiss);
    }

    /// Stop a run under way, for a sheet another project opened.
    pub(crate) fn abandon(&mut self, cx: &mut Context<Self>) {
        self.stop(cx);
        self.generation += 1;
        self.busy = false;
        self.checking.clear();
        running::release(self.owner, &self.root, cx);
    }

    pub(super) fn toggle_disclosure(
        &mut self,
        index: usize,
        name: &'static str,
        cx: &mut Context<Self>,
    ) {
        if !self.disclosed.remove(&(index, name)) {
            self.disclosed.insert((index, name));
        }
        cx.notify();
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
