//! The Agent panel's turn in the window, as the Tauri app follows it
//! (`src/agent/agent-turn-activity.ts`, `use-synara-host.ts`): the page
//! relays the turn's presence, which the window keeps while the turn runs or
//! waits on the writer, so a switch to another project asks before it
//! interrupts "the agent's turn" (`leave-project.ts`), and every open Open
//! Slide deck lights up for the decks the turn names. A turn starting is
//! the writer really asking the Agent something: Get started's "Ask the
//! agent" step is done.

use gpui::{Context, EntityId};
use serde_json::Value;

use super::Shell;

/// The Agent panel's turn, while there is one.
#[derive(Default)]
pub(crate) struct TurnState {
    /// The turn's presence (`AgentDeckPresence`): running or waiting.
    presence: Option<Value>,
    /// The deck pages told of it, so a deck opened mid-turn hears too.
    decks: Vec<EntityId>,
}

impl Shell {
    /// Lattice wrote `paths` of this window's project for the writer or a
    /// co-author (`agent::host_writes`).
    pub(super) fn agent_host_wrote(
        &mut self,
        paths: impl IntoIterator<Item = String>,
        cx: &mut Context<Self>,
    ) {
        if let Some(root) = self.root(cx) {
            crate::agent::host_writes::note(&root, paths, cx);
        }
    }

    /// An editor saved the writer's typing (`use-document-save.ts`); a
    /// board's, sheet's or deck's own page saves what its editor holds,
    /// which may be the Agent's work, so only text is reported.
    pub(super) fn agent_host_saved(
        &mut self,
        editor: &gpui::Entity<crate::editor_panel::EditorPanel>,
        cx: &mut Context<Self>,
    ) {
        let editor = editor.read(cx);
        let text = editor.structured().is_none_or(|document| {
            document.read(cx).kind() == crate::structured::StructuredKind::Markdown
        });
        if text {
            let relative = editor.relative().to_string();
            self.agent_host_wrote([relative], cx);
        }
    }

    /// Whether the Agent panel's turn is running or waiting.
    pub(crate) fn agent_turn_running(&self) -> bool {
        self.agent.state.turn.presence.is_some()
    }

    /// The page reported the turn's presence (`null`: no live turn).
    pub(super) fn agent_turn(&mut self, presence: Option<Value>, cx: &mut Context<Self>) {
        self.agent.state.turn.presence = presence;
        self.agent.state.turn.decks.clear();
        self.tell_decks_of_turn(cx);
    }

    /// A turn started in the panel.
    pub(super) fn agent_turn_started(&mut self, cx: &mut Context<Self>) {
        crate::get_started::progress::mark(crate::get_started::Step::Agent, cx);
    }

    /// Every open deck page shows the turn's presence (`publishAgentDeckPresence`
    /// in each page); one already told is not told again.
    pub(super) fn tell_decks_of_turn(&mut self, cx: &mut Context<Self>) {
        let presence = self
            .agent
            .state
            .turn
            .presence
            .clone()
            .unwrap_or(Value::Null);
        for editor in self.open_editors() {
            let Some(document) = editor.read(cx).structured().cloned() else {
                continue;
            };
            if document.read(cx).kind() != crate::structured::StructuredKind::Deck
                || self.agent.state.turn.decks.contains(&document.entity_id())
            {
                continue;
            }
            let Some(island) = document.read(cx).island().cloned() else {
                continue;
            };
            self.agent.state.turn.decks.push(document.entity_id());
            let presence = presence.clone();
            island.update(cx, |island, _| island.post("agent:deck-presence", presence));
        }
    }
}
