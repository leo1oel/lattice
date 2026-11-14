//! The grid as runs of text, cell backgrounds and block glyphs: Zed's
//! batching (`terminal_view/src/terminal_element.rs` at the pinned revision)
//! with the colours xterm.js gives a cell in the Tauri app: Lattice's
//! terminal palette, bold in the bright colours, faint at half its ink, and a
//! program's colour lifted to 4.5:1 on its ground unless it chose an exact
//! one or draws a decorative glyph.

use std::mem;

use gpui::{
    App, Font, FontStyle, FontWeight, Hsla, Pixels, Point as GpuiPoint, StrikethroughStyle,
    TextRun, UnderlineStyle, Window, point, px,
};
use terminal::{
    Cell, Color, IndexedCell, NamedColor, Range, TerminalBounds, is_app_chosen_exact_color,
    is_default_background_color,
};

use super::ScreenStyle;
use crate::terminal::contrast;

/// xterm.js's `minimumContrastRatio` in the Tauri app.
const MINIMUM_CONTRAST: f32 = 4.5;

/// xterm.js draws faint text at half its ink.
const DIM_OPACITY: f32 = 0.5;

/// A run of cells on one line in one style.
pub(super) struct BatchedTextRun {
    pub(super) line: i32,
    pub(super) column: i32,
    pub(super) text: String,
    pub(super) cell_count: usize,
    pub(super) style: TextRun,
}

impl BatchedTextRun {
    fn new(line: i32, column: i32, c: char, style: TextRun) -> Self {
        let mut text = String::with_capacity(64);
        text.push(c);
        Self {
            line,
            column,
            text,
            cell_count: 1,
            style,
        }
    }

    fn can_append(&self, other: &TextRun) -> bool {
        self.style.font == other.font
            && self.style.color == other.color
            && self.style.background_color == other.background_color
            && self.style.underline == other.underline
            && self.style.strikethrough == other.strikethrough
    }

    fn push(&mut self, c: char, counts_cell: bool) {
        self.text.push(c);
        if counts_cell {
            self.cell_count += 1;
        }
        self.style.len += c.len_utf8();
    }

    pub(super) fn paint(
        &self,
        origin: GpuiPoint<Pixels>,
        dimensions: &TerminalBounds,
        font_size: Pixels,
        window: &mut Window,
        cx: &mut App,
    ) {
        let position = point(
            origin.x + self.column as f32 * dimensions.cell_width,
            origin.y + self.line as f32 * dimensions.line_height,
        );
        let shaped = window.text_system().shape_line(
            self.text.clone().into(),
            font_size,
            std::slice::from_ref(&self.style),
            Some(dimensions.cell_width),
        );
        if let Err(error) = shaped.paint(
            position,
            dimensions.line_height,
            gpui::TextAlign::Left,
            None,
            window,
            cx,
        ) {
            log::debug!("a terminal run did not paint: {error:#}");
        }
    }
}

/// Block element glyphs are filled on a grid of 8 × 24 subcells per cell,
/// as Zed does, so they meet seamlessly whatever the font draws.
pub(super) const SUBCELL_COLUMNS: i32 = 8;

pub(super) const SUBCELL_LINES: i32 = 24;

/// A filled rectangle on the grid (`line` and `column` in cells), or on the
/// subcell grid for block glyphs.
#[derive(Clone, Debug)]
pub(super) struct Region {
    pub(super) start_line: i32,
    pub(super) start_col: i32,
    pub(super) end_line: i32,
    pub(super) end_col: i32,
    pub(super) color: Hsla,
}

impl Region {
    pub(super) fn cell(line: i32, col: i32, color: Hsla) -> Self {
        Self {
            start_line: line,
            start_col: col,
            end_line: line,
            end_col: col,
            color,
        }
    }

    fn can_merge_with(&self, other: &Region) -> bool {
        if self.color != other.color {
            return false;
        }
        if self.start_line == other.start_line && self.end_line == other.end_line {
            return self.end_col + 1 == other.start_col || other.end_col + 1 == self.start_col;
        }
        if self.start_col == other.start_col && self.end_col == other.end_col {
            return self.end_line + 1 == other.start_line || other.end_line + 1 == self.start_line;
        }
        false
    }

