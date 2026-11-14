//! The Agent in the window (`crate::agent`): which project its surfaces
//! show, what it is told of the writer's workspace, the Git workspace's
//! view, and what it asks of the window, as the Tauri app's App wires
//! `useSynaraHost` (`src/app/use-agent-context.ts`, `use-tool-drawers.ts`).

use gpui::{App, AppContext as _, Context, Entity, Window};
use serde_json::Value;

use super::Shell;
use crate::agent::{AgentPanel, GitPanel, SurfaceEvent, SynaraSurface, TurnReview};

/// The Agent in one window: its panel, the Git workspace's, Settings ›
/// Providers' page, and their state.
pub(crate) struct AgentWindow {
    pub panel: Entity<AgentPanel>,
    pub git: Entity<GitPanel>,
    pub settings: Entity<SynaraSurface>,
    state: AgentState,
}

impl AgentWindow {
    pub fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            panel: crate::agent::agent_panel(window, cx),
            git: crate::agent::git_panel(window, cx),
            settings: crate::agent::settings_surface(window, cx),
            state: AgentState::default(),
        }
    }

    /// The shell hears what both surfaces ask of the window.
    pub fn watch(&self, window: &mut Window, cx: &mut Context<Shell>) {
        for panel in [&self.panel, &self.git] {
            let surface = panel.read(cx).surface().clone();
            cx.subscribe_in(&surface, window, |this, surface, event, window, cx| {
                this.on_agent_event(surface, event, window, cx)
            })
            .detach();
        }
    }
}

/// The Agent's state in one window.
struct AgentState {
    /// The Git workspace's view: `changes` or `pull-requests`.
    git_view: String,
    /// The turn the Git workspace is pinned to, while it is.
    turn_review: Option<TurnReview>,
    /// The selection the Agent took (its chip was cleared): it stays out of
    /// the host context until the writer selects something else.
    dismissed: Option<String>,
    /// The project's remote, for the Git workspace's GitHub button.
    remote_url: Option<String>,
    /// The editor whose workspace the Agent was last told of.
    front: Option<gpui::EntityId>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            git_view: "changes".into(),
            turn_review: None,
            dismissed: None,
            remote_url: None,
            front: None,
        }
    }
}

impl Shell {
    fn agent_surface(&self, cx: &gpui::App) -> Entity<SynaraSurface> {
        self.agent.panel.read(cx).surface().clone()
    }

    fn git_surface(&self, cx: &gpui::App) -> Entity<SynaraSurface> {
        self.agent.git.read(cx).surface().clone()
    }

    /// The window shows the project at `root` now: the Agent's frames are
    /// that project's, and start afresh.
    pub(crate) fn agent_project(
        &mut self,
        root: Option<std::path::PathBuf>,
        cx: &mut Context<Self>,
    ) {
        self.agent.state = AgentState::default();
        let settings = self.agent.settings.clone();
        for surface in [self.agent_surface(cx), self.git_surface(cx), settings] {
            let root = root.clone();
            surface.update(cx, |surface, cx| surface.set_project(root, cx));
        }
        self.push_git_state(cx);
        self.push_agent_workspace(cx);
        if let Some(root) = root {
            let looked_up = root.clone();
            let remote = cx.background_spawn(async move {
                lattice_core::git::status(&looked_up)
                    .ok()
                    .and_then(|status| status.remote_url)
            });
            cx.spawn(async move |this, cx| {
                let remote_url = remote.await;
                this.update(cx, |this, cx| {
                    // Another project opened while this one's status ran.
                    if this.root(cx).as_deref() != Some(root.as_path()) {
                        return;
                    }
                    this.agent.state.remote_url = remote_url;
                    this.push_git_state(cx);
                })
                .ok();
            })
            .detach();
        }
    }

    /// The editor in front changed since the Agent was told.
    pub(crate) fn agent_follow_front(&mut self, cx: &mut Context<Self>) {
        let front = self.active_editor().map(|editor| editor.entity_id());
        if front != self.agent.state.front {
            self.push_agent_workspace(cx);
        }
    }

