//! Carrying a document across a dropped channel, as Overleaf's own editor
//! does (`use-overleaf-realtime.ts`, `resendAfterReplay`).
//!
//! A document whose operation was unanswered when the channel dropped is
//! held, still out of regular sync's reach, since that operation may have
//! landed. Once the channel is back it is joined from the version it had
//! reached, and Overleaf replays what happened since: the writer's typing
//! meanwhile goes in first, so the replay is transformed against it; our own
//! update in the replay is the acknowledgement that went missing; and an
//! operation still unanswered after the replay never landed, so it is sent
//! again, naming the connections it went out on, so Overleaf acknowledges a
//! copy that did land after all instead of applying it twice.
//!
//! A document that cannot be carried on (Overleaf will not reach back that
//! far, the replay does not fit, its editor closed) goes back to regular
//! sync, which merges it through the copy the last sync agreed on.

use lattice_core::overleaf_rt::{
    JoinedDoc,
    ot::{OtSend, Replayed},
};

use super::*;

impl OverleafBridge {
    /// The channel is back: join each held document from its version.
    pub(in crate::overleaf::bridge) fn resume_held(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.documents.held.is_empty() {
            return;
        }
        let wanted: Vec<(String, i64)> = self
            .documents
            .held
            .iter()
            .map(|doc| (doc.doc_id.clone(), doc.ot.version()))
            .collect();
        let joining = lattice_core::runtime::spawn(async move {
            let mut joined = Vec::new();
            for (doc_id, version) in wanted {
                let answer = client.join_doc(&doc_id, Some(version)).await;
                joined.push((doc_id, answer));
            }
            joined
        });
        self.documents.resuming = Some(cx.spawn(async move |this, cx| {
            let Ok(joined) = joining.await else {
                return;
            };
            this.update(cx, |this, cx| {
                this.documents.resuming = None;
                for (doc_id, answer) in joined {
                    this.resumed(&doc_id, answer, cx);
                }
                this.reconsider_live(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// `doc_id`'s join from its version answered: carry on with it, or hand
    /// it to regular sync.
    fn resumed(&mut self, doc_id: &str, answer: Result<JoinedDoc, String>, cx: &mut Context<Self>) {
        let Some(at) = self
            .documents
            .held
            .iter()
            .position(|doc| doc.doc_id == doc_id)
        else {
            return;
        };
        let mut doc = self.documents.held.remove(at);
        let Some(own) = self.client.as_ref().map(|client| client.public_id()) else {
            return self.give_up(doc, "the channel is gone again", cx);
        };
        let joined = match answer {
            Ok(joined) if joined.resumed => joined,
            Ok(_) => return self.give_up(doc, "Overleaf would not replay that far", cx),
            Err(error) => return self.give_up(doc, &error, cx),
        };
        let Some(panel) = doc.editor.upgrade() else {
            return self.give_up(doc, "its editor closed", cx);
        };
        // Typing meanwhile joins the work queued behind the operation in
        // flight, so the replay is transformed against all of it.
        let buffer = panel.read(cx).overleaf_text(cx);
        let typed = doc.ot.local(&buffer);
        if typed.send.is_some() {
            // Only a settled document sends at once, and none is held.
            return self.give_up(doc, "nothing was in flight", cx);
        }
        if typed.replaced {
            panel.update(cx, |panel, cx| panel.take_overleaf_text(doc.ot.text(), cx));
        }
        let replayed: Vec<Replayed> = joined
            .caught_up
            .iter()
            .map(|update| Replayed {
                version: update.version,
                ops: update.ops.clone(),
                mine: update.source.as_deref().is_some_and(|source| {
                    source == own || doc.ot.submitted_via().iter().any(|id| id == source)
                }),
            })
            .collect();
        let (applied, mut send) = match doc.ot.catch_up(&replayed) {
            Ok(caught_up) => caught_up,
            Err(desync) => return self.give_up(doc, &desync.to_string(), cx),
        };
        if doc.ot.version() != joined.version {
            return self.give_up(doc, "the replay left a gap", cx);
        }
        if !applied.is_empty()
            && !panel.update(cx, |panel, cx| panel.take_overleaf_ops(&applied, cx))
        {
            return self.give_up(doc, "the replay does not fit the buffer", cx);
        }
        // Still unanswered after the replay: it never landed, so it goes
        // again, as a duplicate of any copy that did land meanwhile.
        let mut dup_if_source = Vec::new();
        if send.is_none()
            && !doc.ot.settled()
            && let Some(resend) = doc.ot.resend()
        {
            dup_if_source = resend.dup_if_source;
            send = Some(OtSend {
                version: resend.version,
                ops: resend.ops,
            });
        }
        let shown = self.documents.shown.as_ref() == Some(&doc.editor);
        if shown && self.documents.live.is_none() {
            self.documents.live = Some(doc);
        } else {
            self.leave(doc, cx);
        }
        if let Some(send) = send {
            self.send_ops(doc_id, send, dup_if_source, cx);
        }
    }

    /// `doc` cannot be carried on: regular sync merges it.
    fn give_up(&mut self, doc: LiveDoc, why: &str, cx: &mut Context<Self>) {
        log::warn!(
            "{} goes back to regular sync after the reconnect: {why}",
            doc.path
        );
        self.release_doc(&doc.doc_id, None);
        self.documents.suspended.insert(doc.path);
        self.sync(
            SyncOptions {
                automatic: true,
                ..Default::default()
            },
            cx,
        );
    }
}
