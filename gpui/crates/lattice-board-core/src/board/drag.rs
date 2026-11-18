// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Dragging elements and sizing new ones. Port of Excalidraw
//! `packages/element/src/dragElements.ts` @ 3a317b5.
//!
//! Differences from upstream:
//! - the snap offset is computed by the caller (the snapping module) and
//!   passed in, as upstream's caller does;
//! - selected elements are named by id and read from the scene;
//! - the part of `PointerDownState` dragging reads is `DragState` (the
//!   elements as they were at pointer down);
//! - labels of moved arrows and elbow routing go through `BindingHooks`
//!   (upstream's `renderEnvironment` measures the labels);
//! - new images: upstream also records `initialWidth`/`initialHeight`, which
//!   nothing reads back in the element model; not kept.

use super::app_state::ToolType;
use super::binding::{
    BindingHooks, UpdateBoundOpts, get_frame_arrow_ids_to_reattach, move_frame_arrows,
    unbind_binding_element, update_bound_elements,
};
use super::bounds::{Bounds, get_bound_text_element, get_common_bounds};
use super::consts::{DRAGGING_THRESHOLD, TEXT_AUTOWRAP_THRESHOLD};
use super::math::Point;
use super::scene::Scene;
use super::size_helpers::get_perfect_element_size;
use super::text::font_of;
use super::text_measure::{Measure, get_min_text_element_width};
use super::types::{Element, ElementType, StartOrEnd};
use super::utils::{ElementsMap, get_grid_point};
use rustc_hash::{FxHashMap, FxHashSet};

/// The part of upstream's `PointerDownState` a drag reads: the elements as
/// they were when the pointer went down.
#[derive(Clone, Debug, Default)]
pub struct DragState {
    pub original_elements: FxHashMap<String, Element>,
    /// The common bounds of the moved elements as they were, by a hash of
    /// their ids (the same on every step of a drag).
    pub bounds_memo: std::cell::Cell<Option<(u64, Bounds)>>,
}

impl DragState {
    /// Snapshot of the scene's non-deleted elements at pointer down.
    pub fn new(scene: &Scene) -> Self {
        DragState {
            original_elements: scene
                .non_deleted_elements()
                .map(|e| (e.id.clone(), e.clone()))
                .collect(),
            bounds_memo: Default::default(),
        }
    }
}

