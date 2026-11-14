//! The Terminal panel (`terminal-panel.tsx`, `terminal-sessions.ts`,
//! `terminal-window.ts`): one login shell per tab in the project folder, a
//! strip of tabs once there are two, the screen of the one in front, its
//! find field, and how a shell that stopped by itself ended.
//!
//! The panel is the window's, kept by the shell whether or not the layout
//! shows it, so a workspace without a Terminal panel, or a layout reset,
//! leaves every shell and its scrollback running for the panel's return. A
//! shell ends when its tab closes, when the panel is closed (asking first
//! while a command runs), when the window's project changes, and with the
//! window. Opening the panel opens a terminal; a panel whose last tab was
//! closed by hand waits with New terminal. A shell that exits cleanly
//! (`exit`, ⌃D) takes its tab with it, and the last one going that way closes
//! the panel; any other exit keeps the tab and says how it ended.

use std::{path::PathBuf, process::ExitStatus};

use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    menu::{PopupMenu, PopupMenuItem},
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, ButtonVariant, IconButton, Surface},
    icons::ICON,
};

mod find;
mod stopping;
mod tabs;

use find::Find;
use tabs::Rename;

use super::{
    FindInTerminal, launch,
    screen::{ScreenEvent, TerminalScreen, exit_code},
};

/// What the shell hears from the panel.
#[derive(Clone, Debug, PartialEq)]
pub enum TerminalPanelEvent {
    /// The last terminal's shell exited cleanly and took its tab: the panel
    /// closes, and ⌃` brings it back with a fresh terminal.
    LastExited,
    /// ⌘W in a panel with no terminal open: the panel itself closes.
    ClosePanel,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SessionState {
    Starting,
    Running,
    /// The shell exited by itself: its code, or `None` when a signal ended it.
    Exited(Option<i32>),
    /// The shell never started.
    Failed(String),
}

pub struct Session {
    /// The tab's own key.
    pub key: usize,
    /// Shown as "Terminal {number}" until renamed.
    pub number: usize,
    pub name: Option<String>,
    /// The shell's program ("zsh").
    pub shell: String,
    pub state: SessionState,
    pub screen: Option<Entity<TerminalScreen>>,
    /// The tab's place for the keyboard, once the strip shows.
    tab_focus: FocusHandle,
    _tasks: Vec<Task<()>>,
    _subscription: Option<Subscription>,
}

impl Session {
    pub fn label(&self) -> String {
        match &self.name {
            Some(name) => name.clone(),
            None => t!("Terminal {number}", number = self.number),
        }
    }
}

pub struct TerminalPanel {
    focus_handle: FocusHandle,
    root: Option<PathBuf>,
    sessions: Vec<Session>,
    active: Option<usize>,
    next_key: usize,
    /// The panel is the selected tab of a panel on screen.
    shown: bool,
    /// A panel is being dragged.
    moving: bool,
    find: Option<Find>,
    rename: Option<Rename>,
}

impl EventEmitter<PanelEvent> for TerminalPanel {}
impl EventEmitter<TerminalPanelEvent> for TerminalPanel {}

impl Focusable for TerminalPanel {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.active_screen()
            .map(|screen| screen.focus_handle(cx))
            .unwrap_or_else(|| self.focus_handle.clone())
    }
}

impl BasePanel for TerminalPanel {
    fn panel_name(&self) -> &'static str {
        "TerminalPanel"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }

    fn set_active(&mut self, active: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.shown = active;
        if active {
            self.open_if_empty(window, cx);
        }
        cx.notify();
    }
}

