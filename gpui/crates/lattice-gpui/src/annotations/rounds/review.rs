//! Reviewing a round's proposals one at a time: the one open in the
//! editor, and stepping to the one before or after it among those waiting.

use gpui::{App, Context};

use super::{AnnotationRounds, RoundsEvent, pending_proposals};

impl AnnotationRounds {
    /// Open `id`'s proposal in the editor, its card under the passage.
    pub fn open_review(&mut self, id: &str, cx: &mut Context<Self>) {
        self.review = Some(id.to_string());
        cx.emit(RoundsEvent::Review(id.to_string()));
        cx.notify();
    }

    pub fn close_review(&mut self, cx: &mut Context<Self>) {
        if self.review.take().is_some() {
            cx.emit(RoundsEvent::CloseReview);
            cx.notify();
        }
    }

    /// The next (or previous) waiting proposal after `id`, wrapping; none
    /// when there is none.
    pub fn neighbour(&self, id: Option<&str>, step: isize, cx: &App) -> Option<String> {
        let root = self.root(cx)?;
        let proposals = pending_proposals(&Self::notes(&root, cx));
        if proposals.is_empty() {
            return None;
        }
        let count = proposals.len() as isize;
        let Some(index) = id.and_then(|id| proposals.iter().position(|comment| comment.id == id))
        else {
            let first = if step > 0 { 0 } else { proposals.len() - 1 };
            return Some(proposals[first].id.clone());
        };
        let next = &proposals[((index as isize + step + count) % count) as usize];
        (Some(next.id.as_str()) != id).then(|| next.id.clone())
    }

    /// Review the proposal before or after `id`.
    pub fn navigate(&mut self, id: &str, step: isize, cx: &mut Context<Self>) {
        if let Some(next) = self.neighbour(Some(id), step, cx) {
            self.open_review(&next, cx);
        }
    }

    /// Where `id` stands among the waiting proposals, and how many wait.
    pub fn position(&self, id: &str, cx: &App) -> (Option<usize>, usize) {
        let Some(root) = self.root(cx) else {
            return (None, 0);
        };
        let proposals = pending_proposals(&Self::notes(&root, cx));
        (
            proposals.iter().position(|comment| comment.id == id),
            proposals.len(),
        )
    }
}
