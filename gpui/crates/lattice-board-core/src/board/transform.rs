// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Element skeletons to elements. Port of Excalidraw
//! `packages/element/src/transform.ts` (`convertToExcalidrawElements`)
//! @ 3a317b5: shapes, text, lines and arrows, images, frames, sticky notes
//! from partial descriptions, with labels on containers and arrows, arrows
//! bound to existing elements by id or to shapes / texts created for their
//! ends, bound arrows placed by their bindings, and frames sized around
//! their children. Used for paste (`excalidraw-api/clipboard`) and
//! templates.
//!
//! Skeletons are JSON (`serde_json::Value`), as upstream takes plain
//! objects; "spreading" an object into a constructor is reading its keys
//! over the defaults. Differences:
//! - text is measured with a `Measure`; elbow routing goes through the
//!   given `BindingHooks` (labels are laid out by this module's own hooks
//!   over them);
//! - where upstream throws (a frame child or bound element missing) an
//!   `Err` comes back; duplicate ids are dropped (upstream logs them);
//! - `Object.assign` on an element (no version bump) is a direct field
//!   write; scene mutations bump versions as upstream's do.

use super::binding::*;
use super::bounds::*;
use super::consts::*;
use super::math::*;
use super::mutate::get_updated_timestamp;
use super::new_element::*;
use super::random::random_id;
use super::scene::Scene;
use super::sticky::normalize_sticky_note_stroke_color;
use super::text::{
    DEFAULT_BOUND_TEXT_LABEL_POSITION, handle_bind_text_resize, redraw_text_bounding_box,
};
use super::text_measure::Measure;
use super::types::*;
use super::utils::{ElementsMap, get_size_from_points, is_transparent, normalize_arrowhead};
use rustc_hash::FxHashMap;
use serde_json::{Map, Value};

const DEFAULT_LINEAR_WIDTH: f64 = 100.;
const DEFAULT_DIMENSION: f64 = 100.;

/// Options of `convertToExcalidrawElements`.
pub struct TransformOpts<'a> {
    /// New ids (and creation times) for every element; default true.
    pub regenerate_ids: bool,
    pub measure: &'a dyn Measure,
    /// Elbow routing.
    pub hooks: &'a dyn BindingHooks,
}

/// Hooks that lay out arrow labels with a measurer, routing through `inner`.
struct LabelHooks<'a> {
    m: &'a dyn Measure,
    inner: &'a dyn BindingHooks,
}
impl BindingHooks for LabelHooks<'_> {
    fn update_elbow_arrow_points(
        &self,
        arrow: &Element,
        map: &dyn ElementsMap,
        updates: &ElbowUpdate,
        opts: &ElbowOptions,
    ) -> ElbowUpdate {
        self.inner
            .update_elbow_arrow_points(arrow, map, updates, opts)
    }
    fn handle_bind_text_resize(&self, arrow_id: &str, store: &mut dyn BindingStore) {
        handle_bind_text_resize(store, arrow_id, self.m, None, false, false, false)
    }
}

// ---------------------------------------------------------------------------
// reading skeletons
// ---------------------------------------------------------------------------

type Obj = Map<String, Value>;
fn num(o: &Obj, k: &str) -> Option<f64> {
    o.get(k).and_then(Value::as_f64)
}
/// JS `o.k || d` on numbers.
fn num_or(o: &Obj, k: &str, d: f64) -> f64 {
    num(o, k).filter(|v| *v != 0.).unwrap_or(d)
}
fn text_of(o: &Obj, k: &str) -> Option<String> {
    o.get(k).and_then(Value::as_str).map(str::to_owned)
}
fn point(v: &Value) -> Option<Point> {
    let a = v.as_array()?;
    Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?])
}
fn points(o: &Obj, k: &str) -> Option<Vec<Point>> {
    o.get(k)?.as_array()?.iter().map(point).collect()
}

