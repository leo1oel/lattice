//! Overleaf's live editing channel as one project holds it: the socket, the
//! documents it has joined, and the generation and receipt bookkeeping that
//! keeps a late connect, a stale React cleanup or a queued event from acting
//! on the wrong project. The shell's realtime commands drive it.

use crate::overleaf;
use crate::overleaf_rt::RealtimeClient;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Default)]
pub struct OverleafRealtimeState {
    /// Advances whenever a connection is replaced or cancelled. A client that
    /// finishes connecting under an older generation must never become active.
    generation: u64,
    /// Project that owns both an in-progress and an established connection.
    pub root: Option<PathBuf>,
    pub client: Option<Arc<RealtimeClient>>,
    /// Documents currently joined on the socket. Sync snapshots this under
    /// the same lease that prevents a new join until the sync finishes.
    pub joined_paths: BTreeMap<String, String>,
    pub join_receipts: BTreeMap<String, String>,
    /// Overleaf's main document as this connection last reported it (the join,
    /// then each tree change), which `record_root_document` writes to the link.
    pub root_document: Option<String>,
}

impl OverleafRealtimeState {
    /// Start a new generation owned by `root` (or by nobody), handing back the
    /// connection it replaces.
    fn reset(&mut self, root: Option<PathBuf>) -> Option<Arc<RealtimeClient>> {
        self.generation = self.generation.wrapping_add(1);
        self.root = root;
        self.joined_paths.clear();
        self.join_receipts.clear();
        self.root_document = None;
        self.client.take()
    }

    pub fn begin(&mut self, root: PathBuf) -> (u64, Option<Arc<RealtimeClient>>) {
        let previous = self.reset(Some(root));
        (self.generation, previous)
    }

    pub fn owns(&self, generation: u64, root: &Path) -> bool {
        self.generation == generation && self.root.as_deref() == Some(root)
    }

    /// Whether `client` is still this project's live connection.
    pub fn is_current(&self, client: &Arc<RealtimeClient>) -> bool {
        self.client.as_ref().is_some_and(|current| Arc::ptr_eq(current, client))
    }

    pub fn extend_joined_paths(&self, root: &Path, paths: &mut BTreeSet<String>) {
        if self.root.as_deref() == Some(root) {
            paths.extend(self.joined_paths.values().cloned());
        }
    }

    /// Caller holds the exclusive sync lease and this state's mutex through
    /// persistence. Neither a queued stale leave nor reconnect can move a base.
    pub fn checkpoint_before_leave(
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
    pub fn cancel(&mut self, root: Option<&Path>) -> Option<Arc<RealtimeClient>> {
        if root.is_some() && self.root.as_deref() != root {
            return None;
        }
        self.reset(None)
    }
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
    fn stale_connects_cleanups_and_root_changes_cannot_act_for_the_current_project() {
        let mut state = OverleafRealtimeState::default();
        let (root_a, root_b) = (PathBuf::from("/project/a"), PathBuf::from("/project/b"));
        let (generation_a, _) = state.begin(root_a.clone());
        let (generation_b, _) = state.begin(root_b.clone());

        // A late connect or stale cleanup for the old project changes nothing.
        assert!(!state.owns(generation_a, &root_a));
        assert!(state.cancel(Some(&root_a)).is_none());
        assert!(state.owns(generation_b, &root_b));

        // Changing the app root invalidates events from the old generation.
        state.cancel(None);
        assert!(!state.owns(generation_b, &root_b));
        assert!(state.root.is_none());
    }
}
