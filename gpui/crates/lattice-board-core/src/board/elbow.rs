// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Elbow arrow routing. Port of Excalidraw `element/src/elbowArrow.ts` and
//! `common/src/binary-heap.ts` @ 3a317b5: the simple one/two-corner route,
//! the A* route on a non-uniform grid around the connected elements, fixed
//! segments (moving, releasing, keeping them while the ends move), the
//! "special" extra corner at a bound end, and renormalizing.
//!
//! Differences from upstream:
//! - upstream calls `updateElbowArrowPoints` from inside `mutateElement`;
//!   here `binding::mutate_elbow_arrow` does (through `BindingHooks`, whose
//!   default routes with this module), as routing needs the scene;
//! - updates are `binding::ElbowUpdate`s: `Some` sets a field, where upstream
//!   spreads a partial object; the no-op short circuit compares bindings by
//!   value (upstream: by identity, which callers never hit for elbow arrows);
//! - hovering while dragging scans `ElementsMap::element_list`; a map that
//!   can't list its elements falls back to the arrow's bindings;
//! - where upstream throws on a route without enough points (endpoint drag,
//!   segment release) the arrow is routed afresh instead;
//! - the dev-only invariants and the out-of-bounds `console.error` are left
//!   out (the clamp to ±1e6 stays).
//!
//! `arrows/focus.ts` and `arrows/helpers.ts` drive the linear editor and
//! live in linear.rs.

use super::binding::{
    BASE_BINDING_GAP, ElbowOptions, ElbowUpdate, bind_point_to_snap_to_element_outline,
    get_binding_gap, get_global_fixed_point_for_bindable_element, get_heading_for_elbow_arrow_snap,
};
use super::bounds::{
    Bounds, aabb_for_element, do_bounds_intersect, get_arrowhead_size, point_inside_bounds,
};
use super::collision::{distance_to_element, get_hovered_element_for_binding};
use super::consts::DEFAULT_ZOOM;
use super::heading::*;
use super::math::*;
use super::shape::ELBOW_ARROW_CORNER_RADIUS;
use super::types::{Arrowhead, Element, FixedPointBinding, FixedSegment, StartOrEnd};
use super::utils::{ElementsMap, get_size_from_points};

const DEDUP_TRESHOLD: f64 = 1.;
pub const BASE_PADDING: f64 = 40.;
const MAX_POS: f64 = 1e6;

// ---------------------------------------------------------------------------
// binary-heap.ts
// ---------------------------------------------------------------------------

/// `BinaryHeap` over node indices, scored by the nodes' `f`. Same sift order
/// as upstream, so ties pop in the same order.
struct BinaryHeap {
    content: Vec<usize>,
}

impl BinaryHeap {
    fn sink_down(&mut self, mut idx: usize, nodes: &[Node]) {
        let node = self.content[idx];
        let score = nodes[node].f;
        while idx > 0 {
            let parent_n = ((idx + 1) >> 1) - 1;
            let parent = self.content[parent_n];
            if score < nodes[parent].f {
                self.content[idx] = parent;
                idx = parent_n;
            } else {
                break;
            }
        }
        self.content[idx] = node;
    }
    fn bubble_up(&mut self, mut idx: usize, nodes: &[Node]) {
        let len = self.content.len();
        let node = self.content[idx];
        let score = nodes[node].f;
        loop {
            let c1 = ((idx + 1) << 1) - 1;
            let c2 = c1 + 1;
            let (mut smallest, mut smallest_score) = (idx, score);
            if c1 < len && nodes[self.content[c1]].f < smallest_score {
                smallest = c1;
                smallest_score = nodes[self.content[c1]].f;
            }
            if c2 < len && nodes[self.content[c2]].f < smallest_score {
                smallest = c2;
            }
            if smallest == idx {
                break;
            }
            self.content[idx] = self.content[smallest];
            idx = smallest;
        }
        self.content[idx] = node;
    }
    fn push(&mut self, n: usize, nodes: &[Node]) {
        self.content.push(n);
        self.sink_down(self.content.len() - 1, nodes);
    }
    fn pop(&mut self, nodes: &[Node]) -> Option<usize> {
        if self.content.is_empty() {
            return None;
        }
        let result = self.content[0];
        let end = self.content.pop().unwrap();
        if !self.content.is_empty() {
            self.content[0] = end;
            self.bubble_up(0, nodes);
        }
        Some(result)
    }
    fn rescore_element(&mut self, n: usize, nodes: &[Node]) {
        // upstream: `sinkDown(indexOf(node))`; the node is always in the heap
        if let Some(i) = self.content.iter().position(|&c| c == n) {
            self.sink_down(i, nodes);
        }
    }
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Node {
    f: f64,
    g: f64,
    h: f64,
    closed: bool,
    visited: bool,
    parent: Option<usize>,
    pos: Point,
    addr: [usize; 2],
}

struct Grid {
    row: usize,
    col: usize,
    data: Vec<Node>,
}

/// `ElbowArrowState` plus the points `getElbowArrowData` reads.
#[derive(Clone, Debug)]
struct ArrowState {
    x: f64,
    y: f64,
    start_binding: Option<FixedPointBinding>,
    end_binding: Option<FixedPointBinding>,
    start_arrowhead: Option<Arrowhead>,
    end_arrowhead: Option<Arrowhead>,
}

impl ArrowState {
    fn of(a: &Element) -> Self {
        let l = a.linear();
        ArrowState {
            x: a.x,
            y: a.y,
            start_binding: l.and_then(|l| l.start_binding.clone()),
            end_binding: l.and_then(|l| l.end_binding.clone()),
            start_arrowhead: l.and_then(|l| l.start_arrowhead),
            end_arrowhead: l.and_then(|l| l.end_arrowhead),
        }
    }
}

struct ElbowArrowData<'a> {
    dynamic_aabbs: [Bounds; 2],
    start_dongle_position: Option<Point>,
    start_global_point: Point,
    start_heading: Heading,
    end_dongle_position: Option<Point>,
    end_global_point: Point,
    end_heading: Heading,
    common_bounds: Bounds,
    hovered_start_element: Option<&'a Element>,
    hovered_end_element: Option<&'a Element>,
}

fn pts(e: &Element) -> &[Point] {
    e.points().unwrap_or(&[])
}
fn fixed_of(e: &Element) -> Option<&Vec<FixedSegment>> {
    e.elbow().and_then(|e| e.fixed_segments.as_ref())
}
fn special(e: &Element) -> (Option<bool>, Option<bool>) {
    e.elbow()
        .map_or((None, None), |e| (e.start_is_special, e.end_is_special))
}
fn global(a: &Element, p: Point) -> Point {
    [a.x + p[0], a.y + p[1]]
}
/// JS `Array.prototype.at`.
fn at<T: Copy>(v: &[T], i: isize) -> Option<T> {
    let i = if i < 0 { v.len() as isize + i } else { i };
    usize::try_from(i).ok().and_then(|i| v.get(i)).copied()
}
fn heading_for(p: Point, o: Point) -> Heading {
    heading_for_point(p, o)
}

/// `getBindableElementForId` (non-deleted, as upstream's map is).
fn bindable_for_id<'a>(id: &str, map: &'a dyn ElementsMap) -> Option<&'a Element> {
    map.get_element(id)
        .filter(|e| !e.is_deleted && e.is_bindable(true))
}

// ---------------------------------------------------------------------------
// fixed segments
// ---------------------------------------------------------------------------

