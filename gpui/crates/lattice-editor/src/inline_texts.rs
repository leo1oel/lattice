//! Inline texts: text shown between the buffer's characters that is not in
//! the buffer, as CodeMirror's inline widget decorations (side −1) show it.
//! Overleaf's suggested deletions are one use: their text has left the
//! document, so it occupies no offsets, only a point, and is shown there
//! struck through in its author's colour. An accepted proofread's old words
//! are another, struck and folding away. A highlight's colour swatch before
//! its `\colorbox` is the third: the room of a few spaces, with the swatch
//! painted in it.
//!
//! Each is one of Zed's inlays, which take room in the line as text does and
//! move with edits. Zed styles every inlay of a kind with the editor's one
//! inlay style (the theme's `hint`), and keeps per-inlay styling to itself,
//! so the strike and the tint in each one's own colour are painted over it by
//! the adapter's overlay, measured on Zed's own layout of each display row
//! the inlay takes (a soft wrap breaks it as it breaks any text). An inlay
//! is anchored after its point, so the caret at the point stands before it,
//! and the inlay starts at the caret's left; several at one point follow
//! each other in the order they were spliced.

use gpui::{App, Bounds, Hsla, Pixels, SharedString, TextRun, Window, fill, point, px, size};

/// A text shown at a point of the buffer.
#[derive(Clone, Debug, PartialEq)]
pub struct InlineText {
    /// Byte offset of the point it stands at.
    pub offset: usize,
    /// What takes the room: the text Zed lays out (and draws in its inlay
    /// style).
    pub text: SharedString,
    pub look: InlineLook,
}

/// What the overlay paints over an inline text's room.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InlineLook {
    /// Struck text: `tint` washed over the room, and the strike in `color`
    /// drawn across `drawn` of its width from the left, 0 to 1 (an accepted
    /// edit's strike comes in as a `scaleX`).
    Struck { color: Hsla, tint: Hsla, drawn: f32 },
    /// A highlight's colour swatch, standing at the room's start
    /// (`.cm-hl-swatch`: 0.72em square, 3px corners, an 18% ring of the
    /// paper's ink, and 0.35em before the text).
    Swatch(Hsla),
}

impl InlineText {
    /// `text` struck through in `color`, on `tint`.
    pub fn struck(offset: usize, text: impl Into<SharedString>, color: Hsla, tint: Hsla) -> Self {
        Self {
            offset,
            text: text.into(),
            look: InlineLook::Struck {
                color,
                tint,
                drawn: 1.,
            },
        }
    }

    /// A swatch of `color` at `offset`: two spaces of the editor's
    /// monospace font give the 0.72em square and its 0.35em margin room.
    pub fn swatch(offset: usize, color: Hsla) -> Self {
        Self {
            offset,
            text: SWATCH_ROOM.into(),
            look: InlineLook::Swatch(color),
        }
    }
}

/// The room a swatch takes.
pub const SWATCH_ROOM: &str = "  ";
/// The swatch's side, in ems of the editor's font.
const SWATCH_EM: f32 = 0.72;

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

/// What `item` paints over its room on one display row, at `left`, `top`,
/// `width` wide on a line `line_height` tall, in a font `font_size` big.
/// `first` is whether this row holds the room's start (a swatch stands only
/// there).
#[allow(clippy::too_many_arguments)]
pub(crate) fn paint(
    left: Pixels,
    top: Pixels,
    width: Pixels,
    line_height: Pixels,
    font_size: Pixels,
    first: bool,
    item: &InlineText,
    window: &mut Window,
) -> Bounds<Pixels> {
    let bounds = Bounds {
        origin: point(left, top),
        size: size(width, line_height),
    };
    match item.look {
        InlineLook::Struck { color, tint, drawn } => {
            window.paint_quad(fill(bounds, tint).corner_radii(px(2.)));
            let strike = Bounds {
                origin: point(left, top + (line_height - STRIKE) / 2.),
                size: size(width * drawn.clamp(0., 1.), STRIKE),
            };
            if drawn > 0. {
                window.paint_quad(fill(strike, color));
            }
            bounds
        }
        InlineLook::Swatch(color) => {
            if !first {
                return bounds;
            }
            let side = font_size * SWATCH_EM;
            // `vertical-align: -0.04em` from the text's middle.
            let swatch = Bounds {
                origin: point(left, top + (line_height - side) / 2. + font_size * 0.04),
                size: size(side, side),
            };
            let ring = gpui::rgb(0x242426);
            window.paint_quad(
                fill(swatch, color)
                    .corner_radii(px(3.))
                    .border_widths(px(1.))
                    .border_color(Hsla::from(ring).opacity(0.18)),
            );
            swatch
        }
    }
}
