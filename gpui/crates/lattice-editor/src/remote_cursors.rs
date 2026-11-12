//! Other people's carets, drawn as Overleaf draws them
//! (`src/overleaf/overleaf-editor-extensions.ts`): a 2px bar in the
//! person's colour with a 6px dot on its top, and a name tag that shows for
//! a moment when the caret arrives or moves, and while the pointer rests on
//! it. The tag sits above the caret, or below it when the line is too close
//! to the editor's top edge for it to fit. A tag that never went away sat
//! over the line above and hid its text.
//!
//! The adapter keeps the carets anchored in the buffer, so a local edit
//! before one moves it until the person's next position arrives, and paints
//! them over the text in the editor's coordinates.

use std::time::Duration;

use gpui::{
    App, Bounds, Corners, FontWeight, Hsla, Pixels, SharedString, TextRun, Window, fill, font,
    hsla, point, px, size, white,
};
use lattice_ui::ActiveLattice as _;

/// A remote caret, as the collaboration layer reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteCursor {
    /// Stable per person and connection.
    pub id: SharedString,
    /// The person's name; an empty name reads "Anonymous".
    pub name: SharedString,
    pub color: Hsla,
    /// 0-based row and column, clamped into the buffer.
    pub row: u32,
    pub column: u32,
}

/// How long the tag shows after the caret arrives or moves: two seconds
/// named, then a short fade (`cm-overleaf-caret-name`: 2.4s, opaque until
/// 85%, ease-in to nothing).
pub const LABEL_MOMENT: Duration = Duration::from_millis(2400);
const LABEL_HOLD: f32 = 0.85;
/// The tag's type: the micro size, semibold, at 1.2 leading.
const LABEL_SIZE: Pixels = px(11.);
const LABEL_LEADING: f32 = 1.2;
const LABEL_PADDING_X: Pixels = px(5.);
const LABEL_PADDING_Y: Pixels = px(1.);
const LABEL_RADIUS: Pixels = px(4.);
/// The bar: 2px, as tall as the text's em box (1.2 of the 1.6 line).
const BAR_WIDTH: Pixels = px(2.);
const BAR_SHARE_OF_LINE: f32 = 1.2 / 1.6;
const DOT: Pixels = px(6.);

/// Overleaf's colour for a hue, `hsl(hue, 70%, 50%)`.
pub fn hue_color(hue: f32) -> Hsla {
    hsla((hue.rem_euclid(360.)) / 360., 0.7, 0.5, 1.)
}

/// The colour a collaborator is drawn in: the provider's exact `#rrggbb`
/// when it sends one, else its hue (`presenceCursorColor`).
pub fn presence_color(hex: Option<&str>, hue: f32) -> Hsla {
    hex.and_then(parse_hex).unwrap_or_else(|| hue_color(hue))
}

fn parse_hex(hex: &str) -> Option<Hsla> {
    let digits = hex.strip_prefix('#')?;
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(digits, 16).ok()?;
    Some(gpui::rgb(value).into())
}

/// The tag's opacity `elapsed` after the caret arrived or moved.
pub fn label_opacity(elapsed: Duration) -> f32 {
    let t = elapsed.as_secs_f32() / LABEL_MOMENT.as_secs_f32();
    if t <= LABEL_HOLD {
        1.
    } else if t >= 1. {
        0.
    } else {
        // CSS `ease-in`, cubic-bezier(0.42, 0, 1, 1), from 1 to 0.
        let local = (t - LABEL_HOLD) / (1. - LABEL_HOLD);
        1. - ease_in(local)
    }
}

/// `cubic-bezier(0.42, 0, 1, 1)` at progress `x`, solved for its curve
/// parameter by bisection.
fn ease_in(x: f32) -> f32 {
    let bezier = |t: f32, p1: f32, p2: f32| {
        let u = 1. - t;
        3. * u * u * t * p1 + 3. * u * t * t * p2 + t * t * t
    };
    let (mut low, mut high) = (0f32, 1f32);
    for _ in 0..24 {
        let mid = (low + high) / 2.;
        if bezier(mid, 0.42, 1.) < x {
            low = mid;
        } else {
            high = mid;
        }
    }
    bezier((low + high) / 2., 0., 1.)
}

/// Where a caret is drawn: its bar, its dot, its tag and the area that
/// shows the tag on hover.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CaretGeometry {
    pub bar: Bounds<Pixels>,
    pub dot: Bounds<Pixels>,
    pub label: Bounds<Pixels>,
    pub label_below: bool,
    pub hover: Bounds<Pixels>,
}