/// `ElementConstructorOpts` from a skeleton's keys.
fn opts_from(o: &Obj) -> ElementOpts {
    let d = ElementOpts::default();
    ElementOpts {
        id: text_of(o, "id"),
        x: num(o, "x").unwrap_or(0.),
        y: num(o, "y").unwrap_or(0.),
        stroke_color: text_of(o, "strokeColor").unwrap_or(d.stroke_color),
        background_color: text_of(o, "backgroundColor").unwrap_or(d.background_color),
        fill_style: o
            .get("fillStyle")
            .and_then(Value::as_str)
            .and_then(FillStyle::parse)
            .unwrap_or(d.fill_style),
        stroke_width: num(o, "strokeWidth").unwrap_or(d.stroke_width),
        stroke_style: o
            .get("strokeStyle")
            .and_then(Value::as_str)
            .and_then(StrokeStyle::parse)
            .unwrap_or(d.stroke_style),
        roundness: o.get("roundness").and_then(Value::as_object).and_then(|r| {
            Some(Roundness {
                kind: r.get("type")?.as_u64()? as u8,
                value: r.get("value").and_then(Value::as_f64),
            })
        }),
        roughness: num(o, "roughness").unwrap_or(d.roughness),
        opacity: num(o, "opacity").unwrap_or(d.opacity),
        width: num(o, "width").unwrap_or(0.),
        height: num(o, "height").unwrap_or(0.),
        angle: num(o, "angle").unwrap_or(0.),
        group_ids: o
            .get("groupIds")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|g| g.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        frame_id: text_of(o, "frameId"),
        index: text_of(o, "index"),
        bound_elements: o.get("boundElements").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(|b| {
                    Some(BoundElement {
                        id: b.get("id")?.as_str()?.into(),
                        kind: BoundType::parse(b.get("type")?.as_str()?)?,
                    })
                })
                .collect()
        }),
        seed: num(o, "seed").map(|v| v as i64),
        version: num(o, "version").map(|v| v as i64),
        version_nonce: num(o, "versionNonce").map(|v| v as i64),
        created: num(o, "created").map(|v| Some(v as i64)),
        link: text_of(o, "link"),
        locked: o.get("locked").and_then(Value::as_bool).unwrap_or(false),
        custom_data: o.get("customData").filter(|v| v.is_object()).cloned(),
    }
}

/// `newTextElement` from a skeleton (`fontSize`, `fontFamily`, `text`, …).
fn text_from(o: &Obj, base: ElementOpts, m: &dyn Measure) -> Element {
    let t = TextOpts {
        text: text_of(o, "text").unwrap_or_default(),
        original_text: text_of(o, "originalText"),
        font_size: num(o, "fontSize"),
        font_family: num(o, "fontFamily").map(|f| f as u32),
        text_align: o
            .get("textAlign")
            .and_then(Value::as_str)
            .and_then(TextAlign::parse),
        vertical_align: o
            .get("verticalAlign")
            .and_then(Value::as_str)
            .and_then(VerticalAlign::parse),
        container_id: text_of(o, "containerId"),
        line_height: num(o, "lineHeight"),
        auto_resize: o.get("autoResize").and_then(Value::as_bool),
        label_position: num(o, "labelPosition"),
        base_font_size: None,
    };
    new_text_element(t, base, m)
}

/// `{...a, ...b}`.
fn spread(a: &Obj, b: &Obj) -> Obj {
    let mut out = a.clone();
    for (k, v) in b {
        out.insert(k.clone(), v.clone());
    }
    out
}

/// An element as a plain object, to spread like upstream spreads elements.
fn as_obj(e: &Element) -> Obj {
    match super::json::element_to_value(e) {
        Value::Object(o) => o,
        _ => Obj::new(),
    }
}

