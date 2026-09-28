//! Overleaf's live editing channel: one socket per project, the documents it
//! has joined, and the generation and receipt bookkeeping that keeps a late
//! connect, a stale React cleanup or a queued event from acting on the wrong
//! project.

use super::overleaf::overleaf_config_dir;
use super::{current_root, pinned_root, run_blocking, scoped_root};
use crate::app_state::{AppState, Lease, ProjectLease};
use crate::overleaf;
use crate::overleaf_rt::{self, RealtimeClient};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, Window};

#[derive(Default)]
pub(crate) struct OverleafRealtimeState {
    /// Advances whenever a connection is replaced or cancelled. A client that
    /// finishes connecting under an older generation must never become active.
    generation: u64,
    /// Project that owns both an in-progress and an established connection.
    root: Option<PathBuf>,
    client: Option<Arc<RealtimeClient>>,
    /// Documents currently joined on the socket. Sync snapshots this under
    /// the same lease that prevents a new join until the sync finishes.
    joined_paths: BTreeMap<String, String>,
    join_receipts: BTreeMap<String, String>,
}

impl OverleafRealtimeState {
    /// Start a new generation owned by `root` (or by nobody), handing back the
    /// connection it replaces.
    fn reset(&mut self, root: Option<PathBuf>) -> Option<Arc<RealtimeClient>> {
        self.generation = self.generation.wrapping_add(1);
        self.root = root;
        self.joined_paths.clear();
        self.join_receipts.clear();
        self.client.take()
    }

    fn begin(&mut self, root: PathBuf) -> (u64, Option<Arc<RealtimeClient>>) {
        let previous = self.reset(Some(root));
        (self.generation, previous)
    }

    fn owns(&self, generation: u64, root: &Path) -> bool {
        self.generation == generation && self.root.as_deref() == Some(root)
    }

    /// Whether `client` is still this project's live connection.
    fn is_current(&self, client: &Arc<RealtimeClient>) -> bool {
        self.client.as_ref().is_some_and(|current| Arc::ptr_eq(current, client))
    }

    pub(crate) fn extend_joined_paths(&self, root: &Path, paths: &mut BTreeSet<String>) {
        if self.root.as_deref() == Some(root) {
            paths.extend(self.joined_paths.values().cloned());
        }
    }

    /// Caller holds the exclusive sync lease and this state's mutex through
    /// persistence. Neither a queued stale leave nor reconnect can move a base.
    fn checkpoint_before_leave(
        &self, root: &Path, doc_id: &str, receipt: &str,
        checkpoint: Option<&overleaf::RealtimeCheckpoint>,
    ) -> Result<(), String> {
        if self.root.as_deref() != Some(root)
            || self.join_receipts.get(doc_id).map(String::as_str) != Some(receipt)
        {
            return Err(
                "The Overleaf document ownership changed before it could be released.".to_string()
            );
        }
        let path = self
            .joined_paths
            .get(doc_id)
            .ok_or_else(|| "The Overleaf document is no longer joined.".to_string())?;
        if let Some(checkpoint) = checkpoint {
            if checkpoint.version < 0 {
                return Err("Invalid Overleaf checkpoint version.".to_string());
            }
            overleaf::checkpoint_realtime_text(root, path, &checkpoint.text)?;
        }
        Ok(())
    }

    /// Cancel everything when `root` is `None`, or only the matching project's
    /// request when a stale React cleanup names its former root.
    pub(crate) fn cancel(&mut self, root: Option<&Path>) -> Option<Arc<RealtimeClient>> {
        if root.is_some() && self.root.as_deref() != root {
            return None;
        }
        self.reset(None)
    }
}

/// A channel event as the UI receives it. Cancellation cannot retract events
/// already queued for the UI, so each carries its source root and consumers
/// reject late delivery after the window has switched projects. `emit_to` alone
/// does not keep this out of other windows: Tauri also delivers it to every
/// untargeted listener, so the web UI must listen through
/// `listenOverleafRealtime`, which names its own window.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScopedEvent<'a> {
    project_root: &'a Path,
    #[serde(flatten)]
    event: overleaf_rt::RealtimeEvent,
}

const CONNECT_CHANGED: &str = "The project changed before Overleaf could connect.";

