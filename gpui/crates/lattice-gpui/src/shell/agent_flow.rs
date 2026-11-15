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
    pub(super) state: AgentState,
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
pub(super) struct AgentState {
    /// The Git workspace's view: `changes` or `pull-requests`.
    git_view: String,
    /// The turn the Git workspace is pinned to, while it is.
    turn_review: Option<TurnReview>,
    /// The project's remote, for the Git workspace's GitHub button.
    remote_url: Option<String>,
    /// What the Agent is told of the window (`agent_context.rs`).
    pub(super) context: super::agent_context::ContextState,
    /// The Agent panel's turn while one runs or waits (`agent_turn.rs`).
    pub(super) turn: super::agent_turn::TurnState,
    /// The Agent's checkpoints (`agent_checkpoints.rs`).
    pub(super) checkpoints: super::agent_checkpoints::CheckpointState,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            git_view: "changes".into(),
            turn_review: None,
            remote_url: None,
            context: Default::default(),
            turn: Default::default(),
            checkpoints: Default::default(),
        }
    }
}

impl Shell {
    pub(super) fn agent_surface(&self, cx: &gpui::App) -> Entity<SynaraSurface> {
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
        self.push_agent_checkpoints(cx);
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

    /// The project's files changed on disk: the Agent's paper library reads
    /// the papers again when theirs did.
    pub(crate) fn agent_files_changed(&mut self, paths: Option<&[String]>, cx: &mut Context<Self>) {
        self.agent_surface(cx)
            .update(cx, |surface, cx| surface.files_changed(paths, cx));
    }

    /// Tell the Agent of the project's Overleaf link and its documents, for
    /// its view of the project's comments (`useEditorComments`'s
    /// `agentOptionsRef`: the threads are read through the link when asked).
    pub(crate) fn push_agent_overleaf(&mut self, cx: &mut Context<Self>) {
        let overleaf = {
            let bridge = self.overleaf.read(cx);
            let doc_paths: serde_json::Map<String, Value> = bridge
                .doc_paths()
                .map(|(id, path)| (id.to_string(), Value::String(path.to_string())))
                .collect();
            serde_json::json!({ "linked": bridge.link().is_some(), "docPaths": doc_paths })
        };
        self.agent_surface(cx)
            .update(cx, |surface, cx| surface.set_overleaf(overleaf, cx));
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
            .animated(lattice_ui::animated_icon::ProductIcon::GitBranch)
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

    pub(crate) fn on_agent_event(
        &mut self,
        surface: &Entity<SynaraSurface>,
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
            SurfaceEvent::ClearSelection => self.agent_selection_taken(cx),
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
            SurfaceEvent::DocumentTool {
                id,
                family,
                request,
            } => match super::agent_documents::ToolFamily::parse(family) {
                Some(family) => self.agent_document_tool(surface, *id, family, request, cx),
                None => surface.update(cx, |surface, cx| {
                    surface.answer(*id, Err(format!("unknown tool family {family}")), cx)
                }),
            },
            SurfaceEvent::CreateDocument {
                id,
                path,
                expires_at,
            } => self.agent_create_document(surface, *id, path.clone(), *expires_at, window, cx),
            SurfaceEvent::History(snapshot) => self.agent_history(snapshot.clone(), window, cx),
            SurfaceEvent::Turn(presence) => self.agent_turn(presence.clone(), cx),
            SurfaceEvent::TurnStarted => self.agent_turn_started(cx),
        }
    }
}
