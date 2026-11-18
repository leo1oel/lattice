// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Incremental undo / redo. Port of Excalidraw @ 3a317b5
//! `packages/element/src/delta.ts` (`Delta`, `AppStateDelta`, `ElementsDelta`),
//! `packages/element/src/store.ts` (`Store`, `StoreSnapshot`, `StoreChange`,
//! `StoreDelta`, increments), `packages/excalidraw/history.ts` (`History`,
//! `HistoryDelta`) and the bound / bindable visitors of
//! `packages/element/src/binding.ts` (`BoundElement`, `BindableElement`,
//! `bindingProperties`) they use to keep bindings two-way.
//!
//! Partials are JSON objects keyed by the upstream property names (what
//! `json::element_to_value` writes), so the diffing, squashing and merging
//! rules carry over key by key. Differences from upstream:
//! - an absent property and `null` are one value in a partial (`undefined`
//!   doesn't exist in JSON); applying `null` to an optional property that
//!   is absent when unset (`customData`, `labelPosition`, unknown keys)
//!   removes it;
//! - delta records are sorted by element id (upstream: insertion order), so
//!   deltas apply in id order; the result is then sorted by fractional index
//!   as upstream does whenever the z-order may have changed;
//! - values compare deeply where upstream compares one level deep by
//!   reference; this only differs for nested values that are equal but
//!   distinct objects, which upstream reports as changed;
//! - `selectedLinearElement` stays a handle (`SelectedLinearElement`);
//!   upstream rebuilds a `LinearElementEditor` from the element;
//! - events (`Emitter`s) are return values: `Store::commit` returns the
//!   increments and the caller hands them to `History::record_increments`;
//! - errors upstream swallows in production and throws in tests can't happen
//!   here, except the redraw guard (`ApplyToOptions::guard_redraw`), which
//!   panics.
//!
//! `HistoryHooks` supplies `redrawTextBoundingBox` and `updateBoundElements`
//! at the points `ElementsDelta.redrawElements` calls them
//! (`binding::BindingHistoryHooks` for the latter).

use super::app_state::{AppState, SelectedLinearElement};
use super::binding::{BINDING_PROPERTIES, bindable_targets, bound_targets};
use super::fractional_index::{
    order_by_fractional_index, sync_invalid_indices_immutable, sync_moved_indices,
};
use super::json::element_to_value;
use super::mutate::{get_updated_timestamp, mutate_element};
use super::new_element::{ElementOpts, new_element};
use super::random::{random_id, random_integer};
use super::types::*;
use super::utils::{ElementsMap, hash_elements_version, hash_string};
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

/// A partial object: upstream property name → value.
pub type Partial = Map<String, Value>;

// ---------------------------------------------------------------------------
// ElementMap: `SceneElementsMap`
// ---------------------------------------------------------------------------

/// `SceneElementsMap`: elements by id, in insertion (scene) order. Elements
/// are shared (`Rc`), so copying a map is cheap and "same instance" checks
/// upstream does by reference are `Rc::ptr_eq`. Elements in a map are never
/// mutated in place: `set` and `mutate` put in a new instance.
#[derive(Clone, Debug, Default)]
pub struct ElementMap {
    items: Vec<Rc<Element>>,
    pos: FxHashMap<String, usize>,
}

impl ElementMap {
    pub fn new() -> ElementMap {
        ElementMap::default()
    }
    pub fn from_slice(elements: &[Element]) -> ElementMap {
        elements.iter().cloned().collect()
    }
    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    pub fn get(&self, id: &str) -> Option<&Element> {
        self.pos.get(id).map(|&i| &*self.items[i])
    }
    pub fn get_rc(&self, id: &str) -> Option<&Rc<Element>> {
        self.pos.get(id).map(|&i| &self.items[i])
    }
    pub fn contains(&self, id: &str) -> bool {
        self.pos.contains_key(id)
    }
    pub fn set(&mut self, e: Element) {
        self.set_rc(Rc::new(e))
    }
    /// Replaces the element with that id in place, or appends it.
    pub fn set_rc(&mut self, e: Rc<Element>) {
        match self.pos.get(&e.id) {
            Some(&i) => self.items[i] = e,
            None => {
                self.pos.insert(e.id.clone(), self.items.len());
                self.items.push(e);
            }
        }
    }
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &Element> + '_ {
        self.items.iter().map(|e| &**e)
    }
    pub fn iter_rc(&self) -> std::slice::Iter<'_, Rc<Element>> {
        self.items.iter()
    }
    pub fn ids(&self) -> impl Iterator<Item = &str> + '_ {
        self.items.iter().map(|e| e.id.as_str())
    }
    /// `mutateElement` on the element with `id` (a new instance when it
    /// changed). Returns whether it changed.
    pub fn mutate(&mut self, id: &str, f: impl FnOnce(&mut Element)) -> bool {
        let Some(&i) = self.pos.get(id) else {
            return false;
        };
        let mut e = (*self.items[i]).clone();
        let changed = mutate_element(&mut e, f);
        if changed {
            self.items[i] = Rc::new(e);
        }
        changed
    }
    pub fn to_vec(&self) -> Vec<Element> {
        self.iter().cloned().collect()
    }
    pub fn into_vec(self) -> Vec<Element> {
        self.items.into_iter().map(Rc::unwrap_or_clone).collect()
    }
}

impl FromIterator<Element> for ElementMap {
    fn from_iter<I: IntoIterator<Item = Element>>(it: I) -> Self {
        let mut m = ElementMap::new();
        for e in it {
            m.set(e);
        }
        m
    }
}
impl ElementsMap for ElementMap {
    fn get_element(&self, id: &str) -> Option<&Element> {
        self.get(id)
    }
    fn element_list(&self) -> Option<std::borrow::Cow<'_, [Element]>> {
        Some(self.to_vec().into())
    }
}

// ---------------------------------------------------------------------------
// element ↔ partial
// ---------------------------------------------------------------------------

/// The element as a partial, without `id` and `updated`
/// (`stripIrrelevantProps`).
pub fn element_partial(e: &Element) -> Partial {
    let Value::Object(mut m) = element_to_value(e) else {
        unreachable!()
    };
    m.remove("id");
    m.remove("updated");
    m
}

/// Values equal the way the diffing treats them: numbers by value, arrays
/// and objects deeply.
pub fn js_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| js_eq(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| js_eq(v, w)))
        }
        _ => a == b,
    }
}
fn differ(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => !js_eq(a, b),
        (None, None) => false,
        _ => true,
    }
}
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0. && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
fn is_object(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}
fn obj(p: &Partial, k: &str) -> Partial {
    p.get(k)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn f(v: &Value) -> Option<f64> {
    v.as_f64()
}
fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}
fn pt(v: &Value) -> Option<[f64; 2]> {
    let a = v.as_array()?;
    Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?])
}
fn pts(v: &Value) -> Vec<[f64; 2]> {
    v.as_array()
        .map(|a| a.iter().filter_map(pt).collect())
        .unwrap_or_default()
}
fn bound_elements_of(v: &Value) -> Option<Vec<BoundElement>> {
    v.as_array().map(|a| {
        a.iter()
            .filter_map(|b| {
                Some(BoundElement {
                    id: b.get("id")?.as_str()?.to_owned(),
                    kind: BoundType::parse(b.get("type")?.as_str()?)?,
                })
            })
            .collect()
    })
}
fn binding_of(v: &Value) -> Option<FixedPointBinding> {
    Some(FixedPointBinding {
        element_id: v.get("elementId")?.as_str()?.to_owned(),
        fixed_point: v.get("fixedPoint").and_then(pt).unwrap_or([0.5001, 0.5001]),
        mode: v
            .get("mode")
            .and_then(Value::as_str)
            .and_then(BindMode::parse)
            .unwrap_or(BindMode::Orbit),
    })
}
fn bound_elements_value(b: &[BoundElement]) -> Value {
    Value::Array(
        b.iter()
            .map(|b| json!({"id": b.id, "type": b.kind.as_str()}))
            .collect(),
    )
}

/// An empty `Kind` of the given type, for elements built from a partial.
fn default_kind(ty: ElementType) -> Kind {
    let linear = || LinearData {
        points: vec![],
        start_binding: None,
        end_binding: None,
        start_arrowhead: None,
        end_arrowhead: None,
    };
    match ty {
        ElementType::Selection => Kind::Selection,
        ElementType::Rectangle => Kind::Rectangle,
        ElementType::StickyNote => Kind::StickyNote { base_height: 0. },
        ElementType::Diamond => Kind::Diamond,
        ElementType::Ellipse => Kind::Ellipse,
        ElementType::Embeddable => Kind::Embeddable,
        ElementType::Iframe => Kind::Iframe,
        ElementType::Image => Kind::Image(ImageData {
            file_id: None,
            status: ImageStatus::Pending,
            scale: [1., 1.],
            crop: None,
        }),
        ElementType::Frame => Kind::Frame { name: None },
        ElementType::MagicFrame => Kind::MagicFrame { name: None },
        ElementType::Text => Kind::Text(TextData {
            font_size: super::consts::DEFAULT_FONT_SIZE,
            font_family: super::consts::DEFAULT_FONT_FAMILY,
            base_font_size: None,
            text: String::new(),
            text_align: TextAlign::Left,
            vertical_align: VerticalAlign::Top,
            container_id: None,
            original_text: String::new(),
            auto_resize: true,
            line_height: super::consts::DEFAULT_LINE_HEIGHT,
            label_position: None,
        }),
        ElementType::Line => Kind::Line {
            linear: linear(),
            polygon: false,
        },
        ElementType::Arrow => Kind::Arrow {
            linear: linear(),
            elbow: None,
        },
        ElementType::FreeDraw => Kind::FreeDraw(FreeDrawData {
            points: vec![],
            pressures: vec![],
            simulate_pressure: false,
            stroke_options: StrokeOptions {
                variability: StrokeVariability::Variable,
                streamline: super::consts::DEFAULT_STROKE_STREAMLINE,
            },
        }),
    }
}

