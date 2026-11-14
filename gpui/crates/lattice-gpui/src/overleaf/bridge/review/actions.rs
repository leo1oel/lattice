//! What the writer does to review (`use-overleaf-comments.ts`,
//! `use-overleaf-track-changes.ts`): a new comment, a reply, an edit or a
//! delete of their own message, resolving, reopening or deleting a thread,
//! and accepting or rejecting suggestions.
//!
//! The REST actions run off the app thread and end in a fresh read of the
//! threads; a failure is said in the review panels (`review_error`). A new
//! comment is posted first and anchored after, as Overleaf's own editor
//! does: a thread with a message and no anchor is one the panel lists as no
//! longer in the document, while an anchor with no thread shows nothing.

use std::path::Path;

use lattice_core::overleaf_rt::tracked;

use super::*;

impl OverleafBridge {
    /// Run `work` (a REST call) for `busy` (a thread or change id, "all"),
    /// then read the threads again; `after` runs on success.
    fn review_rest(
        &mut self,
        busy: String,
        work: impl FnOnce(&Path, &Path) -> Result<(), String> + Send + 'static,
        after: impl FnOnce(&mut Self, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.review.busy = Some(busy);
        self.review.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let done = cx
                .background_spawn(async move { work(&super::super::super::config_dir(), &root) })
                .await;
            this.update(cx, |this, cx| {
                this.review.busy = None;
                match done {
                    Ok(()) => after(this, cx),
                    Err(error) => {
                        let (error, _) = super::super::super::settled::<()>(Err(error));
                        this.review.error = error.err().map(SharedString::from);
                    }
                }
                this.reread_threads(Duration::ZERO, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The document a thread is anchored in, for the endpoints keyed by it.
    fn thread_doc(&self, thread_id: &str) -> Result<String, String> {
        let live = self.review.docs.iter().find_map(|(doc_id, review)| {
            review
                .comments
                .iter()
                .any(|comment| comment.thread_id == thread_id)
                .then(|| doc_id.clone())
        });
        live.or_else(|| {
            self.review
                .anchors
                .iter()
                .find(|anchor| anchor.thread_id == thread_id)
                .map(|anchor| anchor.doc_id.clone())
        })
        .ok_or_else(|| {
            t!("This comment is no longer attached to any text, so Overleaf has nowhere to apply this.").to_string()
        })
    }

    fn refuse(&mut self, error: String, cx: &mut Context<Self>) {
        self.review.error = Some(error.into());
        cx.notify();
    }

    /// Reply `content` to a thread; `done` runs once Overleaf has it.
    pub fn reply_to_thread(
        &mut self,
        thread_id: &str,
        content: String,
        done: impl FnOnce(&mut gpui::App) + 'static,
        cx: &mut Context<Self>,
    ) {
        let thread = thread_id.to_string();
        self.review_rest(
            thread_id.to_string(),
            move |config, root| {
                lattice_core::overleaf::reply_to_thread(config, root, &thread, &content)
            },
            |_, cx| done(cx),
            cx,
        );
    }

    pub fn edit_message(
        &mut self,
        thread_id: &str,
        message_id: &str,
        content: String,
        done: impl FnOnce(&mut gpui::App) + 'static,
        cx: &mut Context<Self>,
    ) {
        let (thread, message) = (thread_id.to_string(), message_id.to_string());
        self.review_rest(
            thread_id.to_string(),
            move |config, root| {
                lattice_core::overleaf::edit_message(config, root, &thread, &message, &content)
            },
            |_, cx| done(cx),
            cx,
        );
    }

    pub fn delete_message(&mut self, thread_id: &str, message_id: &str, cx: &mut Context<Self>) {
        let (thread, message) = (thread_id.to_string(), message_id.to_string());
        self.review_rest(
            thread_id.to_string(),
            move |config, root| {
                lattice_core::overleaf::delete_message(config, root, &thread, &message)
            },
            |_, _| {},
            cx,
        );
    }

    pub fn set_thread_resolved(&mut self, thread_id: &str, resolved: bool, cx: &mut Context<Self>) {
        let doc = match self.thread_doc(thread_id) {
            Ok(doc) => doc,
            Err(error) => return self.refuse(error, cx),
        };
        let thread = thread_id.to_string();
        self.review_rest(
            thread_id.to_string(),
            move |config, root| {
                lattice_core::overleaf::resolve_thread(config, root, &doc, &thread, resolved)
            },
            |_, _| {},
            cx,
        );
    }

    pub fn delete_thread(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        let doc = match self.thread_doc(thread_id) {
            Ok(doc) => doc,
            Err(error) => return self.refuse(error, cx),
        };
        let thread = thread_id.to_string();
        let gone = thread.clone();
        self.review_rest(
            thread_id.to_string(),
            move |config, root| lattice_core::overleaf::delete_thread(config, root, &doc, &thread),
            move |this, _| {
                for review in this.review.docs.values_mut() {
                    review.comments.retain(|comment| comment.thread_id != gone);
                }
            },
            cx,
        );
    }

    /// Start a thread on UTF-16 `from..to` of the live document `path`,
    /// saying `content`; `done` runs once Overleaf has its message.
    pub fn add_comment(
        &mut self,
        path: &str,
        from: i64,
        quote: String,
        content: String,
        done: impl FnOnce(&mut gpui::App) + 'static,
        cx: &mut Context<Self>,
    ) {
        let doc_id = match self.doc_of_path(path) {
            Some(doc_id) if self.live_file() == Some(path) => doc_id,
            _ => {
                let error =
                    t!("The commented file is no longer open live with Overleaf. Try again.");
                return self.refuse(error.to_string(), cx);
            }
        };
        if content.trim().is_empty() || quote.is_empty() {
            return;
        }
        let thread_id = object_id();
        let thread = thread_id.clone();
        self.review_rest(
            thread_id.clone(),
            move |config, root| {
                lattice_core::overleaf::reply_to_thread(config, root, &thread, &content)
            },
            move |this, cx| {
                if let Err(error) = this.anchor_comment(&doc_id, &thread_id, from, &quote, cx) {
                    this.review.error = Some(error.into());
                }
                done(cx);
            },
            cx,
        );
    }

    /// Accept the live document's suggestions `ids` (Overleaf's endpoint;
    /// the text does not change).
    pub fn accept_changes(&mut self, path: &str, ids: Vec<String>, cx: &mut Context<Self>) {
        let Some((doc_id, review)) = self
            .doc_of_path(path)
            .and_then(|doc_id| Some((doc_id.clone(), self.review.docs.get(&doc_id)?)))
        else {
            return;
        };
        let provisional = review
            .changes
            .iter()
            .any(|change| ids.contains(&change.id) && tracked::is_provisional(change));
        if provisional || self.settled_version(&doc_id).is_none() {
            let error =
                t!("An edit is still on its way to Overleaf. Try accepting again in a moment.");
            return self.refuse(error.to_string(), cx);
        }
        let busy = if ids.len() > 1 {
            "all".to_string()
        } else {
            ids.concat()
        };
        let (doc, accepted) = (doc_id.clone(), ids.clone());
        self.review_rest(
            busy,
            move |config, root| lattice_core::overleaf::accept_changes(config, root, &doc, &ids),
            move |this, cx| {
                this.review_event(
                    RealtimeEvent::ChangesAccepted {
                        doc_id,
                        change_ids: accepted,
                    },
                    cx,
                )
            },
            cx,
        );
    }

    /// Reject the live document's suggestions `ids`.
    pub fn reject_changes(&mut self, path: &str, ids: Vec<String>, cx: &mut Context<Self>) {
        let Some(doc_id) = self.doc_of_path(path) else {
            return;
        };
        let Some(review) = self.review.docs.get(&doc_id) else {
            return;
        };
        let changes: Vec<_> = review
            .changes
            .iter()
            .filter(|change| ids.contains(&change.id))
            .cloned()
            .collect();
        if changes.iter().any(tracked::is_provisional) {
            let error = t!("An edit is still on its way to Overleaf. Try again in a moment.");
            return self.refuse(error.to_string(), cx);
        }
        self.review.error = None;
        if let Err(error) = self.send_reject(&doc_id, changes, cx) {
            self.refuse(error, cx);
        }
    }
}

/// A new thread's id, minted here as Overleaf's own editor mints it: a
/// 24-hex-digit Mongo ObjectId (seconds since the epoch, then random).
fn object_id() -> String {
    let seconds = chrono::Utc::now().timestamp().max(0) as u32;
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("{seconds:08x}{}", &random[..16])
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_thread_id_is_a_24_digit_object_id() {
        let id = super::object_id();
        assert_eq!(id.len(), 24);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id, super::object_id());
    }
}
