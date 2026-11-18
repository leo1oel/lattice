// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Object snapping. Port of Excalidraw `packages/excalidraw/snapping.ts`
//! @ 3a317b5: point snaps (corners, centers, diamond / ellipse side
//! midpoints) and gap snaps (equal spacing) for dragged, resized and new
//! elements, snap lines at the pointer, and the snap lines to render.
//!
//! Differences from upstream:
//! - `SnapCache` is a value the app keeps for the gesture (upstream: static
//!   fields), filled with `maybe_cache_*` as `App.maybeCache*` do;
//! - what upstream reads from `app` is a `SnapCtx` (the app state, the view
//!   size and whether the selection is being dragged), the keyboard event an
//!   `Option<SnapModifiers>`;
//!
//! Grid snapping is `utils::get_grid_point`; the elbow / binding midpoint
//! snaps live in binding.rs.

use super::app_state::{AppState, ToolType};
use super::bounds::*;
use super::groups::get_maximum_groups;
use super::handles::HandleType;
use super::math::*;
use super::selection::get_visible_and_non_selected_elements;
use super::types::{Element, ElementType};
use super::utils::ElementsMap;

pub const SNAP_DISTANCE: f64 = 8.;
/// Don't compute more gaps per axis than this.
const VISIBLE_GAPS_LIMIT_PER_AXIS: usize = 99999;

