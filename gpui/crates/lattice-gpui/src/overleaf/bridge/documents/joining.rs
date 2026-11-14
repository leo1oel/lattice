//! Joining the shown document, as `use-overleaf-realtime.ts` joins it.
//!
//! The join is a round trip, and the writer may move on before Overleaf
//! answers: the target is kept, so a switch (or live mode going off) is seen
//! while the join is out, and a join answered after the writer moved on
//! leaves the document again, or its room stays subscribed. Updates can
//! arrive between Overleaf's answer and it being taken in here; they wait in
//! `early` and are replayed over the snapshot.

use std::sync::Arc;

use lattice_core::overleaf_rt::{JoinedDoc, RealtimeClient};

use super::*;

/// A join waiting on Overleaf's answer.
pub(in crate::overleaf::bridge) struct Joining {
    generation: u64,
    pub(super) editor: WeakEntity<EditorPanel>,
    pub(super) doc_id: String,
}

impl OverleafBridge {
    pub(super) fn join(
        &mut self,
        editor: WeakEntity<EditorPanel>,
        path: String,
        doc_id: String,
        cx: &mut Context<Self>,
    ) {
        let (Some(client), Some(root)) = (self.client.clone(), self.root.clone()) else {
            return;
        };
        self.documents.join_generation += 1;
        let generation = self.documents.join_generation;
        self.documents.joining = Some(Joining {
            generation,
            editor: editor.clone(),
            doc_id: doc_id.clone(),
        });
        let id = doc_id.clone();
        let asked = client.clone();
        let joining = lattice_core::runtime::spawn(async move { asked.join_doc(&id, None).await });
        let agreed_path = path.clone();
        let agreed =
            cx.background_spawn(
                async move { lattice_core::overleaf::agreed_text(&root, &agreed_path) },
            );
        cx.spawn(async move |this, cx| {
            let joined = joining.await;
            let agreed = agreed.await;
            this.update(cx, |this, cx| {
                let Ok(Ok(joined)) = joined else {
                    if this.joining_is(generation) {
                        this.documents.joining = None;
                        this.take_early(&doc_id);
                    }
                    return;
                };
                let still_wanted = this.joining_is(generation)
                    && this
                        .wanted_live(cx)
                        .is_some_and(|(wanted, _, id)| wanted == editor && id == doc_id);
                if !still_wanted {
                    if this.joining_is(generation) {
                        this.documents.joining = None;
                        this.take_early(&doc_id);
                    }
                    if !this.doc_in_use(&doc_id) {
                        leave_room(client, &doc_id);
                    }
                    return;
                }
                this.documents.joining = None;
                this.joined(editor, path, doc_id, joined, agreed, cx);
            })
            .ok();
        })
        .detach();
    }

    fn joining_is(&self, generation: u64) -> bool {
        self.documents
            .joining
            .as_ref()
            .is_some_and(|joining| joining.generation == generation)
    }

    /// The join answered and is still wanted: reconcile the buffer with
    /// Overleaf's text and go live, then replay what arrived meanwhile.
    fn joined(
        &mut self,
        editor: WeakEntity<EditorPanel>,
        path: String,
        doc_id: String,
        joined: JoinedDoc,
        agreed: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let early = self.take_early(&doc_id);
        let Some(panel) = editor.upgrade() else {
            self.release_doc(&doc_id);
            return;
        };
        let buffer = panel.read(cx).overleaf_text(cx);
        let mut ot = OtDocument::new(joined.text.clone(), joined.version);
        self.review_doc_joined(&doc_id, joined.comments.clone(), joined.changes.clone());
        let mut typed_ops = Vec::new();
        let send = if buffer == joined.text {
            None
        } else if agreed.as_deref() == Some(joined.text.as_str()) {
            // Overleaf has not moved since the last sync: the buffer's
            // difference is typing that has not reached it.
            let typed = ot.local(&buffer);
            if typed.replaced {
                panel.update(cx, |panel, cx| panel.take_overleaf_text(ot.text(), cx));
            }
            typed_ops = typed.ops;
            typed.send
        } else if agreed.as_deref() == Some(buffer.as_str()) {
            // Only Overleaf moved: take its text.
            panel.update(cx, |panel, cx| panel.take_overleaf_text(&joined.text, cx));
            None
        } else {
            // Both moved: regular sync merges it.
            self.review_doc_left(&doc_id);
            self.release_doc(&doc_id);
            self.documents.suspended.insert(path);
            self.sync(
                SyncOptions {
                    automatic: true,
                    ..Default::default()
                },
                cx,
            );
            return;
        };
        self.documents.live = Some(LiveDoc {
            path,
            doc_id: doc_id.clone(),
            editor,
            ot,
            send: None,
            draining: None,
            hashed_at: None,
        });
        self.review_moved(&doc_id, &typed_ops, true, None, cx);
        if let Some(send) = send {
            self.send_ops(&doc_id, send, Vec::new(), cx);
        }
        self.replay_early(early, cx);
        cx.notify();
    }

    /// The updates for `doc_id` kept while it was being joined.
    pub(super) fn take_early(&mut self, doc_id: &str) -> Vec<RealtimeEvent> {
        let (kept, rest) = std::mem::take(&mut self.documents.early)
            .into_iter()
            .partition(|event| {
                matches!(event, RealtimeEvent::DocUpdate { doc_id: id, .. } if id == doc_id)
            });
        self.documents.early = rest;
        kept
    }

    /// Take in updates that arrived while their document was being joined;
    /// those the snapshot already holds are skipped by version.
    pub(super) fn replay_early(&mut self, early: Vec<RealtimeEvent>, cx: &mut Context<Self>) {
        for event in early {
            self.document_event(event, cx);
        }
    }

    /// An update for a document whose join is out: kept for the replay.
    pub(super) fn keep_early(&mut self, event: &RealtimeEvent) {
        let RealtimeEvent::DocUpdate { doc_id, .. } = event else {
            return;
        };
        let joining = self
            .documents
            .joining
            .as_ref()
            .is_some_and(|joining| &joining.doc_id == doc_id);
        let resuming = self.documents.resuming.is_some()
            && self.documents.held.iter().any(|doc| &doc.doc_id == doc_id);
        if joining || resuming {
            self.documents.early.push(event.clone());
        }
    }

    /// `doc_id` is live, left and draining, held, or being joined.
    pub(super) fn doc_in_use(&self, doc_id: &str) -> bool {
        self.documents
            .live
            .iter()
            .chain(&self.documents.leaving)
            .chain(&self.documents.held)
            .any(|doc| doc.doc_id == doc_id)
            || self
                .documents
                .joining
                .as_ref()
                .is_some_and(|joining| joining.doc_id == doc_id)
    }
}

/// Leave `doc_id`'s room on `client`'s connection.
pub(super) fn leave_room(client: Arc<RealtimeClient>, doc_id: &str) {
    let doc_id = doc_id.to_string();
    lattice_core::runtime::spawn(async move {
        client.leave_doc(&doc_id).await.ok();
    });
}