/// Sets one property from its JSON value. Values of the wrong shape leave
/// the field alone; properties the element's type doesn't have go to `extra`.
fn set_key(e: &mut Element, k: &str, v: &Value) {
    let mut unknown = false;
    match k {
        "id" | "type" | "elbowed" => {}
        "x" => {
            if let Some(n) = f(v) {
                e.x = n
            }
        }
        "y" => {
            if let Some(n) = f(v) {
                e.y = n
            }
        }
        "strokeColor" => {
            if let Some(s) = v.as_str() {
                e.stroke_color = s.into()
            }
        }
        "backgroundColor" => {
            if let Some(s) = v.as_str() {
                e.background_color = s.into()
            }
        }
        "fillStyle" => {
            if let Some(s) = v.as_str().and_then(FillStyle::parse) {
                e.fill_style = s
            }
        }
        "strokeWidth" => {
            if let Some(n) = f(v) {
                e.stroke_width = n
            }
        }
        "strokeStyle" => {
            if let Some(s) = v.as_str().and_then(StrokeStyle::parse) {
                e.stroke_style = s
            }
        }
        "roundness" => {
            e.roundness = v.get("type").and_then(Value::as_u64).map(|t| Roundness {
                kind: t as u8,
                value: v.get("value").and_then(Value::as_f64),
            })
        }
        "roughness" => {
            if let Some(n) = f(v) {
                e.roughness = n
            }
        }
        "opacity" => {
            if let Some(n) = f(v) {
                e.opacity = n
            }
        }
        "width" => {
            if let Some(n) = f(v) {
                e.width = n
            }
        }
        "height" => {
            if let Some(n) = f(v) {
                e.height = n
            }
        }
        "angle" => {
            if let Some(n) = f(v) {
                e.angle = n
            }
        }
        "seed" => {
            if let Some(n) = v.as_i64() {
                e.seed = n
            }
        }
        "version" => {
            if let Some(n) = v.as_i64() {
                e.version = n
            }
        }
        "versionNonce" => {
            if let Some(n) = v.as_i64() {
                e.version_nonce = n
            }
        }
        "index" => e.index = opt_str(v),
        "isDeleted" => e.is_deleted = v.as_bool().unwrap_or(false),
        "groupIds" => {
            e.group_ids = v
                .as_array()
                .map(|a| a.iter().filter_map(opt_str).collect())
                .unwrap_or_default()
        }
        "frameId" => e.frame_id = opt_str(v),
        "boundElements" => e.bound_elements = bound_elements_of(v),
        "updated" => {
            if let Some(n) = v.as_i64() {
                e.updated = n
            }
        }
        "created" => e.created = v.as_i64(),
        "link" => e.link = opt_str(v),
        "locked" => e.locked = v.as_bool().unwrap_or(false),
        "customData" => e.custom_data = if v.is_null() { None } else { Some(v.clone()) },
        _ => match (&mut e.kind, k) {
            (Kind::StickyNote { base_height }, "baseHeight") => {
                if let Some(n) = f(v) {
                    *base_height = n
                }
            }
            (Kind::Image(i), "fileId") => i.file_id = opt_str(v),
            (Kind::Image(i), "status") => {
                if let Some(s) = v.as_str().and_then(ImageStatus::parse) {
                    i.status = s
                }
            }
            (Kind::Image(i), "scale") => {
                if let Some(p) = pt(v) {
                    i.scale = p
                }
            }
            (Kind::Image(i), "crop") => {
                i.crop = (|| {
                    Some(ImageCrop {
                        x: v.get("x")?.as_f64()?,
                        y: v.get("y")?.as_f64()?,
                        width: v.get("width")?.as_f64()?,
                        height: v.get("height")?.as_f64()?,
                        natural_width: v.get("naturalWidth")?.as_f64()?,
                        natural_height: v.get("naturalHeight")?.as_f64()?,
                    })
                })()
            }
            (Kind::Frame { name } | Kind::MagicFrame { name }, "name") => *name = opt_str(v),
            (Kind::Text(t), "fontSize") => {
                if let Some(n) = f(v) {
                    t.font_size = n
                }
            }
            (Kind::Text(t), "fontFamily") => {
                if let Some(n) = v.as_u64() {
                    t.font_family = n as u32
                }
            }
            (Kind::Text(t), "baseFontSize") => t.base_font_size = f(v),
            (Kind::Text(t), "text") => {
                if let Some(s) = v.as_str() {
                    t.text = s.into()
                }
            }
            (Kind::Text(t), "textAlign") => {
                if let Some(s) = v.as_str().and_then(TextAlign::parse) {
                    t.text_align = s
                }
            }
            (Kind::Text(t), "verticalAlign") => {
                if let Some(s) = v.as_str().and_then(VerticalAlign::parse) {
                    t.vertical_align = s
                }
            }
            (Kind::Text(t), "containerId") => t.container_id = opt_str(v),
            (Kind::Text(t), "originalText") => {
                if let Some(s) = v.as_str() {
                    t.original_text = s.into()
                }
            }
            (Kind::Text(t), "autoResize") => t.auto_resize = v.as_bool().unwrap_or(true),
            (Kind::Text(t), "lineHeight") => {
                if let Some(n) = f(v) {
                    t.line_height = n
                }
            }
            (Kind::Text(t), "labelPosition") => {
                t.label_position = if v.is_null() { None } else { Some(f(v)) }
            }
            (Kind::Line { linear, .. } | Kind::Arrow { linear, .. }, "points") => {
                linear.points = pts(v)
            }
            (Kind::Line { linear, .. } | Kind::Arrow { linear, .. }, "startBinding") => {
                linear.start_binding = binding_of(v)
            }
            (Kind::Line { linear, .. } | Kind::Arrow { linear, .. }, "endBinding") => {
                linear.end_binding = binding_of(v)
            }
            (Kind::Line { linear, .. } | Kind::Arrow { linear, .. }, "startArrowhead") => {
                linear.start_arrowhead = v.as_str().and_then(Arrowhead::parse)
            }
            (Kind::Line { linear, .. } | Kind::Arrow { linear, .. }, "endArrowhead") => {
                linear.end_arrowhead = v.as_str().and_then(Arrowhead::parse)
            }
            (Kind::Line { polygon, .. }, "polygon") => *polygon = v.as_bool().unwrap_or(false),
            (
                Kind::Arrow {
                    elbow: Some(el), ..
                },
                "fixedSegments",
            ) => {
                el.fixed_segments = v.as_array().map(|a| {
                    a.iter()
                        .filter_map(|s| {
                            Some(FixedSegment {
                                start: pt(s.get("start")?)?,
                                end: pt(s.get("end")?)?,
                                index: s.get("index")?.as_u64()? as usize,
                            })
                        })
                        .collect()
                })
            }
            (
                Kind::Arrow {
                    elbow: Some(el), ..
                },
                "startIsSpecial",
            ) => el.start_is_special = v.as_bool(),
            (
                Kind::Arrow {
                    elbow: Some(el), ..
                },
                "endIsSpecial",
            ) => el.end_is_special = v.as_bool(),
            (Kind::FreeDraw(d), "points") => d.points = pts(v),
            (Kind::FreeDraw(d), "pressures") => {
                d.pressures = v
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_f64).collect())
                    .unwrap_or_default()
            }
            (Kind::FreeDraw(d), "simulatePressure") => {
                d.simulate_pressure = v.as_bool().unwrap_or(false)
            }
            (Kind::FreeDraw(d), "strokeOptions") => {
                if let Some(s) = v
                    .get("variability")
                    .and_then(Value::as_str)
                    .and_then(StrokeVariability::parse)
                {
                    d.stroke_options.variability = s
                }
                if let Some(n) = v.get("streamline").and_then(Value::as_f64) {
                    d.stroke_options.streamline = n
                }
            }
            _ => unknown = true,
        },
    }
    if unknown {
        if v.is_null() {
            e.extra.remove(k);
        } else {
            e.extra.insert(k.into(), v.clone());
        }
    }
}

/// `{...element, ...partial}`: `type` first (a new type starts from an empty
/// `Kind`), then `elbowed`, then the rest.
pub fn apply_partial(e: &mut Element, p: &Partial) {
    if let Some(ty) = p
        .get("type")
        .and_then(Value::as_str)
        .and_then(ElementType::parse)
        && ty != e.ty()
    {
        e.kind = default_kind(ty);
    }
    if let (Some(b), Kind::Arrow { elbow, .. }) =
        (p.get("elbowed").and_then(Value::as_bool), &mut e.kind)
        && b != elbow.is_some()
    {
        *elbow = if b { Some(ElbowData::default()) } else { None };
    }
    for (k, v) in p {
        set_key(e, k, v);
    }
}

/// `newElementWith` (`mutate: false`) and `mutateElement` (`mutate: true`)
/// with a partial: None when nothing changed (and not `force`d). Object
/// values count as a change, as upstream; `mutate` compares `scale` and
/// `points` by value (points from the last one down to the second).
/// `version` / `versionNonce` come from the updates or are bumped.
pub fn apply_updates(
    el: &Element,
    updates: &Partial,
    force: bool,
    mutate: bool,
) -> Option<Element> {
    let cur = element_partial(el);
    let mut did_change = false;
    for (k, v) in updates {
        let c = cur.get(k.as_str());
        let same = c.is_some_and(|c| js_eq(c, v));
        if same && !is_object(Some(v)) {
            continue;
        }
        if mutate && same && k == "scale" {
            continue;
        }
        if mutate
            && k == "points"
            && let (Some(Value::Array(a)), Value::Array(b)) = (c, v)
            && a.len() == b.len()
            && (1..a.len()).rev().all(|i| js_eq(&a[i], &b[i]))
        {
            continue;
        }
        did_change = true;
    }
    if !did_change && !force {
        return None;
    }
    let mut n = el.clone();
    apply_partial(&mut n, updates);
    n.version = updates
        .get("version")
        .and_then(Value::as_i64)
        .unwrap_or(el.version + 1);
    n.version_nonce = updates
        .get("versionNonce")
        .and_then(Value::as_i64)
        .unwrap_or_else(random_integer);
    n.updated = get_updated_timestamp();
    Some(n)
}

fn new_element_with(el: &Element, updates: &Partial, force: bool) -> Element {
    apply_updates(el, updates, force, false).unwrap_or_else(|| el.clone())
}

// ---------------------------------------------------------------------------
// Delta
// ---------------------------------------------------------------------------

/// `Delta<T>`: `deleted` holds the previous values of the changed
/// properties, `inserted` the new ones.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Delta {
    pub deleted: Partial,
    pub inserted: Partial,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Join {
    Left,
    Right,
    Inner,
    Full,
}

/// Keys whose values differ, sorted (`distinctKeysIterator`).
fn distinct_keys(join: Join, a: &Partial, b: &Partial) -> Vec<String> {
    let keys: Vec<&String> = match join {
        Join::Left => a.keys().collect(),
        Join::Right => b.keys().collect(),
        Join::Inner => a.keys().filter(|k| b.contains_key(*k)).collect(),
        Join::Full => a
            .keys()
            .chain(b.keys().filter(|k| !a.contains_key(*k)))
            .collect(),
    };
    let mut out: Vec<String> = keys
        .into_iter()
        .filter(|k| differ(a.get(*k), b.get(*k)))
        .cloned()
        .collect();
    out.sort();
    out
}