/// Builds the element a skeleton describes (the first pass).
fn build(o: &Obj, m: &dyn Measure) -> Option<Element> {
    let ty = o.get("type").and_then(Value::as_str)?;
    let mut base = opts_from(o);
    let has_label = o
        .get("label")
        .and_then(|l| l.get("text"))
        .and_then(Value::as_str)
        .is_some_and(|t| !t.is_empty());
    Some(match ty {
        "rectangle" | "ellipse" | "diamond" => {
            base.width = if has_label && !o.contains_key("width") {
                0.
            } else {
                num_or(o, "width", DEFAULT_DIMENSION)
            };
            base.height = if has_label && !o.contains_key("height") {
                0.
            } else {
                num_or(o, "height", DEFAULT_DIMENSION)
            };
            new_element(ElementType::parse(ty).unwrap(), base)
        }
        "line" | "arrow" => {
            let (w, h) = (
                num_or(o, "width", DEFAULT_LINEAR_WIDTH),
                num_or(o, "height", 0.),
            );
            (base.width, base.height) =
                (num(o, "width").unwrap_or(w), num(o, "height").unwrap_or(h));
            let pts = points(o, "points").unwrap_or_else(|| vec![[0., 0.], [w, h]]);
            if ty == "line" {
                new_linear_element(base, pts, o.get("polygon").and_then(Value::as_bool))
            } else {
                let head = |k: &str, d: Option<Arrowhead>| match o.get(k) {
                    Some(Value::Null) => None,
                    Some(v) => normalize_arrowhead(v.as_str()),
                    None => d,
                };
                let mut e = new_arrow_element(
                    base,
                    pts,
                    head("startArrowhead", None),
                    head("endArrowhead", Some(Arrowhead::Arrow)),
                    o.get("elbowed").and_then(Value::as_bool).unwrap_or(false),
                    None,
                );
                (e.width, e.height) = get_size_from_points(e.points().unwrap());
                e
            }
        }
        "text" => text_from(o, base, m),
        "image" => {
            (base.width, base.height) = (
                num(o, "width").unwrap_or(DEFAULT_DIMENSION),
                num(o, "height").unwrap_or(DEFAULT_DIMENSION),
            );
            let crop = o.get("crop").and_then(Value::as_object).and_then(|c| {
                Some(ImageCrop {
                    x: num(c, "x")?,
                    y: num(c, "y")?,
                    width: num(c, "width")?,
                    height: num(c, "height")?,
                    natural_width: num(c, "naturalWidth")?,
                    natural_height: num(c, "naturalHeight")?,
                })
            });
            let scale = o.get("scale").and_then(point);
            new_image_element(
                base,
                o.get("status")
                    .and_then(Value::as_str)
                    .and_then(ImageStatus::parse),
                text_of(o, "fileId"),
                scale,
                crop,
            )
        }
        "frame" => new_frame_element(base, text_of(o, "name")),
        "magicframe" => new_magic_frame_element(base, text_of(o, "name")),
        "freedraw" => new_free_draw_element(
            base,
            points(o, "points").unwrap_or_default(),
            o.get("pressures")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default(),
            o.get("simulatePressure")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            None,
        ),
        "iframe" => new_iframe_element(base),
        "embeddable" => new_embeddable_element(base),
        "stickynote" => {
            (base.width, base.height) = (
                num_or(o, "width", DEFAULT_STICKY_NOTE_SIZE),
                num_or(o, "height", DEFAULT_STICKY_NOTE_SIZE),
            );
            let bh = num(o, "baseHeight").unwrap_or(base.height);
            normalize_sticky_note_geometry(&new_sticky_note_element(base, Some(bh)))
        }
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// the element store (insertion-ordered, like upstream's Map)
// ---------------------------------------------------------------------------

fn add(store: &mut Vec<Element>, e: Element) {
    match store.iter_mut().find(|x| x.id == e.id) {
        Some(x) => *x = e,
        None => store.push(e),
    }
}
fn get<'a>(store: &'a [Element], id: &str) -> Option<&'a Element> {
    store.iter().find(|e| e.id == id)
}
/// `Object.assign` on a stored element: no version bump.
fn assign(store: &mut [Element], id: &str, f: impl FnOnce(&mut Element)) {
    if let Some(e) = store.iter_mut().find(|e| e.id == id) {
        f(e)
    }
}

/// `bindTextToContainer`: the label, bound; non-arrow containers are laid
/// out around it here, arrow labels later along the placed arrow.
fn bind_text_to_container(
    store: &mut Vec<Element>,
    container_id: &str,
    label: &Obj,
    m: &dyn Measure,
) -> String {
    let c = get(store, container_id).unwrap().clone();
    let given_stroke = text_of(label, "strokeColor").filter(|s| !s.is_empty());
    let sticky_ink = c.is_sticky_note().then(|| {
        normalize_sticky_note_stroke_color(Some(match &given_stroke {
            Some(s) if !is_transparent(s) => s,
            _ => &c.stroke_color,
        }))
    });
    let mut o = label.clone();
    o.remove("created");
    o.entry("textAlign").or_insert(Value::from("center"));
    o.entry("verticalAlign").or_insert(Value::from("middle"));
    o.insert("containerId".into(), Value::from(c.id.clone()));
    o.insert(
        "strokeColor".into(),
        Value::from(
            sticky_ink
                .clone()
                .or(given_stroke)
                .unwrap_or_else(|| c.stroke_color.clone()),
        ),
    );
    if c.is_arrow() {
        let p = num(label, "labelPosition")
            .filter(|p| p.is_finite())
            .map_or(DEFAULT_BOUND_TEXT_LABEL_POSITION, |p| clamp(p, 0., 1.));
        o.insert("labelPosition".into(), Value::from(p));
        o.insert("angle".into(), Value::from(0.));
    } else {
        o.remove("labelPosition");
    }
    let t = text_from(&o, opts_from(&o), m);
    let tid = t.id.clone();
    assign(store, container_id, |c| {
        c.bound_elements
            .get_or_insert_with(Vec::new)
            .push(BoundElement {
                id: tid.clone(),
                kind: BoundType::Text,
            });
        if let Some(ink) = &sticky_ink
            && *ink != c.stroke_color
        {
            c.stroke_color = ink.clone();
        }
    });
    add(store, t);
    if !c.is_arrow() {
        let t = get(store, &tid).unwrap().clone();
        redraw_text_bounding_box(store, &t, Some(container_id), m);
    }
    tid
}

/// `getArrowEndShapePosition`: where to put a shape for an arrow's end:
/// centered on the end segment extended past the end, the end on its outline.
fn get_arrow_end_shape_position(
    arrow: &Element,
    s: StartOrEnd,
    ty: Option<&str>,
    w: f64,
    h: f64,
) -> Point {
    let p = arrow.points().unwrap_or(&[]);
    let (end, next) = if s == StartOrEnd::Start {
        (p[0], p.get(1))
    } else {
        (
            p[p.len() - 1],
            p.len().checked_sub(2).and_then(|i| p.get(i)),
        )
    };
    let (mut dx, mut dy) = next.map_or((0., 0.), |n| (end[0] - n[0], end[1] - n[1]));
    let len = dx.hypot(dy);
    if len != 0. {
        dx /= len;
        dy /= len;
    } else {
        dx = if s == StartOrEnd::Start { -1. } else { 1. };
    }
    let (a, b) = (w / 2., h / 2.);
    let distance = match ty {
        Some("ellipse") | Some("diamond") => {
            let den = if ty == Some("ellipse") {
                (b * dx).hypot(a * dy)
            } else {
                b * dx.abs() + a * dy.abs()
            };
            if den != 0. { a * b / den } else { 0. }
        }
        _ => (if dx != 0. {
            a / dx.abs()
        } else {
            f64::INFINITY
        })
        .min(if dy != 0. {
            b / dy.abs()
        } else {
            f64::INFINITY
        }),
    };
    [
        arrow.x + end[0] + dx * distance - a,
        arrow.y + end[1] + dy * distance - b,
    ]
}

/// `bindLinearElementToElement`: creates (or re-creates, spreading the
/// existing one) the element for each given end and binds the arrow to it.
fn bind_linear_element_to_element(
    store: &mut Vec<Element>,
    arrow_id: &str,
    start: Option<&Obj>,
    end: Option<&Obj>,
    m: &dyn Measure,
) {
    for (s, spec) in [(StartOrEnd::Start, start), (StartOrEnd::End, end)] {
        let Some(spec) = spec else { continue };
        let arrow = get(store, arrow_id).unwrap().clone();
        let w = num(spec, "width").unwrap_or(DEFAULT_DIMENSION);
        let h = num(spec, "height").unwrap_or(DEFAULT_DIMENSION);
        let existing = text_of(spec, "id").and_then(|id| get(store, &id)).cloned();
        let ty = existing
            .as_ref()
            .map(|e| e.ty().as_str().to_string())
            .or_else(|| text_of(spec, "type"));
        let Some(ty) = ty else { continue };
        let pos = get_arrow_end_shape_position(&arrow, s, Some(&ty), w, h);
        let (x, y) = (num_or(spec, "x", pos[0]), num_or(spec, "y", pos[1]));
        let ex = existing.as_ref().map(as_obj).unwrap_or_default();
        let bound = if ty == "text" {
            let text = match &existing {
                Some(e) if e.is_text() => e.text().unwrap().text.clone(),
                _ => text_of(spec, "text").unwrap_or_default(),
            };
            let mut o = spread(&ex, spec);
            o.insert("text".into(), Value::from(text));
            o.remove("originalText");
            let mut base = opts_from(&o);
            if !o.contains_key("x") {
                base.x = x;
            }
            if !o.contains_key("y") {
                base.y = y;
            }
            let mut t = text_from(&o, base, m);
            let p = get_arrow_end_shape_position(&arrow, s, Some("text"), t.width, t.height);
            t.x = num_or(
                spec,
                "x",
                if s == StartOrEnd::End && existing.is_some() {
                    t.x
                } else {
                    p[0]
                },
            );
            t.y = num_or(spec, "y", p[1]);
            t
        } else if matches!(ty.as_str(), "rectangle" | "ellipse" | "diamond") {
            let o = spread(&ex, spec);
            let mut base = opts_from(&o);
            if !o.contains_key("x") {
                base.x = x;
            }
            if !o.contains_key("y") {
                base.y = y;
            }
            if !o.contains_key("width") {
                base.width = w;
            }
            if !o.contains_key("height") {
                base.height = h;
            }
            new_element(ElementType::parse(&ty).unwrap(), base)
        } else {
            continue;
        };
        let bid = bound.id.clone();
        add(store, bound);
        bind_binding_element(
            arrow_id,
            &bid,
            BindMode::Orbit,
            s,
            store,
            DEFAULT_ZOOM,
            None,
            true,
            true,
        );
    }
}

/// `clampLabelPositionOffEnds`: a label position on a trimmed-off stretch
/// moves as close to the end as it can while clear of it (and its head).
fn clamp_label_position_off_ends(
    arrow: &Element,
    label: &Element,
    p: f64,
    map: &dyn ElementsMap,
) -> f64 {
    if p > PRECISION && p < 1. - PRECISION {
        return p;
    }
    let len = get_path_length(arrow, map);
    let margin = |from: Point, to: Point, head: Option<Arrowhead>| {
        let [dx, dy] = vector_normalize(vector_from_point(to, from));
        (dx.abs() * label.width + dy.abs() * label.height) / 2.
            + head.map_or(0., get_arrowhead_size)
    };
    let pts = arrow.points().unwrap();
    let l = arrow.linear().unwrap();
    let min = margin(pts[0], pts[1], l.start_arrowhead) / len;
    let max = 1. - margin(pts[pts.len() - 1], pts[pts.len() - 2], l.end_arrowhead) / len;
    if min < max { clamp(p, min, max) } else { 0.5 }
}

/// `convertToExcalidrawElements`. `skeletons`: a JSON array.
pub fn convert_to_excalidraw_elements(
    skeletons: &Value,
    o: &TransformOpts,
) -> Result<Vec<Element>, String> {
    let Some(list) = skeletons.as_array() else {
        return Ok(vec![]);
    };
    let m = o.measure;
    let hooks = LabelHooks { m, inner: o.hooks };
    let mut store: Vec<Element> = vec![];
    let mut with_ids: Vec<(String, Obj)> = vec![];
    let mut old_to_new: FxHashMap<String, String> = FxHashMap::default();
    let created = get_updated_timestamp();
    for raw in list {
        let Some(sk) = raw.as_object() else { continue };
        let mut sk = sk.clone();
        let original = text_of(&sk, "id");
        if o.regenerate_ids {
            sk.insert("id".into(), Value::from(random_id()));
            sk.insert("created".into(), Value::from(created));
        }
        let Some(e) = build(&sk, m) else { continue };
        if get(&store, &e.id).is_some() {
            continue;
        }
        with_ids.push((e.id.clone(), sk));
        if let Some(orig) = original {
            old_to_new.insert(orig, e.id.clone());
        }
        store.push(e);
    }
    super::fractional_index::sync_invalid_indices(&mut store);
    // where on the arrows as given their labels' labelPosition puts them
    let snapshot = store.clone();
    let mut label_points: FxHashMap<String, Point> = FxHashMap::default();
    let mut unmeasured: Vec<(String, String)> = vec![];
    let remap = |spec: Option<&Value>,
                 old_to_new: &FxHashMap<String, String>,
                 always: bool|
     -> Option<Obj> {
        let mut s = spec?.as_object()?.clone();
        if let Some(id) = text_of(&s, "id") {
            match old_to_new.get(&id) {
                Some(n) => {
                    s.insert("id".into(), Value::from(n.clone()));
                }
                None if always => {
                    s.remove("id");
                }
                None => {}
            }
        }
        Some(s)
    };
    for (id, sk) in &with_ids {
        let ty = sk.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            ty,
            "rectangle" | "ellipse" | "diamond" | "stickynote" | "arrow"
        ) {
            continue;
        }
        let label = sk.get("label").and_then(Value::as_object).filter(|l| {
            l.get("text")
                .and_then(Value::as_str)
                .is_some_and(|t| !t.is_empty())
        });
        if let Some(label) = label {
            let tid = bind_text_to_container(&mut store, id, label, m);
            if ty != "arrow" {
                continue;
            }
            unmeasured.push((tid.clone(), id.clone()));
            let lp = get(&store, &tid)
                .and_then(|t| t.text())
                .and_then(|d| d.label_position.flatten());
            if let Some(lp) = lp
                && let Some(p) =
                    get_point_at_path_parameter(get(&snapshot, id).unwrap(), lp, &snapshot)
            {
                label_points.insert(tid, p);
            }
            let (s, e) = (
                remap(sk.get("start"), &old_to_new, false),
                remap(sk.get("end"), &old_to_new, false),
            );
            bind_linear_element_to_element(&mut store, id, s.as_ref(), e.as_ref(), m);
        } else if ty == "arrow" {
            // ids not found are dropped (upstream assigns `undefined`)
            let (s, e) = (
                remap(sk.get("start"), &old_to_new, true),
                remap(sk.get("end"), &old_to_new, true),
            );
            bind_linear_element_to_element(&mut store, id, s.as_ref(), e.as_ref(), m);
        }
    }

    // place bound arrows' ends as the editor would (before sizing frames)
    let mut scene = Scene::new(store);
    let mut unbound: FxHashMap<String, Vec<String>> = FxHashMap::default();
    let arrows: Vec<String> = scene
        .non_deleted_elements()
        .filter(|e| e.is_arrow())
        .map(|e| e.id.clone())
        .collect();
    let ends = [StartOrEnd::Start, StartOrEnd::End];
    for aid in &arrows {
        let mut extended = PointsPositionUpdates::new();
        let mut extended_points: Vec<(StartOrEnd, Point)> = vec![];
        for s in ends {
            let arrow = scene.get_element(aid).unwrap().clone();
            if !is_end_bound_beyond_binding_area(&arrow, s, &scene, DEFAULT_ZOOM) {
                continue;
            }
            if let Some(ext) = get_bound_end_extension(&arrow, s, &scene) {
                extended_points.push((s, ext));
                let i = if s == StartOrEnd::Start {
                    0
                } else {
                    arrow.points().unwrap().len() - 1
                };
                extended.insert(
                    i,
                    PointUpdate::at(point_from_absolute_coords(&arrow, ext, &scene)),
                );
                continue;
            }
            if let Some(eid) = unbind_binding_element(aid, s, &mut scene) {
                unbound.entry(eid).or_default().push(aid.clone());
            }
        }
        if !extended.is_empty() {
            let arrow = scene.get_element(aid).unwrap().clone();
            if arrow.is_elbow_arrow() {
                for s in ends {
                    let Some(b) = binding_of(&arrow, s).cloned() else {
                        continue;
                    };
                    let Some(bindable) = scene
                        .get_non_deleted_element(&b.element_id)
                        .filter(|e| e.is_bindable(true))
                        .cloned()
                    else {
                        continue;
                    };
                    match extended_points.iter().find(|(x, _)| *x == s) {
                        Some(&(_, ext)) => {
                            let fp = calculate_fixed_point_for_non_elbow_arrow_binding(
                                &arrow,
                                &bindable,
                                s,
                                &scene,
                                Some(ext),
                            );
                            bind_binding_element_to_fixed_point(
                                aid,
                                &bindable.id,
                                s,
                                fp,
                                &mut scene,
                            );
                        }
                        None => bind_binding_element(
                            aid,
                            &bindable.id,
                            b.mode,
                            s,
                            &mut scene,
                            DEFAULT_ZOOM,
                            None,
                            true,
                            true,
                        ),
                    }
                }
            }
            move_points(
                aid,
                &mut scene,
                &extended,
                None,
                &MovePointsOpts::default(),
                &hooks,
            );
        }
        // rebind against what it's bound to as sized now
        for s in ends {
            let Some(b) = scene
                .get_element(aid)
                .and_then(|a| binding_of(a, s))
                .cloned()
            else {
                continue;
            };
            if scene
                .get_non_deleted_element(&b.element_id)
                .is_some_and(|e| e.is_bindable(true))
            {
                bind_binding_element(
                    aid,
                    &b.element_id,
                    b.mode,
                    s,
                    &mut scene,
                    DEFAULT_ZOOM,
                    None,
                    true,
                    true,
                );
            }
        }
        let arrow = scene.get_element(aid).unwrap().clone();
        if !ends.iter().any(|&s| {
            binding_of(&arrow, s)
                .is_some_and(|b| scene.get_non_deleted_element(&b.element_id).is_some())
        }) {
            continue;
        }
        update_bound_arrow(aid, &mut scene, &[], &hooks, false);
        let arrow = scene.get_element(aid).unwrap().clone();
        let Some(label) = get_bound_text_element(&arrow, &scene).cloned() else {
            continue;
        };
        unmeasured.retain(|(t, _)| *t != label.id);
        if let Some(&lp) = label_points.get(&label.id)
            && let Some(p) = get_path_parameter_at_point(&arrow, lp, &scene)
        {
            let p = clamp_label_position_off_ends(&arrow, &label, p, &scene);
            scene.mutate_element(&label.id, true, |t| {
                if let Some(d) = t.text_mut() {
                    d.label_position = Some(Some(p))
                }
            });
        }
        let label = scene.get_element(&label.id).unwrap().clone();
        let [x, y] = get_bound_text_element_position(&arrow, &label, &scene);
        scene.mutate_element(&label.id, true, |t| (t.x, t.y) = (x, y));
    }
    // the labels of arrows not placed, along them as given
    for (tid, aid) in &unmeasured {
        let Some(t) = scene.get_element(tid).cloned() else {
            continue;
        };
        redraw_text_bounding_box(&mut scene, &t, Some(aid), m);
    }

    // frames, sized around their children (plus padding) unless given
    let mut store = scene.into_elements();
    for (id, sk) in &with_ids {
        if !matches!(
            sk.get("type").and_then(Value::as_str),
            Some("frame" | "magicframe")
        ) {
            continue;
        }
        let Some(frame) = get(&store, id).cloned() else {
            return Err(format!("Excalidraw element with id {id} doesn't exist"));
        };
        let mut children: Vec<String> = vec![];
        for cid in sk
            .get("children")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let Some(nid) = old_to_new.get(cid).cloned() else {
                return Err(format!("Element with {cid} wasn't mapped correctly"));
            };
            let Some(child) = get(&store, &nid).cloned() else {
                return Err(format!("Frame element with id {nid} doesn't exist"));
            };
            assign(&mut store, &nid, |e| e.frame_id = Some(frame.id.clone()));
            let mut bound: Vec<String> = child
                .bound_elements
                .iter()
                .flatten()
                .map(|b| b.id.clone())
                .collect();
            bound.extend(unbound.get(&nid).cloned().unwrap_or_default());
            for b in bound {
                if get(&store, &b).is_none() {
                    return Err(format!("Bound element with id {b} doesn't exist"));
                }
                assign(&mut store, &b, |e| e.frame_id = Some(frame.id.clone()));
                children.push(b);
            }
            children.push(nid);
        }
        let kids: Vec<&Element> = children.iter().filter_map(|c| get(&store, c)).collect();
        let [min_x, min_y, max_x, max_y] = get_common_bounds(kids.iter().copied(), &store);
        const PADDING: f64 = 10.;
        let (min_x, min_y, max_x, max_y) = (
            min_x - PADDING,
            min_y - PADDING,
            max_x + PADDING,
            max_y + PADDING,
        );
        let or = |v: f64, d: f64| if v != 0. && !v.is_nan() { v } else { d };
        assign(&mut store, id, |f| {
            (f.x, f.y, f.width, f.height) = (
                or(frame.x, min_x),
                or(frame.y, min_y),
                or(frame.width, max_x - min_x),
                or(frame.height, max_y - min_y),
            );
        });
    }
    super::fractional_index::sync_invalid_indices(&mut store);
    Ok(store)
}
