//! A check run (`start` in `bibliography-audit.tsx`): the references read
//! again, then checked twenty at a time, Semantic Scholar's batch first and
//! each reference the batch could not answer on its own, two at once. Stop
//! drains the group under way; a check that finds the paper tools missing
//! halts the run, as every later check would fail the same way.

use std::{collections::HashSet, time::Duration};

use futures::{
    FutureExt as _,
    channel::oneshot,
    future::{Either, select},
};
use gpui::{AppContext as _, Context};
use lattice_core::citation_audit::{self, AuditEntry};
use lattice_i18n::t;

use super::{
    Audit, AuditEvent, Finding, PAPER_TOOLS_MISSING, Source, audit_key, finding::take_batch,
    report, running,
};

/// References checked per group.
const GROUP: usize = 20;
/// How long a group waits on its Semantic Scholar batch before checking the
/// other sources without it: a cached batch answers in time, a queued one
/// does not hold them behind its quota wait.
const S2_HEAD_START: Duration = Duration::from_millis(250);

impl Audit {
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
}