impl Delta {
    pub fn new(deleted: Partial, inserted: Partial) -> Delta {
        Delta { deleted, inserted }
    }
    /// From two JSON objects (anything else counts as empty).
    pub fn from_json(deleted: Value, inserted: Value) -> Delta {
        let o = |v: Value| {
            if let Value::Object(m) = v {
                m
            } else {
                Partial::new()
            }
        };
        Delta {
            deleted: o(deleted),
            inserted: o(inserted),
        }
    }
    /// `Delta.calculate`: the differing properties, then `post` (which may
    /// narrow reference values down to their real difference).
    pub fn calculate(
        prev: &Partial,
        next: &Partial,
        post: Option<fn(&mut Partial, &mut Partial)>,
    ) -> Delta {
        let mut d = Delta::default();
        for k in distinct_keys(Join::Full, prev, next) {
            d.deleted
                .insert(k.clone(), prev.get(&k).cloned().unwrap_or(Value::Null));
            d.inserted
                .insert(k.clone(), next.get(&k).cloned().unwrap_or(Value::Null));
        }
        if let Some(post) = post {
            post(&mut d.deleted, &mut d.inserted);
        }
        d
    }
    pub fn is_empty(&self) -> bool {
        self.deleted.is_empty() && self.inserted.is_empty()
    }
    /// `Delta.merge`: later partials win.
    pub fn merge(d1: &Delta, d2: &Delta, d3: Option<&Delta>) -> Delta {
        let mut d = d1.clone();
        for x in [Some(d2), d3].into_iter().flatten() {
            d.deleted.extend(x.deleted.clone());
            d.inserted.extend(x.inserted.clone());
        }
        d
    }
    /// `Delta.mergeObjects`: `prev` without the `removed` keys, plus `added`.
    pub fn merge_objects(prev: &Partial, added: &Partial, removed: &Partial) -> Partial {
        let mut m = prev.clone();
        for k in removed.keys() {
            m.remove(k);
        }
        m.extend(added.clone());
        m
    }
    /// `Delta.mergeArrays`, grouping by `key`; keeps first-seen order.
    pub fn merge_arrays(
        prev: &[Value],
        added: &[Value],
        removed: &[Value],
        key: fn(&Value) -> String,
    ) -> Vec<Value> {
        let mut out: Vec<(String, Value)> = vec![];
        let put = |out: &mut Vec<(String, Value)>, v: &Value| {
            let k = key(v);
            match out.iter_mut().find(|(x, _)| *x == k) {
                Some(slot) => slot.1 = v.clone(),
                None => out.push((k, v.clone())),
            }
        };
        for v in prev {
            put(&mut out, v);
        }
        let removed: FxHashSet<String> = removed.iter().map(key).collect();
        out.retain(|(k, _)| !removed.contains(k));
        for v in added {
            put(&mut out, v);
        }
        out.into_iter().map(|(_, v)| v).collect()
    }
    /// `Delta.diffObjects`: narrows an object-valued property to the keys
    /// that differ, each mapped through `set_value`.
    pub fn diff_objects(
        deleted: &mut Partial,
        inserted: &mut Partial,
        prop: &str,
        set_value: fn(Option<&Value>) -> Value,
    ) {
        if !truthy(deleted.get(prop)) && !truthy(inserted.get(prop)) {
            return;
        }
        let (d_obj, i_obj) = (is_object(deleted.get(prop)), is_object(inserted.get(prop)));
        if d_obj || i_obj {
            let (d, i) = (obj(deleted, prop), obj(inserted, prop));
            let dd: Partial = distinct_keys(Join::Left, &d, &i)
                .into_iter()
                .map(|k| {
                    let v = set_value(d.get(&k));
                    (k, v)
                })
                .collect();
            let id: Partial = distinct_keys(Join::Right, &d, &i)
                .into_iter()
                .map(|k| {
                    let v = set_value(i.get(&k));
                    (k, v)
                })
                .collect();
            if !dd.is_empty() || !id.is_empty() {
                deleted.insert(prop.into(), Value::Object(dd));
                inserted.insert(prop.into(), Value::Object(id));
            } else {
                deleted.remove(prop);
                inserted.remove(prop);
            }
        } else if !differ(deleted.get(prop), inserted.get(prop)) {
            deleted.remove(prop);
            inserted.remove(prop);
        }
    }
    /// `Delta.diffArrays`: narrows an array-valued property to the items
    /// (grouped by `key`) that differ.
    pub fn diff_arrays(
        deleted: &mut Partial,
        inserted: &mut Partial,
        prop: &str,
        key: fn(&Value) -> String,
    ) {
        if !truthy(deleted.get(prop)) && !truthy(inserted.get(prop)) {
            return;
        }
        let arr = |p: &Partial| p.get(prop).and_then(Value::as_array).cloned();
        let (da, ia) = (arr(deleted), arr(inserted));
        if da.is_none() && ia.is_none() {
            return;
        }
        let (da, ia) = (da.unwrap_or_default(), ia.unwrap_or_default());
        let by_key = |a: &[Value]| -> Partial { a.iter().map(|v| (key(v), v.clone())).collect() };
        let (dobj, iobj) = (by_key(&da), by_key(&ia));
        let dd: FxHashSet<String> = distinct_keys(Join::Left, &dobj, &iobj)
            .into_iter()
            .collect();
        let id: FxHashSet<String> = distinct_keys(Join::Right, &dobj, &iobj)
            .into_iter()
            .collect();
        if !dd.is_empty() || !id.is_empty() {
            deleted.insert(
                prop.into(),
                Value::Array(da.into_iter().filter(|v| dd.contains(&key(v))).collect()),
            );
            inserted.insert(
                prop.into(),
                Value::Array(ia.into_iter().filter(|v| id.contains(&key(v))).collect()),
            );
        } else {
            deleted.remove(prop);
            inserted.remove(prop);
        }
    }
    pub fn is_left_different(a: &Partial, b: &Partial) -> bool {
        !distinct_keys(Join::Left, a, b).is_empty()
    }
    pub fn is_right_different(a: &Partial, b: &Partial) -> bool {
        !distinct_keys(Join::Right, a, b).is_empty()
    }
    pub fn is_inner_different(a: &Partial, b: &Partial) -> bool {
        !distinct_keys(Join::Inner, a, b).is_empty()
    }
    pub fn is_different(a: &Partial, b: &Partial) -> bool {
        !distinct_keys(Join::Full, a, b).is_empty()
    }
    pub fn get_left_differences(a: &Partial, b: &Partial) -> Vec<String> {
        distinct_keys(Join::Left, a, b)
    }
    pub fn get_right_differences(a: &Partial, b: &Partial) -> Vec<String> {
        distinct_keys(Join::Right, a, b)
    }
    pub fn get_inner_differences(a: &Partial, b: &Partial) -> Vec<String> {
        distinct_keys(Join::Inner, a, b)
    }
    pub fn get_differences(a: &Partial, b: &Partial) -> Vec<String> {
        distinct_keys(Join::Full, a, b)
    }
    fn inverse(&self) -> Delta {
        Delta {
            deleted: self.inserted.clone(),
            inserted: self.deleted.clone(),
        }
    }
}

