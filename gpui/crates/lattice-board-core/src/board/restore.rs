// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Reading untrusted scene JSON. Port of Excalidraw
//! `packages/excalidraw/data/restore.ts` @ 3a317b5 (`restoreElements`,
//! `restoreElement`, the binding / container / frame / sticky note repairs,
//! `bumpElementVersions`, and `restoreAppState` for the fields that travel
//! with a file), and of the loading half of `data/json.ts` / `data/blob.ts`.
//!
//! Upstream spreads the raw object and overrides the fields it normalizes;
//! here the modeled fields are read with the same defaults and the rest go to
//! `Element::extra`. Values our types can't hold fall back to the default the
//! upstream code uses for a missing value: a non-string color, an unknown
//! `fillStyle` / `strokeStyle` / alignment / arrowhead name, a non-numeric
//! size. Elements that aren't objects are dropped (upstream throws).
//!
//! v1 (focus / gap) arrow bindings are migrated once the elements they
//! point at are restored (`binding::repair_legacy_binding`).
//!
//! `refreshDimensions` re-wraps texts and refits sticky notes with the
//! measurer passed as `RestoreOpts::refresh_dimensions`.
//!
//! Unbound elbow arrows with invalid (not axis-aligned) points are routed
//! again end to end (`elbow::update_elbow_arrow_points`).

use super::consts::*;
use super::fractional_index::{sync_invalid_indices, sync_moved_indices};
use super::math::{Point, clamp, js_round, points_equal};
use super::mutate::{bump_version, get_updated_timestamp};
use super::new_element::normalize_sticky_note;
use super::random::random_id;
use super::scene::normalize_bound_elements_order;
use super::sticky::*;
use super::text_measure::{detect_line_height, font_family_by_name, get_line_height};
use super::types::*;
use super::utils::*;
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Migrates a v1 binding (no `mode`) of `arrow`'s `end` to `bound`: decide
/// inside / orbit and compute the fixed point (upstream: `repairBinding`'s
/// legacy branch). `arrow` has its points restored and its v1 bindings in
/// place (orbit, fixed points normalized); the others as restored.
pub type LegacyBindingRepair = fn(
    arrow: &Element,
    end: StartOrEnd,
    bound: &Element,
    elements: &dyn ElementsMap,
) -> Option<FixedPointBinding>;

#[derive(Clone, Copy, Default)]
pub struct RestoreOpts {
    pub repair_bindings: bool,
    pub delete_invisible_elements: bool,
    /// None: `binding::repair_legacy_binding`.
    pub legacy_binding: Option<LegacyBindingRepair>,
    /// `refreshDimensions` (with `repair_bindings`), measuring with this.
    pub refresh_dimensions: Option<&'static dyn super::text_measure::Measure>,
}

impl RestoreOpts {
    /// What loading a file does upstream (`loadFromBlob`, initial data).
    pub fn load() -> RestoreOpts {
        RestoreOpts {
            repair_bindings: true,
            delete_invisible_elements: true,
            legacy_binding: None,
            refresh_dimensions: None,
        }
    }
}

// ---------------------------------------------------------------------------
// reading raw values with JS semantics
// ---------------------------------------------------------------------------

fn get<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a Value> {
    o.get(k).filter(|v| !v.is_null())
}
/// A number (`isFiniteNumber` not implied).
fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}
fn finite(v: Option<&Value>) -> Option<f64> {
    number(v).filter(|n| n.is_finite())
}
/// `v || d` for a number.
fn num_or(v: Option<&Value>, d: f64) -> f64 {
    number(v).filter(|n| *n != 0. && !n.is_nan()).unwrap_or(d)
}
/// `v ?? d` for a number.
fn num_nullish(v: Option<&Value>, d: f64) -> f64 {
    number(v).unwrap_or(d)
}
fn int(v: f64) -> i64 {
    if v.is_finite() { v as i64 } else { 0 }
}
/// `v || d` for a string.
fn str_or<'a>(v: Option<&'a Value>, d: &'a str) -> &'a str {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(d)
}
fn string(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}
/// JS truthiness.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0. && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
/// `v ?? d` for a boolean.
fn bool_nullish(v: Option<&Value>, d: bool) -> bool {
    if v.is_some() { truthy(v) } else { d }
}
fn pair(v: Option<&Value>) -> Option<[f64; 2]> {
    let a = v?.as_array()?;
    if a.len() != 2 {
        return None;
    }
    Some([a[0].as_f64()?, a[1].as_f64()?])
}
/// `isValidPoint`.
fn valid_point(v: &Value) -> Option<Point> {
    pair(Some(v)).filter(|p| p[0].is_finite() && p[1].is_finite())
}

