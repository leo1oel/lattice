//! tldraw's style props mapped onto Excalidraw's. Colours go to the nearest
//! entries of Excalidraw's own palette (`COLOR_PALETTE`), so a converted
//! board offers the same swatches its elements already use.

use crate::board::scene::font_family;
use serde_json::Value;

/// One tldraw colour: its stroke, the light tint tldraw fills `solid` and
/// `pattern` shapes and sticky notes with, the strong colour of the `fill`
/// style, and the highlighter's colour.
struct Swatch {
    stroke: &'static str,
    tint: &'static str,
    strong: &'static str,
    highlight: &'static str,
}

fn swatch(color: &str) -> Swatch {
    let (stroke, tint, strong, highlight) = match color {
        "grey" => ("#868e96", "#e9ecef", "#ced4da", "#ced4da"),
        "light-violet" => ("#9c36b5", "#eebefa", "#be4bdb", "#e599f7"),
        "violet" => ("#6741d9", "#d0bfff", "#7950f2", "#9775fa"),
        "blue" => ("#1971c2", "#a5d8ff", "#228be6", "#4dabf7"),
        "light-blue" => ("#0c8599", "#99e9f2", "#15aabf", "#3bc9db"),
        "yellow" => ("#f08c00", "#ffec99", "#fab005", "#ffd43b"),
        "orange" => ("#e8590c", "#ffd8a8", "#fd7e14", "#ffa94d"),
        "green" => ("#2f9e44", "#b2f2bb", "#40c057", "#69db7c"),
        "light-green" => ("#099268", "#96f2d7", "#12b886", "#38d9a9"),
        "light-red" => ("#c2255c", "#fcc2d7", "#e64980", "#f783ac"),
        "red" => ("#e03131", "#ffc9c9", "#fa5252", "#ff8787"),
        "white" => ("#ffffff", "#ffffff", "#ffffff", "#ffffff"),
        _ => ("#1e1e1e", "#e9ecef", "#343a40", "#ced4da"),
    };
    Swatch { stroke, tint, strong, highlight }
}

pub(super) fn stroke_color(color: &str) -> String {
    swatch(color).stroke.to_string()
}

pub(super) fn tint(color: &str) -> String {
    swatch(color).tint.to_string()
}

pub(super) fn highlight_color(color: &str) -> String {
    swatch(color).highlight.to_string()
}

/// `backgroundColor` and `fillStyle` for a tldraw `fill` on `color`. tldraw's
/// `semi` fills with the canvas colour, which is white on a light board.
pub(super) fn fill(fill: &str, color: &str) -> (String, &'static str) {
    let swatch = swatch(color);
    match fill {
        "semi" => ("#ffffff".to_string(), "solid"),
        "solid" => (swatch.tint.to_string(), "solid"),
        "pattern" => (swatch.tint.to_string(), "hachure"),
        "lined-fill" => (swatch.tint.to_string(), "cross-hatch"),
        "fill" => (swatch.strong.to_string(), "solid"),
        _ => ("transparent".to_string(), "solid"),
    }
}

/// tldraw's hand-drawn `draw` dash becomes a plain solid line: converted
/// boards take the app's clean look, like new elements do.
pub(super) fn stroke_style(dash: &str) -> &'static str {
    match dash {
        "dashed" => "dashed",
        "dotted" => "dotted",
        _ => "solid",
    }
}

pub(super) fn stroke_width(size: &str) -> f64 {
    match size {
        "s" => 1.,
        "m" => 2.,
        _ => 4.,
    }
}

/// Excalidraw's S/M/L/XL font sizes for tldraw's, times the shape's scale.
pub(super) fn font_size(size: &str, scale: f64) -> f64 {
    let base = match size {
        "s" => 16.,
        "l" => 28.,
        "xl" => 36.,
        _ => 20.,
    };
    base * scale
}

pub(super) fn font(font: &str) -> u32 {
    match font {
        "draw" => font_family::EXCALIFONT,
        "mono" => font_family::CASCADIA,
        _ => font_family::NUNITO,
    }
}

pub(super) fn text_align(align: &str) -> &'static str {
    if align.starts_with("start") {
        "left"
    } else if align.starts_with("end") {
        "right"
    } else {
        "center"
    }
}

pub(super) fn vertical_align(align: &str) -> &'static str {
    match align {
        "start" => "top",
        "end" => "bottom",
        _ => "middle",
    }
}

/// Excalidraw has no square, pipe or inverted heads; each takes the closest.
pub(super) fn arrowhead(head: &str) -> Option<&'static str> {
    Some(match head {
        "none" | "" => return None,
        "triangle" | "square" => "triangle",
        "dot" => "circle",
        "diamond" => "diamond",
        "bar" | "pipe" => "bar",
        _ => "arrow",
    })
}

/// The element type a tldraw `geo` becomes: Excalidraw draws rectangles,
/// ellipses and diamonds, and every other geo takes the nearest of them.
pub(super) fn geo_type(geo: &str) -> &'static str {
    match geo {
        "ellipse" | "oval" | "cloud" => "ellipse",
        "diamond" | "rhombus" | "rhombus-2" => "diamond",
        _ => "rectangle",
    }
}

/// A string prop, or `fallback` when it is missing.
pub(super) fn text_prop<'a>(props: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    props.get(key).and_then(Value::as_str).unwrap_or(fallback)
}

/// A number prop, or `fallback` when it is missing or not finite.
pub(super) fn number_prop(props: &Value, key: &str, fallback: f64) -> f64 {
    props.get(key).and_then(Value::as_f64).filter(|value| value.is_finite()).unwrap_or(fallback)
}
