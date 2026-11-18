// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Element constructors. Port of Excalidraw `packages/element/src/newElement.ts`
//! @ 3a317b5. `ElementOpts` is `ElementConstructorOpts`: fields upstream
//! leaves optional and treats `undefined` specially are `Option`s.
//! `refreshTextDimensions` / `getAdjustedDimensions` need text wrapping and
//! arrow label positions and move with them to the text module.

use super::consts::*;
use super::math::Point;
use super::mutate::{get_updated_timestamp, new_element_with};
use super::random::{random_id, random_integer};
use super::sticky::{normalize_sticky_note_background_color, normalize_sticky_note_stroke_color};
use super::text_measure::{Font, Measure, get_line_height, measure_text, normalize_text};
use super::types::*;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct ElementOpts {
    /// None: a fresh `randomId()`.
    pub id: Option<String>,
    pub x: f64,
    pub y: f64,
    pub stroke_color: String,
    pub background_color: String,
    pub fill_style: FillStyle,
    pub stroke_width: f64,
    pub stroke_style: StrokeStyle,
    pub roundness: Option<Roundness>,
    pub roughness: f64,
    pub opacity: f64,
    pub width: f64,
    pub height: f64,
    pub angle: f64,
    pub group_ids: Vec<String>,
    pub frame_id: Option<String>,
    pub index: Option<String>,
    pub bound_elements: Option<Vec<BoundElement>>,
    /// None: `randomInteger()`.
    pub seed: Option<i64>,
    /// None (or 0): 1.
    pub version: Option<i64>,
    /// None: 0.
    pub version_nonce: Option<i64>,
    /// None: now. `Some(None)` keeps an explicit null when reconstructing a
    /// legacy element.
    pub created: Option<Option<i64>>,
    pub link: Option<String>,
    pub locked: bool,
    pub custom_data: Option<Value>,
}

impl Default for ElementOpts {
    /// `DEFAULT_ELEMENT_PROPS`.
    fn default() -> Self {
        ElementOpts {
            id: None,
            x: 0.,
            y: 0.,
            stroke_color: DEFAULT_STROKE_COLOR.into(),
            background_color: DEFAULT_BACKGROUND_COLOR.into(),
            fill_style: FillStyle::Solid,
            stroke_width: DEFAULT_STROKE_WIDTH,
            stroke_style: StrokeStyle::Solid,
            roundness: None,
            roughness: DEFAULT_ROUGHNESS,
            opacity: DEFAULT_OPACITY,
            width: 0.,
            height: 0.,
            angle: 0.,
            group_ids: vec![],
            frame_id: None,
            index: None,
            bound_elements: None,
            seed: None,
            version: None,
            version_nonce: None,
            created: None,
            link: None,
            locked: false,
            custom_data: None,
        }
    }
}

impl ElementOpts {
    pub fn at(x: f64, y: f64) -> Self {
        ElementOpts {
            x,
            y,
            ..Default::default()
        }
    }
    /// The constructor options that rebuild `e` with its identity and style
    /// (upstream: spreading an element into a constructor).
    pub fn from_element(e: &Element) -> Self {
        ElementOpts {
            id: Some(e.id.clone()),
            x: e.x,
            y: e.y,
            stroke_color: e.stroke_color.clone(),
            background_color: e.background_color.clone(),
            fill_style: e.fill_style,
            stroke_width: e.stroke_width,
            stroke_style: e.stroke_style,
            roundness: e.roundness,
            roughness: e.roughness,
            opacity: e.opacity,
            width: e.width,
            height: e.height,
            angle: e.angle,
            group_ids: e.group_ids.clone(),
            frame_id: e.frame_id.clone(),
            index: e.index.clone(),
            bound_elements: e.bound_elements.clone(),
            seed: Some(e.seed),
            version: Some(e.version),
            version_nonce: Some(e.version_nonce),
            created: Some(e.created),
            link: e.link.clone(),
            locked: e.locked,
            custom_data: e.custom_data.clone(),
        }
    }
}

/// `_newElementBase`.
fn new_element_base(kind: Kind, o: ElementOpts) -> Element {
    let timestamp = get_updated_timestamp();
    Element {
        id: o.id.filter(|s| !s.is_empty()).unwrap_or_else(random_id),
        x: o.x,
        y: o.y,
        stroke_color: o.stroke_color,
        background_color: o.background_color,
        fill_style: o.fill_style,
        stroke_width: o.stroke_width,
        stroke_style: o.stroke_style,
        roundness: o.roundness,
        roughness: o.roughness,
        opacity: o.opacity,
        width: o.width,
        height: o.height,
        angle: o.angle,
        seed: o.seed.unwrap_or_else(random_integer),
        version: o.version.filter(|&v| v != 0).unwrap_or(1),
        version_nonce: o.version_nonce.unwrap_or(0),
        index: o.index,
        is_deleted: false,
        group_ids: o.group_ids,
        frame_id: o.frame_id,
        bound_elements: o.bound_elements,
        updated: timestamp,
        created: o.created.unwrap_or(Some(timestamp)),
        link: o.link,
        locked: o.locked,
        custom_data: o.custom_data,
        kind,
        extra: Default::default(),
    }
}

