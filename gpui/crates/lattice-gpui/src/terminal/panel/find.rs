//! The find field over the terminal in front (`FindField` in
//! `terminal-panel.tsx`): ⌘F or the ⋯ menu's Find opens it over the screen's
//! top right; typing finds as it goes, case-insensitively as xterm.js's
//! search does, keeping the match in front while it still matches; Enter
//! and ⇧Enter (or its arrows) step through the matches, counted beside the
//! field; Escape closes it, clears the matches and hands the keyboard back.

use gpui::{
    AnyElement, AppContext as _, ClickEvent, Context, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Styled as _,
    Subscription, Task, Window, div, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Field, IconButton, Surface},
    shape,
};

use super::TerminalPanel;

/// The find field's input (`.terminal-find input`), and the least it gives
/// way to in a narrow panel.
const FIND_WIDTH: f32 = 180.;

const FIND_MIN_WIDTH: f32 = 64.;

/// The find field over the screen in front.
pub(super) struct Find {
    pub(super) key: usize,
    pub(super) input: Entity<InputState>,
    /// The match in front, and how many there are.
    pub(super) current: Option<usize>,
    pub(super) count: usize,
    /// Searches as typed; a newer one replaces it.
    pub(super) search: Option<Task<()>>,
    pub(super) _subscription: Subscription,
}

impl TerminalPanel {
    /// The find field's match in front and the number of matches, while it
    /// is open.
    pub fn find_state(&self) -> Option<(Option<usize>, usize)> {
        self.find.as_ref().map(|find| (find.current, find.count))
    }

    /// The find field over the terminal in front (⌘F, or the menu's Find).
    pub fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = self.active.filter(|_| self.active_screen().is_some()) else {
            return;
        };
        if let Some(find) = self.find.as_ref().filter(|find| find.key == key) {
            let input = find.input.clone();
            input.update(cx, |input, cx| {
                input.focus(window, cx);
                input.select_all(window, cx);
            });
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Find in terminal")));
        let subscription = cx.subscribe_in(
            &input,
            window,
            |panel, _, event: &InputEvent, window, cx| {
                match event {
                    InputEvent::Change => panel.search(true, false, cx),
                    InputEvent::PressEnter { shift, .. } => panel.step(!*shift, cx),
                    _ => {}
                }
                let _ = window;
            },
        );
        input.update(cx, |input, cx| input.focus(window, cx));
        self.find = Some(Find {
            key,
            input,
            current: None,
            count: 0,
            search: None,
            _subscription: subscription,
        });
        self.set_screen_finding(true, cx);
        cx.notify();
    }

    fn set_screen_finding(&self, finding: bool, cx: &mut Context<Self>) {
        if let Some(screen) = self.active_screen() {
            screen.update(cx, |screen, cx| screen.set_finding(finding, cx));
        }
    }

