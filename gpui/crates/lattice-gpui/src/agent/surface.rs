//! One Synara surface: the Agent island's page (`gpui/islands/agent`) for
//! one project, as the Agent panel or the Git workspace, and everything its
//! page asks of the app.
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
//!   the writer's workspace (the host context's inputs), a prompt for the
//!   composer, the interface language, and the theme beyond what the
//!   bridge's `host:theme` carries (the accent as chosen, translucency).
//!
//! The page's frame may load only the runtime's own origin, allowed once the
//! runtime says where it is (`synara_ensure_ready`), before the page is
//! answered.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, Focusable as _, InteractiveElement as _, IntoElement,
    MouseMoveEvent, ParentElement as _, Render, SharedString, Styled as _, Subscription, Task,
    Window,
    canvas, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::{Locale, t};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::ToastLevel,
    palette::{Accent, Palette},
};
use lattice_webview::{
    Bundle, FileScope, Island, IslandConfig, IslandEvent, IslandState, IslandTheme,
};
use serde_json::{Value, json};

use super::{commands, runtime};
use crate::notices::{self, Notice, NoticeAction};

/// Which of the page's two surfaces this is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceKind {
    /// The Agent panel (`trellis-agent-surface.tsx`).
    Agent,
    /// The Git workspace docked as a tool panel (`app-history-drawers.tsx`).
    Git,
}

impl SurfaceKind {
    fn name(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Git => "git",
        }
    }
}

/// What the Agent asks of the window.
#[derive(Clone, Debug, PartialEq)]
pub enum SurfaceEvent {
    /// Open a project file the Agent named.
    OpenPath(String),
    /// Open the Git workspace, pinned to one turn's checkpoint diff when given.
    OpenReview(Option<TurnReview>),
    /// Open Settings on the Agent's providers.
    OpenProviderSettings,
    /// The selection the Agent was shown is spent.
    ClearSelection,
    /// The narrowest the Agent's panel can be with its composer intact.
    MinimumWidth(f32),
    /// The Git workspace's view tab was chosen.
    GitView(String),
    /// The Git workspace's close button.
    CloseGit,
}

/// A turn's checkpoint diff, reviewable after the working tree moved on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnReview {
    pub thread_id: String,
    pub turn_id: String,
    pub file_path: Option<String>,
}

/// The least time between two pointer reports, as the Tauri host throttles
/// its `lattice:host-pointer` (`use-synara-host.ts`).
const POINTER_THROTTLE: Duration = Duration::from_millis(150);
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
    locale: Locale,
    /// What the page was last told of the appearance.
    appearance: Value,
    /// What the page was last told of the writer's workspace.
    workspace: Value,
    /// A workspace report waiting out the caret's movement.
    workspace_report: Option<Task<()>>,
    /// The Git workspace's view and pinned turn.
    git: Value,
    last_pointer: Option<Instant>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SurfaceEvent> for SynaraSurface {}

impl SynaraSurface {
    pub fn new(kind: SurfaceKind, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let bundle = crate::structured::resources::islands_dir()
            .ok_or_else(|| {
                "The island pages are not built: run gpui/script/build-islands.".to_string()
            })
            .and_then(|dir| FileScope::new(dir).map_err(|error| format!("{error:#}")));
        let palette = cx.palette().clone();
        let mut subscriptions = vec![cx.observe_global::<lattice_ui::LatticeTheme>(|this, cx| {
            this.push_appearance(cx)
        })];
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
                    // A hidden Agent may still own a turn or a terminal.
                    hibernates: false,
                };
                let island = cx.new(|cx| Island::new(config, window, cx));
                subscriptions.push(cx.subscribe_in(&island, window, Self::on_island));
                subscriptions.push(cx.observe(&island, |_, _, cx| cx.notify()));
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
            locale: lattice_i18n::locale(),
            appearance,
            workspace: Value::Null,
            workspace_report: None,
            git: json!({ "view": "changes", "turnReview": null, "remoteUrl": null }),
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
        self.root = root;
        // A frame belongs to one project: another project's starts afresh
        // (the page keys its host by the project).
        self.workspace = Value::Null;
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