/// `handleSegmentRenormalization`: merges collinear runs and drops short
/// segments, keeping what's fixed.
fn handle_segment_renormalization(arrow: &Element, map: &dyn ElementsMap) -> ElbowUpdate {
    let (si, ei) = special(arrow);
    let Some(mut next_fixed) = fixed_of(arrow).cloned() else {
        return ElbowUpdate {
            x: Some(arrow.x),
            y: Some(arrow.y),
            points: Some(pts(arrow).to_vec()),
            fixed_segments: Some(fixed_of(arrow).cloned()),
            start_is_special: Some(si),
            end_is_special: Some(ei),
            ..Default::default()
        };
    };
    let points: Vec<Point> = pts(arrow).iter().map(|&p| global(arrow, p)).collect();
    let mut np1: Vec<Point> = vec![];
    for (i, &p) in points.iter().enumerate() {
        if i < 2 {
            np1.push(p);
            continue;
        }
        // the previous two points are on the same line
        if compare_heading(
            heading_for(p, points[i - 1]),
            heading_for(points[i - 1], points[i - 2]),
        ) {
            let prev = next_fixed.iter().position(|s| s.index == i - 1);
            let cur = next_fixed.iter().position(|s| s.index == i);
            // the current segment is fixed: update its start point
            if let Some(c) = cur {
                next_fixed[c].start = [points[i - 2][0] - arrow.x, points[i - 2][1] - arrow.y];
            }
            // the previous one is unified with the current one
            if let Some(pv) = prev {
                next_fixed.remove(pv);
            }
            np1.pop();
            for s in &mut next_fixed {
                if s.index > i - 1 {
                    s.index -= 1;
                }
            }
        }
        np1.push(p);
    }
    let mut np: Vec<Point> = vec![];
    for (i, &p) in np1.iter().enumerate() {
        if i < 3 {
            np.push(p);
            continue;
        }
        // segments that are too short
        if point_distance(np1[i - 2], np1[i - 1]) < DEDUP_TRESHOLD {
            let pp = next_fixed.iter().position(|s| s.index == i - 2);
            let pv = next_fixed.iter().position(|s| s.index == i - 1);
            // (upstream splices with the indices found before either splice)
            if let Some(x) = pv
                && x < next_fixed.len()
            {
                next_fixed.remove(x);
            }
            if let Some(x) = pp
                && x < next_fixed.len()
            {
                next_fixed.remove(x);
            }
            np.truncate(np.len().saturating_sub(2));
            for s in &mut next_fixed {
                if s.index > i - 2 {
                    s.index -= 2;
                }
            }
            // aligned segment points
            let h = heading_for_point_is_horizontal(p, np1[i - 1]);
            np.push([
                if !h { np1[i - 2][0] } else { p[0] },
                if h { np1[i - 2][1] } else { p[1] },
            ]);
            continue;
        }
        np.push(p);
    }
    let n = np.len();
    let filtered: Vec<FixedSegment> = next_fixed
        .into_iter()
        .filter(|s| s.index != 1 && s.index + 1 != n)
        .collect();
    if filtered.is_empty() {
        let local: Vec<Point> = np
            .iter()
            .map(|p| [p[0] - arrow.x, p[1] - arrow.y])
            .collect();
        let st = ArrowState::of(arrow);
        let data = get_elbow_arrow_data(arrow, &st, map, &local, &ElbowOptions::default());
        return normalize_arrow_element_update(
            &get_elbow_arrow_route(&st, &data, map),
            &filtered,
            None,
            None,
        );
    }
    normalize_arrow_element_update(&np, &filtered, si, ei)
}

/// `handleSegmentRelease`: a fixed segment let go; the stretch between its
/// fixed neighbours is routed again.
fn handle_segment_release(
    arrow: &Element,
    fixed_segments: &[FixedSegment],
    map: &dyn ElementsMap,
) -> ElbowUpdate {
    let points = pts(arrow);
    let new_idx: Vec<usize> = fixed_segments.iter().map(|s| s.index).collect();
    let old = fixed_of(arrow).cloned().unwrap_or_default();
    let Some(deleted_si) = old.iter().position(|s| !new_idx.contains(&s.index)) else {
        return ElbowUpdate {
            points: Some(points.to_vec()),
            ..Default::default()
        };
    };
    let deleted_idx = old[deleted_si].index;
    let prev = deleted_si.checked_sub(1).and_then(|i| old.get(i)).copied();
    let next = old.get(deleted_si + 1).copied();
    // a sub-arrow path restores the deleted segments
    let x = arrow.x + prev.map_or(0., |p| p.end[0]);
    let y = arrow.y + prev.map_or(0., |p| p.end[1]);
    let l = arrow.linear();
    let st = ArrowState {
        x,
        y,
        start_binding: if prev.is_some() {
            None
        } else {
            l.and_then(|l| l.start_binding.clone())
        },
        end_binding: if next.is_some() {
            None
        } else {
            l.and_then(|l| l.end_binding.clone())
        },
        start_arrowhead: None,
        end_arrowhead: None,
    };
    let last = points[points.len() - 1];
    let end = next.map_or(last, |n| n.start);
    let data = get_elbow_arrow_data(
        arrow,
        &st,
        map,
        &[[0., 0.], [arrow.x + end[0] - x, arrow.y + end[1] - y]],
        &ElbowOptions::default(),
    );
    let restored = normalize_arrow_element_update(
        &get_elbow_arrow_route(&ArrowState::of(arrow), &data, map),
        fixed_segments,
        None,
        None,
    )
    .points
    .unwrap_or_default();
    if restored.len() < 2 {
        return route_afresh(arrow, map);
    }
    let mut np: Vec<Point> = vec![];
    // the first part of the arrow are the old points
    if let Some(p) = prev {
        for &q in &points[..p.index.min(points.len())] {
            np.push(global(arrow, q));
        }
    }
    for p in &restored {
        np.push([x + p[0], y + p[1]]);
    }
    // the last part too
    if let Some(n) = next {
        for &q in &points[n.index.min(points.len())..] {
            np.push(global(arrow, q));
        }
    }
    let diff =
        next.map_or(points.len(), |n| n.index) as isize - prev.map_or(0, |p| p.index) as isize - 1;
    let mut next_fixed: Vec<FixedSegment> = fixed_segments
        .iter()
        .map(|&s| {
            if s.index > deleted_idx {
                FixedSegment {
                    index: (s.index as isize - diff + restored.len() as isize - 1) as usize,
                    ..s
                }
            } else {
                s
            }
        })
        .collect();
    let mut simplified: Vec<Point> = vec![];
    for i in 0..np.len() {
        let p = np[i];
        if i > 0 && i + 1 < np.len() {
            let (ph, nh) = (heading_for(p, np[i - 1]), heading_for(np[i + 1], p));
            if compare_heading(ph, nh) {
                for s in &mut next_fixed {
                    if s.index > i {
                        s.index -= 1;
                    }
                }
                continue;
            } else if compare_heading(ph, flip_heading(nh)) {
                for s in &mut next_fixed {
                    if s.index > i {
                        s.index += 1;
                    }
                }
                simplified.push(p);
                simplified.push(p);
                continue;
            }
        }
        simplified.push(p);
    }
    normalize_arrow_element_update(&simplified, &next_fixed, Some(false), Some(false))
}