    /// Close the find field, clear its matches and hand the keyboard back.
    pub fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(find) = self.find.take() else {
            return;
        };
        if let Some(screen) = self
            .sessions
            .iter()
            .find(|session| session.key == find.key)
            .and_then(|session| session.screen.clone())
        {
            screen.update(cx, |screen, cx| {
                screen.set_finding(false, cx);
                screen.terminal().update(cx, |terminal, _| {
                    terminal.matches.clear();
                });
                cx.notify();
            });
            if Some(find.key) == self.active {
                screen.focus_handle(cx).focus(window, cx);
            }
        }
        cx.notify();
    }

    /// Look for the field's text, case-insensitively as xterm.js's search
    /// does; typing keeps the match in front while it still matches.
    fn search(&mut self, incremental: bool, backwards: bool, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        let query = find.input.read(cx).value().to_string();
        let Some(screen) = self
            .sessions
            .iter()
            .find(|session| session.key == find.key)
            .and_then(|session| session.screen.clone())
        else {
            return;
        };
        let terminal = screen.read(cx).terminal().clone();
        if query.is_empty() {
            find.current = None;
            find.count = 0;
            find.search = None;
            terminal.update(cx, |terminal, _| terminal.matches.clear());
            cx.notify();
            return;
        }
        let Some(searcher) = terminal::Search::new(&format!("(?i){}", regex::escape(&query)))
        else {
            return;
        };
        let task = terminal.update(cx, |terminal, cx| terminal.find_matches(searcher, cx));
        let previous = find.current;
        find.search = Some(cx.spawn(async move |panel, cx| {
            let matches = task.await;
            panel
                .update(cx, |panel, cx| {
                    let count = matches.len();
                    let current = if count == 0 {
                        None
                    } else if incremental {
                        Some(previous.unwrap_or(0).min(count - 1))
                    } else if backwards {
                        Some(previous.map_or(count - 1, |i| (i + count - 1) % count))
                    } else {
                        Some(previous.map_or(0, |i| (i + 1) % count))
                    };
                    terminal.update(cx, |terminal, _| {
                        terminal.matches = matches;
                        if let Some(index) = current {
                            terminal.activate_match(index);
                        }
                    });
                    if let Some(find) = panel.find.as_mut() {
                        find.current = current;
                        find.count = count;
                    }
                    cx.notify();
                })
                .ok();
        }));
    }

    /// Enter and ⇧Enter, and the field's arrows: the next or previous match.
    fn step(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        if find.count == 0 {
            self.search(false, !forward, cx);
            return;
        }
        let count = find.count;
        let index = match find.current {
            Some(i) if forward => (i + 1) % count,
            Some(i) => (i + count - 1) % count,
            None => 0,
        };
        find.current = Some(index);
        let key = find.key;
        if let Some(screen) = self
            .sessions
            .iter()
            .find(|session| session.key == key)
            .and_then(|session| session.screen.clone())
        {
            screen.update(cx, |screen, cx| {
                screen
                    .terminal()
                    .update(cx, |terminal, _| terminal.activate_match(index));
                cx.notify();
            });
        }
        cx.notify();
    }

    pub(super) fn render_find(&self, find: &Find, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let query_empty = find.input.read(cx).value().is_empty();
        let count = if query_empty {
            String::new()
        } else if find.count == 0 {
            t!("No results").to_string()
        } else {
            format!("{}/{}", find.current.map_or(0, |i| i + 1), find.count)
        };
        let button = |id: &'static str, icon: Icon, label: &str| {
            IconButton::new(id, icon)
                .frame(px(24.), px(24.))
                .surface(Surface::Sheet)
                .tooltip(label.to_string())
        };
        // Right-aligned in a row across the screen's top, so a panel too
        // narrow for the 180px field shrinks the field rather than pushing
        // the field off the panel's left edge. The row itself takes no
        // pointer: only the pill does.
        let pill = div()
            .id("terminal-find")
            .flex()
            .flex_shrink(1.)
            .min_w_0()
            .items_center()
            .gap(px(1.))
            .p(px(2.))
            .rounded(shape::CHROME.paint(shape::RADIUS_SURFACE))
            .bg(palette.raised)
            .shadow(Elevation::Floating.shadows(&palette))
            .capture_key_down(cx.listener(|panel, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    panel.close_find(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .w(px(FIND_WIDTH))
                    .flex_shrink(1.)
                    .min_w(px(FIND_MIN_WIDTH))
                    .child(Field::new(&find.input).compact()),
            )
            .child(
                div()
                    .flex_none()
                    .min_w(px(48.))
                    .px(px(4.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .text_center()
                    .child(count),
            )
            .child(
                button(
                    "terminal-find-previous",
                    Icon::CHEVRON_UP,
                    t!("Previous match"),
                )
                .disabled(query_empty)
                .on_click(cx.listener(|panel, _: &ClickEvent, _, cx| panel.step(false, cx))),
            )
            .child(
                button("terminal-find-next", Icon::CHEVRON_DOWN, t!("Next match"))
                    .disabled(query_empty)
                    .on_click(cx.listener(|panel, _: &ClickEvent, _, cx| panel.step(true, cx))),
            )
            .child(
                button("terminal-find-close", Icon::X, t!("Close find")).on_click(
                    cx.listener(|panel, _: &ClickEvent, window, cx| panel.close_find(window, cx)),
                ),
            );
        div()
            .absolute()
            .top(px(4.))
            .left(px(6.))
            .right(px(24.))
            .flex()
            .justify_end()
            .child(pill)
            .into_any_element()
    }
}
