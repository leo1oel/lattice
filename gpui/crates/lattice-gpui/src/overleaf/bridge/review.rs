//! Review on a linked Overleaf project: its comment threads and its
//! suggestions ("tracked changes"), the Tauri app's `use-overleaf-comments.ts`,
//! `use-overleaf-track-changes.ts` and `use-open-doc-review.ts`.
//!
//! The conversation lives behind REST (`lattice_core::overleaf::threads`, and
//! where each thread is anchored, `comment_anchors`), re-read whole whenever
//! the channel says a thread changed: Overleaf spreads thread state over six
//! socket events, and rebuilding it from them is how a panel drifts from the
//! browser. The live document's own comments and suggestions come with its
//! join and ride along on every operation that moves its text
//! (`lattice_core::overleaf_rt::tracked`), ours and everyone else's; what an
//! edit sent as a suggestion makes of them is worked out here, provisionally,
//! and replaced by Overleaf's own ranges once the document is quiet.
//!
//! Whether typing goes out as suggestions is Overleaf's setting, followed
//! here, never set: the project's track-changes state for this account, or
//! always for an account that may only review.

use std::collections::HashMap;
use std::time::Duration;

use lattice_core::overleaf::{OverleafCommentAnchor, OverleafThread};
use lattice_core::overleaf_rt::{
    CommentRange, OtOp, Permission, Suggester, TrackedChange, tracked,
};

use super::*;

mod actions;

/// Threads are re-read this long after the last event that changed one.
const REREAD_AFTER: Duration = Duration::from_millis(400);
/// Provisional suggestions are swapped for Overleaf's once the document has
/// been quiet this long.
const SUGGESTIONS_REFRESH: Duration = Duration::from_millis(1500);

/// The live document's comments and suggestions, in UTF-16 units of its
/// text as it reads here.
#[derive(Clone, Debug, Default)]
pub struct DocReview {
    pub comments: Vec<CommentRange>,
    pub changes: Vec<TrackedChange>,
}

#[derive(Default)]
pub(super) struct ReviewState {
    threads: Vec<OverleafThread>,
    anchors: Vec<OverleafCommentAnchor>,
    /// Threads have been read at least once for this project.
    loaded: bool,
    error: Option<SharedString>,
    read_generation: u64,
    reading: Option<Task<()>>,
    /// Joined documents' review, by document id.
    docs: HashMap<String, DocReview>,
    /// Overleaf's track-changes setting for this account.
    track_changes: bool,
    permission: Option<Permission>,
    user_id: Option<String>,
    /// Suggestion authors' names, by Overleaf user id.
    authors: HashMap<String, String>,
    /// What an action is waiting on: a change id, a thread id, or "all".
    busy: Option<String>,
    refresh: Option<Task<()>>,
}

impl OverleafBridge {
    /// Every comment thread in the project, newest conversation first.
    pub fn threads(&self) -> &[OverleafThread] {
        &self.review.threads
    }

    /// Where each thread is anchored, by document (REST's view; the live
    /// document's own ranges are newer, see [`Self::comments_in`]).
    pub fn anchors(&self) -> &[OverleafCommentAnchor] {
        &self.review.anchors
    }

    /// Threads are still being read for the first time.
    pub fn comments_loading(&self) -> bool {
        !self.review.loaded && self.review.reading.is_some()
    }

    /// The last review action's or read's failure, worded for the writer.
    pub fn review_error(&self) -> Option<&SharedString> {
        self.review.error.as_ref()
    }

    pub fn review_busy(&self) -> Option<&str> {
        self.review.busy.as_deref()
    }

    /// May this account accept or reject suggestions, and comment?
    pub fn can_review(&self) -> bool {
        self.review.permission.is_some_and(Permission::can_write)
    }

    /// Typing goes out as suggestions.
    pub fn tracking(&self) -> bool {
        self.review.track_changes || self.review.permission == Some(Permission::Review)
    }

    /// A suggestion author's name, when Overleaf has told us.
    pub fn author_name(&self, user_id: Option<&str>) -> Option<&str> {
        self.review.authors.get(user_id?).map(String::as_str)
    }

    /// Where thread `thread_id` is anchored: its file (none when Overleaf
    /// names a document this project does not know), UTF-16 position and
    /// quote; the live document's own ranges are the newest. None when its
    /// passage was deleted from the document.
    pub fn thread_anchor(&self, thread_id: &str) -> Option<(Option<String>, i64, String)> {
        let live = self.review.docs.iter().find_map(|(doc_id, review)| {
            let range = review
                .comments
                .iter()
                .find(|comment| comment.thread_id == thread_id)?;
            Some((doc_id.clone(), range.position, range.quote.clone()))
        });
        let (doc_id, position, quote) = live.or_else(|| {
            let anchor = self
                .review
                .anchors
                .iter()
                .find(|anchor| anchor.thread_id == thread_id)?;
            Some((anchor.doc_id.clone(), anchor.position, anchor.quote.clone()))
        })?;
        Some((self.path_of_doc(&doc_id), position, quote))
    }