/// `newElement`: rectangle, diamond, ellipse (and selection).
pub fn new_element(ty: ElementType, o: ElementOpts) -> Element {
    let kind = match ty {
        ElementType::Selection => Kind::Selection,
        ElementType::Diamond => Kind::Diamond,
        ElementType::Ellipse => Kind::Ellipse,
        _ => Kind::Rectangle,
    };
    new_element_base(kind, o)
}

/// `normalizeStickyNoteStyle`: never-transparent colors, solid fill.
pub fn normalize_sticky_note_style(e: &Element) -> Element {
    new_element_with(
        e,
        |e| {
            e.background_color = normalize_sticky_note_background_color(Some(&e.background_color));
            e.stroke_color = normalize_sticky_note_stroke_color(Some(&e.stroke_color));
            e.fill_style = FillStyle::Solid;
        },
        false,
    )
}

/// `normalizeStickyNoteGeometry`: minimum size and `baseHeight ≤ height`, for
/// a finalized note (a draft starts at 0×0 like any other tool).
pub fn normalize_sticky_note_geometry(e: &Element) -> Element {
    let Kind::StickyNote { base_height } = e.kind else {
        return e.clone();
    };
    let width = e.width.max(STICKY_NOTE_MIN_SIZE);
    let or = |a: f64, b: f64| if a != 0. && !a.is_nan() { a } else { b };
    let base = or(or(base_height, e.height), DEFAULT_STICKY_NOTE_SIZE).max(STICKY_NOTE_MIN_SIZE);
    new_element_with(
        e,
        |e| {
            e.width = width;
            e.height = e.height.max(base);
            e.kind = Kind::StickyNote { base_height: base };
        },
        false,
    )
}

/// `normalizeStickyNote`: style and finalized geometry.
pub fn normalize_sticky_note(e: &Element) -> Element {
    normalize_sticky_note_geometry(&normalize_sticky_note_style(e))
}

/// `newStickyNoteElement`. No size inflation here (see
/// `normalize_sticky_note_geometry`).
pub fn new_sticky_note_element(o: ElementOpts, base_height: Option<f64>) -> Element {
    let base_height = base_height.unwrap_or(o.height);
    normalize_sticky_note_style(&new_element_base(Kind::StickyNote { base_height }, o))
}

pub fn new_embeddable_element(o: ElementOpts) -> Element {
    new_element_base(Kind::Embeddable, o)
}
pub fn new_iframe_element(o: ElementOpts) -> Element {
    new_element_base(Kind::Iframe, o)
}

/// `newFrameElement`. An empty name is no name.
pub fn new_frame_element(o: ElementOpts, name: Option<String>) -> Element {
    new_element_base(
        Kind::Frame {
            name: name.filter(|n| !n.is_empty()),
        },
        o,
    )
}
pub fn new_magic_frame_element(o: ElementOpts, name: Option<String>) -> Element {
    new_element_base(
        Kind::MagicFrame {
            name: name.filter(|n| !n.is_empty()),
        },
        o,
    )
}

/// `getTextAnchorRatios`: the point of the text box its alignment pins, as
/// ratios of width/height; it stays put as the text grows.
pub fn get_text_anchor_ratios(align: TextAlign, valign: VerticalAlign) -> (f64, f64) {
    let x = match align {
        TextAlign::Center => 0.5,
        TextAlign::Right => 1.,
        TextAlign::Left => 0.,
    };
    let y = match valign {
        VerticalAlign::Middle => 0.5,
        VerticalAlign::Bottom => 1.,
        VerticalAlign::Top => 0.,
    };
    (x, y)
}

/// `getTextElementPositionOffsets`.
pub fn get_text_element_position_offsets(
    align: TextAlign,
    valign: VerticalAlign,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let (rx, ry) = get_text_anchor_ratios(align, valign);
    (width * rx, height * ry)
}

/// `newTextElement` options beyond `ElementOpts`.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct TextOpts {
    pub text: String,
    pub original_text: Option<String>,
    /// None or 0: `DEFAULT_FONT_SIZE`.
    pub font_size: Option<f64>,
    /// None or 0: `DEFAULT_FONT_FAMILY`.
    pub font_family: Option<u32>,
    pub text_align: Option<TextAlign>,
    pub vertical_align: Option<VerticalAlign>,
    pub container_id: Option<String>,
    /// None or 0: the family's line height.
    pub line_height: Option<f64>,
    pub auto_resize: Option<bool>,
    pub label_position: Option<f64>,
    pub base_font_size: Option<f64>,
}

