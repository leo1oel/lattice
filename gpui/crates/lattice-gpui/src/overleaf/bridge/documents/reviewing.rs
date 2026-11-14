//! The two review actions that travel on the live channel as operations of
//! the open document, and so take its wire like typing does: anchoring a new
//! comment thread to a span, and rejecting suggestions (their inverse,
//! flagged `u` so Overleaf consumes them). Both need the document settled:
//! an operation built on a version Overleaf has not confirmed would be
//! refused, or worse, land in the wrong place.

use lattice_core::overleaf_rt::{OtOp, TrackedChange};

use super::*;

impl OverleafBridge {
    /// Anchor thread `thread_id` to `quote` at UTF-16 `position` of the live
    /// document `doc_id`; it shows at once, and Overleaf's answer comes as
    /// the operation's acknowledgement.
    pub(in crate::overleaf::bridge) fn anchor_comment(
        &mut self,
        doc_id: &str,
        thread_id: &str,
        position: i64,
        quote: &str,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let Some(client) = self.client.clone() else {
            return Err(not_live());
        };
        let live = self
            .documents
            .live
            .as_mut()
            .filter(|doc| doc.doc_id == doc_id)
            .ok_or_else(not_live)?;
        if live.send.is_some() {
            return Err(still_sending());
        }
        // An anchor is an operation like any other, so it needs the wire to
        // itself.
        let version = live.ot.anchor().ok_or_else(still_sending)?;
        live.ot.note_submitted(Some(&client.public_id()));
        let range = lattice_core::overleaf_rt::CommentRange {
            thread_id: thread_id.to_string(),
            position,
            quote: quote.to_string(),
        };
        self.review_event(
            RealtimeEvent::CommentAnchored {
                doc_id: doc_id.to_string(),
                range,
            },
            cx,
        );
        let (id, thread, quote) = (doc_id.to_string(), thread_id.to_string(), quote.to_string());
        let asked = client.clone();
        let sending = lattice_core::runtime::spawn(async move {
            asked
                .send_comment(&id, version, position, &quote, &thread)
                .await
        });
        let doc_id = doc_id.to_string();
        cx.spawn(async move |this, cx| {
            let sent = matches!(sending.await, Ok(Ok(())));
            if !sent && client.current_entities().is_some() {
                // Whether it landed is unknown: regular sync reconciles.
                this.update(cx, |this, cx| this.drop_live(&doc_id, None, cx))
                    .ok();
            }
        })
        .detach();
        Ok(())
    }

    /// Reject `changes` of the live document `doc_id` by undoing them: a
    /// suggested insertion's text removed, a suggested deletion's put back,
    /// from the end of the document backwards so one does not move the next.
    pub(in crate::overleaf::bridge) fn send_reject(
        &mut self,
        doc_id: &str,
        mut changes: Vec<TrackedChange>,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let live = self
            .documents
            .live
            .as_mut()
            .filter(|doc| doc.doc_id == doc_id)
            .ok_or_else(not_live)?;
        let panel = live.editor.upgrade().ok_or_else(not_live)?;
        if live.send.is_some() || !live.ot.settled() {
            return Err(still_sending());
        }
        let ops = reject_ops(&mut changes);
        let send = live.ot.local_ops(ops.clone()).ok_or_else(|| {
            t!("This suggestion no longer matches the text. Try again in a moment.").to_string()
        })?;
        if !panel.update(cx, |panel, cx| panel.take_overleaf_ops(&ops, cx)) {
            let notice = t!("This document drifted from Overleaf's copy, so live editing stopped. Syncing will reconcile it.").to_string();
            self.drop_live(doc_id, Some(notice), cx);
            return Ok(());
        }
        // The rejected suggestions go; the rest move with the text.
        let ids: Vec<String> = changes.into_iter().map(|change| change.id).collect();
        self.review_event(
            RealtimeEvent::ChangesAccepted {
                doc_id: doc_id.to_string(),
                change_ids: ids,
            },
            cx,
        );
        self.review_moved(doc_id, &ops, false, None, cx);
        self.send_ops(doc_id, send, Vec::new(), cx);
        Ok(())
    }
}

/// The inverse of `changes`, from the end of the document backwards. At one
/// position a suggested insertion goes before a deletion is put back, so a
/// replacement (both at the same place) undoes cleanly.
fn reject_ops(changes: &mut [TrackedChange]) -> Vec<OtOp> {
    changes.sort_by_key(|change| (std::cmp::Reverse(change.position), change.deletion));
    changes
        .iter()
        .map(|change| OtOp {
            p: change.position.max(0) as usize,
            i: change.deletion.then(|| change.text.clone()),
            d: (!change.deletion).then(|| change.text.clone()),
            u: Some(true),
        })
        .collect()
}

fn not_live() -> String {
    t!("The file is no longer open live with Overleaf. Try again.").to_string()
}

fn still_sending() -> String {
    t!("An edit is still on its way to Overleaf. Try again in a moment.").to_string()
}

#[cfg(test)]
mod tests {
    use lattice_core::overleaf_rt::{TrackedChange, ot::OtDocument};

    use super::reject_ops;

    fn change(id: &str, position: i64, text: &str, deletion: bool) -> TrackedChange {
        TrackedChange {
            id: id.into(),
            position,
            text: text.into(),
            deletion,
            user_id: None,
            timestamp: None,
            hue: 0,
        }
    }

    #[test]
    fn rejecting_a_replacement_restores_the_original_whichever_comes_first() {
        // "quick" replaced by "fast": the deletion and the insertion share
        // position 4, and the panel may list either first.
        for deletion_first in [true, false] {
            let mut changes = vec![change("d", 4, "quick", true), change("i", 4, "fast", false)];
            if !deletion_first {
                changes.reverse();
            }
            let mut doc = OtDocument::new("The fast fox", 1);
            assert!(doc.local_ops(reject_ops(&mut changes)).is_some());
            assert_eq!(doc.text(), "The quick fox");
        }
    }

    #[test]
    fn rejecting_several_works_from_the_end_backwards() {
        // "wide red fox" became "Big wide fox": "Big " suggested at 0 and
        // "red " suggested away at 9, listed front first.
        let mut changes = vec![change("a", 0, "Big ", false), change("b", 9, "red ", true)];
        let mut doc = OtDocument::new("Big wide fox", 1);
        assert!(doc.local_ops(reject_ops(&mut changes)).is_some());
        assert_eq!(doc.text(), "wide red fox");
    }
}