/// `getSnapDistance`: the snap distance in scene units.
pub fn get_snap_distance(zoom: f64) -> f64 {
    SNAP_DISTANCE / zoom
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointSnap {
    pub points: [Point; 2],
    pub offset: f64,
}

/// `Gap`: the space between two elements' bounds that overlap on the other
/// axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gap {
    pub start_bounds: Bounds,
    pub end_bounds: Bounds,
    pub start_side: [Point; 2],
    pub end_side: [Point; 2],
    pub overlap: Range,
    pub length: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GapDirection {
    CenterHorizontal,
    CenterVertical,
    SideLeft,
    SideRight,
    SideTop,
    SideBottom,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GapSnap {
    pub direction: GapDirection,
    pub gap: Gap,
    pub offset: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Snap {
    Point(PointSnap),
    Gap(GapSnap),
}
impl Snap {
    pub fn offset(&self) -> f64 {
        match self {
            Snap::Point(p) => p.offset,
            Snap::Gap(g) => g.offset,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineDirection {
    Horizontal,
    Vertical,
}

/// `SnapLine`, for rendering.
#[derive(Clone, Debug, PartialEq)]
pub enum SnapLine {
    /// Points lined up on one axis.
    Points(Vec<Point>),
    Gap {
        direction: LineDirection,
        points: [Point; 2],
    },
    Pointer {
        direction: LineDirection,
        points: [Point; 2],
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct VisibleGaps {
    pub horizontal_gaps: Vec<Gap>,
    pub vertical_gaps: Vec<Gap>,
}

/// `SnapCache`: the reference points and gaps for the current gesture.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SnapCache {
    pub reference_snap_points: Option<Vec<Point>>,
    pub visible_gaps: Option<VisibleGaps>,
}

/// `KeyboardModifiersObject`, the part snapping reads.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SnapModifiers {
    pub ctrl_or_cmd: bool,
}

/// What snapping reads from `app`.
#[derive(Clone, Copy)]
pub struct SnapCtx<'a> {
    pub app: &'a AppState,
    /// The canvas size (`appState.width` / `height`), for "visible".
    pub width: f64,
    pub height: f64,
    /// `selectedElementsAreBeingDragged`.
    pub dragging_selection: bool,
}

/// The result of the `snap*` functions: how far to move, and lines to draw.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SnapResult {
    pub snap_offset: Vector,
    pub snap_lines: Vec<SnapLine>,
}

/// `isGridModeEnabled`.
pub fn is_grid_mode_enabled(ctx: &SnapCtx) -> bool {
    ctx.app.grid_mode_enabled
}

/// `isSnappingEnabled`: with an event, object snap mode unless ctrl/cmd
/// toggles it (and the grid isn't on), never while lassoing; without one,
/// the mode, except for a lone arrow (which binds instead).
pub fn is_snapping_enabled(
    ctx: &SnapCtx,
    event: Option<SnapModifiers>,
    selected: &[&Element],
) -> bool {
    let a = ctx.app;
    if let Some(ev) = event {
        let lasso_dragging = a.active_tool.ty == ToolType::Lasso && ctx.dragging_selection;
        return (a.active_tool.ty != ToolType::Lasso || lasso_dragging)
            && ((a.objects_snap_mode_enabled && !ev.ctrl_or_cmd)
                || (!a.objects_snap_mode_enabled && ev.ctrl_or_cmd && !is_grid_mode_enabled(ctx)));
    }
    if selected.len() == 1 && selected[0].ty() == ElementType::Arrow {
        return false;
    }
    a.objects_snap_mode_enabled
}

/// `areRoughlyEqual` (precision 0.01).
pub fn are_roughly_equal(a: f64, b: f64, precision: f64) -> bool {
    (a - b).abs() <= precision
}

/// `round` to 6 decimals.
fn round6(x: f64) -> f64 {
    js_round(x * 1e6) / 1e6
}

/// `getElementsCorners`' options.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CornersOpts {
    pub omit_center: bool,
    pub bounding_box_corners: bool,
    pub drag_offset: Option<Vector>,
}

/// `getElementsCorners`: a single element's corners (side midpoints for
/// diamonds and ellipses) and center, rotated; several elements' common
/// bounding box corners and center.
pub fn get_elements_corners(
    elements: &[&Element],
    map: &dyn ElementsMap,
    o: CornersOpts,
) -> Vec<Point> {
    let mut r: Vec<Point> = vec![];
    if elements.len() == 1 {
        let e = elements[0];
        let [mut x1, mut y1, mut x2, mut y2, mut cx, mut cy] =
            get_element_absolute_coords(e, map, false);
        if let Some([dx, dy]) = o.drag_offset {
            x1 += dx;
            x2 += dx;
            cx += dx;
            y1 += dy;
            y2 += dy;
            cy += dy;
        }
        let (hw, hh) = ((x2 - x1) / 2., (y2 - y1) / 2.);
        let rot = |p: Point| point_rotate_rads(p, [cx, cy], e.angle);
        r = if matches!(e.ty(), ElementType::Diamond | ElementType::Ellipse)
            && !o.bounding_box_corners
        {
            vec![
                rot([x1, y1 + hh]),
                rot([x1 + hw, y1]),
                rot([x2, y1 + hh]),
                rot([x1 + hw, y2]),
            ]
        } else {
            vec![rot([x1, y1]), rot([x2, y1]), rot([x1, y2]), rot([x2, y2])]
        };
        if !o.omit_center {
            r.push([cx, cy]);
        }
    } else if elements.len() > 1 {
        let [dx, dy] = o.drag_offset.unwrap_or([0., 0.]);
        let [min_x, min_y, max_x, max_y] =
            get_dragged_elements_bounds(elements.iter().copied(), map, dx, dy);
        r = vec![
            [min_x, min_y],
            [max_x, min_y],
            [min_x, max_y],
            [max_x, max_y],
        ];
        if !o.omit_center {
            r.push([min_x + (max_x - min_x) / 2., min_y + (max_y - min_y) / 2.]);
        }
    }
    r.into_iter()
        .map(|p| [round6(p[0]), round6(p[1])])
        .collect()
}

fn reference_elements<'a>(
    elements: &'a [Element],
    selected: &[&Element],
    ctx: &SnapCtx,
    map: &dyn ElementsMap,
) -> Vec<&'a Element> {
    get_visible_and_non_selected_elements(elements, selected, ctx.app, ctx.width, ctx.height, map)
}

fn reference_groups<'a>(
    elements: &'a [Element],
    selected: &[&Element],
    ctx: &SnapCtx,
    map: &'a dyn ElementsMap,
) -> Vec<Vec<&'a Element>> {
    let refs = reference_elements(elements, selected, ctx, map);
    get_maximum_groups(&refs, map)
        .into_iter()
        .filter(|g| !(g.len() == 1 && g[0].is_bound_to_container()))
        .collect()
}