/// `newTextElement`: measured, and positioned so `x`/`y` is the alignment
/// anchor.
pub fn new_text_element(t: TextOpts, o: ElementOpts, m: &dyn Measure) -> Element {
    let font_family = t
        .font_family
        .filter(|&f| f != 0)
        .unwrap_or(DEFAULT_FONT_FAMILY);
    let font_size = t
        .font_size
        .filter(|&s| s != 0. && !s.is_nan())
        .unwrap_or(DEFAULT_FONT_SIZE);
    let line_height = t
        .line_height
        .filter(|&l| l != 0. && !l.is_nan())
        .unwrap_or_else(|| get_line_height(font_family));
    let text = normalize_text(&t.text);
    let metrics = measure_text(m, &text, Font::new(font_size, font_family), line_height);
    let text_align = t.text_align.unwrap_or(TextAlign::Left);
    let vertical_align = t.vertical_align.unwrap_or(VerticalAlign::Top);
    let (ox, oy) = get_text_element_position_offsets(
        text_align,
        vertical_align,
        metrics.width,
        metrics.height,
    );
    let (x, y) = (o.x - ox, o.y - oy);
    let data = TextData {
        font_size,
        font_family,
        base_font_size: t.base_font_size,
        original_text: t.original_text.unwrap_or_else(|| text.clone()),
        text,
        text_align,
        vertical_align,
        container_id: t.container_id.filter(|c| !c.is_empty()),
        auto_resize: t.auto_resize.unwrap_or(true),
        line_height,
        label_position: Some(t.label_position),
    };
    let mut e = new_element_base(Kind::Text(data), o);
    (e.x, e.y, e.width, e.height) = (x, y, metrics.width, metrics.height);
    e
}

/// `adjustXYWithRotation`: moves `x`/`y` so the sides not in `sides` stay put
/// under rotation, given how much each edge moved.
pub fn adjust_xy_with_rotation(
    sides: [bool; 4],
    mut x: f64,
    mut y: f64,
    angle: f64,
    dx1: f64,
    dy1: f64,
    dx2: f64,
    dy2: f64,
) -> (f64, f64) {
    let [n, e, s, w] = sides;
    let (cos, sin) = (angle.cos(), angle.sin());
    if e && w {
        x += dx1 + dx2;
    } else if e {
        x += dx1 * (1. + cos);
        y += dx1 * sin;
        x += dx2 * (1. - cos);
        y += dx2 * -sin;
    } else if w {
        x += dx1 * (1. - cos);
        y += dx1 * -sin;
        x += dx2 * (1. + cos);
        y += dx2 * sin;
    }
    if n && s {
        y += dy1 + dy2;
    } else if n {
        x += dy1 * sin;
        y += dy1 * (1. - cos);
        x += dy2 * -sin;
        y += dy2 * (1. + cos);
    } else if s {
        x += dy1 * -sin;
        y += dy1 * (1. + cos);
        x += dy2 * sin;
        y += dy2 * (1. - cos);
    }
    (x, y)
}

/// `newFreeDrawElement`.
pub fn new_free_draw_element(
    o: ElementOpts,
    points: Vec<Point>,
    pressures: Vec<f64>,
    simulate_pressure: bool,
    stroke_options: Option<StrokeOptions>,
) -> Element {
    let stroke_options = stroke_options.unwrap_or(StrokeOptions {
        variability: StrokeVariability::Variable,
        streamline: DEFAULT_STROKE_STREAMLINE,
    });
    new_element_base(
        Kind::FreeDraw(FreeDrawData {
            points,
            pressures,
            simulate_pressure,
            stroke_options,
        }),
        o,
    )
}

fn linear(
    points: Vec<Point>,
    start_arrowhead: Option<Arrowhead>,
    end_arrowhead: Option<Arrowhead>,
) -> LinearData {
    LinearData {
        points,
        start_binding: None,
        end_binding: None,
        start_arrowhead,
        end_arrowhead,
    }
}

/// `newLinearElement` for `line` (`polygon` defaults to false). Upstream also
/// builds bare `arrow`s here; use `new_arrow_element`.
pub fn new_linear_element(o: ElementOpts, points: Vec<Point>, polygon: Option<bool>) -> Element {
    new_element_base(
        Kind::Line {
            linear: linear(points, None, None),
            polygon: polygon.unwrap_or(false),
        },
        o,
    )
}

/// `newArrowElement`. `fixed_segments` only applies to elbow arrows.
pub fn new_arrow_element(
    o: ElementOpts,
    points: Vec<Point>,
    start_arrowhead: Option<Arrowhead>,
    end_arrowhead: Option<Arrowhead>,
    elbowed: bool,
    fixed_segments: Option<Vec<FixedSegment>>,
) -> Element {
    let elbow = elbowed.then(|| ElbowData {
        fixed_segments: Some(fixed_segments.unwrap_or_default()),
        start_is_special: Some(false),
        end_is_special: Some(false),
    });
    new_element_base(
        Kind::Arrow {
            linear: linear(points, start_arrowhead, end_arrowhead),
            elbow,
        },
        o,
    )
}

/// `newImageElement`. The stroke is `transparent` ("use the image's colors").
pub fn new_image_element(
    o: ElementOpts,
    status: Option<ImageStatus>,
    file_id: Option<String>,
    scale: Option<[f64; 2]>,
    crop: Option<ImageCrop>,
) -> Element {
    let mut e = new_element_base(
        Kind::Image(ImageData {
            file_id,
            status: status.unwrap_or(ImageStatus::Pending),
            scale: scale.unwrap_or([1., 1.]),
            crop,
        }),
        o,
    );
    e.stroke_color = "transparent".into();
    e
}