    fn merge_with(&mut self, other: &Region) {
        self.start_line = self.start_line.min(other.start_line);
        self.start_col = self.start_col.min(other.start_col);
        self.end_line = self.end_line.max(other.end_line);
        self.end_col = self.end_col.max(other.end_col);
    }
}

pub(super) fn merge_regions(mut regions: Vec<Region>) -> Vec<Region> {
    let mut changed = true;
    while changed {
        changed = false;
        let mut i = 0;
        while i < regions.len() {
            let mut j = i + 1;
            while j < regions.len() {
                if regions[i].can_merge_with(&regions[j]) {
                    let other = regions.remove(j);
                    regions[i].merge_with(&other);
                    changed = true;
                } else {
                    j += 1;
                }
            }
            i += 1;
        }
    }
    regions
}

/// A colour the grid names, in Lattice's terminal palette.
fn grid_color(style: &ScreenStyle, color: &Color, bold: bool, cx: &App) -> Hsla {
    let ansi = &style.colors.ansi;
    match color {
        Color::Named(named) => match named {
            NamedColor::Foreground | NamedColor::BrightForeground | NamedColor::DimForeground => {
                style.colors.ink
            }
            NamedColor::Background => style.colors.ground,
            NamedColor::Cursor => style.colors.caret,
            named => {
                let index = match named {
                    NamedColor::Black | NamedColor::DimBlack => 0,
                    NamedColor::Red | NamedColor::DimRed => 1,
                    NamedColor::Green | NamedColor::DimGreen => 2,
                    NamedColor::Yellow | NamedColor::DimYellow => 3,
                    NamedColor::Blue | NamedColor::DimBlue => 4,
                    NamedColor::Magenta | NamedColor::DimMagenta => 5,
                    NamedColor::Cyan | NamedColor::DimCyan => 6,
                    NamedColor::White | NamedColor::DimWhite => 7,
                    NamedColor::BrightBlack => 8,
                    NamedColor::BrightRed => 9,
                    NamedColor::BrightGreen => 10,
                    NamedColor::BrightYellow => 11,
                    NamedColor::BrightBlue => 12,
                    NamedColor::BrightMagenta => 13,
                    NamedColor::BrightCyan => 14,
                    _ => 15,
                };
                // xterm.js's `drawBoldTextInBrightColors`.
                ansi[if bold && index < 8 { index + 8 } else { index }]
            }
        },
        Color::Spec(rgb) => terminal::rgba_color(rgb.r, rgb.g, rgb.b),
        Color::Indexed(index) if (*index as usize) < 16 => {
            let index = *index as usize;
            ansi[if bold && index < 8 { index + 8 } else { index }]
        }
        Color::Indexed(index) => {
            terminal::get_color_at_index(*index as usize, theme::ActiveTheme::theme(cx))
        }
    }
}

fn cell_run(
    style: &ScreenStyle,
    cell: &Cell,
    fg: Color,
    bg: Color,
    hyperlink: bool,
    cx: &App,
) -> TextRun {
    let bold = cell.is_bold();
    let exact = is_app_chosen_exact_color(fg);
    let mut ink = grid_color(style, &fg, bold, cx);
    let ground = grid_color(style, &bg, false, cx);
    if !exact && !is_decorative(cell.character()) {
        ink = contrast::ensure(ink, ground, MINIMUM_CONTRAST);
    }
    if cell.is_dim() {
        ink.a *= DIM_OPACITY;
    }
    let underline =
        (cell.has_underline() || cell.hyperlink().is_some() || hyperlink).then(|| UnderlineStyle {
            color: Some(ink),
            thickness: px(1.),
            wavy: cell.has_undercurl(),
        });
    let strikethrough = cell.has_strikeout().then(|| StrikethroughStyle {
        color: Some(ink),
        thickness: px(1.),
    });
    TextRun {
        len: cell.character().len_utf8(),
        color: ink,
        background_color: None,
        font: Font {
            weight: if bold {
                FontWeight::BOLD
            } else {
                style.font.weight
            },
            style: if cell.is_italic() {
                FontStyle::Italic
            } else {
                FontStyle::Normal
            },
            ..style.font.clone()
        },
        underline,
        strikethrough,
    }
}