fn id_key(v: &Value) -> String {
    v.get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

// ---------------------------------------------------------------------------
// AppStateDelta
// ---------------------------------------------------------------------------

/// `ObservedAppState`: the app state the store records, and so what undo
/// restores. `name` and `viewBackgroundColor` are "standalone"; the rest
/// refer to elements and are dropped when those are gone.
#[derive(Clone, Debug, PartialEq)]
pub struct ObservedAppState {
    pub name: Option<String>,
    pub view_background_color: String,
    pub editing_group_id: Option<String>,
    pub selected_element_ids: BTreeSet<String>,
    pub selected_group_ids: BTreeMap<String, bool>,
    pub selected_linear_element: Option<SelectedLinearElement>,
    pub cropping_element_id: Option<String>,
    pub locked_multi_selections: BTreeSet<String>,
    pub active_locked_id: Option<String>,
}

impl Default for ObservedAppState {
    /// `getDefaultObservedAppState`.
    fn default() -> Self {
        ObservedAppState {
            name: None,
            view_background_color: super::consts::COLOR_WHITE.into(),
            editing_group_id: None,
            selected_element_ids: BTreeSet::new(),
            selected_group_ids: BTreeMap::new(),
            selected_linear_element: None,
            cropping_element_id: None,
            locked_multi_selections: BTreeSet::new(),
            active_locked_id: None,
        }
    }
}

const ELEMENTS_PROPS: [&str; 7] = [
    "activeLockedId",
    "croppingElementId",
    "editingGroupId",
    "lockedMultiSelections",
    "selectedElementIds",
    "selectedGroupIds",
    "selectedLinearElement",
];

fn opt_value(v: &Option<String>) -> Value {
    v.as_ref().map_or(Value::Null, |s| Value::String(s.clone()))
}
fn true_set(s: &BTreeSet<String>) -> Value {
    Value::Object(s.iter().map(|k| (k.clone(), Value::Bool(true))).collect())
}

impl ObservedAppState {
    /// `getObservedAppState`.
    pub fn from_app(a: &AppState) -> ObservedAppState {
        ObservedAppState {
            name: a.name.clone(),
            view_background_color: a.view_background_color.clone(),
            editing_group_id: a.editing_group_id.clone(),
            selected_element_ids: a.selected_element_ids.clone(),
            selected_group_ids: a.selected_group_ids.clone(),
            selected_linear_element: a.selected_linear_element.clone(),
            cropping_element_id: a.cropping_element_id.clone(),
            locked_multi_selections: a.locked_multi_selections.clone(),
            active_locked_id: a.active_locked_id.clone(),
        }
    }
    pub fn to_partial(&self) -> Partial {
        let mut m = Partial::new();
        m.insert("name".into(), opt_value(&self.name));
        m.insert(
            "viewBackgroundColor".into(),
            Value::String(self.view_background_color.clone()),
        );
        m.insert("editingGroupId".into(), opt_value(&self.editing_group_id));
        m.insert(
            "selectedElementIds".into(),
            true_set(&self.selected_element_ids),
        );
        m.insert(
            "selectedGroupIds".into(),
            Value::Object(
                self.selected_group_ids
                    .iter()
                    .map(|(k, v)| (k.clone(), Value::Bool(*v)))
                    .collect(),
            ),
        );
        m.insert(
            "selectedLinearElement".into(),
            self.selected_linear_element.as_ref().map_or(
                Value::Null,
                |s| json!({"elementId": s.element_id, "isEditing": s.is_editing}),
            ),
        );
        m.insert(
            "croppingElementId".into(),
            opt_value(&self.cropping_element_id),
        );
        m.insert(
            "lockedMultiSelections".into(),
            true_set(&self.locked_multi_selections),
        );
        m.insert("activeLockedId".into(), opt_value(&self.active_locked_id));
        m
    }
    /// `{...this, ...partial}` for observed keys.
    pub fn apply_partial(&mut self, p: &Partial) {
        let keys = |v: &Value| -> BTreeSet<String> {
            v.as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default()
        };
        for (k, v) in p {
            match k.as_str() {
                "name" => self.name = opt_str(v),
                "viewBackgroundColor" => {
                    if let Some(s) = v.as_str() {
                        self.view_background_color = s.into()
                    }
                }
                "editingGroupId" => self.editing_group_id = opt_str(v),
                "selectedElementIds" => self.selected_element_ids = keys(v),
                "selectedGroupIds" => {
                    self.selected_group_ids = v
                        .as_object()
                        .map(|o| {
                            o.iter()
                                .map(|(k, b)| (k.clone(), b.as_bool().unwrap_or(false)))
                                .collect()
                        })
                        .unwrap_or_default()
                }
                "selectedLinearElement" => self.selected_linear_element = linear_handle(v),
                "croppingElementId" => self.cropping_element_id = opt_str(v),
                "lockedMultiSelections" => self.locked_multi_selections = keys(v),
                "activeLockedId" => self.active_locked_id = opt_str(v),
                _ => {}
            }
        }
    }
}

fn linear_handle(v: &Value) -> Option<SelectedLinearElement> {
    Some(SelectedLinearElement {
        element_id: v.get("elementId")?.as_str()?.into(),
        is_editing: v.get("isEditing").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// `AppStateDelta`.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct AppStateDelta {
    pub delta: Delta,
}

impl AppStateDelta {
    pub fn new(delta: Delta) -> AppStateDelta {
        AppStateDelta { delta }
    }
    pub fn empty() -> AppStateDelta {
        AppStateDelta::default()
    }
    pub fn calculate(prev: &ObservedAppState, next: &ObservedAppState) -> AppStateDelta {
        AppStateDelta {
            delta: Delta::calculate(
                &prev.to_partial(),
                &next.to_partial(),
                Some(Self::post_process),
            ),
        }
    }
    pub fn inverse(&self) -> AppStateDelta {
        AppStateDelta {
            delta: self.delta.inverse(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.delta.is_empty()
    }

    /// `squash`: later values win; the id maps are merged.
    pub fn squash(&mut self, other: &AppStateDelta) -> &mut Self {
        if other.is_empty() {
            return self;
        }
        let (mut md, mut mi) = (Partial::new(), Partial::new());
        for k in [
            "selectedElementIds",
            "selectedGroupIds",
            "lockedMultiSelections",
        ] {
            let d = Delta::merge_objects(
                &obj(&self.delta.deleted, k),
                &obj(&other.delta.deleted, k),
                &Partial::new(),
            );
            let i = Delta::merge_objects(
                &obj(&self.delta.inserted, k),
                &obj(&other.delta.inserted, k),
                &Partial::new(),
            );
            if !d.is_empty() || !i.is_empty() {
                md.insert(k.into(), Value::Object(d));
                mi.insert(k.into(), Value::Object(i));
            }
        }
        self.delta = Delta::merge(&self.delta, &other.delta, Some(&Delta::new(md, mi)));
        self
    }

    /// `applyTo`: the next app state, and whether the change is visible
    /// (state referring only to deleted elements is dropped and isn't).
    pub fn apply_to(&self, app: &AppState, next_elements: &ElementMap) -> (AppState, bool) {
        let (d, ins) = (&self.delta.deleted, &self.delta.inserted);
        let set_of = |s: &BTreeSet<String>| -> Partial {
            s.iter().map(|k| (k.clone(), Value::Bool(true))).collect()
        };
        let sel = Delta::merge_objects(
            &set_of(&app.selected_element_ids),
            &obj(ins, "selectedElementIds"),
            &obj(d, "selectedElementIds"),
        );
        let groups_prev: Partial = app
            .selected_group_ids
            .iter()
            .map(|(k, v)| (k.clone(), Value::Bool(*v)))
            .collect();
        let groups = Delta::merge_objects(
            &groups_prev,
            &obj(ins, "selectedGroupIds"),
            &obj(d, "selectedGroupIds"),
        );
        let locked = Delta::merge_objects(
            &set_of(&app.locked_multi_selections),
            &obj(ins, "lockedMultiSelections"),
            &obj(d, "lockedMultiSelections"),
        );
        let mut next = app.clone();
        for (k, v) in ins {
            match k.as_str() {
                "name" => next.name = opt_str(v),
                "viewBackgroundColor" => {
                    if let Some(s) = v.as_str() {
                        next.view_background_color = s.into()
                    }
                }
                "editingGroupId" => next.editing_group_id = opt_str(v),
                "croppingElementId" => next.cropping_element_id = opt_str(v),
                "activeLockedId" => next.active_locked_id = opt_str(v),
                _ => {}
            }
        }
        next.selected_element_ids = sel.keys().cloned().collect();
        next.selected_group_ids = groups
            .iter()
            .map(|(k, v)| (k.clone(), v.as_bool().unwrap_or(false)))
            .collect();
        next.locked_multi_selections = locked.keys().cloned().collect();
        if let Some(v) = ins.get("selectedLinearElement") {
            next.selected_linear_element =
                linear_handle(v).filter(|h| next_elements.contains(&h.element_id));
        }
        let visible = Self::filter_invisible_changes(app, &mut next, next_elements);
        (next, visible)
    }

    /// `filterInvisibleChanges`: drops element-related state that points at
    /// deleted elements; true if a visible difference remains.
    fn filter_invisible_changes(
        prev: &AppState,
        next: &mut AppState,
        elements: &ElementMap,
    ) -> bool {
        let (p, n) = (
            ObservedAppState::from_app(prev).to_partial(),
            ObservedAppState::from_app(next).to_partial(),
        );
        let split = |m: &Partial, elements_props: bool| -> Partial {
            m.iter()
                .filter(|(k, _)| ELEMENTS_PROPS.contains(&k.as_str()) == elements_props)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };
        let standalone = Delta::is_right_different(&split(&p, false), &split(&n, false));
        let changed = Delta::get_right_differences(&split(&p, true), &split(&n, true));
        if !standalone && changed.is_empty() {
            return false;
        }
        let mut visible = standalone;
        let alive = |id: &str| elements.get(id).is_some_and(|e| !e.is_deleted);
        let group_ids: FxHashSet<String> = if changed
            .iter()
            .any(|k| k == "editingGroupId" || k == "selectedGroupIds")
        {
            elements
                .iter()
                .filter(|e| !e.is_deleted)
                .flat_map(|e| e.group_ids.iter().cloned())
                .collect()
        } else {
            FxHashSet::default()
        };
        for key in &changed {
            match key.as_str() {
                "selectedElementIds" => {
                    if next.selected_element_ids.is_empty() {
                        visible = true;
                    } else {
                        next.selected_element_ids.retain(|id| {
                            let a = alive(id);
                            visible |= a;
                            a
                        });
                    }
                }
                "selectedGroupIds" => {
                    if next.selected_group_ids.is_empty() {
                        visible = true;
                    } else {
                        next.selected_group_ids.retain(|id, _| {
                            let a = group_ids.contains(id);
                            visible |= a;
                            a
                        });
                    }
                }
                "croppingElementId" => match &next.cropping_element_id {
                    None => visible = true,
                    Some(id) => {
                        if alive(id) {
                            visible = true
                        } else {
                            next.cropping_element_id = None
                        }
                    }
                },
                "editingGroupId" => match &next.editing_group_id {
                    None => visible = true,
                    Some(id) => {
                        if group_ids.contains(id) {
                            visible = true
                        } else {
                            next.editing_group_id = None
                        }
                    }
                },
                "selectedLinearElement" => match &next.selected_linear_element {
                    None => visible = true,
                    Some(h) => {
                        if alive(&h.element_id) {
                            visible = true
                        } else {
                            next.selected_linear_element = None
                        }
                    }
                },
                "lockedMultiSelections"
                    if prev.locked_multi_selections != next.locked_multi_selections =>
                {
                    visible = true
                }
                "activeLockedId" if prev.active_locked_id != next.active_locked_id => {
                    visible = true
                }
                _ => {}
            }
        }
        visible
    }

    fn post_process(deleted: &mut Partial, inserted: &mut Partial) {
        Delta::diff_objects(deleted, inserted, "selectedElementIds", |_| {
            Value::Bool(true)
        });
        Delta::diff_objects(deleted, inserted, "selectedGroupIds", |v| {
            v.cloned()
                .filter(|v| !v.is_null())
                .unwrap_or(Value::Bool(false))
        });
        Delta::diff_objects(deleted, inserted, "lockedMultiSelections", |v| {
            v.cloned()
                .filter(|v| !v.is_null())
                .unwrap_or(Value::Object(Partial::new()))
        });
    }
}

// ---------------------------------------------------------------------------
// hooks for modules not ported yet
// ---------------------------------------------------------------------------

/// Layout that applying a delta triggers (`ElementsDelta.redrawElements`),
/// supplied by the text and binding modules once they exist. Implementations
/// change elements through `ElementMap::mutate` (which bumps versions; the
/// redraw guard relies on that) and may only touch the elements named and
/// what is bound to them.
pub trait HistoryHooks {
    /// `redrawTextBoundingBox(boundText, container, scene)`: re-lay out a
    /// container's label (both alive).
    fn redraw_text_bounding_box(
        &mut self,
        _text_id: &str,
        _container_id: &str,
        _elements: &mut ElementMap,
    ) {
    }
    /// `updateBoundElements(element, scene, { changedElements })`: re-route
    /// the arrows bound to a changed bindable element (and their labels).
    fn update_bound_elements(
        &mut self,
        _element_id: &str,
        _elements: &mut ElementMap,
        _changed: &FxHashSet<String>,
    ) {
    }
}

/// No layout: deltas apply as recorded.
pub struct NoHooks;
impl HistoryHooks for NoHooks {}

// ---------------------------------------------------------------------------
// ElementsDelta
// ---------------------------------------------------------------------------

/// `ApplyToOptions`.
#[derive(Clone, Debug)]
pub struct ApplyToOptions {
    /// Properties not to apply (history: `version`, `versionNonce`, so undo
    /// is a new version, not a return to the old one).
    pub excluded_properties: Vec<String>,
    /// Panic when the redraw changed an element outside the set compared for
    /// visibility (upstream throws in dev / tests). Default: debug builds.
    pub guard_redraw: bool,
}
// not derivable in debug builds
#[allow(clippy::derivable_impls)]
impl Default for ApplyToOptions {
    fn default() -> Self {
        ApplyToOptions {
            excluded_properties: vec![],
            guard_redraw: cfg!(debug_assertions),
        }
    }
}
impl ApplyToOptions {
    pub fn history() -> Self {
        ApplyToOptions {
            excluded_properties: vec!["version".into(), "versionNonce".into()],
            ..Default::default()
        }
    }
}

/// `ElementsDelta`: per element id, a delta that adds (un-deletes), removes
/// (deletes) or updates it.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ElementsDelta {
    pub added: BTreeMap<String, Delta>,
    pub removed: BTreeMap<String, Delta>,
    pub updated: BTreeMap<String, Delta>,
}

#[derive(Default)]
struct Flags {
    visible: bool,
    zindex: bool,
    forward: Option<bool>,
}

fn deleted_flag(p: &Partial) -> Option<bool> {
    p.get("isDeleted").and_then(Value::as_bool)
}
fn satisfies_addition(d: &Delta) -> bool {
    deleted_flag(&d.deleted) == Some(true) && deleted_flag(&d.inserted) != Some(true)
}
fn satisfies_removal(d: &Delta) -> bool {
    deleted_flag(&d.deleted) != Some(true) && deleted_flag(&d.inserted) == Some(true)
}
fn satisfies_update(d: &Delta) -> bool {
    (deleted_flag(&d.deleted) == Some(true)) == (deleted_flag(&d.inserted) == Some(true))
}

impl ElementsDelta {
    pub fn empty() -> ElementsDelta {
        ElementsDelta::default()
    }

    /// `ElementsDelta.create`. `redistribute` sorts the deltas into added /
    /// removed / updated by their `isDeleted` values. Invariants are checked
    /// in debug builds.
    pub fn create(
        added: BTreeMap<String, Delta>,
        removed: BTreeMap<String, Delta>,
        updated: BTreeMap<String, Delta>,
        redistribute: bool,
    ) -> ElementsDelta {
        let d = if redistribute {
            let mut d = ElementsDelta::default();
            for (id, delta) in added.into_iter().chain(removed).chain(updated) {
                if satisfies_addition(&delta) {
                    d.added.insert(id, delta);
                } else if satisfies_removal(&delta) {
                    d.removed.insert(id, delta);
                } else {
                    d.updated.insert(id, delta);
                }
            }
            d
        } else {
            ElementsDelta {
                added,
                removed,
                updated,
            }
        };
        if cfg!(debug_assertions) {
            d.validate();
        }
        d
    }

    /// Panics on a broken invariant (`validate`).
    pub fn validate(&self) {
        let common = |d: &Delta| {
            let (a, b) = (
                d.deleted.get("version").and_then(Value::as_i64),
                d.inserted.get("version").and_then(Value::as_i64),
            );
            matches!((a, b), (Some(a), Some(b)) if a >= 0 && b >= 0 && a != b)
        };
        for (kind, map, special) in [
            (
                "added",
                &self.added,
                satisfies_addition as fn(&Delta) -> bool,
            ),
            ("removed", &self.removed, satisfies_removal),
            ("updated", &self.updated, satisfies_update),
        ] {
            for (id, d) in map {
                let unique = [&self.added, &self.removed, &self.updated]
                    .iter()
                    .filter(|m| m.contains_key(id))
                    .count()
                    == 1;
                assert!(
                    common(d) && unique && special(d),
                    "ElementsDelta invariant broken for element \"{id}\" ({kind}): {d:?}"
                );
            }
        }
    }

    /// `ElementsDelta.calculate`.
    pub fn calculate(prev: &ElementMap, next: &ElementMap) -> ElementsDelta {
        let (mut added, mut removed, mut updated) =
            (BTreeMap::new(), BTreeMap::new(), BTreeMap::new());
        for p in prev.iter() {
            if next.contains(&p.id) {
                continue;
            }
            let mut inserted = Partial::new();
            inserted.insert("isDeleted".into(), Value::Bool(true));
            inserted.insert("version".into(), json!(p.version + 1));
            inserted.insert("versionNonce".into(), json!(random_integer()));
            let d = Delta::new(element_partial(p), inserted);
            if !p.is_deleted {
                removed.insert(p.id.clone(), d);
            } else {
                updated.insert(p.id.clone(), d);
            }
        }
        for n in next.iter() {
            let Some(p) = prev.get(&n.id) else {
                let mut deleted = Partial::new();
                deleted.insert("isDeleted".into(), Value::Bool(true));
                deleted.insert("version".into(), json!(n.version - 1));
                deleted.insert("versionNonce".into(), json!(random_integer()));
                let d = Delta::new(deleted, element_partial(n));
                if !n.is_deleted {
                    added.insert(n.id.clone(), d);
                } else {
                    updated.insert(n.id.clone(), d);
                }
                continue;
            };
            if p.version_nonce != n.version_nonce {
                let d = Delta::calculate(
                    &element_partial(p),
                    &element_partial(n),
                    Some(Self::post_process),
                );
                if p.is_deleted != n.is_deleted {
                    if p.is_deleted {
                        added.insert(n.id.clone(), d);
                    } else {
                        removed.insert(n.id.clone(), d);
                    }
                    continue;
                }
                updated.insert(n.id.clone(), d);
            }
        }
        ElementsDelta::create(added, removed, updated, false)
    }

    /// `inverse`: removed and added swap.
    pub fn inverse(&self) -> ElementsDelta {
        let inv =
            |m: &BTreeMap<String, Delta>| m.iter().map(|(k, d)| (k.clone(), d.inverse())).collect();
        ElementsDelta::create(
            inv(&self.removed),
            inv(&self.added),
            inv(&self.updated),
            false,
        )
    }

    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.updated.is_empty()
    }

    /// `applyLatestChanges`: the delta with its values replaced by the
    /// elements' current ones (`deleted` from `prev`, `inserted` from `next`,
    /// or only the side `modifier` names); `boundElements` keeps its diff.
    /// Deltas left without differences are dropped.
    pub fn apply_latest_changes(
        &self,
        prev: &ElementMap,
        next: &ElementMap,
        modifier: Option<StartOrEndSide>,
    ) -> ElementsDelta {
        let latest = |partial: &Partial, e: Option<&Element>| -> Partial {
            let Some(e) = e else { return partial.clone() };
            let cur = element_partial(e);
            partial
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if k == "boundElements" {
                            v.clone()
                        } else {
                            cur.get(k).cloned().unwrap_or(Value::Null)
                        },
                    )
                })
                .collect()
        };
        let modify = |m: &BTreeMap<String, Delta>| -> BTreeMap<String, Delta> {
            let mut out = BTreeMap::new();
            for (id, d) in m {
                let (p, n) = (prev.get(id), next.get(id));
                let d2 = if p.is_some() || n.is_some() {
                    Delta::new(
                        if modifier != Some(StartOrEndSide::Inserted) {
                            latest(&d.deleted, p)
                        } else {
                            d.deleted.clone()
                        },
                        if modifier != Some(StartOrEndSide::Deleted) {
                            latest(&d.inserted, n)
                        } else {
                            d.inserted.clone()
                        },
                    )
                } else {
                    d.clone()
                };
                if Delta::is_inner_different(&d2.deleted, &d2.inserted) {
                    out.insert(id.clone(), d2);
                }
            }
            out
        };
        ElementsDelta::create(
            modify(&self.added),
            modify(&self.removed),
            modify(&self.updated),
            true,
        )
    }

    /// `squash`: folds `other` (which happened after `self`) into `self`.
    pub fn squash(&mut self, other: &ElementsDelta) -> &mut Self {
        if other.is_empty() {
            return self;
        }
        fn merge_bound(prev: &Delta, next: &Delta) -> Option<Delta> {
            let arr = |p: &Partial| {
                p.get("boundElements")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
            };
            let d = Delta::merge_arrays(&arr(&prev.deleted), &arr(&next.deleted), &[], id_key);
            let i = Delta::merge_arrays(&arr(&prev.inserted), &arr(&next.inserted), &[], id_key);
            if d.is_empty() && i.is_empty() {
                return None;
            }
            let one = |v: Vec<Value>| {
                let mut m = Partial::new();
                m.insert("boundElements".into(), Value::Array(v));
                m
            };
            Some(Delta::new(one(d), one(i)))
        }
        for (id, nd) in &other.added {
            match self
                .added
                .get(id)
                .or(self.removed.get(id))
                .or(self.updated.get(id))
                .cloned()
            {
                None => {
                    self.added.insert(id.clone(), nd.clone());
                }
                Some(pd) => {
                    let m = merge_bound(&pd, nd);
                    self.removed.remove(id);
                    self.updated.remove(id);
                    self.added
                        .insert(id.clone(), Delta::merge(&pd, nd, m.as_ref()));
                }
            }
        }
        for (id, nd) in &other.removed {
            match self
                .added
                .get(id)
                .or(self.removed.get(id))
                .or(self.updated.get(id))
                .cloned()
            {
                None => {
                    self.removed.insert(id.clone(), nd.clone());
                }
                Some(pd) => {
                    let m = merge_bound(&pd, nd);
                    self.added.remove(id);
                    self.updated.remove(id);
                    self.removed
                        .insert(id.clone(), Delta::merge(&pd, nd, m.as_ref()));
                }
            }
        }
        for (id, nd) in &other.updated {
            let target = if self.added.contains_key(id) {
                &mut self.added
            } else if self.removed.contains_key(id) {
                &mut self.removed
            } else {
                &mut self.updated
            };
            match target.get(id).cloned() {
                None => {
                    target.insert(id.clone(), nd.clone());
                }
                Some(pd) => {
                    let m = merge_bound(&pd, nd);
                    target.insert(id.clone(), Delta::merge(&pd, nd, m.as_ref()));
                }
            }
        }
        if cfg!(debug_assertions) {
            self.validate();
        }
        self
    }

    /// `applyTo`: applies the deltas to `elements` (falling back to
    /// `snapshot` for elements missing from the scene), repairs bindings
    /// (squashing the repairs into `self`), restores the z-order, runs the
    /// layout hooks, and tells whether anything visibly changed.
    pub fn apply_to(
        &mut self,
        elements: &ElementMap,
        snapshot: &ElementMap,
        opts: &ApplyToOptions,
        hooks: &mut dyn HistoryHooks,
    ) -> (ElementMap, bool) {
        let mut next = elements.clone();
        let mut flags = Flags::default();
        let mut changed = ElementMap::new();
        for map in [&self.added, &self.removed, &self.updated] {
            for (id, delta) in map {
                let element = Self::get_element(&next, snapshot, &mut flags, id, &delta.inserted);
                let n = Rc::new(Self::apply_delta(&element, delta, &mut flags, opts));
                next.set_rc(n.clone());
                changed.set_rc(n.clone());
                if flags.forward.is_none()
                    && let Some(p) = elements.get(id)
                {
                    flags.forward = Some(p.version <= n.version);
                }
            }
        }
        for e in self
            .resolve_conflicts(elements, &mut next, flags.forward.unwrap_or(true))
            .iter_rc()
        {
            changed.set_rc(e.clone());
        }

        // what to compare for visibility: the changed elements and what layout
        // can move for them (a text's container, everything bound), walked as
        // the set grows
        let mut ids: Vec<String> = changed.ids().map(str::to_owned).collect();
        let mut seen: FxHashSet<String> = ids.iter().cloned().collect();
        let mut previous = ElementMap::new();
        let mut i = 0;
        while i < ids.len() {
            let id = ids[i].clone();
            let (p, n) = (elements.get_rc(&id), next.get_rc(&id));
            for e in [p, n].into_iter().flatten() {
                let deps = e
                    .container_id()
                    .map(str::to_owned)
                    .into_iter()
                    .chain(e.bound_elements.iter().flatten().map(|b| b.id.clone()));
                for d in deps {
                    if seen.insert(d.clone()) {
                        ids.push(d);
                    }
                }
            }
            if let Some(p) = p {
                previous.set_rc(p.clone());
            }
            i += 1;
        }

        Self::reorder_elements(&mut next, &changed, &mut flags);
        let before: Option<FxHashMap<String, i64>> = opts
            .guard_redraw
            .then(|| next.iter().map(|e| (e.id.clone(), e.version)).collect());
        Self::redraw_elements(&mut next, &changed, hooks);
        if let Some(before) = before {
            for e in next.iter() {
                if before.get(&e.id) != Some(&e.version) && !seen.contains(&e.id) {
                    panic!("Redrawn element \"{}\" is missing from idsToCheck", e.id);
                }
            }
        }
        if !flags.visible
            && ids.iter().any(|id| {
                Self::check_for_visible_difference(previous.get(id), next.get(id), &previous, &next)
            })
        {
            flags.visible = true;
        }
        (next, flags.visible)
    }

    /// `createGetter`: from the scene, else the snapshot (a possible z-order
    /// change), else a new element from the partial (added remotely).
    fn get_element(
        next: &ElementMap,
        snapshot: &ElementMap,
        flags: &mut Flags,
        id: &str,
        partial: &Partial,
    ) -> Rc<Element> {
        if let Some(e) = next.get_rc(id) {
            return e.clone();
        }
        if let Some(e) = snapshot.get_rc(id) {
            flags.zindex = true;
            return e.clone();
        }
        let base = new_element(
            ElementType::Rectangle,
            ElementOpts {
                id: Some(id.into()),
                version: Some(1),
                seed: Some(0),
                version_nonce: Some(0),
                ..Default::default()
            },
        );
        Rc::new(new_element_with(&base, partial, false))
    }

    /// `applyDelta`.
    fn apply_delta(
        element: &Element,
        delta: &Delta,
        flags: &mut Flags,
        opts: &ApplyToOptions,
    ) -> Element {
        let mut partial: Partial = delta
            .inserted
            .iter()
            .filter(|(k, _)| {
                *k != "boundElements" && !opts.excluded_properties.iter().any(|x| x == *k)
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let arr = |p: &Partial| {
            p.get("boundElements")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let (db, ib) = (arr(&delta.deleted), arr(&delta.inserted));
        if !db.is_empty() || !ib.is_empty() {
            let cur = element
                .bound_elements
                .as_deref()
                .map(bound_elements_value)
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
            partial.insert(
                "boundElements".into(),
                Value::Array(Delta::merge_arrays(&cur, &ib, &db, id_key)),
            );
        }
        if !flags.zindex {
            flags.zindex = differ(delta.deleted.get("index"), delta.inserted.get("index"));
        }
        new_element_with(element, &partial, true)
    }

    /// `checkForVisibleDifference`: whether an element paints differently.
    /// Missing, deleted and empty texts (unless arrow-bound or an arrow's
    /// label) paint nothing; metadata and `index` don't count; references to
    /// empty labels in `boundElements` don't count.
    fn check_for_visible_difference(
        prev: Option<&Element>,
        next: Option<&Element>,
        prev_map: &ElementMap,
        next_map: &ElementMap,
    ) -> bool {
        let visible = |e: Option<&Element>, m: &ElementMap| -> bool {
            let Some(e) = e.filter(|e| !e.is_deleted) else {
                return false;
            };
            !(e.text().is_some_and(|t| t.text.trim().is_empty())
                && e.bound_elements.as_ref().is_none_or(|b| b.is_empty())
                && !e
                    .container_id()
                    .and_then(|c| m.get(c))
                    .is_some_and(Element::is_arrow))
        };
        let (bv, av) = (visible(prev, prev_map), visible(next, next_map));
        if !bv || !av {
            return bv != av;
        }
        let (b, a) = (prev.unwrap(), next.unwrap());
        let bindings = |e: &Element, m: &ElementMap| -> Vec<String> {
            e.bound_elements
                .iter()
                .flatten()
                .filter(|b| {
                    b.kind != BoundType::Text
                        || e.is_arrow()
                        || m.get(&b.id)
                            .is_none_or(|l| l.text().is_none_or(|t| !t.text.trim().is_empty()))
                })
                .map(|b| format!("{}:{}", b.kind.as_str(), b.id))
                .collect()
        };
        Delta::get_differences(&element_partial(b), &element_partial(a))
            .iter()
            .any(|k| match k.as_str() {
                "index" | "version" | "versionNonce" | "updated" | "created" => false,
                "boundElements" => bindings(b, prev_map) != bindings(a, next_map),
                _ => true,
            })
    }

    /// `resolveConflicts`: keeps bindings two-way after applying: unbinds
    /// what points at removed elements, rebinds added and rebound ones. The
    /// repairs are squashed into `self`; returns the elements they changed.
    fn resolve_conflicts(
        &mut self,
        prev: &ElementMap,
        next: &mut ElementMap,
        forward: bool,
    ) -> ElementMap {
        let mut r = Resolver {
            prev,
            next,
            affected: ElementMap::new(),
            forward,
        };
        for id in self.removed.keys() {
            let (p, n) = (prev.get(id).cloned(), r.next.get(id).cloned());
            r.bound_unbind(p.as_ref());
            r.bound_unbind(n.as_ref());
            r.bindable_unbind(p.as_ref(), false);
            let n = r.next.get(id).cloned();
            r.bindable_unbind(n.as_ref(), false);
        }
        for id in self.added.keys() {
            r.rebind(id);
        }
        for (id, d) in &self.updated {
            if !d
                .deleted
                .keys()
                .chain(d.inserted.keys())
                .any(|k| BINDING_PROPERTIES.contains(&k.as_str()))
            {
                continue;
            }
            if r.next.get(id).is_none_or(|e| e.is_deleted) {
                continue;
            }
            r.rebind(id);
        }
        let affected = r.affected;
        let prev_affected: ElementMap = prev.iter_rc().filter(|e| affected.contains(&e.id)).fold(
            ElementMap::new(),
            |mut m, e| {
                m.set_rc(e.clone());
                m
            },
        );
        self.squash(&ElementsDelta::calculate(&prev_affected, &affected));
        affected
    }

    /// `redrawElements`: labels of changed containers / changed labels, then
    /// arrows bound to changed bindable elements.
    fn redraw_elements(next: &mut ElementMap, changed: &ElementMap, hooks: &mut dyn HistoryHooks) {
        let alive = |m: &ElementMap, id: &str| m.get(id).filter(|e| !e.is_deleted).is_some();
        let mut boxes: Vec<(String, String)> = vec![];
        let mut put = |c: String, t: String| match boxes.iter_mut().find(|(x, _)| *x == c) {
            Some(b) => b.1 = t,
            None => boxes.push((c, t)),
        };
        for e in changed.ids().filter_map(|id| next.get(id)) {
            if let Some(c) = e.container_id()
                && alive(next, c)
            {
                put(c.into(), e.id.clone());
            }
            if e.has_bound_text()
                && let Some(t) = e.bound_text_id()
                && alive(next, t)
            {
                put(e.id.clone(), t.into());
            }
        }
        for (c, t) in boxes {
            if !alive(next, &c) || !alive(next, &t) {
                continue;
            }
            hooks.redraw_text_bounding_box(&t, &c, next);
        }
        let changed_ids: FxHashSet<String> = changed.ids().map(str::to_owned).collect();
        for id in changed.ids() {
            if next
                .get(id)
                .is_some_and(|e| !e.is_deleted && e.is_bindable(true))
            {
                hooks.update_bound_elements(id, next, &changed_ids);
            }
        }
    }

    /// `reorderElements`: when the z-order may have changed, sorts by
    /// fractional index and regenerates the indices of the changed elements
    /// that moved.
    fn reorder_elements(next: &mut ElementMap, changed: &ElementMap, flags: &mut Flags) {
        if !flags.zindex {
            return;
        }
        let unordered: Vec<Rc<Element>> = next.iter_rc().cloned().collect();
        let mut ordered: Vec<Element> = next.to_vec();
        order_by_fractional_index(&mut ordered);
        let moved: FxHashSet<String> = unordered
            .iter()
            .zip(&ordered)
            .filter(|(u, o)| u.id != o.id && changed.contains(&u.id))
            .map(|(u, _)| u.id.clone())
            .collect();
        if !moved.is_empty() {
            flags.visible = true;
        }
        sync_moved_indices(&mut ordered, &moved);
        let by_id: FxHashMap<&str, &Rc<Element>> =
            unordered.iter().map(|e| (e.id.as_str(), e)).collect();
        let mut out = ElementMap::new();
        for e in ordered {
            match by_id.get(e.id.as_str()) {
                Some(rc) if ***rc == e => out.set_rc((*rc).clone()),
                _ => out.set(e),
            }
        }
        *next = out;
    }

    fn post_process(deleted: &mut Partial, inserted: &mut Partial) {
        Delta::diff_arrays(deleted, inserted, "boundElements", id_key);
        // points aren't diffed, only dropped when equal
        let points = |p: &Partial| p.get("points").cloned().unwrap_or(Value::Array(vec![]));
        if js_eq(&points(deleted), &points(inserted)) {
            deleted.remove("points");
            inserted.remove("points");
        }
    }
}

/// Which side `applyLatestChanges` refreshes (`modifierOptions`); None: both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartOrEndSide {
    Deleted,
    Inserted,
}

/// The binding repairs of `resolveConflicts`: `BoundElement` /
/// `BindableElement` from `binding.ts`, with the version-aware updater.
struct Resolver<'a> {
    prev: &'a ElementMap,
    next: &'a mut ElementMap,
    affected: ElementMap,
    forward: bool,
}

fn upd(k: &str, v: Value) -> Partial {
    let mut m = Partial::new();
    m.insert(k.into(), v);
    m
}

/// `newBoundElements`: null stays null.
fn new_bound_elements(b: Option<&Vec<BoundElement>>, remove: &str, add: Option<&Element>) -> Value {
    let Some(b) = b else { return Value::Null };
    let mut out: Vec<BoundElement> = b.iter().filter(|x| x.id != remove).cloned().collect();
    if let Some(a) = add
        && let Some(kind) = BoundType::parse(a.ty().as_str())
    {
        out.push(BoundElement {
            id: a.id.clone(),
            kind,
        });
    }
    bound_elements_value(&out)
}

impl Resolver<'_> {
    /// The `updater`: changes only the next element; the version moves with
    /// the apply direction unless it already moved.
    fn update(&mut self, id: &str, mut updates: Partial) {
        let Some(n) = self.next.get_rc(id).cloned() else {
            return;
        };
        let p = self.prev.get_rc(id);
        let next_version = if self.forward {
            n.version + 1
        } else {
            n.version - 1
        };
        let e = if p.is_some_and(|p| Rc::ptr_eq(p, &n)) {
            updates.insert("version".into(), json!(next_version));
            Rc::new(new_element_with(&n, &updates, true))
        } else {
            let v = if p.map(|p| p.version) != Some(n.version) {
                n.version
            } else {
                next_version
            };
            updates.insert("version".into(), json!(v));
            apply_updates(&n, &updates, false, true).map_or(n, Rc::new)
        };
        self.affected.set_rc(e.clone());
        self.next.set_rc(e);
    }
    fn get(&self, id: &str) -> Option<Element> {
        self.next.get(id).cloned()
    }

    /// `BoundElement.unbindAffected`: drop `bound` from the `boundElements`
    /// of the live elements it points at.
    fn bound_unbind(&mut self, bound: Option<&Element>) {
        let Some(bound) = bound else { return };
        for (_, bid) in bindable_targets(bound) {
            let Some(b) = self.get(&bid).filter(|b| !b.is_deleted) else {
                continue;
            };
            for id in bound_targets(&b) {
                if id == bound.id {
                    let cur = self.get(&bid).unwrap();
                    self.update(
                        &bid,
                        upd(
                            "boundElements",
                            new_bound_elements(cur.bound_elements.as_ref(), &id, None),
                        ),
                    );
                }
            }
        }
    }

    /// `BoundElement.rebindAffected`: add `bound` back to what it points at,
    /// or drop pointers into deleted elements (and to containers that have
    /// another label).
    fn bound_rebind(&mut self, bound: Option<&Element>) {
        let Some(bound) = bound.filter(|b| !b.is_deleted) else {
            return;
        };
        for (prop, bid) in bindable_targets(bound) {
            let Some(b) = self.get(&bid).filter(|b| !b.is_deleted) else {
                self.update(&bound.id, upd(prop, Value::Null));
                continue;
            };
            if prop == "frameId" {
                continue;
            }
            if b.bound_elements.iter().flatten().any(|x| x.id == bound.id) {
                continue;
            }
            if bound.is_arrow() {
                self.update(
                    &bid,
                    upd(
                        "boundElements",
                        new_bound_elements(b.bound_elements.as_ref(), "", Some(bound)),
                    ),
                );
            }
            if bound.is_text() {
                if !b
                    .bound_elements
                    .iter()
                    .flatten()
                    .any(|x| x.kind == BoundType::Text)
                {
                    self.update(
                        &bid,
                        upd(
                            "boundElements",
                            new_bound_elements(b.bound_elements.as_ref(), "", Some(bound)),
                        ),
                    );
                } else {
                    self.update(&bound.id, upd(prop, Value::Null));
                }
            }
        }
    }

    /// `BindableElement.unbindAffected`: null the bindings of live bound
    /// elements that point at `bindable` (`text_only`: only labels).
    fn bindable_unbind(&mut self, bindable: Option<&Element>, text_only: bool) {
        let Some(bindable) = bindable else { return };
        for id in bound_targets(bindable) {
            let Some(bound) = self.get(&id).filter(|b| !b.is_deleted) else {
                continue;
            };
            for (prop, bid) in bindable_targets(&bound) {
                if bid == bindable.id && (!text_only || bound.is_text()) {
                    self.update(&bound.id, upd(prop, Value::Null));
                }
            }
        }
    }

    /// `BindableElement.rebindAffected`: point the labels listed in
    /// `bindable.boundElements` back at it (the last listed label wins),
    /// dropping entries for deleted elements.
    fn bindable_rebind(&mut self, bindable: Option<&Element>) {
        let Some(bindable) = bindable.filter(|b| !b.is_deleted) else {
            return;
        };
        let bid = bindable.id.clone();
        for id in bound_targets(bindable) {
            let Some(bound) = self.get(&id).filter(|b| !b.is_deleted) else {
                let c = self.get(&bid).unwrap();
                self.update(
                    &bid,
                    upd(
                        "boundElements",
                        new_bound_elements(c.bound_elements.as_ref(), &id, None),
                    ),
                );
                continue;
            };
            if bound.is_text() {
                let c = self.get(&bid).unwrap();
                let last_text = c
                    .bound_elements
                    .iter()
                    .flatten()
                    .rev()
                    .find(|x| x.kind == BoundType::Text)
                    .map(|x| x.id.clone());
                if last_text.as_deref() == Some(bound.id.as_str()) {
                    if bound.container_id() != Some(bid.as_str()) {
                        self.update(&bound.id, upd("containerId", Value::String(bid.clone())));
                    }
                } else {
                    if bound.container_id().is_some() {
                        self.update(&bound.id, upd("containerId", Value::Null));
                    }
                    let c = self.get(&bid).unwrap();
                    self.update(
                        &bid,
                        upd(
                            "boundElements",
                            new_bound_elements(c.bound_elements.as_ref(), &bound.id, None),
                        ),
                    );
                }
            }
        }
    }

    /// `ElementsDelta.rebindAffected`.
    fn rebind(&mut self, id: &str) {
        let p = self.prev.get(id).cloned();
        self.bound_unbind(p.as_ref());
        let n = self.get(id);
        self.bound_rebind(n.as_ref());
        // arrows can't be rebound to a bindable element, so only labels are unbound here
        let p = self.prev.get(id).cloned();
        self.bindable_unbind(p.as_ref(), true);
        let n = self.get(id);
        self.bindable_rebind(n.as_ref());
    }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// `CaptureUpdateAction`: how an update reaches undo history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureUpdateAction {
    /// Undoable right away: most local updates (not in-gesture ephemerals).
    Immediately,
    /// Never undoable: scene initialization, remote updates, undo / redo
    /// themselves.
    Never,
    /// Undoable with the next `Immediately` capture: steps of a multi-step
    /// change (and everything committed without a scheduled action).
    Eventually,
}

