//! What the screen draws over its grid, as xterm.js draws it: the caret
//! (a 1px bar, a block with its character in the ground's colour, a 1px
//! underline, or its cell's outline while the terminal is not focused), an
//! input method's composition at the caret, and a selection or find match as
//! one wash per line.

use gpui::{
    App, Bounds, Hsla, Pixels, Point as GpuiPoint, TextRun, UnderlineStyle, Window, fill, outline,
    point, px, size,
};
use terminal::{CursorShape, Range, TerminalBounds};

use super::ScreenStyle;

/// The caret as xterm.js draws it: a 1px bar, a block with the character
/// over it in the ground's colour, or a 1px underline; while the terminal is
/// not focused, the outline of its cell (`cursorInactiveStyle`).
#[allow(clippy::too_many_arguments)]
pub(super) fn paint_cursor(
    cell: Bounds<Pixels>,
    shape: CursorShape,
    text: Option<(char, Hsla)>,
    focused: bool,
    visible: bool,
    style: &ScreenStyle,
    color: Hsla,
    window: &mut Window,
    cx: &mut App,
) {
    if !focused || shape == CursorShape::HollowBlock {
        window.paint_quad(outline(cell, color, gpui::BorderStyle::Solid));
        return;
    }
    if !visible {
        return;
    }
    match shape {
        CursorShape::Bar => {
            window.paint_quad(fill(
                Bounds::new(cell.origin, size(px(1.), cell.size.height)),
                color,
            ));
        }
        CursorShape::Underline => {
            let origin = point(cell.origin.x, cell.bottom() - px(1.));
            window.paint_quad(fill(
                Bounds::new(origin, size(cell.size.width, px(1.))),
                color,
            ));
        }
        _ => {
            window.paint_quad(fill(cell, color));
            if let Some((c, ink)) = text {
                let text: gpui::SharedString = c.to_string().into();
                let run = TextRun {
                    len: text.len(),
                    font: style.font.clone(),
                    color: ink,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let shaped = window
                    .text_system()
                    .shape_line(text, style.font_size, &[run], None);
                shaped
                    .paint(
                        cell.origin,
                        cell.size.height,
                        gpui::TextAlign::Left,
                        None,
                        window,
                        cx,
                    )
                    .ok();
            }
        }
    }
}

/// Text an input method is composing, over the screen at the caret.
pub(super) fn paint_marked_text(
    text: &str,
    at: Bounds<Pixels>,
    style: &ScreenStyle,
    window: &mut Window,
    cx: &mut App,
) {
    let ink = style.colors.ink;
    let run = TextRun {
        len: text.len(),
        font: style.font.clone(),
        color: ink,
        background_color: None,
        underline: Some(UnderlineStyle {
            color: Some(ink),
            thickness: px(1.),
            wavy: false,
        }),
        strikethrough: None,
    };
    let shaped =
        window
            .text_system()
            .shape_line(text.to_owned().into(), style.font_size, &[run], None);
    window.paint_quad(fill(
        Bounds::new(at.origin, size(shaped.width, at.size.height)),
        style.colors.ground,
    ));
    shaped
        .paint(
            at.origin,
            at.size.height,
            gpui::TextAlign::Left,
            None,
            window,
            cx,
        )
        .ok();
}

/// A selection or a match, as one wash per line it covers.
pub(super) fn paint_range(
    range: &Range,
    color: Hsla,
    display_offset: usize,
    dimensions: &TerminalBounds,
    origin: GpuiPoint<Pixels>,
    window: &mut Window,
) {
    let offset = i32::try_from(display_offset).unwrap_or(i32::MAX);
    let start_line = range.start().line.saturating_add(offset);
    let end_line = range.end().line.saturating_add(offset);
    let lines = dimensions.num_lines() as i32;
    if end_line < 0 || start_line >= lines {
        return;
    }
    for line in start_line.max(0)..=end_line.min(lines - 1) {
        let first = if line == start_line {
            range.start().column
        } else {
            0
        };
        let last = if line == end_line {
            range.end().column + 1
        } else {
            dimensions.num_columns()
        };
        if last <= first {
            continue;
        }
        let position = point(
            origin.x + first as f32 * dimensions.cell_width,
            origin.y + line as f32 * dimensions.line_height,
        );
        let size = size(
            dimensions.cell_width * (last - first) as f32,
            dimensions.line_height,
        );
        window.paint_quad(fill(Bounds::new(position, size), color));
    }
}
