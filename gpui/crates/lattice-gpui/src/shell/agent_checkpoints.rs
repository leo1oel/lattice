//! The Agent's checkpoints in the window, as the Tauri app's App wires
//! `useAgentCheckpoints` (`src/app/use-agent-checkpoints.ts`) to its build
//! pipeline, its History drawer (`app-history-drawers.tsx`) and its conflict
//! resolver (`agent-undo-conflicts.ts`, `app-overleaf-dialogs.tsx`):
//!
//! - every snapshot the Agent panel's page relays becomes the History
//!   panel's checkpoint rows, only the open thread's able to undo;
//! - fresh Agent edits build the PDF once they rest for 1.5 s (with
//!   Automatic builds), an Undo at once (even without), and each build tells
//!   the turns it covers how it went: the checkpoints present as a pass
//!   starts are that pass's, so one arriving mid-build waits for the next;
//! - an Undo that came back with conflict markers (it kept newer edits where
//!   they overlap the Agent's change) says so and opens the resolver, its
//!   sides the current text and the text from before the Agent;
//! - a row's Undo goes to the Agent's own frame, which reverses the turn.
//!
//! The model is `crate::agent::checkpoints`; this is what the window does
//! with it. The Tauri app also hands each edited path to Overleaf's realtime
//! editing as an outside edit (`suspendPaths`); here the project watcher
//! already carries every write on disk to the open editors and the sync.

use std::collections::HashSet;

use gpui::{AppContext as _, Context, Task, Window};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use super::{Shell, build::BuildRequest};
use crate::{
    agent::checkpoints::{self, Association, Checkpoints, Compiled, Entry, Snapshot},
    history::{CheckpointItem, conflicts::has_conflict_markers},
    notices::{self, Notice},
};

/// The Agent's checkpoints in one window, for the project it shows; a new
/// project starts afresh (`AgentState::default`).
#[derive(Default)]
pub(crate) struct CheckpointState {
    model: Checkpoints,
    /// The build waiting for fresh edits to rest.
    timer: Option<Task<()>>,
    /// The next pass to start is the one the Agent asked for, and takes the
    /// checkpoints waiting for a build (`consumeAgentAssociations`).
    consume_next: bool,
    /// The checkpoints the running pass reports to.
    crediting: Vec<Association>,
    /// The files an Undo left with conflict markers, whose resolver names
    /// its sides as the Undo's until it resolves or closes
    /// (`undoConflictPaths`).
    undo_conflicts: HashSet<String>,
    /// What was sent to the Agent's frame, for a scenario.
    sent: Vec<serde_json::Value>,
}

impl Shell {
    fn checkpoints(&mut self) -> &mut CheckpointState {
        &mut self.agent.state.checkpoints
    }

    /// A snapshot of the Agent panel's thread.
    pub(super) fn agent_history(
        &mut self,
        snapshot: Snapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let automatic = crate::settings::builds_automatically(cx);
        let outcome = self.checkpoints().model.handle(snapshot, automatic);
        self.push_agent_checkpoints(cx);
        if !outcome.undone.is_empty() {
            self.look_for_undo_conflicts(outcome.undone, window, cx);
        }
        let Some(delay) = outcome.build else { return };
        let project = self.project.clone();
        let timer = cx.spawn_in(window, async move |this, cx| {
            if !delay.is_zero() {
                cx.background_executor().timer(delay).await;
            }
            this.update_in(cx, |this, window, cx| {
                // Another project opened meanwhile starts its own checkpoints.
                if this.project != project {
                    return;
                }
                this.checkpoints().timer = None;
                this.checkpoints().consume_next = true;
                this.run_build(BuildRequest::default(), window, cx);
            })
            .ok();
        });
        self.checkpoints().timer = Some(timer);
    }

    /// The History panel's checkpoint rows, from the model.
    pub(super) fn push_agent_checkpoints(&mut self, cx: &mut Context<Self>) {
        let model = &self.agent.state.checkpoints.model;
        let items: Vec<CheckpointItem> = model
            .entries()
            .map(|entry| CheckpointItem {
                entry: entry.clone(),
                restorable: model.restorable(&entry.thread_id),
            })
            .collect();
        self.history
            .update(cx, |history, cx| history.set_agent_checkpoints(items, cx));
    }

