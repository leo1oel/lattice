//! Inline texts: text shown between the buffer's characters that is not in
//! the buffer, as CodeMirror's inline widget decorations (side −1) show it.
//! Overleaf's suggested deletions are the use: their text has left the
//! document, so it occupies no offsets, only a point, and is shown there
//! struck through in its author's colour.
//!
//! Each is one of Zed's inlays, which take room in the line as text does and
//! move with edits. Zed styles every inlay of a kind with the editor's one
//! inlay style (the theme's `hint`), and keeps per-inlay styling to itself,
//! so the strike and the tint in each one's own colour are painted over it by
//! the adapter's overlay, measured with the editor's text style. An inlay is
//! anchored after its point, so the caret at the point stands before it,
//! and the inlay starts at the caret's left.

use gpui::{App, Bounds, Hsla, Pixels, SharedString, TextRun, Window, fill, point, px, size};

/// A text shown at a point of the buffer.
#[derive(Clone, Debug, PartialEq)]
pub struct InlineText {
    /// Byte offset of the point it stands at.
    pub offset: usize,
    pub text: SharedString,
    /// The strike's colour.
    pub color: Hsla,
    /// The wash behind it.
    pub tint: Hsla,
}

/// The strike's thickness (`text-decoration-thickness: 2px`).
pub const STRIKE: Pixels = px(2.);

/// The width `text` takes in the editor's text style.
pub fn text_width(text: &str, style: &gpui::TextStyle, window: &mut Window, _cx: &App) -> Pixels {
    let font_size = style.font_size.to_pixels(window.rem_size());
    let run = TextRun {
        len: text.len(),
        font: style.font(),
        color: style.color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window
        .text_system()
        .shape_line(
            SharedString::from(text.to_string()),
            font_size,
            &[run],
            None,
        )
        .width
}

/// The wash and the strike across an inline text standing at `left`,
/// `top` on a line `line_height` tall, `width` wide.
pub(crate) fn paint(
    left: Pixels,
    top: Pixels,
    width: Pixels,
    line_height: Pixels,
    item: &InlineText,
    window: &mut Window,
) -> Bounds<Pixels> {
    let bounds = Bounds {
        origin: point(left, top),
        size: size(width, line_height),
    };
    window.paint_quad(fill(bounds, item.tint).corner_radii(px(2.)));
    let strike = Bounds {
        origin: point(left, top + (line_height - STRIKE) / 2.),
        size: size(width, STRIKE),
    };
    window.paint_quad(fill(strike, item.color));
    bounds
}
