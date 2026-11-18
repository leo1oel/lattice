//! One Synara surface: the Agent island's page (`gpui/islands/agent`) for
//! one project, as the Agent panel, the Git workspace or Settings ›
//! Providers, and everything its page asks of the app.
//!
//! The page is the Tauri app's Synara host, so what crosses this bridge is
//! what crossed the Tauri app's from that host to the rest of its window:
//!
//! - the page's `invoke`s (`tauri:invoke`), answered by `commands.rs`, and
//!   here those that need a window or the app (the save panel, the browser,
//!   the clipboard);
//! - its confirmations, in the app's confirm dialog, and its toasts and
//!   Synara's notifications, on the app's stack, all drawn above the page;
//! - what the Agent asks of the window (a file opened, a turn's review, the
//!   selection cleared, the narrowest the panel may be), as [`SurfaceEvent`]s
//!   for the panel's owner;
//! - what the window tells the Agent: the panel shown or brought forward,
//!   the writer's workspace (the host context's inputs), the interface
//!   language, and the theme beyond what the bridge's `host:theme` carries
//!   (the accent as chosen, translucency).
//!
//! The page's frame may load only the runtime's own origin, allowed once the
//! runtime says where it is (`synara_ensure_ready`), before the page is
//! answered.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, Focusable as _, InteractiveElement as _,
    IntoElement, MouseMoveEvent, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, Task, Window, canvas, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::{Locale, t};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    palette::{Accent, Palette},
};
use lattice_webview::{
    Bundle, FileScope, Island, IslandConfig, IslandEvent, IslandState, IslandTheme,
};
use serde_json::{Value, json};

use super::{
    commands,
    permission_mode::{PermissionMode, set_permission_mode},
    runtime,
};

mod annotations;
mod documents;
mod drops;
mod events;
mod invoke;
mod notices;
pub mod permission;
mod skeleton;

use events::surface_event;
pub use events::{SurfaceEvent, TurnReview};

/// Which of the page's three surfaces this is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceKind {
    /// The Agent panel (`trellis-agent-surface.tsx`).
    Agent,
    /// The Git workspace docked as a tool panel (`app-history-drawers.tsx`).
    Git,
    /// Settings › Providers, Synara's own settings page
    /// (`synara-settings-pane.tsx`).
    Settings,
}

impl SurfaceKind {
    fn name(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Git => "git",
            Self::Settings => "settings",
        }
    }
}

/// The least time between two pointer reports, as the Tauri host throttles
/// its `lattice:host-pointer` (`use-synara-host.ts`).
const POINTER_THROTTLE: Duration = Duration::from_millis(150);
/// How long a hidden Agent or Git workspace keeps its page before it is torn
/// down (its WebContent process alone is ~200 MB): long enough that toggling
/// the panel never reloads it, while a turn running or waiting holds it
/// however long (`hold_hibernation`). Synara's service, its threads and
/// terminals live on in the runtime and the page reattaches when shown.
const AGENT_HIBERNATE_AFTER: Duration = Duration::from_secs(180);
/// How long the writer's workspace must rest before the page hears of it.
const WORKSPACE_SETTLE: Duration = Duration::from_millis(80);