/// `StoreChange`: the changed elements and app state properties.
#[derive(Clone, Debug, Default)]
pub struct StoreChange {
    pub elements: ElementMap,
    pub app_state: Partial,
}

impl StoreChange {
    pub fn create(prev: &StoreSnapshot, next: &StoreSnapshot) -> StoreChange {
        StoreChange {
            elements: next.get_changed_elements(prev),
            app_state: next.get_changed_app_state(prev),
        }
    }
}

/// `StoreDelta` (and `HistoryDelta`: `is_history`, set on entries of the
/// undo / redo stacks, so applying one isn't recorded again).
#[derive(Clone, Debug, PartialEq)]
pub struct StoreDelta {
    pub id: String,
    pub elements: ElementsDelta,
    pub app_state: AppStateDelta,
    pub is_history: bool,
}

impl StoreDelta {
    pub fn create(elements: ElementsDelta, app_state: AppStateDelta) -> StoreDelta {
        StoreDelta {
            id: random_id(),
            elements,
            app_state,
            is_history: false,
        }
    }
    pub fn empty() -> StoreDelta {
        StoreDelta::create(ElementsDelta::empty(), AppStateDelta::empty())
    }
    /// `StoreDelta.calculate`: only what the snapshot flags as changed.
    pub fn calculate(prev: &StoreSnapshot, next: &StoreSnapshot) -> StoreDelta {
        let e = if next.did_elements_change {
            ElementsDelta::calculate(&prev.elements, &next.elements)
        } else {
            ElementsDelta::empty()
        };
        let a = if next.did_app_state_change {
            AppStateDelta::calculate(&prev.app_state, &next.app_state)
        } else {
            AppStateDelta::empty()
        };
        StoreDelta::create(e, a)
    }
    pub fn squash(deltas: &[StoreDelta]) -> StoreDelta {
        let mut out = StoreDelta::empty();
        for d in deltas {
            out.elements.squash(&d.elements);
            out.app_state.squash(&d.app_state);
        }
        out
    }
    /// `inverse` (a new id; keeps `is_history`).
    pub fn inverse(&self) -> StoreDelta {
        StoreDelta {
            is_history: self.is_history,
            ..StoreDelta::create(self.elements.inverse(), self.app_state.inverse())
        }
    }
    /// `StoreDelta.applyTo`, against an empty snapshot.
    pub fn apply_to(
        &mut self,
        elements: &ElementMap,
        app: &AppState,
        opts: &ApplyToOptions,
        hooks: &mut dyn HistoryHooks,
    ) -> (ElementMap, AppState, bool) {
        let (ne, ev) = self
            .elements
            .apply_to(elements, &ElementMap::new(), opts, hooks);
        let (na, av) = self.app_state.apply_to(app, &ne);
        (ne, na, ev || av)
    }
    /// `HistoryDelta.applyTo`: versions aren't restored, so undo / redo is a
    /// new version; elements missing from the scene come from the snapshot.
    pub fn apply_history(
        &mut self,
        elements: &ElementMap,
        app: &AppState,
        snapshot: &StoreSnapshot,
        hooks: &mut dyn HistoryHooks,
    ) -> (ElementMap, AppState, bool) {
        let (ne, ev) = self.elements.apply_to(
            elements,
            &snapshot.elements,
            &ApplyToOptions::history(),
            hooks,
        );
        let (na, av) = self.app_state.apply_to(app, &ne);
        (ne, na, ev || av)
    }
    /// `applyLatestChanges` (same id).
    pub fn apply_latest_changes(
        &self,
        prev: &ElementMap,
        next: &ElementMap,
        modifier: Option<StartOrEndSide>,
    ) -> StoreDelta {
        StoreDelta {
            id: self.id.clone(),
            elements: self.elements.apply_latest_changes(prev, next, modifier),
            app_state: self.app_state.clone(),
            is_history: self.is_history,
        }
    }
    pub fn is_empty(&self) -> bool {
        self.elements.is_empty() && self.app_state.is_empty()
    }
}

