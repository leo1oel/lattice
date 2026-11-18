// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Flowcharts: Ctrl+arrow creates successor nodes linked by elbow arrows,
//! Alt+arrow walks the chart. Port of Excalidraw `element/src/flowchart.ts`
//! @ 3a317b5.
//!
//! The new nodes and arrows are pending (`FlowChartCreator::pending_nodes`)
//! until the app inserts them when Ctrl is released. As upstream, binding
//! the arrows lists them on the start node in the scene right away.

use super::binding::*;
use super::bounds::{Bounds, aabb_for_element, element_overlaps_with_frame};
use super::frame::elements_are_in_frame_bounds;
use super::math::{PRECISION, clamp};
use super::mutate::mutate_element;
use super::new_element::*;
use super::scene::Scene;
use super::types::*;
use rustc_hash::{FxHashMap, FxHashSet};

/// `LinkDirection`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkDirection {
    Up,
    Right,
    Down,
    Left,
}

const VERTICAL_OFFSET: f64 = 100.;
const HORIZONTAL_OFFSET: f64 = 100.;

#[derive(Clone, Copy, Debug)]
struct Interval {
    start: f64,
    end: f64,
}

fn merge_intervals(intervals: Vec<Interval>) -> Vec<Interval> {
    let mut sorted = intervals;
    sorted.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut merged: Vec<Interval> = vec![];
    for i in sorted {
        match merged.last_mut() {
            Some(l) if i.start <= l.end => l.end = l.end.max(i.end),
            _ => merged.push(i),
        }
    }
    merged
}

fn interval_is_free(start: f64, size: f64, occupied: &[Interval]) -> bool {
    occupied
        .iter()
        .all(|o| start + size <= o.start || start >= o.end)
}

/// The nearest `start` for a run of `size` clear of every occupied interval,
/// either side of `ideal`; a tie goes to the positive side.
fn find_nearest_free_slot(ideal: f64, size: f64, occupied: &[Interval]) -> f64 {
    if interval_is_free(ideal, size, occupied) {
        return ideal;
    }
    let starts: Vec<f64> = std::iter::once(f64::NEG_INFINITY)
        .chain(occupied.iter().map(|o| o.end))
        .collect();
    let ends: Vec<f64> = occupied
        .iter()
        .map(|o| o.start)
        .chain(std::iter::once(f64::INFINITY))
        .collect();
    let (mut best, mut best_d) = (ideal, f64::INFINITY);
    for i in 0..starts.len() {
        if ends[i] - starts[i] < size {
            continue;
        }
        let s = clamp(ideal, starts[i], ends[i] - size);
        let d = (s - ideal).abs();
        if d <= best_d {
            best = s;
            best_d = d;
        }
    }
    best
}

/// Arrows bound at both ends, as an adjacency list (both ways).
fn neighbors<'a>(elements: impl Iterator<Item = &'a Element>) -> FxHashMap<String, Vec<String>> {
    let mut n: FxHashMap<String, Vec<String>> = FxHashMap::default();
    for e in elements {
        if !e.is_arrow() {
            continue;
        }
        let (Some(s), Some(t)) = (
            binding_of(e, StartOrEnd::Start),
            binding_of(e, StartOrEnd::End),
        ) else {
            continue;
        };
        n.entry(s.element_id.clone())
            .or_default()
            .push(t.element_id.clone());
        n.entry(t.element_id.clone())
            .or_default()
            .push(s.element_id.clone());
    }
    n
}

/// `getConnectedFlowchartNodes`: the rest of the chart `node` is in,
/// following arrows bound at both ends.
fn get_connected_flowchart_nodes<'a>(node: &Element, scene: &'a Scene) -> Vec<&'a Element> {
    let nb = neighbors(scene.non_deleted_elements());
    let mut visited: FxHashSet<String> = FxHashSet::from_iter([node.id.clone()]);
    let mut queue = vec![node.id.clone()];
    let mut connected = vec![];
    let mut i = 0;
    while i < queue.len() {
        for n in nb.get(&queue[i]).into_iter().flatten() {
            if !visited.insert(n.clone()) {
                continue;
            }
            if let Some(e) = scene
                .get_non_deleted_element(n)
                .filter(|e| e.is_bindable(true))
            {
                connected.push(e);
                queue.push(n.clone());
            }
        }
        i += 1;
    }
    connected
}

