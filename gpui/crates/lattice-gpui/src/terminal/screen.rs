//! One terminal's screen: Zed's terminal (the shell's grid and its pty)
//! with the keyboard, the input method, the caret's blink, the wheel and
//! the scrollbar around it, as `terminal-screen.ts` puts xterm.js together
//! in the Tauri app.
//!
//! Keys reach the shell through Zed's terminal (`try_keystroke`), Option not
//! taken as Meta (xterm.js's default on macOS). Zed's keymap gives the
//! terminal its conveniences in the `Terminal` context (⌘C and ⌘V, ⌘← and
//! ⌘→ to the line's ends, ⌥← and ⌥→ by word, ⇧PgUp and ⇧PgDn through the
//! scrollback); Lattice binds ⌘F (find), ⌘A (select all), ⌘K (the command
//! palette) and ⌘W (close the tab) over it ([`super::key_bindings`]), as the
//! Tauri app's terminal leaves those to the window.
//!
//! A new size reaches the grid, and the shell, only once the screen has held
//! it for [`SETTLE`], and not at all while a panel is being dragged
//! (`terminal-slot.tsx`): each size the grid takes reflows its lines and
//! makes the shell redraw its prompt, and a panel shrunk to a strip while it
//! moves pushed a multi-line prompt's first line out of the redraw's reach.

use std::{
    cell::RefCell,
    process::ExitStatus,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    App, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable, Font, FontFeatures,
    FontWeight, InteractiveElement as _, IntoElement, KeyContext, KeyDownEvent, ParentElement as _,
    Pixels, Point, Render, ScrollEvent, Size, Styled as _, Subscription, Task, Window, div, point,
    px, size,
};
use gpui_kit::base::ScrollbarHandle;
use lattice_ui::{
    ActiveLattice as _,
    editor_theme::terminal::TerminalColors,
    scrollbar::{FluidScrollbar, ScrollbarFeel},
};
use terminal::{
    Clear, Copy, Event, MaybeNavigationTarget, Modes, MouseInputMode, Paste, PasteText,
    ScrollLineDown, ScrollLineUp, ScrollPageDown, ScrollPageUp, ScrollToBottom, ScrollToTop,
    SelectAll, Terminal, TerminalBounds,
};

use super::element::{ScreenStyle, TerminalElement};

/// xterm.js's caret blink: on and off every 600 ms.
const BLINK: Duration = Duration::from_millis(600);
/// How long a new size must hold before the grid takes it
/// (`SETTLE_MS` in `terminal-slot.tsx`).
pub const SETTLE: Duration = Duration::from_millis(120);
/// The terminal's type: `--type-diff-code-size` (the caption's 12px), at
/// xterm.js's `lineHeight` of 1.2.
pub const FONT_SIZE: Pixels = px(12.);
pub const LINE_HEIGHT: f32 = 1.2;

/// What the screen asks of its panel.
#[derive(Clone, Debug, PartialEq)]
pub enum ScreenEvent {
    /// ⌘F: open the find field.
    FindRequested,
}

/// The scroll the bar reads and moves: in lines, as Zed's terminal scrolls,
/// told to the terminal on the next frame.
#[derive(Default)]
struct ScrollState {
    viewport: Bounds<Pixels>,
    line_height: Pixels,
    total_lines: usize,
    viewport_lines: usize,
    display_offset: usize,
    /// A display offset the bar asked for, not yet given to the terminal.
    pending: Option<usize>,
}

#[derive(Clone, Default)]
pub struct TerminalScroll(Rc<RefCell<ScrollState>>);

impl TerminalScroll {
    fn update(&self, terminal: &Terminal) {
        let content = terminal.last_content();
        let mut state = self.0.borrow_mut();
        state.viewport = content.terminal_bounds.bounds;
        state.line_height = content.terminal_bounds.line_height;
        state.total_lines = terminal.total_lines();
        state.viewport_lines = terminal.viewport_lines();
        state.display_offset = content.display_offset;
    }

    fn max_top(state: &ScrollState) -> usize {
        state.total_lines.saturating_sub(state.viewport_lines)
    }
}

impl ScrollbarHandle for TerminalScroll {
    fn viewport_bounds(&self) -> Bounds<Pixels> {
        self.0.borrow().viewport
    }

    fn offset(&self) -> Point<Pixels> {
        let state = self.0.borrow();
        let offset = state.pending.unwrap_or(state.display_offset);
        let top = Self::max_top(&state).saturating_sub(offset);
        point(px(0.), -(state.line_height * top as f32))
    }

    fn set_offset(&self, offset: Point<Pixels>) {
        let mut state = self.0.borrow_mut();
        if state.line_height <= px(0.) {
            return;
        }
        let max = Self::max_top(&state);
        let top = (f32::from(-offset.y / state.line_height)).round().max(0.) as usize;
        state.pending = Some(max.saturating_sub(top.min(max)));
    }

