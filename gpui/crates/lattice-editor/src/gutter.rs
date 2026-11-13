//! Gutter marks: a sign beside a line, in the gutter's free left edge.
//!
//! CodeMirror's `gutter` with `GutterMarker`s (the Tauri app's annotation
//! pins) and its lint gutter put a marker in a column beside the line
//! numbers. Zed's gutter draws only its own indicators (breakpoints, code
//! actions, git), so the adapter paints marks over the gutter's left edge,
//! where Lattice's line numbers (right-aligned, four digits wide) leave
//! room, row by row in the editor's own coordinates so they scroll with the
//! text. A mark may carry a hover card, opened like a text hover.

use gpui::{App, Bounds, Hsla, Pixels, Window, fill, point, px, size};

use crate::hover::HoverCard;

/// The diameter of a dot mark: the remote caret's dot, at the same quiet size.
pub const DOT: Pixels = px(6.);
/// How far the dot's centre sits from the gutter's left edge.
pub const DOT_INSET: Pixels = px(7.);

/// What a gutter mark looks like.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GutterShape {
    /// A small filled circle, centred on the line.
    #[default]
    Dot,
}

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

/// The area that opens a mark's card: the gutter's left edge over its whole
/// line, so the pointer need not land on a 6px dot.
pub(crate) fn hover_bounds(left: Pixels, row_top: Pixels, line_height: Pixels) -> Bounds<Pixels> {
    Bounds {
        origin: point(left, row_top),
        size: size(DOT_INSET * 2., line_height),
    }
}

pub(crate) fn paint(
    shape: GutterShape,
    bounds: Bounds<Pixels>,
    color: Hsla,
    window: &mut Window,
    _: &mut App,
) {
    match shape {
        GutterShape::Dot => window.paint_quad(fill(bounds, color).corner_radii(DOT / 2.)),
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
    }
}
