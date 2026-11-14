//! The terminal's screen as one GPUI element: the grid Zed's terminal holds,
//! drawn the way the Tauri app's xterm.js draws it (`terminal-screen.ts`).
//!
//! The grid, block glyphs and background batching are Zed's
//! (`terminal_view/src/terminal_element.rs` at the pinned revision), trimmed
//! of what only Zed's workspace uses; what the screen looks like is
//! xterm.js's as the Tauri app configures it: the code theme's colours
//! (`lattice_ui::editor_theme::terminal`), any colour a program picks lifted
//! to 4.5:1 on its ground (`minimumContrastRatio`, [`super::contrast`]),
//! bold text in the bright colours, faint text at half its ink, a 1px bar
//! caret that blinks, outlined while the terminal is not focused, the
//! selection in the code theme's selection colour (its unfocused one without
//! focus) and the find matches in the unfocused one with the current match
//! in the focused one. ⌘ held over a link underlines it and shows the
//! pointing hand; ⌘-click opens it (Zed's terminal emits `Open`).

use gpui::{
    App, Bounds, ContentMask, DispatchPhase, Element, ElementId, Entity, FocusHandle, Font,
    GlobalElementId, Hitbox, Hsla, InteractiveElement, Interactivity, IntoElement, LayoutId,
    ModifiersChangedEvent, MouseButton, MouseMoveEvent, Pixels, Window, fill, point, px, relative,
    size,
};
use lattice_ui::editor_theme::terminal::TerminalColors;
use terminal::{CursorShape, Modes, MouseInputMode, Range, Terminal, TerminalBounds};

mod grid;
mod input;
mod paint;

use grid::{BatchedTextRun, Region, SUBCELL_COLUMNS, SUBCELL_LINES, layout_grid};
use input::TerminalInputHandler;
use paint::{paint_cursor, paint_marked_text, paint_range};

use super::screen::TerminalScreen;

/// What xterm.js's fit leaves at the right of the grid for its scrollbar
/// (`DEFAULT_SCROLL_BAR_WIDTH`): the same columns fit, and Lattice's own bar
/// stands over it.
pub const SCROLLBAR_GUTTER: Pixels = px(14.);

/// How the screen is drawn this frame.
#[derive(Clone)]
pub struct ScreenStyle {
    pub colors: TerminalColors,
    pub font: Font,
    pub font_size: Pixels,
    /// The font size times xterm.js's `lineHeight` (1.2).
    pub line_height: Pixels,
}

/// Everything prepaint works out for paint.
pub struct LayoutState {
    hitbox: Hitbox,
    runs: Vec<BatchedTextRun>,
    backgrounds: Vec<Region>,
    blocks: Vec<Region>,
    highlights: Vec<(Range, Hsla)>,
    cursor: Option<(Bounds<Pixels>, CursorShape, Option<(char, Hsla)>)>,
    ime_bounds: Option<Bounds<Pixels>>,
    dimensions: TerminalBounds,
    display_offset: usize,
    link_under_pointer: bool,
}

/// The terminal's screen.
pub struct TerminalElement {
    terminal: Entity<Terminal>,
    screen: Entity<TerminalScreen>,
    focus: FocusHandle,
    focused: bool,
    cursor_visible: bool,
    /// The find field is open: the current match is drawn as focused.
    finding: bool,
    style: ScreenStyle,
    interactivity: Interactivity,
}

impl InteractiveElement for TerminalElement {
    fn interactivity(&mut self) -> &mut Interactivity {
        &mut self.interactivity
    }
}

impl gpui::StatefulInteractiveElement for TerminalElement {}

impl TerminalElement {
    pub fn new(
        terminal: Entity<Terminal>,
        screen: Entity<TerminalScreen>,
        focus: FocusHandle,
        focused: bool,
        cursor_visible: bool,
        finding: bool,
        style: ScreenStyle,
    ) -> Self {
        TerminalElement {
            terminal,
            screen,
            focus: focus.clone(),
            focused,
            cursor_visible,
            finding,
            style,
            interactivity: Interactivity::default(),
        }
        .track_focus(&focus)
    }
}