    /// Put a prompt into the Agent's composer, or send it
    /// (`AgentComposerPromptMessage`); the page waits for its frame.
    pub fn compose(&self, message: Value, cx: &mut App) {
        self.post("agent:compose", message, cx);
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
        let payload = json!({
            "surface": self.kind.name(),
            "projectRoot": root.to_string_lossy(),
            "locale": self.locale.tag(),
            "visible": self.shown,
            "appearance": self.appearance,
            "git": self.git,
        });
        self.post("agent:open", payload, cx);
        if !self.workspace.is_null() {
            self.post("agent:workspace", self.workspace.clone(), cx);
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
            }
            IslandEvent::Hibernated => {
                self.drawn = false;
                cx.notify();
            }
            IslandEvent::Message { kind, payload } => self.on_message(kind, payload, cx),
            IslandEvent::Request { id, kind, payload } => {
                self.on_request(*id, kind, payload.clone(), window, cx)
            }
            IslandEvent::Focus(_) | IslandEvent::PointerDown => {}
        }
    }

    fn on_message(&mut self, kind: &str, payload: &Value, cx: &mut Context<Self>) {
        let text = |key: &str| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        match kind {
            "agent:drawn" => {
                self.drawn = true;
                if let Some(island) = &self.island {
                    island.update(cx, |island, cx| island.reveal(cx));
                }
                cx.notify();
            }
            "island:notify" => crate::structured::show_page_notice(payload, cx),
            "agent:notify" => self.synara_notice(payload, cx),
            "agent:open-path" => {
                if let Some(path) = text("path") {
                    cx.emit(SurfaceEvent::OpenPath(path));
                }
            }
            "agent:open-review" => {
                let turn = match (text("threadId"), text("turnId")) {
                    (Some(thread_id), Some(turn_id)) => Some(TurnReview {
                        thread_id,
                        turn_id,
                        file_path: None,
                    }),
                    _ => None,
                };
                cx.emit(SurfaceEvent::OpenReview(turn));
            }
            "agent:open-settings" => cx.emit(SurfaceEvent::OpenProviderSettings),
            "agent:clear-selection" => cx.emit(SurfaceEvent::ClearSelection),
            "agent:minimum-width" => {
                if let Some(width) = payload.get("width").and_then(Value::as_f64) {
                    cx.emit(SurfaceEvent::MinimumWidth(width as f32));
                }
            }
            "agent:git-view" => {
                if let Some(view) = text("view") {
                    cx.emit(SurfaceEvent::GitView(view));
                }
            }
            "agent:close-git" => cx.emit(SurfaceEvent::CloseGit),
            // The Agent's checkpoints, for the History panel's Agent filter,
            // which reads the project's own activity log instead.
            "agent:history" => {}
            _ => log::debug!("{}: unhandled {kind}", self.kind.name()),
        }
    }

    /// One of Synara's notifications (`synara-notifications.ts`'s parsed
    /// message), on the app's stack under its id: a later one with the same
    /// id replaces it, a loading one runs until its outcome does, and its
    /// buttons answer the frame.
    fn synara_notice(&mut self, payload: &Value, cx: &mut Context<Self>) {
        let text = |key: &str| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        let Some(id) = text("id") else { return };
        let key = format!("synara:{}:{id}", self.kind.name());
        if text("operation").as_deref() == Some("dismiss") {
            // Only a running one follows Synara's close; a finished one keeps
            // the app's own display time (as the Tauri host does).
            if notices::is_running(&key, cx) {
                notices::dismiss(&key, cx);
            }
            return;
        }
        let level = text("level").unwrap_or_default();
        let mut notice = Notice::new(
            match level.as_str() {
                "error" => ToastLevel::Error,
                "warning" => ToastLevel::Warning,
                "success" => ToastLevel::Success,
                _ => ToastLevel::Info,
            },
            text("title").unwrap_or_default(),
        )
        .key(key);
        if let Some(detail) = text("detail") {
            notice = notice.detail(detail);
        }
        let timeout = payload.get("timeoutMs").and_then(Value::as_f64);
        if level == "loading" {
            notice = notice.running();
        } else if timeout == Some(0.) {
            notice = notice.persistent();
        }
        for (label, action) in [
            (text("primaryActionLabel"), "primary"),
            (text("secondaryActionLabel"), "secondary"),
        ] {
            let Some(label) = label else { continue };
            let this = cx.entity().downgrade();
            let id = id.clone();
            notice = notice.action(NoticeAction::new(label, move |_, cx| {
                this.update(cx, |this, cx| {
                    this.post(
                        "agent:notify-action",
                        json!({ "id": id, "action": action }),
                        cx,
                    )
                })
                .ok();
            }));
        }
        notices::show(notice, cx);
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
            _ => self.respond(id, Err(format!("unknown request {kind}")), cx),
        }
    }

    fn invoke(&mut self, id: u64, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let command = payload
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let args = payload.get("args").cloned().unwrap_or(Value::Null);
        let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
        match command.as_str() {
            "plugin:dialog|save" => {
                let suggested = args
                    .get("options")
                    .and_then(|options| options.get("defaultPath"))
                    .and_then(Value::as_str)
                    .and_then(|path| Path::new(path).file_name())
                    .map(|name| name.to_string_lossy().into_owned());
                let directory = dirs::document_dir()
                    .or_else(dirs::home_dir)
                    .or_else(|| self.root.clone())
                    .unwrap_or_default();
                let chosen = cx.prompt_for_new_path(&directory, suggested.as_deref());
                cx.spawn_in(window, async move |this, cx| {
                    let answer = match chosen.await {
                        Ok(Ok(Some(path))) => Ok(json!(path.to_string_lossy())),
                        Ok(Ok(None)) | Err(_) => Ok(Value::Null),
                        Ok(Err(error)) => Err(format!("{error:#}")),
                    };
                    this.update(cx, |this, cx| this.respond(id, answer, cx))
                        .ok();
                })
                .detach();
            }
            // Web links only: WebKit does not hand an embedded frame's
            // `_blank` navigation to the browser, so the host does.
            "plugin:opener|open_url" => {
                let url = text("url").unwrap_or_default();
                let lower = url.to_ascii_lowercase();
                if lower.starts_with("https://") || lower.starts_with("http://") {
                    cx.open_url(&url);
                    self.respond(id, Ok(Value::Null), cx);
                } else {
                    self.respond(id, Err("Only web links open in the browser.".into()), cx);
                }
            }
            "plugin:clipboard-manager|write_text" => {
                let text = text("text").unwrap_or_default();
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                self.respond(id, Ok(Value::Null), cx);
            }
            _ if commands::handles(&command) => {
                let Some(root) = self.root.clone() else {
                    self.respond(id, Err("No project is open.".into()), cx);
                    return;
                };
                let task = commands::invoke(&root, &command, &payload, cx);
                let ensures = command == "synara_ensure_ready";
                cx.spawn(async move |this, cx| {
                    let result = task.await;
                    this.update(cx, |this, cx| {
                        // The frame may load the runtime's origin, and nothing
                        // else, before the page learns where it is.
                        if ensures
                            && let Ok(info) = &result
                            && let Some(origin) = info.get("origin").and_then(Value::as_str)
                            && let Some(island) = &this.island
                        {
                            island.update(cx, |island, _| island.allow_frame_origin(origin));
                        }
                        this.respond(id, result, cx);
                    })
                    .ok();
                })
                .detach();
            }
            _ => {
                log::warn!("{}: refused {command}", self.kind.name());
                self.respond(
                    id,
                    Err(format!("{command} is not available in the GPUI preview")),
                    cx,
                );
            }
        }
    }
}

/// The page's ground before it draws: the Agent panel's sidebar, or the Git
/// workspace's tool surface (`trellis.css`'s `.trellis-agent-host`,
/// `.trellis-tool-host`), so a load never flashes another colour.
fn ground(kind: SurfaceKind, palette: &Palette) -> gpui::Hsla {
    match kind {
        SurfaceKind::Agent => palette.chrome,
        SurfaceKind::Git => palette.input,
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
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            .when(self.root.is_some(), |this| {
                this.children(self.island.clone())
            })
    }
}
