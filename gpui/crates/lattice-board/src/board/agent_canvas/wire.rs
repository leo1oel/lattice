//! The wire format of the Agent's canvas tools: the tldraw-era shape ids,
//! types, named colours and fills Synara declares, read into Excalidraw terms
//! and an element projected back out. Every check and message is the Tauri
//! board adapter's (`src/agent/agent-canvas-excalidraw-adapter.ts`).

use serde_json::{Map, Value, json};

use super::ToolError;
use crate::board::json::js_number;
use crate::board::math::Point;
use crate::board::types::{Element, FillStyle};

pub(super) type Input = Map<String, Value>;

pub(super) const MAX_POINTS: usize = 2_000;
pub(super) const INK: &str = "#1e1e1e";
pub(super) const NOTE: &str = "#ffec99";
pub(super) const POINTS_ERROR: &str = "points must hold between 2 and 2000 [x, y] pairs.";

/// Named colour → (stroke, tint, highlight), as the .tldr converter maps them
/// (lattice-core `board/tldr/style.rs`).
const COLORS: [(&str, [&str; 3]); 13] = [
    ("black", ["#1e1e1e", "#e9ecef", "#ced4da"]),
    ("grey", ["#868e96", "#e9ecef", "#ced4da"]),
    ("light-violet", ["#9c36b5", "#eebefa", "#e599f7"]),
    ("violet", ["#6741d9", "#d0bfff", "#9775fa"]),
    ("blue", ["#1971c2", "#a5d8ff", "#4dabf7"]),
    ("light-blue", ["#0c8599", "#99e9f2", "#3bc9db"]),
    ("yellow", ["#f08c00", "#ffec99", "#ffd43b"]),
    ("orange", ["#e8590c", "#ffd8a8", "#ffa94d"]),
    ("green", ["#2f9e44", "#b2f2bb", "#69db7c"]),
    ("light-green", ["#099268", "#96f2d7", "#38d9a9"]),
    ("light-red", ["#c2255c", "#fcc2d7", "#f783ac"]),
    ("red", ["#e03131", "#ffc9c9", "#ff8787"]),
    ("white", ["#ffffff", "#ffffff", "#ffffff"]),
];

pub(super) fn named(color: &str) -> Option<[&'static str; 3]> {
    COLORS.iter().find(|(n, _)| *n == color).map(|(_, c)| *c)
}

/// Wire type → the shape it makes, aliases included.
pub(super) fn shape_type(wire: &str) -> Option<&'static str> {
    Some(match wire {
        "rectangle" | "geo" | "triangle" | "trapezoid" | "hexagon" => "rectangle",
        "ellipse" | "oval" => "ellipse",
        "diamond" | "rhombus" => "diamond",
        "text" => "text",
        "note" | "sticky" => "note",
        "arrow" => "arrow",
        "line" => "line",
        "draw" | "freedraw" => "draw",
        "highlight" => "highlight",
        "frame" => "frame",
        _ => return None,
    })
}

pub(super) fn is_linear(ty: &str) -> bool {
    matches!(ty, "arrow" | "line" | "draw" | "highlight")
}

fn takes_text(ty: &str) -> bool {
    matches!(
        ty,
        "rectangle" | "ellipse" | "diamond" | "note" | "arrow" | "text" | "frame"
    )
}

/// JavaScript's string length (UTF-16 code units), which the limits count.
pub(super) fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// A number the way `JSON.stringify` writes it: whole numbers without `.0`.
pub(super) fn num(v: f64) -> Value {
    if v.fract() == 0. && v.abs() < 9_007_199_254_740_992. {
        json!(v as i64)
    } else {
        json!(v)
    }
}

fn finite_number(input: &Input, key: &str) -> Result<Option<f64>, ToolError> {
    match input.get(key) {
        None => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(_) => Err(ToolError::failed(format!("{key} must be a finite number."))),
    }
}

pub(super) fn bounded_number(
    input: &Input,
    key: &str,
    min: f64,
    max: f64,
) -> Result<Option<f64>, ToolError> {
    let value = finite_number(input, key)?;
    if value.is_some_and(|v| v < min || v > max) {
        return Err(ToolError::failed(format!(
            "{key} must be between {} and {}.",
            js_number(min),
            js_number(max)
        )));
    }
    Ok(value)
}