impl TerminalElement {
    fn register_mouse_listeners(&mut self, hitbox: &Hitbox, window: &mut Window) {
        let mode = MouseInputMode::ReportToTerminal;
        let focus = self.focus.clone();
        let terminal = self.terminal.clone();
        self.interactivity.on_mouse_down(MouseButton::Left, {
            let terminal = terminal.clone();
            let focus = focus.clone();
            move |event, window, cx| {
                window.focus(&focus, cx);
                terminal.update(cx, |terminal, cx| {
                    terminal.mouse_down(event, mode, cx);
                    cx.notify();
                });
            }
        });
        window.on_mouse_event({
            let terminal = terminal.clone();
            let hitbox = hitbox.clone();
            let focus = focus.clone();
            move |event: &MouseMoveEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                if event.pressed_button.is_some()
                    && !cx.has_active_drag()
                    && focus.is_focused(window)
                {
                    let hovered = hitbox.is_hovered(window);
                    terminal.update(cx, |terminal, cx| {
                        if terminal.selection_started() || hovered {
                            terminal.mouse_drag(event, hitbox.bounds, mode, cx);
                            cx.notify();
                        }
                    });
                }
                if hitbox.is_hovered(window) {
                    terminal.update(cx, |terminal, cx| terminal.mouse_move(event, mode, cx));
                }
            }
        });
        for button in [MouseButton::Left, MouseButton::Middle, MouseButton::Right] {
            self.interactivity.on_mouse_up(button, {
                let terminal = terminal.clone();
                let focus = focus.clone();
                move |event, window, cx| {
                    if !focus.is_focused(window) {
                        return;
                    }
                    if button != MouseButton::Left
                        && !terminal
                            .read(cx)
                            .last_content
                            .mode
                            .intersects(Modes::MOUSE_MODE)
                    {
                        return;
                    }
                    terminal.update(cx, |terminal, cx| {
                        terminal.mouse_up(event, mode, cx);
                        cx.notify();
                    });
                }
            });
        }
        for button in [MouseButton::Middle, MouseButton::Right] {
            self.interactivity.on_mouse_down(button, {
                let terminal = terminal.clone();
                let focus = focus.clone();
                move |event, window, cx| {
                    window.focus(&focus, cx);
                    let reports = terminal
                        .read(cx)
                        .last_content
                        .mode
                        .intersects(Modes::MOUSE_MODE);
                    terminal.update(cx, |terminal, cx| {
                        if reports && !event.modifiers.shift {
                            terminal.mouse_down(event, mode, cx);
                        } else if button == MouseButton::Right {
                            // xterm.js's `rightClickSelectsWord`.
                            terminal.select_word_at_event_position(event);
                        }
                        cx.notify();
                    });
                }
            });
        }
        let screen = self.screen.downgrade();
        self.interactivity.on_scroll(move |event, _, cx| {
            screen
                .update(cx, |screen, cx| screen.scroll_wheel(event, cx))
                .ok();
        });
    }
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = LayoutState;

    fn id(&self) -> Option<ElementId> {
        self.interactivity.element_id.clone()
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let layout_id = self.interactivity.request_layout(
            global_id,
            inspector_id,
            window,
            cx,
            |mut style, window, cx| {
                style.size.width = relative(1.).into();
                style.size.height = relative(1.).into();
                window.request_layout(style, None, cx)
            },
        );
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.interactivity.prepaint(
            global_id,
            inspector_id,
            bounds,
            bounds.size,
            window,
            cx,
            |_, _, hitbox, window, cx| {
                let hitbox = hitbox.expect("the terminal is hit-tested");
                let font_id = cx.text_system().resolve_font(&self.style.font);
                let cell_width = cx
                    .text_system()
                    .advance(font_id, self.style.font_size, 'm')
                    .map(|advance| advance.width)
                    .unwrap_or(self.style.font_size * 0.6);
                let scale = window.scale_factor().max(1.);
                let snap = |value: Pixels| px((f32::from(value) * scale).floor() / scale);
                // Whole rows from the top, as xterm.js fits them; what is
                // left over stays at the foot.
                let line_device = (f32::from(self.style.line_height) * scale).round().max(1.);
                let line_height = px(line_device / scale);
                let mut size = bounds.size;
                size.width = (size.width - SCROLLBAR_GUTTER).max(cell_width * 2.);
                let rows = ((f32::from(size.height) * scale).floor() / line_device).max(1.);
                size.height = line_height * rows.floor();
                let origin = point(snap(bounds.origin.x), snap(bounds.origin.y));
                let wanted = TerminalBounds::new(line_height, cell_width, Bounds { origin, size });
                let dimensions = self
                    .screen
                    .update(cx, |screen, cx| screen.settled_bounds(wanted, cx));

                let secondary = window.modifiers().secondary(cx);
                let (link, display_offset, matches) = self.terminal.update(cx, |terminal, cx| {
                    terminal.set_size(dimensions);
                    terminal.sync(window, cx);
                    let content = &terminal.last_content;
                    let link = (secondary && bounds.contains(&window.mouse_position()))
                        .then(|| {
                            content
                                .last_hovered_word
                                .as_ref()
                                .filter(|_| self.screen.read(cx).link_hovered())
                                .map(|word| word.word_match)
                        })
                        .flatten();
                    (link, content.display_offset, terminal.matches.clone())
                });

                let colors = self.style.colors;
                let content = &self.terminal.read(cx).last_content;
                let (runs, backgrounds, blocks) =
                    layout_grid(&self.style, content.cells.iter(), link, cx);

                let mut highlights = Vec::with_capacity(matches.len() + 1);
                for found in matches {
                    highlights.push((found, colors.selection_inactive));
                }
                if let Some(selection) = &content.selection {
                    let color = if self.focused || self.finding {
                        colors.selection
                    } else {
                        colors.selection_inactive
                    };
                    highlights.push((selection.point_range(), color));
                }

                let cursor_line = content.cursor.point.line + display_offset as i32;
                let ime_bounds = (cursor_line >= 0
                    && (cursor_line as usize) < dimensions.num_lines())
                .then(|| Bounds {
                    origin: point(
                        (content.cursor.point.column as f32 * cell_width).floor(),
                        (cursor_line as f32 * line_height).floor(),
                    ),
                    size: gpui::size(cell_width.ceil(), line_height),
                });
                let cursor = match content.cursor.shape {
                    CursorShape::Hidden => None,
                    shape => ime_bounds.map(|bounds| {
                        let under = content.cursor_char;
                        let text = (shape == CursorShape::Block && !under.is_whitespace())
                            .then_some((under, colors.ground));
                        (bounds, shape, text)
                    }),
                };
                let link_under_pointer = link.is_some();
                LayoutState {
                    hitbox,
                    runs,
                    backgrounds,
                    blocks,
                    highlights,
                    cursor,
                    ime_bounds,
                    dimensions,
                    display_offset,
                    link_under_pointer,
                }
            },
        )
    }

    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        layout: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            let origin = layout.dimensions.bounds.origin;
            let marked = self.screen.read(cx).marked_text().map(str::to_owned);
            let handler = TerminalInputHandler {
                screen: self.screen.clone(),
                cursor_bounds: layout.ime_bounds.map(|bounds| bounds + origin),
                cell_width: layout.dimensions.cell_width,
            };
            self.register_mouse_listeners(&layout.hitbox, window);
            window.set_cursor_style(
                if layout.link_under_pointer {
                    gpui::CursorStyle::PointingHand
                } else {
                    gpui::CursorStyle::IBeam
                },
                &layout.hitbox,
            );
            let cursor = layout.cursor.take();
            let font_size = self.style.font_size;
            let colors = self.style.colors;
            let cursor_visible = self.cursor_visible;
            let focused = self.focused;
            self.interactivity.paint(
                global_id,
                inspector_id,
                bounds,
                Some(&layout.hitbox),
                window,
                cx,
                |_, window, cx| {
                    window.handle_input(&self.focus, handler, cx);
                    window.on_key_event({
                        let terminal = self.terminal.clone();
                        move |event: &ModifiersChangedEvent, phase, window, cx| {
                            if phase != DispatchPhase::Bubble {
                                return;
                            }
                            terminal.update(cx, |terminal, cx| {
                                terminal.try_modifiers_change(&event.modifiers, window, cx)
                            });
                        }
                    });
                    let dimensions = &layout.dimensions;
                    for region in &layout.backgrounds {
                        let position = point(
                            (origin.x + region.start_col as f32 * dimensions.cell_width).floor(),
                            origin.y + region.start_line as f32 * dimensions.line_height,
                        );
                        let size = size(
                            (dimensions.cell_width
                                * (region.end_col - region.start_col + 1) as f32)
                                .ceil(),
                            dimensions.line_height
                                * (region.end_line - region.start_line + 1) as f32,
                        );
                        window.paint_quad(fill(Bounds::new(position, size), region.color));
                    }
                    for (range, color) in &layout.highlights {
                        paint_range(
                            range,
                            *color,
                            layout.display_offset,
                            dimensions,
                            origin,
                            window,
                        );
                    }
                    for run in &layout.runs {
                        run.paint(origin, dimensions, font_size, window, cx);
                    }
                    let sub_w = dimensions.cell_width / SUBCELL_COLUMNS as f32;
                    let sub_h = dimensions.line_height / SUBCELL_LINES as f32;
                    for block in &layout.blocks {
                        let position = point(
                            origin.x + block.start_col as f32 * sub_w,
                            origin.y + block.start_line as f32 * sub_h,
                        );
                        let size = size(
                            sub_w * (block.end_col - block.start_col + 1) as f32,
                            sub_h * (block.end_line - block.start_line + 1) as f32,
                        );
                        window.paint_quad(fill(Bounds::new(position, size), block.color));
                    }
                    if let Some(marked) = marked.as_ref().filter(|text| !text.is_empty())
                        && let Some(ime) = layout.ime_bounds
                    {
                        paint_marked_text(marked, ime + origin, &self.style, window, cx);
                    } else if let Some((cell, shape, text)) = cursor {
                        paint_cursor(
                            cell + origin,
                            shape,
                            text,
                            focused,
                            cursor_visible,
                            &self.style,
                            colors.caret,
                            window,
                            cx,
                        );
                    }
                },
            );
        });
    }
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}
