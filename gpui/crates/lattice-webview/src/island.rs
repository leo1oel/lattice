//! An island: a web page living in a GPUI panel.
//!
//! The Tauri app is one web page, so its few surfaces that stay web content
//! in the GPUI app (the Agent, boards, sheets, slide decks, the visual
//! Markdown editor, the HTML viewer) were iframes there. Here each is an
//! [`Island`]: a WKWebView (WebView2, WebKitGTK) placed over its panel by
//! gpui-webview on gpui-fast's window composition, so GPUI's overlays
//! (menus, popovers, tooltips, the palette, toasts and sheets, all drawn
//! deferred) stay above the page. The island owns everything every one of
//! them needs, so their lanes add only their own page and protocol:
//!
//! - **Lifecycle.** Nothing is built until the island is first shown (a
//!   WebContent process costs 60 MB before the page does anything); the
//!   owner says when it is shown with [`Island::set_active`], since a native
//!   view whose element stops being painted stays on screen. Hidden for
//!   [`HIBERNATE_AFTER`] (the Tauri app's `use-hibernation.ts`; an owner may
//!   set its own, [`Island::set_hibernate_after`]), it is torn down, and
//!   built again when shown, the owner restoring the page's state on
//!   [`IslandEvent::Ready`] as it did the first time; an owner whose page
//!   still works while hidden holds it ([`Island::hold_hibernation`]).
//!   Messages posted before the page listens wait for it, the latest of each
//!   event only.
//! - **Reveal.** Until the owner says the page has drawn what it should
//!   ([`Island::reveal`], or at once with [`IslandConfig::reveal_on_ready`]),
//!   the page is laid out at its real size but clipped away, so the owner's
//!   GPUI placeholder shows and the page's first visible frame is a loaded one.
//! - **The bridge** (`bridge.rs`): events and requests both ways, the page's
//!   focus and presses, the theme, and the app's shortcuts pressed in the page
//!   (only those the host last relayed to it, and that the page did not
//!   handle itself), all from the main frame alone.
//! - **The asset protocol and file bridge** (`protocol.rs`, `files.rs`): the
//!   page and the project files granted to it, never anything else; no frame
//!   navigates anywhere but the island's own bundle.
//! - **Focus.** When the page takes the keyboard, GPUI's focus moves to the
//!   island, so the app's key context is the island's (AppKit says when, as
//!   the page's view becomes first responder, and the bridge where it
//!   cannot); when GPUI's focus
//!   leaves the island while the page still holds AppKit's first responder
//!   (a shortcut from the page opened the palette, or GPUI moved focus while
//!   the window was inactive), the first responder goes back to GPUI's view.
//!   This is the Phase 0 spike's fix (`data/gpui-p0-webview-spike`, §4.3).
//! - **Drawn or not.** A native view stays where it was put when its element
//!   stops being painted (another panel maximized over it, its group zoomed
//!   away), and gpui-fast replays a retained view without running its
//!   elements, so "painted this frame" cannot be watched. What survives a
//!   replay is the frame's dispatch tree: the island's own focus node holds
//!   the page's while the island is on screen. After every layout change
//!   ([`check_drawn_after_frame`]) and every 250 ms while shown, an island
//!   whose node is gone hides its page until it is drawn again.
//! - **Windows.** An island is drawn in one window at a time, and its page
//!   follows the window that draws it: drawn in another (the Agent moved
//!   into a window of its own), the page's view moves there as it is,
//!   without a reload ([`Island::move_to_window`]), and what the island
//!   hears of its window (activation, the page's focus, its tasks) is that
//!   window's from then on.
//! - **Overlays and drags.** GPUI's presses outside the page reach it as
//!   `host:outside-pointerdown`, so it closes its own popups; while a dock
//!   panel is dragged anywhere in the window every island steps aside
//!   ([`set_dock_dragging`]), since the page would hide the drop targets.
//!
//! - **Frames from elsewhere.** A page may frame another origin only once its
//!   owner allows that origin ([`Island::allow_frame_origin`]): the slides
//!   island frames the Open Slide runtime, a loopback server whose port is
//!   known only after it starts.
//!
//! The sheet island writes nothing through the bridge: its owner
//! holds the file's text and saves it as every document is saved
//! (lattice-core's editor transaction), and the slides island's saves are
//! mutations its owner applies through lattice-core too. The Agent's island
//! is held while a turn runs or waits, since the turn's tool calls for the
//! window pass through its page.