/// The element id a wire id (`shape:<id>`) names.
pub(super) fn element_id(value: &Value) -> Result<String, ToolError> {
    value
        .as_str()
        .and_then(|s| s.strip_prefix("shape:"))
        .filter(|id| {
            (1..=128).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .map(str::to_string)
        .ok_or_else(|| {
            ToolError::failed("Shape ids must use the form shape:<letters, numbers, _ or ->.")
        })
}

pub(super) fn wire_id(id: &str) -> String {
    format!("shape:{id}")
}

/// What `customData.latticeShape` says the element is (a note, a highlight).
pub(super) fn lattice_shape(element: &Element) -> Option<&str> {
    element
        .custom_data
        .as_ref()
        .and_then(|d| d.get("latticeShape"))
        .and_then(Value::as_str)
}

/// The wire type of an element, images and embeds included for the listing.
pub(super) fn wire_type(element: &Element) -> String {
    if let Some(shape @ ("note" | "highlight")) = lattice_shape(element) {
        return shape.into();
    }
    match element.ty().as_str() {
        "freedraw" => "draw".into(),
        "embeddable" | "iframe" => "embed".into(),
        ty => ty.into(),
    }
}

/// A container's label: a text element of its own, which the tools never name.
pub(super) fn is_label(element: &Element) -> bool {
    element.is_text() && element.container_id().is_some()
}

fn fill_of(element: &Element) -> &'static str {
    if element.background_color == "transparent" {
        return "none";
    }
    match element.fill_style {
        FillStyle::Solid if element.background_color == "#ffffff" => "semi",
        FillStyle::Solid => "solid",
        _ => "pattern",
    }
}

/// The element as the tools show it; `label` is its bound text.
pub(super) fn project(element: &Element, label: Option<&Element>) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(wire_id(&element.id)));
    out.insert("type".into(), json!(wire_type(element)));
    for (key, v) in [
        ("x", element.x),
        ("y", element.y),
        ("width", element.width),
        ("height", element.height),
        ("rotation", element.angle),
        ("opacity", element.opacity / 100.),
    ] {
        out.insert(key.into(), num(v));
    }
    out.insert("isLocked".into(), json!(element.locked));
    out.insert("color".into(), json!(element.stroke_color));
    out.insert("backgroundColor".into(), json!(element.background_color));
    out.insert("fill".into(), json!(fill_of(element)));
    let text = match (element.text(), element.is_frame()) {
        (Some(t), _) => Some(t.text.as_str()),
        (None, true) => element.frame_name(),
        _ => label.and_then(|l| l.text()).map(|t| t.text.as_str()),
    };
    if let Some(text) = text {
        out.insert("text".into(), json!(text));
    }
    if let Some(points) = element.points() {
        let points: Vec<Value> = points
            .iter()
            .map(|[x, y]| json!([num(*x), num(*y)]))
            .collect();
        out.insert("points".into(), Value::Array(points));
    }
    if let Some(linear) = element.linear() {
        for (key, binding) in [
            ("startBinding", &linear.start_binding),
            ("endBinding", &linear.end_binding),
        ] {
            if let Some(b) = binding {
                out.insert(key.into(), json!(wire_id(&b.element_id)));
            }
        }
    }
    if let Some(frame) = &element.frame_id {
        out.insert("frameId".into(), json!(wire_id(frame)));
    }
    if !element.group_ids.is_empty() {
        out.insert("groupIds".into(), json!(element.group_ids));
    }
    if let Some(index) = &element.index {
        out.insert("index".into(), json!(index));
    }
    Value::Object(out)
}

/// Stroke, background and fill from `color` and `fill`.
#[derive(Default)]
pub(super) struct Paint {
    pub stroke: Option<String>,
    pub background: Option<String>,
    pub fill_style: Option<FillStyle>,
}