pub struct SynaraSurface {
    kind: SurfaceKind,
    island: Option<Entity<Island>>,
    /// Why there is no island: the pages are not built.
    unavailable: Option<String>,
    root: Option<PathBuf>,
    shown: bool,
    /// The page has drawn since it was (re)built.
    drawn: bool,
    /// When the Agent's page was asked to open, for its placeholder's
    /// loading clock (`skeleton.rs`), and the panel's width as last drawn.
    opening: Option<Instant>,
    width: std::rc::Rc<std::cell::Cell<gpui::Pixels>>,
    locale: Locale,
    /// What the page was last told of the appearance.
    appearance: Value,
    /// What the page was last told of the writer's workspace.
    workspace: Value,
    /// A workspace report waiting out the caret's movement.
    workspace_report: Option<Task<()>>,
    /// The Git workspace's view and pinned turn.
    git: Value,
    /// Settings' compact insets, for Settings' Synara pages.
    settings_compact: bool,
    /// The Synara settings section on screen (`providers`, `integrations`,
    /// `skills`, `usage`) and its Settings tab's label.
    settings_section: (&'static str, String),
    /// The Agent's own page previews' standing with Open Slide, made on
    /// the first (`documents.rs`).
    deck: Option<crate::structured::DeckSession>,
    /// What the page was last told of the project's Overleaf link.
    overleaf: Value,
    /// The last paths reported as Lattice's own writes, for a scenario,
    /// and how many were ever reported.
    host_writes: std::collections::VecDeque<String>,
    host_writes_reported: usize,
    /// The frame's permission mode, once it has said (`permission.rs`).
    permission: Option<permission::AgentPermission>,
    /// A model endpoint is saved, for the picker's note.
    endpoint_saved: bool,
    /// The paths of the Finder drop the page may read (`drops.rs`).
    dropped: Vec<String>,
    drop_read: Option<Result<usize, String>>,
    /// The project's annotations as the page last heard (`annotations.rs`).
    annotations: annotations::PageAnnotations,
    last_pointer: Option<Instant>,
    _subscriptions: Vec<Subscription>,
}

/// How many of Lattice's own writes [`SynaraSurface::host_writes`] keeps.
const HOST_WRITES_KEPT: usize = 32;

impl EventEmitter<SurfaceEvent> for SynaraSurface {}

impl SynaraSurface {
    pub fn new(kind: SurfaceKind, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let bundle = crate::structured::resources::islands_dir()
            .ok_or_else(|| {
                "The island pages are not built: run gpui/script/build-islands.".to_string()
            })
            .and_then(|dir| FileScope::new(dir).map_err(|error| format!("{error:#}")));
        let palette = cx.palette().clone();
        let mut subscriptions = vec![
            cx.observe_global::<lattice_ui::LatticeTheme>(|this, cx| this.push_appearance(cx)),
        ];
        let (island, unavailable) = match bundle {
            Ok(scope) => {
                let config = IslandConfig {
                    name: kind.name().into(),
                    entry: "agent/index.html",
                    bundle: Bundle::Directory(scope),
                    files: None,
                    ground: Some(ground(kind, &palette)),
                    reveal_on_ready: false,
                    theme: IslandTheme::Document,
                    hibernates: true,
                };
                let island = cx.new(|cx| {
                    let mut island = Island::new(config, window, cx);
                    if kind != SurfaceKind::Settings {
                        island.set_hibernate_after(AGENT_HIBERNATE_AFTER);
                    }
                    if kind == SurfaceKind::Agent {
                        island.accept_file_drops();
                    }
                    island
                });
                subscriptions.push(cx.subscribe_in(&island, window, Self::on_island));
                subscriptions.push(cx.observe(&island, |_, _, cx| cx.notify()));
                subscriptions.push(cx.on_release(|this: &mut Self, _| {
                    if let Some(root) = &this.root {
                        commands::forget_turn(root);
                    }
                }));
                (Some(island), None)
            }
            Err(error) => {
                log::error!("{}: {error}", kind.name());
                (None, Some(error))
            }
        };
        runtime::register(cx.entity().downgrade(), cx);
        let appearance = appearance(cx);
        Self {
            kind,
            island,
            unavailable,
            root: None,
            shown: false,
            drawn: false,
            opening: None,
            width: Default::default(),
            locale: lattice_i18n::locale(),
            appearance,
            workspace: Value::Null,
            workspace_report: None,
            git: json!({ "view": "changes", "turnReview": null, "remoteUrl": null }),
            settings_compact: false,
            settings_section: ("providers", String::new()),
            deck: None,
            overleaf: Value::Null,
            host_writes: std::collections::VecDeque::new(),
            host_writes_reported: 0,
            permission: None,
            endpoint_saved: false,
            dropped: Vec::new(),
            drop_read: None,
            annotations: Default::default(),
            last_pointer: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn island(&self) -> Option<&Entity<Island>> {
        self.island.as_ref()
    }

    pub fn kind(&self) -> SurfaceKind {
        self.kind
    }

    /// What the page was last told of the writer's workspace.
    pub fn workspace(&self) -> &Value {
        &self.workspace
    }

    pub fn is_drawn(&self) -> bool {
        self.drawn
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    /// The focus the panel hands out: the page's.
    pub fn focus_handle(&self, cx: &App) -> Option<gpui::FocusHandle> {
        self.island
            .as_ref()
            .map(|island| island.read(cx).focus_handle(cx))
    }

    fn post(&self, kind: &str, payload: Value, cx: &mut App) {
        if let Some(island) = &self.island {
            island.update(cx, |island, _| island.post(kind, payload));
        }
    }

    fn respond(&self, id: u64, result: Result<Value, String>, cx: &mut App) {
        if let Some(island) = &self.island {
            island.update(cx, |island, _| island.respond(id, result));
        }
    }

    /// The project the surface shows; none takes the page off screen.
    pub fn set_project(&mut self, root: Option<PathBuf>, cx: &mut Context<Self>) {
        if self.root == root {
            return;
        }
        if let Some(old) = &self.root {
            commands::forget_turn(old);
        }
        self.root = root;
        // A frame belongs to one project: another project's starts afresh
        // (the page keys its host by the project).
        self.workspace = Value::Null;
        self.overleaf = Value::Null;
        self.permission = None;
        self.deck = None;
        if self.kind == SurfaceKind::Agent {
            self.follow_annotations(cx);
        }
        self.open_page(cx);
        self.sync_active(cx);
        cx.notify();
    }

    /// The panel became, or stopped being, the one displayed.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if self.shown == shown {
            return;
        }
        self.shown = shown;
        self.post("agent:visible", json!({ "visible": shown }), cx);
        self.sync_active(cx);
        cx.notify();
    }

    fn sync_active(&mut self, cx: &mut Context<Self>) {
        let active = self.shown && self.root.is_some();
        if let Some(island) = &self.island {
            island.update(cx, |island, cx| island.set_active(active, cx));
        }
    }

    /// Lattice wrote these project files itself (`host_writes.rs`).
    pub(super) fn host_wrote(&mut self, paths: Vec<String>, cx: &mut App) {
        self.host_writes.extend(paths.iter().cloned());
        self.host_writes_reported += paths.len();
        let over = self.host_writes.len().saturating_sub(HOST_WRITES_KEPT);
        self.host_writes.drain(..over);
        self.post("agent:host-writes", json!({ "paths": paths }), cx);
    }

    /// How many paths were ever reported as Lattice's own writes, for a
    /// scenario to count from.
    pub fn host_writes_reported(&self) -> usize {
        self.host_writes_reported
    }

    /// The paths reported as Lattice's own writes since `count` were, as far
    /// as the last kept go, for a scenario.
    pub fn host_writes_since(&self, count: usize) -> impl Iterator<Item = &String> {
        let new = self.host_writes_reported.saturating_sub(count);
        let kept = self.host_writes.len();
        self.host_writes.iter().skip(kept.saturating_sub(new))
    }

    /// Hand `message` to the Agent's frame, as the Tauri host's
    /// `postMessage` does (a checkpoint's Undo, a build's result); dropped
    /// while no frame is up, as there.
    pub fn post_frame(&self, message: Value, cx: &mut App) {
        self.post("agent:frame-message", message, cx);
    }

    /// The panel was brought forward (its tab chosen, ⌘⌥3).
    pub fn opened(&self, cx: &mut App) {
        self.post("agent:opened", Value::Null, cx);
    }

    /// The writer's workspace, as the host context is built from it
    /// (`useAgentContext`'s inputs). Unchanged, nothing is sent; a caret on
    /// the move is reported once it rests, as the Tauri host waits a frame.
    pub fn set_workspace(&mut self, workspace: Value, cx: &mut Context<Self>) {
        if workspace == self.workspace {
            self.workspace_report = None;
            return;
        }
        self.workspace_report = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(WORKSPACE_SETTLE).await;
            this.update(cx, |this, cx| {
                this.workspace_report = None;
                if workspace != this.workspace {
                    this.workspace = workspace.clone();
                    this.post("agent:workspace", workspace, cx);
                }
            })
            .ok();
        }));
    }

    /// The Git workspace's view, and the turn it is pinned to.
    pub fn set_git(
        &mut self,
        view: &str,
        turn: Option<&TurnReview>,
        remote_url: Option<String>,
        cx: &mut App,
    ) {
        let git = json!({
            "view": view,
            "turnReview": turn.map(|turn| json!({
                "threadId": turn.thread_id,
                "turnId": turn.turn_id,
                "filePath": turn.file_path,
            })),
            "remoteUrl": remote_url,
        });
        if git == self.git {
            return;
        }
        self.git = git.clone();
        self.post("agent:git", git, cx);
    }

    /// Settings' insets, compact while the dialog is in its narrow form, and
    /// the Synara page on screen with its tab's label. The page switches
    /// sections in its loaded frame (`synara-settings-pane.tsx`).
    pub fn set_settings_layout(
        &mut self,
        compact: bool,
        section: &'static str,
        label: String,
        cx: &mut App,
    ) {
        let next = (section, label);
        if compact != self.settings_compact || next != self.settings_section {
            self.settings_compact = compact;
            self.settings_section = next;
            self.post_settings_layout(cx);
        }
    }

    fn post_settings_layout(&self, cx: &mut App) {
        let (section, label) = &self.settings_section;
        self.post(
            "agent:settings-layout",
            json!({ "compact": self.settings_compact, "section": section, "label": label }),
            cx,
        );
    }

    /// The Synara settings section Settings shows (`providers`,
    /// `integrations`, `skills`, `usage`).
    pub fn settings_section(&self) -> &'static str {
        self.settings_section.0
    }

    /// Open and reveal a place on Settings › Providers.
    pub fn reveal_setting(&self, target: &str, cx: &mut App) {
        self.post("agent:settings-target", json!({ "target": target }), cx);
    }

    /// One of the runtime's events, for the page's modules (`runtime.rs`).
    pub(super) fn runtime_event(&mut self, event: &str, payload: Value, cx: &mut App) {
        // The island holds it until the page listens; a hidden page hears it.
        self.post(
            "agent:runtime-event",
            json!({ "event": event, "payload": payload }),
            cx,
        );
    }

    /// Send the page everything it needs to show the surface.
    fn open_page(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.locale = lattice_i18n::locale();
        if !self.drawn && self.opening.is_none() {
            self.opening = Some(Instant::now());
        }
        let payload = json!({
            "surface": self.kind.name(),
            "projectRoot": root.to_string_lossy(),
            "locale": self.locale.tag(),
            "visible": self.shown,
            "appearance": self.appearance,
            "git": self.git,
        });
        self.post("agent:open", payload, cx);
        if self.kind == SurfaceKind::Settings {
            self.post_settings_layout(cx);
        }
        if !self.workspace.is_null() {
            self.post("agent:workspace", self.workspace.clone(), cx);
        }
        if !self.overleaf.is_null() {
            self.post("agent:overleaf", self.overleaf.clone(), cx);
        }
    }

    fn push_appearance(&mut self, cx: &mut Context<Self>) {
        let next = appearance(cx);
        if next != self.appearance {
            self.appearance = next.clone();
            self.post("agent:appearance", next, cx);
        }
    }

    /// The pointer moved over the app outside the page: Synara's hover
    /// states, which WebKit leaves stuck when the pointer leaves for GPUI,
    /// let go (`lattice:host-pointer`).
    fn pointer_elsewhere(&mut self, cx: &mut Context<Self>) {
        if !self.shown {
            return;
        }
        let now = Instant::now();
        if self
            .last_pointer
            .is_some_and(|last| now.duration_since(last) < POINTER_THROTTLE)
        {
            return;
        }
        self.last_pointer = Some(now);
        self.post("agent:pointer", Value::Null, cx);
    }

    fn on_island(
        &mut self,
        _: &Entity<Island>,
        event: &IslandEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            IslandEvent::Ready => {
                self.drawn = false;
                self.open_page(cx);
                if self.kind == SurfaceKind::Agent {
                    self.retell_annotations(cx);
                }
            }
            IslandEvent::Hibernated => {
                self.drawn = false;
                cx.notify();
            }
            IslandEvent::Message { kind, payload } => self.on_message(kind, payload, cx),
            IslandEvent::Request { id, kind, payload } => {
                self.on_request(*id, kind, payload.clone(), window, cx)
            }
            IslandEvent::FileDrop(payload) => self.file_dragged(payload, cx),
            IslandEvent::Focus(_) | IslandEvent::PointerDown => {}
        }
    }

    fn on_message(&mut self, kind: &str, payload: &Value, cx: &mut Context<Self>) {
        match kind {
            "agent:drawn" => {
                self.drawn = true;
                self.opening = None;
                if let Some(island) = &self.island {
                    island.update(cx, |island, cx| island.reveal(cx));
                }
                cx.notify();
            }
            "island:notify" => crate::structured::show_page_notice(
                payload,
                self.island.as_ref().map(gpui::Entity::downgrade),
                cx,
            ),
            "agent:notify" => self.synara_notice(payload, cx),
            "agent:permission" => self.permission_reported(payload, cx),
            // The Agent's checkpoints: the History panel's rows, and the
            // builds its turns' edits need (`shell/agent_checkpoints.rs`).
            "agent:history" => match super::checkpoints::parse_snapshot(payload) {
                Some(snapshot) => cx.emit(SurfaceEvent::History(snapshot)),
                None => log::debug!("{}: malformed agent:history", self.kind.name()),
            },
            "agent:permission-mode" => {
                if let Some(mode) = payload["mode"].as_str().and_then(PermissionMode::parse) {
                    set_permission_mode(mode, cx);
                }
            }
            _ => match surface_event(kind, payload) {
                Some(event) => {
                    if let SurfaceEvent::Turn(presence) = &event {
                        self.hold_page(presence.is_some(), cx);
                    }
                    cx.emit(event)
                }
                None => log::debug!("{}: unhandled {kind}", self.kind.name()),
            },
        }
    }

    /// A turn running or waiting keeps the page while hidden: its tool calls
    /// for the window and its approvals pass through the page.
    fn hold_page(&self, held: bool, cx: &mut Context<Self>) {
        if let Some(island) = &self.island {
            island.update(cx, |island, cx| island.hold_hibernation(held, cx));
        }
    }

    fn on_request(
        &mut self,
        id: u64,
        kind: &str,
        payload: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match kind {
            "island:confirm" => {
                let this = cx.entity().downgrade();
                crate::structured::ask_page_confirm(&payload, cx, move |answer, cx| {
                    this.update(cx, |this, cx| this.respond(id, Ok(answer), cx))
                        .ok();
                });
            }
            "tauri:invoke" => self.invoke(id, payload, window, cx),
            _ => match documents::document_request(id, kind, &payload) {
                Some(event) => cx.emit(event),
                None => self.respond(id, Err(format!("unknown request {kind}")), cx),
            },
        }
    }
}