    /// A build pass starts: one the Agent asked for takes the checkpoints
    /// waiting for it.
    pub(super) fn agent_build_started(&mut self) {
        let state = self.checkpoints();
        state.crediting = if std::mem::take(&mut state.consume_next) {
            state.model.take_pending()
        } else {
            Vec::new()
        };
    }

    /// A build pass ended, with its result when it ran: the turns it covers
    /// hear how it went, unless the project changed under it.
    pub(super) fn agent_build_finished(
        &mut self,
        current: bool,
        outcome: Option<&Result<super::build::Finished, String>>,
        cx: &mut Context<Self>,
    ) {
        let crediting = std::mem::take(&mut self.checkpoints().crediting);
        if !current || crediting.is_empty() {
            return;
        }
        let result = outcome.and_then(|outcome| outcome.as_ref().ok());
        let compiled = result.map(|finished| Compiled::of(&finished.result));
        let now = checkpoints::now();
        let surface = self.agent.panel.read(cx).surface().clone();
        for association in &crediting {
            let message = checkpoints::compile_result(association, compiled.as_ref(), &now);
            self.checkpoints().sent.push(message.clone());
            surface.update(cx, |surface, cx| surface.post_frame(message, cx));
        }
    }

    /// A checkpoint row's Undo: the Agent reverses the turn's file changes,
    /// which only the thread its panel has open can.
    pub(super) fn agent_restore_checkpoint(&mut self, entry: &Entry, cx: &mut Context<Self>) {
        if !self
            .agent
            .state
            .checkpoints
            .model
            .restorable(&entry.thread_id)
        {
            return;
        }
        let message = checkpoints::restore(entry);
        self.checkpoints().sent.push(message.clone());
        self.agent
            .panel
            .read(cx)
            .surface()
            .clone()
            .update(cx, |surface, cx| surface.post_frame(message, cx));
    }

    /// What the checkpoints sent the Agent's frame (builds' results and
    /// Undos), for a scenario.
    pub(crate) fn agent_checkpoint_messages(&self) -> &[serde_json::Value] {
        &self.agent.state.checkpoints.sent
    }

    /// The files an Undo put back that carry conflict markers: where newer
    /// edits overlapped the Agent's change, Synara kept both, marked.
    fn look_for_undo_conflicts(
        &mut self,
        paths: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else { return };
        let read = cx.background_spawn({
            let root = root.clone();
            async move {
                paths
                    .into_iter()
                    .filter(|path| {
                        std::fs::read_to_string(root.join(path))
                            .is_ok_and(|content| has_conflict_markers(&content))
                    })
                    .collect::<Vec<_>>()
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let marked = read.await;
            this.update_in(cx, |this, window, cx| {
                if marked.is_empty() || this.root(cx).as_deref() != Some(root.as_path()) {
                    return;
                }
                this.announce_undo_conflicts(&marked, window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn announce_undo_conflicts(
        &mut self,
        marked: &[String],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let files = marked.join(", ");
        notices::show(
            Notice::new(ToastLevel::Warning, t!("Agent")).detail(t!(
                "Undo kept newer edits in {files} where they overlap the agent's change. Choose \
                 what to keep in each marked spot; nothing uploads to Overleaf until then.",
                files = files
            )),
            cx,
        );
        self.checkpoints()
            .undo_conflicts
            .extend(marked.iter().cloned());
        self.open_conflict_resolver(marked[0].clone(), false, window, cx);
    }

    /// Whether `path` is a file an Undo left with conflict markers.
    pub(super) fn is_agent_undo_conflict(&self, path: &str) -> bool {
        self.agent.state.checkpoints.undo_conflicts.contains(path)
    }

    /// The resolver for `path` resolved or closed.
    pub(super) fn forget_agent_undo_conflict(&mut self, path: &str) {
        self.checkpoints().undo_conflicts.remove(path);
    }
}
