//! Live mode's timing: a change here pushed once the writer pauses (with a
//! cheap local check first), a whole-file document's held until the writer
//! leaves it, Overleaf polled for co-authors' work (often while the channel
//! is down or blind, rarely once it carries documents, never from a window
//! off screen), and Manual mode's badge for new work there.

use futures::{FutureExt as _, StreamExt as _};

use super::*;
use crate::structured::StructuredKind;

/// A board, sheet or deck: its editor rewrites the whole file on every
/// change, so each save would otherwise cost a project download
/// (`isWholeFileEditorPath`).
pub(in crate::overleaf) fn is_whole_file(path: &str) -> bool {
    StructuredKind::of(path).is_some()
}

/// Whole-file documents' uploads, held while they are edited.
#[derive(Default)]
pub(in crate::overleaf) struct WholeFiles {
    /// Shown in the window's editor now.
    editing: BTreeSet<String>,
    /// Shown, with an edit the page has not committed yet (a deck's
    /// pending inspector change): held even from a flush.
    drafts: BTreeSet<String>,
    /// Saved since they last went up.
    deferred: BTreeSet<String>,
    /// Left: flushed once their writes settle.
    boundary: BTreeSet<String>,
    /// Every held one goes with the next flush (⌘S, the window's blur).
    flush_all: bool,
    boundary_task: Option<Task<()>>,
    idle_task: Option<Task<()>>,
}

impl WholeFiles {
    pub(super) fn stop_timers(&mut self) {
        self.boundary_task = None;
        self.idle_task = None;
        self.boundary.clear();
        self.flush_all = false;
    }

    /// A sync went through without `live`: what it carried is up.
    pub(super) fn synced(&mut self, live: &BTreeSet<String>) {
        self.deferred.retain(|path| live.contains(path));
    }
}