impl Panel for TerminalPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(t!("Terminal").into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        t!("Terminal")
    }

    /// The strip's New terminal button (`TerminalActions`).
    fn title_suffix(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        Some(
            IconButton::new("terminal-new", Icon::PLUS)
                .radius(lattice_ui::components::TAB_RADIUS)
                .surface(Surface::Sheet)
                .tooltip(t!("New terminal"))
                .disabled(self.root.is_none())
                .on_click(
                    cx.listener(|panel, _: &ClickEvent, window, cx| {
                        panel.open_terminal(window, cx)
                    }),
                ),
        )
    }

    /// The ⋯ menu's own entries, ahead of the workspace's.
    fn dropdown_menu(
        &mut self,
        menu: PopupMenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        let panel = cx.entity().downgrade();
        let item = |label: String, run: fn(&mut Self, &mut Window, &mut Context<Self>)| {
            let panel = panel.clone();
            PopupMenuItem::new(label).on_click(move |_, window, cx| {
                panel.update(cx, |this, cx| run(this, window, cx)).ok();
            })
        };
        menu.item(item(t!("New terminal").into(), Self::open_terminal))
            .item(
                item(t!("Find in terminal").into(), Self::open_find)
                    .action(Box::new(FindInTerminal)),
            )
            .item(item(t!("Clear terminal").into(), Self::clear_active))
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl TerminalPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            root: None,
            sessions: Vec::new(),
            active: None,
            next_key: 1,
            shown: false,
            moving: false,
            find: None,
            rename: None,
        }
    }

    pub fn sessions(&self) -> &[Session] {
        &self.sessions
    }

    pub fn active_key(&self) -> Option<usize> {
        self.active
    }

    /// The keyboard's place in the terminal in front.
    pub fn active_screen_focus(&self, cx: &App) -> Option<FocusHandle> {
        self.active_screen().map(|screen| screen.focus_handle(cx))
    }

    fn active_session(&self) -> Option<&Session> {
        self.sessions
            .iter()
            .find(|session| Some(session.key) == self.active)
    }

    fn active_screen(&self) -> Option<&Entity<TerminalScreen>> {
        self.active_session()?.screen.as_ref()
    }

    /// The project the terminals run in; another project ends every
    /// terminal of the last one.
    pub fn set_project(
        &mut self,
        root: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if root == self.root {
            return;
        }
        self.end_all(cx);
        self.root = root;
        if self.shown {
            self.open_if_empty(window, cx);
        }
        cx.notify();
    }

    pub fn set_moving(&mut self, moving: bool, cx: &mut Context<Self>) {
        if self.moving == moving {
            return;
        }
        self.moving = moving;
        for screen in self
            .sessions
            .iter()
            .filter_map(|session| session.screen.as_ref())
        {
            screen.update(cx, |screen, cx| screen.set_moving(moving, cx));
        }
    }

    /// Opening the panel opens a terminal: there is nothing else to do in it.
    fn open_if_empty(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.root.is_some() && self.sessions.is_empty() {
            self.open_terminal(window, cx);
        }
    }

    /// Start a terminal in the project folder and bring its tab forward.
    pub fn open_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let mut number = 1;
        while self.sessions.iter().any(|session| session.number == number) {
            number += 1;
        }
        let key = self.next_key;
        self.next_key += 1;
        let (exited, exit) = async_channel::bounded::<Option<ExitStatus>>(1);
        let window_id = window.window_handle().window_id().as_u64();
        let (shell, start) = launch::start(&root, window_id, exited, cx);
        let started = cx.spawn_in(window, async move |panel, cx| {
            let built = start.await;
            panel
                .update_in(cx, |panel, window, cx| {
                    panel.started(key, built, window, cx)
                })
                .ok();
        });
        let ended = cx.spawn_in(window, async move |panel, cx| {
            if let Ok(status) = exit.recv().await {
                panel
                    .update_in(cx, |panel, window, cx| {
                        panel.exited(key, status, window, cx)
                    })
                    .ok();
            }
        });
        self.sessions.push(Session {
            key,
            number,
            name: None,
            shell,
            state: SessionState::Starting,
            screen: None,
            tab_focus: cx.focus_handle(),
            _tasks: vec![started, ended],
            _subscription: None,
        });
        self.select(key, window, cx);
    }

    fn started(
        &mut self,
        key: usize,
        built: anyhow::Result<terminal::TerminalBuilder>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let moving = self.moving;
        let focused = self.focus_handle(cx).contains_focused(window, cx)
            || self.focus_handle.is_focused(window);
        let Some(session) = self.sessions.iter_mut().find(|session| session.key == key) else {
            return;
        };
        match built {
            Ok(builder) => {
                let terminal = cx.new(|cx| builder.subscribe(cx));
                let screen = cx.new(|cx| {
                    let mut screen = TerminalScreen::new(terminal, window, cx);
                    screen.set_moving(moving, cx);
                    screen
                });
                session._subscription = Some(cx.subscribe_in(
                    &screen,
                    window,
                    |panel, _, event: &ScreenEvent, window, cx| match event {
                        ScreenEvent::FindRequested => panel.open_find(window, cx),
                    },
                ));
                session.screen = Some(screen.clone());
                if session.state == SessionState::Starting {
                    session.state = SessionState::Running;
                }
                if Some(key) == self.active && (focused || self.shown) {
                    screen.focus_handle(cx).focus(window, cx);
                }
            }
            Err(error) => {
                session.state = SessionState::Failed(format!("{error:#}"));
            }
        }
        cx.notify();
    }

    /// The shell exited by itself: a clean exit closes its tab, as closing
    /// it would; any other keeps the tab and says how it ended.
    fn exited(
        &mut self,
        key: usize,
        status: Option<ExitStatus>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(session) = self.sessions.iter_mut().find(|session| session.key == key) else {
            return;
        };
        let code = exit_code(status);
        if code == Some(0) {
            self.close(key, window, cx);
            if self.sessions.is_empty() {
                cx.emit(TerminalPanelEvent::LastExited);
            }
            return;
        }
        session.state = SessionState::Exited(code);
        cx.notify();
    }

    pub fn select(&mut self, key: usize, window: &mut Window, cx: &mut Context<Self>) {
        if !self.sessions.iter().any(|session| session.key == key) {
            return;
        }
        self.active = Some(key);
        if self.find.as_ref().is_some_and(|find| find.key != key) {
            self.close_find(window, cx);
        }
        if let Some(screen) = self.active_screen() {
            screen.focus_handle(cx).focus(window, cx);
        } else {
            self.focus_handle.focus(window, cx);
        }
        cx.notify();
    }

    /// Close one tab, ending its shell; the tab after it (else before it)
    /// comes forward.
    pub fn close(&mut self, key: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.sessions.iter().position(|session| session.key == key) else {
            return;
        };
        if self.find.as_ref().is_some_and(|find| find.key == key) {
            self.find = None;
        }
        if self.rename.as_ref().is_some_and(|rename| rename.key == key) {
            self.rename = None;
        }
        // Dropping Zed's terminal ends its shell and what runs in it.
        self.sessions.remove(index);
        if self.active == Some(key) {
            let next = self
                .sessions
                .get(index)
                .or_else(|| index.checked_sub(1).and_then(|i| self.sessions.get(i)))
                .map(|session| session.key);
            self.active = None;
            match next {
                Some(next) => self.select(next, window, cx),
                None => self.focus_handle.focus(window, cx),
            }
        }
        cx.notify();
    }

    /// End every shell: the panel closed, or the project changed.
    pub fn end_all(&mut self, cx: &mut Context<Self>) {
        self.find = None;
        self.rename = None;
        self.sessions.clear();
        self.active = None;
        cx.notify();
    }

    pub fn clear_active(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(screen) = self.active_screen() {
            screen.update(cx, |screen, cx| screen.clear(cx));
        }
    }

    /// How a shell that stopped by itself ended, over the foot of its screen.
    fn render_ended(&self, session: &Session, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        let key = session.key;
        let (message, button): (String, Button) = match &session.state {
            SessionState::Exited(code) => (
                match code {
                    Some(code) => t!("The shell exited with code {code}", code = code),
                    None => t!("The shell was stopped").to_string(),
                },
                Button::new("terminal-ended-close", t!("Close"))
                    .compact()
                    .variant(ButtonVariant::Secondary)
                    .on_click(cx.listener(move |panel, _: &ClickEvent, window, cx| {
                        panel.close(key, window, cx)
                    })),
            ),
            SessionState::Failed(message) => (
                t!("The shell did not start: {message}", message = message),
                Button::new("terminal-ended-retry", t!("Try again"))
                    .compact()
                    .variant(ButtonVariant::Secondary)
                    .on_click(cx.listener(move |panel, _: &ClickEvent, window, cx| {
                        panel.close(key, window, cx);
                        panel.open_terminal(window, cx);
                    })),
            ),
            _ => return None,
        };
        Some(
            div()
                .flex()
                .flex_none()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .pt(px(4.))
                .pb(px(4.))
                .pl(px(10.))
                .pr(px(6.))
                .border_t_1()
                .border_color(palette.line)
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(div().flex_1().min_w_0().child(message))
                .child(button)
                .into_any_element(),
        )
    }

    /// No terminal open: the panel's last tab was closed by hand.
    fn render_empty(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(4.))
            .py(px(6.))
            .child(Icon::SQUARE_TERMINAL.element(ICON, palette.text_secondary))
            .child(
                div()
                    .text_role(TextRole::Subtitle, cx)
                    .text_color(palette.text)
                    .child(t!("No terminal open")),
            )
            .child(
                div().mt(px(4.)).child(
                    Button::new("terminal-empty-new", t!("New terminal"))
                        .compact()
                        .tinted()
                        .disabled(self.root.is_none())
                        .on_click(cx.listener(|panel, _: &ClickEvent, window, cx| {
                            panel.open_terminal(window, cx)
                        })),
                ),
            )
            .into_any_element()
    }
}

