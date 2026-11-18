//! The Agent: Synara's panel and its Git workspace, as the Tauri app embeds
//! them, each the Agent island's page (`gpui/islands/agent`, the Tauri app's
//! own Synara host) in a panel of the window.
//!
//! - [`runtime`]: the Synara service, lattice-core's supervisor with its
//!   macOS bibliography sandbox, made once per process; off where the
//!   Tauri app keeps it off.
//! - [`commands`]: the backend commands the page invokes, the bibliography
//!   brokers among them, answered through lattice-core for the panel's own
//!   project only.
//! - [`surface`]: one page for one project, its bridge to the app; the
//!   third, Settings › Providers, is shown in the Settings dialog.
//! - [`AgentPanel`], [`GitPanel`]: the dock's panels around a surface: the
//!   Agent beside Project (the `agent` view), and the Git workspace opened
//!   as a tool panel among the documents (`git`, the titlebar's Git button
//!   or a turn's Review).
//!
//! Hidden behind another tab, collapsed or closed, the Agent's page stays
//! while a turn runs or waits (its tool calls for the window pass through
//! the page) and for a few minutes after; then it hibernates, freeing its
//! WebContent process, and is built again when shown. Synara's service, with
//! its threads and terminals, keeps running either way. The page is told
//! whether it is on screen, which keeps Synara's idle stop for a thread
//! nobody looks at.

use std::path::PathBuf;

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Window, div,
};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use lattice_i18n::t;

pub mod checkpoints;
pub mod commands;
pub mod host_context;
pub mod host_writes;
pub mod permission_mode;
pub mod runtime;
pub mod surface;
pub mod text_task;
pub mod workspace;

pub use surface::{SurfaceEvent, SurfaceKind, SynaraSurface, TurnReview};

/// The Agent's home, where its state, skills and `models.json` live: the
/// GPUI app's own (`structured::resources::app_dirs`), never the Tauri
/// app's, as lattice-core's supervisor puts it under the data folder.
pub fn agent_home() -> PathBuf {
    crate::structured::resources::app_dirs().data.join("synara")
}

/// A panel around one Synara surface.
pub struct SynaraPanel {
    surface: Entity<SynaraSurface>,
    focus_handle: FocusHandle,
}

impl SynaraPanel {
    fn new(kind: SurfaceKind, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let surface = cx.new(|cx| SynaraSurface::new(kind, window, cx));
        Self {
            surface,
            focus_handle: cx.focus_handle(),
        }
    }

    pub fn surface(&self) -> &Entity<SynaraSurface> {
        &self.surface
    }

    pub fn kind(&self, cx: &App) -> SurfaceKind {
        self.surface.read(cx).kind()
    }
}

/// The Agent panel: the `agent` view.
pub type AgentPanel = SynaraPanel;
/// The Git workspace: the `git` tool view.
pub type GitPanel = SynaraPanel;

pub fn agent_panel(window: &mut Window, cx: &mut App) -> Entity<AgentPanel> {
    cx.new(|cx| SynaraPanel::new(SurfaceKind::Agent, window, cx))
}

pub fn git_panel(window: &mut Window, cx: &mut App) -> Entity<GitPanel> {
    cx.new(|cx| SynaraPanel::new(SurfaceKind::Git, window, cx))
}

/// Settings › Providers' page, for the Settings dialog.
pub fn settings_surface(window: &mut Window, cx: &mut App) -> Entity<SynaraSurface> {
    cx.new(|cx| SynaraSurface::new(SurfaceKind::Settings, window, cx))
}

impl EventEmitter<PanelEvent> for SynaraPanel {}

impl Focusable for SynaraPanel {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.surface
            .read(cx)
            .focus_handle(cx)
            .unwrap_or_else(|| self.focus_handle.clone())
    }
}

impl BasePanel for SynaraPanel {
    fn panel_name(&self) -> &'static str {
        // Fixed per kind; the surface's kind never changes.
        "SynaraPanel"
    }

    fn set_active(&mut self, active: bool, _: &mut Window, cx: &mut Context<Self>) {
        self.surface.update(cx, |surface, cx| {
            surface.set_shown(active, cx);
            if active {
                surface.opened(cx);
            }
        });
    }
}

impl Panel for SynaraPanel {
    fn tab_name(&self, cx: &App) -> Option<SharedString> {
        Some(self.title_text(cx).into())
    }

    fn title(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.title_text(cx)
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }

    /// The Agent's header tool: its permission picker, once the frame has
    /// said its mode (`trellis-panel-actions.tsx`).
    fn title_suffix(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let surface = self.surface.read(cx);
        if surface.kind() != SurfaceKind::Agent {
            return None;
        }
        let permission = surface.permission()?;
        Some(surface::permission::picker(
            &self.surface,
            permission,
            surface.endpoint_saved(),
        ))
    }
}

impl SynaraPanel {
    /// `PANEL_TITLES` (`src/trellis/trellis-titles.ts`).
    fn title_text(&self, cx: &App) -> &'static str {
        match self.kind(cx) {
            SurfaceKind::Agent => t!("Agent"),
            SurfaceKind::Git => t!("Source control"),
            SurfaceKind::Settings => t!("Providers"),
        }
    }
}

impl Render for SynaraPanel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("synara-panel")
            .track_focus(&self.focus_handle)
            .size_full()
            .child(self.surface.clone())
    }
}
