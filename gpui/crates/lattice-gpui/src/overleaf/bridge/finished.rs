//! What a finished sync leaves the writer to know or do
//! (`reportSyncOutcome`): the summary toast, its warnings and conflicts, the
//! version it records, and, for a failure, the words that fit or a quiet
//! retry. Every sync is also one operation in the app's log, quiet no-ops
//! and cancellations included, so a gap in sync history is explained.

use serde_json::json;

use super::*;
use crate::app_log::trace::Trace;

/// End a sync's operation in the log: its counts, then the summary, or the
/// failure under the words its notice uses (`runOverleafSync`'s trace).
pub(super) fn trace_outcome(
    trace: &mut Trace,
    result: &Result<OverleafSyncResult, String>,
    options: &SyncOptions,
    cx: &mut App,
) {
    match result {
        Ok(result) => {
            trace.enrich([
                ("automatic", json!(options.automatic)),
                ("pulled", json!(result.pulled.len())),
                ("pushed", json!(result.pushed.len())),
                ("merged", json!(result.merged.len())),
                ("conflicts", json!(result.conflicts.len())),
                ("deleted_local", json!(result.deleted_local.len())),
                ("read_only", json!(result.read_only)),
            ]);
            trace.finish("success", Some(outcome::summary(result)), cx);
        }
        Err(error) => {
            let refused = outcome::is_project_refusal(error);
            let transient = outcome::is_transient_transport_failure(error);
            if options.automatic && (transient || refused) {
                trace.enrich([("retry_scheduled", json!(true))]);
            }
            let title = if outcome::is_signed_out(error) {
                t!("Overleaf sync paused").to_string()
            } else if refused {
                t!("Overleaf refused this project").to_string()
            } else if transient {
                t!("Couldn’t reach Overleaf").to_string()
            } else {
                t!("{action} failed", action = t!("Sync")).to_string()
            };
            trace.fail(title, error, cx);
        }
    }
}

impl OverleafBridge {
    /// Drop the running sync, ending its operation in the log as cancelled.
    pub(super) fn cancel_sync(&mut self, cx: &mut Context<Self>) {
        self.sync_task = None;
        if let Some(mut trace) = self.sync_trace.take() {
            trace.finish(
                "cancelled",
                Some(t!("Overleaf sync cancelled").to_string()),
                cx,
            );
        }
    }

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
        crate::agent::host_writes::note(&root, crate::agent::host_writes::sync_writes(&result), cx);
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

    /// Say which files a sync left in conflict, and open the first that has
    /// markers in it in the editor, where each spot carries its own choices
    /// (`reportSyncOutcome`). A later write can have settled one already, so
    /// each is read back first. A binary file names the copy it kept, with
    /// the action that puts the other one back.
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
        let message = outcome::conflict_message(&marked);
        if !message.is_empty() {
            notices::show(Notice::new(ToastLevel::Error, message), cx);
        }
        for conflict in result.conflicts.iter().filter(|conflict| !conflict.markers) {
            let (message, label) = outcome::binary_conflict(conflict);
            let (root, set_aside, path) = (
                root.to_path_buf(),
                conflict.set_aside.clone(),
                conflict.path.clone(),
            );
            let action = NoticeAction::new(label, move |_, cx| {
                if let Err(error) =
                    lattice_core::overleaf::restore_set_aside(&root, &set_aside, &path)
                {
                    notices::error(t!("Could not restore the file"), error, cx);
                }
            });
            notices::show(Notice::new(ToastLevel::Warning, message).action(action), cx);
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
