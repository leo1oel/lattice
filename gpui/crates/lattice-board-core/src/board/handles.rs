// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Transform handles and which one is under the pointer. Port of Excalidraw
//! `element/src/transformHandles.ts` and `element/src/resizeTest.ts` @
//! 3a317b5. Zoom is a plain number; `EditorInterface` reduces to
//! `can_resize_from_sides` (false on phones) and the selection check of
//! `resizeTest` to an `is_selected` flag.

use super::bounds::get_element_absolute_coords;
use super::consts::{DEFAULT_TRANSFORM_HANDLE_SPACING, SIDE_RESIZING_THRESHOLD};
use super::math::*;
use super::types::Element;
use super::utils::ElementsMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HandleType {
    N,
    S,
    W,
    E,
    Nw,
    Ne,
    Sw,
    Se,
    Rotation,
}

impl HandleType {
    /// Upstream's object key order, which is the order hits are reported in.
    pub const ORDER: [HandleType; 9] = [
        HandleType::Nw,
        HandleType::Ne,
        HandleType::Sw,
        HandleType::Se,
        HandleType::Rotation,
        HandleType::N,
        HandleType::S,
        HandleType::W,
        HandleType::E,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            HandleType::N => "n",
            HandleType::S => "s",
            HandleType::W => "w",
            HandleType::E => "e",
            HandleType::Nw => "nw",
            HandleType::Ne => "ne",
            HandleType::Sw => "sw",
            HandleType::Se => "se",
            HandleType::Rotation => "rotation",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerType {
    Mouse,
    Pen,
    Touch,
}

/// `[x, y, width, height]`.
pub type TransformHandle = [f64; 4];

/// The handles there are, keyed by type (upstream: a partial object).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TransformHandles(pub Vec<(HandleType, TransformHandle)>);

impl TransformHandles {
    pub fn get(&self, t: HandleType) -> Option<TransformHandle> {
        self.0.iter().find(|(k, _)| *k == t).map(|(_, h)| *h)
    }
    fn set(&mut self, t: HandleType, h: TransformHandle) {
        self.0.retain(|(k, _)| *k != t);
        self.0.push((t, h));
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Sides to leave out (`{ [T in TransformHandleType]?: boolean }`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OmitSides {
    pub n: bool,
    pub s: bool,
    pub w: bool,
    pub e: bool,
    pub nw: bool,
    pub ne: bool,
    pub sw: bool,
    pub se: bool,
    pub rotation: bool,
}

impl OmitSides {
    fn has(&self, t: HandleType) -> bool {
        match t {
            HandleType::N => self.n,
            HandleType::S => self.s,
            HandleType::W => self.w,
            HandleType::E => self.e,
            HandleType::Nw => self.nw,
            HandleType::Ne => self.ne,
            HandleType::Sw => self.sw,
            HandleType::Se => self.se,
            HandleType::Rotation => self.rotation,
        }
    }
}

pub const DEFAULT_OMIT_SIDES: OmitSides = OmitSides {
    e: true,
    s: true,
    n: true,
    w: true,
    nw: false,
    ne: false,
    sw: false,
    se: false,
    rotation: false,
};
pub const OMIT_SIDES_FOR_MULTIPLE_ELEMENTS: OmitSides = DEFAULT_OMIT_SIDES;
pub const OMIT_SIDES_FOR_FRAME: OmitSides = OmitSides {
    rotation: true,
    ..DEFAULT_OMIT_SIDES
};
const OMIT_SIDES_FOR_LINE_SLASH: OmitSides = OmitSides {
    nw: true,
    se: true,
    ..DEFAULT_OMIT_SIDES
};
const OMIT_SIDES_FOR_LINE_BACKSLASH: OmitSides = DEFAULT_OMIT_SIDES;

fn handle_size(p: PointerType) -> f64 {
    match p {
        PointerType::Mouse => 8.,
        PointerType::Pen => 16.,
        PointerType::Touch => 28.,
    }
}
const ROTATION_RESIZE_HANDLE_GAP: f64 = 16.;

fn generate(x: f64, y: f64, w: f64, h: f64, cx: f64, cy: f64, angle: f64) -> TransformHandle {
    let [xx, yy] = point_rotate_rads([x + w / 2., y + h / 2.], [cx, cy], angle);
    [xx - w / 2., yy - h / 2., w, h]
}

/// `getOmitSidesForEditorInterface`: no omitted sides where sides can't be
/// resized from (phones).
pub fn get_omit_sides_for_editor(can_resize_from_sides: bool) -> OmitSides {
    if can_resize_from_sides {
        DEFAULT_OMIT_SIDES
    } else {
        OmitSides::default()
    }
}

/// `getTransformHandlesFromCoords`. Upstream defaults: `margin` 4,
/// `spacing` `DEFAULT_TRANSFORM_HANDLE_SPACING`.
pub fn get_transform_handles_from_coords(
    c: [f64; 6],
    angle: f64,
    zoom: f64,
    pointer: PointerType,
    omit: OmitSides,
    margin: f64,
    spacing: f64,
) -> TransformHandles {
    let [x1, y1, x2, y2, cx, cy] = c;
    let size = handle_size(pointer);
    let (hw, hh, mx, my) = (size / zoom, size / zoom, size / zoom, size / zoom);
    let (width, height) = (x2 - x1, y2 - y1);
    let dm = margin / zoom;
    let co = (size - spacing * 2.) / (2. * zoom);
    let mut out = TransformHandles::default();
    let mut put = |t: HandleType, x: f64, y: f64| {
        if !omit.has(t) {
            out.set(t, generate(x, y, hw, hh, cx, cy, angle))
        }
    };
    put(HandleType::Nw, x1 - dm - mx + co, y1 - dm - my + co);
    put(HandleType::Ne, x2 + dm - co, y1 - dm - my + co);
    put(HandleType::Sw, x1 - dm - mx + co, y2 + dm - co);
    put(HandleType::Se, x2 + dm - co, y2 + dm - co);
    put(
        HandleType::Rotation,
        x1 + width / 2. - hw / 2.,
        y1 - dm - my + co - ROTATION_RESIZE_HANDLE_GAP / zoom,
    );
    // all eight only above a size (measured with the mouse size, as drawn)
    let min_for_eight = 5. * handle_size(PointerType::Mouse) / zoom;
    if width.abs() > min_for_eight {
        put(HandleType::N, x1 + width / 2. - hw / 2., y1 - dm - my + co);
        put(HandleType::S, x1 + width / 2. - hw / 2., y2 + dm - co);
    }
    if height.abs() > min_for_eight {
        put(HandleType::W, x1 - dm - mx + co, y1 + height / 2. - hh / 2.);
        put(HandleType::E, x2 + dm - co, y1 + height / 2. - hh / 2.);
    }
    out
}

/// `getTransformHandles` (upstream default `omit_sides`: `DEFAULT_OMIT_SIDES`).
pub fn get_transform_handles(
    e: &Element,
    zoom: f64,
    map: &dyn ElementsMap,
    pointer: PointerType,
    mut omit: OmitSides,
) -> TransformHandles {
    // locked elements show no handles; elbow arrows can't be rotated
    if e.locked || e.is_elbow_arrow() {
        return TransformHandles::default();
    }
    if let Some(pts) = e.points().filter(|_| e.is_freedraw() || e.is_linear()) {
        if pts.len() == 2 {
            let p1 = pts[1];
            if p1[0] == 0. || p1[1] == 0. {
                omit = OMIT_SIDES_FOR_LINE_BACKSLASH
            } else if (p1[0] > 0. && p1[1] < 0.) || (p1[0] < 0. && p1[1] > 0.) {
                omit = OMIT_SIDES_FOR_LINE_SLASH
            } else if (p1[0] > 0. && p1[1] > 0.) || (p1[0] < 0. && p1[1] < 0.) {
                omit = OMIT_SIDES_FOR_LINE_BACKSLASH
            }
        }
    } else if e.is_frame_like() {
        omit.rotation = true;
    }
    let margin = if e.is_linear() {
        DEFAULT_TRANSFORM_HANDLE_SPACING + 8.
    } else if e.is_image() {
        0.
    } else {
        DEFAULT_TRANSFORM_HANDLE_SPACING
    };
    let spacing = if e.is_image() {
        0.
    } else {
        DEFAULT_TRANSFORM_HANDLE_SPACING
    };
    get_transform_handles_from_coords(
        get_element_absolute_coords(e, map, true),
        e.angle,
        zoom,
        pointer,
        omit,
        margin,
        spacing,
    )
}

/// `hasBoundingBox` for a selection; `editing_linear` is the linear editor
/// editing or dragging, `is_mobile` the user agent.
pub fn has_bounding_box(elements: &[&Element], editing_linear: bool, is_mobile: bool) -> bool {
    if editing_linear {
        return false;
    }
    if elements.len() > 1 {
        return true;
    }
    let Some(e) = elements.first() else {
        return false;
    };
    if e.is_elbow_arrow() {
        return false;
    }
    if !e.is_linear() {
        return true;
    }
    e.points().map_or(0, |p| p.len()) > 2 && !is_mobile
}

fn inside(h: TransformHandle, x: f64, y: f64) -> bool {
    x >= h[0] && x <= h[0] + h[2] && y >= h[1] && y <= h[1] + h[3]
}

fn selection_borders(p1: Point, p2: Point, c: Point, angle: f64) -> [(HandleType, Segment); 4] {
    let r = |x: f64, y: f64| point_rotate_rads([x, y], c, angle);
    let (tl, tr, bl, br) = (
        r(p1[0], p1[1]),
        r(p2[0], p1[1]),
        r(p1[0], p2[1]),
        r(p2[0], p2[1]),
    );
    [
        (HandleType::N, [tl, tr]),
        (HandleType::E, [tr, br]),
        (HandleType::S, [br, bl]),
        (HandleType::W, [bl, tl]),
    ]
}

/// `resizeTest`: the handle (or side) of a selected element under the
/// pointer. `cropping` is `appState.croppingElementId` being set.
#[allow(clippy::too_many_arguments)]
pub fn resize_test(
    e: &Element,
    map: &dyn ElementsMap,
    is_selected: bool,
    cropping: bool,
    x: f64,
    y: f64,
    zoom: f64,
    pointer: PointerType,
    can_resize_from_sides: bool,
) -> Option<HandleType> {
    if !is_selected {
        return None;
    }
    let handles = get_transform_handles(
        e,
        zoom,
        map,
        pointer,
        get_omit_sides_for_editor(can_resize_from_sides),
    );
    if let Some(r) = handles.get(HandleType::Rotation)
        && !cropping
        && inside(r, x, y)
    {
        return Some(HandleType::Rotation);
    }
    for t in HandleType::ORDER {
        if t == HandleType::Rotation {
            continue;
        }
        if let Some(h) = handles.get(t)
            && inside(h, x, y)
        {
            return Some(t);
        }
    }
    if can_resize_from_sides {
        let [x1, y1, x2, y2, cx, cy] = get_element_absolute_coords(e, map, false);
        // not from the sides of two-point lines
        if !(e.is_linear() && e.points().map_or(0, |p| p.len()) <= 2) {
            let spacing = if e.is_image() {
                0.
            } else {
                SIDE_RESIZING_THRESHOLD / zoom
            };
            let threshold = SIDE_RESIZING_THRESHOLD / zoom;
            for (dir, side) in selection_borders(
                [x1 - spacing, y1 - spacing],
                [x2 + spacing, y2 + spacing],
                [cx, cy],
                e.angle,
            ) {
                if point_on_line_segment([x, y], side, threshold) {
                    return Some(dir);
                }
            }
        }
    }
    None
}

/// `getElementWithTransformHandleType`: the first selected element with a
/// handle under the pointer. `is_selected` stands for `selectedElementIds`.
#[allow(clippy::too_many_arguments)]
pub fn get_element_with_transform_handle_type<'a>(
    elements: &'a [Element],
    is_selected: &dyn Fn(&Element) -> bool,
    cropping: bool,
    x: f64,
    y: f64,
    zoom: f64,
    pointer: PointerType,
    map: &dyn ElementsMap,
    can_resize_from_sides: bool,
) -> Option<(&'a Element, HandleType)> {
    elements.iter().find_map(|e| {
        resize_test(
            e,
            map,
            is_selected(e),
            cropping,
            x,
            y,
            zoom,
            pointer,
            can_resize_from_sides,
        )
        .map(|t| (e, t))
    })
}

/// `getTransformHandleTypeFromCoords`: the handle of a multi-element
/// selection box under the pointer.
pub fn get_transform_handle_type_from_coords(
    b: [f64; 4],
    x: f64,
    y: f64,
    zoom: f64,
    pointer: PointerType,
    can_resize_from_sides: bool,
) -> Option<HandleType> {
    let [x1, y1, x2, y2] = b;
    let handles = get_transform_handles_from_coords(
        [x1, y1, x2, y2, (x1 + x2) / 2., (y1 + y2) / 2.],
        0.,
        zoom,
        pointer,
        get_omit_sides_for_editor(can_resize_from_sides),
        4.,
        DEFAULT_TRANSFORM_HANDLE_SPACING,
    );
    if let Some(t) = HandleType::ORDER
        .into_iter()
        .find(|&t| handles.get(t).is_some_and(|h| inside(h, x, y)))
    {
        return Some(t);
    }
    if can_resize_from_sides {
        let spacing = SIDE_RESIZING_THRESHOLD / zoom;
        for (dir, side) in selection_borders(
            [x1 - spacing, y1 - spacing],
            [x2 + spacing, y2 + spacing],
            [(x1 + x2) / 2., (y1 + y2) / 2.],
            0.,
        ) {
            if point_on_line_segment([x, y], side, spacing) {
                return Some(dir);
            }
        }
    }
    None
}

const RESIZE_CURSORS: [&str; 4] = ["ns", "nesw", "ew", "nwse"];

fn rotate_resize_cursor(cursor: &'static str, angle: f64) -> &'static str {
    match RESIZE_CURSORS.iter().position(|&c| c == cursor) {
        Some(i) => {
            let a = js_round(angle / (PI / 4.)) as i64;
            RESIZE_CURSORS[(i as i64 + a).rem_euclid(4) as usize]
        }
        None => cursor,
    }
}

/// `getCursorForResizingElement`: a CSS cursor name (`"nwse-resize"`,
/// `"grab"`, or "" for none).
pub fn get_cursor_for_resizing_element(e: Option<&Element>, t: Option<HandleType>) -> String {
    let sign = |v: f64| {
        if v > 0. {
            1.
        } else if v < 0. {
            -1.
        } else {
            0.
        }
    };
    let swap = e.is_some_and(|e| sign(e.height) * sign(e.width) == -1.);
    let cursor = match t {
        Some(HandleType::N | HandleType::S) => "ns",
        Some(HandleType::W | HandleType::E) => "ew",
        Some(HandleType::Nw | HandleType::Se) => {
            if swap {
                "nesw"
            } else {
                "nwse"
            }
        }
        Some(HandleType::Ne | HandleType::Sw) => {
            if swap {
                "nwse"
            } else {
                "nesw"
            }
        }
        Some(HandleType::Rotation) => return "grab".into(),
        None => return String::new(),
    };
    let cursor = e.map_or(cursor, |e| rotate_resize_cursor(cursor, e.angle));
    format!("{cursor}-resize")
}