    fn content_size(&self) -> Size<Pixels> {
        let state = self.0.borrow();
        size(
            state.viewport.size.width,
            state.line_height * state.total_lines as f32,
        )
    }
}

/// The size the grid has, and the one waiting to take its place.
#[derive(Default)]
struct Settle {
    committed: Option<TerminalBounds>,
    waiting: Option<(TerminalBounds, Instant)>,
    timer: Option<Task<()>>,
}

fn same_grid(a: &TerminalBounds, b: &TerminalBounds) -> bool {
    a.num_lines() == b.num_lines()
        && a.num_columns() == b.num_columns()
        && a.cell_width == b.cell_width
        && a.line_height == b.line_height
}

pub struct TerminalScreen {
    terminal: Entity<Terminal>,
    focus_handle: FocusHandle,
    /// The caret shows in this phase of its blink.
    blink_on: bool,
    blink_epoch: usize,
    /// A program asked for a steady caret (`DECSCUSR`).
    blink_allowed: bool,
    marked_text: Option<String>,
    /// ⌘ is over a link the terminal found under the pointer.
    link_hovered: bool,
    /// The find field is open over this screen.
    finding: bool,
    /// A panel is being dragged: the grid keeps its size.
    moving: bool,
    scroll: TerminalScroll,
    settle: Settle,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ScreenEvent> for TerminalScreen {}

impl Focusable for TerminalScreen {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl TerminalScreen {
    pub fn new(terminal: Entity<Terminal>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        let subscriptions = vec![
            cx.observe(&terminal, |_, _, cx| cx.notify()),
            cx.subscribe_in(&terminal, window, Self::on_terminal_event),
            cx.on_focus_in(&focus_handle, window, |screen, window, cx| {
                screen
                    .terminal
                    .update(cx, |terminal, _| terminal.focus_in());
                screen.restart_blink(window, cx);
                window.invalidate_character_coordinates();
                cx.notify();
            }),
            cx.on_focus_out(&focus_handle, window, |screen, _, _, cx| {
                screen
                    .terminal
                    .update(cx, |terminal, _| terminal.focus_out());
                screen.blink_epoch += 1;
                cx.notify();
            }),
        ];
        Self {
            terminal,
            focus_handle,
            blink_on: true,
            blink_epoch: 0,
            blink_allowed: true,
            marked_text: None,
            link_hovered: false,
            finding: false,
            moving: false,
            scroll: TerminalScroll::default(),
            settle: Settle::default(),
            _subscriptions: subscriptions,
        }
    }

    pub fn terminal(&self) -> &Entity<Terminal> {
        &self.terminal
    }

    /// The caret is in the shown phase of its blink.
    pub fn caret_shown(&self) -> bool {
        self.blink_on
    }

    pub fn marked_text(&self) -> Option<&str> {
        self.marked_text.as_deref()
    }

    pub fn link_hovered(&self) -> bool {
        self.link_hovered
    }

    pub fn set_finding(&mut self, finding: bool, cx: &mut Context<Self>) {
        if self.finding != finding {
            self.finding = finding;
            cx.notify();
        }
    }

    pub fn set_moving(&mut self, moving: bool, cx: &mut Context<Self>) {
        if self.moving != moving {
            self.moving = moving;
            cx.notify();
        }
    }

    fn on_terminal_event(
        &mut self,
        _: &Entity<Terminal>,
        event: &Event,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            Event::Wakeup | Event::SelectionsChanged => {
                window.invalidate_character_coordinates();
                cx.notify();
            }
            Event::BlinkChanged(blinking) => {
                self.blink_allowed = *blinking;
                self.restart_blink(window, cx);
            }
            Event::NewNavigationTarget(target) => {
                let hovered = matches!(target, Some(MaybeNavigationTarget::Url(_)));
                if hovered != self.link_hovered {
                    self.link_hovered = hovered;
                    cx.notify();
                }
            }
            // ⌘-click on a link, as WebLinksAddon opens it.
            Event::Open(MaybeNavigationTarget::Url(url)) => cx.open_url(url),
            _ => {}
        }
    }