/// The live connection of the window's project.
pub(crate) fn realtime_client(
    state: &AppState, window: &Window,
) -> Result<Arc<RealtimeClient>, String> {
    let root = current_root(state, window)?;
    let project = state.project(&root);
    let realtime = project.realtime()?;
    if realtime.root.as_ref() != Some(&root) {
        return Err("The Overleaf live connection belongs to a different project.".to_string());
    }
    realtime
        .client
        .clone()
        .ok_or_else(|| "Not connected to Overleaf's live editing channel.".to_string())
}

/// The live connection of a pinned project, held under the shared sync lease
/// so an outgoing message cannot interleave with a full sync.
async fn live_client(
    state: &AppState, window: &Window, project_root: &str,
) -> Result<(Arc<RealtimeClient>, ProjectLease), String> {
    let lease = state.lease(project_root, Lease::Shared).await;
    scoped_root(state, window, project_root)?;
    Ok((realtime_client(state, window)?, lease))
}

/// Open the live editing channel for the current project.
///
/// Every event the channel produces is forwarded to the web UI as
/// `overleaf-realtime`, which is where documents, chat and comments all arrive.
#[tauri::command]
pub async fn overleaf_rt_connect(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = pinned_root(&state, &window, &project_root, "Overleaf could connect")?;
    let config_root = root.clone();
    let (host, cookie, project_id, user_id) =
        run_blocking("The Overleaf task", move || overleaf::realtime_config(&config, &config_root))
            .await?;

    // Project loading and credential reads are asynchronous. A connection
    // requested for A must not become the newest request after the UI has
    // already opened B.
    if current_root(&state, &window)? != root {
        return Err(CONNECT_CHANGED.to_string());
    }

    // Claim a generation before the network await. Compare the root while
    // still holding its guard, then take realtime in the same root→realtime
    // order as `set_root`. Otherwise a switch to B can land in the gap after a
    // successful check for A and let A become the newest live connection.
    let project = state.project(&root);
    let (generation, previous) = {
        let roots = state.roots()?;
        if roots.get(window.label()) != Some(&root) {
            return Err(CONNECT_CHANGED.to_string());
        }
        project.realtime()?.begin(root.clone())
    };
    if let Some(previous) = previous {
        previous.shutdown();
    }

    let event_state = Arc::clone(&project.realtime);
    let event_root = root.clone();
    let emit_label = window.label().to_string();
    let emitter = app.clone();
    let connecting = RealtimeClient::connect(
        overleaf_rt::RealtimeConfig { user_id, host, cookie, project_id },
        move |event| {
            if event_state.lock().is_ok_and(|realtime| realtime.owns(generation, &event_root)) {
                let event = ScopedEvent { project_root: &event_root, event };
                let _ = emitter.emit_to(emit_label.as_str(), "overleaf-realtime", event);
            }
        },
    )
    .await;
    let client = match connecting {
        Ok(client) => Arc::new(client),
        Err(error) => {
            if let Ok(mut realtime) = project.realtime.lock() {
                if realtime.owns(generation, &root) {
                    realtime.cancel(Some(&root));
                }
            }
            return Err(error);
        }
    };
    // Answering with the project tree, rather than only emitting it, is what
    // makes live editing reliable: the app can start the moment this returns
    // instead of depending on an event that may have been emitted before its
    // listener was registered.
    let tree = client.project();
    let mut joined = serde_json::to_value(tree).map_err(|error| error.to_string())?;
    joined["publicId"] = client.public_id().into();
    let mut installed = false;
    if current_root(&state, &window).is_ok_and(|current| current == root) {
        let mut realtime = project.realtime()?;
        if realtime.owns(generation, &root) {
            realtime.client = Some(Arc::clone(&client));
            installed = true;
        }
    }
    if !installed {
        client.shutdown();
        return Err("A newer Overleaf connection replaced this one.".to_string());
    }
    // `joinProject` is the only source for the root folder id required by the
    // REST uploader. Persist it before this command returns: the frontend marks
    // the channel live on return, and its first automatic sync may start in the
    // same render. The project lease serializes this write with any manual sync
    // that was already under way.
    let root_folder_id = tree.root_folder_id.clone();
    let permission = tree.permission.as_str().to_string();
    let _lease = ProjectLease::take(project, Lease::Exclusive).await;
    if current_root(&state, &window)? != root {
        return Err("The project changed before Overleaf could finish connecting.".to_string());
    }
    run_blocking("The Overleaf metadata update", move || {
        overleaf::set_realtime_metadata(&root, &root_folder_id, &permission)
    })
    .await?;
    Ok(joined)
}