/// The geometry of a caret at `x` on a line whose display row starts at
/// `row_top`, with a tag `label_width` wide, in an editor whose text area
/// starts at `editor_top`.
pub(crate) fn caret_geometry(
    x: Pixels,
    row_top: Pixels,
    line_height: Pixels,
    label_width: Pixels,
    editor_top: Pixels,
) -> CaretGeometry {
    let bar_height = line_height * BAR_SHARE_OF_LINE;
    let bar_top = row_top + (line_height - bar_height) / 2.;
    let bar = Bounds {
        origin: point(x - BAR_WIDTH / 2., bar_top),
        size: size(BAR_WIDTH, bar_height),
    };
    let dot = Bounds {
        origin: point(x - DOT / 2., bar_top - DOT / 2.),
        size: size(DOT, DOT),
    };
    let label_height = LABEL_SIZE * LABEL_LEADING + LABEL_PADDING_Y * 2.;
    // `top: -1.35em` of the tag's own size above the bar's top.
    let above_top = bar_top - LABEL_SIZE * 1.35;
    let label_below = above_top < editor_top + px(2.);
    let label_top = if label_below {
        bar_top + bar_height + px(2.)
    } else {
        above_top
    };
    let label = Bounds {
        origin: point(x, label_top),
        size: size(label_width, label_height),
    };
    let hover = Bounds {
        origin: point(x - DOT, row_top),
        size: size(DOT * 2., line_height),
    };
    CaretGeometry {
        bar,
        dot,
        label,
        label_below,
        hover,
    }
}

/// The tag's width for `name`, and the shaped line to paint, its white ink
/// at `opacity`.
pub(crate) fn shape_label(
    name: &str,
    opacity: f32,
    window: &mut Window,
    cx: &App,
) -> (gpui::ShapedLine, Pixels) {
    let text: SharedString = if name.trim().is_empty() {
        "Anonymous".into()
    } else {
        SharedString::from(name.to_string())
    };
    let mut label_font = font(cx.lattice().fonts.ui.clone());
    label_font.weight = FontWeight::SEMIBOLD;
    label_font.fallbacks = Some(lattice_ui::fonts::Fonts::ui_fallbacks());
    let run = TextRun {
        len: text.len(),
        font: label_font,
        color: white().opacity(opacity),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let line = window
        .text_system()
        .shape_line(text, LABEL_SIZE, &[run], None);
    let width = line.width + LABEL_PADDING_X * 2.;
    (line, width)
}

/// Paint one caret; the tag at `label_opacity` (0 leaves it out).
pub(crate) fn paint(
    geometry: &CaretGeometry,
    color: Hsla,
    label: &gpui::ShapedLine,
    label_opacity: f32,
    window: &mut Window,
    cx: &mut App,
) {
    window.paint_quad(fill(geometry.bar, color));
    window.paint_quad(fill(geometry.dot, color).corner_radii(DOT / 2.));
    if label_opacity <= 0. {
        return;
    }
    let radii = if geometry.label_below {
        Corners {
            top_left: px(0.),
            top_right: LABEL_RADIUS,
            bottom_right: LABEL_RADIUS,
            bottom_left: LABEL_RADIUS,
        }
    } else {
        Corners {
            top_left: LABEL_RADIUS,
            top_right: LABEL_RADIUS,
            bottom_right: LABEL_RADIUS,
            bottom_left: px(0.),
        }
    };
    window.paint_quad(fill(geometry.label, color.opacity(label_opacity)).corner_radii(radii));
    let origin = point(
        geometry.label.origin.x + LABEL_PADDING_X,
        geometry.label.origin.y + LABEL_PADDING_Y,
    );
    label
        .paint(
            origin,
            LABEL_SIZE * LABEL_LEADING,
            gpui::TextAlign::Left,
            None,
            window,
            cx,
        )
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tag_holds_then_fades_out_by_the_end_of_its_moment() {
        assert_eq!(label_opacity(Duration::ZERO), 1.);
        assert_eq!(label_opacity(Duration::from_millis(2000)), 1.);
        let fading = label_opacity(Duration::from_millis(2200));
        assert!(fading > 0. && fading < 1., "{fading}");
        // Ease-in: most of the fade happens late.
        assert!(fading > 0.5, "{fading}");
        assert_eq!(label_opacity(LABEL_MOMENT), 0.);
        assert_eq!(label_opacity(Duration::from_secs(10)), 0.);
    }

    #[test]
    fn a_caret_near_the_top_edge_puts_its_tag_below() {
        let line = px(22.4);
        let top = caret_geometry(px(80.), px(0.), line, px(60.), px(0.));
        assert!(top.label_below);
        assert!(top.label.top() > top.bar.bottom());
        let lower = caret_geometry(px(80.), px(100.), line, px(60.), px(0.));
        assert!(!lower.label_below);
        assert!(lower.label.bottom() <= lower.bar.top() + px(1.));
        // The tag starts at the caret; the bar and dot centre on it.
        assert_eq!(lower.label.left(), px(80.));
        assert_eq!(lower.bar.center().x, px(80.));
        assert_eq!(lower.dot.center().x, px(80.));
        assert_eq!(lower.dot.center().y, lower.bar.top());
    }

    #[test]
    fn colours_come_from_the_provider_or_the_hue() {
        let exact = presence_color(Some("#0b6e4f"), 200.);
        assert_eq!(exact, gpui::rgb(0x0b6e4f).into());
        let hue = presence_color(Some("not a colour"), 120.);
        assert_eq!(hue, hue_color(120.));
        assert!((hue_color(480.).h - hue_color(120.).h).abs() < 1e-6);
    }
}
