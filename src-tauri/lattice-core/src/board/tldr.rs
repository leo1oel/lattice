//! `.tldr` → `.excalidraw`: the one-time migration of a tldraw board.
//!
//! Each tldraw page becomes an Excalidraw frame named after it, the pages laid
//! out left to right; a board with one page keeps its shapes where they are,
//! with no frame around them. Shapes keep their tldraw ids (without the
//! `shape:` prefix) and every seed derives from its id, so converting the same
//! board twice gives the same bytes. Rich text degrades to plain text.

mod content;
mod shapes;
mod style;

use super::scene::{
    fractional_index, round, stable_seed, BinaryFile, BoundElement, Element, Kind, Scene,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::f64::consts::TAU;

/// Space around a page's shapes inside its frame.
const PAGE_PADDING: f64 = 80.;
/// Space between two pages' frames.
const PAGE_GAP: f64 = 200.;
/// The frame of a page with no shapes.
const EMPTY_PAGE: (f64, f64) = (800., 600.);

const NOT_A_BOARD: &str = "This file is not a tldraw board Lattice can convert.";

/// Reads an image a board refers to by a path relative to the board's folder.
pub type AssetReader<'a> = dyn Fn(&str) -> Option<Vec<u8>> + 'a;

/// Convert `.tldr` text into an Excalidraw scene. Images referenced by path
/// are read through `read_asset` and inlined into the scene's `files`.
/// An empty file (a board never drawn on) is an empty scene.
pub fn convert_tldr(source: &str, read_asset: &AssetReader<'_>) -> Result<Scene, String> {
    if source.trim().is_empty() {
        return Ok(Scene::default());
    }
    let value: Value = serde_json::from_str(source).map_err(|_| NOT_A_BOARD.to_string())?;
    let records = value.get("records").and_then(Value::as_array).ok_or(NOT_A_BOARD)?;
    let mut converter = Converter { doc: Doc::new(records), read_asset, files: BTreeMap::new() };
    let elements = converter.pages();
    Ok(Scene { elements, files: converter.files, ..Scene::default() })
}

/// The board's records, indexed for the walk.
struct Doc<'a> {
    pages: Vec<&'a Value>,
    shapes: BTreeMap<&'a str, &'a Value>,
    /// Each parent's children in tldraw's z-order (`index`, then id).
    children: BTreeMap<&'a str, Vec<&'a Value>>,
    bindings: Vec<&'a Value>,
    assets: BTreeMap<&'a str, &'a Value>,
}

fn record_id(record: &Value) -> &str {
    record.get("id").and_then(Value::as_str).unwrap_or_default()
}

fn order_key(record: &Value) -> (&str, &str) {
    (record.get("index").and_then(Value::as_str).unwrap_or_default(), record_id(record))
}

impl<'a> Doc<'a> {
    fn new(records: &'a [Value]) -> Self {
        let mut doc = Doc {
            pages: Vec::new(),
            shapes: BTreeMap::new(),
            children: BTreeMap::new(),
            bindings: Vec::new(),
            assets: BTreeMap::new(),
        };
        for record in records {
            match record.get("typeName").and_then(Value::as_str) {
                Some("page") => doc.pages.push(record),
                Some("shape") => {
                    doc.shapes.insert(record_id(record), record);
                    let parent = record.get("parentId").and_then(Value::as_str).unwrap_or_default();
                    doc.children.entry(parent).or_default().push(record);
                }
                Some("binding") => doc.bindings.push(record),
                Some("asset") => {
                    doc.assets.insert(record_id(record), record);
                }
                _ => {}
            }
        }
        doc.pages.sort_by(|a, b| order_key(a).cmp(&order_key(b)));
        for children in doc.children.values_mut() {
            children.sort_by(|a, b| order_key(a).cmp(&order_key(b)));
        }
        doc
    }

    fn children(&self, parent: &str) -> &[&'a Value] {
        self.children.get(parent).map(Vec::as_slice).unwrap_or_default()
    }
}

/// A translation then a rotation: where a tldraw shape's local space sits on
/// the page.
#[derive(Clone, Copy, Debug)]
pub(super) struct Xform {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

impl Xform {
    const PAGE: Xform = Xform { x: 0., y: 0., rotation: 0. };

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let (sin, cos) = self.rotation.sin_cos();
        (self.x + x * cos - y * sin, self.y + x * sin + y * cos)
    }