/// `parseFloat`: the longest numeric prefix.
fn js_parse_float(s: &str) -> f64 {
    let s = s.trim_start();
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    if s[i..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let start_digits = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    if i == start_digits || &s[start_digits..i] == "." {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let d = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > d {
            i = j;
        }
    }
    s[..i].parse().unwrap_or(f64::NAN)
}

// ---------------------------------------------------------------------------
// restoreElement
// ---------------------------------------------------------------------------

const BASE_KEYS: &[&str] = &[
    "id",
    "type",
    "x",
    "y",
    "strokeColor",
    "backgroundColor",
    "fillStyle",
    "strokeWidth",
    "strokeStyle",
    "roundness",
    "roughness",
    "opacity",
    "width",
    "height",
    "angle",
    "seed",
    "version",
    "versionNonce",
    "index",
    "isDeleted",
    "groupIds",
    "frameId",
    "boundElements",
    "updated",
    "created",
    "link",
    "locked",
    "customData",
];

/// Keys a type models besides the base ones.
fn type_keys(ty: ElementType, elbow: bool) -> &'static [&'static str] {
    match ty {
        ElementType::StickyNote => &["baseHeight"],
        ElementType::Image => &["fileId", "status", "scale", "crop"],
        ElementType::Frame | ElementType::MagicFrame => &["name"],
        ElementType::Text => &[
            "fontSize",
            "fontFamily",
            "baseFontSize",
            "text",
            "textAlign",
            "verticalAlign",
            "containerId",
            "originalText",
            "autoResize",
            "lineHeight",
            "labelPosition",
        ],
        ElementType::Line => &[
            "points",
            "startBinding",
            "endBinding",
            "startArrowhead",
            "endArrowhead",
            "polygon",
        ],
        ElementType::Arrow if elbow => &[
            "points",
            "startBinding",
            "endBinding",
            "startArrowhead",
            "endArrowhead",
            "elbowed",
            "fixedSegments",
            "startIsSpecial",
            "endIsSpecial",
        ],
        ElementType::Arrow => &[
            "points",
            "startBinding",
            "endBinding",
            "startArrowhead",
            "endArrowhead",
            "elbowed",
        ],
        ElementType::FreeDraw => &["points", "pressures", "simulatePressure", "strokeOptions"],
        _ => &[],
    }
}

/// Props upstream strips once migrated.
const STRIPPED_KEYS: &[&str] = &[
    "strokeSharpness",
    "boundElementIds",
    "moveMidPointsWithElement",
];

/// A v1 arrow binding waiting for `RestoreOpts::legacy_binding`.
struct PendingBinding {
    end: StartOrEnd,
    element_id: String,
    fixed_point: [f64; 2],
}