/// `placeCluster`: `count` copies of `parent` one gap away in `direction`,
/// slid across into the free slot nearest centered on the parent;
/// `sticky_cross_start` keeps an already shown cluster put as it grows.
/// Returns the positions and the cluster's cross-axis start.
fn place_cluster(
    parent: &Element,
    direction: LinkDirection,
    count: usize,
    obstacles: &[Bounds],
    sticky_cross_start: Option<f64>,
) -> (Vec<(f64, f64)>, f64) {
    let horizontal = matches!(direction, LinkDirection::Left | LinkDirection::Right);
    let positive = matches!(direction, LinkDirection::Right | LinkDirection::Down);
    // new nodes copy the parent's size
    let (primary_size, cross_size) = if horizontal {
        (parent.width, parent.height)
    } else {
        (parent.height, parent.width)
    };
    let (primary_gap, cross_gap) = if horizontal {
        (HORIZONTAL_OFFSET, VERTICAL_OFFSET)
    } else {
        (VERTICAL_OFFSET, HORIZONTAL_OFFSET)
    };
    let parent_primary_start = if horizontal { parent.x } else { parent.y };
    let parent_cross_center = if horizontal {
        parent.y + parent.height / 2.
    } else {
        parent.x + parent.width / 2.
    };
    let primary_start = if positive {
        parent_primary_start + primary_size + primary_gap
    } else {
        parent_primary_start - primary_gap - primary_size
    };
    // the band, a gap wider on both sides; the near side stops at the parent
    let (zs, ze) = if positive {
        (
            parent_primary_start + primary_size,
            primary_start + primary_size + primary_gap,
        )
    } else {
        (primary_start - primary_gap, parent_primary_start)
    };
    let occupied = merge_intervals(
        obstacles
            .iter()
            .filter(|b| {
                let (s, e) = if horizontal {
                    (b[0], b[2])
                } else {
                    (b[1], b[3])
                };
                // rounding noise: nodes a full gap away stay out
                s < ze - PRECISION && e > zs + PRECISION
            })
            .map(|b| Interval {
                start: (if horizontal { b[1] } else { b[0] }) - cross_gap,
                end: (if horizontal { b[3] } else { b[2] }) + cross_gap,
            })
            .collect(),
    );
    let step = cross_size + cross_gap;
    let cluster = count as f64 * cross_size + (count as f64 - 1.) * cross_gap;
    let centered = parent_cross_center - cluster / 2.;
    // the centered slot sorts first, so the cluster re-centers when it fits
    let anchored = sticky_cross_start.and_then(|sticky| {
        let mut c: Vec<f64> = [centered, sticky, sticky - step]
            .into_iter()
            .filter(|&s| interval_is_free(s, cluster, &occupied))
            .collect();
        let off = |a: f64| (a + cluster / 2. - parent_cross_center).abs();
        c.sort_by(|a, b| off(*a).total_cmp(&off(*b)));
        c.first().copied()
    });
    let cross_start =
        anchored.unwrap_or_else(|| find_nearest_free_slot(centered, cluster, &occupied));
    let positions = (0..count)
        .map(|i| {
            let c = cross_start + i as f64 * step;
            if horizontal {
                (primary_start, c)
            } else {
                (c, primary_start)
            }
        })
        .collect();
    (positions, cross_start)
}

/// `cloneFlowchartNode`: a node of the template's type, size and style.
fn clone_flowchart_node(t: &Element, x: f64, y: f64) -> Element {
    let o = ElementOpts {
        x,
        y,
        width: t.width,
        height: t.height,
        roundness: t.roundness,
        roughness: t.roughness,
        background_color: t.background_color.clone(),
        stroke_color: t.stroke_color.clone(),
        stroke_width: t.stroke_width,
        opacity: t.opacity,
        fill_style: t.fill_style,
        stroke_style: t.stroke_style,
        ..Default::default()
    };
    match t.kind {
        Kind::StickyNote { base_height } => new_sticky_note_element(o, Some(base_height)),
        _ => new_element(t.ty(), o),
    }
}