/// `getVisibleGaps`.
pub fn get_visible_gaps(
    elements: &[Element],
    selected: &[&Element],
    ctx: &SnapCtx,
    map: &dyn ElementsMap,
) -> VisibleGaps {
    let mut bounds: Vec<Bounds> = reference_groups(elements, selected, ctx, map)
        .iter()
        .map(|g| get_common_bounds(g.iter().copied(), map).map(round6))
        .collect();
    let mut out = VisibleGaps::default();
    bounds.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut c = 0;
    'h: for i in 0..bounds.len() {
        let s = bounds[i];
        for &e in &bounds[i + 1..] {
            c += 1;
            if c > VISIBLE_GAPS_LIMIT_PER_AXIS {
                break 'h;
            }
            if s[2] < e[0] && ranges_overlap([s[1], s[3]], [e[1], e[3]]) {
                out.horizontal_gaps.push(Gap {
                    start_bounds: s,
                    end_bounds: e,
                    start_side: [[s[2], s[1]], [s[2], s[3]]],
                    end_side: [[e[0], e[1]], [e[0], e[3]]],
                    length: e[0] - s[2],
                    overlap: range_intersection([s[1], s[3]], [e[1], e[3]]).unwrap(),
                });
            }
        }
    }
    bounds.sort_by(|a, b| a[1].total_cmp(&b[1]));
    c = 0;
    'v: for i in 0..bounds.len() {
        let s = bounds[i];
        for &e in &bounds[i + 1..] {
            c += 1;
            if c > VISIBLE_GAPS_LIMIT_PER_AXIS {
                break 'v;
            }
            if s[3] < e[1] && ranges_overlap([s[0], s[2]], [e[0], e[2]]) {
                out.vertical_gaps.push(Gap {
                    start_bounds: s,
                    end_bounds: e,
                    start_side: [[s[0], s[3]], [s[2], s[3]]],
                    end_side: [[e[0], e[1]], [e[2], e[1]]],
                    length: e[1] - s[3],
                    overlap: range_intersection([s[0], s[2]], [e[0], e[2]]).unwrap(),
                });
            }
        }
    }
    out
}

/// `getReferenceSnapPoints`.
pub fn get_reference_snap_points(
    elements: &[Element],
    selected: &[&Element],
    ctx: &SnapCtx,
    map: &dyn ElementsMap,
) -> Vec<Point> {
    reference_groups(elements, selected, ctx, map)
        .iter()
        .flat_map(|g| get_elements_corners(g, map, CornersOpts::default()))
        .collect()
}

impl SnapCache {
    /// `App.maybeCacheReferenceSnapPoints`.
    pub fn maybe_cache_reference_snap_points(
        &mut self,
        elements: &[Element],
        selected: &[&Element],
        ctx: &SnapCtx,
        map: &dyn ElementsMap,
        event: Option<SnapModifiers>,
        recompute: bool,
    ) {
        if is_snapping_enabled(ctx, event, selected)
            && (recompute || self.reference_snap_points.is_none())
        {
            self.reference_snap_points =
                Some(get_reference_snap_points(elements, selected, ctx, map));
        }
    }
    /// `App.maybeCacheVisibleGaps`.
    pub fn maybe_cache_visible_gaps(
        &mut self,
        elements: &[Element],
        selected: &[&Element],
        ctx: &SnapCtx,
        map: &dyn ElementsMap,
        event: Option<SnapModifiers>,
        recompute: bool,
    ) {
        if is_snapping_enabled(ctx, event, selected) && (recompute || self.visible_gaps.is_none()) {
            self.visible_gaps = Some(get_visible_gaps(elements, selected, ctx, map));
        }
    }
    /// Whether a `maybe_cache_*` call would compute anything, so callers can
    /// skip gathering the scene's elements on every drag step.
    pub fn wants(
        &self,
        ctx: &SnapCtx,
        event: Option<SnapModifiers>,
        selected: &[&Element],
    ) -> bool {
        is_snapping_enabled(ctx, event, selected)
            && (self.reference_snap_points.is_none() || self.visible_gaps.is_none())
    }
    /// `SnapCache.destroy`.
    pub fn destroy(&mut self) {
        *self = SnapCache::default();
    }
}

