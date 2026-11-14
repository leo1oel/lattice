//! What a finished sync leaves the writer to know or do
//! (`reportSyncOutcome`): the summary toast, its warnings and conflicts, the
//! version it records, and, for a failure, the words that fit or a quiet
//! retry.

use super::*;

impl OverleafBridge {
    /// A sync finished: say what it left, and settle what it asks of the
    /// writer.
    pub(super) fn synced(
        &mut self,
        root: PathBuf,
        result: OverleafSyncResult,
        options: SyncOptions,
        cx: &mut Context<Self>,
    ) {
        self.transport_retry = false;
        self.refusals = 0;
        self.remote_changes = false;
        // Edited here while the sync ran: left as they were, so they still
        // need to go up.
        if !result.edited_during_sync.is_empty() {
            self.local_pending = true;
            if self.mode == OverleafSyncMode::Live {
                self.schedule_push(cx);
            }
        }
        // Old versions uploaded PDF-inspection renders from an app-owned
        // folder: removed silently, outside the writer's preference.
        if !result.automatic_remote_deletes.is_empty() && !result.read_only {
            remote_deletes::settle(
                self,
                &root,
                result.automatic_remote_deletes.clone(),
                true,
                cx,
            );
        }
        // What happens to a file deleted here is the writer's call.
        if !result.skipped_remote_deletes.is_empty() {
            remote_deletes::settle(
                self,
                &root,
                result.skipped_remote_deletes.clone(),
                false,
                cx,
            );
        }
        let this = cx.entity().downgrade();
        for warning in outcome::warnings(&result) {
            let mut notice = Notice::new(ToastLevel::Warning, warning.message);
            if let Some(file) = warning.resolve {
                let this = this.clone();
                notice = notice.action(NoticeAction::new(t!("Resolve"), move |_, cx| {
                    this.update(cx, |_, cx| {
                        cx.emit(OverleafBridgeEvent::OpenConflict(file.clone()))
                    })
                    .ok();
                }));
            }
            notices::show(notice, cx);
        }
        self.report_conflicts(&root, &result, cx);
        let incoming = outcome::incoming(&result);
        if incoming {
            cx.emit(OverleafBridgeEvent::Incoming);
        }
        let moved =
            !result.pulled.is_empty() || !result.pushed.is_empty() || !result.merged.is_empty();
        // A quiet background no-op is only logged.
        if !options.automatic || moved {
            notices::show(
                Notice::new(ToastLevel::Success, outcome::summary(&result)).key(SYNC_KEY),
                cx,
            );
        } else {
            log::info!("{}", outcome::summary(&result));
        }
        // Only a real content change becomes a version.
        if incoming || !result.pushed.is_empty() {
            let version_root = root.clone();
            cx.background_spawn(async move {
                let _ = lattice_core::git::auto_commit(
                    &version_root,
                    crate::history::messages::OVERLEAF_SYNC,
                    None,
                );
            })
            .detach();
        }
        if self.channel == ChannelStatus::Error && !self.rejoined {
            self.rejoined = true;
            self.channel_task = None;
        }
        self.reload_link(cx);
    }

    /// Say which files a sync left in conflict, and open the resolver on the
    /// first that has markers in it (`reportSyncOutcome`). A later write can
    /// have settled one already, so each is read back first.
    fn report_conflicts(
        &mut self,
        root: &Path,
        result: &OverleafSyncResult,
        cx: &mut Context<Self>,
    ) {
        if result.conflicts.is_empty() {
            return;
        }
        let marked: Vec<_> = result
            .conflicts
            .iter()
            .filter(|conflict| conflict.markers)
            .filter(|conflict| {
                lattice_core::project::read_file(root, &conflict.path)
                    .map(|text| crate::history::conflicts::has_conflict_markers(&text))
                    .unwrap_or(true)
            })
            .collect();
        let whole: Vec<_> = result
            .conflicts
            .iter()
            .filter(|conflict| !conflict.markers)
            .collect();
        let message = outcome::conflict_message(&marked, &whole);
        if !message.is_empty() {
            notices::show(Notice::new(ToastLevel::Error, message), cx);
        }
        if let Some(first) = marked.first() {
            cx.emit(OverleafBridgeEvent::OpenConflict(first.path.clone()));
        }
    }

    /// A sync failed: say so in the words that fit, or quietly owe it again
    /// for a brief outage in live mode.
    pub(super) fn failed(&mut self, error: String, options: SyncOptions, cx: &mut Context<Self>) {
        let refused = outcome::is_project_refusal(&error);
        if refused {
            self.refusals += 1;
        }
        let retryable = outcome::is_transient_transport_failure(&error)
            || (refused && self.refusals < outcome::REFUSAL_RETRIES);
        let this = cx.entity().downgrade();
        let sync_again = || {
            let this = this.clone();
            NoticeAction::new(t!("Sync again"), move |_, cx| {
                this.update(cx, |this, cx| this.sync(SyncOptions::default(), cx))
                    .ok();
            })
        };
        if options.automatic && retryable {
            // The live loop retries on its rate-limited cadence: retrying
            // now risks another 429, and a toast for a brief outage
            // interrupts work.
            self.transport_retry = true;
            log::warn!("Overleaf sync will be retried: {error}");
            return;
        }
        let notice = if outcome::is_signed_out(&error) {
            let this = this.clone();
            Notice::new(ToastLevel::Error, t!("Overleaf sync paused"))
                .detail(t!(
                    "Your Overleaf session ended. Your edits stay on this Mac until you sign in"
                ))
                .action(NoticeAction::new(
                    t!("Sign in to Overleaf"),
                    move |_, cx| {
                        this.update(cx, |_, cx| cx.emit(OverleafBridgeEvent::OpenSettings))
                            .ok();
                    },
                ))
        } else if refused {
            // Signed in, yet this project's requests keep being turned away:
            // most often a share that was removed.
            self.transport_retry = false;
            Notice::new(ToastLevel::Error, t!("Overleaf refused this project"))
                .detail(t!("You are still signed in. Check that the project still opens on Overleaf; your edits stay on this Mac"))
                .action(sync_again())
        } else if outcome::is_transient_transport_failure(&error) {
            Notice::new(ToastLevel::Error, t!("Couldn’t reach Overleaf"))
                .detail(t!("Your edits stay on this Mac until the next sync"))
                .action(sync_again())
        } else {
            Notice::new(
                ToastLevel::Error,
                t!("{action} failed", action = t!("Sync")),
            )
            .detail(error)
        };
        notices::show(notice.key(SYNC_KEY), cx);
    }
}
