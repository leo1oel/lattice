//! One tldraw shape at a time, onto Excalidraw elements.

use super::content::{plain_text, segment_points};
use super::style::{
    arrowhead, fill, font, font_size, geo_type, highlight_color, number_prop, stroke_color,
    stroke_style, stroke_width, text_align, text_prop, tint, vertical_align,
};
use super::{bare_id, Converter, Placement, Xform};
use crate::board::scene::{
    line_height, measure, wrap, BoundElement, Element, ImageCrop, Kind, PointBinding,
    BOUND_TEXT_PADDING, PROPORTIONAL_RADIUS,
};
use serde_json::Value;
use std::f64::consts::SQRT_2;

/// tldraw's sticky note side, before its scale.
const NOTE_SIZE: f64 = 200.;
/// How far a converted arrow stops short of the shape it binds to.
const BINDING_GAP: f64 = 4.;
/// The colour of placeholders for what Excalidraw cannot show.
const PLACEHOLDER_COLOR: &str = "#868e96";

/// How a label is set inside its container.
struct LabelStyle {
    font_size: f64,
    family: u32,
    align: &'static str,
    vertical_align: &'static str,
    color: String,
    /// An arrow label's centre; boxes centre theirs on themselves.
    anchor: Option<(f64, f64)>,
}

/// The outline an arrow binds to, in the bound shape's local space.
struct Outline {
    xform: Xform,
    width: f64,
    height: f64,
    kind: &'static str,
}

impl Outline {
    fn contains(&self, x: f64, y: f64) -> bool {
        let (x, y) = self.xform.invert(x, y);
        let (rx, ry) = (self.width / 2., self.height / 2.);
        let (dx, dy) = ((x - rx) / rx.max(1e-9), (y - ry) / ry.max(1e-9));
        match self.kind {
            "ellipse" => dx * dx + dy * dy <= 1.,
            "diamond" => dx.abs() + dy.abs() <= 1.,
            _ => dx.abs() <= 1. && dy.abs() <= 1.,
        }
    }

    /// Where the segment from `inside` towards `toward` leaves the outline,
    /// moved `BINDING_GAP` further out; `inside` itself when the segment
    /// never leaves it.
    fn exit(&self, inside: (f64, f64), toward: (f64, f64)) -> (f64, f64) {
        if !self.contains(inside.0, inside.1) || self.contains(toward.0, toward.1) {
            return inside;
        }
        let at =
            |t: f64| (inside.0 + (toward.0 - inside.0) * t, inside.1 + (toward.1 - inside.1) * t);
        let (mut low, mut high) = (0., 1.);
        for _ in 0..40 {
            let middle = (low + high) / 2.;
            let (x, y) = at(middle);
            if self.contains(x, y) {
                low = middle;
            } else {
                high = middle;
            }
        }
        let length = (toward.0 - inside.0).hypot(toward.1 - inside.1);
        at((high + BINDING_GAP / length.max(1e-9)).min(1.))
    }
}

/// Place a box element of `width` × `height` whose local top-left is the
/// origin of `xform`: Excalidraw rotates about the centre, tldraw about the
/// top-left corner.
fn place_box(element: &mut Element, xform: Xform, width: f64, height: f64) {
    let (cx, cy) = xform.apply(width / 2., height / 2.);
    element.x = cx - width / 2.;
    element.y = cy - height / 2.;
    element.width = width;
    element.height = height;
    element.angle = xform.rotation;
}

/// Points relative to the first, and the extent they span.
fn relative_points(element: &mut Element, points: &[(f64, f64)]) -> Vec<[f64; 2]> {
    let (x0, y0) = points.first().copied().unwrap_or_default();
    element.x = x0;
    element.y = y0;
    let relative: Vec<[f64; 2]> = points.iter().map(|(x, y)| [x - x0, y - y0]).collect();
    let extent = |axis: usize| {
        let values = relative.iter().map(|point| point[axis]);
        values.clone().fold(f64::MIN, f64::max) - values.fold(f64::MAX, f64::min)
    };
    if !relative.is_empty() {
        element.width = extent(0);
        element.height = extent(1);
    }
    relative
}