/// The nearest snaps on both axes and how far they are (`minOffset`).
struct Nearest {
    x: Vec<Snap>,
    y: Vec<Snap>,
    min: Vector,
}
impl Nearest {
    fn new(d: f64) -> Self {
        Nearest {
            x: vec![],
            y: vec![],
            min: [d, d],
        }
    }
    fn reset(&mut self) {
        self.x.clear();
        self.y.clear();
        self.min = [0., 0.];
    }
    fn offset(&self) -> Vector {
        [
            self.x.first().map_or(0., Snap::offset),
            self.y.first().map_or(0., Snap::offset),
        ]
    }
    /// Pushes a snap on axis `k` if it's at most as far as the nearest.
    fn push(&mut self, k: usize, offset: f64, snap: Snap) -> bool {
        if offset.abs() > self.min[k] {
            return false;
        }
        let list = if k == 0 { &mut self.x } else { &mut self.y };
        if offset.abs() < self.min[k] {
            list.clear();
        }
        self.min[k] = offset.abs();
        list.push(snap);
        true
    }
}

fn get_gap_snaps(
    selected: &[&Element],
    map: &dyn ElementsMap,
    drag: Vector,
    cache: &SnapCache,
    n: &mut Nearest,
) {
    let Some(g) = &cache.visible_gaps else { return };
    if selected.is_empty() {
        return;
    }
    let [min_x, min_y, max_x, max_y] =
        get_dragged_elements_bounds(selected.iter().copied(), map, drag[0], drag[1]).map(round6);
    let (cx, cy) = ((min_x + max_x) / 2., (min_y + max_y) / 2.);
    let snap = |direction, gap: &Gap, offset| {
        Snap::Gap(GapSnap {
            direction,
            gap: *gap,
            offset,
        })
    };
    for gap in &g.horizontal_gaps {
        if !ranges_overlap([min_y, max_y], gap.overlap) {
            continue;
        }
        let center = round6(gap.start_side[0][0] + gap.length / 2. - cx);
        if gap.length > max_x - min_x
            && n.push(0, center, snap(GapDirection::CenterHorizontal, gap, center))
        {
            continue;
        }
        let right = round6(gap.length - (min_x - gap.end_bounds[2]));
        if n.push(0, right, snap(GapDirection::SideRight, gap, right)) {
            continue;
        }
        let left = round6(gap.start_bounds[0] - max_x - gap.length);
        n.push(0, left, snap(GapDirection::SideLeft, gap, left));
    }
    for gap in &g.vertical_gaps {
        if !ranges_overlap([min_x, max_x], gap.overlap) {
            continue;
        }
        let center = round6(gap.start_side[0][1] + gap.length / 2. - cy);
        if gap.length > max_y - min_y
            && n.push(1, center, snap(GapDirection::CenterVertical, gap, center))
        {
            continue;
        }
        let top = round6(gap.start_bounds[1] - max_y - gap.length);
        if n.push(1, top, snap(GapDirection::SideTop, gap, top)) {
            continue;
        }
        let bottom = gap.length - round6(min_y - gap.end_bounds[3]);
        n.push(1, bottom, snap(GapDirection::SideBottom, gap, bottom));
    }
}

fn get_point_snaps(selection_points: &[Point], cache: &SnapCache, n: &mut Nearest) {
    let Some(refs) = &cache.reference_snap_points else {
        return;
    };
    for &p in selection_points {
        for &o in refs {
            let (dx, dy) = (o[0] - p[0], o[1] - p[1]);
            n.push(
                0,
                dx,
                Snap::Point(PointSnap {
                    points: [p, o],
                    offset: dx,
                }),
            );
            n.push(
                1,
                dy,
                Snap::Point(PointSnap {
                    points: [p, o],
                    offset: dy,
                }),
            );
        }
    }
}

