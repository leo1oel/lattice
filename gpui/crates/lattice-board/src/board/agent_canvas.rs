//! The Agent's canvas tools on the native board: `list`, `create`, `update`
//! and `delete` in the tldraw-era wire format Synara's tools declare, run
//! as the Tauri board's adapter runs them (`src/agent/agent-canvas-excalidraw-
//! adapter.ts`): the same checks in the same order, the same messages and
//! the same results, so the Agent sees one board whichever app hosts it.
//!
//! A call works on a copy of the scene and hands back the whole scene to
//! commit, or an error and nothing: a call that fails part-way changes
//! nothing. Differs: a linear shape's `width` / `height` are its points'
//! extent (Excalidraw's restore leaves a new stroke's at 0), an arrow binds
//! to its shape the native way (a fixed point, `orbit`), and a label is
//! re-centred in its container whenever the container changes.

mod wire;

use rustc_hash::FxHashSet;
use serde_json::{Map, Value, json};

use crate::board::binding::{BindingStore, bind_binding_element, unbind_binding_element};
use crate::board::consts::font_family::NUNITO;
use crate::board::mutate::mutate_element;
use crate::board::new_element::{
    ElementOpts, TextOpts, new_arrow_element, new_element, new_frame_element,
    new_free_draw_element, new_linear_element, new_text_element,
};
use crate::board::random::random_id;
use crate::board::text::redraw_text_bounding_box;
use crate::board::text_measure::Measure;
use crate::board::types::{
    Arrowhead, BindMode, BoundElement, BoundType, Element, ElementType, FillStyle, Kind,
    StartOrEnd, TextAlign, VerticalAlign,
};
use wire::*;

const MAX_SHAPES_PER_CALL: usize = 100;
const MAX_ARGUMENT_BYTES: usize = 512 * 1024;
const MAX_RESULT_BYTES: usize = 400 * 1024;
const FONT_SIZE: f64 = 20.;

/// A call's failure: the envelope's `error.code` and `error.message`.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    fn failed(message: impl Into<String>) -> Self {
        ToolError {
            code: "canvas_tool_failed",
            message: message.into(),
        }
    }
}

/// Runs `action` on `scene` (z-order, deleted elements included): its result,
/// and the scene to commit as one undoable step when it wrote. A board that
/// can't be written (`!writable`) still lists.
pub fn execute(
    scene: &[Element],
    action: &str,
    args: &Map<String, Value>,
    writable: bool,
    m: &dyn Measure,
) -> Result<(Value, Option<Vec<Element>>), ToolError> {
    let size = serde_json::to_string(args).map_or(0, |s| js_len(&s));
    if size > MAX_ARGUMENT_BYTES {
        return Err(ToolError::failed("Canvas tool arguments are too large."));
    }
    if action == "list" {
        return list(scene, args).map(|result| (result, None));
    }
    if !writable {
        return Err(ToolError {
            code: "canvas_read_only",
            message: "The active canvas is read-only.".into(),
        });
    }
    let mut els = scene.to_vec();
    let result = match action {
        "create" => create(&mut els, args, m)?,
        "update" => {
            let inputs = shape_array(args)?;
            for input in &inputs {
                update(&mut els, input, m)?;
            }
            let ids = inputs
                .iter()
                .map(|i| element_id(i.get("id").unwrap_or(&Value::Null)))
                .collect::<Result<Vec<_>, _>>()?;
            json!({ "shapes": projected(&els, &ids)? })
        }
        _ => delete(&mut els, args)?,
    };
    Ok((result, Some(els)))
}

fn list(scene: &[Element], args: &Map<String, Value>) -> Result<Value, ToolError> {
    let offset = bounded_number(args, "offset", 0., 9_007_199_254_740_991.)?.unwrap_or(0.);
    let limit = bounded_number(args, "limit", 1., 20.)?.unwrap_or(20.);
    if offset.fract() != 0. || limit.fract() != 0. {
        return Err(ToolError::failed("offset and limit must be integers."));
    }
    let (offset, limit) = (offset as usize, limit as usize);
    let all: Vec<&Element> = scene
        .iter()
        .filter(|e| !e.is_deleted && !is_label(e))
        .collect();
    let shapes: Vec<Value> = all
        .iter()
        .skip(offset)
        .take(limit)
        .map(|e| project(e, label(scene, e)))
        .collect();
    let end = offset.saturating_add(limit);
    let result = json!({
        "shapes": shapes,
        "offset": offset,
        "nextOffset": end.min(all.len()),
        "hasMore": end < all.len(),
        "total": all.len(),
    });
    if js_len(&result.to_string()) > MAX_RESULT_BYTES {
        return Err(ToolError::failed(
            "Canvas result is too large; request a smaller page.",
        ));
    }
    Ok(result)
}

