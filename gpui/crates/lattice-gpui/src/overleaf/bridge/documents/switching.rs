//! Leaving a project before the window switches (#1208). Opening the next
//! project replaces the bridge's root and drops its link (`set_project`),
//! after which no leave can record its agreed copy. So the shell asks first:
//! the live document is left, unsent typing and all, nothing is joined while
//! the switch is under way (the old editor stays focused and editable), and
//! the switch waits, at most [`SWITCH_WAIT`], for every draining document,
//! save and queued agreed copy. The shell ends the switch whichever way it
//! went (`switch_ended`), which lets the shown editor be joined again.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::*;

/// A project switch waits this long for its documents to be answered.
const SWITCH_WAIT: Duration = Duration::from_secs(5);

/// Agreed copies waiting for the running sync, each with the project it is
/// of: a queue a switch left behind must never land in the next project's
/// same-named file, where it would become a wrong merge base.
#[derive(Default)]
pub(in crate::overleaf::bridge) struct Checkpoints(Vec<(PathBuf, String, String)>);

impl Checkpoints {
    pub(super) fn push(&mut self, root: PathBuf, path: String, text: String) {
        self.0.push((root, path, text));
    }

    /// Take every queued copy: `root`'s are handed back, any other
    /// project's are dropped, as a switch the wait gave up on drops them.
    pub(super) fn take_for(&mut self, root: Option<&Path>) -> Vec<(String, String)> {
        self.0
            .drain(..)
            .filter_map(|(of, path, text)| {
                if Some(of.as_path()) == root {
                    return Some((path, text));
                }
                log::warn!("not recording {path} as agreed: its project is no longer shown");
                None
            })
            .collect()
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl DocumentsState {
    /// What a switch still waits for before the project can go.
    fn switch_owed(&self) -> bool {
        self.live.is_some()
            || self.joining.is_some()
            || !self.leaving.is_empty()
            || !self.checkpoints.is_empty()
            || self.checkpoint_saves > 0
    }
}

impl OverleafBridge {
    /// The window is about to leave its project: see the module comment.
    pub fn leave_before_switch(&mut self, cx: &mut Context<Self>) -> Task<()> {
        self.documents.switching = true;
        self.editor_shown(None, cx);
        cx.spawn(async move |this, cx| {
            let deadline = Instant::now() + SWITCH_WAIT;
            while Instant::now() < deadline
                && this
                    .read_with(cx, |this, _| this.documents.switch_owed())
                    .unwrap_or(false)
            {
                cx.background_executor()
                    .timer(Duration::from_millis(25))
                    .await;
            }
        })
    }

    /// The switch is over, entered or not: `editor` is the one shown now,
    /// and may be joined again.
    pub fn switch_ended(&mut self, editor: Option<&Entity<EditorPanel>>, cx: &mut Context<Self>) {
        self.documents.switching = false;
        self.documents.shown = None;
        self.editor_shown(editor, cx);
        self.reconsider_live(cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_queued_agreed_copy_never_lands_in_the_next_project() {
        let (old, next) = (PathBuf::from("/project/a"), PathBuf::from("/project/b"));
        let mut queue = Checkpoints::default();
        queue.push(old.clone(), "main.tex".into(), "A's text".into());
        assert!(queue.take_for(Some(&next)).is_empty());
        assert!(queue.is_empty());

        queue.push(old.clone(), "main.tex".into(), "A's text".into());
        queue.push(next.clone(), "main.tex".into(), "B's text".into());
        assert_eq!(
            queue.take_for(Some(&next)),
            [("main.tex".to_string(), "B's text".to_string())]
        );
        queue.push(old, "main.tex".into(), "A's text".into());
        assert!(queue.take_for(None).is_empty());
    }

    #[test]
    fn a_switch_waits_for_queued_copies_and_saves() {
        let mut documents = DocumentsState::default();
        assert!(!documents.switch_owed());
        documents.checkpoint_saves = 1;
        assert!(documents.switch_owed());
        documents.checkpoint_saves = 0;
        documents
            .checkpoints
            .push("/project/a".into(), "main.tex".into(), "text".into());
        assert!(documents.switch_owed());
    }
}