/// `handleSegmentMove`: one fixed segment dragged.
fn handle_segment_move(
    arrow: &Element,
    fixed_segments: &[FixedSegment],
    start_heading: Heading,
    end_heading: Heading,
    hovered_start: Option<&Element>,
    hovered_end: Option<&Element>,
) -> ElbowUpdate {
    let points = pts(arrow);
    let old = fixed_of(arrow);
    let mut fixed = fixed_segments.to_vec();
    let active = fixed
        .iter()
        .enumerate()
        .position(|(i, s)| match old.and_then(|o| o.get(i)) {
            Some(o) if o.index == s.index => {
                (s.start[0] != o.start[0] && s.end[0] != o.end[0])
                    != (s.start[1] != o.start[1] && s.end[1] != o.end[1])
            }
            _ => true,
        });
    let Some(a) = active else {
        return ElbowUpdate {
            points: Some(points.to_vec()),
            ..Default::default()
        };
    };
    let first_seg = old.and_then(|o| o.iter().position(|s| s.index == 1));
    let last_seg = old.and_then(|o| o.iter().position(|s| s.index + 1 == points.len()));
    // the special cases of moving the first and last segment
    let len = point_distance(fixed[a].start, fixed[a].end);
    let too_short = len < BASE_PADDING + 5.;
    let pad = |positive: bool| {
        if positive {
            if too_short { len / 2. } else { BASE_PADDING }
        } else if too_short {
            -len / 2.
        } else {
            -BASE_PADDING
        }
    };
    if first_seg.is_none() && fixed[a].index == 1 && hovered_start.is_some() {
        let h = heading_is_horizontal(start_heading);
        let p = pad(if h {
            compare_heading(start_heading, HEADING_RIGHT)
        } else {
            compare_heading(start_heading, HEADING_DOWN)
        });
        fixed[a].start = [
            fixed[a].start[0] + if h { p } else { 0. },
            fixed[a].start[1] + if !h { p } else { 0. },
        ];
    }
    if last_seg.is_none() && fixed[a].index + 1 == points.len() && hovered_end.is_some() {
        let h = heading_is_horizontal(end_heading);
        let p = pad(if h {
            compare_heading(end_heading, HEADING_RIGHT)
        } else {
            compare_heading(end_heading, HEADING_DOWN)
        });
        fixed[a].end = [
            fixed[a].end[0] + if h { p } else { 0. },
            fixed[a].end[1] + if !h { p } else { 0. },
        ];
    }
    // all fixed segments to global coordinates
    let mut nf: Vec<FixedSegment> = fixed
        .iter()
        .map(|s| FixedSegment {
            start: global(arrow, s.start),
            end: global(arrow, s.end),
            index: s.index,
        })
        .collect();
    let mut np: Vec<Point> = points.iter().map(|&p| global(arrow, p)).collect();
    let start_idx = nf[a].index as isize - 1;
    let end_idx = nf[a].index;
    let (start, end) = (nf[a].start, nf[a].end);
    let g = |i: isize| at(&np, i).filter(|_| i >= 0);
    let prev_h = match (g(start_idx - 1), g(start_idx)) {
        (Some(a), Some(b)) if !points_equal(b, a, PRECISION) => {
            Some(heading_for_point_is_horizontal(a, b))
        }
        _ => None,
    };
    let next_h = match (np.get(end_idx + 1), np.get(end_idx)) {
        (Some(&a), Some(&b)) if !points_equal(b, a, PRECISION) => {
            Some(heading_for_point_is_horizontal(a, b))
        }
        _ => None,
    };
    // the moved segment overrides the points
    if let Some(h) = prev_h {
        let d = if h { 1 } else { 0 };
        np[(start_idx - 1) as usize][d] = start[d];
    }
    if start_idx >= 0 {
        np[start_idx as usize] = start;
    }
    if end_idx < np.len() {
        np[end_idx] = end;
    }
    if let Some(h) = next_h {
        let d = if h { 1 } else { 0 };
        np[end_idx + 1][d] = end[d];
    }
    // and the neighbouring fixed segments' ends
    if let Some(pi) = nf.iter().position(|s| s.index as isize == start_idx) {
        let d = if heading_for_point_is_horizontal(nf[pi].end, nf[pi].start) {
            1
        } else {
            0
        };
        nf[pi].start[d] = start[d];
        nf[pi].end = start;
    }
    if let Some(ni) = nf.iter().position(|s| s.index == end_idx + 1) {
        let d = if heading_for_point_is_horizontal(nf[ni].end, nf[ni].start) {
            1
        } else {
            0
        };
        nf[ni].end[d] = end[d];
        nf[ni].start = end;
    }
    // moving the first segment needs another segment
    if first_seg.is_none() && start_idx == 0 {
        let h = if hovered_start.is_some() {
            heading_is_horizontal(start_heading)
        } else {
            heading_for_point_is_horizontal(np[1], np[0])
        };
        let p0 = global(arrow, points[0]);
        np.insert(
            0,
            [
                if h { start[0] } else { p0[0] },
                if !h { start[1] } else { p0[1] },
            ],
        );
        if hovered_start.is_some() {
            np.insert(0, p0);
        }
        for s in &mut nf {
            s.index += if hovered_start.is_some() { 2 } else { 1 };
        }
    }
    // the last one too
    if last_seg.is_none() && end_idx + 1 == points.len() {
        let h = heading_is_horizontal(end_heading);
        let pl = global(arrow, points[points.len() - 1]);
        np.push([
            if h { end[0] } else { pl[0] },
            if !h { end[1] } else { pl[1] },
        ]);
        if hovered_end.is_some() {
            np.push(pl);
        }
    }
    let local: Vec<FixedSegment> = nf
        .iter()
        .map(|s| FixedSegment {
            start: [s.start[0] - arrow.x, s.start[1] - arrow.y],
            end: [s.end[0] - arrow.x, s.end[1] - arrow.y],
            index: s.index,
        })
        .collect();
    // a moved segment leaves no special points
    normalize_arrow_element_update(&np, &local, Some(false), Some(false))
}

/// `handleEndpointDrag`: an end moved while segments are fixed; the arrow
/// keeps its segment count.
#[allow(clippy::too_many_arguments)]
fn handle_endpoint_drag(
    arrow: &Element,
    updated: &[Point],
    fixed_segments: &[FixedSegment],
    start_heading: Heading,
    end_heading: Heading,
    start_global: Point,
    end_global: Point,
    hovered_start: Option<&Element>,
    hovered_end: Option<&Element>,
    map: &dyn ElementsMap,
) -> ElbowUpdate {
    let points = pts(arrow);
    let (si, ei) = special(arrow);
    let (mut start_special, mut end_special) = (si.unwrap_or(false), ei.unwrap_or(false));
    let n = updated.len();
    let gu: Vec<Point> = updated
        .iter()
        .enumerate()
        .map(|(i, &p)| {
            if i == 0 || i == n - 1 {
                global(arrow, p)
            } else {
                global(arrow, points[i])
            }
        })
        .collect();
    let mut nf: Vec<FixedSegment> = fixed_segments.to_vec();
    let mut np: Vec<Point> = vec![];
    // the inside points
    let offset = 2 + start_special as usize;
    let end_offset = 2 + end_special as usize;
    while np.len() + offset < gu.len().saturating_sub(end_offset) {
        np.push(gu[np.len() + offset]);
    }
    let bp = |positive: bool| {
        if positive {
            BASE_PADDING
        } else {
            -BASE_PADDING
        }
    };
    // the moving second point and the start point
    {
        let (Some(second), Some(third)) = (
            at(&gu, if start_special { 2 } else { 1 }),
            at(&gu, if start_special { 3 } else { 2 }),
        ) else {
            return route_afresh(arrow, map);
        };
        let sh = heading_is_horizontal(start_heading);
        let second_h = heading_is_horizontal(vector_to_heading(vector_from_point(second, third)));
        if hovered_start.is_some() && sh == second_h {
            let p = bp(if sh {
                compare_heading(start_heading, HEADING_RIGHT)
            } else {
                compare_heading(start_heading, HEADING_DOWN)
            });
            np.insert(
                0,
                [
                    if !second_h {
                        third[0]
                    } else {
                        start_global[0] + p
                    },
                    if second_h {
                        third[1]
                    } else {
                        start_global[1] + p
                    },
                ],
            );
            np.insert(
                0,
                [
                    if sh {
                        start_global[0] + p
                    } else {
                        start_global[0]
                    },
                    if !sh {
                        start_global[1] + p
                    } else {
                        start_global[1]
                    },
                ],
            );
            if !start_special {
                start_special = true;
                for s in &mut nf {
                    if s.index > 1 {
                        s.index += 1;
                    }
                }
            }
        } else {
            np.insert(
                0,
                [
                    if !second_h {
                        second[0]
                    } else {
                        start_global[0]
                    },
                    if second_h { second[1] } else { start_global[1] },
                ],
            );
            if start_special {
                start_special = false;
                for s in &mut nf {
                    if s.index > 1 {
                        s.index -= 1;
                    }
                }
            }
        }
        np.insert(0, start_global);
    }
    // the moving second to last point
    {
        let gl = gu.len() as isize;
        let (Some(second_last), Some(third_last)) = (
            at(&gu, gl - if end_special { 3 } else { 2 }),
            at(&gu, gl - if end_special { 4 } else { 3 }),
        ) else {
            return route_afresh(arrow, map);
        };
        let eh = heading_is_horizontal(end_heading);
        let second_h = heading_for_point_is_horizontal(third_last, second_last);
        if hovered_end.is_some() && eh == second_h {
            let p = bp(if eh {
                compare_heading(end_heading, HEADING_RIGHT)
            } else {
                compare_heading(end_heading, HEADING_DOWN)
            });
            np.push([
                if !second_h {
                    third_last[0]
                } else {
                    end_global[0] + p
                },
                if second_h {
                    third_last[1]
                } else {
                    end_global[1] + p
                },
            ]);
            np.push([
                if eh { end_global[0] + p } else { end_global[0] },
                if !eh {
                    end_global[1] + p
                } else {
                    end_global[1]
                },
            ]);
            end_special = true;
        } else {
            np.push([
                if !second_h {
                    second_last[0]
                } else {
                    end_global[0]
                },
                if second_h {
                    second_last[1]
                } else {
                    end_global[1]
                },
            ]);
            end_special = false;
        }
    }
    np.push(end_global);
    let segs: Vec<FixedSegment> = nf
        .iter()
        .map(|s| {
            let (a, b) = (
                np.get(s.index.wrapping_sub(1))
                    .copied()
                    .unwrap_or([f64::NAN; 2]),
                np.get(s.index).copied().unwrap_or([f64::NAN; 2]),
            );
            FixedSegment {
                index: s.index,
                start: [a[0] - start_global[0], a[1] - start_global[1]],
                end: [b[0] - start_global[0], b[1] - start_global[1]],
            }
        })
        .collect();
    normalize_arrow_element_update(&np, &segs, Some(start_special), Some(end_special))
}