fn shape_array(args: &Map<String, Value>) -> Result<Vec<&Input>, ToolError> {
    let shapes = args
        .get("shapes")
        .and_then(Value::as_array)
        .filter(|s| (1..=MAX_SHAPES_PER_CALL).contains(&s.len()))
        .ok_or_else(|| {
            ToolError::failed(format!(
                "shapes must contain between 1 and {MAX_SHAPES_PER_CALL} items."
            ))
        })?;
    shapes
        .iter()
        .map(Value::as_object)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| ToolError::failed("Every shape must be an object."))
}

fn find<'a>(els: &'a [Element], id: &str) -> Option<&'a Element> {
    els.iter().find(|e| e.id == id)
}

fn edit(els: &mut Vec<Element>, id: &str, mut f: impl FnMut(&mut Element)) {
    BindingStore::update(els, id, &mut f);
}

/// A container's label, while it has one.
fn label<'a>(els: &'a [Element], element: &Element) -> Option<&'a Element> {
    let bound = element
        .bound_elements
        .as_ref()?
        .iter()
        .find(|b| b.kind == BoundType::Text)?;
    find(els, &bound.id).filter(|t| t.is_text() && !t.is_deleted)
}

fn existing<'a>(els: &'a [Element], id: &str) -> Result<&'a Element, ToolError> {
    find(els, id)
        .filter(|e| !e.is_deleted && !is_label(e))
        .ok_or_else(|| ToolError::failed(format!("Canvas shape not found: {}", wire_id(id))))
}

fn assert_unlocked(els: &[Element], element: &Element) -> Result<(), ToolError> {
    let frame = element.frame_id.as_deref().and_then(|f| find(els, f));
    if element.locked || frame.is_some_and(|f| f.locked) {
        return Err(ToolError::failed(format!(
            "Canvas shape is locked: {}",
            wire_id(&element.id)
        )));
    }
    Ok(())
}

fn projected(els: &[Element], ids: &[String]) -> Result<Vec<Value>, ToolError> {
    ids.iter()
        .map(|id| existing(els, id).map(|e| project(e, label(els, e))))
        .collect()
}

/// The frame `frameId` names: `Some(None)` takes the shape out of its frame.
fn frame_of(els: &[Element], input: &Input) -> Result<Option<Option<String>>, ToolError> {
    match input.get("frameId") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => {
            let id = element_id(value)?;
            let frame = find(els, &id).filter(|f| !f.is_deleted).ok_or_else(|| {
                ToolError::failed(format!("Canvas shape not found: {}", wire_id(&id)))
            })?;
            if !frame.is_frame() {
                return Err(ToolError::failed(format!("Not a frame: {}", wire_id(&id))));
            }
            Ok(Some(Some(id)))
        }
    }
}

fn text_opts(text: &str) -> TextOpts {
    TextOpts {
        text: text.into(),
        font_size: Some(FONT_SIZE),
        font_family: Some(NUNITO),
        ..Default::default()
    }
}

/// `container`'s new label (not yet bound or placed).
fn new_label(container: &Element, text: &str, ink: String, m: &dyn Measure) -> Element {
    let opts = TextOpts {
        text_align: Some(TextAlign::Center),
        vertical_align: Some(VerticalAlign::Middle),
        container_id: Some(container.id.clone()),
        ..text_opts(text)
    };
    let base = ElementOpts {
        x: container.x,
        y: container.y,
        stroke_color: ink,
        roughness: 0.,
        frame_id: container.frame_id.clone(),
        ..Default::default()
    };
    new_text_element(opts, base, m)
}