    /// Show the caret now and blink from here (a key pressed, focus won).
    fn restart_blink(&mut self, window: &Window, cx: &mut Context<Self>) {
        self.blink_on = true;
        self.blink_epoch += 1;
        let epoch = self.blink_epoch;
        cx.notify();
        if !self.blink_allowed || !self.focus_handle.is_focused(window) {
            return;
        }
        cx.spawn(async move |screen, cx| {
            loop {
                cx.background_executor().timer(BLINK).await;
                let going = screen
                    .update(cx, |screen, cx| {
                        if screen.blink_epoch != epoch {
                            return false;
                        }
                        screen.blink_on = !screen.blink_on;
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !going {
                    break;
                }
            }
        })
        .detach();
    }

    /// The size the grid draws at this frame: `wanted` once it has held for
    /// [`SETTLE`] (at once the first time, or when only the font changed),
    /// the size it had until then, placed where `wanted` is.
    pub fn settled_bounds(
        &mut self,
        wanted: TerminalBounds,
        cx: &mut Context<Self>,
    ) -> TerminalBounds {
        let Some(committed) = self.settle.committed else {
            self.settle.committed = Some(wanted);
            return wanted;
        };
        let place = |bounds: TerminalBounds| {
            TerminalBounds::new(
                bounds.line_height,
                bounds.cell_width,
                Bounds {
                    origin: wanted.bounds.origin,
                    size: bounds.bounds.size,
                },
            )
        };
        if same_grid(&committed, &wanted)
            || committed.cell_width != wanted.cell_width
            || committed.line_height != wanted.line_height
        {
            self.settle.committed = Some(wanted);
            self.settle.waiting = None;
            return wanted;
        }
        if self.moving {
            self.settle.waiting = None;
            return place(committed);
        }
        let now = Instant::now();
        let since = match self.settle.waiting {
            Some((waiting, since)) if same_grid(&waiting, &wanted) => since,
            _ => {
                self.settle.waiting = Some((wanted, now));
                now
            }
        };
        let held = now.duration_since(since);
        if held >= SETTLE {
            self.settle.committed = Some(wanted);
            self.settle.waiting = None;
            return wanted;
        }
        self.settle.timer = Some(cx.spawn(async move |screen, cx| {
            cx.background_executor().timer(SETTLE - held).await;
            screen.update(cx, |_, cx| cx.notify()).ok();
        }));
        place(committed)
    }

    pub fn set_marked_text(&mut self, text: Option<String>, cx: &mut Context<Self>) {
        let text = text.filter(|text| !text.is_empty());
        if self.marked_text != text {
            self.marked_text = text;
            cx.notify();
        }
    }

    /// Text an input method committed, typed into the shell.
    pub fn type_text(&mut self, text: &str, window: &Window, cx: &mut Context<Self>) {
        if text.is_empty() {
            return;
        }
        self.terminal.update(cx, |terminal, _| {
            terminal.input(text.to_string().into_bytes())
        });
        self.restart_blink(window, cx);
    }

    pub fn scroll_wheel(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        self.terminal.update(cx, |terminal, _| {
            terminal.scroll_wheel(event, 1., MouseInputMode::ReportToTerminal)
        });
        cx.notify();
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.terminal.update(cx, |terminal, _| terminal.clear());
        cx.notify();
    }

    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.restart_blink(window, cx);
        if event.prefer_character_input
            && event.keystroke.key_char.is_some()
            && !self.terminal.read(cx).vi_mode_enabled()
        {
            return;
        }
        let handled = self.terminal.update(cx, |terminal, _| {
            terminal.try_keystroke(&event.keystroke, false)
        });
        if handled {
            cx.stop_propagation();
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        self.terminal.update(cx, |terminal, _| terminal.copy(None));
        cx.notify();
    }

    /// ⌘V: the clipboard's text, bracketed when the program asked for it.
    fn paste(&mut self, window: &Window, cx: &mut Context<Self>) {
        let Some(text) = cx
            .read_from_clipboard()
            .and_then(|clipboard| clipboard.text())
        else {
            return;
        };
        self.terminal
            .update(cx, |terminal, _| terminal.paste(&text));
        self.restart_blink(window, cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.terminal
            .update(cx, |terminal, _| terminal.select_all());
        cx.notify();
    }

    /// The screen's scroll keys move through the scrollback, except in a
    /// full-screen program, which gets them.
    fn scroll_by(&mut self, cx: &mut Context<Self>, scroll: impl FnOnce(&mut Terminal)) {
        if self
            .terminal
            .read(cx)
            .last_content
            .mode
            .contains(Modes::ALT_SCREEN)
        {
            cx.propagate();
            return;
        }
        self.terminal.update(cx, |terminal, _| scroll(terminal));
        cx.notify();
    }

    fn dispatch_context(&self, cx: &App) -> KeyContext {
        let mut context = KeyContext::new_with_defaults(cx.platform_info().os);
        context.add("Terminal");
        let terminal = self.terminal.read(cx);
        let mode = terminal.last_content.mode;
        context.set(
            "screen",
            if mode.contains(Modes::ALT_SCREEN) {
                "alt"
            } else {
                "normal"
            },
        );
        if mode.contains(Modes::APP_CURSOR) {
            context.add("DECCKM");
        }
        if mode.contains(Modes::BRACKETED_PASTE) {
            context.add("bracketed_paste");
        }
        if mode.intersects(Modes::MOUSE_MODE) {
            context.add("any_mouse_reporting");
        }
        if terminal.last_content.selection.is_some() {
            context.add("selection");
        }
        context
    }

    /// How the screen is drawn: the code theme's terminal colours and the
    /// editor's face at the terminal's size.
    pub fn style(cx: &App) -> ScreenStyle {
        let lattice = cx.lattice();
        let colors = TerminalColors::new(lattice.code_theme, &lattice.palette);
        ScreenStyle {
            colors,
            font: Font {
                family: lattice.fonts.editor.clone(),
                features: FontFeatures::disable_ligatures(),
                fallbacks: None,
                weight: FontWeight::NORMAL,
                style: gpui::FontStyle::Normal,
            },
            font_size: FONT_SIZE,
            line_height: FONT_SIZE * LINE_HEIGHT,
        }
    }
}

impl Render for TerminalScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let pending = self.scroll.0.borrow_mut().pending.take();
        if let Some(offset) = pending {
            self.terminal.update(cx, |terminal, _| {
                let now = terminal.last_content.display_offset as i32;
                let delta = offset as i32 - now;
                if delta > 0 {
                    terminal.scroll_up_by(delta as usize);
                } else if delta < 0 {
                    terminal.scroll_down_by((-delta) as usize);
                }
            });
        }
        self.scroll.update(self.terminal.read(cx));
        let focused = self.focus_handle.is_focused(window);
        let style = Self::style(cx);
        let ink = style.colors.ink;
        div()
            .id("terminal-screen")
            .size_full()
            .relative()
            .key_context(self.dispatch_context(cx))
            .on_action(cx.listener(Self::copy))
            .on_action(
                cx.listener(|screen, _: &editor::actions::Copy, window, cx| {
                    screen.copy(&Copy, window, cx)
                }),
            )
            .on_action(cx.listener(|screen, _: &Paste, window, cx| screen.paste(window, cx)))
            .on_action(
                cx.listener(|screen, _: &editor::actions::Paste, window, cx| {
                    screen.paste(window, cx)
                }),
            )
            .on_action(cx.listener(|screen, _: &PasteText, window, cx| screen.paste(window, cx)))
            .on_action(cx.listener(|screen, _: &Clear, _, cx| screen.clear(cx)))
            .on_action(cx.listener(Self::select_all))
            .on_action(
                cx.listener(|screen, _: &editor::actions::SelectAll, window, cx| {
                    screen.select_all(&SelectAll, window, cx)
                }),
            )
            .on_action(cx.listener(|screen, _: &ScrollLineUp, _, cx| {
                screen.scroll_by(cx, |terminal| terminal.scroll_line_up())
            }))
            .on_action(cx.listener(|screen, _: &ScrollLineDown, _, cx| {
                screen.scroll_by(cx, |terminal| terminal.scroll_line_down())
            }))
            .on_action(cx.listener(|screen, _: &ScrollPageUp, _, cx| {
                screen.scroll_by(cx, |terminal| terminal.scroll_page_up())
            }))
            .on_action(cx.listener(|screen, _: &ScrollPageDown, _, cx| {
                screen.scroll_by(cx, |terminal| terminal.scroll_page_down())
            }))
            .on_action(cx.listener(|screen, _: &ScrollToTop, _, cx| {
                screen.scroll_by(cx, |terminal| terminal.scroll_to_top())
            }))
            .on_action(cx.listener(|screen, _: &ScrollToBottom, _, cx| {
                screen.scroll_by(cx, |terminal| terminal.scroll_to_bottom())
            }))
            .on_action(cx.listener(|_, _: &super::FindInTerminal, _, cx| {
                cx.emit(ScreenEvent::FindRequested)
            }))
            .on_key_down(cx.listener(Self::key_down))
            .child(TerminalElement::new(
                self.terminal.clone(),
                cx.entity(),
                self.focus_handle.clone(),
                focused,
                self.blink_on || !self.blink_allowed,
                self.finding,
                style,
            ))
            .child(
                FluidScrollbar::vertical(
                    gpui::ElementId::NamedInteger(
                        "terminal-scrollbar".into(),
                        cx.entity_id().as_u64(),
                    ),
                    &self.scroll,
                )
                .feel(ScrollbarFeel::EDITOR)
                .ink(ink),
            )
    }
}

/// How a shell ended, from its exit status: a code, or `None` when a
/// signal ended it.
pub fn exit_code(status: Option<ExitStatus>) -> Option<i32> {
    status.and_then(|status| status.code())
}