/// Where upstream would throw: route the arrow from end to end.
fn route_afresh(arrow: &Element, map: &dyn ElementsMap) -> ElbowUpdate {
    let p = pts(arrow);
    let st = ArrowState::of(arrow);
    let data = get_elbow_arrow_data(
        arrow,
        &st,
        map,
        &[p[0], p[p.len() - 1]],
        &ElbowOptions::default(),
    );
    normalize_arrow_element_update(&get_elbow_arrow_route(&st, &data, map), &[], None, None)
}

// ---------------------------------------------------------------------------
// updateElbowArrowPoints
// ---------------------------------------------------------------------------

/// `updateElbowArrowPoints`: the update that routes `arrow` (with `x`/`y`
/// from `updates` already applied) for `updates`. Apply it over `updates`.
pub fn update_elbow_arrow_points(
    arrow: &Element,
    map: &dyn ElementsMap,
    updates: &ElbowUpdate,
    opts: &ElbowOptions,
) -> ElbowUpdate {
    let points = pts(arrow);
    if points.len() < 2 {
        return ElbowUpdate {
            points: Some(updates.points.clone().unwrap_or_else(|| points.to_vec())),
            ..Default::default()
        };
    }
    let fixed_segments: Vec<FixedSegment> = updates
        .fixed_segments
        .clone()
        .flatten()
        .or_else(|| fixed_of(arrow).cloned())
        .unwrap_or_default();
    let updated: Vec<Point> = match &updates.points {
        Some(u) if u.len() == 2 => points
            .iter()
            .enumerate()
            .map(|(i, &p)| {
                if i == 0 {
                    u[0]
                } else if i == points.len() - 1 {
                    u[1]
                } else {
                    p
                }
            })
            .collect(),
        Some(u) => u.clone(),
        None => points.to_vec(),
    };
    let l = arrow.linear().unwrap();
    let start_binding = updates
        .start_binding
        .clone()
        .unwrap_or_else(|| l.start_binding.clone());
    let end_binding = updates
        .end_binding
        .clone()
        .unwrap_or_else(|| l.end_binding.clone());
    let start_el = start_binding
        .as_ref()
        .and_then(|b| bindable_for_id(&b.element_id, map));
    let end_el = end_binding
        .as_ref()
        .and_then(|b| bindable_for_id(&b.element_id, map));
    let valid = validate_elbow_points(&updated, DEDUP_TRESHOLD);
    let empty = map
        .element_list()
        .is_some_and(|l| l.iter().all(|e| e.is_deleted));
    let rest_empty = updates.x.is_none()
        && updates.y.is_none()
        && updates.width.is_none()
        && updates.height.is_none()
        && updates.points.is_none()
        && updates.fixed_segments.is_none()
        && updates.start_is_special.is_none()
        && updates.end_is_special.is_none();
    let (si, ei) = special(arrow);
    let renormalize = || {
        normalize_arrow_element_update(
            &updated
                .iter()
                .map(|&p| global(arrow, p))
                .collect::<Vec<_>>(),
            fixed_of(arrow).map_or(&[][..], |f| f),
            si,
            ei,
        )
    };
    if (start_binding.is_some() && start_el.is_none() && valid)
        || (end_binding.is_some() && end_el.is_none() && valid)
        || (empty && valid)
        || (rest_empty
            && ((start_binding.is_some() && start_el.is_none())
                || (end_binding.is_some() && end_el.is_none())))
    {
        return renormalize();
    }
    let st = ArrowState {
        start_binding,
        end_binding,
        ..ArrowState::of(arrow)
    };
    let data = get_elbow_arrow_data(arrow, &st, map, &updated, opts);
    // 1. renormalize the arrow
    let falsy = |b: &Option<Option<FixedPointBinding>>| b.as_ref().is_none_or(|b| b.is_none());
    if updates.points.is_none()
        && updates.fixed_segments.as_ref().is_none_or(|f| f.is_none())
        && falsy(&updates.start_binding)
        && falsy(&updates.end_binding)
    {
        return handle_segment_renormalization(arrow, map);
    }
    // short circuit on no-op
    if updates.start_binding.as_ref() == Some(&l.start_binding)
        && updates.end_binding.as_ref() == Some(&l.end_binding)
        && updates.points.iter().flatten().enumerate().all(|(i, p)| {
            points_equal(
                *p,
                points.get(i).copied().unwrap_or([f64::INFINITY; 2]),
                PRECISION,
            )
        })
        && valid
    {
        return ElbowUpdate::default();
    }
    // 2. just normal elbow arrow things
    if fixed_segments.is_empty() {
        // (routed with the arrow's own bindings and arrowheads, as upstream)
        return normalize_arrow_element_update(
            &get_elbow_arrow_route(&ArrowState::of(arrow), &data, map),
            &fixed_segments,
            None,
            None,
        );
    }
    // 3. releasing a fixed segment
    if fixed_of(arrow).map_or(0, |f| f.len()) > fixed_segments.len() {
        return handle_segment_release(arrow, &fixed_segments, map);
    }
    // 4. a segment moved
    if updates.points.is_none() {
        return handle_segment_move(
            arrow,
            &fixed_segments,
            data.start_heading,
            data.end_heading,
            data.hovered_start_element,
            data.hovered_end_element,
        );
    }
    // 5. resize
    if updates.fixed_segments.as_ref().is_some_and(|f| f.is_some()) {
        return updates.clone();
    }
    // 6. segments fixed and the ends moved: same segment count, fixed
    //    segments replace exactly one segment of the old arrow each
    handle_endpoint_drag(
        arrow,
        &updated,
        &fixed_segments,
        data.start_heading,
        data.end_heading,
        data.start_global_point,
        data.end_global_point,
        data.hovered_start_element,
        data.hovered_end_element,
        map,
    )
}