#[tauri::command]
pub fn overleaf_rt_disconnect(
    state: State<'_, AppState>, window: Window, project_root: Option<String>,
) -> Result<(), String> {
    // A stale React cleanup names the project it was watching; anything else
    // means "disconnect the window I am in". Either way the cancel is addressed
    // to one project, so a second window's connection is left alone.
    let root = match project_root {
        Some(named) => PathBuf::from(named),
        None => match state.root_for(window.label())? {
            Some(root) => root,
            None => return Ok(()),
        },
    };
    let previous = state.project(&root).realtime()?.cancel(Some(&root));
    if let Some(previous) = previous {
        previous.shutdown();
    }
    Ok(())
}

/// Subscribe to a document; returns its current text and version.
///
/// `fromVersion` asks the server to replay what happened while we were away
/// instead of only handing back the current text, which is what lets work that
/// never reached it survive coming back to a file.
#[tauri::command]
pub async fn overleaf_rt_join_doc(
    state: State<'_, AppState>, window: Window, project_root: String, doc_id: String,
    from_version: Option<i64>, receipt: String,
) -> Result<overleaf_rt::JoinedDoc, String> {
    let lease = state.lease(&project_root, Lease::Exclusive).await;
    let root = scoped_root(&state, &window, &project_root)?;
    let client = realtime_client(&state, &window)?;
    let path = client
        .project()
        .docs
        .iter()
        .find(|doc| doc.id == doc_id)
        .map(|doc| doc.path.clone())
        .ok_or_else(|| "Overleaf did not report that document in this project.".to_string())?;
    let previous_path = {
        let mut realtime = lease.project.realtime()?;
        if realtime.root.as_ref() != Some(&root) || !realtime.is_current(&client) {
            return Err("The Overleaf project changed before the document joined.".to_string());
        }
        realtime.joined_paths.insert(doc_id.clone(), path)
    };
    match client.join_doc(&doc_id, from_version).await {
        Ok(joined) => {
            let mut realtime = lease.project.realtime()?;
            if !realtime.is_current(&client) {
                return Err("The Overleaf connection changed during the document join.".to_string());
            }
            realtime.join_receipts.insert(doc_id, receipt);
            Ok(joined)
        }
        Err(error) => {
            if let Ok(mut realtime) = lease.project.realtime.lock() {
                if realtime.is_current(&client) {
                    match previous_path {
                        Some(previous_path) => realtime.joined_paths.insert(doc_id, previous_path),
                        None => realtime.joined_paths.remove(&doc_id),
                    };
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn overleaf_rt_leave_doc(
    state: State<'_, AppState>, window: Window, project_root: String, doc_id: String,
    receipt: String, checkpoint: Option<overleaf::RealtimeCheckpoint>,
) -> Result<(), String> {
    let lease = state.lease(&project_root, Lease::Exclusive).await;
    let root = scoped_root(&state, &window, &project_root)?;
    let client = realtime_client(&state, &window)?;
    {
        // Connection begin/cancel also takes this mutex, even outside the sync
        // lease. Keep receipt validation and persistence indivisible with them.
        let realtime = lease.project.realtime()?;
        if !realtime.is_current(&client) {
            return Err(
                "The Overleaf document ownership changed before it could be released.".to_string()
            );
        }
        realtime.checkpoint_before_leave(&root, &doc_id, &receipt, checkpoint.as_ref())?;
    }
    client.leave_doc(&doc_id).await?;
    if let Ok(mut realtime) = lease.project.realtime.lock() {
        if realtime.is_current(&client) {
            realtime.joined_paths.remove(&doc_id);
            realtime.join_receipts.remove(&doc_id);
        }
    }
    Ok(())
}

/// Everyone currently in the Overleaf project, ourselves included.
#[tauri::command]
pub async fn overleaf_rt_connected_users(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<Vec<overleaf_rt::PresenceUser>, String> {
    let (client, _lease) = live_client(&state, &window, &project_root).await?;
    client.connected_users().await
}

/// Publish our caret, which is also what makes us visible to everyone else.
#[tauri::command]
pub async fn overleaf_rt_update_position(
    state: State<'_, AppState>, window: Window, project_root: String, doc_id: String, row: i64,
    column: i64,
) -> Result<(), String> {
    let (client, _lease) = live_client(&state, &window, &project_root).await?;
    client.update_position(&doc_id, row, column).await
}

#[tauri::command]
pub async fn overleaf_rt_send_ops(
    state: State<'_, AppState>, window: Window, project_root: String, doc_id: String, version: i64,
    ops: Vec<overleaf_rt::OtOp>,
) -> Result<(), String> {
    let (client, _lease) = live_client(&state, &window, &project_root).await?;
    client.send_ops(&doc_id, version, ops, false).await
}

/// Anchor a comment thread to a span of the open document.
// Overleaf's comment payload decides these arguments, and `window` on top of
// them is what scopes the call to one window's project. Grouping them into a
// struct would only move the same fields behind an extra IPC type.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn overleaf_rt_send_comment(
    state: State<'_, AppState>, window: Window, project_root: String, doc_id: String, version: i64,
    position: i64, quote: String, thread_id: String,
) -> Result<(), String> {
    let (client, _lease) = live_client(&state, &window, &project_root).await?;
    client.send_comment(&doc_id, version, position, &quote, &thread_id).await
}

/// Reject tracked changes by undoing them through the editing channel.
#[tauri::command]
pub async fn overleaf_reject_changes(
    state: State<'_, AppState>, window: Window, project_root: String, doc_id: String, version: i64,
    changes: Vec<overleaf_rt::TrackedChange>,
) -> Result<(), String> {
    let (client, _lease) = live_client(&state, &window, &project_root).await?;
    client.reject_changes(&doc_id, version, &changes).await
}

#[cfg(test)]
mod tests {
    use super::OverleafRealtimeState;
    use crate::overleaf::RealtimeCheckpoint;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    /// Also pins that a document the backend joined counts as live even when
    /// the UI's snapshot of joined paths is stale.
    #[test]
    fn realtime_checkpoint_rejects_stale_receipts_and_keeps_ownership_on_failure() {
        let mut state = OverleafRealtimeState::default();
        let root =
            std::env::temp_dir().join(format!("missing-checkpoint-{}", uuid::Uuid::new_v4()));
        let checkpoint = RealtimeCheckpoint { text: "human text".into(), version: 11 };
        let leave = |state: &OverleafRealtimeState, root: &Path, receipt: &str, text: bool| {
            state.checkpoint_before_leave(root, "doc", receipt, text.then_some(&checkpoint))
        };
        let join = |state: &mut OverleafRealtimeState, receipt: &str| {
            state.joined_paths.insert("doc".into(), "main.tex".into());
            state.join_receipts.insert("doc".into(), receipt.into());
        };
        state.begin(root.clone());
        join(&mut state, "replacement");
        assert!(leave(&state, &root, "stale", true).unwrap_err().contains("ownership changed"));
        assert!(leave(&state, Path::new("/wrong/root"), "replacement", false).is_err());
        assert!(leave(&state, &root, "replacement", true).is_err());
        assert!(!root.exists());
        let mut paths = BTreeSet::new();
        state.extend_joined_paths(&root, &mut paths);
        assert_eq!(paths, BTreeSet::from(["main.tex".into()]));
        assert!(leave(&state, &root, "replacement", false).is_ok());
        state.begin(root.clone());
        assert!(leave(&state, &root, "replacement", true).is_err());
        join(&mut state, "new-connection");
        state.cancel(Some(&root));
        assert!(leave(&state, &root, "new-connection", true).is_err());
    }

    #[test]
    fn a_late_connect_and_stale_cleanup_cannot_replace_the_new_project() {
        let mut state = OverleafRealtimeState::default();
        let root_a = PathBuf::from("/project/a");
        let root_b = PathBuf::from("/project/b");
        let (generation_a, _) = state.begin(root_a.clone());
        let (generation_b, _) = state.begin(root_b.clone());

        assert!(!state.owns(generation_a, &root_a));
        assert!(state.owns(generation_b, &root_b));
        assert!(state.cancel(Some(&root_a)).is_none());
        assert!(state.owns(generation_b, &root_b));
    }

    #[test]
    fn changing_the_app_root_invalidates_events_from_the_old_generation() {
        let mut state = OverleafRealtimeState::default();
        let root = PathBuf::from("/project/a");
        let (generation, _) = state.begin(root.clone());

        state.cancel(None);

        assert!(!state.owns(generation, &root));
        assert!(state.root.is_none());
    }
}