use std::time::Duration;

use anyhow::Result;
use gpui::{
    App, Bounds, Context, ElementId, Entity, EventEmitter, FocusHandle, Focusable, Hsla,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Render, SharedString,
    Styled as _, Subscription, Task, Window, div,
};
use gpui_webview::WebView;
use lattice_ui::ActiveLattice as _;
use serde_json::{Value, json};

use crate::{
    bridge::{self, Inbound, Outbound},
    files::FileScope,
    held::hold,
    keys,
    masked::Masked,
    native::{insert_text, native_frame, native_page_focused, page_undo_script},
    navigation::{FrameOrigins, exact_origin},
    protocol::{self, Bundle, Served},
    registry::Registry,
    theme::{IslandTheme, theme_payload},
};

mod build;
mod file_drops;
mod page_focus;
mod windows;

use windows::activation;
pub(crate) use windows::update_in_home;

/// How long a hidden island keeps its page: the Tauri app's
/// `HIBERNATE_AFTER_MS`.
pub const HIBERNATE_AFTER: Duration = Duration::from_secs(20);
/// How often a shown island checks that it is still drawn.
const DRAWN_POLL: Duration = Duration::from_millis(250);

/// What an island is.
#[derive(Clone)]
pub struct IslandConfig {
    /// Its name, for logs and the scripted checks: `html-preview`.
    pub name: SharedString,
    /// The page, as a path in its bundle: `html-preview/index.html`.
    pub entry: &'static str,
    pub bundle: Bundle,
    /// The project its files come from, if it reads any.
    pub files: Option<FileScope>,
    /// The page's ground before it draws, so a reload never flashes white.
    pub ground: Option<Hsla>,
    /// Reveal the page as soon as its script reports ready, rather than when
    /// the owner calls [`Island::reveal`].
    pub reveal_on_ready: bool,
    /// How the page takes the host's theme.
    pub theme: IslandTheme,
    /// Whether the page is torn down after it has been hidden a while
    /// ([`HIBERNATE_AFTER`], or the owner's [`Island::set_hibernate_after`]).
    pub hibernates: bool,
}

/// Where the island is in its life.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IslandState {
    /// Not built: never shown yet.
    Cold,
    /// Built; its page has not reported ready.
    Loading,
    Ready,
    /// Torn down after being hidden; built again when shown.
    Hibernated,
    /// The webview could not be built.
    Failed(String),
}

/// What the island tells its owner.
#[derive(Clone, Debug)]
pub enum IslandEvent {
    /// The page is listening: send it its state. Comes again after every
    /// rebuild (a hibernation, a reload).
    Ready,
    /// An event from the page.
    Message { kind: String, payload: Value },
    /// A request from the page that the island does not answer itself;
    /// answer it with [`Island::respond`].
    Request {
        id: u64,
        kind: String,
        payload: Value,
    },
    /// The page took or gave up the keyboard.
    Focus(bool),
    /// A phase of a Finder drag, from the host alone
    /// ([`Island::accept_file_drops`]): no page message can produce it.
    FileDrop(Value),
    /// A press in the page.
    PointerDown,
    /// The island was torn down while hidden.
    Hibernated,
}

/// Counters the scripted checks read.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct IslandStats {
    /// Webviews built: 1 for a page shown once, one more per wake.
    pub builds: usize,
    pub hibernations: usize,
    /// The app's shortcuts forwarded from the page.
    pub shortcuts: usize,
    /// Messages from frames other than the page's own, and shortcuts outside
    /// the relay set, dropped.
    pub rejected: usize,
    /// Presses in the page.
    pub presses: usize,
    /// The last relay set sent to the page.
    pub relay: Vec<String>,
}

