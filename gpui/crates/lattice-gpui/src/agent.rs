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
//! The Agent panel can move into a window of its own ([`window`]), with the
//! same page.
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
    AnyWindowHandle, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Window, div, px,
};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, IconButton, Surface, TAB_RADIUS},
    dock::PANEL_RADIUS,
    icons::ICON_LARGE,
};

pub mod checkpoints;
pub mod commands;
pub mod host_context;
pub mod host_writes;
pub mod permission_mode;
pub mod runtime;
pub mod surface;
pub mod text_task;
pub mod window;
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
    /// The workspace window the panel is in.
    home: AnyWindowHandle,
    /// The Agent's separate window, while it has one.
    window: Option<AnyWindowHandle>,
    /// The panel is the one its dock shows, which shows the surface while it
    /// is here.
    active: bool,
}

impl SynaraPanel {
    fn new(kind: SurfaceKind, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let surface = cx.new(|cx| SynaraSurface::new(kind, window, cx));
        // The separate window goes with the workspace's panel.
        cx.on_release(|this: &mut Self, cx| {
            if let Some(handle) = this.window.take() {
                handle
                    .update(cx, |_, window, _| window.remove_window())
                    .ok();
            }
        })
        .detach();
        Self {
            surface,
            focus_handle: cx.focus_handle(),
            home: window.window_handle(),
            window: None,
            active: false,
        }
    }

    pub fn surface(&self) -> &Entity<SynaraSurface> {
        &self.surface
    }

    pub fn kind(&self, cx: &App) -> SurfaceKind {
        self.surface.read(cx).kind()
    }

    /// Whether the Agent is in a window of its own.
    pub fn is_detached(&self) -> bool {
        self.window.is_some()
    }

    /// The Agent's separate window, while it has one.
    pub fn window_handle(&self) -> Option<AnyWindowHandle> {
        self.window
    }

    /// Move the Agent into a window of its own, in front: it opens where it
    /// was last left for the project, with the page as it is.
    pub fn detach(&mut self, cx: &mut Context<Self>) {
        self.open_window(true, cx);
    }

    /// The window is leaving the project the surface shows: the Agent's
    /// window goes with it, its choice left as it was.
    pub fn leave_project(&mut self, cx: &mut Context<Self>) {
        let Some(handle) = self.window.take() else {
            return;
        };
        let root = self
            .surface
            .read(cx)
            .root()
            .map(std::path::Path::to_path_buf);
        window::close(handle, &self.surface, root.as_deref(), cx);
        self.sync_shown(cx);
        cx.notify();
    }

    /// The surface shows a project now: a window that project left open
    /// comes back, behind the workspace.
    pub fn restore_window(&mut self, cx: &mut Context<Self>) {
        if self.surface.read(cx).root().is_some_and(window::is_open) {
            self.open_window(false, cx);
        }
    }

    fn open_window(&mut self, focus: bool, cx: &mut Context<Self>) {
        let surface = self.surface.read(cx);
        if surface.kind() != SurfaceKind::Agent || self.window.is_some() {
            return;
        }
        let Some(root) = surface.root().map(std::path::Path::to_path_buf) else {
            return;
        };
        let title = match root.file_name() {
            Some(name) => format!("{} — {}", t!("Agent"), name.to_string_lossy()),
            None => t!("Agent").to_string(),
        };
        let opened = window::AgentWindow::open(
            cx.entity().downgrade(),
            self.surface.clone(),
            Some(root.clone()),
            title.into(),
            focus,
            cx,
        );
        match opened {
            Ok(handle) => {
                self.window = Some(handle);
                window::update(&root, |remembered| remembered.open = true);
                self.sync_shown(cx);
                if !focus {
                    self.home
                        .update(cx, |_, window, _| window.activate_window())
                        .ok();
                }
                cx.notify();
            }
            Err(error) => {
                log::error!("could not open the Agent window: {error:#}");
                crate::notices::error(
                    t!("Could not open the Agent in a new window"),
                    format!("{error:#}"),
                    cx,
                );
            }
        }
    }

    /// Return to workspace: the Agent comes back into its panel, its page
    /// with it, and the project remembers it there; the window closes
    /// (unless the writer is closing it already).
    pub fn dock(&mut self, close_window: bool, cx: &mut Context<Self>) {
        let Some(handle) = self.window.take() else {
            return;
        };
        let root = self
            .surface
            .read(cx)
            .root()
            .map(std::path::Path::to_path_buf);
        if close_window {
            window::close(handle, &self.surface, root.as_deref(), cx);
        }
        if let Some(root) = root {
            window::update(&root, |remembered| remembered.open = false);
        }
        self.sync_shown(cx);
        cx.notify();
    }

    /// The surface is shown while the panel is, or while it is in its own
    /// window, whatever the dock shows.
    fn sync_shown(&mut self, cx: &mut Context<Self>) {
        let shown = self.active || self.window.is_some();
        self.surface.update(cx, |surface, cx| {
            surface.set_shown(shown, cx);
            if shown {
                surface.opened(cx);
            }
        });
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
        if self.window.is_some() {
            return self.focus_handle.clone();
        }
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
        self.active = active;
        if self.window.is_none() {
            self.sync_shown(cx);
        }
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

    /// The Agent's header tools: its permission picker, once the frame has
    /// said its mode (`trellis-panel-actions.tsx`), and Open in separate
    /// window, the PDF's (#1202), while it is here and has a project.
    fn title_suffix(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let surface = self.surface.read(cx);
        if surface.kind() != SurfaceKind::Agent || self.window.is_some() {
            return None;
        }
        let picker = surface.permission().map(|permission| {
            surface::permission::picker(&self.surface, permission, surface.endpoint_saved())
        });
        let separate = (cfg!(target_os = "macos") && surface.root().is_some()).then(|| {
            IconButton::new("agent-open-window", Icon::SQUARE_ARROW_OUT_UP_RIGHT)
                .radius(TAB_RADIUS)
                .surface(Surface::SidePanel)
                .tooltip(t!("Open in separate window"))
                .on_click(cx.listener(|this, _, _, cx| this.detach(cx)))
        });
        if picker.is_none() && separate.is_none() {
            return None;
        }
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(1.))
                .children(picker)
                .children(separate),
        )
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
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.window.is_none() {
            return div()
                .id("synara-panel")
                .track_focus(&self.focus_handle)
                .size_full()
                .child(self.surface.clone());
        }
        // In its own window, the Agent leaves the panel: a layout that brings
        // the panel up anyway shows the way back, as the PDF's does.
        let palette = cx.palette().clone();
        div()
            .id("synara-panel")
            .track_focus(&self.focus_handle)
            .size_full()
            .rounded_b(PANEL_RADIUS)
            .bg(palette.editor)
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.))
            .p(px(24.))
            .child(Icon::SQUARE_ARROW_OUT_UP_RIGHT.element(ICON_LARGE, palette.text_secondary))
            .child(
                div()
                    .text_role(TextRole::BodyCompact, cx)
                    .font_weight(lattice_ui::tokens::FONT_WEIGHT_SEMIBOLD)
                    .text_color(palette.text)
                    .child(t!("The Agent is in a separate window")),
            )
            .child(
                Button::new("agent-return", t!("Return to workspace"))
                    .compact()
                    .icon(Icon::SQUARE_ARROW_DOWN_LEFT)
                    .on_click(cx.listener(|this, _, _, cx| this.dock(true, cx))),
            )
    }
}