/// `updateElbowArrowRoute`: routes the arrow again where it is (e.g. once
/// its arrowheads change, as its route makes room for them).
pub fn update_elbow_arrow_route(arrow: &Element, map: &dyn ElementsMap) -> ElbowUpdate {
    let p = pts(arrow);
    update_elbow_arrow_points(
        arrow,
        map,
        &ElbowUpdate {
            points: Some(vec![p[0], p[p.len() - 1]]),
            ..Default::default()
        },
        &ElbowOptions::default(),
    )
}

/// `getElbowArrowData`. `base` is the arrow (for its type and style); `st`
/// overrides its position, bindings and arrowheads.
fn get_elbow_arrow_data<'a>(
    base: &Element,
    st: &ArrowState,
    map: &'a dyn ElementsMap,
    next_points: &[Point],
    opts: &ElbowOptions,
) -> ElbowArrowData<'a> {
    let orig_start = point_translate(next_points[0], [st.x, st.y]);
    let orig_end = point_translate(next_points[next_points.len() - 1], [st.x, st.y]);
    // updates through `mutateElement` don't carry the zoom
    let zoom = DEFAULT_ZOOM;
    let (hovered_start, hovered_end): (Option<&Element>, Option<&Element>) =
        match map.element_list() {
            Some(list) if opts.is_dragging && opts.is_binding_enabled != Some(false) => {
                let hs = get_hovered_element_for_binding(orig_start, &list, map, zoom)
                    .map(|e| e.id.clone());
                let he = get_hovered_element_for_binding(orig_end, &list, map, zoom)
                    .map(|e| e.id.clone());
                (
                    hs.and_then(|id| map.get_element(&id)),
                    he.and_then(|id| map.get_element(&id)),
                )
            }
            _ => (
                st.start_binding
                    .as_ref()
                    .and_then(|b| bindable_for_id(&b.element_id, map)),
                st.end_binding
                    .as_ref()
                    .and_then(|b| bindable_for_id(&b.element_id, map)),
            ),
        };
    let mut tmp = base.clone();
    (tmp.x, tmp.y, tmp.angle) = (st.x, st.y, 0.);
    if let Some(l) = tmp.linear_mut() {
        l.points = next_points.to_vec();
        (
            l.start_binding,
            l.end_binding,
            l.start_arrowhead,
            l.end_arrowhead,
        ) = (
            st.start_binding.clone(),
            st.end_binding.clone(),
            st.start_arrowhead,
            st.end_arrowhead,
        );
    }
    let fixed = |b: &Option<FixedPointBinding>| b.as_ref().map(|b| b.fixed_point);
    let start_global = get_global_point(
        &tmp,
        StartOrEnd::Start,
        fixed(&st.start_binding),
        orig_start,
        zoom,
        hovered_start,
        map,
        opts,
    );
    let end_global = get_global_point(
        &tmp,
        StartOrEnd::End,
        fixed(&st.end_binding),
        orig_end,
        zoom,
        hovered_end,
        map,
        opts,
    );
    let start_heading = get_bind_point_heading(
        start_global,
        end_global,
        hovered_start,
        orig_start,
        map,
        zoom,
    );
    let end_heading =
        get_bind_point_heading(end_global, start_global, hovered_end, orig_end, map, zoom);
    let pb = |p: Point| [p[0] - 2., p[1] - 2., p[0] + 2., p[1] + 2.];
    let (start_pb, end_pb) = (pb(start_global), pb(end_global));
    let el_bounds = |h: Option<&Element>,
                     heading: Heading,
                     arrowhead: Option<Arrowhead>,
                     fallback: Bounds| match h {
        Some(h) => aabb_for_element(
            h,
            map,
            Some(offset_from_heading(
                heading,
                get_binding_gap(h.stroke_width) * if arrowhead.is_some() { 6. } else { 2. },
                1.,
            )),
        ),
        None => fallback,
    };
    let start_eb = el_bounds(hovered_start, start_heading, st.start_arrowhead, start_pb);
    let end_eb = el_bounds(hovered_end, end_heading, st.end_arrowhead, end_pb);
    let padded = |h: Option<&Element>, heading: Heading, fallback: Bounds| {
        h.map_or(fallback, |h| {
            aabb_for_element(
                h,
                map,
                Some(offset_from_heading(heading, BASE_PADDING, BASE_PADDING)),
            )
        })
    };
    let overlap = point_inside_bounds(start_global, padded(hovered_end, end_heading, end_pb))
        || point_inside_bounds(end_global, padded(hovered_start, start_heading, start_pb));
    let common = common_aabb(&if overlap {
        [start_pb, end_pb]
    } else {
        [start_eb, end_eb]
    });
    let none_hovered = hovered_start.is_none() && hovered_end.is_none();
    let diff = |heading: Heading, arrowhead: Option<Arrowhead>| {
        if overlap {
            offset_from_heading(heading, if none_hovered { 0. } else { BASE_PADDING }, 0.)
        } else {
            offset_from_heading(
                heading,
                if none_hovered {
                    0.
                } else {
                    BASE_PADDING
                        - if arrowhead.is_some() {
                            BASE_BINDING_GAP * 6.
                        } else {
                            BASE_BINDING_GAP * 2.
                        }
                },
                BASE_PADDING,
            )
        }
    };
    let dynamic = generate_dynamic_aabbs(
        if overlap { start_pb } else { start_eb },
        if overlap { end_pb } else { end_eb },
        common,
        Some(diff(start_heading, st.start_arrowhead)),
        Some(diff(end_heading, st.end_arrowhead)),
        overlap,
        hovered_start.map(|h| aabb_for_element(h, map, None)),
        hovered_end.map(|h| aabb_for_element(h, map, None)),
    );
    ElbowArrowData {
        start_dongle_position: Some(get_dongle_position(dynamic[0], start_heading, start_global)),
        end_dongle_position: Some(get_dongle_position(dynamic[1], end_heading, end_global)),
        dynamic_aabbs: dynamic,
        start_global_point: start_global,
        start_heading,
        end_global_point: end_global,
        end_heading,
        common_bounds: common,
        hovered_start_element: hovered_start,
        hovered_end_element: hovered_end,
    }
}

/// Whether an axis-aligned segment passes through `bounds`.
fn segment_crosses_bounds(a: Point, b: Point, bounds: Bounds) -> bool {
    do_bounds_intersect(
        Some([
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[0].max(b[0]),
            a[1].max(b[1]),
        ]),
        Some(bounds),
    )
}

/// `getSimpleRoute`: between two bound elements, one corner (leaving one
/// and entering the other at a right angle) or two (heading the same way),
/// if that fits clear of both.
fn get_simple_route(
    st: &ArrowState,
    d: &ElbowArrowData,
    map: &dyn ElementsMap,
) -> Option<Vec<Point>> {
    let (sh, eh) = (d.start_heading, d.end_heading);
    let one_corner = heading_is_horizontal(sh) != heading_is_horizontal(eh);
    let (Some(hs), Some(he)) = (d.hovered_start_element, d.hovered_end_element) else {
        return None;
    };
    if hs.id == he.id || (!one_corner && !compare_heading(sh, flip_heading(eh))) {
        return None;
    }
    let (s, e) = (d.start_global_point, d.end_global_point);
    // legs as long as each end is ahead of the other along its heading
    let ahead = (e[0] - s[0]) * sh[0] + (e[1] - s[1]) * sh[1];
    let (first_leg, last_leg);
    if one_corner {
        first_leg = ahead;
        last_leg = (s[0] - e[0]) * eh[0] + (s[1] - e[1]) * eh[1];
    } else {
        // halfway, unless that leaves an arrowhead a leg shorter than the
        // padding and the other end can spare some (keeping its corner)
        let mut f = ahead / 2.;
        if st.start_arrowhead.is_none() != st.end_arrowhead.is_none() {
            let leg = (ahead / 2.).max(BASE_PADDING.min(ahead - ELBOW_ARROW_CORNER_RADIUS * 2.));
            f = if st.start_arrowhead.is_some() {
                leg
            } else {
                ahead - leg
            };
        }
        first_leg = f;
        last_leg = ahead - f;
    }
    // a leg keeps its corner rounded, and fits its arrowhead
    let min_leg = |a: Option<Arrowhead>| {
        (ELBOW_ARROW_CORNER_RADIUS / 2.).max(a.map_or(0., get_arrowhead_size))
    };
    if first_leg <= min_leg(st.start_arrowhead) || last_leg <= min_leg(st.end_arrowhead) {
        return None;
    }
    let first_turn = [s[0] + sh[0] * first_leg, s[1] + sh[1] * first_leg];
    let last_turn = [e[0] + eh[0] * last_leg, e[1] + eh[1] * last_leg];
    let b = |el: &Element| {
        let g = get_binding_gap(el.stroke_width);
        aabb_for_element(el, map, Some([g, g, g, g]))
    };
    let (sb, eb) = (b(hs), b(he));
    if segment_crosses_bounds(s, first_turn, eb)
        || segment_crosses_bounds(first_turn, last_turn, sb)
        || segment_crosses_bounds(first_turn, last_turn, eb)
        || segment_crosses_bounds(last_turn, e, sb)
    {
        return None;
    }
    Some(vec![s, first_turn, last_turn, e])
}

