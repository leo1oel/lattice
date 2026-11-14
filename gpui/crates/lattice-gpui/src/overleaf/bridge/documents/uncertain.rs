//! A send whose outcome is unknown with the channel still up
//! (`markOutcomeUnknown`, `reconcileUnknown` in `use-overleaf-realtime.ts`).
//!
//! A failed answer is not a rejection: Overleaf may have applied the
//! operation before the answer was lost, so the document is held, out of
//! regular sync's reach, and joined again from its version at once; the
//! replay (`resume`) says whether the edit landed, and a send still owed
//! goes again as a duplicate of any copy that did. The writer is told once
//! why the file is paused, and the toolbar's tooltip says it while the
//! file is shown.

use super::*;

impl OverleafBridge {
    /// Keep `doc_id`, whose last send has no proven outcome, away from
    /// regular sync, and ask Overleaf to replay what happened since its
    /// version (`markOutcomeUnknown`, `reconcileUnknown`).
    pub(in crate::overleaf::bridge) fn outcome_unknown(
        &mut self,
        doc_id: &str,
        reason: String,
        cx: &mut Context<Self>,
    ) {
        let doc = if let Some(doc) = self.documents.live.take_if(|doc| doc.doc_id == doc_id) {
            doc
        } else if let Some(at) = self
            .documents
            .leaving
            .iter()
            .position(|doc| doc.doc_id == doc_id)
        {
            self.documents.leaving.remove(at)
        } else {
            return;
        };
        let path = doc.path.clone();
        let mut doc = doc;
        // Typing still coalescing stays in the buffer, where the replay
        // picks it up.
        doc.send = None;
        doc.draining = None;
        self.documents.held.push(doc);
        let first = self.documents.uncertain.insert(doc_id.to_string());
        let message = unconfirmed_notice(&path, &reason);
        self.documents.detail = Some((path, message.clone().into()));
        if first {
            notices::show(
                Notice::new(ToastLevel::Warning, message).key("overleaf-live-doc"),
                cx,
            );
        }
        self.resume_held(cx);
        cx.notify();
    }
}

/// Why regular sync is paused on a file whose last send has no proven
/// outcome (`unconfirmedNotice`).
fn unconfirmed_notice(path: &str, detail: &str) -> String {
    if path.is_empty() {
        t!("Lattice could not confirm whether Overleaf accepted the latest edit to this file ({detail}). Syncing is paused for this file while Lattice checks.", detail = detail).to_string()
    } else {
        t!("Lattice could not confirm whether Overleaf accepted the latest edit to {path} ({detail}). Syncing is paused for this file while Lattice checks.", path = path, detail = detail).to_string()
    }
}