impl OverleafBridge {
    /// Files changed on disk under the project (the watcher's report): in
    /// live mode, a change to push once the writer pauses. A sync's own
    /// writes are reported too, so a report is only a reason to look: the
    /// probe before the push reads the files against the copy the sync
    /// agreed on, so they cost one small request and no sync.
    pub fn files_changed(&mut self, paths: Option<&[String]>, cx: &mut Context<Self>) {
        if self.staged {
            return;
        }
        if self.mode != OverleafSyncMode::Live || self.link().is_none() {
            return;
        }
        // App folders and the version history never sync.
        let relevant = paths.is_none_or(|paths| {
            paths.iter().any(|path| {
                !(path.starts_with(".research/")
                    || path.starts_with(".git/")
                    || path.starts_with(".omp/"))
            })
        });
        if !relevant {
            return;
        }
        let Some(paths) = paths else {
            self.schedule_push(cx);
            return;
        };
        // A whole-file editor's saves wait for a document boundary, or the
        // idle fallback, instead of a project download after every change.
        let (whole, other): (Vec<&String>, Vec<&String>) =
            paths.iter().partition(|path| is_whole_file(path));
        if !whole.is_empty() {
            let mut left = false;
            for path in whole {
                self.whole_files.deferred.insert(path.clone());
                if !self.whole_files.editing.contains(path) {
                    self.whole_files.boundary.insert(path.clone());
                    left = true;
                }
            }
            if left {
                self.arm_boundary_flush(cx);
            }
            self.whole_files.idle_task = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(WHOLE_FILE_IDLE).await;
                this.update(cx, |this, cx| this.flush_whole_files(None, cx))
                    .ok();
            }));
        }
        if other.iter().any(|path| {
            !(path.starts_with(".research/")
                || path.starts_with(".git/")
                || path.starts_with(".omp/"))
        }) {
            self.schedule_push(cx);
        }
    }

    /// The whole-file documents in the shown editor are `editing` now (one,
    /// or none); those just left go up once their last writes settle.
    pub fn whole_files_shown(&mut self, editing: BTreeSet<String>, cx: &mut Context<Self>) {
        let left: Vec<String> = self
            .whole_files
            .editing
            .difference(&editing)
            .cloned()
            .collect();
        self.whole_files.editing = editing;
        let drafts = &self.whole_files.editing;
        self.whole_files.drafts.retain(|path| drafts.contains(path));
        let mut any = false;
        for path in left {
            if self.whole_files.deferred.contains(&path) {
                self.whole_files.boundary.insert(path);
                any = true;
            }
        }
        if any {
            self.arm_boundary_flush(cx);
        }
    }

    /// `path`, shown in a deck, has an edit its page has not committed yet
    /// (or no longer has one).
    pub fn set_whole_file_draft(&mut self, path: &str, draft: bool) {
        if draft && self.whole_files.editing.contains(path) {
            self.whole_files.drafts.insert(path.to_string());
        } else {
            self.whole_files.drafts.remove(path);
        }
    }

    fn arm_boundary_flush(&mut self, cx: &mut Context<Self>) {
        self.whole_files.boundary_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(WHOLE_FILE_SETTLE).await;
            this.update(cx, |this, cx| {
                let mut paths = std::mem::take(&mut this.whole_files.boundary);
                if std::mem::take(&mut this.whole_files.flush_all) {
                    paths.extend(this.whole_files.deferred.iter().cloned());
                }
                this.flush_whole_files(Some(paths), cx);
            })
            .ok();
        }));
    }

    /// Flush every held whole-file document once the writes under way
    /// settle (`save().then(flushDeferredWholeFileSync)`): ⌘S, or the
    /// window losing focus. What those writes save is held by then too.
    pub fn flush_whole_files_soon(&mut self, cx: &mut Context<Self>) {
        if self.staged || self.mode != OverleafSyncMode::Live || self.link().is_none() {
            return;
        }
        self.whole_files.flush_all = true;
        self.arm_boundary_flush(cx);
    }

    /// Send the held whole-file documents (`paths`, or all of them) up now:
    /// ⌘S, leaving them, the idle fallback (`flushDeferredWholeFileSync`).
    /// One with an uncommitted page edit waits a little longer.
    pub fn flush_whole_files(&mut self, paths: Option<BTreeSet<String>>, cx: &mut Context<Self>) {
        if self.staged || self.mode != OverleafSyncMode::Live || self.link().is_none() {
            return;
        }
        let requested = paths.unwrap_or_else(|| self.whole_files.deferred.clone());
        let ready: BTreeSet<String> = requested
            .iter()
            .filter(|path| {
                self.whole_files.deferred.contains(*path)
                    && !self.whole_files.drafts.contains(*path)
            })
            .cloned()
            .collect();
        if ready.is_empty() {
            if requested
                .iter()
                .any(|path| self.whole_files.deferred.contains(path))
            {
                self.whole_files.boundary.extend(requested);
                self.arm_boundary_flush(cx);
            }
            return;
        }
        if self.syncing {
            // Once the running sync is over, the flush is the next one.
            self.whole_files.boundary.extend(ready);
            self.arm_boundary_flush(cx);
            return;
        }
        self.push_whole_files(ready, cx);
    }

    /// Sync `ready` up, once a probe that reads the files here says
    /// something differs: a sync's own write of a board is reported like
    /// the writer's, and must not cost a project download.
    fn push_whole_files(&mut self, ready: BTreeSet<String>, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let options = SyncOptions {
            automatic: true,
            include_whole_files: ready,
            ..Default::default()
        };
        let live = self.sync_live_paths(&options, cx);
        let probe_root = root.clone();
        let probe = cx.background_spawn(async move { sync::probe(&probe_root, Some(&live)) });
        self.whole_files.boundary_task = Some(cx.spawn(async move |this, cx| {
            let (probe, expired) = probe.await;
            this.update(cx, |this, cx| {
                if expired {
                    super::super::session_changed(cx);
                }
                if !this.is_current(&root) {
                    return;
                }
                if this.syncing {
                    // A sync started meanwhile: the flush follows it.
                    this.whole_files
                        .boundary
                        .extend(options.include_whole_files);
                    this.arm_boundary_flush(cx);
                    return;
                }
                match probe {
                    Ok(probe) if probe.version_known && !probe.changed && !probe.local_changed => {
                        for path in &options.include_whole_files {
                            this.whole_files.deferred.remove(path);
                        }
                    }
                    Ok(probe) => this.sync(
                        SyncOptions {
                            observed_remote_version: probe.remote_version,
                            ..options
                        },
                        cx,
                    ),
                    Err(_) => this.sync(options, cx),
                }
            })
            .ok();
        }));
    }

    /// What a sync (or its probe) leaves alone: the documents the channel
    /// carries and, in a sync of live mode's own, whole-file documents
    /// still being edited, unless this one carries them; a deck's
    /// uncommitted edit stays out of every sync.
    pub(super) fn sync_live_paths(&self, options: &SyncOptions, _cx: &App) -> BTreeSet<String> {
        let mut live = self.live_paths();
        for path in &self.whole_files.editing {
            let carried = !options.automatic || options.include_whole_files.contains(path);
            if !carried || self.whole_files.drafts.contains(path) {
                live.insert(path.clone());
            }
        }
        live
    }

    /// Push after the quiet period, once a probe that reads the files here
    /// says something differs, waiting out the rest of the sync gap.
    pub(super) fn schedule_push(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.push_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PUSH_DEBOUNCE).await;
            loop {
                let wait = this
                    .update(cx, |this, _| {
                        if this.syncing {
                            return Some(Duration::from_secs(1));
                        }
                        Some(this.gap_left())
                    })
                    .ok()
                    .flatten();
                match wait {
                    Some(wait) if !wait.is_zero() => cx.background_executor().timer(wait).await,
                    _ => break,
                }
            }
            let probe_root = root.clone();
            let live = this
                .update(cx, |this, cx| {
                    this.sync_live_paths(
                        &SyncOptions {
                            automatic: true,
                            ..Default::default()
                        },
                        cx,
                    )
                })
                .unwrap_or_default();
            let (probe, expired) = cx
                .background_spawn(async move { sync::probe(&probe_root, Some(&live)) })
                .await;
            this.update(cx, |this, cx| {
                if expired {
                    super::super::session_changed(cx);
                }
                if this.root.as_deref() != Some(root.as_path()) {
                    return;
                }
                match probe {
                    Ok(probe) if probe.version_known && !probe.changed && !probe.local_changed => {
                        this.local_pending = false;
                    }
                    Ok(probe) => this.sync(
                        SyncOptions {
                            automatic: true,
                            observed_remote_version: probe.remote_version,
                            ..Default::default()
                        },
                        cx,
                    ),
                    // A probe that could not run means a full sync.
                    Err(_) => this.sync(
                        SyncOptions {
                            automatic: true,
                            ..SyncOptions::default()
                        },
                        cx,
                    ),
                }
            })
            .ok();
        }));
    }

    /// The rest of the gap since the last automatic sync.
    pub(super) fn gap_left(&self) -> Duration {
        let gap = if self.channel_live() {
            CHANNEL_SYNC_GAP
        } else {
            MIN_SYNC_GAP
        };
        self.last_auto_sync
            .map(|last| gap.saturating_sub(last.elapsed()))
            .unwrap_or_default()
    }

    /// The poll's cadence while probes answer with a version.
    fn base_poll(&self) -> Duration {
        if self.channel_live() {
            CHANNEL_POLL
        } else {
            LIVE_POLL
        }
    }

    /// Live mode's poll: the probe every few seconds, the full sync only on
    /// a yes (`overleaf-live-poll.ts`). The first probe also reads the files
    /// here, so work left from before the project opened goes up.
    ///
    /// Off screen the loop rests: no probe until the window is shown again,
    /// which asks at once (as focus does, through `woken`). Without this an
    /// idle window behind others asked Overleaf every 3 s while its channel
    /// was down, for as long as it stayed open. Our own unsent work is the
    /// exception: a sync owed for a failed transfer or a change here keeps
    /// its retries going, so collaborators still get it.
    pub(super) fn live_poll(
        &mut self,
        mut woken: mpsc::UnboundedReceiver<()>,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        let Some(root) = self.root.clone() else {
            return Task::ready(());
        };
        let mut wait = self.base_poll();
        cx.spawn(async move |this, cx| {
            let mut first = true;
            loop {
                let (busy, live) = this
                    .update(cx, |this, cx| {
                        let owed = this.transport_retry || this.local_pending;
                        let resting = !this.window_visible && !owed;
                        let live = this.sync_live_paths(
                            &SyncOptions {
                                automatic: true,
                                ..Default::default()
                            },
                            cx,
                        );
                        (this.syncing || resting, live)
                    })
                    .unwrap_or((true, BTreeSet::new()));
                if !busy {
                    let probe_root = root.clone();
                    let local = first;
                    let (probe, expired) = cx
                        .background_spawn(async move {
                            sync::probe(&probe_root, local.then_some(&live))
                        })
                        .await;
                    if probe.is_ok() {
                        first = false;
                    }
                    let next = this.update(cx, |this, cx| {
                        if expired {
                            super::super::session_changed(cx);
                            this.reload_link(cx);
                        }
                        this.poll_answered(probe, local, &mut wait, cx)
                    });
                    if next.is_err() {
                        return;
                    }
                }
                // Asked while that probe ran: it already answered.
                while woken.try_recv().is_ok() {}
                let mut timer = cx.background_executor().timer(wait).fuse();
                futures::select_biased! {
                    _ = timer => {}
                    asked = woken.next() => {
                        if asked.is_none() {
                            return;
                        }
                    }
                }
            }
        })
    }

    /// What a live poll's probe calls for, and how long until the next.
    pub(super) fn poll_answered(
        &mut self,
        probe: Result<lattice_core::overleaf::OverleafProbe, String>,
        local: bool,
        wait: &mut Duration,
        cx: &mut Context<Self>,
    ) {
        let probe = match probe {
            Ok(probe) => Some(probe),
            // A refused probe is a probe without a version: sync on the slow
            // clock, and let the sync count the refusals and report them.
            Err(error)
                if outcome::is_project_refusal(&error)
                    && self.refusals < outcome::REFUSAL_RETRIES =>
            {
                None
            }
            Err(error) => {
                // A 429 means we are asking too often: ease off sharply.
                *wait = if outcome::is_rate_limited(&error) {
                    (*wait * 4).min(Duration::from_secs(300))
                } else {
                    (*wait * 2).clamp(self.base_poll(), Duration::from_secs(60))
                };
                return;
            }
        };
        let version_known = probe.as_ref().is_some_and(|probe| probe.version_known);
        *wait = if version_known {
            self.base_poll()
        } else {
            BLIND_POLL
        };
        if local && probe.as_ref().is_some_and(|probe| probe.local_changed) {
            self.local_pending = true;
        }
        let gap_elapsed = self.gap_left().is_zero();
        let owed = self.transport_retry || self.local_pending;
        let since_last = self.last_auto_sync.map(|last| last.elapsed());
        if owed && gap_elapsed {
            self.sync(
                SyncOptions {
                    automatic: true,
                    ..Default::default()
                },
                cx,
            );
        } else if !version_known {
            // No change signal: sync on a slow clock instead.
            if since_last.is_none_or(|since| since >= BLIND_POLL) {
                self.sync(
                    SyncOptions {
                        automatic: true,
                        ..Default::default()
                    },
                    cx,
                );
            }
        } else if let Some(probe) = probe.filter(|probe| probe.changed && gap_elapsed) {
            self.sync(
                SyncOptions {
                    automatic: true,
                    observed_remote_version: probe.remote_version,
                    ..Default::default()
                },
                cx,
            );
        }
    }

    /// Manual mode only badges incoming work; a check that cannot run leaves
    /// the badge as it was.
    pub(super) fn badge_poll(&mut self, root: PathBuf, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| {
            loop {
                let probe_root = root.clone();
                let (probe, _) = cx
                    .background_spawn(async move { sync::probe(&probe_root, None) })
                    .await;
                let alive = this.update(cx, |this, cx| {
                    if let Ok(probe) = probe {
                        if this.remote_changes != probe.changed {
                            this.remote_changes = probe.changed;
                            cx.notify();
                        }
                    }
                });
                if alive.is_err() {
                    return;
                }
                cx.background_executor().timer(BADGE_POLL).await;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boards_sheets_and_decks_are_whole_file_documents() {
        assert!(is_whole_file("figures/plan.tldr"));
        assert!(is_whole_file("data.lattice-sheet"));
        assert!(!is_whole_file("main.tex"));
        assert!(!is_whole_file("notes.md"));
    }

    #[test]
    fn a_sync_settles_the_held_files_it_carried() {
        let mut files = WholeFiles {
            deferred: BTreeSet::from(["a.tldr".to_string(), "b.tldr".to_string()]),
            ..Default::default()
        };
        // `b.tldr` was still being edited, so the sync left it alone.
        files.synced(&BTreeSet::from(["b.tldr".to_string()]));
        assert_eq!(files.deferred, BTreeSet::from(["b.tldr".to_string()]));
    }
}