    /// Tell the Agent what the writer is working in now: the editor in
    /// front, its caret and its selection (`useAgentContext`).
    pub(crate) fn push_agent_workspace(&mut self, cx: &mut Context<Self>) {
        let editor = self.active_editor();
        self.agent.state.front = editor.as_ref().map(|editor| editor.entity_id());
        let mut workspace =
            crate::agent::workspace::of_editor(editor.as_ref().map(|editor| editor.read(cx)), cx);
        let selection = workspace
            .get("selection")
            .and_then(Value::as_str)
            .map(str::to_string);
        // The selection the Agent took stays out until it changes.
        if selection.is_some() && selection == self.agent.state.dismissed {
            if let Some(fields) = workspace.as_object_mut() {
                for key in ["selection", "selectionSource", "selectionLines"] {
                    fields.remove(key);
                }
            }
        } else {
            self.agent.state.dismissed = None;
        }
        self.agent_surface(cx)
            .update(cx, |surface, cx| surface.set_workspace(workspace, cx));
    }

    fn push_git_state(&mut self, cx: &mut Context<Self>) {
        let view = self.agent.state.git_view.clone();
        let turn = self.agent.state.turn_review.clone();
        let remote = self.agent.state.remote_url.clone();
        self.git_surface(cx).update(cx, |surface, cx| {
            surface.set_git(&view, turn.as_ref(), remote, cx)
        });
    }

    /// The titlebar's Git button.
    pub(crate) fn git_button(&self, cx: &mut Context<Self>) -> lattice_ui::components::IconButton {
        use lattice_ui::{
            Icon,
            components::{IconButton, Surface},
        };
        IconButton::new("git", Icon::GIT)
            .surface(Surface::Titlebar)
            .tooltip(lattice_i18n::t!("Git status and commit"))
            .disabled(self.project.is_none())
            .on_click(cx.listener(|shell, _, window, cx| shell.open_git(None, window, cx)))
    }

    /// The Git workspace (the titlebar's Git button): its Changes view, or a
    /// turn's checkpoint diff, as a tool panel among the documents.
    pub(crate) fn open_git(
        &mut self,
        turn: Option<TurnReview>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.project.is_none() {
            return;
        }
        self.agent.state.turn_review = turn;
        self.push_git_state(cx);
        self.reveal_tool("git", window, cx);
    }

    /// Show `prompt` in the Agent's composer, or send it
    /// (`AgentComposerPromptMessage`), bringing the panel forward.
    #[allow(dead_code)]
    pub(crate) fn ask_agent(
        &mut self,
        message: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.reveal_agent(window, cx);
        self.agent_surface(cx)
            .update(cx, |surface, cx| surface.compose(message, cx));
    }

    /// The Agent panel on screen and in front (`showPanel`).
    fn reveal_agent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_view("agent", true, window, cx);
    }

    pub(crate) fn on_agent_event(
        &mut self,
        _: &Entity<SynaraSurface>,
        event: &SurfaceEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            SurfaceEvent::OpenPath(path) => {
                let Some(root) = self.root(cx) else { return };
                self.open_path(root.join(path), None, window, cx);
            }
            SurfaceEvent::OpenReview(turn) => self.open_git(turn.clone(), window, cx),
            SurfaceEvent::OpenProviderSettings(target) => {
                self.open_settings(Some(lattice_settings::SettingsTab::Agent), window, cx);
                if let Some(target) = target {
                    self.agent
                        .settings
                        .update(cx, |surface, cx| surface.reveal_setting(target, cx));
                }
            }
            SurfaceEvent::ClearSelection => {
                let editor = self.active_editor();
                let workspace = crate::agent::workspace::of_editor(
                    editor.as_ref().map(|editor| editor.read(cx)),
                    cx,
                );
                self.agent.state.dismissed = workspace
                    .get("selection")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.push_agent_workspace(cx);
            }
            SurfaceEvent::MinimumWidth(width) => {
                let size = super::views::agent_min_size(*width);
                self.engine_do(cx, |engine| engine.set_min_size("agent", size));
            }
            SurfaceEvent::GitView(view) => {
                self.agent.state.git_view = view.clone();
                self.agent.state.turn_review = None;
                self.push_git_state(cx);
            }
            SurfaceEvent::CloseGit => {
                self.engine_do(cx, |engine| engine.close("git"));
                self.focus_front(window, cx);
            }
        }
    }
}