/// The grid's text runs, cell backgrounds and block glyphs.
pub(super) fn layout_grid<'a>(
    style: &ScreenStyle,
    cells: impl Iterator<Item = &'a IndexedCell>,
    link: Option<Range>,
    cx: &App,
) -> (Vec<BatchedTextRun>, Vec<Region>, Vec<Region>) {
    let mut runs: Vec<BatchedTextRun> = Vec::new();
    let mut backgrounds: Vec<Region> = Vec::new();
    let mut blocks: Vec<Region> = Vec::new();
    let mut current: Option<BatchedTextRun> = None;
    let mut line_index = -1;
    let mut last_line = None;
    let mut previous_had_extras = false;
    for indexed in cells {
        let point = indexed.point;
        if last_line != Some(point.line) {
            last_line = Some(point.line);
            line_index += 1;
            previous_had_extras = false;
            if let Some(run) = current.take() {
                runs.push(run);
            }
        }
        let line = line_index;
        let cell = &indexed.cell;
        let mut fg = cell.foreground();
        let mut bg = cell.background();
        if cell.is_inverse() {
            mem::swap(&mut fg, &mut bg);
        }
        if !is_default_background_color(bg) {
            let color = grid_color(style, &bg, false, cx);
            let col = point.column as i32;
            match backgrounds.last_mut() {
                Some(last)
                    if last.color == color
                        && last.start_line == line
                        && last.end_line == line
                        && last.end_col + 1 == col =>
                {
                    last.end_col = col;
                }
                _ => backgrounds.push(Region::cell(line, col, color)),
            }
        }
        if cell.is_wide_char_spacer() {
            continue;
        }
        if cell.character() == ' ' && previous_had_extras {
            previous_had_extras = false;
            continue;
        }
        previous_had_extras = matches!(cell.zerowidth(), Some(chars) if !chars.is_empty());
        if is_blank(cell) {
            continue;
        }
        let hyperlink = link.is_some_and(|range| range.contains(point));
        let run = cell_run(style, cell, fg, bg, hyperlink, cx);
        let column = point.column as i32;
        if push_block(line, column, cell.character(), run.color, &mut blocks) {
            if let Some(run) = current.take() {
                runs.push(run);
            }
            continue;
        }
        match current.as_mut() {
            Some(batch)
                if batch.can_append(&run)
                    && batch.line == line
                    && batch.column + batch.cell_count as i32 == column =>
            {
                batch.push(cell.character(), true);
                for c in cell.zerowidth().unwrap_or(&[]) {
                    batch.push(*c, false);
                }
            }
            _ => {
                if let Some(run) = current.take() {
                    runs.push(run);
                }
                let mut batch = BatchedTextRun::new(line, column, cell.character(), run);
                for c in cell.zerowidth().unwrap_or(&[]) {
                    batch.push(*c, false);
                }
                current = Some(batch);
            }
        }
    }
    if let Some(run) = current {
        runs.push(run);
    }
    (runs, merge_regions(backgrounds), merge_regions(blocks))
}

/// A cell that draws nothing: a space on the default ground with no
/// visible style and no link.
fn is_blank(cell: &Cell) -> bool {
    cell.character() == ' '
        && is_default_background_color(cell.background())
        && cell.hyperlink().is_none()
        && !cell.has_visible_style_modifier()
}

/// Box drawing, block elements, geometric shapes and Powerline separators:
/// they meet the colours around them exactly, so they are never lifted for
/// contrast (Zed's rule).
pub(super) fn is_decorative(c: char) -> bool {
    matches!(
        c as u32,
        0x2500..=0x257F
            | 0x2580..=0x259F
            | 0x25A0..=0x25FF
            | 0x1FB00..=0x1FB3B
            | 0xE0B0..=0xE0BF
            | 0xE0C0..=0xE0CA
            | 0xE0CC..=0xE0D7
    )
}

/// `(column, line, columns, lines)` in subcells for a block glyph that is
/// one rectangle.
fn block_rect(c: char) -> Option<(i32, i32, i32, i32)> {
    let code = c as u32;
    Some(match code {
        0x2580 => (0, 0, 8, 12),
        0x2581..=0x2588 => {
            let eighths = (code - 0x2580) as i32;
            (0, 24 - eighths * 3, 8, eighths * 3)
        }
        0x2589..=0x258F => (0, 0, (0x2590 - code) as i32, 24),
        0x2590 => (4, 0, 4, 24),
        0x2594 => (0, 0, 8, 3),
        0x2595 => (7, 0, 1, 24),
        _ => return None,
    })
}