    /// The hue of a suggestion author named `name`, from the joined
    /// documents' suggestions.
    pub fn suggestion_hue_of(&self, name: &str) -> Option<u32> {
        self.review
            .docs
            .values()
            .flat_map(|review| &review.changes)
            .find(|change| self.author_name(change.user_id.as_deref()) == Some(name))
            .map(|change| change.hue)
    }

    /// The live document's comments and suggestions, if it is `path`.
    pub fn live_review(&self, path: &str) -> Option<&DocReview> {
        let doc_id = self.doc_of_path(path)?;
        (self.live_file() == Some(path))
            .then(|| self.review.docs.get(&doc_id))
            .flatten()
    }

    /// The comment threads anchored in `path`: the live document's own
    /// ranges when it is live, REST's anchors otherwise, each with its
    /// thread, unresolved ones only.
    pub fn comments_in(&self, path: &str) -> Vec<(CommentRange, &OverleafThread)> {
        let thread = |id: &str| {
            self.review
                .threads
                .iter()
                .find(|thread| thread.id == id && !thread.resolved)
        };
        if let Some(review) = self.live_review(path) {
            return review
                .comments
                .iter()
                .filter_map(|range| Some((range.clone(), thread(&range.thread_id)?)))
                .collect();
        }
        let Some(doc_id) = self.doc_of_path(path) else {
            return Vec::new();
        };
        self.review
            .anchors
            .iter()
            .filter(|anchor| anchor.doc_id == doc_id)
            .filter_map(|anchor| {
                let range = CommentRange {
                    thread_id: anchor.thread_id.clone(),
                    position: anchor.position,
                    quote: anchor.quote.clone(),
                };
                Some((range, thread(&anchor.thread_id)?))
            })
            .collect()
    }

    /// The channel joined the project: what this account may do, and
    /// whether it suggests; then the threads.
    pub(super) fn review_joined_project(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.as_ref() else {
            return;
        };
        let project = client.project();
        self.review.permission = Some(project.permission);
        self.review.track_changes = project.track_changes;
        self.review.user_id = project.user_id.clone();
        self.reread_threads(Duration::ZERO, cx);
        self.read_authors(cx);
    }

    /// The project changed or closed: nothing of its review stays.
    pub(super) fn review_reset(&mut self) {
        self.review = ReviewState::default();
    }

    /// A document was joined: its comments and suggestions as Overleaf has
    /// them.
    pub(super) fn review_doc_joined(
        &mut self,
        doc_id: &str,
        comments: Vec<CommentRange>,
        changes: Vec<TrackedChange>,
    ) {
        self.review
            .docs
            .insert(doc_id.to_string(), DocReview { comments, changes });
    }

    /// A document was let go.
    pub(super) fn review_doc_left(&mut self, doc_id: &str) {
        self.review.docs.remove(doc_id);
    }

    /// `ops` moved `doc_id`'s text: ours when `own` (suggestions when we
    /// track), else a collaborator's, sent as suggestions by `by` if any.
    pub(super) fn review_moved(
        &mut self,
        doc_id: &str,
        ops: &[OtOp],
        own: bool,
        by: Option<Suggester>,
        cx: &mut Context<Self>,
    ) {
        if ops.is_empty() {
            return;
        }
        let by = if own {
            self.tracking().then(|| self.own_suggester())
        } else {
            by
        };
        let Some(review) = self.review.docs.get_mut(doc_id) else {
            return;
        };
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        review.comments = tracked::comments_after(&review.comments, ops);
        review.changes = tracked::changes_after(&review.changes, ops, by.as_ref(), &now);
        if review.changes.iter().any(tracked::is_provisional) {
            self.refresh_suggestions_later(doc_id.to_string(), cx);
        }
    }

    fn own_suggester(&self) -> Suggester {
        Suggester {
            user_id: self.review.user_id.clone(),
            // Overleaf's own colour for "you".
            hue: 200,
        }
    }

    /// What the channel said about review.
    pub(super) fn review_event(&mut self, event: RealtimeEvent, cx: &mut Context<Self>) {
        match event {
            RealtimeEvent::ThreadsChanged => self.reread_threads(REREAD_AFTER, cx),
            RealtimeEvent::CommentAnchored { doc_id, range } => {
                if let Some(review) = self.review.docs.get_mut(&doc_id)
                    && !review
                        .comments
                        .iter()
                        .any(|comment| comment.thread_id == range.thread_id)
                {
                    review.comments.push(range);
                }
                self.reread_threads(REREAD_AFTER, cx);
            }
            RealtimeEvent::ChangesAccepted { doc_id, change_ids } => {
                if let Some(review) = self.review.docs.get_mut(&doc_id) {
                    review
                        .changes
                        .retain(|change| !change_ids.contains(&change.id));
                }
            }
            RealtimeEvent::TrackChangesToggled { on } => self.review.track_changes = on,
            _ => {}
        }
        cx.notify();
    }