    /// Page space to this transform's local space.
    pub fn invert(&self, x: f64, y: f64) -> (f64, f64) {
        let (sin, cos) = self.rotation.sin_cos();
        let (dx, dy) = (x - self.x, y - self.y);
        (dx * cos + dy * sin, -dx * sin + dy * cos)
    }

    /// A child placed at (`x`, `y`) and turned by `rotation` in this space.
    pub fn then(&self, x: f64, y: f64, rotation: f64) -> Xform {
        let (x, y) = self.apply(x, y);
        Xform { x, y, rotation: self.rotation + rotation }
    }
}

/// What a shape inherits from its ancestors: the Excalidraw frame it belongs
/// to, its groups (innermost first) and its opacity.
#[derive(Clone, Debug)]
pub(super) struct Placement {
    pub frame_id: Option<String>,
    pub group_ids: Vec<String>,
    pub opacity: f64,
}

pub(super) struct Converter<'a> {
    doc: Doc<'a>,
    read_asset: &'a AssetReader<'a>,
    files: BTreeMap<String, BinaryFile>,
}

/// A tldraw id without its record-type prefix.
pub(super) fn bare_id(id: &str) -> String {
    id.split_once(':').map_or(id, |(_, rest)| rest).to_string()
}

impl<'a> Converter<'a> {
    fn pages(&mut self) -> Vec<Element> {
        let pages = self.doc.pages.clone();
        let framed = pages.len() > 1;
        let mut elements = Vec::new();
        let mut next: Option<(f64, f64)> = None;
        for page in pages {
            let frame_id = framed.then(|| format!("page-{}", bare_id(record_id(page))));
            let place =
                Placement { frame_id: frame_id.clone(), group_ids: Vec::new(), opacity: 1. };
            let mut page_elements = Vec::new();
            for child in self.doc.children(record_id(page)).to_vec() {
                self.shape(child, Xform::PAGE, &place, &mut page_elements);
            }
            let Some(frame_id) = frame_id else {
                elements.extend(page_elements);
                continue;
            };
            let (x, y, width, height) = bounds(&page_elements).map_or(
                (0., 0., EMPTY_PAGE.0, EMPTY_PAGE.1),
                |(left, top, right, bottom)| {
                    (
                        left - PAGE_PADDING,
                        top - PAGE_PADDING,
                        right - left + 2. * PAGE_PADDING,
                        bottom - top + 2. * PAGE_PADDING,
                    )
                },
            );
            let (frame_x, frame_y) = next.unwrap_or((x, y));
            for element in &mut page_elements {
                element.x += frame_x - x;
                element.y += frame_y - y;
            }
            elements.extend(page_elements);
            let name = page.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            let mut frame = self.element(
                frame_id,
                "frame",
                &Placement { frame_id: None, ..place },
                Kind::Frame { name: Some(name) },
            );
            (frame.x, frame.y, frame.width, frame.height) = (frame_x, frame_y, width, height);
            frame.stroke_color = "#bbb".to_string();
            elements.push(frame);
            next = Some((frame_x + width + PAGE_GAP, next.map_or(frame_y, |(_, top)| top)));
        }
        link_arrow_bindings(&mut elements);
        for (number, element) in elements.iter_mut().enumerate() {
            element.index = fractional_index(number);
            tidy(element);
        }
        elements
    }

    /// A new element with Excalidraw's defaults, Lattice's clean stroke
    /// (roughness 0) and seeds derived from its id.
    pub fn element(
        &self, id: String, kind_name: &'static str, place: &Placement, kind: Kind,
    ) -> Element {
        Element {
            seed: stable_seed(&id),
            version_nonce: stable_seed(&format!("{id}#nonce")),
            id,
            kind_name,
            x: 0.,
            y: 0.,
            width: 0.,
            height: 0.,
            angle: 0.,
            stroke_color: "#1e1e1e".to_string(),
            background_color: "transparent".to_string(),
            fill_style: "solid",
            stroke_width: 2.,
            stroke_style: "solid",
            roughness: 0.,
            opacity: 100. * place.opacity,
            group_ids: place.group_ids.clone(),
            frame_id: place.frame_id.clone(),
            index: String::new(),
            roundness: None,
            version: 1,
            is_deleted: false,
            bound_elements: None,
            updated: 1,
            link: None,
            locked: false,
            kind,
        }
    }

    pub fn asset(&self, id: &str) -> Option<&Value> {
        self.doc.assets.get(id).copied()
    }

    pub fn bindings_from(&self, arrow_id: &str) -> Vec<&Value> {
        self.doc
            .bindings
            .iter()
            .copied()
            .filter(|binding| binding.get("fromId").and_then(Value::as_str) == Some(arrow_id))
            .collect()
    }