fn bound_elements(o: &Map<String, Value>) -> Option<Vec<BoundElement>> {
    if let Some(ids) = get(o, "boundElementIds").and_then(Value::as_array) {
        return Some(
            ids.iter()
                .filter_map(|id| id.as_str())
                .map(|id| BoundElement {
                    id: id.into(),
                    kind: BoundType::Arrow,
                })
                .collect(),
        );
    }
    let Some(list) = get(o, "boundElements") else {
        return Some(vec![]);
    };
    Some(
        list.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|b| {
                        let b = b.as_object()?;
                        Some(BoundElement {
                            id: b.get("id")?.as_str()?.into(),
                            kind: BoundType::parse(b.get("type")?.as_str()?)?,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

fn roundness_of(o: &Map<String, Value>, ty: ElementType) -> Option<Roundness> {
    if let Some(r) = get(o, "roundness") {
        if !truthy(Some(r)) {
            return None;
        }
        let r = r.as_object()?;
        let kind =
            number(r.get("type")).filter(|k| *k >= 0. && *k <= 255. && k.fract() == 0.)? as u8;
        return Some(Roundness {
            kind,
            value: number(r.get("value")),
        });
    }
    (get(o, "strokeSharpness").and_then(Value::as_str) == Some("round")).then(|| {
        // old elements that would now use the adaptive radius keep the legacy one
        Roundness {
            kind: if ty.uses_adaptive_radius() {
                roundness::LEGACY
            } else {
                roundness::PROPORTIONAL_RADIUS
            },
            value: None,
        }
    })
}

/// `restoreElementWithProperties`: the base fields with their defaults;
/// `x`/`y`/`width`/`height` already overridden where the type computes them.
fn restore_base(o: &Map<String, Value>, kind: Kind, xywh: Option<(f64, f64, f64, f64)>) -> Element {
    let ty = kind.element_type();
    let (x, y, w, h) = match xywh {
        Some(v) => v,
        None => get_normalized_dimensions(
            num_nullish(get(o, "x"), 0.),
            num_nullish(get(o, "y"), 0.),
            num_or(get(o, "width"), 0.),
            num_or(get(o, "height"), 0.),
        ),
    };
    let elbow = matches!(kind, Kind::Arrow { elbow: Some(_), .. });
    let modeled = |k: &str| {
        BASE_KEYS.contains(&k) || type_keys(ty, elbow).contains(&k) || STRIPPED_KEYS.contains(&k)
    };
    Element {
        id: str_or(o.get("id"), "").to_owned(),
        x,
        y,
        stroke_color: str_or(o.get("strokeColor"), DEFAULT_STROKE_COLOR).into(),
        background_color: str_or(o.get("backgroundColor"), DEFAULT_BACKGROUND_COLOR).into(),
        fill_style: FillStyle::parse(str_or(o.get("fillStyle"), "")).unwrap_or(FillStyle::Solid),
        stroke_width: num_or(get(o, "strokeWidth"), DEFAULT_STROKE_WIDTH),
        stroke_style: get(o, "strokeStyle")
            .and_then(Value::as_str)
            .and_then(StrokeStyle::parse)
            .unwrap_or(StrokeStyle::Solid),
        roundness: roundness_of(o, ty),
        roughness: num_nullish(get(o, "roughness"), DEFAULT_ROUGHNESS),
        opacity: num_nullish(get(o, "opacity"), DEFAULT_OPACITY),
        width: w,
        height: h,
        angle: num_or(get(o, "angle"), 0.),
        seed: int(num_nullish(get(o, "seed"), 1.)),
        // all elements need version > 0 so scene version hashing sees new ones
        version: int(num_or(get(o, "version"), 1.)),
        version_nonce: int(num_nullish(get(o, "versionNonce"), 0.)),
        index: string(get(o, "index")),
        is_deleted: bool_nullish(get(o, "isDeleted"), false),
        group_ids: get(o, "groupIds")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|g| g.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        frame_id: string(get(o, "frameId")),
        bound_elements: bound_elements(o),
        updated: number(get(o, "updated")).map_or_else(get_updated_timestamp, int),
        created: number(get(o, "created")).map(int),
        link: get(o, "link")
            .and_then(Value::as_str)
            .filter(|l| !l.is_empty())
            .map(normalize_link),
        locked: bool_nullish(get(o, "locked"), false),
        custom_data: o.get("customData").cloned(),
        kind,
        extra: o
            .iter()
            .filter(|(k, _)| !modeled(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    }
}

fn restore_linear_points(
    points: Option<&Value>,
    width: Option<&Value>,
    height: Option<&Value>,
) -> Vec<Point> {
    let restored: Vec<Point> = points
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(valid_point).collect())
        .unwrap_or_default();
    if restored.len() < 2 {
        vec![
            [0., 0.],
            [finite(width).unwrap_or(0.), finite(height).unwrap_or(0.)],
        ]
    } else {
        restored
    }
}

/// `LinearElementEditor.getNormalizeElementPointsAndCoords`: the first point
/// at the origin.
fn normalize_points(points: Vec<Point>, x: f64, y: f64) -> (Vec<Point>, f64, f64) {
    let [ox, oy] = points[0];
    (
        points.into_iter().map(|p| [p[0] - ox, p[1] - oy]).collect(),
        x + ox,
        y + oy,
    )
}

const MAX_LINEAR_PX: f64 = 75_000.;

/// Last resort for huge lines / arrows, which would freeze rendering.
fn handle_oversized_linear(mut e: Element) -> Element {
    if e.width <= MAX_LINEAR_PX && e.height <= MAX_LINEAR_PX {
        return e;
    }
    (e.x, e.y, e.width, e.height, e.is_deleted) = (0., 0., 100., 100., true);
    if let Some(p) = e.points_mut() {
        *p = vec![[0., 0.], [100., 100.]];
    }
    e
}

fn restore_stroke_options(v: Option<&Value>) -> StrokeOptions {
    let o = v.and_then(Value::as_object);
    StrokeOptions {
        variability: o
            .and_then(|o| o.get("variability"))
            .and_then(Value::as_str)
            .and_then(StrokeVariability::parse)
            .unwrap_or(StrokeVariability::Variable),
        streamline: finite(o.and_then(|o| o.get("streamline")))
            .unwrap_or(DEFAULT_STROKE_STREAMLINE),
    }
}

fn restore_crop(v: Option<&Value>) -> Option<ImageCrop> {
    let c = v?.as_object()?;
    let n = |k| c.get(k).and_then(Value::as_f64);
    Some(ImageCrop {
        x: n("x")?,
        y: n("y")?,
        width: n("width")?,
        height: n("height")?,
        natural_width: n("naturalWidth")?,
        natural_height: n("naturalHeight")?,
    })
}

fn restore_fixed_segments(v: Option<&Value>) -> Vec<FixedSegment> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let s = s.as_object()?;
                    Some(FixedSegment {
                        start: pair(s.get("start"))?,
                        end: pair(s.get("end"))?,
                        index: number(s.get("index")).filter(|i| *i >= 0.)? as usize,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `repairBinding`. v1 bindings are queued for `legacy_binding`.
fn repair_binding(
    v: Option<&Value>,
    elbow: bool,
    end: StartOrEnd,
    pending: &mut Vec<PendingBinding>,
) -> Option<FixedPointBinding> {
    let b = v?.as_object()?;
    let fixed_point = normalize_fixed_point(pair(b.get("fixedPoint")));
    let mode = get(b, "mode").filter(|m| truthy(Some(m)));
    let element_id = b
        .get("elementId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if elbow {
        // the element's existence is checked in the repair pass
        let mode = mode
            .and_then(Value::as_str)
            .and_then(BindMode::parse)
            .unwrap_or(BindMode::Orbit);
        return Some(FixedPointBinding {
            element_id: element_id?.into(),
            fixed_point,
            mode,
        });
    }
    // binding schema v2
    if let Some(mode) = mode {
        let mode = mode
            .as_str()
            .and_then(BindMode::parse)
            .unwrap_or(BindMode::Orbit);
        return Some(FixedPointBinding {
            element_id: element_id?.into(),
            fixed_point,
            mode,
        });
    }
    // v1: migrated later, once the bound element is restored
    pending.push(PendingBinding {
        end,
        element_id: element_id?.into(),
        fixed_point,
    });
    None
}

/// `restoreElement`. None for unsupported types.
fn restore_element(
    o: &Map<String, Value>,
    opts: &RestoreOpts,
    pending: &mut Vec<PendingBinding>,
) -> Option<Element> {
    let ty_name = o.get("type").and_then(Value::as_str)?;
    let mut e = match ty_name {
        "text" => {
            let mut font_size = number(get(o, "fontSize"));
            let mut font_family = number(get(o, "fontFamily"));
            if let Some(font) = o.get("font").and_then(Value::as_str) {
                let mut parts = font.split(' ');
                font_size = Some(js_parse_float(parts.next().unwrap_or("")));
                font_family = Some(
                    parts
                        .next()
                        .and_then(font_family_by_name)
                        .unwrap_or(DEFAULT_FONT_FAMILY) as f64,
                );
            }
            let font_size = font_size
                .filter(|s| s.is_finite())
                .unwrap_or(DEFAULT_FONT_SIZE);
            let font_family = font_family
                .filter(|f| *f >= 0. && f.fract() == 0. && *f <= u32::MAX as f64)
                .map_or(DEFAULT_FONT_FAMILY, |f| f as u32);
            let text = str_or(o.get("text"), "").to_owned();
            let line_height = number(get(o, "lineHeight"))
                .filter(|l| *l != 0. && !l.is_nan())
                .unwrap_or_else(|| {
                    // `restoreLineHeight`: detect it from old diagrams' laid-out height
                    let detected = number(get(o, "height"))
                        .filter(|h| *h != 0. && !h.is_nan())
                        .map(|h| detect_line_height(&text, h, font_size));
                    detected
                        .filter(|d| d.is_finite() && *d > 0.)
                        .unwrap_or_else(|| get_line_height(font_family))
                });
            let data = TextData {
                font_size,
                font_family,
                // only meaningful for sticky note labels; reconciled in `restore_sticky_notes`
                base_font_size: finite(get(o, "baseFontSize")).map(normalize_sticky_note_font_size),
                text_align: TextAlign::parse(str_or(o.get("textAlign"), ""))
                    .unwrap_or(TextAlign::Left),
                vertical_align: VerticalAlign::parse(str_or(o.get("verticalAlign"), ""))
                    .unwrap_or(VerticalAlign::Top),
                container_id: string(get(o, "containerId")),
                original_text: str_or(o.get("originalText"), &text).to_owned(),
                auto_resize: bool_nullish(get(o, "autoResize"), true),
                line_height,
                label_position: Some(finite(get(o, "labelPosition")).map(|p| clamp(p, 0., 1.))),
                text,
            };
            let empty = data.text.is_empty();
            let mut e = restore_base(o, Kind::Text(data), None);
            // obsidian-excalidraw's attribute conflicts when moving between the apps
            e.extra.remove("rawText");
            // empty text is deleted but kept, for data integrity (collab etc.)
            if opts.delete_invisible_elements && empty && !e.is_deleted {
                if let Some(t) = e.text_mut() {
                    t.original_text = String::new();
                }
                e.is_deleted = true;
                bump_version(&mut e, None);
            }
            e
        }
        "freedraw" => {
            let pressure_values = get(o, "pressures").and_then(Value::as_array);
            let (mut points, mut pressures) = (vec![], vec![]);
            for (i, p) in get(o, "points")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                if let Some(p) = valid_point(p) {
                    points.push(p);
                    if let Some(v) = pressure_values.and_then(|a| a.get(i)) {
                        pressures.push(v.as_f64().filter(|v| v.is_finite()).unwrap_or(0.5));
                    }
                }
            }
            let data = FreeDrawData {
                points,
                pressures,
                simulate_pressure: truthy(get(o, "simulatePressure")),
                stroke_options: restore_stroke_options(get(o, "strokeOptions")),
            };
            restore_base(o, Kind::FreeDraw(data), None)
        }
        "image" => restore_base(
            o,
            Kind::Image(ImageData {
                status: ImageStatus::parse(str_or(o.get("status"), ""))
                    .unwrap_or(ImageStatus::Pending),
                file_id: string(get(o, "fileId")),
                scale: pair(get(o, "scale")).unwrap_or([1., 1.]),
                crop: restore_crop(get(o, "crop")),
            }),
            None,
        ),
        // "draw" is a legacy type
        "line" | "draw" => {
            let arrowhead = |k| normalize_arrowhead(get(o, k).and_then(Value::as_str));
            let (mut x, mut y) = (num_nullish(get(o, "x"), 0.), num_nullish(get(o, "y"), 0.));
            let mut points =
                restore_linear_points(get(o, "points"), get(o, "width"), get(o, "height"));
            if points[0] != [0., 0.] {
                (points, x, y) = normalize_points(points, x, y);
            }
            let polygon =
                ty_name == "line" && is_valid_polygon(&points) && truthy(get(o, "polygon"));
            let (w, h) = get_size_from_points(&points);
            let linear = LinearData {
                points,
                start_binding: None,
                end_binding: None,
                start_arrowhead: arrowhead("startArrowhead"),
                end_arrowhead: arrowhead("endArrowhead"),
            };
            handle_oversized_linear(restore_base(
                o,
                Kind::Line { linear, polygon },
                Some((x, y, w, h)),
            ))
        }
        "arrow" => {
            let start_arrowhead =
                normalize_arrowhead(get(o, "startArrowhead").and_then(Value::as_str));
            let end_arrowhead = if o.contains_key("endArrowhead") {
                normalize_arrowhead(get(o, "endArrowhead").and_then(Value::as_str))
            } else {
                Some(Arrowhead::Arrow)
            };
            let (x, y) = (num_nullish(get(o, "x"), 0.), num_nullish(get(o, "y"), 0.));
            let points = restore_linear_points(get(o, "points"), get(o, "width"), get(o, "height"));
            let elbowed = truthy(get(o, "elbowed"));
            let start_binding =
                repair_binding(get(o, "startBinding"), elbowed, StartOrEnd::Start, pending);
            let end_binding =
                repair_binding(get(o, "endBinding"), elbowed, StartOrEnd::End, pending);
            let elbow = elbowed.then(|| {
                let segments = restore_fixed_segments(get(o, "fixedSegments"));
                ElbowData {
                    fixed_segments: (!segments.is_empty() && points.len() >= 4).then_some(segments),
                    start_is_special: get(o, "startIsSpecial").and_then(Value::as_bool),
                    end_is_special: get(o, "endIsSpecial").and_then(Value::as_bool),
                }
            });
            let (w, h) = get_size_from_points(&points);
            let (points, x, y) = normalize_points(points, x, y);
            let linear = LinearData {
                points,
                start_binding,
                end_binding,
                start_arrowhead,
                end_arrowhead,
            };
            handle_oversized_linear(restore_base(
                o,
                Kind::Arrow { linear, elbow },
                Some((x, y, w, h)),
            ))
        }
        "ellipse" => restore_base(o, Kind::Ellipse, None),
        "rectangle" => restore_base(o, Kind::Rectangle, None),
        "diamond" => restore_base(o, Kind::Diamond, None),
        "iframe" => restore_base(o, Kind::Iframe, None),
        "embeddable" => restore_base(o, Kind::Embeddable, None),
        "stickynote" => {
            let base_height = number(get(o, "baseHeight"))
                .or_else(|| number(get(o, "maxHeight")))
                .or_else(|| number(get(o, "height")))
                .unwrap_or(0.);
            normalize_sticky_note(&restore_base(o, Kind::StickyNote { base_height }, None))
        }
        "frame" => restore_base(
            o,
            Kind::Frame {
                name: string(get(o, "name")),
            },
            None,
        ),
        "magicframe" => restore_base(
            o,
            Kind::MagicFrame {
                name: string(get(o, "name")),
            },
            None,
        ),
        _ => return None,
    };
    if e.id.is_empty() {
        e.id = random_id();
    }
    Some(e)
}

/// `isInvisiblySmallElement` on the raw element, as upstream checks it before
/// restoring.
fn raw_invisibly_small(o: &Map<String, Value>) -> bool {
    match o.get("type").and_then(Value::as_str) {
        Some("line" | "draw" | "arrow" | "freedraw") => {
            let Some(p) = get(o, "points").and_then(Value::as_array) else {
                return false;
            };
            p.len() < 2
                || (p.len() == 2
                    && o.get("type").and_then(Value::as_str) == Some("arrow")
                    && matches!((pair(Some(&p[0])), pair(Some(&p[1]))), (Some(a), Some(b)) if points_equal(a, b, INVISIBLY_SMALL_ELEMENT_SIZE)))
        }
        _ => number(o.get("width")) == Some(0.) && number(o.get("height")) == Some(0.),
    }
}

// ---------------------------------------------------------------------------
// restoreElements and the repairs
// ---------------------------------------------------------------------------

/// `restoreElements`: `target` is the raw `elements` array. `existing` is the
/// local scene, for version bumps of invisible elements and for binding
/// context. The result has valid fractional indices in array order.
pub fn restore_elements(
    target: Option<&Value>,
    existing: Option<&dyn ElementsMap>,
    opts: &RestoreOpts,
) -> Vec<Element> {
    let mut existing_ids: FxHashSet<String> = FxHashSet::default();
    let mut elements: Vec<Element> = vec![];
    let mut pending: Vec<(usize, PendingBinding)> = vec![];
    for raw in target.and_then(Value::as_array).into_iter().flatten() {
        let Some(o) = raw.as_object() else { continue };
        // selection elements are legacy and break things when kept
        if o.get("type").and_then(Value::as_str) == Some("selection") {
            continue;
        }
        let mut p = vec![];
        let Some(mut e) = restore_element(o, opts, &mut p) else {
            continue;
        };
        if opts.delete_invisible_elements && raw_invisibly_small(o) {
            let local = existing
                .and_then(|m| m.get_element(&e.id))
                .map(|l| l.version);
            bump_version(&mut e, local);
            e.is_deleted = true;
        }
        if existing_ids.contains(&e.id) {
            e.id = random_id();
        }
        existing_ids.insert(e.id.clone());
        pending.extend(p.into_iter().map(|p| (elements.len(), p)));
        elements.push(e);
    }
    migrate_legacy_bindings(&mut elements, pending, existing, opts);
    sync_invalid_indices(&mut elements);
    if !opts.repair_bindings {
        return elements;
    }

    let pos: FxHashMap<String, usize> = elements
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.clone(), i))
        .collect();
    for i in 0..elements.len() {
        // frame membership: drop a frameId whose frame doesn't exist
        if elements[i]
            .frame_id
            .as_ref()
            .is_some_and(|f| !pos.contains_key(f))
        {
            elements[i].frame_id = None;
        }
        if elements[i].container_id().is_some() {
            repair_bound_element(&mut elements, i, &pos);
        } else if elements[i].bound_elements.is_some() {
            repair_container_element(&mut elements, i, &pos);
        }
        let e = &mut elements[i];
        let is_arrow = e.is_arrow();
        if let Some(l) = e.linear_mut() {
            if l.start_binding
                .as_ref()
                .is_some_and(|b| !pos.contains_key(&b.element_id) || !is_arrow)
            {
                l.start_binding = None;
            }
            if l.end_binding
                .as_ref()
                .is_some_and(|b| !pos.contains_key(&b.element_id) || !is_arrow)
            {
                l.end_binding = None;
            }
        }
        // sticky labels are refitted with their note below
        if let Some(m) = opts.refresh_dimensions
            && elements[i].is_text()
            && !is_sticky_note_bound_text(&elements[i], &elements)
        {
            let container = elements[i]
                .container_id()
                .and_then(|c| pos.get(c))
                .map(|&c| elements[c].clone());
            if let Some(d) = super::text::refresh_text_dimensions(
                &elements[i],
                container.as_ref(),
                &elements,
                None,
                None,
                m,
            ) {
                d.apply(&mut elements[i]);
            }
        }
    }
    restore_sticky_notes(&mut elements, &pos, opts.refresh_dimensions);
    let mut elements = repair_bound_text_element_order(elements);
    fix_self_bound_elbow_arrows(&mut elements);
    elements
}

fn migrate_legacy_bindings(
    elements: &mut Vec<Element>,
    pending: Vec<(usize, PendingBinding)>,
    existing: Option<&dyn ElementsMap>,
    opts: &RestoreOpts,
) {
    let repair = opts
        .legacy_binding
        .unwrap_or(super::binding::repair_legacy_binding);
    // the arrows with their v1 bindings in place (upstream's `safeElement`)
    let mut safe: FxHashMap<usize, Element> = FxHashMap::default();
    for (i, p) in &pending {
        let e = safe.entry(*i).or_insert_with(|| elements[*i].clone());
        let b = Some(FixedPointBinding {
            element_id: p.element_id.clone(),
            fixed_point: p.fixed_point,
            mode: BindMode::Orbit,
        });
        if let Some(l) = e.linear_mut() {
            match p.end {
                StartOrEnd::Start => l.start_binding = b,
                StartOrEnd::End => l.end_binding = b,
            }
        }
    }
    for (i, p) in pending {
        let bound = elements
            .iter()
            .find(|e| e.id == p.element_id)
            .or_else(|| existing.and_then(|m| m.get_element(&p.element_id)))
            .cloned();
        let Some(bound) = bound else { continue };
        let in_target = elements.iter().any(|e| e.id == p.element_id);
        let arrow = &safe[&i];
        let b = if in_target {
            repair(arrow, p.end, &bound, &*elements)
        } else {
            repair(arrow, p.end, &bound, existing.unwrap())
        };
        if let Some(l) = elements[i].linear_mut() {
            match p.end {
                StartOrEnd::Start => l.start_binding = b,
                StartOrEnd::End => l.end_binding = b,
            }
        }
    }
}

/// `repairBoundElement`: the text takes its container's angle (0 on
/// arrows), loses a containerId whose container is gone, and gets listed in
/// its container's `boundElements`.
fn repair_bound_element(elements: &mut [Element], i: usize, pos: &FxHashMap<String, usize>) {
    let container = elements[i].container_id().and_then(|c| pos.get(c)).copied();
    elements[i].angle = container.map_or(0., |c| {
        if elements[c].is_arrow() {
            0.
        } else {
            elements[c].angle
        }
    });
    let Some(c) = container else {
        if let Some(t) = elements[i].text_mut() {
            t.container_id = None;
        }
        return;
    };
    if elements[i].is_deleted {
        return;
    }
    let id = elements[i].id.clone();
    if let Some(b) = &mut elements[c].bound_elements
        && !b.iter().any(|b| b.id == id)
    {
        b.push(BoundElement {
            id,
            kind: BoundType::Text,
        });
    }
}

/// `repairContainerElement`: dedupes `boundElements`, drops missing and
/// deleted ones, and sets the containerId of listed text that has none.
fn repair_container_element(elements: &mut [Element], i: usize, pos: &FxHashMap<String, usize>) {
    let Some(list) = elements[i].bound_elements.clone() else {
        return;
    };
    let container_id = elements[i].id.clone();
    let mut seen = FxHashSet::default();
    let mut out = vec![];
    for b in list {
        let Some(&j) = pos.get(&b.id) else { continue };
        if !seen.insert(b.id.clone()) {
            continue;
        }
        if elements[j].is_deleted {
            continue;
        }
        out.push(b);
        // conservative: an existing containerId wins, lest boundElements is stale
        if let Some(t) = elements[j].text_mut()
            && t.container_id.is_none()
        {
            t.container_id = Some(container_id.clone());
        }
    }
    elements[i].bound_elements = Some(out);
}

/// Sticky note invariants that need both halves (after binding repair): a
/// label's `baseFontSize` only while it labels a note (seeded from
/// `fontSize`), a visible label stroke, and one ink per note.
fn restore_sticky_notes(
    elements: &mut [Element],
    pos: &FxHashMap<String, usize>,
    refresh: Option<&dyn super::text_measure::Measure>,
) {
    for i in 0..elements.len() {
        if !elements[i].is_text() || elements[i].is_deleted {
            continue;
        }
        let container = elements[i]
            .container_id()
            .and_then(|c| pos.get(c))
            .copied()
            .filter(|&c| elements[c].is_sticky_note());
        if let Some(c) = container {
            // a transparent label takes the note's color; otherwise the label wins
            let label = &elements[i].stroke_color;
            let stroke = normalize_sticky_note_stroke_color(Some(if is_transparent(label) {
                &elements[c].stroke_color
            } else {
                label
            }));
            if let Some(t) = elements[i].text_mut() {
                t.base_font_size = Some(normalize_sticky_note_font_size(
                    t.base_font_size.unwrap_or(t.font_size),
                ));
            }
            elements[i].stroke_color = stroke.clone();
            if elements[c].stroke_color != stroke {
                elements[c].stroke_color = stroke;
            }
        } else if let Some(t) = elements[i].text_mut()
            && t.base_font_size.is_some()
        {
            t.base_font_size = None;
        }
    }
    // refreshDimensions: the note and its label refitted together
    let Some(m) = refresh else { return };
    for i in 0..elements.len() {
        if !elements[i].is_sticky_note() || elements[i].is_deleted {
            continue;
        }
        let text = elements[i]
            .bound_text_id()
            .and_then(|t| pos.get(t))
            .copied();
        let layout = get_sticky_note_layout(
            &elements[i],
            text.map(|t| &elements[t]),
            &StickyNoteLayoutOpts::default(),
            m,
        );
        layout.container.apply(&mut elements[i]);
        if let (Some(t), Some(lt)) = (text, &layout.text) {
            lt.apply(&mut elements[t]);
        }
    }
}

/// `repairBoundTextElementOrder`: bound text right after its container,
/// keeping the container's index.
fn repair_bound_text_element_order(elements: Vec<Element>) -> Vec<Element> {
    let original: FxHashMap<String, usize> = elements
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.clone(), i))
        .collect();
    let mut normalized = normalize_bound_elements_order(elements);
    let moved: FxHashSet<String> = normalized
        .iter()
        .enumerate()
        .filter(|(i, e)| e.container_id().is_some() && original.get(&e.id) != Some(i))
        .map(|(_, e)| e.id.clone())
        .collect();
    if !moved.is_empty() {
        sync_moved_indices(&mut normalized, &moved);
    }
    normalized
}

/// Temporary upstream fixes: unbound elbow arrows with invalid points are
/// routed again, self-bound ones with runaway points reset.
fn fix_self_bound_elbow_arrows(elements: &mut [Element]) {
    for i in 0..elements.len() {
        let e = &elements[i];
        let Some(l) = e.linear().filter(|_| e.is_elbow_arrow()) else {
            continue;
        };
        if l.start_binding.is_none()
            && l.end_binding.is_none()
            && !super::elbow::validate_elbow_points(&l.points, 1.)
        {
            let last = l.points[l.points.len() - 1];
            let u = super::binding::ElbowUpdate {
                points: Some(vec![[0., 0.], last]),
                ..Default::default()
            };
            let map = super::utils::array_to_map(elements);
            let u = super::elbow::update_elbow_arrow_points(e, &map, &u, &Default::default());
            u.apply(&mut elements[i]);
            continue;
        }
        let (Some(s), Some(t)) = (&l.start_binding, &l.end_binding) else {
            continue;
        };
        if s.element_id != t.element_id
            || l.points.len() <= 1
            || !l
                .points
                .iter()
                .any(|p| p[0].abs() > 1e6 || p[1].abs() > 1e6)
        {
            continue;
        }
        let Some(b) = elements.iter().find(|b| b.id == s.element_id) else {
            continue;
        };
        let (bx, by, bw, bh) = (b.x, b.y, b.width, b.height);
        let e = &mut elements[i];
        (e.x, e.y, e.width, e.height) = (bx + bw / 2., by - 5., bw, bh);
        if let Some(p) = e.points_mut() {
            *p = vec![
                [0., 0.],
                [0., -10.],
                [bw / 2. + 5., -10.],
                [bw / 2. + 5., bh / 2. + 5.],
            ];
        }
    }
}

/// `bumpElementVersions`: elements that also exist locally with a newer (or
/// equal but different) version get the local version + 1, for later
/// reconciliation.
pub fn bump_element_versions(
    mut target: Vec<Element>,
    local: Option<&dyn ElementsMap>,
) -> Vec<Element> {
    let Some(local) = local else { return target };
    for e in &mut target {
        if let Some(l) = local.get_element(&e.id)
            && (l.version > e.version
                || (l.version == e.version && l.version_nonce != e.version_nonce))
        {
            bump_version(e, Some(l.version));
        }
    }
    target
}

// ---------------------------------------------------------------------------
// appState and files
// ---------------------------------------------------------------------------

/// The app state that travels with a file (`cleanAppStateForExport`, minus
/// `lockedMultiSelections`, which needs selection state we don't keep).
#[derive(Clone, Debug, PartialEq)]
pub struct ExportedAppState {
    pub view_background_color: String,
    pub grid_size: f64,
    pub grid_step: f64,
    pub grid_mode_enabled: bool,
}

impl Default for ExportedAppState {
    fn default() -> Self {
        ExportedAppState {
            view_background_color: COLOR_WHITE.into(),
            grid_size: DEFAULT_GRID_SIZE,
            grid_step: DEFAULT_GRID_STEP as f64,
            grid_mode_enabled: false,
        }
    }
}

/// `getNormalizedGridSize` / `getNormalizedGridStep`.
pub fn get_normalized_grid(v: f64) -> f64 {
    clamp(js_round(v), 1., 100.)
}

/// `restoreAppState` for the exported fields: supplied values win, then
/// local ones, then defaults; grid size and step ignore the local state.
pub fn restore_app_state(
    app: Option<&Value>,
    local: Option<&ExportedAppState>,
) -> ExportedAppState {
    let d = ExportedAppState::default();
    let o = app.and_then(Value::as_object);
    let field = |k: &str| o.and_then(|o| o.get(k));
    ExportedAppState {
        view_background_color: field("viewBackgroundColor")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| local.map(|l| l.view_background_color.clone()))
            .unwrap_or(d.view_background_color),
        grid_mode_enabled: field("gridModeEnabled")
            .and_then(Value::as_bool)
            .or(local.map(|l| l.grid_mode_enabled))
            .unwrap_or(false),
        grid_size: get_normalized_grid(finite(field("gridSize")).unwrap_or(DEFAULT_GRID_SIZE)),
        grid_step: get_normalized_grid(
            finite(field("gridStep")).unwrap_or(DEFAULT_GRID_STEP as f64),
        ),
    }
}

/// `files` (`BinaryFiles`), id → file. Upstream takes them as they come;
/// entries that aren't objects are dropped, missing fields defaulted.
pub fn restore_files(v: Option<&Value>) -> BTreeMap<String, FileData> {
    let Some(o) = v.and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    o.iter()
        .filter_map(|(k, f)| {
            let f = f.as_object()?;
            const KEYS: &[&str] = &[
                "mimeType",
                "id",
                "dataURL",
                "path",
                "created",
                "lastRetrieved",
                "version",
            ];
            Some((
                k.clone(),
                FileData {
                    id: string(get(f, "id")).unwrap_or_else(|| k.clone()),
                    mime_type: str_or(f.get("mimeType"), "application/octet-stream").into(),
                    data_url: string(get(f, "dataURL")),
                    path: string(get(f, "path")),
                    created: number(get(f, "created")).map_or(0, int),
                    last_retrieved: number(get(f, "lastRetrieved")).map(int),
                    version: number(get(f, "version")).map(int),
                    extra: f
                        .iter()
                        .filter(|(k, _)| !KEYS.contains(&k.as_str()))
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                },
            ))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/// A restored scene.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct SceneData {
    pub elements: Vec<Element>,
    pub app_state: ExportedAppState,
    pub files: BTreeMap<String, FileData>,
}

/// `isValidExcalidrawData`.
pub fn is_valid_excalidraw_data(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some(EXPORT_DATA_TYPE_EXCALIDRAW)
        && (!truthy(v.get("elements"))
            || (v["elements"].is_array()
                && (!truthy(v.get("appState")) || v["appState"].is_object())))
}

/// Loads a `.excalidraw` file (`loadFromBlob` for scene data, without a
/// local scene).
pub fn load_file(s: &str, opts: &RestoreOpts) -> Result<SceneData, String> {
    let v: Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
    if !is_valid_excalidraw_data(&v) {
        return Err("not Excalidraw scene data".into());
    }
    Ok(SceneData {
        elements: restore_elements(v.get("elements"), None, opts),
        app_state: restore_app_state(v.get("appState"), None),
        files: restore_files(v.get("files")),
    })
}

/// Loads the scene form documents embed: `{"elements":[…],"files":{…}}`.
pub fn load_scene(s: &str, opts: &RestoreOpts) -> Result<SceneData, String> {
    let v: Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
    if !v.is_object() {
        return Err("scene is not an object".into());
    }
    Ok(SceneData {
        elements: restore_elements(v.get("elements"), None, opts),
        app_state: ExportedAppState::default(),
        files: restore_files(v.get("files")),
    })
}

/// Why a dropped / opened file didn't load (`loadSceneOrLibraryFromBlob`'s
/// errors).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoadError {
    /// An image without a scene in it (`IMAGE_NOT_CONTAINS_SCENE_DATA`).
    ImageWithoutScene,
    /// An image whose scene can't be read ("cannot restore image").
    CannotRestoreImage,
    /// A library file (`.excalidrawlib`), which `loadFromBlob` refuses.
    Library,
    /// Anything else ("invalid file").
    Invalid,
}

/// `parseFileContents`: the scene JSON in a file, by its mime type (PNG and
/// SVG: the embedded scene).
pub fn parse_file_contents(bytes: &[u8], mime_type: &str) -> Result<String, LoadError> {
    use super::encode::{SceneDataError, decode_png_metadata, decode_svg_base64_payload};
    let image_err = |e: SceneDataError| {
        if e == SceneDataError::NoScene {
            LoadError::ImageWithoutScene
        } else {
            LoadError::CannotRestoreImage
        }
    };
    if mime_type == super::image::mime::PNG {
        return decode_png_metadata(bytes).map_err(image_err);
    }
    let text = String::from_utf8_lossy(bytes).into_owned();
    if mime_type == super::image::mime::SVG {
        return decode_svg_base64_payload(&text).map_err(image_err);
    }
    Ok(text)
}

/// `loadFromBlob`: a dropped or opened `.excalidraw` / `.json` file, or a
/// PNG / SVG with a scene embedded, restored as on load with
/// `RestoreOpts::load()` (`local_elements`: for the versions of elements
/// deleted as invisible). `mime_type` as the file came (empty: guessed from `name`, as
/// `getMimeType` / `normalizeFile` do). The app state is the exported part,
/// over `local`; scrolling to the content is the app's.
pub fn load_from_blob(
    bytes: &[u8],
    mime_type: &str,
    name: &str,
    local_app_state: Option<&ExportedAppState>,
    local_elements: Option<&dyn ElementsMap>,
    opts: &RestoreOpts,
) -> Result<SceneData, LoadError> {
    let declared = if mime_type.is_empty() {
        super::image::get_mime_type(name)
    } else {
        mime_type
    };
    let mime = super::image::normalize_file_mime_type(name, declared, bytes);
    let contents = parse_file_contents(bytes, &mime)?;
    let data: Value = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(_) if super::image::is_supported_image_file_type(&mime) => {
            return Err(LoadError::ImageWithoutScene);
        }
        Err(_) => return Err(LoadError::Invalid),
    };
    if is_valid_excalidraw_data(&data) {
        let elements = restore_elements(data.get("elements"), local_elements, opts);
        return Ok(SceneData {
            elements,
            app_state: restore_app_state(data.get("appState"), local_app_state),
            files: restore_files(data.get("files")),
        });
    }
    if is_valid_library(&data) {
        return Err(LoadError::Library);
    }
    Err(LoadError::Invalid)
}

/// `isValidLibrary`.
pub fn is_valid_library(v: &Value) -> bool {
    v.is_object()
        && v.get("type").and_then(Value::as_str) == Some("excalidrawlib")
        && matches!(
            v.get("version").and_then(Value::as_f64),
            Some(1.) | Some(2.)
        )
}