/// Binds `label` (already in `els`) to its container and lays it out there.
fn attach(els: &mut Vec<Element>, container_id: &str, label: &Element, m: &dyn Measure) {
    let bound = BoundElement {
        id: label.id.clone(),
        kind: BoundType::Text,
    };
    edit(els, container_id, |e| {
        e.bound_elements
            .get_or_insert_with(Vec::new)
            .push(bound.clone())
    });
    redraw_text_bounding_box(els, label, Some(container_id), m);
}

/// The new element, then its label when it has one, for one create input.
fn created(input: &Input, m: &dyn Measure) -> Result<Vec<Element>, ToolError> {
    let wire = input
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::failed("Each new shape requires a type."))?;
    let ty = shape_type(wire)
        .ok_or_else(|| ToolError::failed(format!("Unsupported canvas shape type: {wire}")))?;
    let id = match input.get("id") {
        None => random_id(),
        Some(value) => element_id(value)?,
    };
    let text = text_of(input, ty)?;
    let place = placement(input)?;
    let colors = paint(input, ty, None)?;
    let mut o = ElementOpts {
        id: Some(id),
        x: place.x.unwrap_or(0.),
        y: place.y.unwrap_or(0.),
        angle: place.angle.unwrap_or(0.),
        locked: place.locked.unwrap_or(false),
        roughness: 0.,
        stroke_width: 2.,
        ..Default::default()
    };
    if let Some(opacity) = place.opacity {
        o.opacity = opacity;
    }
    if let Some(stroke) = &colors.stroke {
        o.stroke_color = stroke.clone();
    }
    if let Some(background) = &colors.background {
        o.background_color = background.clone();
    }
    if let Some(fill) = colors.fill_style {
        o.fill_style = fill;
    }
    let element = if is_linear(ty) {
        let straight = vec![[0., 0.], [place.width.unwrap_or(100.), 0.]];
        let points = match points_of(input)? {
            Some(points) => points,
            None if matches!(ty, "arrow" | "line") => straight,
            None => return Err(ToolError::failed(POINTS_ERROR)),
        };
        let points = fit_points(&points, place.width, place.height);
        [o.width, o.height] = extent(&points);
        match ty {
            "draw" | "highlight" => {
                if ty == "highlight" {
                    o.stroke_color = colors.stroke.clone().unwrap_or_else(|| "#ffd43b".into());
                    o.opacity = 50.;
                    o.stroke_width = 4.;
                    o.custom_data = Some(json!({ "latticeShape": "highlight" }));
                }
                return Ok(vec![new_free_draw_element(o, points, vec![], true, None)]);
            }
            "arrow" => new_arrow_element(o, points, None, Some(Arrowhead::Arrow), false, None),
            _ => new_linear_element(o, points, None),
        }
    } else if ty == "text" {
        return Ok(vec![new_text_element(
            text_opts(text.as_deref().unwrap_or("")),
            o,
            m,
        )]);
    } else if ty == "frame" {
        o.width = place.width.unwrap_or(400.);
        o.height = place.height.unwrap_or(300.);
        return Ok(vec![new_frame_element(o, text)]);
    } else {
        let note = ty == "note";
        if note {
            o.background_color = colors.background.clone().unwrap_or_else(|| NOTE.into());
            o.fill_style = FillStyle::Solid;
            o.stroke_color = "transparent".into();
            o.custom_data = Some(json!({ "latticeShape": "note" }));
        }
        o.width = place.width.unwrap_or(if note { 200. } else { 160. });
        o.height = place.height.unwrap_or(if note { 200. } else { 100. });
        let kind = match ty {
            "ellipse" => ElementType::Ellipse,
            "diamond" => ElementType::Diamond,
            _ => ElementType::Rectangle,
        };
        new_element(kind, o)
    };
    let mut made = vec![element];
    if let Some(text) = text.filter(|t| !t.is_empty()) {
        let container = &made[0];
        let ink = if lattice_shape(container) == Some("note") {
            INK.into()
        } else {
            container.stroke_color.clone()
        };
        let label = new_label(container, &text, ink, m);
        let id = container.id.clone();
        made.push(label.clone());
        attach(&mut made, &id, &label, m);
    }
    Ok(made)
}