/// `getElbowArrowRoute`: the simple route if it fits, the grid route
/// otherwise, without short segments and collinear points.
fn get_elbow_arrow_route(st: &ArrowState, d: &ElbowArrowData, map: &dyn ElementsMap) -> Vec<Point> {
    get_elbow_arrow_corner_points(remove_elbow_arrow_short_segments(
        get_simple_route(st, d, map)
            .or_else(|| get_elbow_arrow_grid_route(st, d))
            .unwrap_or_default(),
    ))
}

/// `getElbowArrowGridRoute`: A* on the grid, keeping a padding around the
/// connected elements.
fn get_elbow_arrow_grid_route(st: &ArrowState, d: &ElbowArrowData) -> Option<Vec<Point>> {
    let mut grid = calculate_grid(
        &d.dynamic_aabbs,
        d.start_dongle_position.unwrap_or(d.start_global_point),
        d.start_heading,
        d.end_dongle_position.unwrap_or(d.end_global_point),
        d.end_heading,
        d.common_bounds,
    );
    let start_dongle = d
        .start_dongle_position
        .and_then(|p| point_to_grid_node(p, &grid));
    let end_dongle = d
        .end_dongle_position
        .and_then(|p| point_to_grid_node(p, &grid));
    // don't step on the true end or start points
    let end_node = point_to_grid_node(d.end_global_point, &grid);
    if let Some(n) = end_node
        && d.hovered_end_element.is_some()
    {
        grid.data[n].closed = true;
    }
    let start_node = point_to_grid_node(d.start_global_point, &grid);
    if let Some(n) = start_node
        && st.start_binding.is_some()
    {
        grid.data[n].closed = true;
    }
    let dongle_overlap = match (start_dongle, end_dongle) {
        (Some(s), Some(e)) => {
            point_inside_bounds(grid.data[s].pos, d.dynamic_aabbs[1])
                || point_inside_bounds(grid.data[e].pos, d.dynamic_aabbs[0])
        }
        _ => false,
    };
    let (start, end) = (start_dongle.or(start_node)?, end_dongle.or(end_node)?);
    let path = astar(
        start,
        end,
        &mut grid,
        d.start_heading,
        d.end_heading,
        if dongle_overlap {
            &[]
        } else {
            &d.dynamic_aabbs
        },
    )?;
    let mut points: Vec<Point> = path.iter().map(|&n| grid.data[n].pos).collect();
    if start_dongle.is_some() {
        points.insert(0, d.start_global_point);
    }
    if end_dongle.is_some() {
        points.push(d.end_global_point);
    }
    Some(points)
}

/// `offsetFromHeading`: top, right, bottom, left.
fn offset_from_heading(h: Heading, head: f64, side: f64) -> [f64; 4] {
    if compare_heading(h, HEADING_UP) {
        [head, side, side, side]
    } else if compare_heading(h, HEADING_RIGHT) {
        [side, head, side, side]
    } else if compare_heading(h, HEADING_DOWN) {
        [side, side, head, side]
    } else {
        [side, side, side, head]
    }
}

/// `astar`: A* with turns penalized and no going back over the previous
/// segment.
fn astar(
    start: usize,
    end: usize,
    grid: &mut Grid,
    start_heading: Heading,
    end_heading: Heading,
    aabbs: &[Bounds],
) -> Option<Vec<usize>> {
    let bend = m_dist(grid.data[start].pos, grid.data[end].pos);
    let mut open = BinaryHeap { content: vec![] };
    open.push(start, &grid.data);
    while let Some(current) = open.pop(&grid.data) {
        if grid.data[current].closed {
            continue;
        }
        if current == end {
            return Some(path_to(start, current, grid));
        }
        grid.data[current].closed = true;
        let neighbors = get_neighbors(grid.data[current].addr, grid);
        for (i, nb) in neighbors.into_iter().enumerate() {
            let Some(nb) = nb else { continue };
            if grid.data[nb].closed {
                continue;
            }
            let (cpos, npos) = (grid.data[current].pos, grid.data[nb].pos);
            let half = point_scale_from_origin(npos, cpos, 0.5);
            if aabbs.iter().any(|b| point_inside_bounds(half, *b)) {
                continue;
            }
            let nh = neighbor_index_to_heading(i);
            let prev_dir = match grid.data[current].parent {
                Some(p) => vector_to_heading(vector_from_point(cpos, grid.data[p].pos)),
                None => start_heading,
            };
            // no going in reverse
            let reverse = compare_heading(flip_heading(prev_dir), nh)
                || (grid.data[start].addr == grid.data[nb].addr
                    && compare_heading(nh, start_heading))
                || (grid.data[end].addr == grid.data[nb].addr && compare_heading(nh, end_heading));
            if reverse {
                continue;
            }
            let direction_change = !compare_heading(prev_dir, nh);
            let g = grid.data[current].g
                + m_dist(npos, cpos)
                + if direction_change { bend.powi(3) } else { 0. };
            let visited = grid.data[nb].visited;
            if !visited || g < grid.data[nb].g {
                let est = estimate_segment_count(&grid.data[nb], &grid.data[end], nh, end_heading);
                let epos = grid.data[end].pos;
                let n = &mut grid.data[nb];
                n.visited = true;
                n.parent = Some(current);
                n.h = m_dist(epos, npos) + est * bend.powi(2);
                n.g = g;
                n.f = n.g + n.h;
                if !visited {
                    open.push(nb, &grid.data);
                } else {
                    open.rescore_element(nb, &grid.data);
                }
            }
        }
    }
    None
}

fn path_to(start: usize, node: usize, grid: &Grid) -> Vec<usize> {
    let mut curr = node;
    let mut path = vec![];
    while let Some(p) = grid.data[curr].parent {
        path.push(curr);
        curr = p;
    }
    path.push(start);
    path.reverse();
    path
}

fn m_dist(a: Point, b: Point) -> f64 {
    (a[0] - b[0]).abs() + (a[1] - b[1]).abs()
}

