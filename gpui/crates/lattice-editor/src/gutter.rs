//! Gutter marks: a sign beside a line, in the gutter's free left edge.
//!
//! CodeMirror's `gutter` with `GutterMarker`s (the Tauri app's annotation
//! pins) and its lint gutter put a marker in a column beside the line
//! numbers. The adapter's source gutter (`adapter/gutter_column.rs`, in
//! place of Zed's) draws only line numbers and fold markers, so the overlay
//! paints marks over the gutter's left edge, where the line numbers
//! (right-aligned, four digits wide) leave room, row by row in the editor's
//! own coordinates so they scroll with the text. A mark may carry a hover card, opened like a text hover.
//!
//! A pin (the annotation's numbered mark, `.cm-annotation-pin`) stands over
//! the fold column instead, centred 6px inside the gutter's end, on its
//! line's first row: a pill as wide as its number, ringed in the editor's
//! ground and its own ink when more than one note starts on the line.

use gpui::{
    App, Bounds, FontWeight, Hsla, Pixels, SharedString, TextRun, Window, fill, font, point, px,
    size,
};
use lattice_ui::ActiveLattice as _;

use crate::hover::HoverCard;

/// The diameter of a dot mark: the remote caret's dot, at the same quiet size.
pub const DOT: Pixels = px(6.);
/// How far the dot's centre sits from the gutter's left edge.
pub const DOT_INSET: Pixels = px(7.);

/// What a gutter mark looks like.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum GutterShape {
    /// A small filled circle, centred on the line.
    #[default]
    Dot,
    /// A numbered pill over the fold column, `size` tall and at least as
    /// wide, its figure in `ink`; `more` rings it.
    Pin {
        label: SharedString,
        ink: Hsla,
        more: bool,
        size: Pixels,
    },
}

/// How far a pin's centre stands inside the gutter's end.
pub const PIN_INSET: Pixels = px(6.);
/// The pin's figure: the micro role's 11px, medium.
const PIN_TEXT: Pixels = px(11.);

/// A mark beside one line.
#[derive(Clone)]
pub struct GutterMark {
    /// The buffer row, 0-based.
    pub line: u32,
    pub color: Hsla,
    pub shape: GutterShape,
    /// The card the mark opens on hover, if any.
    pub hover: Option<HoverCard>,
}

/// Where a mark is drawn and answers the pointer, for a line whose display
/// row starts at `row_top` with `line_height`, in an editor whose gutter
/// starts at `left`.
pub(crate) fn mark_bounds(left: Pixels, row_top: Pixels, line_height: Pixels) -> Bounds<Pixels> {
    let center_y = row_top + line_height / 2.;
    Bounds {
        origin: point(left + DOT_INSET - DOT / 2., center_y - DOT / 2.),
        size: size(DOT, DOT),
    }
}

/// The area that opens a dot's card: the gutter's left edge over its whole
/// line, so the pointer need not land on a 6px dot.
#[cfg(test)]
pub(crate) fn hover_bounds(left: Pixels, row_top: Pixels, line_height: Pixels) -> Bounds<Pixels> {
    Bounds {
        origin: point(left, row_top),
        size: size(DOT_INSET * 2., line_height),
    }
}

/// Where a pin is drawn, for a line whose display row starts at `row_top`,
/// in a gutter that ends at `end`: centred `PIN_INSET` inside it, on the
/// line's first row, as wide as its figure.
pub(crate) fn pin_bounds(
    label: &str,
    pin: Pixels,
    end: Pixels,
    row_top: Pixels,
    line_height: Pixels,
    window: &mut Window,
    cx: &App,
) -> Bounds<Pixels> {
    let figure = shape_figure(label, Hsla::default(), window, cx).width;
    // `padding-inline: var(--gap-tight)`, 2px on either side.
    let width = (figure + px(4.)).max(pin);
    let center = point(end - PIN_INSET, row_top + line_height / 2.);
    Bounds {
        origin: point(center.x - width / 2., center.y - pin / 2.),
        size: size(width, pin),
    }
}

fn shape_figure(label: &str, color: Hsla, window: &mut Window, cx: &App) -> gpui::ShapedLine {
    let mut face = font(cx.lattice().fonts.ui.clone());
    face.weight = FontWeight::MEDIUM;
    face.fallbacks = Some(lattice_ui::fonts::Fonts::ui_fallbacks());
    face.features = lattice_ui::typography::tabular_nums();
    let run = TextRun {
        len: label.len(),
        font: face,
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window.text_system().shape_line(
        SharedString::from(label.to_string()),
        PIN_TEXT,
        &[run],
        None,
    )
}

/// The area that opens a mark's card or answers a press on it: the mark's
/// own width (a dot's whole left edge) over its whole line.
pub(crate) fn hover_area(mark: Bounds<Pixels>, line_height: Pixels) -> Bounds<Pixels> {
    let center = mark.center();
    let left = mark.left().min(center.x - DOT_INSET);
    let width = (DOT_INSET * 2.).max(mark.size.width);
    Bounds {
        origin: point(left, center.y - line_height / 2.),
        size: size(width, line_height),
    }
}

pub(crate) fn paint(
    shape: &GutterShape,
    bounds: Bounds<Pixels>,
    color: Hsla,
    ground: Hsla,
    window: &mut Window,
    cx: &mut App,
) {
    match shape {
        GutterShape::Dot => window.paint_quad(fill(bounds, color).corner_radii(DOT / 2.)),
        GutterShape::Pin {
            label, ink, more, ..
        } => {
            let radius = bounds.size.height / 2.;
            if *more {
                // `box-shadow: 0 0 0 2px var(--code-ground), 0 0 0 3px ink`.
                let ring = |by: Pixels| Bounds {
                    origin: point(bounds.left() - by, bounds.top() - by),
                    size: size(bounds.size.width + by * 2., bounds.size.height + by * 2.),
                };
                window.paint_quad(fill(ring(px(3.)), color).corner_radii(radius + px(3.)));
                window.paint_quad(fill(ring(px(2.)), ground).corner_radii(radius + px(2.)));
            }
            window.paint_quad(fill(bounds, color).corner_radii(radius));
            let line = shape_figure(label, *ink, window, cx);
            let line_height = bounds.size.height;
            let origin = point(
                bounds.center().x - line.width / 2.,
                bounds.top() + (line_height - px(14.)) / 2.,
            );
            let _ = line.paint(origin, px(14.), gpui::TextAlign::Left, None, window, cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dot_is_centred_on_its_line_at_the_gutter_edge() {
        let bounds = mark_bounds(px(100.), px(40.), px(22.));
        assert_eq!(bounds.size, size(DOT, DOT));
        assert_eq!(bounds.center(), point(px(107.), px(51.)));
        let hover = hover_bounds(px(100.), px(40.), px(22.));
        assert!(hover.contains(&bounds.center()));
        assert_eq!(hover.size.height, px(22.));
        assert_eq!(hover_area(bounds, px(22.)), hover);
    }
}