/// What a commit emitted (`DurableIncrement` / `EphemeralIncrement`).
#[derive(Clone, Debug)]
pub enum StoreIncrement {
    /// A recorded change: goes to undo history.
    Durable {
        change: StoreChange,
        delta: StoreDelta,
    },
    /// An unrecorded change (`Never`, `Eventually`).
    Ephemeral { change: StoreChange },
}

/// `StoreSnapshot`: the last captured elements (copies) and observed app
/// state.
#[derive(Clone, Debug)]
pub struct StoreSnapshot {
    pub elements: Rc<ElementMap>,
    pub app_state: ObservedAppState,
    pub did_elements_change: bool,
    pub did_app_state_change: bool,
    pub is_empty: bool,
    last_changed_elements_hash: u32,
    last_changed_app_state_hash: u32,
}

impl StoreSnapshot {
    pub fn create(
        elements: ElementMap,
        app_state: ObservedAppState,
        did_elements_change: bool,
        did_app_state_change: bool,
    ) -> StoreSnapshot {
        StoreSnapshot {
            elements: Rc::new(elements),
            app_state,
            did_elements_change,
            did_app_state_change,
            is_empty: false,
            last_changed_elements_hash: 0,
            last_changed_app_state_hash: 0,
        }
    }
    pub fn empty() -> StoreSnapshot {
        StoreSnapshot {
            is_empty: true,
            ..StoreSnapshot::create(ElementMap::new(), ObservedAppState::default(), false, false)
        }
    }