/// `addNewNodes`: `count` successor nodes of `start_id` in `direction`,
/// each with its arrow (pending: node, arrow, node, arrow…), and the
/// cluster's cross-axis start.
pub fn add_new_nodes(
    start_id: &str,
    end_arrowhead: Option<Arrowhead>,
    zoom: f64,
    direction: LinkDirection,
    scene: &mut Scene,
    count: usize,
    sticky_cross_start: Option<f64>,
    hooks: &dyn BindingHooks,
) -> (Vec<Element>, f64) {
    let Some(start) = scene.get_non_deleted_element(start_id).cloned() else {
        return (vec![], 0.);
    };
    let obstacles: Vec<Bounds> = get_connected_flowchart_nodes(&start, scene)
        .iter()
        .map(|n| aabb_for_element(n, scene, None))
        .collect();
    let (positions, cross_start) =
        place_cluster(&start, direction, count, &obstacles, sticky_cross_start);
    let mut nodes = vec![];
    for (x, y) in positions {
        let next = clone_flowchart_node(&start, x, y);
        let (next, arrow) =
            create_binding_arrow(start_id, next, direction, end_arrowhead, zoom, scene, hooks);
        nodes.push(next);
        nodes.push(arrow);
    }
    (nodes, cross_start)
}

/// `createBindingArrow`: an elbow arrow from the start node to `end`, bound
/// at both ends and routed. Returns `end` (with the arrow listed) and the
/// arrow.
fn create_binding_arrow(
    start_id: &str,
    end: Element,
    direction: LinkDirection,
    end_arrowhead: Option<Arrowhead>,
    zoom: f64,
    scene: &mut Scene,
    hooks: &dyn BindingHooks,
) -> (Element, Element) {
    let s = scene.get_element(start_id).unwrap().clone();
    const PADDING: f64 = 6.;
    let (sx, sy) = match direction {
        LinkDirection::Up => (s.x + s.width / 2., s.y - PADDING),
        LinkDirection::Down => (s.x + s.width / 2., s.y + s.height + PADDING),
        LinkDirection::Right => (s.x + s.width + PADDING, s.y + s.height / 2.),
        LinkDirection::Left => (s.x - PADDING, s.y + s.height / 2.),
    };
    let (ex, ey) = match direction {
        LinkDirection::Up => (
            end.x + end.width / 2. - sx,
            end.y + end.height - sy + PADDING,
        ),
        LinkDirection::Down => (end.x + end.width / 2. - sx, end.y - sy - PADDING),
        LinkDirection::Right => (end.x - sx - PADDING, end.y - sy + end.height / 2.),
        LinkDirection::Left => (
            end.x + end.width - sx + PADDING,
            end.y - sy + end.height / 2.,
        ),
    };
    let o = ElementOpts {
        x: sx,
        y: sy,
        stroke_color: s.stroke_color.clone(),
        stroke_style: s.stroke_style,
        stroke_width: s.stroke_width,
        opacity: s.opacity,
        roughness: s.roughness,
        ..Default::default()
    };
    let arrow = new_arrow_element(o, vec![[0., 0.], [ex, ey]], None, end_arrowhead, true, None);
    let (aid, eid) = (arrow.id.clone(), end.id.clone());
    // the scene with the pending node and arrow
    let mut all: Vec<Element> = scene.elements_including_deleted().to_vec();
    all.push(end);
    all.push(arrow);
    bind_binding_element(
        &aid,
        start_id,
        BindMode::Orbit,
        StartOrEnd::Start,
        &mut all,
        zoom,
        None,
        true,
        true,
    );
    bind_binding_element(
        &aid,
        &eid,
        BindMode::Orbit,
        StartOrEnd::End,
        &mut all,
        zoom,
        None,
        true,
        true,
    );
    // the start node is in the scene: so is its new arrow
    if let Some(sb) = all
        .iter()
        .find(|e| e.id == start_id)
        .map(|e| e.bound_elements.clone())
    {
        scene.mutate_element(start_id, true, |e| e.bound_elements = sb.clone());
    }
    // `movePoints` on the scene, which doesn't have the pending node yet
    let mut without_end: Vec<Element> = all.iter().filter(|e| e.id != eid).cloned().collect();
    let p1 = without_end
        .iter()
        .find(|e| e.id == aid)
        .unwrap()
        .points()
        .unwrap()[1];
    move_points(
        &aid,
        &mut without_end,
        &PointsPositionUpdates::from([(1, PointUpdate::at(p1))]),
        None,
        &MovePointsOpts::default(),
        hooks,
    );
    let moved = without_end.into_iter().find(|e| e.id == aid).unwrap();
    for e in all.iter_mut() {
        if e.id == aid {
            *e = moved.clone();
        }
    }
    let u = hooks.update_elbow_arrow_points(
        &moved,
        &all,
        &ElbowUpdate {
            points: moved.points().map(|p| p.to_vec()),
            ..Default::default()
        },
        &ElbowOptions::default(),
    );
    let mut arrow = moved;
    u.apply(&mut arrow);
    let end = all.into_iter().find(|e| e.id == eid).unwrap();
    (end, arrow)
}