/// The page's ground before it draws: the Agent panel's sidebar, the Git
/// workspace's tool surface (`trellis.css`'s `.trellis-agent-host`,
/// `.trellis-tool-host`) or Settings' page (`.settings-content`), so a load
/// never flashes another colour.
fn ground(kind: SurfaceKind, palette: &Palette) -> gpui::Hsla {
    match kind {
        SurfaceKind::Agent => palette.chrome,
        SurfaceKind::Git => palette.input,
        SurfaceKind::Settings => palette.panel,
    }
}

/// What the page needs of the appearance beyond the root element's
/// attributes: the accent as the writer chose it (a preset's name, or the
/// custom colour as `#rrggbb`) and the window's translucency, which the
/// host theme snapshot carries (`agent-host-theme.ts`).
fn appearance(cx: &App) -> Value {
    let palette = cx.palette();
    let accent = match palette.accent_preset {
        Accent::Graphite => "graphite".to_string(),
        Accent::Blue => "blue".to_string(),
        Accent::Purple => "purple".to_string(),
        Accent::Pink => "pink".to_string(),
        Accent::Orange => "orange".to_string(),
        Accent::Green => "green".to_string(),
        Accent::Teal => "teal".to_string(),
        Accent::Custom(rgb) => format!("#{:06x}", rgb & 0xff_ffff),
        // The theme's accent as the colour the page shows, or Graphite.
        Accent::Theme => match palette.themed.as_ref().and_then(|themed| themed.accent) {
            Some(accent) => format!("#{:06x}", accent.rgb),
            None => "graphite".to_string(),
        },
    };
    let translucency = match crate::settings::get(cx).appearance.translucency {
        lattice_settings::Translucency::Off => "off",
        lattice_settings::Translucency::Subtle => "subtle",
        lattice_settings::Translucency::Strong => "strong",
    };
    json!({
        "accent": accent,
        "translucency": translucency,
        "translucent": crate::window_material::backing(cx) == crate::window_material::Backing::Translucent,
    })
}