    /// `getChangedElements`: elements that are new instances compared to
    /// `prev`; elements gone from this snapshot come back deleted.
    pub fn get_changed_elements(&self, prev: &StoreSnapshot) -> ElementMap {
        let mut out = ElementMap::new();
        for p in prev.elements.iter() {
            if !self.elements.contains(&p.id) {
                out.set(new_element_with(
                    p,
                    &upd("isDeleted", Value::Bool(true)),
                    false,
                ));
            }
        }
        for n in self.elements.iter_rc() {
            if prev
                .elements
                .get_rc(&n.id)
                .is_none_or(|p| !Rc::ptr_eq(p, n))
            {
                out.set_rc(n.clone());
            }
        }
        out
    }
    pub fn get_changed_app_state(&self, prev: &StoreSnapshot) -> Partial {
        let n = self.app_state.to_partial();
        Delta::get_right_differences(&prev.app_state.to_partial(), &n)
            .into_iter()
            .map(|k| {
                let v = n[&k].clone();
                (k, v)
            })
            .collect()
    }

    /// `applyChange`: a new snapshot with the change on top.
    pub fn apply_change(&self, change: &StoreChange) -> StoreSnapshot {
        let mut elements = (*self.elements).clone();
        for e in change.elements.iter_rc() {
            elements.set_rc(e.clone());
        }
        let mut app = self.app_state.clone();
        app.apply_partial(&change.app_state);
        StoreSnapshot::create(
            elements,
            app,
            !change.elements.is_empty(),
            !change.app_state.is_empty(),
        )
    }

    /// `maybeClone`: a new snapshot if `elements` / `app` differ from this
    /// one, None otherwise. `Eventually` also skips changes already seen by
    /// the previous `Eventually` (hash compare).
    pub fn maybe_clone(
        &mut self,
        action: CaptureUpdateAction,
        elements: Option<&[&Element]>,
        app: Option<&ObservedAppState>,
    ) -> Option<StoreSnapshot> {
        let hashes = action == CaptureUpdateAction::Eventually;
        let next_elements = elements
            .and_then(|e| self.detect_changed_elements(e, hashes))
            .map(|changed| {
                let mut m = (*self.elements).clone();
                for e in changed {
                    m.set(e);
                }
                Rc::new(m)
            });
        let next_app = app
            .filter(|a| self.detect_changed_app_state(a, hashes))
            .cloned();
        if next_elements.is_none() && next_app.is_none() {
            return None;
        }
        Some(StoreSnapshot {
            did_elements_change: next_elements.is_some(),
            did_app_state_change: next_app.is_some(),
            elements: next_elements.unwrap_or_else(|| self.elements.clone()),
            app_state: next_app.unwrap_or_else(|| self.app_state.clone()),
            is_empty: false,
            last_changed_elements_hash: 0,
            last_changed_app_state_hash: 0,
        })
    }