fn point_prop(props: &Value, key: &str) -> (f64, f64) {
    let point = props.get(key).unwrap_or(&Value::Null);
    (number_prop(point, "x", 0.), number_prop(point, "y", 0.))
}

impl Converter<'_> {
    pub(super) fn shape(
        &mut self, shape: &Value, parent: Xform, place: &Placement, out: &mut Vec<Element>,
    ) {
        let full_id = shape.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let id = bare_id(&full_id);
        let props = shape.get("props").cloned().unwrap_or(Value::Null);
        let number = |key| shape.get(key).and_then(Value::as_f64).unwrap_or(0.);
        let xform = parent.then(number("x"), number("y"), number("rotation"));
        let place = Placement {
            opacity: place.opacity * number_prop(shape, "opacity", 1.),
            ..place.clone()
        };
        let first = out.len();
        match shape.get("type").and_then(Value::as_str).unwrap_or_default() {
            "group" => {
                let mut inner = place.clone();
                inner.group_ids.insert(0, id);
                for child in self.shape_children(&full_id) {
                    self.shape(child, xform, &inner, out);
                }
            }
            "frame" => self.frame(&full_id, id, &props, xform, &place, out),
            "geo" => self.geo(id, &props, xform, &place, out),
            "note" => self.note(id, &props, xform, &place, out),
            "text" => self.text(id, &props, xform, &place, out),
            "arrow" => self.arrow(&full_id, id, &props, xform, &place, out),
            "line" => self.line(id, &props, xform, &place, out),
            "draw" | "highlight" => {
                self.stroke(id, &props, xform, &place, out, shape["type"] == "highlight")
            }
            "image" => self.image(id, &props, xform, &place, out),
            kind => self.placeholder(id, &props, xform, &place, out, kind),
        }
        if shape.get("isLocked") == Some(&Value::Bool(true)) {
            for element in &mut out[first..] {
                element.locked = true;
            }
        }
    }

    fn frame(
        &mut self, full_id: &str, id: String, props: &Value, xform: Xform, place: &Placement,
        out: &mut Vec<Element>,
    ) {
        let inner = Placement { frame_id: Some(id.clone()), ..place.clone() };
        for child in self.shape_children(full_id) {
            self.shape(child, xform, &inner, out);
        }
        // Excalidraw frames neither nest nor group.
        let outer = Placement { frame_id: None, group_ids: Vec::new(), opacity: place.opacity };
        let name = text_prop(props, "name", "");
        let name = (!name.is_empty()).then(|| name.to_string());
        let mut frame = self.element(id, "frame", &outer, Kind::Frame { name });
        place_box(&mut frame, xform, number_prop(props, "w", 160.), number_prop(props, "h", 90.));
        frame.stroke_color = "#bbb".to_string();
        out.push(frame);
    }

    fn geo(
        &mut self, id: String, props: &Value, xform: Xform, place: &Placement,
        out: &mut Vec<Element>,
    ) {
        let color = text_prop(props, "color", "black");
        let mut element =
            self.element(id, geo_type(text_prop(props, "geo", "rectangle")), place, Kind::Shape {});
        let height = number_prop(props, "h", 100.) + number_prop(props, "growY", 0.);
        place_box(&mut element, xform, number_prop(props, "w", 100.), height);
        element.stroke_color = stroke_color(color);
        (element.background_color, element.fill_style) =
            fill(text_prop(props, "fill", "none"), color);
        element.stroke_style = stroke_style(text_prop(props, "dash", "draw"));
        element.stroke_width = stroke_width(text_prop(props, "size", "m"));
        let url = text_prop(props, "url", "");
        element.link = (!url.is_empty()).then(|| url.to_string());
        out.push(element);
        self.label(out, plain_text(props), self.label_style(props, "middle"));
    }

    fn note(
        &mut self, id: String, props: &Value, xform: Xform, place: &Placement,
        out: &mut Vec<Element>,
    ) {
        let scale = number_prop(props, "scale", 1.);
        let mut element = self.element(id, "rectangle", place, Kind::Shape {});
        let side = NOTE_SIZE * scale;
        place_box(&mut element, xform, side, side + number_prop(props, "growY", 0.));
        element.stroke_color = "transparent".to_string();
        element.background_color = tint(text_prop(props, "color", "yellow"));
        out.push(element);
        self.label(out, plain_text(props), self.label_style(props, "middle"));
    }

    fn label_style(&self, props: &Value, default_vertical: &str) -> LabelStyle {
        LabelStyle {
            font_size: font_size(text_prop(props, "size", "m"), number_prop(props, "scale", 1.)),
            family: font(text_prop(props, "font", "draw")),
            align: text_align(text_prop(props, "align", "middle")),
            vertical_align: vertical_align(text_prop(props, "verticalAlign", default_vertical)),
            color: stroke_color(text_prop(props, "labelColor", "black")),
            anchor: None,
        }
    }

    /// Bind `text` to the last element of `out`, as Excalidraw's container
    /// text: wrapped to fit, and the container grown when it does not.
    fn label(&self, out: &mut Vec<Element>, text: String, style: LabelStyle) {
        if text.trim().is_empty() {
            return;
        }
        let container = out.last_mut().expect("a label follows its container");
        let padding = BOUND_TEXT_PADDING;
        let max_width = match container.kind_name {
            "ellipse" => (container.width / 2. * SQRT_2).round() - 2. * padding,
            "diamond" => (container.width / 2.).round() - 2. * padding,
            "arrow" => (container.width.hypot(container.height) * 0.7).max(style.font_size * 11.),
            _ => container.width - 2. * padding,
        }
        .max(style.font_size);
        let wrapped = wrap(&text, style.font_size, style.family, max_width);
        let (width, height) = measure(&wrapped, style.font_size, style.family);
        let (x, y) = match style.anchor {
            Some((x, y)) => (x - width / 2., y - height / 2.),
            None => {
                container.height = container.height.max(height + 2. * padding);
                let inset = (container.width - max_width) / 2.;
                let x = match style.align {
                    "left" => container.x + inset,
                    "right" => container.x + container.width - inset - width,
                    _ => container.x + (container.width - width) / 2.,
                };
                let y = match style.vertical_align {
                    "top" => container.y + padding,
                    "bottom" => container.y + container.height - padding - height,
                    _ => container.y + (container.height - height) / 2.,
                };
                (x, y)
            }
        };
        let label_id = format!("{}-label", container.id);
        container
            .bound_elements
            .get_or_insert_with(Vec::new)
            .push(BoundElement { id: label_id.clone(), kind: "text" });
        let place = Placement {
            frame_id: container.frame_id.clone(),
            group_ids: container.group_ids.clone(),
            opacity: container.opacity / 100.,
        };
        let (angle, container_id, locked) =
            (container.angle, container.id.clone(), container.locked);
        let mut label = self.element(
            label_id,
            "text",
            &place,
            Kind::Text {
                text: wrapped,
                font_size: style.font_size,
                font_family: style.family,
                text_align: style.align,
                vertical_align: style.vertical_align,
                container_id: Some(container_id),
                original_text: text,
                auto_resize: true,
                line_height: line_height(style.family),
            },
        );
        (label.x, label.y, label.width, label.height, label.angle, label.locked) =
            (x, y, width, height, angle, locked);
        label.stroke_color = style.color;
        out.push(label);
    }

    fn text(
        &mut self, id: String, props: &Value, xform: Xform, place: &Placement,
        out: &mut Vec<Element>,
    ) {
        let text = plain_text(props);
        if text.is_empty() {
            return;
        }
        let scale = number_prop(props, "scale", 1.);
        let size = font_size(text_prop(props, "size", "m"), scale);
        let family = font(text_prop(props, "font", "draw"));
        let auto_resize = props.get("autoSize") != Some(&Value::Bool(false));
        let fixed_width = number_prop(props, "w", 0.) * scale;
        let wrapped =
            if auto_resize { text.clone() } else { wrap(&text, size, family, fixed_width) };
        let (measured, height) = measure(&wrapped, size, family);
        let mut element = self.element(
            id,
            "text",
            place,
            Kind::Text {
                text: wrapped,
                font_size: size,
                font_family: family,
                text_align: text_align(text_prop(props, "textAlign", "start")),
                vertical_align: "top",
                container_id: None,
                original_text: text,
                auto_resize,
                line_height: line_height(family),
            },
        );
        place_box(&mut element, xform, if auto_resize { measured } else { fixed_width }, height);
        element.stroke_color = stroke_color(text_prop(props, "color", "black"));
        out.push(element);
    }

    /// The outline of the shape `id`, for an arrow bound to it.
    fn outline(&self, id: &str) -> Option<(String, Outline)> {
        let shape = self.shape_record(id)?;
        let props = shape.get("props")?;
        let scale = number_prop(props, "scale", 1.);
        let grow = number_prop(props, "growY", 0.);
        let (width, height, kind) = match shape.get("type").and_then(Value::as_str)? {
            "geo" => (
                number_prop(props, "w", 100.),
                number_prop(props, "h", 100.) + grow,
                geo_type(text_prop(props, "geo", "")),
            ),
            "note" => (NOTE_SIZE * scale, NOTE_SIZE * scale + grow, "rectangle"),
            _ => (props.get("w")?.as_f64()?, props.get("h")?.as_f64()?, "rectangle"),
        };
        Some((bare_id(id), Outline { xform: self.page_xform(shape), width, height, kind }))
    }

    fn arrow(
        &mut self, full_id: &str, id: String, props: &Value, xform: Xform, place: &Placement,
        out: &mut Vec<Element>,
    ) {
        let mut ends = [xform.apply(point_prop(props, "start").0, point_prop(props, "start").1), {
            let (x, y) = point_prop(props, "end");
            xform.apply(x, y)
        }];
        let mut bound: [Option<(String, Outline, bool)>; 2] = [None, None];
        for binding in self.bindings_from(full_id) {
            let binding_props = binding.get("props").unwrap_or(&Value::Null);
            let terminal = usize::from(text_prop(binding_props, "terminal", "start") == "end");
            let target = binding.get("toId").and_then(Value::as_str).unwrap_or_default();
            let Some((target_id, outline)) = self.outline(target) else { continue };
            let anchor = if binding_props.get("isPrecise") == Some(&Value::Bool(true)) {
                point_prop(binding_props, "normalizedAnchor")
            } else {
                (0.5, 0.5)
            };
            ends[terminal] =
                outline.xform.apply(anchor.0 * outline.width, anchor.1 * outline.height);
            let exact = binding_props.get("isExact") == Some(&Value::Bool(true));
            bound[terminal] = Some((target_id, outline, exact));
        }
        let [start, end] = ends;
        let bend = number_prop(props, "bend", 0.);
        let length = (end.0 - start.0).hypot(end.1 - start.1);
        let middle = (bend.abs() > 0.5 && length > 0.).then(|| {
            let (ux, uy) = ((end.0 - start.0) / length, (end.1 - start.1) / length);
            ((start.0 + end.0) / 2. - uy * bend, (start.1 + end.1) / 2. + ux * bend)
        });
        let trimmed = |terminal: usize, own: (f64, f64), other: (f64, f64)| match &bound[terminal] {
            Some((_, outline, false)) => outline.exit(own, middle.unwrap_or(other)),
            _ => own,
        };
        let (start, end) = (trimmed(0, start, end), trimmed(1, end, start));
        let binding = |terminal: usize| {
            bound[terminal].as_ref().map(|(element_id, _, _)| PointBinding {
                element_id: element_id.clone(),
                focus: 0.,
                gap: BINDING_GAP,
            })
        };
        let points: Vec<(f64, f64)> =
            [Some(start), middle, Some(end)].into_iter().flatten().collect();
        let mut element = self.element(id, "arrow", place, Kind::Shape {});
        let relative = relative_points(&mut element, &points);
        element.kind = Kind::Linear {
            points: relative,
            last_committed_point: None,
            start_binding: binding(0),
            end_binding: binding(1),
            start_arrowhead: arrowhead(text_prop(props, "arrowheadStart", "none")),
            end_arrowhead: arrowhead(text_prop(props, "arrowheadEnd", "arrow")),
            elbowed: Some(false),
        };
        element.roundness = middle.map(|_| PROPORTIONAL_RADIUS);
        element.stroke_color = stroke_color(text_prop(props, "color", "black"));
        element.stroke_style = stroke_style(text_prop(props, "dash", "draw"));
        element.stroke_width = stroke_width(text_prop(props, "size", "m"));
        out.push(element);
        let position = number_prop(props, "labelPosition", 0.5);
        let anchor = middle.unwrap_or((
            start.0 + (end.0 - start.0) * position,
            start.1 + (end.1 - start.1) * position,
        ));
        let style = LabelStyle { anchor: Some(anchor), ..self.label_style(props, "middle") };
        self.label(out, plain_text(props), style);
    }

    fn line(
        &mut self, id: String, props: &Value, xform: Xform, place: &Placement,
        out: &mut Vec<Element>,
    ) {
        let mut handles: Vec<&Value> = props
            .get("points")
            .and_then(Value::as_object)
            .map(|points| points.values().collect())
            .unwrap_or_default();
        handles.sort_by(|a, b| {
            text_prop(a, "index", "")
                .cmp(text_prop(b, "index", ""))
                .then(text_prop(a, "id", "").cmp(text_prop(b, "id", "")))
        });
        let points: Vec<(f64, f64)> = handles
            .iter()
            .map(|handle| xform.apply(number_prop(handle, "x", 0.), number_prop(handle, "y", 0.)))
            .collect();
        if points.len() < 2 {
            return;
        }
        let mut element = self.element(id, "line", place, Kind::Shape {});
        let relative = relative_points(&mut element, &points);
        element.kind = Kind::Linear {
            points: relative,
            last_committed_point: None,
            start_binding: None,
            end_binding: None,
            start_arrowhead: None,
            end_arrowhead: None,
            elbowed: None,
        };
        element.roundness =
            (text_prop(props, "spline", "line") == "cubic").then_some(PROPORTIONAL_RADIUS);
        element.stroke_color = stroke_color(text_prop(props, "color", "black"));
        element.stroke_style = stroke_style(text_prop(props, "dash", "draw"));
        element.stroke_width = stroke_width(text_prop(props, "size", "m"));
        out.push(element);
    }

    /// A draw or highlighter stroke, as one freehand element.
    fn stroke(
        &mut self, id: String, props: &Value, xform: Xform, place: &Placement,
        out: &mut Vec<Element>, highlight: bool,
    ) {
        let (scale_x, scale_y) =
            (number_prop(props, "scaleX", 1.), number_prop(props, "scaleY", 1.));
        let samples: Vec<[f64; 3]> = props
            .get("segments")
            .and_then(Value::as_array)
            .map(|segments| segments.iter().flat_map(segment_points).collect())
            .unwrap_or_default();
        if samples.is_empty() {
            return;
        }
        let points: Vec<(f64, f64)> =
            samples.iter().map(|[x, y, _]| xform.apply(x * scale_x, y * scale_y)).collect();
        let pen = props.get("isPen") == Some(&Value::Bool(true));
        let mut element = self.element(id, "freedraw", place, Kind::Shape {});
        let relative = relative_points(&mut element, &points);
        element.kind = Kind::FreeDraw {
            points: relative,
            pressures: if pen {
                samples.iter().map(|sample| sample[2]).collect()
            } else {
                Vec::new()
            },
            simulate_pressure: !pen,
            last_committed_point: None,
        };
        let color = text_prop(props, "color", "black");
        let size = text_prop(props, "size", "m");
        if highlight {
            element.stroke_color = highlight_color(color);
            element.stroke_width = if size == "s" { 2. } else { 4. };
            element.opacity *= 0.5;
        } else {
            element.stroke_color = stroke_color(color);
            element.stroke_width = stroke_width(size);
            if props.get("isClosed") == Some(&Value::Bool(true)) {
                (element.background_color, element.fill_style) =
                    fill(text_prop(props, "fill", "none"), color);
            }
        }
        out.push(element);
    }

    fn image(
        &mut self, id: String, props: &Value, xform: Xform, place: &Placement,
        out: &mut Vec<Element>,
    ) {
        let (width, height) = (number_prop(props, "w", 100.), number_prop(props, "h", 100.));
        let asset = self.asset(text_prop(props, "assetId", "")).cloned().unwrap_or(Value::Null);
        let asset_props = asset.get("props").cloned().unwrap_or(Value::Null);
        let src = text_prop(&asset_props, "src", "");
        let Some((mime_type, data_url)) = self.read_image(src) else {
            let name = text_prop(&asset_props, "name", "");
            let label = if name.is_empty() { "Missing image" } else { name };
            return self.placeholder_box(
                id,
                xform,
                (width, height),
                place,
                out,
                (label.to_string(), None),
            );
        };
        let file_id = self.add_file(mime_type, data_url);
        let crop = props.get("crop").filter(|crop| crop.is_object()).map(|crop| {
            let (natural_width, natural_height) =
                (number_prop(&asset_props, "w", width), number_prop(&asset_props, "h", height));
            let (left, top) = point_prop(crop, "topLeft");
            let (right, bottom) = point_prop(crop, "bottomRight");
            ImageCrop {
                x: left * natural_width,
                y: top * natural_height,
                width: (right - left) * natural_width,
                height: (bottom - top) * natural_height,
                natural_width,
                natural_height,
            }
        });
        let flip = |key| if props.get(key) == Some(&Value::Bool(true)) { -1. } else { 1. };
        let mut element = self.element(
            id,
            "image",
            place,
            Kind::Image { file_id, status: "saved", scale: [flip("flipX"), flip("flipY")], crop },
        );
        place_box(&mut element, xform, width, height);
        element.stroke_color = "transparent".to_string();
        out.push(element);
    }

    /// Embeds, bookmarks, videos and shapes Excalidraw has no element for: a
    /// box naming what was there, linked to its URL.
    fn placeholder(
        &mut self, id: String, props: &Value, xform: Xform, place: &Placement,
        out: &mut Vec<Element>, kind: &str,
    ) {
        let (Some(width), Some(height)) =
            (props.get("w").and_then(Value::as_f64), props.get("h").and_then(Value::as_f64))
        else {
            return;
        };
        let asset = self.asset(text_prop(props, "assetId", "")).cloned().unwrap_or(Value::Null);
        let asset_props = asset.get("props").cloned().unwrap_or(Value::Null);
        let url = [text_prop(props, "url", ""), text_prop(&asset_props, "src", "")]
            .into_iter()
            .find(|url| url.contains("://"))
            .unwrap_or_default();
        let title = [text_prop(&asset_props, "title", ""), text_prop(&asset_props, "name", "")]
            .into_iter()
            .find(|title| !title.is_empty());
        let label = match (title, url.is_empty()) {
            (Some(title), false) => format!("{title}\n{url}"),
            (Some(title), true) => title.to_string(),
            (None, false) => url.to_string(),
            (None, true) => kind.to_string(),
        };
        let link = (!url.is_empty()).then(|| url.to_string());
        self.placeholder_box(id, xform, (width, height), place, out, (label, link));
    }

    fn placeholder_box(
        &mut self, id: String, xform: Xform, (width, height): (f64, f64), place: &Placement,
        out: &mut Vec<Element>, (label, link): (String, Option<String>),
    ) {
        let mut element = self.element(id, "rectangle", place, Kind::Shape {});
        place_box(&mut element, xform, width, height);
        element.stroke_color = PLACEHOLDER_COLOR.to_string();
        element.stroke_style = "dashed";
        element.background_color = "#f8f9fa".to_string();
        element.link = link;
        out.push(element);
        let style = LabelStyle {
            font_size: 16.,
            family: crate::board::scene::font_family::NUNITO,
            align: "center",
            vertical_align: "middle",
            color: PLACEHOLDER_COLOR.to_string(),
            anchor: None,
        };
        self.label(out, label, style);
    }
}