impl Render for SynaraSurface {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The interface language changed (settings redraw every window).
        if lattice_i18n::locale() != self.locale {
            self.locale = lattice_i18n::locale();
            let locale = self.locale.tag();
            self.post("agent:locale", json!({ "locale": locale }), cx);
        }
        let palette = cx.palette().clone();
        let failure: Option<SharedString> = self
            .unavailable
            .clone()
            .or_else(|| {
                self.island
                    .as_ref()
                    .and_then(|island| match island.read(cx).state() {
                        IslandState::Failed(error) => Some(error.clone()),
                        _ => None,
                    })
            })
            .map(Into::into);
        let placeholder = self.awaiting_page().filter(|_| failure.is_none());
        let this = cx.entity().downgrade();
        div()
            .id(("synara-surface", self.kind as usize))
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(ground(self.kind, &palette))
            .children(lattice_ui::parity::probe(match self.kind {
                SurfaceKind::Agent => "agent/surface",
                SurfaceKind::Git => "git/surface",
                SurfaceKind::Settings => "settings/providers",
            }))
            // The pointer over the rest of the window, for Synara's hovers.
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| {
                        let this = this.clone();
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                            if phase.bubble() && !bounds.contains(&event.position) {
                                this.update(cx, |this, cx| this.pointer_elsewhere(cx)).ok();
                            }
                        });
                    },
                )
                .absolute()
                .size_full(),
            )
            .when_some(failure, |this, failure| {
                this.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap(px(4.))
                        .px(px(24.))
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text)
                                .child(t!("The Agent couldn’t start")),
                        )
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .text_center()
                                .child(failure),
                        ),
                )
            })
            // The panel the Agent opens on, until its page has drawn.
            .when_some(placeholder, |this, since| {
                this.child(skeleton::agent(since, self.width.clone(), window, cx))
            })
            .when(self.root.is_some(), |this| {
                this.children(self.island.clone())
            })
    }
}