    pub fn shape_record(&self, id: &str) -> Option<&'a Value> {
        self.doc.shapes.get(id).copied()
    }

    pub fn shape_children(&self, id: &str) -> Vec<&'a Value> {
        self.doc.children(id).to_vec()
    }

    /// Where a shape's local space sits on its page.
    pub fn page_xform(&self, shape: &Value) -> Xform {
        let parent = shape
            .get("parentId")
            .and_then(Value::as_str)
            .and_then(|parent| self.doc.shapes.get(parent))
            .map_or(Xform::PAGE, |parent| self.page_xform(parent));
        let number = |key| shape.get(key).and_then(Value::as_f64).unwrap_or(0.);
        parent.then(number("x"), number("y"), number("rotation"))
    }

    /// Inline an image's bytes into the scene's files; returns its `fileId`.
    pub fn add_file(&mut self, mime_type: String, data_url: String) -> String {
        use sha1::{Digest, Sha1};
        let id = Sha1::digest(data_url.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.files.entry(id.clone()).or_insert_with(|| BinaryFile {
            mime_type,
            id: id.clone(),
            data_url,
            created: 1,
            last_retrieved: 1,
        });
        id
    }

    pub fn read_image(&self, src: &str) -> Option<(String, String)> {
        content::image_data_url(src, self.read_asset)
    }
}

/// An element's axis-aligned box on the page: (left, top, right, bottom).
fn element_box(element: &Element) -> (f64, f64, f64, f64) {
    let corners: Vec<(f64, f64)> = match &element.kind {
        Kind::Linear { points, .. } | Kind::FreeDraw { points, .. } => {
            points.iter().map(|[x, y]| (element.x + x, element.y + y)).collect()
        }
        _ => {
            let (cx, cy) = (element.x + element.width / 2., element.y + element.height / 2.);
            let center = Xform { x: cx, y: cy, rotation: element.angle };
            let (w, h) = (element.width / 2., element.height / 2.);
            vec![center.apply(-w, -h), center.apply(w, -h), center.apply(w, h), center.apply(-w, h)]
        }
    };
    corners.iter().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |(l, t, r, b), &(x, y)| {
        (l.min(x), t.min(y), r.max(x), b.max(y))
    })
}

fn bounds(elements: &[Element]) -> Option<(f64, f64, f64, f64)> {
    elements
        .iter()
        .map(element_box)
        .reduce(|(l, t, r, b), (l2, t2, r2, b2)| (l.min(l2), t.min(t2), r.max(r2), b.max(b2)))
}

/// List each bound arrow on the element it binds to, as Excalidraw expects,
/// and drop bindings to shapes that did not survive the conversion.
fn link_arrow_bindings(elements: &mut [Element]) {
    let positions: BTreeMap<String, usize> =
        elements.iter().enumerate().map(|(number, element)| (element.id.clone(), number)).collect();
    for number in 0..elements.len() {
        let arrow_id = elements[number].id.clone();
        let Kind::Linear { start_binding, end_binding, .. } = &mut elements[number].kind else {
            continue;
        };
        let mut targets = Vec::new();
        for binding in [start_binding, end_binding] {
            match binding.as_ref().and_then(|bound| positions.get(&bound.element_id)) {
                Some(&target) => targets.push(target),
                None => *binding = None,
            }
        }
        for target in targets {
            let bound = elements[target].bound_elements.get_or_insert_with(Vec::new);
            if !bound.iter().any(|entry| entry.id == arrow_id) {
                bound.push(BoundElement { id: arrow_id.clone(), kind: "arrow" });
            }
        }
    }
}

/// Round what the conversion computed, so files stay small and stable.
fn tidy(element: &mut Element) {
    element.x = round(element.x);
    element.y = round(element.y);
    element.width = round(element.width);
    element.height = round(element.height);
    element.opacity = element.opacity.round();
    element.angle = (element.angle.rem_euclid(TAU) * 1e6).round() / 1e6;
    if element.angle >= TAU - 1e-6 {
        element.angle = 0.;
    }
    if let Kind::Linear { points, .. } | Kind::FreeDraw { points, .. } = &mut element.kind {
        for point in points.iter_mut() {
            *point = [round(point[0]), round(point[1])];
        }
    }
    if let Kind::FreeDraw { pressures, .. } = &mut element.kind {
        for pressure in pressures.iter_mut() {
            *pressure = round(*pressure);
        }
    }
}