impl Render for TerminalPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = lattice_ui::editor_theme::terminal::TerminalColors::new(
            cx.lattice().code_theme,
            &cx.palette().clone(),
        );
        let tabs: Vec<AnyElement> = if self.sessions.len() > 1 {
            self.sessions
                .iter()
                .map(|session| self.render_tab(session, window, cx))
                .collect()
        } else {
            Vec::new()
        };
        let screen = self.active_screen().cloned();
        let find = self
            .find
            .as_ref()
            .filter(|find| Some(find.key) == self.active)
            .map(|find| self.render_find(find, cx));
        let ended = self
            .active_session()
            .and_then(|session| self.render_ended(session, cx));
        let empty = self.sessions.is_empty().then(|| self.render_empty(cx));
        div()
            .id("terminal-panel")
            .track_focus(&self.focus_handle)
            .key_context("TerminalPanel")
            .on_action(
                cx.listener(|panel, _: &FindInTerminal, window, cx| panel.open_find(window, cx)),
            )
            .on_action(
                cx.listener(|panel, _: &super::CloseTerminalTab, window, cx| {
                    if !panel.close_active(window, cx) {
                        cx.emit(TerminalPanelEvent::ClosePanel);
                    }
                }),
            )
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .bg(colors.ground)
            .when(!tabs.is_empty(), |panel| {
                panel.child(
                    div()
                        .id("terminal-tabs")
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(px(2.))
                        .py(px(2.))
                        .px(px(6.))
                        .overflow_x_scroll()
                        .children(tabs),
                )
            })
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .children(screen.map(|screen| {
                        div()
                            .absolute()
                            .top(px(2.))
                            .right(px(2.))
                            .bottom_0()
                            .left(px(10.))
                            .child(screen)
                    }))
                    .children(empty)
                    .children(find),
            )
            .children(ended)
    }
}
