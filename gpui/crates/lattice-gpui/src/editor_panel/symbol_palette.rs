//! The math symbol palette (⌥⌘M, Ctrl+Alt+M off macOS) in a LaTeX source,
//! as the Tauri app's `symbol-palette.ts` shows it under the caret: a
//! search field over a grid of eight columns holding every maths command of
//! the vocabulary, each drawn by KaTeX, found by its name, its meaning or
//! the symbol itself (`lattice_editor::latex::symbol_palette`). The arrows
//! move the highlight (up and down a row of eight), Enter or a click writes
//! the symbol at the caret and closes it, Escape closes it with the caret
//! back in the text, and it closes when its field loses the keyboard.
//!
//! Each cell is KaTeX's own picture of the command, with an empty box where
//! an argument goes, set by the math page the cards' previews use
//! (`card_previews.rs`) and kept per command; until it is in, the cell shows
//! the symbol's text, and a command KaTeX cannot set shows its name.

use std::{cell::Cell, ops::Range, rc::Rc};

use editor::ToOffset as _;
use gpui::{
    AnyElement, AppContext as _, Bounds, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement as _, KeyDownEvent, ParentElement as _, Pixels, ScrollHandle,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, actions, canvas, div, img,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{
    Input, InputEvent, InputState, MoveDown, MoveLeft, MoveRight, MoveUp,
};
use language::{Anchor, ToOffset as _};
use lattice_editor::latex::{
    previews::{self, MacroSources, MathRequest, Preview},
    symbol_palette::{PaletteSymbol, insertion, match_symbols},
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{LatticeTooltip, PopFrom, pop_in},
    tokens,
};

use super::EditorPanel;

actions!(lattice, [InsertMathSymbol]);

/// The grid's columns, and what an arrow moves by.
const COLUMNS: usize = 8;
/// The palette's width (`min(340px, 100vw - 32px)`), its grid's tallest
/// before it scrolls, and a cell's height (`.symbol-palette*`).
const WIDTH: f32 = 340.;
const GRID_MAX_HEIGHT: f32 = 216.;
const CELL_HEIGHT: f32 = 36.;
const FIELD_HEIGHT: f32 = 28.;
const MARGIN: f32 = 4.;

/// The open palette.
pub(super) struct SymbolPalette {
    input: Entity<InputState>,
    /// The selection it writes over.
    range: Range<Anchor>,
    shown: Vec<&'static PaletteSymbol>,
    active: usize,
    scroll: ScrollHandle,
    /// The source's bounds, for its place.
    view: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// How many of the cells drawn last are settled: KaTeX's picture is
    /// in, or KaTeX cannot set the command (its name shows).
    drawn: Cell<usize>,
    _subscription: Subscription,
}

impl EditorPanel {
    /// ⌥⌘M's handler, on the panel's element: the palette opens in a LaTeX
    /// source with the keyboard in its text, else the key goes on.
    pub(super) fn symbol_palette_actions(element: gpui::Div, cx: &mut Context<Self>) -> gpui::Div {
        element.on_action(cx.listener(|this, _: &InsertMathSymbol, window, cx| {
            let tex = lattice_editor::latex::is_tex_source(std::path::Path::new(this.relative()));
            if !tex || !this.editor().focus_handle(cx).is_focused(window) {
                cx.propagate();
                return;
            }
            this.open_symbol_palette(window, cx)
        }))
    }

    /// Whether the palette is open.
    pub(crate) fn symbol_palette_open(&self) -> bool {
        self.symbols.is_some()
    }

    /// The commands the palette lists now, the highlighted one's index, and
    /// how many of the cells drawn last hold KaTeX's picture, for the e2e
    /// checks.
    pub(crate) fn symbol_palette_shown(&self) -> Option<(Vec<&'static str>, usize, usize)> {
        let palette = self.symbols.as_ref()?;
        Some((
            palette.shown.iter().map(|symbol| symbol.name).collect(),
            palette.active,
            palette.drawn.get(),
        ))
    }

    /// Whether the highlighted cell lies wholly inside the grid's visible
    /// part, for the e2e checks.
    pub(crate) fn symbol_palette_highlight_in_view(&self) -> Option<bool> {
        let palette = self.symbols.as_ref()?;
        let cell = palette.scroll.bounds_for_item(palette.active)?;
        let grid = palette.scroll.bounds();
        let offset = palette.scroll.offset().y;
        Some(cell.top() + offset >= grid.top() && cell.bottom() + offset <= grid.bottom())
    }

    fn open_symbol_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let range = self.editor().update(cx, |editor, cx| {
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            let selection = editor.selections.newest_anchor();
            (
                selection.start.to_offset(&snapshot).0,
                selection.end.to_offset(&snapshot).0,
            )
        });
        let text = self.buffer.read(cx).snapshot();
        let range = text.anchor_before(range.0)..text.anchor_after(range.1);
        let input = cx.new(|cx| {
            InputState::new(window, cx).placeholder(t!("Search by symbol, command or meaning"))
        });
        let subscription = cx.subscribe_in(
            &input,
            window,
            |this, input, event: &InputEvent, window, cx| match event {
                InputEvent::Change => {
                    let query = input.read(cx).value().to_string();
                    if let Some(palette) = &mut this.symbols {
                        palette.shown = match_symbols(&query);
                        palette.active = 0;
                        palette.scroll.scroll_to_item(0);
                    }
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => {
                    let active = this
                        .symbols
                        .as_ref()
                        .and_then(|palette| palette.shown.get(palette.active).copied());
                    if let Some(symbol) = active {
                        this.insert_symbol(symbol, window, cx);
                    }
                }
                InputEvent::Blur => {
                    this.symbols = None;
                    cx.notify();
                }
                InputEvent::Focus => {}
            },
        );
        let focus = input.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        self.symbols = Some(SymbolPalette {
            input,
            range,
            shown: match_symbols(""),
            active: 0,
            scroll: ScrollHandle::new(),
            view: Rc::default(),
            drawn: Cell::new(0),
            _subscription: subscription,
        });
        cx.notify();
    }

    /// Close the palette, the keyboard back in the text.
    fn close_symbol_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.symbols.take().is_some() {
            let focus = self.editor().focus_handle(cx);
            window.focus(&focus, cx);
            cx.notify();
        }
    }

    /// Write `symbol` over the selection the palette opened on, the caret
    /// in its first argument (`insertSymbol`), and close the palette.
    pub(crate) fn insert_symbol(
        &mut self,
        symbol: &'static PaletteSymbol,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(palette) = self.symbols.take() else {
            return;
        };
        let text = self.buffer.read(cx).snapshot();
        let (from, to) = (
            palette.range.start.to_offset(&text),
            palette.range.end.to_offset(&text),
        );
        let (insert, caret) = insertion(&text.text(), from..to, symbol);
        self.replace_range(from, to, &insert, from + caret, window, cx);
        cx.notify();
    }

    /// Move the highlight by `step` cells, kept on the grid.
    fn move_symbol_highlight(&mut self, step: isize, cx: &mut Context<Self>) {
        let Some(palette) = &mut self.symbols else {
            return;
        };
        let last = palette.shown.len().saturating_sub(1) as isize;
        palette.active = (palette.active as isize + step).clamp(0, last.max(0)) as usize;
        palette.scroll.scroll_to_item(palette.active);
        cx.notify();
    }

    /// The palette under the caret it opened at (above it when there is no
    /// room below), as CodeMirror places the tooltip.
    pub(super) fn symbol_palette_popover(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let palette = self.symbols.as_ref()?;
        let view_cell = palette.view.clone();
        let tracker = canvas(
            move |bounds, _, _| view_cell.set(Some(bounds)),
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .into_any_element();
        let at = palette
            .range
            .end
            .to_offset(&self.buffer.read(cx).snapshot());
        let (Some(view), Some(_)) = (palette.view.get(), self.lattice.read(cx).painted().bounds)
        else {
            cx.on_next_frame(window, |_, _, cx| cx.notify());
            return Some(tracker);
        };
        let Some(anchor) = self
            .lattice
            .update(cx, |lattice, cx| lattice.offset_bounds(at, window, cx))
        else {
            return Some(tracker);
        };
        let palette = self.symbols.as_ref()?;
        let width = px(WIDTH).min((view.size.width - px(32.)).max(px(200.)));
        let height = symbol_palette_height(palette.shown.len(), window.rem_size());
        let below = view.bottom() - anchor.bottom() >= height + px(MARGIN)
            || anchor.top() - view.top() < height + px(MARGIN);
        let left = (anchor.left() - view.left())
            .max(px(MARGIN))
            .min((view.size.width - width - px(MARGIN)).max(px(MARGIN)));
        let top = if below {
            anchor.bottom() + px(MARGIN) - view.top()
        } else {
            anchor.top() - px(MARGIN) - height - view.top()
        };
        let body = self.symbol_palette_body(width, window, cx);
        let from = if below {
            PopFrom::Below
        } else {
            PopFrom::Above
        };
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(tracker)
                .child(div().absolute().left(left).top(top).child(pop_in(
                    "symbol-palette-in",
                    from,
                    body,
                )))
                .into_any_element(),
        )
    }

    fn symbol_palette_body(
        &mut self,
        width: Pixels,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let rem = window.rem_size();
        let caption = tokens::TEXT_CAPTION.to_pixels(rem);
        let panel = cx.entity_id();
        let Some(state) = self.symbols.as_ref() else {
            return div().into_any_element();
        };
        let query = state.input.read(cx).value().trim().to_string();
        let mut drawn = 0;
        let cells: Vec<AnyElement> = state
            .shown
            .iter()
            .enumerate()
            .map(|(index, symbol)| {
                let symbol: &'static PaletteSymbol = symbol;
                let request = MathRequest {
                    tex: symbol.tex(),
                    display: false,
                    size: caption,
                    color: palette.text,
                    macros: MacroSources::default(),
                };
                let content = match previews::math_for(&request, panel, cx) {
                    Some(Preview::Ready(Some(picture))) => {
                        drawn += 1;
                        img(picture.image.clone())
                            .w(picture.width)
                            .h(picture.height)
                            .into_any_element()
                    }
                    // A command KaTeX cannot set (or no math page) shows
                    // its name; one still being set, its symbol's text.
                    Some(Preview::Ready(None)) | None => {
                        drawn += 1;
                        div()
                            .text_size(caption)
                            .child(symbol.name)
                            .into_any_element()
                    }
                    Some(Preview::Loading) => div()
                        .text_size(caption)
                        .child(if symbol.glyph.is_empty() {
                            symbol.name
                        } else {
                            symbol.glyph
                        })
                        .into_any_element(),
                };
                let title = symbol.title();
                div()
                    .id(("symbol-palette-option", index))
                    .h(px(CELL_HEIGHT))
                    .flex()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .rounded(tokens::RADIUS_CONTROL)
                    .cursor_pointer()
                    .when(index == state.active, |cell| cell.bg(palette.hover))
                    .hover(|cell| cell.bg(palette.hover))
                    .tooltip(move |_, cx| {
                        LatticeTooltip::view(gpui::SharedString::from(title.clone()), None, cx)
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.insert_symbol(symbol, window, cx)
                    }))
                    .child(content)
                    .into_any_element()
            })
            .collect();
        state.drawn.set(drawn);
        let empty = state.shown.is_empty();
        div()
            .id("symbol-palette")
            .w(width)
            .p(tokens::SPACING_4)
            .rounded(tokens::RADIUS_PANEL)
            .bg(palette.raised.opacity(0.97))
            .shadow(Elevation::Popover.shadows(&palette))
            .text_color(palette.text)
            .occlude()
            // A click on a cell keeps the keyboard in the search, so the
            // palette stays open under the pointer.
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            // The arrows move the highlight, never the search's caret, as
            // the Tauri palette takes them from its field: the field binds
            // them to its own moves, which run before any key listener, so
            // they are taken as those actions here, on the way down.
            .capture_action(cx.listener(|this, _: &MoveLeft, _, cx| {
                cx.stop_propagation();
                this.move_symbol_highlight(-1, cx)
            }))
            .capture_action(cx.listener(|this, _: &MoveRight, _, cx| {
                cx.stop_propagation();
                this.move_symbol_highlight(1, cx)
            }))
            .capture_action(cx.listener(|this, _: &MoveUp, _, cx| {
                cx.stop_propagation();
                this.move_symbol_highlight(-(COLUMNS as isize), cx)
            }))
            .capture_action(cx.listener(|this, _: &MoveDown, _, cx| {
                cx.stop_propagation();
                this.move_symbol_highlight(COLUMNS as isize, cx)
            }))
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    this.close_symbol_palette(window, cx);
                }
            }))
            .child(
                div()
                    .h(px(FIELD_HEIGHT))
                    .mb(tokens::SPACING_3)
                    .px(tokens::SPACING_4)
                    .flex()
                    .items_center()
                    .border_1()
                    .border_color(palette.line)
                    .rounded(tokens::RADIUS_CONTROL)
                    .bg(palette.editor)
                    .text_role(TextRole::Caption, cx)
                    .child(Input::new(&state.input).appearance(false).px_0().py_0()),
            )
            .child(
                div()
                    .id("symbol-palette-grid")
                    .max_h(px(GRID_MAX_HEIGHT))
                    .overflow_y_scroll()
                    .track_scroll(&state.scroll)
                    .grid()
                    .grid_cols(COLUMNS as u16)
                    .children(cells),
            )
            .when(empty, |body| {
                body.child(
                    div()
                        .mt(tokens::SPACING_3)
                        .text_color(palette.text_secondary)
                        .text_size(tokens::TEXT_MICRO.to_pixels(rem))
                        .line_height(tokens::LEADING_MICRO.to_pixels(rem))
                        .truncate()
                        .child(t!("No symbol matches “{query}”.", query = query).to_string()),
                )
            })
            .into_any_element()
    }
}

/// The palette's height with `shown` cells: its padding, the search field
/// and its margin, the grid (up to its tallest), and the empty-state line
/// when nothing matches, so it is placed right on the frame it opens.
fn symbol_palette_height(shown: usize, rem: Pixels) -> Pixels {
    let rows = shown.div_ceil(COLUMNS);
    let grid = px((rows as f32 * CELL_HEIGHT).min(GRID_MAX_HEIGHT));
    let empty = if shown == 0 {
        tokens::SPACING_3.to_pixels(rem) + tokens::LEADING_MICRO.to_pixels(rem)
    } else {
        px(0.)
    };
    tokens::SPACING_4.to_pixels(rem) * 2.
        + px(FIELD_HEIGHT)
        + tokens::SPACING_3.to_pixels(rem)
        + grid
        + empty
}