/// `generateDynamicAABBs`: boxes that grow to touch each other, at least the
/// given static bounds.
#[allow(clippy::too_many_arguments)]
fn generate_dynamic_aabbs(
    a: Bounds,
    b: Bounds,
    common: Bounds,
    start_diff: Option<[f64; 4]>,
    end_diff: Option<[f64; 4]>,
    disable_side_hack: bool,
    start_el: Option<Bounds>,
    end_el: Option<Bounds>,
) -> [Bounds; 2] {
    let (se, ee) = (start_el.unwrap_or(a), end_el.unwrap_or(b));
    let [s_up, s_right, s_down, s_left] = start_diff.unwrap_or([0.; 4]);
    let [e_up, e_right, e_down, e_left] = end_diff.unwrap_or([0.; 4]);
    let first: Bounds = [
        if a[0] > b[2] {
            if a[1] > b[3] || a[3] < b[1] {
                ((se[0] + ee[2]) / 2.).min(a[0] - s_left)
            } else {
                (se[0] + ee[2]) / 2.
            }
        } else if a[0] > b[0] {
            a[0] - s_left
        } else {
            common[0] - s_left
        },
        if a[1] > b[3] {
            if a[0] > b[2] || a[2] < b[0] {
                ((se[1] + ee[3]) / 2.).min(a[1] - s_up)
            } else {
                (se[1] + ee[3]) / 2.
            }
        } else if a[1] > b[1] {
            a[1] - s_up
        } else {
            common[1] - s_up
        },
        if a[2] < b[0] {
            if a[1] > b[3] || a[3] < b[1] {
                ((se[2] + ee[0]) / 2.).max(a[2] + s_right)
            } else {
                (se[2] + ee[0]) / 2.
            }
        } else if a[2] < b[2] {
            a[2] + s_right
        } else {
            common[2] + s_right
        },
        if a[3] < b[1] {
            if a[0] > b[2] || a[2] < b[0] {
                ((se[3] + ee[1]) / 2.).max(a[3] + s_down)
            } else {
                (se[3] + ee[1]) / 2.
            }
        } else if a[3] < b[3] {
            a[3] + s_down
        } else {
            common[3] + s_down
        },
    ];
    let second: Bounds = [
        if b[0] > a[2] {
            if b[1] > a[3] || b[3] < a[1] {
                ((ee[0] + se[2]) / 2.).min(b[0] - e_left)
            } else {
                (ee[0] + se[2]) / 2.
            }
        } else if b[0] > a[0] {
            b[0] - e_left
        } else {
            common[0] - e_left
        },
        if b[1] > a[3] {
            if b[0] > a[2] || b[2] < a[0] {
                ((ee[1] + se[3]) / 2.).min(b[1] - e_up)
            } else {
                (ee[1] + se[3]) / 2.
            }
        } else if b[1] > a[1] {
            b[1] - e_up
        } else {
            common[1] - e_up
        },
        if b[2] < a[0] {
            if b[1] > a[3] || b[3] < a[1] {
                ((ee[2] + se[0]) / 2.).max(b[2] + e_right)
            } else {
                (ee[2] + se[0]) / 2.
            }
        } else if b[2] < a[2] {
            b[2] + e_right
        } else {
            common[2] + e_right
        },
        if b[3] < a[1] {
            if b[0] > a[2] || b[2] < a[0] {
                ((ee[3] + se[1]) / 2.).max(b[3] + e_down)
            } else {
                (ee[3] + se[1]) / 2.
            }
        } else if b[3] < a[3] {
            b[3] + e_down
        } else {
            common[3] + e_down
        },
    ];
    let c = common_aabb(&[first, second]);
    if !disable_side_hack
        && first[2] - first[0] + second[2] - second[0] > c[2] - c[0] + 0.00000000001
        && first[3] - first[1] + second[3] - second[1] > c[3] - c[1] + 0.00000000001
    {
        let (ecx, ecy) = ((second[0] + second[2]) / 2., (second[1] + second[3]) / 2.);
        let cross =
            |p: [f64; 4]| vector_cross([p[0] - ecx, p[1] - ecy], [p[2] - ecx, p[3] - ecy]) > 0.;
        if b[0] > a[2] && a[1] > b[3] {
            // bottom left
            let cx = first[2] + (second[0] - first[2]) / 2.;
            let cy = second[3] + (first[1] - second[3]) / 2.;
            if cross([a[2], a[1], a[0], a[3]]) {
                return [
                    [first[0], first[1], cx, first[3]],
                    [cx, second[1], second[2], second[3]],
                ];
            }
            return [
                [first[0], cy, first[2], first[3]],
                [second[0], second[1], second[2], cy],
            ];
        } else if a[2] < b[0] && a[3] < b[1] {
            // top left
            let cx = first[2] + (second[0] - first[2]) / 2.;
            let cy = first[3] + (second[1] - first[3]) / 2.;
            if cross([a[0], a[1], a[2], a[3]]) {
                return [
                    [first[0], first[1], first[2], cy],
                    [second[0], cy, second[2], second[3]],
                ];
            }
            return [
                [first[0], first[1], cx, first[3]],
                [cx, second[1], second[2], second[3]],
            ];
        } else if a[0] > b[2] && a[3] < b[1] {
            // top right
            let cx = second[2] + (first[0] - second[2]) / 2.;
            let cy = first[3] + (second[1] - first[3]) / 2.;
            if cross([a[2], a[1], a[0], a[3]]) {
                return [
                    [cx, first[1], first[2], first[3]],
                    [second[0], second[1], cx, second[3]],
                ];
            }
            return [
                [first[0], first[1], first[2], cy],
                [second[0], cy, second[2], second[3]],
            ];
        } else if a[0] > b[2] && a[1] > b[3] {
            // bottom right
            let cx = second[2] + (first[0] - second[2]) / 2.;
            let cy = second[3] + (first[1] - second[3]) / 2.;
            if cross([a[0], a[1], a[2], a[3]]) {
                return [
                    [cx, first[1], first[2], first[3]],
                    [second[0], second[1], cx, second[3]],
                ];
            }
            return [
                [first[0], cy, first[2], first[3]],
                [second[0], second[1], second[2], cy],
            ];
        }
    }
    [first, second]
}

/// `calculateGrid`: nodes where the boxes' sides and the ends' axes cross
/// (not uniform).
fn calculate_grid(
    aabbs: &[Bounds],
    start: Point,
    start_heading: Heading,
    end: Point,
    end_heading: Heading,
    common: Bounds,
) -> Grid {
    let (mut horizontal, mut vertical): (Vec<f64>, Vec<f64>) = (vec![], vec![]);
    if heading_is_horizontal(start_heading) {
        vertical.push(start[1])
    } else {
        horizontal.push(start[0])
    }
    if heading_is_horizontal(end_heading) {
        vertical.push(end[1])
    } else {
        horizontal.push(end[0])
    }
    for b in aabbs {
        horizontal.extend([b[0], b[2]]);
        vertical.extend([b[1], b[3]]);
    }
    horizontal.extend([common[0], common[2]]);
    vertical.extend([common[1], common[3]]);
    let norm = |mut v: Vec<f64>| {
        v.sort_by(|a, b| a.total_cmp(b));
        v.dedup_by(|a, b| a == b);
        v
    };
    let (vertical, horizontal) = (norm(vertical), norm(horizontal));
    let mut data = Vec::with_capacity(vertical.len() * horizontal.len());
    for (row, &y) in vertical.iter().enumerate() {
        for (col, &x) in horizontal.iter().enumerate() {
            data.push(Node {
                f: 0.,
                g: 0.,
                h: 0.,
                closed: false,
                visited: false,
                parent: None,
                addr: [col, row],
                pos: [x, y],
            });
        }
    }
    Grid {
        row: vertical.len(),
        col: horizontal.len(),
        data,
    }
}

fn get_dongle_position(b: Bounds, h: Heading, p: Point) -> Point {
    if compare_heading(h, HEADING_UP) {
        [p[0], b[1]]
    } else if compare_heading(h, HEADING_RIGHT) {
        [b[2], p[1]]
    } else if compare_heading(h, HEADING_DOWN) {
        [p[0], b[3]]
    } else {
        [b[0], p[1]]
    }
}