/// `snapDraggedElements`: `elements` are the dragged elements as at the
/// drag's start (filtered by the selection), `drag_offset` the drag so far.
pub fn snap_dragged_elements<E: std::borrow::Borrow<Element>>(
    elements: &[E],
    drag_offset: Vector,
    ctx: &SnapCtx,
    event: Option<SnapModifiers>,
    map: &dyn ElementsMap,
    cache: &SnapCache,
) -> SnapResult {
    let selected: Vec<&Element> = elements
        .iter()
        .map(|e| e.borrow())
        .filter(|e| !e.is_deleted && ctx.app.selected_element_ids.contains(&e.id))
        .collect();
    if !is_snapping_enabled(ctx, event, &selected) || selected.is_empty() {
        return SnapResult::default();
    }
    let drag = [round6(drag_offset[0]), round6(drag_offset[1])];
    let mut n = Nearest::new(get_snap_distance(ctx.app.zoom));
    get_point_snaps(
        &get_elements_corners(
            &selected,
            map,
            CornersOpts {
                drag_offset: Some(drag),
                ..Default::default()
            },
        ),
        cache,
        &mut n,
    );
    get_gap_snaps(&selected, map, drag, cache, &mut n);
    let snap_offset = n.offset();
    // lines from where the elements snap to, without shifting
    n.reset();
    let next = [
        round6(drag[0] + snap_offset[0]),
        round6(drag[1] + snap_offset[1]),
    ];
    get_point_snaps(
        &get_elements_corners(
            &selected,
            map,
            CornersOpts {
                drag_offset: Some(next),
                ..Default::default()
            },
        ),
        cache,
        &mut n,
    );
    get_gap_snaps(&selected, map, next, cache, &mut n);
    let mut snap_lines = create_point_snap_lines(&n.x, &n.y);
    let gaps: Vec<GapSnap> =
        n.x.iter()
            .chain(&n.y)
            .filter_map(|s| if let Snap::Gap(g) = s { Some(*g) } else { None })
            .collect();
    snap_lines.extend(create_gap_snap_lines(&selected, map, next, &gaps));
    SnapResult {
        snap_offset,
        snap_lines,
    }
}

/// JS `String(number)` keys sort like this in `Object.entries`: integer-like
/// keys ascending first, then the rest in insertion order.
fn js_object_order(keys: Vec<f64>) -> Vec<f64> {
    let is_index = |k: f64| k >= 0. && k.fract() == 0. && k < 4294967295.;
    let mut ints: Vec<f64> = keys.iter().copied().filter(|&k| is_index(k)).collect();
    ints.sort_by(f64::total_cmp);
    ints.extend(keys.into_iter().filter(|&k| !is_index(k)));
    ints
}