fn create(
    els: &mut Vec<Element>,
    args: &Map<String, Value>,
    m: &dyn Measure,
) -> Result<Value, ToolError> {
    let inputs = shape_array(args)?;
    let made = inputs
        .iter()
        .map(|input| created(input, m))
        .collect::<Result<Vec<_>, _>>()?;
    let ids: Vec<String> = made.iter().map(|group| group[0].id.clone()).collect();
    if ids.iter().collect::<FxHashSet<_>>().len() != ids.len() {
        return Err(ToolError::failed("Canvas shape ids must be unique."));
    }
    if let Some(id) = ids.iter().find(|id| find(els, id).is_some()) {
        return Err(ToolError::failed(format!(
            "Canvas shape already exists: {}",
            wire_id(id)
        )));
    }
    for group in &made {
        els.extend(group.iter().cloned());
    }
    for (input, group) in inputs.iter().zip(&made) {
        if let Some(Some(frame)) = frame_of(els, input)? {
            for element in group {
                edit(els, &element.id, |e| e.frame_id = Some(frame.clone()));
            }
        }
        bind(
            els,
            &group[0].id,
            StartOrEnd::Start,
            input.get("startBinding"),
        )?;
        bind(els, &group[0].id, StartOrEnd::End, input.get("endBinding"))?;
    }
    Ok(json!({ "shapes": projected(els, &ids)? }))
}

/// Points the arrow's end `s` at a shape (`null` unbinds it), keeping both
/// sides' records.
fn bind(
    els: &mut Vec<Element>,
    arrow_id: &str,
    s: StartOrEnd,
    value: Option<&Value>,
) -> Result<(), ToolError> {
    let Some(value) = value else {
        return Ok(());
    };
    if !find(els, arrow_id).is_some_and(Element::is_arrow) {
        return Err(ToolError::failed("Only arrows bind to shapes."));
    }
    if value.is_null() {
        unbind_binding_element(arrow_id, s, els);
        return Ok(());
    }
    let id = element_id(value)?;
    if !find(els, &id).is_some_and(|t| !t.is_deleted && !is_label(t)) {
        return Err(ToolError::failed(format!(
            "Canvas shape not found: {}",
            wire_id(&id)
        )));
    }
    unbind_binding_element(arrow_id, s, els);
    bind_binding_element(
        arrow_id,
        &id,
        BindMode::Orbit,
        s,
        els,
        1.,
        None,
        false,
        false,
    );
    Ok(())
}

