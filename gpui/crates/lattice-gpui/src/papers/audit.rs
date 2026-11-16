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
//!   each reference the batch could not answer on its own, two at once
//!   (`run.rs`). Stop drains the group under way. Closing the sheet does not stop it:
//!   the run holds its `Audit` (`running.rs`) until it finishes, and the
//!   sheet opened again for the project shows it still going, as the Tauri
//!   app's sheet stays mounted while hidden.
//! - Apply writes a fix through `citation_audit::apply`, which refuses an
//!   entry that changed since it was read; Apply all takes every fix that
//!   only fills in or publishes the entry, leaving disputed values for the
//!   writer. An inline reference is checked, never rewritten.
//! - Ticking references offers Check selected, which checks only those
//!   (`selection.rs`); a report with nothing left to act on shows the research
//!   desk's reading glass.
//! - The report is saved per project beside the app's other state, so it
//!   comes back next time.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

use futures::channel::oneshot;

use gpui::{
    App, AppContext as _, Context, EventEmitter, FocusHandle, Focusable, ScrollHandle, Task,
};
use lattice_core::citation_audit::{self, AuditEntry, AuditIssue};
use lattice_i18n::t;

mod compare;
mod detail;
mod finding;
mod fix;
mod groups;
mod issues;
mod mark;
mod messages;
mod pane;
mod queue;
mod report;
mod row;
mod run;
mod running;
mod selection;
mod summary;
mod tabs;
mod typeset;
mod view;

pub use finding::{Candidate, Change, Finding, Source};
pub use groups::{Bucket, FixGroup, fix_group};
pub use queue::{KEY_CONTEXT, bindings};
pub use running::{running, stop_others};

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
    /// The references ticked for Check selected (`selected`); a fresh scan
    /// renumbers them, so it clears them.
    pub(super) selected: HashSet<usize>,
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
    /// The sheet is wide enough for the review queue's two panes, as the
    /// last frame measured the window (`queueWidth`).
    pub(super) queue: bool,
    /// The sheet is narrower than 520px: a folded row keeps no Apply.
    pub(super) narrow: bool,
    /// The row to bring into view next frame: the finding just opened.
    pub(super) reveal: Option<usize>,
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
            selected: HashSet::new(),
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
            queue: false,
            narrow: false,
            reveal: None,
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

    /// Write the fixes at `indexes`, one after another; a refused one stops
    /// the rest and says why.
    pub(super) fn apply(&mut self, indexes: Vec<usize>, cx: &mut Context<Self>) {
        self.apply_then(indexes, None, cx);
    }

    /// [`Audit::apply`], then, once every write landed, open `advance`'s
    /// finding (none closes the open one), as Apply moves to the next.
    fn apply_then(
        &mut self,
        indexes: Vec<usize>,
        advance: Option<Option<usize>>,
        cx: &mut Context<Self>,
    ) {
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
            let mut landed = true;
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
                    landed = false;
                    break;
                }
            }
            this.update(cx, |this, cx| {
                this.applying = false;
                if landed && let Some(next) = advance {
                    this.open_finding(next, cx);
                }
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
        // Keep mine finishes the finding: the queue moves on to the next.
        let next = kept.then(|| self.listing().next_after(index));
        if kept {
            self.kept.insert(index);
        } else {
            self.kept.remove(&index);
        }
        self.save(cx);
        if let Some(next) = next {
            self.open_finding(next, cx);
        }
        cx.notify();
    }

    pub(super) fn set_view(&mut self, view: Option<Bucket>, cx: &mut Context<Self>) {
        self.view = view;
        cx.notify();
    }

    /// A row pressed: its finding opens, or (unfolded under its row, below
    /// the queue's width) folds again.
    pub(super) fn toggle(&mut self, index: usize, cx: &mut Context<Self>) {
        let open = self.current(&self.listing()) == Some(index);
        self.open_finding((self.queue || !open).then_some(index), cx);
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
        self.selected.clear();
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