fn dedupe_points(points: Vec<Point>) -> Vec<Point> {
    let mut out: Vec<Point> = vec![];
    for p in points {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

fn create_point_snap_lines(xs: &[Snap], ys: &[Snap]) -> Vec<SnapLine> {
    let collect = |snaps: &[Snap], k: usize| {
        let mut keys: Vec<f64> = vec![];
        let mut map: Vec<(f64, Vec<Point>)> = vec![];
        for s in snaps {
            let Snap::Point(p) = s else { continue };
            let key = round6(p.points[0][k]);
            let key = if key == 0. { 0. } else { key };
            let pts = p.points.map(|q| [round6(q[0]), round6(q[1])]);
            match map.iter_mut().find(|(k2, _)| *k2 == key) {
                Some((_, v)) => v.extend(pts),
                None => {
                    keys.push(key);
                    map.push((key, pts.to_vec()));
                }
            }
        }
        js_object_order(keys)
            .into_iter()
            .map(|key| {
                let mut pts: Vec<Point> = map
                    .iter()
                    .find(|(k2, _)| *k2 == key)
                    .unwrap()
                    .1
                    .iter()
                    .map(|p| if k == 0 { [key, p[1]] } else { [p[0], key] })
                    .collect();
                let o = 1 - k;
                pts.sort_by(|a, b| a[o].total_cmp(&b[o]));
                SnapLine::Points(dedupe_points(pts))
            })
            .collect::<Vec<_>>()
    };
    let mut out = collect(xs, 0);
    out.extend(collect(ys, 1));
    out
}

fn create_gap_snap_lines(
    selected: &[&Element],
    map: &dyn ElementsMap,
    drag: Vector,
    gaps: &[GapSnap],
) -> Vec<SnapLine> {
    let [min_x, min_y, max_x, max_y] =
        get_dragged_elements_bounds(selected.iter().copied(), map, drag[0], drag[1]);
    let mut lines: Vec<(LineDirection, [Point; 2])> = vec![];
    use LineDirection::*;
    for g in gaps {
        let [s_min_x, s_min_y, s_max_x, s_max_y] = g.gap.start_bounds;
        let [e_min_x, e_min_y, e_max_x, e_max_y] = g.gap.end_bounds;
        let vi = range_intersection([min_y, max_y], g.gap.overlap);
        let hi = range_intersection([min_x, max_x], g.gap.overlap);
        match g.direction {
            GapDirection::CenterHorizontal => {
                if let Some(v) = vi {
                    let y = (v[0] + v[1]) / 2.;
                    lines.push((Horizontal, [[g.gap.start_side[0][0], y], [min_x, y]]));
                    lines.push((Horizontal, [[max_x, y], [g.gap.end_side[0][0], y]]));
                }
            }
            GapDirection::CenterVertical => {
                if let Some(h) = hi {
                    let x = (h[0] + h[1]) / 2.;
                    lines.push((Vertical, [[x, g.gap.start_side[0][1]], [x, min_y]]));
                    lines.push((Vertical, [[x, max_y], [x, g.gap.end_side[0][1]]]));
                }
            }
            GapDirection::SideRight => {
                if let Some(v) = vi {
                    let y = (v[0] + v[1]) / 2.;
                    lines.push((Horizontal, [[s_max_x, y], [e_min_x, y]]));
                    lines.push((Horizontal, [[e_max_x, y], [min_x, y]]));
                }
            }
            GapDirection::SideLeft => {
                if let Some(v) = vi {
                    let y = (v[0] + v[1]) / 2.;
                    lines.push((Horizontal, [[max_x, y], [s_min_x, y]]));
                    lines.push((Horizontal, [[s_max_x, y], [e_min_x, y]]));
                }
            }
            GapDirection::SideTop => {
                if let Some(h) = hi {
                    let x = (h[0] + h[1]) / 2.;
                    lines.push((Vertical, [[x, max_y], [x, s_min_y]]));
                    lines.push((Vertical, [[x, s_max_y], [x, e_min_y]]));
                }
            }
            GapDirection::SideBottom => {
                if let Some(h) = hi {
                    let x = (h[0] + h[1]) / 2.;
                    lines.push((Vertical, [[x, s_max_y], [x, e_min_y]]));
                    lines.push((Vertical, [[x, e_max_y], [x, min_y]]));
                }
            }
        }
    }
    let mut out: Vec<SnapLine> = vec![];
    let mut seen: Vec<[Point; 2]> = vec![];
    for (direction, p) in lines {
        let points = p.map(|q| [round6(q[0]), round6(q[1])]);
        if seen.contains(&points) {
            continue;
        }
        seen.push(points);
        out.push(SnapLine::Gap { direction, points });
    }
    out
}

/// `snapResizingElements`: `selected` as they are now (for the lines),
/// `original` as at the resize's start (for the offset).
pub fn snap_resizing_elements(
    selected: &[&Element],
    original: &[&Element],
    ctx: &SnapCtx,
    event: Option<SnapModifiers>,
    drag_offset: Vector,
    handle: Option<HandleType>,
    map: &dyn ElementsMap,
    cache: &SnapCache,
) -> SnapResult {
    if !is_snapping_enabled(ctx, event, selected)
        || selected.is_empty()
        || (selected.len() == 1 && !are_roughly_equal(selected[0].angle, 0., 0.01))
    {
        return SnapResult::default();
    }
    let [mut min_x, mut min_y, mut max_x, mut max_y] =
        get_common_bounds(original.iter().copied(), map);
    let h = handle.map_or("", |h| h.as_str());
    if h.contains('e') {
        max_x += drag_offset[0];
    } else if h.contains('w') {
        min_x += drag_offset[0];
    }
    if h.contains('n') {
        min_y += drag_offset[1];
    } else if h.contains('s') {
        max_y += drag_offset[1];
    }
    let points: Vec<Point> = match handle {
        Some(HandleType::E) => vec![[max_x, min_y], [max_x, max_y]],
        Some(HandleType::W) => vec![[min_x, min_y], [min_x, max_y]],
        Some(HandleType::N) => vec![[min_x, min_y], [max_x, min_y]],
        Some(HandleType::S) => vec![[min_x, max_y], [max_x, max_y]],
        Some(HandleType::Ne) => vec![[max_x, min_y]],
        Some(HandleType::Nw) => vec![[min_x, min_y]],
        Some(HandleType::Se) => vec![[max_x, max_y]],
        Some(HandleType::Sw) => vec![[min_x, max_y]],
        _ => vec![],
    };
    let mut n = Nearest::new(get_snap_distance(ctx.app.zoom));
    if !points.is_empty() || !original.is_empty() {
        get_point_snaps(&points, cache, &mut n);
    }
    let snap_offset = n.offset();
    n.reset();
    let [x1, y1, x2, y2] = get_common_bounds(selected.iter().copied(), map).map(round6);
    get_point_snaps(&[[x1, y1], [x1, y2], [x2, y1], [x2, y2]], cache, &mut n);
    SnapResult {
        snap_offset,
        snap_lines: create_point_snap_lines(&n.x, &n.y),
    }
}

/// `snapNewElement`: snaps the dragged corner of an element being drawn.
pub fn snap_new_element(
    new: &Element,
    ctx: &SnapCtx,
    event: Option<SnapModifiers>,
    origin: Point,
    drag_offset: Vector,
    map: &dyn ElementsMap,
    cache: &SnapCache,
) -> SnapResult {
    if !is_snapping_enabled(ctx, event, &[new]) {
        return SnapResult::default();
    }
    let mut n = Nearest::new(get_snap_distance(ctx.app.zoom));
    get_point_snaps(
        &[[origin[0] + drag_offset[0], origin[1] + drag_offset[1]]],
        cache,
        &mut n,
    );
    let snap_offset = n.offset();
    n.reset();
    get_point_snaps(
        &get_elements_corners(
            &[new],
            map,
            CornersOpts {
                bounding_box_corners: true,
                omit_center: true,
                drag_offset: None,
            },
        ),
        cache,
        &mut n,
    );
    SnapResult {
        snap_offset,
        snap_lines: create_point_snap_lines(&n.x, &n.y),
    }
}

/// `getSnapLinesAtPointer`: where a new element would start (the offset to
/// the nearest reference point on each axis) and the lines to show.
pub fn get_snap_lines_at_pointer(
    elements: &[Element],
    ctx: &SnapCtx,
    pointer: Point,
    event: Option<SnapModifiers>,
    map: &dyn ElementsMap,
) -> (Vector, Vec<SnapLine>) {
    if !is_snapping_enabled(ctx, event, &[]) {
        return ([0., 0.], vec![]);
    }
    let d = get_snap_distance(ctx.app.zoom);
    let mut min = [d, d];
    let (mut horizontal, mut vertical): (Vec<[Point; 2]>, Vec<[Point; 2]>) = (vec![], vec![]);
    for e in reference_elements(elements, &[], ctx, map) {
        for c in get_elements_corners(&[e], map, CornersOpts::default()) {
            let ox = c[0] - pointer[0];
            if ox.abs() <= min[0].abs() {
                if ox.abs() < min[0].abs() {
                    vertical.clear();
                }
                vertical.push([c, [c[0], pointer[1]]]);
                min[0] = ox;
            }
            let oy = c[1] - pointer[1];
            if oy.abs() <= min[1].abs() {
                if oy.abs() < min[1].abs() {
                    horizontal.clear();
                }
                horizontal.push([c, [pointer[0], c[1]]]);
                min[1] = oy;
            }
        }
    }
    let offset = [
        vertical.first().map_or(0., |l| l[0][0] - pointer[0]),
        horizontal.first().map_or(0., |l| l[0][1] - pointer[1]),
    ];
    let lines = vertical
        .into_iter()
        .map(|points| SnapLine::Pointer {
            direction: LineDirection::Vertical,
            points,
        })
        .chain(horizontal.into_iter().map(|points| SnapLine::Pointer {
            direction: LineDirection::Horizontal,
            points,
        }))
        .collect();
    (offset, lines)
}

/// `isActiveToolNonLinearSnappable`.
pub fn is_active_tool_non_linear_snappable(t: ToolType) -> bool {
    matches!(
        t,
        ToolType::Rectangle
            | ToolType::Ellipse
            | ToolType::Diamond
            | ToolType::Frame
            | ToolType::MagicFrame
            | ToolType::Image
            | ToolType::Text
    )
}