pub struct Island {
    config: IslandConfig,
    served: Served,
    frame_origins: FrameOrigins,
    state: IslandState,
    webview: Option<Entity<WebView>>,
    /// The raw page, held with the entity and dropped with it.
    handle: Option<gpui_webview::WebViewHandle>,
    focus_handle: FocusHandle,
    /// The owner shows the island.
    active: bool,
    /// The owner (or the ready page) lets the page be seen.
    revealed: bool,
    /// A dock panel is being dragged.
    stepped_aside: bool,
    /// The island was in the last frame the window drew.
    drawn: bool,
    pub(crate) window: gpui::AnyWindowHandle,
    /// The window the island was made in, where its tasks fall back to
    /// while the window it moved to is closing.
    origin: gpui::AnyWindowHandle,
    page_ready: bool,
    page_focused: bool,
    /// The webview's bridge token, which only its main frame knows.
    token: String,
    /// Messages posted before the page was listening.
    queue: Vec<Outbound>,
    building: bool,
    hibernation: Option<Task<()>>,
    /// How long a hidden page is kept before it is torn down.
    hibernate_after: Duration,
    /// The owner keeps the page while hidden ([`Island::hold_hibernation`]).
    hibernation_held: bool,
    stats: IslandStats,
    /// Files dragged in from the Finder come to the owner instead of the
    /// page ([`Island::accept_file_drops`]).
    file_drops: bool,
    _inbox: Option<Task<()>>,
    _drops: Option<Task<()>>,
    /// The page's view taking AppKit's keyboard (`native::watch_keyboard`).
    _keyboard: Option<Task<()>>,
    _drawn_poll: Option<Task<()>>,
    _webview_subscriptions: Vec<Subscription>,
    /// The window's activation, in the window the island is in.
    _window_subscriptions: Vec<Subscription>,
    _subscriptions: Vec<Subscription>,
}

impl Island {
    pub fn new(config: IslandConfig, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let served = Served::new(config.bundle.clone(), config.files.clone());
        let subscriptions = vec![cx.observe_global::<lattice_ui::LatticeTheme>(|this, cx| {
            this.push_theme(cx);
        })];
        Registry::add(cx.entity().downgrade(), cx);
        Self {
            config,
            served,
            frame_origins: FrameOrigins::default(),
            state: IslandState::Cold,
            webview: None,
            handle: None,
            focus_handle: cx.focus_handle(),
            active: false,
            revealed: false,
            stepped_aside: false,
            drawn: true,
            window: window.window_handle(),
            origin: window.window_handle(),
            page_ready: false,
            page_focused: false,
            token: String::new(),
            queue: Vec::new(),
            building: false,
            hibernation: None,
            hibernate_after: HIBERNATE_AFTER,
            hibernation_held: false,
            stats: IslandStats::default(),
            file_drops: false,
            _inbox: None,
            _drops: None,
            _keyboard: None,
            _drawn_poll: None,
            _webview_subscriptions: Vec::new(),
            _window_subscriptions: vec![activation(window, cx)],
            _subscriptions: subscriptions,
        }
    }

    pub fn state(&self) -> &IslandState {
        &self.state
    }