    fn detect_changed_app_state(&mut self, next: &ObservedAppState, hashes: bool) -> bool {
        let n = next.to_partial();
        if !Delta::is_right_different(&self.app_state.to_partial(), &n) {
            return false;
        }
        let hash = hash_string(&Value::Object(n).to_string());
        if hashes && self.last_changed_app_state_hash == hash {
            return false;
        }
        self.last_changed_app_state_hash = hash;
        true
    }

    /// `detectChangedElements`: new elements, elements with a higher version
    /// (uninitialized images ignored), and elements gone (as deleted). The
    /// changed elements are copies.
    fn detect_changed_elements(&mut self, next: &[&Element], hashes: bool) -> Option<Vec<Element>> {
        let by_id: FxHashMap<&str, &Element> = next.iter().map(|e| (e.id.as_str(), *e)).collect();
        let mut changed: Vec<Element> = vec![];
        for p in self.elements.iter() {
            if !by_id.contains_key(p.id.as_str()) {
                changed.push(new_element_with(
                    p,
                    &upd("isDeleted", Value::Bool(true)),
                    false,
                ));
            }
        }
        for n in next {
            if self
                .elements
                .get(&n.id)
                .is_none_or(|p| p.version < n.version)
            {
                if n.is_image() && !n.is_initialized_image() {
                    continue;
                }
                changed.push((*n).clone());
            }
        }
        if changed.is_empty() {
            return None;
        }
        let hash = hash_elements_version(changed.iter());
        if hashes && self.last_changed_elements_hash == hash {
            return None;
        }
        self.last_changed_elements_hash = hash;
        Some(changed)
    }
}

/// `Store`: captures changes between commits as deltas. The app calls
/// `commit` after every update it applied, having scheduled how the update
/// is captured; the increments it returns go to `History::record_increments`.
#[derive(Debug)]
pub struct Store {
    pub snapshot: StoreSnapshot,
    scheduled_macro: BTreeSet<u8>,
    scheduled_micro: Vec<(CaptureUpdateAction, StoreChange, Option<StoreDelta>)>,
    /// Whether ephemeral increments are wanted (upstream: someone subscribed
    /// to `onStoreIncrementEmitter`). Without, `Eventually` commits are
    /// skipped entirely.
    pub emit_ephemeral: bool,
}

impl Default for Store {
    fn default() -> Self {
        Store::new()
    }
}

fn rank(a: CaptureUpdateAction) -> u8 {
    match a {
        CaptureUpdateAction::Immediately => 0,
        CaptureUpdateAction::Never => 1,
        CaptureUpdateAction::Eventually => 2,
    }
}

impl Store {
    pub fn new() -> Store {
        Store {
            snapshot: StoreSnapshot::empty(),
            scheduled_macro: BTreeSet::new(),
            scheduled_micro: vec![],
            emit_ephemeral: false,
        }
    }

    /// `scheduleAction`: how the next commit captures. `Immediately` wins
    /// over `Never`, which wins over `Eventually` (the default).
    pub fn schedule_action(&mut self, a: CaptureUpdateAction) {
        self.scheduled_macro.insert(rank(a));
    }
    /// `scheduleCapture`.
    pub fn schedule_capture(&mut self) {
        self.schedule_action(CaptureUpdateAction::Immediately)
    }

    /// `scheduleMicroAction` with elements / app state: the change from the
    /// current scene state (`current_*`) to the given one is fixed now and
    /// processed first thing in the next commit (async steps such as image
    /// or text completion, whose capture differs from the commit's).
    pub fn schedule_micro_action(
        &mut self,
        action: CaptureUpdateAction,
        elements: Option<&[Element]>,
        app: Option<&AppState>,
        current_elements: &[Element],
        current_app: &AppState,
    ) {
        let mut current = StoreSnapshot::create(
            ElementMap::from_slice(current_elements),
            ObservedAppState::from_app(current_app),
            false,
            false,
        );
        let synced = elements.map(sync_invalid_indices_immutable);
        let refs: Option<Vec<&Element>> = synced.as_ref().map(|v| v.iter().collect());
        let observed = app.map(ObservedAppState::from_app);
        let scheduled = current
            .maybe_clone(action, refs.as_deref(), observed.as_ref())
            .unwrap_or_else(|| current.clone());
        let change = StoreChange::create(&current, &scheduled);
        self.scheduled_micro.push((action, change, None));
    }
    /// `scheduleMicroAction` with a ready change (and delta, for `Immediately`).
    pub fn schedule_micro_change(
        &mut self,
        action: CaptureUpdateAction,
        change: StoreChange,
        delta: Option<StoreDelta>,
    ) {
        self.scheduled_micro.push((action, change, delta));
    }

    /// `commit`: runs the scheduled micro actions, then the scheduled macro
    /// action against the given scene state (`elements` in scene order,
    /// deleted included), and returns what was emitted.
    pub fn commit(
        &mut self,
        elements: Option<&[Element]>,
        app: Option<&AppState>,
    ) -> Vec<StoreIncrement> {
        let mut out = vec![];
        for (action, change, delta) in std::mem::take(&mut self.scheduled_micro) {
            if action == CaptureUpdateAction::Eventually && !self.emit_ephemeral {
                continue;
            }
            let next = self.snapshot.apply_change(&change);
            self.process(action, next, Some(change), delta, &mut out);
        }
        let action = if self.scheduled_macro.contains(&0) {
            CaptureUpdateAction::Immediately
        } else if self.scheduled_macro.contains(&1) {
            CaptureUpdateAction::Never
        } else {
            CaptureUpdateAction::Eventually
        };
        self.scheduled_macro.clear();
        if (action != CaptureUpdateAction::Eventually || self.emit_ephemeral)
            && (elements.is_some() || app.is_some())
        {
            let refs: Option<Vec<&Element>> = elements.map(|e| e.iter().collect());
            let observed = app.map(ObservedAppState::from_app);
            if let Some(next) =
                self.snapshot
                    .maybe_clone(action, refs.as_deref(), observed.as_ref())
            {
                self.process(action, next, None, None, &mut out);
            }
        }
        out
    }

    fn process(
        &mut self,
        action: CaptureUpdateAction,
        next: StoreSnapshot,
        change: Option<StoreChange>,
        delta: Option<StoreDelta>,
        out: &mut Vec<StoreIncrement>,
    ) {
        let change = change.unwrap_or_else(|| StoreChange::create(&self.snapshot, &next));
        match action {
            CaptureUpdateAction::Immediately => {
                let delta = delta.unwrap_or_else(|| StoreDelta::calculate(&self.snapshot, &next));
                if !delta.is_empty() {
                    out.push(StoreIncrement::Durable { change, delta });
                }
            }
            _ => out.push(StoreIncrement::Ephemeral { change }),
        }
        if action != CaptureUpdateAction::Eventually {
            self.snapshot = next;
        }
    }

    /// `clear`.
    pub fn clear(&mut self) {
        self.snapshot = StoreSnapshot::empty();
        self.scheduled_macro.clear();
    }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/// `History`: undo / redo stacks of inverse deltas.
///
/// Per user action the app: applies the update to the scene and app state;
/// `store.schedule_capture()` (or `schedule_action(Never)` for loading /
/// remote updates; nothing for in-gesture steps); `store.commit(...)`;
/// `history.record_increments(&increments)`. For undo: `history.undo(...)`;
/// when it returns a state, sets it, `store.schedule_action(Never)`, commits
/// and records as usual (the history's own increment isn't re-recorded).
/// Upstream blocks undo / redo while a gesture is in progress (new, resized,
/// dragged element, text editing); that check is the app's.
#[derive(Clone, Debug, Default)]
pub struct History {
    pub undo_stack: Vec<StoreDelta>,
    pub redo_stack: Vec<StoreDelta>,
}

impl History {
    pub fn new() -> History {
        History::default()
    }
    pub fn is_undo_stack_empty(&self) -> bool {
        self.undo_stack.is_empty()
    }
    pub fn is_redo_stack_empty(&self) -> bool {
        self.redo_stack.is_empty()
    }
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }

    /// `record`: pushes the inverse of a durable local delta. Only element
    /// changes clear the redo stack, so a click that unselects doesn't lose
    /// the redos.
    pub fn record(&mut self, delta: &StoreDelta) {
        if delta.is_empty() || delta.is_history {
            return;
        }
        let entry = StoreDelta {
            is_history: true,
            ..delta.inverse()
        };
        let clears = !entry.elements.is_empty();
        self.undo_stack.push(entry);
        if clears {
            self.redo_stack.clear();
        }
    }
    /// Records the durable increments of a commit.
    pub fn record_increments(&mut self, increments: &[StoreIncrement]) {
        for i in increments {
            if let StoreIncrement::Durable { delta, .. } = i {
                self.record(delta);
            }
        }
    }

    /// `undo`: the scene (sorted by fractional index) and app state after
    /// undoing, or None when there is nothing to undo. Entries without a
    /// visible effect are undone along the way.
    pub fn undo(
        &mut self,
        store: &mut Store,
        elements: &[Element],
        app: &AppState,
        hooks: &mut dyn HistoryHooks,
    ) -> Option<(Vec<Element>, AppState)> {
        self.perform(store, elements, app, hooks, true)
    }
    /// `redo`.
    pub fn redo(
        &mut self,
        store: &mut Store,
        elements: &[Element],
        app: &AppState,
        hooks: &mut dyn HistoryHooks,
    ) -> Option<(Vec<Element>, AppState)> {
        self.perform(store, elements, app, hooks, false)
    }

    fn perform(
        &mut self,
        store: &mut Store,
        elements: &[Element],
        app: &AppState,
        hooks: &mut dyn HistoryHooks,
        undo: bool,
    ) -> Option<(Vec<Element>, AppState)> {
        let pop = |h: &mut History| {
            if undo {
                h.undo_stack.pop()
            } else {
                h.redo_stack.pop()
            }
        };
        let mut delta = pop(self)?;
        let action = CaptureUpdateAction::Immediately;
        let mut prev_snapshot = store.snapshot.clone();
        let mut next_elements = ElementMap::from_slice(elements);
        let mut next_app = app.clone();
        loop {
            let (ne, na, visible) =
                delta.apply_history(&next_elements, &next_app, &prev_snapshot, hooks);
            (next_elements, next_app) = (ne, na);
            let prev_elements = prev_snapshot.elements.clone();
            let refs: Vec<&Element> = next_elements.iter().collect();
            let next_snapshot = prev_snapshot
                .maybe_clone(
                    action,
                    Some(&refs),
                    Some(&ObservedAppState::from_app(&next_app)),
                )
                .unwrap_or_else(|| prev_snapshot.clone());
            let change = StoreChange::create(&prev_snapshot, &next_snapshot);
            let latest = delta.apply_latest_changes(&prev_elements, &next_elements, None);
            if !latest.is_empty() {
                // emitted as a durable increment for sync; `is_history` keeps it out of the stacks
                store.schedule_micro_change(action, change, Some(latest.clone()));
                delta = latest;
            }
            prev_snapshot = next_snapshot;
            let entry = StoreDelta {
                is_history: true,
                ..delta.inverse()
            };
            if undo {
                self.redo_stack.push(entry)
            } else {
                self.undo_stack.push(entry)
            }
            if visible {
                break;
            }
            match pop(self) {
                Some(d) => delta = d,
                None => break,
            }
        }
        let mut out = next_elements.into_vec();
        order_by_fractional_index(&mut out);
        Some((out, next_app))
    }
}