/// `dragSelectedElements`: moves the selection (and the children of selected
/// frames, and bound text) to where the pointer is, `offset` from where the
/// drag started, plus `snap_offset`; snaps to the grid on axes not snapped.
/// Arrows moved without what they're bound to are unbound; arrows bound to
/// moved elements follow.
pub fn drag_selected_elements(
    ds: &DragState,
    selected: &[String],
    offset: Point,
    scene: &mut Scene,
    snap_offset: Point,
    grid_size: Option<f64>,
    hooks: &dyn BindingHooks,
) {
    // what to move, read up front by id (the scene changes as they move)
    let (to_update, ids, frame_arrows, adjusted) = {
        let sel: Vec<&Element> = selected
            .iter()
            .filter_map(|id| scene.get_non_deleted_element(id))
            .collect();
        if sel.len() == 1
            && sel[0].is_elbow_arrow()
            && sel[0]
                .linear()
                .is_some_and(|l| l.start_binding.is_some() || l.end_binding.is_some())
        {
            return;
        }
        let in_sel: FxHashSet<&str> = sel.iter().map(|e| e.id.as_str()).collect();
        let sel: Vec<&Element> = sel
            .iter()
            .copied()
            .filter(|e| {
                let Some(l) = e.linear().filter(|_| e.is_elbow_arrow()) else {
                    return true;
                };
                let (Some(s), Some(en)) = (&l.start_binding, &l.end_binding) else {
                    return true;
                };
                in_sel.contains(s.element_id.as_str()) && in_sel.contains(en.element_id.as_str())
            })
            .collect();
        // a frame and its children selected together: move each once
        let mut to_update: Vec<&Element> = vec![];
        let mut ids: FxHashSet<String> = FxHashSet::default();
        for e in &sel {
            if ids.insert(e.id.clone()) {
                to_update.push(e);
            }
        }
        let frames: Vec<&str> = sel
            .iter()
            .filter(|e| e.is_frame_like())
            .map(|e| e.id.as_str())
            .collect();
        if !frames.is_empty() {
            for e in scene.non_deleted_elements() {
                if e.frame_id.as_deref().is_some_and(|f| frames.contains(&f))
                    && ids.insert(e.id.clone())
                {
                    to_update.push(e);
                }
            }
        }
        let mut orig = vec![];
        let mut h = rustc_hash::FxHasher::default();
        for e in &to_update {
            // not there at pointer down (duplicated mid-drag)
            let Some(o) = ds.original_elements.get(&e.id) else {
                return;
            };
            orig.push(o);
            std::hash::Hash::hash(&e.id, &mut h);
        }
        let key = std::hash::Hasher::finish(&h);
        let common = match ds.bounds_memo.get() {
            Some((k, b)) if k == key => b,
            _ => {
                let b = get_common_bounds(orig.iter().copied(), &ds.original_elements);
                ds.bounds_memo.set(Some((key, b)));
                b
            }
        };
        let adjusted = calculate_offset(common, offset, snap_offset, grid_size);
        let frame_arrows = get_frame_arrow_ids_to_reattach(&to_update);
        (
            to_update
                .iter()
                .map(|e| e.id.clone())
                .collect::<Vec<String>>(),
            ids,
            frame_arrows,
            adjusted,
        )
    };
    let many = to_update.len() > 1;
    super::mutate::with_one_timestamp(|| {
        for id in &to_update {
            if frame_arrows.contains(id) {
                continue;
            }
            let Some(e) = scene.get_element(id) else {
                continue;
            };
            if !e.is_arrow() {
                let text = get_bound_text_element(e, scene)
                    .filter(|t| !t.is_deleted)
                    .map(|t| t.id.clone());
                update_element_coords(ds, id, scene, adjusted);
                if let Some(t) = text {
                    update_element_coords(ds, &t, scene, adjusted);
                }
                update_bound_elements(
                    id,
                    scene,
                    &UpdateBoundOpts {
                        simultaneously_updated: Some(&ids),
                        changed_elements: &[],
                    },
                    hooks,
                );
            } else {
                let l = e.linear().unwrap();
                // a little initial drag before a lone bound arrow unbinds
                if many
                    || adjusted[0].abs().max(adjusted[1].abs()) > DRAGGING_THRESHOLD
                    || (l.start_binding.is_none() && l.end_binding.is_none())
                {
                    let unbind_start = l
                        .start_binding
                        .as_ref()
                        .is_none_or(|b| !ids.contains(&b.element_id));
                    let unbind_end = l
                        .end_binding
                        .as_ref()
                        .is_none_or(|b| !ids.contains(&b.element_id));
                    update_element_coords(ds, id, scene, adjusted);
                    if unbind_start {
                        unbind_binding_element(id, StartOrEnd::Start, scene);
                    }
                    if unbind_end {
                        unbind_binding_element(id, StartOrEnd::End, scene);
                    }
                }
            }
        }
    });
    move_frame_arrows(
        &frame_arrows,
        adjusted,
        scene,
        Some(&ds.original_elements),
        hooks,
    );
}

fn calculate_offset(b: Bounds, drag: Point, snap: Point, grid_size: Option<f64>) -> Point {
    let [x, y, ..] = b;
    let (mut nx, mut ny) = (x + drag[0] + snap[0], y + drag[1] + snap[1]);
    if snap[0] == 0. || snap[1] == 0. {
        let [gx, gy] = get_grid_point(x + drag[0], y + drag[1], grid_size);
        if snap[0] == 0. {
            nx = gx;
        }
        if snap[1] == 0. {
            ny = gy;
        }
    }
    [nx - x, ny - y]
}

fn update_element_coords(ds: &DragState, id: &str, scene: &mut Scene, d: Point) {
    let Some(o) = ds
        .original_elements
        .get(id)
        .or_else(|| scene.get_element(id))
        .map(|o| (o.x, o.y))
    else {
        return;
    };
    scene.translate_element(id, o.0 + d[0], o.1 + d[1], true);
}

/// `getDragOffsetXY`: the pointer's offset from the selection's top left.
pub fn get_drag_offset_xy(selected: &[&Element], map: &dyn ElementsMap, x: f64, y: f64) -> Point {
    let [x1, y1, ..] = get_common_bounds(selected.iter().copied(), map);
    [x - x1, y - y1]
}