/// `color` and `fill` on a shape of wire type `ty`; `current` is the shape
/// being updated.
pub(super) fn paint(
    input: &Input,
    ty: &str,
    current: Option<&Element>,
) -> Result<Paint, ToolError> {
    let mut out = Paint::default();
    let mut tint = None;
    if let Some(color) = input.get("color") {
        let color = color.as_str();
        let name = color.and_then(named);
        let hex = color.filter(|c| {
            c.strip_prefix('#').is_some_and(|h| {
                (h.len() == 3 || h.len() == 6) && h.bytes().all(|b| b.is_ascii_hexdigit())
            })
        });
        let t = match (name, hex) {
            (Some(n), _) => {
                if ty == "highlight" {
                    n[2]
                } else {
                    n[1]
                }
            }
            (None, Some(h)) => h,
            _ => return Err(ToolError::failed("Unsupported canvas color.")),
        };
        tint = Some(t.to_string());
        if ty == "note" {
            out.background = tint.clone();
        } else if ty == "highlight" {
            out.stroke = tint.clone();
        } else {
            out.stroke = Some(name.map_or(t, |n| n[0]).to_string());
        }
    }
    if let Some(fill) = input.get("fill") {
        let fill = fill
            .as_str()
            .filter(|f| matches!(*f, "none" | "semi" | "solid" | "pattern"))
            .ok_or_else(|| ToolError::failed("Unsupported canvas fill."))?;
        let color = tint.unwrap_or_else(|| match current {
            Some(c) if c.background_color != "transparent" => c.background_color.clone(),
            _ => "#e9ecef".into(),
        });
        out.background = Some(match fill {
            "none" => "transparent".into(),
            "semi" => "#ffffff".into(),
            _ => color,
        });
        out.fill_style = Some(if fill == "pattern" {
            FillStyle::Hachure
        } else {
            FillStyle::Solid
        });
    }
    Ok(out)
}

pub(super) fn text_of(input: &Input, ty: &str) -> Result<Option<String>, ToolError> {
    let Some(text) = input.get("text") else {
        return Ok(None);
    };
    let text = text
        .as_str()
        .ok_or_else(|| ToolError::failed("text must be a string."))?;
    if js_len(text) > 50_000 {
        return Err(ToolError::failed("Canvas shape text is too long."));
    }
    if !takes_text(ty) {
        return Err(ToolError::failed(format!(
            "The {ty} shape type does not accept text."
        )));
    }
    Ok(Some(text.into()))
}

pub(super) fn points_of(input: &Input) -> Result<Option<Vec<Point>>, ToolError> {
    let Some(points) = input.get("points") else {
        return Ok(None);
    };
    let pair = |p: &Value| match p.as_array().map(Vec::as_slice) {
        Some([x, y]) => Some([x.as_f64()?, y.as_f64()?]),
        _ => None,
    };
    points
        .as_array()
        .filter(|p| (2..=MAX_POINTS).contains(&p.len()))
        .and_then(|p| p.iter().map(pair).collect::<Option<Vec<Point>>>())
        .map(Some)
        .ok_or_else(|| ToolError::failed(POINTS_ERROR))
}

/// Points scaled so their extent is `width` × `height` where those are given.
pub(super) fn fit_points(points: &[Point], width: Option<f64>, height: Option<f64>) -> Vec<Point> {
    let [ex, ey] = extent(points);
    let sx = width.filter(|_| ex > 0.).map_or(1., |w| w / ex);
    let sy = height.filter(|_| ey > 0.).map_or(1., |h| h / ey);
    points.iter().map(|[x, y]| [x * sx, y * sy]).collect()
}

pub(super) fn extent(points: &[Point]) -> [f64; 2] {
    let span = |axis: usize| {
        let (lo, hi) = points.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| {
            (lo.min(p[axis]), hi.max(p[axis]))
        });
        if points.is_empty() { 0. } else { hi - lo }
    };
    [span(0), span(1)]
}

/// Place, size, rotation, opacity and lock, in Excalidraw's terms.
#[derive(Default)]
pub(super) struct Placement {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub angle: Option<f64>,
    pub opacity: Option<f64>,
    pub locked: Option<bool>,
}

pub(super) fn placement(input: &Input) -> Result<Placement, ToolError> {
    if input.contains_key("props") {
        return Err(ToolError::failed("Raw canvas props are not supported."));
    }
    let tau = std::f64::consts::TAU;
    let mut out = Placement {
        x: bounded_number(input, "x", -10_000_000., 10_000_000.)?,
        y: bounded_number(input, "y", -10_000_000., 10_000_000.)?,
        width: bounded_number(input, "width", 1., 1_000_000.)?,
        height: bounded_number(input, "height", 1., 1_000_000.)?,
        angle: bounded_number(input, "rotation", -tau, tau)?,
        opacity: bounded_number(input, "opacity", 0., 1.)?.map(|o| (o * 100.).round()),
        locked: None,
    };
    out.locked = match input.get("isLocked") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(ToolError::failed("isLocked must be a boolean.")),
    };
    Ok(out)
}