    pub fn is_ready(&self) -> bool {
        self.page_ready
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn is_revealed(&self) -> bool {
        self.revealed
    }

    pub fn page_focused(&self) -> bool {
        self.page_focused
    }

    /// The window the page is in.
    pub fn window(&self) -> gpui::AnyWindowHandle {
        self.window
    }

    /// Whether the page's view holds AppKit's keyboard now (macOS; false
    /// where the platform cannot say), for the scripted checks.
    pub fn holds_keyboard(&self, cx: &App) -> bool {
        self.native_focus(cx) == Some(true)
    }

    pub fn stats(&self) -> &IslandStats {
        &self.stats
    }

    /// The project files the protocol has served the page, in order.
    pub fn served_files(&self) -> Vec<String> {
        self.served.log.borrow().clone()
    }

    /// Whether the native view is on screen now.
    pub fn native_visible(&self, cx: &App) -> bool {
        self.webview
            .as_ref()
            .is_some_and(|webview| webview.read(cx).visible())
    }

    /// The page's bounds in the window as last laid out.
    pub fn bounds(&self, cx: &App) -> Option<Bounds<Pixels>> {
        self.webview
            .as_ref()
            .map(|webview| webview.read(cx).bounds())
    }

    /// The page's native view in the window, in points (macOS), for a
    /// scenario to check it against [`Island::bounds`].
    pub fn native_frame(&self, cx: &App) -> Option<Bounds<Pixels>> {
        self.webview
            .as_ref()
            .and_then(|webview| native_frame(webview.read(cx)))
    }

    /// The Edit menu's Undo or Redo, with the page focused. The menu holds ⌘Z
    /// and ⌘⇧Z, so a press of either in the page reaches GPUI as the menu's
    /// action and never reaches the page: in the visual Markdown page nothing
    /// typed could be undone. The page gets the press it stands for.
    pub fn undo(&self, redo: bool, cx: &App) {
        drop(self.evaluate(&page_undo_script(redo), cx));
    }

    /// Whether the keyboard is in the page in `window`: AppKit's first
    /// responder is its view.
    pub fn focused(&self, window: &Window, cx: &App) -> bool {
        self.window == window.window_handle()
            && self
                .webview
                .as_ref()
                .and_then(|webview| native_page_focused(webview.read(cx)))
                .unwrap_or(false)
    }

    /// Commit `text` to the page's view as an input method does (macOS), for
    /// a scenario.
    pub fn insert_text(&self, text: &str, cx: &App) {
        if let Some(webview) = &self.webview {
            insert_text(webview.read(cx), text);
        }
    }

    /// Let the page load the project file `relative` through the protocol.
    pub fn grant(&self, relative: &str) -> String {
        self.served.grants.borrow_mut().grant(relative);
        protocol::asset_url(relative)
    }

    /// Let the page's frames load `origin` (`http://127.0.0.1:52011`), its
    /// pages and their navigations within it. Only an exact
    /// `scheme://host[:port]` is accepted; anything else is ignored.
    pub fn allow_frame_origin(&mut self, origin: &str) {
        let Some(origin) = exact_origin(origin) else {
            log::warn!("{}: not an origin: {origin:?}", self.config.name);
            return;
        };
        if let Ok(mut origins) = self.frame_origins.lock() {
            origins.insert(origin);
        }
    }

    /// Show or hide the island. The owner calls this whenever its panel
    /// becomes or stops being the visible one, and whenever it stops
    /// rendering the island (another view of the document), since the page's
    /// native view does not hide by not being painted.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active == active {
            return;
        }
        self.active = active;
        if active {
            self.hibernation = None;
        } else {
            self.schedule_hibernation(cx);
        }
        self.sync_native_visibility(cx);
        cx.notify();
    }

    /// Let the page be seen (its first frame is ready).
    pub fn reveal(&mut self, cx: &mut Context<Self>) {
        if !self.revealed {
            self.revealed = true;
            cx.notify();
        }
    }

    /// Post an event to the page; held until it is listening.
    pub fn post(&mut self, kind: impl Into<String>, payload: Value) {
        self.send(Outbound::event(kind, payload));
    }

    /// Answer a request [`IslandEvent::Request`] carried.
    pub fn respond(&mut self, id: u64, result: Result<Value, String>) {
        self.send(Outbound::response(id, result));
    }

    /// Run `script` in the page and hand back what it evaluates to, as
    /// JSON; for the scripted checks.
    pub fn evaluate(&self, script: &str, cx: &App) -> futures::channel::oneshot::Receiver<String> {
        let (sender, receiver) = futures::channel::oneshot::channel();
        if let Some(webview) = &self.webview {
            let sender = std::sync::Mutex::new(Some(sender));
            let result = webview
                .read(cx)
                .evaluate_script_with_callback(script, move |value| {
                    if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                        sender.send(value).ok();
                    }
                });
            if let Err(error) = result {
                log::warn!("{}: evaluate failed: {error}", self.config.name);
            }
        }
        receiver
    }

    /// Keep a hidden page this long before tearing it down, rather than
    /// [`HIBERNATE_AFTER`]: a page that is slow to build again.
    pub fn set_hibernate_after(&mut self, after: Duration) {
        self.hibernate_after = after;
    }

    /// Keep the page while hidden, or let it hibernate again: the owner's
    /// page is doing work the window needs (the Agent's running turn).
    pub fn hold_hibernation(&mut self, held: bool, cx: &mut Context<Self>) {
        if self.hibernation_held == held {
            return;
        }
        self.hibernation_held = held;
        if held {
            self.hibernation = None;
        } else if !self.active && self.webview.is_some() {
            self.schedule_hibernation(cx);
        }
    }

    /// Tear the page down now rather than after the hidden period; for the
    /// scripted checks and for memory pressure.
    pub fn hibernate(&mut self, cx: &mut Context<Self>) {
        if self.active || self.webview.is_none() || !self.config.hibernates || self.hibernation_held
        {
            return;
        }
        self.webview = None;
        self.handle = None;
        self._inbox = None;
        self._keyboard = None;
        self._drawn_poll = None;
        self._webview_subscriptions.clear();
        self.page_ready = false;
        self.page_focused = false;
        self.revealed = false;
        self.queue.clear();
        self.served.grants.borrow_mut().clear();
        self.state = IslandState::Hibernated;
        self.stats.hibernations += 1;
        log::debug!("{}: hibernated", self.config.name);
        cx.emit(IslandEvent::Hibernated);
        cx.notify();
    }

    fn schedule_hibernation(&mut self, cx: &mut Context<Self>) {
        if !self.config.hibernates || self.hibernation_held {
            return;
        }
        let after = Registry::hibernate_after(cx).unwrap_or(self.hibernate_after);
        self.hibernation = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(after).await;
            this.update(cx, |this, cx| {
                if !this.active {
                    this.hibernate(cx);
                }
            })
            .ok();
        }));
    }

    pub(crate) fn set_stepped_aside(&mut self, stepped_aside: bool, cx: &mut Context<Self>) {
        if self.stepped_aside != stepped_aside {
            self.stepped_aside = stepped_aside;
            self.sync_native_visibility(cx);
            cx.notify();
        }
    }

    /// Hide the page while the island is not in the window's last frame,
    /// and show it again once it is.
    pub fn check_drawn(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(webview) = &self.webview else {
            return;
        };
        let page = webview.read(cx).focus_handle(cx);
        let drawn = self.focus_handle.contains(&page, window);
        if drawn != self.drawn {
            self.drawn = drawn;
            self.sync_native_visibility(cx);
            if drawn {
                cx.notify();
            }
        }
    }

    fn sync_native_visibility(&mut self, cx: &mut Context<Self>) {
        let visible = self.active && !self.stepped_aside && self.drawn;
        if let Some(webview) = &self.webview {
            webview.update(cx, |webview, _| {
                if webview.visible() != visible
                    && let Err(error) = webview.set_visible(visible)
                {
                    log::warn!("island visibility: {error}");
                }
            });
        }
    }

    fn send(&mut self, message: Outbound) {
        if !self.page_ready {
            hold(&mut self.queue, message);
            return;
        }
        self.deliver(message);
    }

    /// Posting needs no borrow of the app: an island posts from inside its
    /// own updates and its owner's, so it keeps the raw page beside the entity.
    fn deliver(&self, message: Outbound) {
        if let Some(handle) = &self.handle
            && let Err(error) = handle.raw().evaluate_script(&message.script())
        {
            log::warn!("{}: deliver failed: {error}", self.config.name);
        }
    }

    fn push_theme(&mut self, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
            let theme = if cx.palette().is_dark() {
                wry::Theme::Dark
            } else {
                wry::Theme::Light
            };
            if let Err(error) = webview.read(cx).set_theme(theme) {
                log::warn!("{}: theme: {error}", self.config.name);
            }
        }
        if self.page_ready {
            let payload = theme_payload(self.config.theme, cx);
            self.deliver(Outbound::event("host:theme", payload));
        }
    }

    fn receive(&mut self, sender: &str, body: &str, window: &mut Window, cx: &mut Context<Self>) {
        let message = match bridge::parse(sender, &self.token, body) {
            Ok(message) => message,
            Err(reason) => {
                self.stats.rejected += 1;
                log::warn!("{}: dropped {reason}", self.config.name);
                return;
            }
        };
        match message {
            Inbound::Ready => {
                self.page_ready = true;
                self.state = IslandState::Ready;
                let theme = theme_payload(self.config.theme, cx);
                self.deliver(Outbound::event("host:theme", theme));
                for message in std::mem::take(&mut self.queue) {
                    self.deliver(message);
                }
                if self.config.reveal_on_ready {
                    self.revealed = true;
                }
                cx.emit(IslandEvent::Ready);
                cx.notify();
            }
            Inbound::Event { kind, .. } if kind.starts_with("island:file-drop") => {
                self.stats.rejected += 1;
                log::warn!("{}: dropped a page-posted {kind}", self.config.name);
            }
            Inbound::Event { kind, payload } => {
                cx.emit(IslandEvent::Message { kind, payload });
            }
            Inbound::Request { id, kind, payload } => {
                if let Some(result) = self.answer_files(&kind, &payload) {
                    self.respond(id, result);
                } else {
                    cx.emit(IslandEvent::Request { id, kind, payload });
                }
            }
            Inbound::Focus { focused } => {
                // AppKit knows better than the page: a page in a window that
                // is not key reports no focus, and moving into one of its
                // frames blurs its main frame.
                let focused = self.native_focus(cx).unwrap_or(focused);
                self.set_page_focused(focused, window, cx);
            }
            Inbound::Shortcut(key) => {
                if !self.stats.relay.contains(&key.combo()) {
                    self.stats.rejected += 1;
                    log::warn!("{}: dropped {}, not relayed", self.config.name, key.combo());
                    return;
                }
                let Some(keystroke) = key.keystroke() else {
                    return;
                };
                self.stats.shortcuts += 1;
                // Dispatched after this update: the action may well touch
                // the island's owner, which is being updated now.
                let this = cx.entity().downgrade();
                window.defer(cx, move |window, cx| {
                    window.dispatch_keystroke(keystroke, cx);
                    this.update(cx, |this, cx| this.sync_native_focus(window, cx))
                        .ok();
                });
            }
            Inbound::Pointerdown => {
                self.stats.presses += 1;
                if self.native_focus(cx) == Some(true) {
                    self.set_page_focused(true, window, cx);
                }
                cx.emit(IslandEvent::PointerDown);
            }
        }
    }

    /// Whether the page holds the window's keyboard, as the platform says;
    /// `None` where it cannot say.
    fn native_focus(&self, cx: &App) -> Option<bool> {
        let webview = self.webview.as_ref()?;
        native_page_focused(webview.read(cx))
    }

    /// The page took or gave up the keyboard: GPUI's focus moves to the
    /// island with it, so the app's key context is the island's, and the
    /// page learns which of the keys typed in it are the app's.
    fn set_page_focused(&mut self, focused: bool, window: &mut Window, cx: &mut Context<Self>) {
        let changed = self.page_focused != focused;
        self.page_focused = focused;
        if focused && let Some(webview) = &self.webview {
            let handle = webview.read(cx).focus_handle(cx);
            if !handle.is_focused(window) {
                window.focus(&handle, cx);
            }
            // The island is the focused node now, so the key context stack
            // is the one its keys resolve in.
            // Sent on every focus: a page built again after a hibernation
            // starts without it, and the keymap may have changed meanwhile.
            let relay: Vec<String> = keys::relay_set(&window.context_stack(), cx)
                .into_iter()
                .collect();
            self.deliver(Outbound::event("host:relay", json!(relay)));
            self.stats.relay = relay;
        }
        if changed {
            cx.emit(IslandEvent::Focus(focused));
        }
    }

    /// The file bridge's own request: `files:read-text`, of a granted file.
    fn answer_files(&self, kind: &str, payload: &Value) -> Option<Result<Value, String>> {
        if kind != "files:read-text" {
            return None;
        }
        let Some(files) = &self.config.files else {
            return Some(Err("This page has no project files".into()));
        };
        let Some(path) = payload.get("path").and_then(Value::as_str) else {
            return Some(Err("No path".into()));
        };
        if !self.served.grants.borrow().contains(path) {
            return Some(Err(format!("{path} is not open to this page")));
        }
        Some(
            files
                .read_text(path)
                .map(Value::String)
                .map_err(|error| format!("{error:#}")),
        )
    }

    /// Hand AppKit's first responder back to GPUI when GPUI's focus is no
    /// longer the page's but the page still has the keyboard.
    fn sync_native_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(webview) = &self.webview else {
            return;
        };
        let handle = webview.read(cx).focus_handle(cx);
        if self.page_focused && !handle.is_focused(window) {
            // Only while the page's view still has it: another page's view
            // that has just taken it (a click from the Agent's composer into
            // the HTML preview) keeps it, or GPUI would show the preview
            // focused while its keys went to GPUI's view.
            if self.native_focus(cx) != Some(false)
                && let Err(error) = webview.read(cx).focus_parent()
            {
                log::warn!("{}: focus_parent: {error}", self.config.name);
            }
            self.page_focused = false;
        }
    }
}

