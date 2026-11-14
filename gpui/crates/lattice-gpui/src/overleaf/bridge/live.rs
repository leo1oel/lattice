//! Live mode's timing: a change here pushed once the writer pauses (with a
//! cheap local check first), Overleaf polled for co-authors' work while the
//! channel is down or blind, and Manual mode's badge for new work there.

use super::*;

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
        self.schedule_push(cx);
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
                .update(cx, |this, _| this.live_paths())
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
        self.last_auto_sync
            .map(|last| MIN_SYNC_GAP.saturating_sub(last.elapsed()))
            .unwrap_or_default()
    }

    /// Live mode's poll: the probe every few seconds, the full sync only on
    /// a yes (`overleaf-live-poll.ts`). The first probe also reads the files
    /// here, so work left from before the project opened goes up.
    pub(super) fn live_poll(&mut self, cx: &mut Context<Self>) -> Task<()> {
        let Some(root) = self.root.clone() else {
            return Task::ready(());
        };
        cx.spawn(async move |this, cx| {
            let mut wait = LIVE_POLL;
            let mut first = true;
            loop {
                let (busy, live) = this
                    .update(cx, |this, _| (this.syncing, this.live_paths()))
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
                cx.background_executor().timer(wait).await;
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
                    (*wait * 2).clamp(LIVE_POLL, Duration::from_secs(60))
                };
                return;
            }
        };
        let version_known = probe.as_ref().is_some_and(|probe| probe.version_known);
        *wait = if version_known { LIVE_POLL } else { BLIND_POLL };
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