/// `dragNewTextElement`: sizes a text being dragged out. `anchor_ratio`: 0
/// pinned by its left edge, 1 by its right, 0.5 by its centre. `next_y`:
/// free text re-tops itself to the drag origin.
#[allow(clippy::too_many_arguments)]
pub fn drag_new_text_element(
    scene: &mut Scene,
    id: &str,
    anchor_x: f64,
    anchor_ratio: f64,
    pointer_x: f64,
    next_y: Option<f64>,
    zoom: f64,
    m: &dyn Measure,
    inform: bool,
) {
    let Some(t) = scene.get_element(id) else {
        return;
    };
    let Some(td) = t.text() else { return };
    let off = pointer_x - anchor_x;
    let reach = if anchor_ratio == 0. {
        off
    } else if anchor_ratio == 1. {
        -off
    } else {
        off.abs()
    };
    let width = (if anchor_ratio == 0.5 {
        reach * 2.
    } else {
        reach
    })
    .max(get_min_text_element_width(m, font_of(t), td.line_height));
    scene.mutate_element(id, inform, |e| {
        e.x = anchor_x - width * anchor_ratio;
        if let Some(y) = next_y {
            e.y = y;
        }
        e.width = width;
        if reach > TEXT_AUTOWRAP_THRESHOLD / zoom
            && let Some(t) = e.text_mut()
        {
            t.auto_resize = false;
        }
    });
}

/// `dragNewElement`'s arguments.
#[derive(Clone, Copy, Debug)]
pub struct DragNewOpts {
    /// The active tool's type.
    pub tool: ToolType,
    pub origin_x: f64,
    pub origin_y: f64,
    /// Pointer position.
    pub x: f64,
    pub y: f64,
    /// Unsigned distances from the origin to the pointer.
    pub width: f64,
    pub height: f64,
    /// Shift.
    pub maintain_aspect_ratio: bool,
    /// Alt.
    pub resize_from_center: bool,
    pub zoom: f64,
    /// Keep this width/height when keeping the aspect ratio (images).
    pub width_aspect_ratio: Option<f64>,
    pub origin_offset: Option<Point>,
    pub inform: bool,
}

impl DragNewOpts {
    /// From the drag origin and pointer, upstream's caller's `width`/`height`.
    pub fn new(tool: ToolType, origin: Point, pointer: Point, zoom: f64) -> Self {
        DragNewOpts {
            tool,
            origin_x: origin[0],
            origin_y: origin[1],
            x: pointer[0],
            y: pointer[1],
            width: (pointer[0] - origin[0]).abs(),
            height: (pointer[1] - origin[1]).abs(),
            maintain_aspect_ratio: false,
            resize_from_center: false,
            zoom,
            width_aspect_ratio: None,
            origin_offset: None,
            inform: true,
        }
    }
}

/// `dragNewElement`: sizes the element being drawn from the drag origin to
/// the pointer; shift keeps the aspect (squares, or `width_aspect_ratio`),
/// alt grows it from the origin as its centre. Texts only widen.
pub fn drag_new_element(scene: &mut Scene, id: &str, o: &DragNewOpts, m: &dyn Measure) {
    let Some(e) = scene.get_element(id) else {
        return;
    };
    let (mut width, mut height) = (o.width, o.height);
    if o.maintain_aspect_ratio && e.ty() != ElementType::Selection {
        if let Some(r) = o.width_aspect_ratio.filter(|r| *r != 0.) {
            height = width / r;
        } else {
            let tool = ElementType::parse(o.tool.as_str());
            if (o.y - o.origin_y).abs() > (o.x - o.origin_x).abs() {
                (width, height) = get_perfect_element_size(
                    tool,
                    height,
                    if o.x < o.origin_x { -width } else { width },
                );
            } else {
                (width, height) = get_perfect_element_size(
                    tool,
                    width,
                    if o.y < o.origin_y { -height } else { height },
                );
            }
            if height < 0. {
                height = -height;
            }
        }
    }
    let off = o.origin_offset.unwrap_or([0., 0.]);
    if e.is_text() {
        let ratio = if o.resize_from_center {
            0.5
        } else if o.x < o.origin_x {
            1.
        } else {
            0.
        };
        drag_new_text_element(
            scene,
            id,
            o.origin_x + off[0],
            ratio,
            o.x,
            Some(o.origin_y + off[1]),
            o.zoom,
            m,
            o.inform,
        );
        return;
    }
    let mut nx = if o.x < o.origin_x {
        o.origin_x - width
    } else {
        o.origin_x
    };
    let mut ny = if o.y < o.origin_y {
        o.origin_y - height
    } else {
        o.origin_y
    };
    if o.resize_from_center {
        width += width;
        height += height;
        nx = o.origin_x - width / 2.;
        ny = o.origin_y - height / 2.;
    }
    if width != 0. && height != 0. {
        scene.mutate_element(id, o.inform, |e| {
            e.x = nx + off[0];
            e.y = ny + off[1];
            e.width = width;
            e.height = height;
        });
    }
}