impl EventEmitter<IslandEvent> for Island {}

impl Focusable for Island {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

use gpui::prelude::FluentBuilder as _;

impl Render for Island {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Rendering means the island is in this frame.
        if !self.drawn {
            self.drawn = true;
            self.sync_native_visibility(cx);
        }
        // Drawn in another window than the page is in: the page follows.
        if self.window.window_id() != window.window_handle().window_id() {
            let this = cx.entity().downgrade();
            window.defer(cx, move |window, cx| {
                this.update(cx, |this, cx| this.move_to_window(window, cx))
                    .ok();
            });
        }
        // Built lazily, after this frame: the first time the island is shown,
        // and again after a hibernation.
        if self.active
            && self.webview.is_none()
            && !self.building
            && matches!(self.state, IslandState::Cold | IslandState::Hibernated)
        {
            self.building = true;
            let this = cx.entity().downgrade();
            window.defer(cx, move |window, cx| {
                this.update(cx, |this, cx| this.build(window, cx)).ok();
            });
        }
        let shown = self.revealed && self.page_ready;
        let page_ready = self.page_ready;
        let webview = self.webview.clone();
        div()
            .id(ElementId::Name(self.config.name.clone()))
            .key_context("Island")
            .track_focus(&self.focus_handle)
            .size_full()
            .relative()
            .when_some(self.config.ground, |this, ground| this.bg(ground))
            .on_mouse_down_out(cx.listener(move |this, _, _, _| {
                if page_ready {
                    this.deliver(Outbound::event("host:outside-pointerdown", Value::Null));
                }
            }))
            .when_some(webview, |this, webview| {
                this.child(Masked {
                    child: webview.into_any_element(),
                    hidden: !shown,
                })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hibernates_after_the_tauri_apps_delay() {
        assert_eq!(HIBERNATE_AFTER, Duration::from_millis(20_000));
    }
}