fn quadrants(c: char) -> Option<u8> {
    Some(match c {
        '▘' => 0b0001,
        '▝' => 0b0010,
        '▖' => 0b0100,
        '▗' => 0b1000,
        '▚' => 0b1001,
        '▞' => 0b0110,
        '▛' => 0b0111,
        '▜' => 0b1011,
        '▙' => 0b1101,
        '▟' => 0b1110,
        _ => return None,
    })
}

/// A sextant's filled 2×3 subcells as bits (`row * 2 + column`).
pub(super) fn sextants(c: char) -> Option<u8> {
    let offset = (c as u32).checked_sub(0x1FB00)?;
    if offset > 0x3B {
        return None;
    }
    Some((offset + 1 + u32::from(offset >= 20) + u32::from(offset >= 40)) as u8)
}

/// Fill `c` as rectangles when it is a block glyph; false otherwise.
pub(super) fn push_block(
    line: i32,
    column: i32,
    c: char,
    color: Hsla,
    out: &mut Vec<Region>,
) -> bool {
    let mut push = |x: i32, y: i32, w: i32, h: i32, color: Hsla| {
        let start_line = line * SUBCELL_LINES + y;
        let start_col = column * SUBCELL_COLUMNS + x;
        let region = Region {
            start_line,
            start_col,
            end_line: start_line + h - 1,
            end_col: start_col + w - 1,
            color,
        };
        match out.last_mut() {
            Some(last)
                if last.color == color
                    && last.start_line == region.start_line
                    && last.end_line == region.end_line
                    && last.end_col + 1 == region.start_col =>
            {
                last.end_col = region.end_col;
            }
            _ => out.push(region),
        }
    };
    if let Some((x, y, w, h)) = block_rect(c) {
        push(x, y, w, h, color);
        return true;
    }
    if let Some(filled) = quadrants(c) {
        for row in 0..2 {
            for col in 0..2 {
                if filled & (1 << (row * 2 + col)) != 0 {
                    push(col * 4, row * 12, 4, 12, color);
                }
            }
        }
        return true;
    }
    if let Some(filled) = sextants(c) {
        for row in 0..3 {
            for col in 0..2 {
                if filled & (1 << (row * 2 + col)) != 0 {
                    push(col * 4, row * 8, 4, 8, color);
                }
            }
        }
        return true;
    }
    let shade = match c {
        '░' => 0.25,
        '▒' => 0.5,
        '▓' => 0.75,
        _ => return false,
    };
    push(0, 0, 8, 24, color.opacity(shade));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adjacent_regions_of_one_colour_merge() {
        let red = gpui::red();
        let merged = merge_regions(vec![
            Region::cell(0, 0, red),
            Region::cell(0, 1, red),
            Region::cell(0, 3, red),
        ]);
        assert_eq!(merged.len(), 2);
        assert_eq!((merged[0].start_col, merged[0].end_col), (0, 1));
    }

    #[test]
    fn a_full_block_fills_its_cell_and_runs_of_them_merge() {
        let mut out = Vec::new();
        assert!(push_block(0, 0, '█', gpui::black(), &mut out));
        assert!(push_block(0, 1, '█', gpui::black(), &mut out));
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].start_col, out[0].end_col), (0, 15));
        assert_eq!((out[0].start_line, out[0].end_line), (0, 23));
        assert!(!push_block(0, 2, 'a', gpui::black(), &mut out));
    }

    #[test]
    fn sextants_skip_the_four_block_elements() {
        assert_eq!(sextants('\u{1FB00}'), Some(1));
        assert_eq!(sextants('\u{1FB13}'), Some(20));
        assert_eq!(sextants('\u{1FB14}'), Some(22));
        assert_eq!(sextants('a'), None);
    }

    #[test]
    fn decorative_glyphs_are_never_lifted() {
        assert!(is_decorative('─'));
        assert!(is_decorative('\u{E0B0}'));
        assert!(!is_decorative('a'));
    }
}