/// One update input's changes, written into `els`.
fn update(els: &mut Vec<Element>, input: &Input, m: &dyn Measure) -> Result<(), ToolError> {
    let id = element_id(input.get("id").unwrap_or(&Value::Null))?;
    let current = existing(els, &id)?.clone();
    assert_unlocked(els, &current)?;
    if input.contains_key("type") {
        return Err(ToolError::failed("A shape's type cannot be changed."));
    }
    let ty = wire_type(&current);
    let text = text_of(input, &ty)?;
    let place = placement(input)?;
    let colors = paint(input, &ty, Some(&current))?;
    let points = match current.points() {
        Some(now) => {
            let given = points_of(input)?;
            (given.is_some() || place.width.is_some() || place.height.is_some())
                .then(|| fit_points(given.as_deref().unwrap_or(now), place.width, place.height))
        }
        None => None,
    };
    let frame = frame_of(els, input)?;
    let measured = match (current.text(), &text) {
        (Some(t), Some(new)) => {
            let opts = TextOpts {
                font_size: Some(t.font_size),
                font_family: Some(t.font_family),
                ..text_opts(new)
            };
            let sized = new_text_element(opts, ElementOpts::default(), m);
            Some((sized.width, sized.height))
        }
        _ => None,
    };
    edit(els, &id, |e| {
        e.x = place.x.unwrap_or(e.x);
        e.y = place.y.unwrap_or(e.y);
        e.angle = place.angle.unwrap_or(e.angle);
        e.opacity = place.opacity.unwrap_or(e.opacity);
        e.locked = place.locked.unwrap_or(e.locked);
        if let Some(stroke) = &colors.stroke {
            e.stroke_color = stroke.clone();
        }
        if let Some(background) = &colors.background {
            e.background_color = background.clone();
        }
        if let Some(fill) = colors.fill_style {
            e.fill_style = fill;
        }
        if let Some(points) = &points {
            [e.width, e.height] = extent(points);
            if let Some(p) = e.points_mut() {
                *p = points.clone();
            }
        } else if e.points().is_none() {
            e.width = place.width.unwrap_or(e.width);
            e.height = place.height.unwrap_or(e.height);
        }
        if let Some(frame) = &frame {
            e.frame_id = frame.clone();
        }
        if let (Some((w, h)), Some(new)) = (measured, &text) {
            e.width = w;
            e.height = h;
            if let Some(t) = e.text_mut() {
                t.text = new.clone();
                t.original_text = new.clone();
            }
        }
        if let (Kind::Frame { name }, Some(new)) = (&mut e.kind, &text) {
            *name = Some(new.clone());
        }
    });
    let old = label(els, &current).map(|l| l.id.clone());
    match text.filter(|_| !current.is_text() && !current.is_frame()) {
        Some(new) => {
            if let Some(old) = &old {
                edit(els, old, |e| e.is_deleted = true);
            }
            edit(els, &id, |e| {
                if let Some(bound) = &mut e.bound_elements {
                    bound.retain(|b| b.kind != BoundType::Text)
                }
            });
            if !new.is_empty() {
                let container = existing(els, &id)?.clone();
                let ink = if lattice_shape(&container) == Some("note") {
                    INK.into()
                } else {
                    container.stroke_color.clone()
                };
                let label = new_label(&container, &new, ink, m);
                els.push(label.clone());
                attach(els, &id, &label, m);
            }
        }
        None => {
            if let Some(old) = old {
                let frame = existing(els, &id)?.frame_id.clone();
                edit(els, &old, |e| e.frame_id = frame.clone());
                let label = find(els, &old).cloned();
                if let Some(label) = label {
                    redraw_text_bounding_box(els, &label, Some(&id), m);
                }
            }
        }
    }
    bind(els, &id, StartOrEnd::Start, input.get("startBinding"))?;
    bind(els, &id, StartOrEnd::End, input.get("endBinding"))?;
    Ok(())
}

fn delete(els: &mut Vec<Element>, args: &Map<String, Value>) -> Result<Value, ToolError> {
    let ids = args
        .get("ids")
        .and_then(Value::as_array)
        .filter(|ids| (1..=MAX_SHAPES_PER_CALL).contains(&ids.len()))
        .ok_or_else(|| {
            ToolError::failed(format!(
                "ids must contain between 1 and {MAX_SHAPES_PER_CALL} shape ids."
            ))
        })?
        .iter()
        .map(element_id)
        .collect::<Result<Vec<_>, _>>()?;
    let gone: FxHashSet<String> = ids.iter().cloned().collect();
    if gone.len() != ids.len() {
        return Err(ToolError::failed("Canvas shape ids must be unique."));
    }
    let doomed = ids
        .iter()
        .map(|id| existing(els, id).cloned())
        .collect::<Result<Vec<_>, _>>()?;
    for element in &doomed {
        assert_unlocked(els, element)?;
    }
    let labels: Vec<String> = doomed
        .iter()
        .filter_map(|e| label(els, e).map(|l| l.id.clone()))
        .collect();
    for id in ids.iter().chain(&labels) {
        edit(els, id, |e| e.is_deleted = true);
    }
    // arrows pointing at a deleted shape come unbound, and shapes forget
    // deleted arrows
    for element in els.iter_mut() {
        if gone.contains(&element.id) || element.is_deleted {
            continue;
        }
        mutate_element(element, |e| {
            if let Some(linear) = e.linear_mut() {
                for end in [&mut linear.start_binding, &mut linear.end_binding] {
                    if end.as_ref().is_some_and(|b| gone.contains(&b.element_id)) {
                        *end = None;
                    }
                }
            }
            if let Some(bound) = &mut e.bound_elements {
                bound.retain(|b| !gone.contains(&b.id));
            }
        });
    }
    let deleted: Vec<String> = ids.iter().map(|id| wire_id(id)).collect();
    Ok(json!({ "deletedIds": deleted }))
}

#[cfg(test)]
mod tests;