fn estimate_segment_count(start: &Node, end: &Node, sh: Heading, eh: Heading) -> f64 {
    let (s, e) = (start.pos, end.pos);
    let is = |a: Heading, b: Heading| compare_heading(a, b);
    let (r, l, u, d) = (HEADING_RIGHT, HEADING_LEFT, HEADING_UP, HEADING_DOWN);
    let n = if is(eh, r) {
        if is(sh, r) {
            if s[0] >= e[0] {
                4
            } else if s[1] == e[1] {
                0
            } else {
                2
            }
        } else if is(sh, u) {
            if s[1] > e[1] && s[0] < e[0] { 1 } else { 3 }
        } else if is(sh, d) {
            if s[1] < e[1] && s[0] < e[0] { 1 } else { 3 }
        } else if is(sh, l) {
            if s[1] == e[1] { 4 } else { 2 }
        } else {
            0
        }
    } else if is(eh, l) {
        if is(sh, r) {
            if s[1] == e[1] { 4 } else { 2 }
        } else if is(sh, u) {
            if s[1] > e[1] && s[0] > e[0] { 1 } else { 3 }
        } else if is(sh, d) {
            if s[1] < e[1] && s[0] > e[0] { 1 } else { 3 }
        } else if is(sh, l) {
            if s[0] <= e[0] {
                4
            } else if s[1] == e[1] {
                0
            } else {
                2
            }
        } else {
            0
        }
    } else if is(eh, u) {
        if is(sh, r) {
            if s[1] > e[1] && s[0] < e[0] { 1 } else { 3 }
        } else if is(sh, u) {
            if s[1] >= e[1] {
                4
            } else if s[0] == e[0] {
                0
            } else {
                2
            }
        } else if is(sh, d) {
            if s[0] == e[0] { 4 } else { 2 }
        } else if is(sh, l) {
            if s[1] > e[1] && s[0] > e[0] { 1 } else { 3 }
        } else {
            0
        }
    } else if is(eh, d) {
        if is(sh, r) {
            if s[1] < e[1] && s[0] < e[0] { 1 } else { 3 }
        } else if is(sh, u) {
            if s[0] == e[0] { 4 } else { 2 }
        } else if is(sh, d) {
            if s[1] <= e[1] {
                4
            } else if s[0] == e[0] {
                0
            } else {
                2
            }
        } else if is(sh, l) {
            if s[1] < e[1] && s[0] > e[0] { 1 } else { 3 }
        } else {
            0
        }
    } else {
        0
    };
    n as f64
}

/// Up, right, down, left.
fn get_neighbors([col, row]: [usize; 2], grid: &Grid) -> [Option<usize>; 4] {
    let (c, r) = (col as isize, row as isize);
    [
        node_from_addr(c, r - 1, grid),
        node_from_addr(c + 1, r, grid),
        node_from_addr(c, r + 1, grid),
        node_from_addr(c - 1, r, grid),
    ]
}

fn node_from_addr(col: isize, row: isize, grid: &Grid) -> Option<usize> {
    if col < 0 || col >= grid.col as isize || row < 0 || row >= grid.row as isize {
        return None;
    }
    Some(row as usize * grid.col + col as usize)
}

/// `pointToGridNode`: the node exactly at the point.
fn point_to_grid_node(p: Point, grid: &Grid) -> Option<usize> {
    for col in 0..grid.col {
        for row in 0..grid.row {
            let i = row * grid.col + col;
            if p[0] == grid.data[i].pos[0] && p[1] == grid.data[i].pos[1] {
                return Some(i);
            }
        }
    }
    None
}

fn common_aabb(b: &[Bounds]) -> Bounds {
    [
        b.iter().map(|b| b[0]).fold(f64::INFINITY, f64::min),
        b.iter().map(|b| b[1]).fold(f64::INFINITY, f64::min),
        b.iter().map(|b| b[2]).fold(f64::NEG_INFINITY, f64::max),
        b.iter().map(|b| b[3]).fold(f64::NEG_INFINITY, f64::max),
    ]
}

/// `normalizeArrowElementUpdate`: global points to `x`, `y` and local points
/// (clamped to ±1e6), with the size.
fn normalize_arrow_element_update(
    global: &[Point],
    fixed: &[FixedSegment],
    start_is_special: Option<bool>,
    end_is_special: Option<bool>,
) -> ElbowUpdate {
    let Some(&[ox, oy]) = global.first() else {
        return ElbowUpdate::default();
    };
    let points: Vec<Point> = global
        .iter()
        .map(|p| {
            [
                clamp(p[0] - ox, -MAX_POS, MAX_POS),
                clamp(p[1] - oy, -MAX_POS, MAX_POS),
            ]
        })
        .collect();
    let (w, h) = get_size_from_points(&points);
    ElbowUpdate {
        x: Some(clamp(ox, -MAX_POS, MAX_POS)),
        y: Some(clamp(oy, -MAX_POS, MAX_POS)),
        width: Some(w),
        height: Some(h),
        points: Some(points),
        fixed_segments: Some((!fixed.is_empty()).then(|| fixed.to_vec())),
        start_is_special: Some(start_is_special),
        end_is_special: Some(end_is_special),
        ..Default::default()
    }
}

/// `getElbowArrowCornerPoints`: drops the points between collinear ones.
fn get_elbow_arrow_corner_points(points: Vec<Point>) -> Vec<Point> {
    if points.len() <= 1 {
        return points;
    }
    let mut prev_h = (points[0][1] - points[1][1]).abs() < (points[0][0] - points[1][0]).abs();
    let n = points.len();
    (0..n)
        .filter(|&i| {
            if i == 0 || i == n - 1 {
                return true;
            }
            let (p, next) = (points[i], points[i + 1]);
            let next_h = (p[1] - next[1]).abs() < (p[0] - next[0]).abs();
            let keep = prev_h != next_h;
            prev_h = next_h;
            keep
        })
        .map(|i| points[i])
        .collect()
}

/// `removeElbowArrowShortSegments`.
fn remove_elbow_arrow_short_segments(points: Vec<Point>) -> Vec<Point> {
    if points.len() < 4 {
        return points;
    }
    let n = points.len();
    (0..n)
        .filter(|&i| {
            i == 0 || i == n - 1 || point_distance(points[i - 1], points[i]) > DEDUP_TRESHOLD
        })
        .map(|i| points[i])
        .collect()
}

fn neighbor_index_to_heading(i: usize) -> Heading {
    match i {
        0 => HEADING_UP,
        1 => HEADING_RIGHT,
        2 => HEADING_DOWN,
        _ => HEADING_LEFT,
    }
}

/// `getGlobalPoint`: where the end is: snapped to the hovered outline while
/// dragging, at its fixed point when bound, or as given.
#[allow(clippy::too_many_arguments)]
fn get_global_point(
    arrow: &Element,
    s: StartOrEnd,
    fixed: Option<[f64; 2]>,
    initial: Point,
    zoom: f64,
    element: Option<&Element>,
    map: &dyn ElementsMap,
    opts: &ElbowOptions,
) -> Point {
    if opts.is_dragging {
        if opts.is_binding_enabled != Some(false)
            && let Some(e) = element
        {
            return bind_point_to_snap_to_element_outline(
                arrow,
                e,
                s,
                map,
                zoom,
                None,
                opts.is_midpoint_snapping_enabled != Some(false),
            );
        }
        return initial;
    }
    match element {
        Some(e) => get_global_fixed_point_for_bindable_element(fixed.unwrap_or([0., 0.]), e, map),
        None => initial,
    }
}

fn get_bind_point_heading(
    p: Point,
    other: Point,
    hovered: Option<&Element>,
    orig: Point,
    map: &dyn ElementsMap,
    zoom: f64,
) -> Heading {
    let aabb = hovered.map(|h| {
        let d = distance_to_element(h, map, p);
        aabb_for_element(h, map, Some([d; 4]))
    });
    get_heading_for_elbow_arrow_snap(p, other, hovered, aabb, orig, map, zoom)
}

/// `validateElbowPoints`: every segment horizontal or vertical (within
/// `tolerance`).
pub fn validate_elbow_points(points: &[Point], tolerance: f64) -> bool {
    points
        .windows(2)
        .all(|w| (w[1][0] - w[0][0]).abs() < tolerance || (w[1][1] - w[0][1]).abs() < tolerance)
}