// Alt+arrow moves to the node of the chart that looks next that way: the
// nearest of the first non-empty tier of
// 1. nodes in line (same row for left/right, column for up/down),
// 2. linked nodes whose center is past the edge, at any angle,
// 3. nodes whose center is in the 45° cone that way,
// 4. any other node whose center is past the edge.
// Near ties (within 10%) go to a node linked to, then from, then the more
// level one, then reading order.
const NAVIGATION_TIE_TOLERANCE: f64 = 0.1;

/// `FlowChartNavigator`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FlowChartNavigator {
    pub is_exploring: bool,
}

impl FlowChartNavigator {
    pub fn clear(&mut self) {
        self.is_exploring = false;
    }

    /// `exploreByDirection`: the id of the node to move to.
    pub fn explore_by_direction(
        &mut self,
        element: &Element,
        scene: &Scene,
        direction: LinkDirection,
    ) -> Option<String> {
        if !element.is_bindable(true) {
            return None;
        }
        let next = find_node_in_direction(element, scene, direction)?;
        self.is_exploring = true;
        Some(next)
    }
}

fn find_node_in_direction(
    node: &Element,
    scene: &Scene,
    direction: LinkDirection,
) -> Option<String> {
    let horizontal = matches!(direction, LinkDirection::Left | LinkDirection::Right);
    let sign = if matches!(direction, LinkDirection::Right | LinkDirection::Down) {
        1.
    } else {
        -1.
    };
    let axes = |b: Bounds| {
        if horizontal {
            (b[0], b[2], b[1], b[3])
        } else {
            (b[1], b[3], b[0], b[2])
        }
    };
    let (nms, nme, ncs, nce) = axes(aabb_for_element(node, scene, None));
    let (nmc, ncc) = ((nms + nme) / 2., (ncs + nce) / 2.);
    let edge = if sign > 0. { nme } else { nms };
    let (mut succ, mut pred) = (FxHashSet::default(), FxHashSet::default());
    for e in scene.non_deleted_elements() {
        if !e.is_arrow() {
            continue;
        }
        let (Some(s), Some(t)) = (
            binding_of(e, StartOrEnd::Start),
            binding_of(e, StartOrEnd::End),
        ) else {
            continue;
        };
        if s.element_id == node.id {
            succ.insert(t.element_id.clone());
        }
        if t.element_id == node.id {
            pred.insert(s.element_id.clone());
        }
    }
    let rank = |id: &str| {
        if succ.contains(id) {
            0
        } else if pred.contains(id) {
            1
        } else {
            2
        }
    };
    struct Cand<'a> {
        node: &'a Element,
        tier: u8,
        distance: f64,
        cross_center: f64,
    }
    let cands: Vec<Cand> = get_connected_flowchart_nodes(node, scene)
        .into_iter()
        .filter_map(|c| {
            let (ms, me, cs, ce) = axes(aabb_for_element(c, scene, None));
            let (mc, cc) = ((ms + me) / 2., (cs + ce) / 2.);
            if (mc - nmc) * sign <= 0. {
                return None;
            }
            // positive when apart along that axis
            let main_gap = (ms - nme).max(nms - me);
            let cross_gap = (cs - nce).max(ncs - ce);
            let in_cone = (mc - nmc).abs() >= (cc - ncc).abs();
            // either center within the other's span: mostly the same row
            let in_line = (ncs < cc && cc < nce) || (cs < ncc && ncc < ce);
            let past = (mc - edge) * sign > 0.;
            let tier = if in_line {
                0
            } else if past && rank(&c.id) < 2 {
                1
            } else if in_cone {
                2
            } else if past {
                3
            } else {
                return None;
            };
            let distance = if tier == 0 {
                main_gap.max(0.)
            } else {
                main_gap.max(0.).hypot(cross_gap.max(0.))
            };
            Some(Cand {
                node: c,
                tier,
                distance,
                cross_center: cc,
            })
        })
        .collect();
    let top = cands.iter().map(|c| c.tier).min()?;
    let pool: Vec<&Cand> = cands.iter().filter(|c| c.tier == top).collect();
    let nearest = pool
        .iter()
        .map(|c| c.distance)
        .fold(f64::INFINITY, f64::min);
    let tol = (nearest * NAVIGATION_TIE_TOLERANCE).max(1.);
    let off = |c: &Cand| (c.cross_center - ncc).abs();
    let cmp_off = |a: &Cand, b: &Cand| {
        if (off(a) - off(b)).abs() > 1. {
            off(a) - off(b)
        } else {
            0.
        }
    };
    let mut near: Vec<&Cand> = pool
        .into_iter()
        .filter(|c| c.distance <= nearest + tol)
        .collect();
    // JS sort comparator: the first non-zero difference
    near.sort_by(|a, b| {
        let d = [
            (rank(&a.node.id) - rank(&b.node.id)) as f64,
            cmp_off(a, b),
            a.cross_center - b.cross_center,
            a.distance - b.distance,
        ];
        d.into_iter()
            .find(|&x| x != 0. && !x.is_nan())
            .unwrap_or(0.)
            .total_cmp(&0.)
    });
    near.first().map(|c| c.node.id.clone())
}