    /// Read the threads and their anchors again, `after` from now; a newer
    /// read replaces one still waiting.
    pub(super) fn reread_threads(&mut self, after: Duration, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.review.read_generation += 1;
        let generation = self.review.read_generation;
        self.review.reading = Some(cx.spawn(async move |this, cx| {
            if !after.is_zero() {
                cx.background_executor().timer(after).await;
            }
            let read = cx
                .background_spawn(async move {
                    let config = super::super::config_dir();
                    let threads = lattice_core::overleaf::threads(&config, &root)?;
                    let anchors = lattice_core::overleaf::comment_anchors(&config, &root)?;
                    Ok::<_, String>((threads, anchors))
                })
                .await;
            this.update(cx, |this, cx| {
                // Only the newest read settles.
                if this.review.read_generation != generation {
                    return;
                }
                this.review.reading = None;
                match read {
                    Ok((threads, anchors)) => {
                        this.review.threads = threads;
                        this.review.anchors = anchors;
                        this.review.loaded = true;
                        this.review.error = None;
                    }
                    Err(error) => {
                        let (error, _) = super::super::settled::<()>(Err(error));
                        this.review.error = error.err().map(SharedString::from);
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Who wrote the project's suggestions (`/changes/users`).
    fn read_authors(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let read = cx
                .background_spawn(async move {
                    lattice_core::overleaf::change_authors(&super::super::config_dir(), &root)
                })
                .await;
            let Ok(body) = read else {
                return;
            };
            this.update(cx, |this, cx| {
                this.review.authors = parse_authors(&body);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Swap `doc_id`'s provisional suggestions for Overleaf's own once the
    /// document has been quiet for [`SUGGESTIONS_REFRESH`]: joined again at
    /// its version, the answer counts only when nothing moved meanwhile.
    fn refresh_suggestions_later(&mut self, doc_id: String, cx: &mut Context<Self>) {
        self.review.refresh = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(SUGGESTIONS_REFRESH).await;
                let asked = this
                    .update(cx, |this, _| {
                        let version = this.settled_version(&doc_id)?;
                        Some((this.client.clone()?, version))
                    })
                    .ok()
                    .flatten();
                let Some((client, version)) = asked else {
                    continue;
                };
                let id = doc_id.clone();
                let joined = lattice_core::runtime::spawn(async move {
                    client.join_doc(&id, Some(version)).await
                })
                .await;
                let done = this
                    .update(cx, |this, cx| {
                        let Ok(Ok(joined)) = joined else {
                            return false;
                        };
                        let quiet = joined.resumed
                            && joined.caught_up.is_empty()
                            && this.settled_version(&doc_id) == Some(version);
                        if !quiet {
                            return false;
                        }
                        if let Some(review) = this.review.docs.get_mut(&doc_id) {
                            review.changes = joined.changes;
                            review.comments = joined.comments;
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(true);
                if done {
                    break;
                }
            }
            this.update(cx, |this, _| this.review.refresh = None).ok();
        }));
    }
}

/// `[{id, email, first_name, last_name}]`, or the same under `users`.
fn parse_authors(body: &serde_json::Value) -> HashMap<String, String> {
    let users = body
        .as_array()
        .or_else(|| body.get("users").and_then(serde_json::Value::as_array));
    let text = |user: &serde_json::Value, key: &str| {
        user.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    users
        .into_iter()
        .flatten()
        .filter_map(|user| {
            let id = text(user, "id").or_else(|| text(user, "_id"))?;
            let name = [text(user, "first_name"), text(user, "last_name")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            let name = Some(name)
                .filter(|name| !name.is_empty())
                .or_else(|| text(user, "email"))?;
            Some((id, name))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn suggestion_authors_parse_in_both_shapes_overleaf_uses() {
        let listed = json!([
            { "id": "u1", "first_name": "Ada", "last_name": "Lovelace" },
            { "_id": "u2", "email": "grace@example.edu" },
            { "id": "u3" },
        ]);
        let authors = parse_authors(&listed);
        assert_eq!(authors.get("u1").map(String::as_str), Some("Ada Lovelace"));
        assert_eq!(
            authors.get("u2").map(String::as_str),
            Some("grace@example.edu")
        );
        assert!(!authors.contains_key("u3"));
        let wrapped = json!({ "users": [{ "id": "u4", "first_name": "Emmy" }] });
        assert_eq!(
            parse_authors(&wrapped).get("u4").map(String::as_str),
            Some("Emmy")
        );
    }
}