/// `FlowChartCreator`: the pending successor nodes while Ctrl is held.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FlowChartCreator {
    pub is_creating_chart: bool,
    number_of_nodes: usize,
    direction: Option<LinkDirection>,
    /// The pending cluster's cross-axis start, so growing it keeps the
    /// pending nodes already shown in place.
    cluster_cross_start: Option<f64>,
    pub pending_nodes: Option<Vec<Element>>,
}

impl FlowChartCreator {
    /// `createNodes`: one more pending node in `direction` (or a first one
    /// when the direction changed).
    pub fn create_nodes(
        &mut self,
        start_id: &str,
        end_arrowhead: Option<Arrowhead>,
        zoom: f64,
        direction: LinkDirection,
        scene: &mut Scene,
        hooks: &dyn BindingHooks,
    ) {
        if Some(direction) != self.direction {
            self.number_of_nodes = 1;
            self.cluster_cross_start = None;
        } else {
            self.number_of_nodes += 1;
        }
        let (mut nodes, cross_start) = add_new_nodes(
            start_id,
            end_arrowhead,
            zoom,
            direction,
            scene,
            self.number_of_nodes,
            self.cluster_cross_start,
            hooks,
        );
        self.is_creating_chart = true;
        self.direction = Some(direction);
        self.cluster_cross_start = Some(cross_start);
        // pending nodes join the start node's frame if they all at least
        // overlap it
        if let Some(fid) = scene.get_element(start_id).and_then(|s| s.frame_id.clone())
            && let Some(frame) = scene.get_element(&fid).filter(|f| f.is_frame())
            && nodes.iter().all(|n| {
                elements_are_in_frame_bounds(&[n], frame, scene)
                    || element_overlaps_with_frame(n, frame, scene)
            })
        {
            for n in &mut nodes {
                mutate_element(n, |e| e.frame_id = Some(fid.clone()));
            }
        }
        self.pending_nodes = Some(nodes);
    }

    pub fn clear(&mut self) {
        *self = FlowChartCreator::default();
    }
}

/// `isNodeInFlowchart`: an arrow is bound to it. `elements`: the scene's.
pub fn is_node_in_flowchart(element: &Element, elements: &[Element]) -> bool {
    elements.iter().any(|e| {
        !e.is_deleted
            && e.is_arrow()
            && [StartOrEnd::Start, StartOrEnd::End]
                .iter()
                .any(|&s| binding_of(e, s).is_some_and(|b| b.element_id == element.id))
    })
}
