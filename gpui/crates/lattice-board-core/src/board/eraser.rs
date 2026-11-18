// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The eraser. Port of Excalidraw `packages/excalidraw/eraser/index.ts`
//! (`EraserTrail`'s hit tracking and `eraserTest`) @ 3a317b5, with
//! `getFreedrawOutlineAsSegments` (renderElement.ts) and what `App.tsx` does
//! with the result: `eraseElements` (delete, unbind) and the restore on
//! pointer up without erasing (`restoreReadyToEraseElements`: the pending
//! set is just dropped). The trail is the app's to draw, from `points`.

use super::bounds::*;
use super::collision::{
    intersect_element_with_line_segment, is_point_in_element, should_test_inside,
};
use super::groups::get_elements_in_group;
use super::math::*;
use super::mutate::new_element_with;
use super::scene::Scene;
use super::shape::get_freedraw_outline_points;
use super::text::compute_bound_text_position;
use super::types::{BoundType, Element};
use super::utils::ElementsMap;
use rustc_hash::{FxHashMap, FxHashSet};

/// `EraserTrail` minus drawing: what the trail has marked for erasing.
/// Group ids are `Option` as upstream's `groupIds.at(-1)` (ungrouped
/// elements share the `None` entry, which selects no other element).
#[derive(Clone, Debug, Default)]
pub struct EraserTrail {
    pub points: Vec<Point>,
    pub elements_to_erase: FxHashSet<String>,
    groups_to_erase: FxHashSet<Option<String>>,
}

fn elements_in_group<'a>(all: &'a [Element], g: &Option<String>) -> Vec<&'a Element> {
    g.as_ref().map_or(vec![], |g| {
        get_elements_in_group(all, g)
            .into_iter()
            .filter(|e| !e.is_deleted)
            .collect()
    })
}

impl EraserTrail {
    /// `startPath`.
    pub fn start_path(&mut self, x: f64, y: f64) {
        self.end_path();
        self.points.push([x, y]);
    }

    /// `addPointToPath`: adds the point and returns the ids pending erasure
    /// (`elementsPendingErasure`, rendered faded). `restore` (alt held)
    /// un-marks what the trail now crosses instead. `visible`: the visible
    /// elements; `all`: the non-deleted scene.
    pub fn add_point_to_path(
        &mut self,
        x: f64,
        y: f64,
        restore: bool,
        visible: &[Element],
        all: &[Element],
        zoom: f64,
    ) -> Vec<String> {
        self.points.push([x, y]);
        let n = self.points.len();
        if n < 2 {
            return vec![];
        }
        let seg = [self.points[n - 1], self.points[n - 2]];
        let candidates: Vec<&Element> = visible.iter().filter(|e| !e.locked).collect();
        let map: FxHashMap<&str, &Element> =
            candidates.iter().map(|e| (e.id.as_str(), *e)).collect();
        for &e in &candidates {
            let marked = self.elements_to_erase.contains(&e.id);
            if restore != marked || !eraser_test(seg, e, &map, zoom) {
                continue;
            }
            let group = e.group_ids.last().cloned();
            if restore {
                if self.groups_to_erase.contains(&group) {
                    for m in elements_in_group(all, &group) {
                        self.elements_to_erase.remove(&m.id);
                    }
                    self.groups_to_erase.remove(&group);
                }
                if let Some(c) = e.container_id() {
                    self.elements_to_erase.remove(c);
                }
                if e.has_bound_text()
                    && let Some(t) = e.bound_text_id()
                {
                    self.elements_to_erase.remove(t);
                }
                self.elements_to_erase.remove(&e.id);
            } else {
                if !self.groups_to_erase.contains(&group) {
                    for m in elements_in_group(all, &group) {
                        self.elements_to_erase.insert(m.id.clone());
                    }
                    self.groups_to_erase.insert(group);
                }
                if e.has_bound_text()
                    && let Some(t) = e.bound_text_id()
                {
                    self.elements_to_erase.insert(t.into());
                }
                if let Some(c) = e.container_id() {
                    self.elements_to_erase.insert(c.into());
                }
                self.elements_to_erase.insert(e.id.clone());
            }
        }
        let mut out: Vec<String> = self.elements_to_erase.iter().cloned().collect();
        out.sort();
        out
    }

    /// `endPath`.
    pub fn end_path(&mut self) {
        self.points.clear();
        self.elements_to_erase.clear();
        self.groups_to_erase.clear();
    }
}

/// `eraserTest`: whether the eraser segment `[last, previous]` hits the
/// element (its stroke, a filled inside, a freedraw outline or its label).
pub fn eraser_test(seg: Segment, e: &Element, map: &dyn ElementsMap, zoom: f64) -> bool {
    let last = seg[1];
    let t = if e.is_freedraw() {
        15.
    } else {
        e.stroke_width / 2.
    };
    let sb = [
        seg[0][0].min(seg[1][0]) - t,
        seg[0][1].min(seg[1][1]) - t,
        seg[0][0].max(seg[1][0]) + t,
        seg[0][1].max(seg[1][1]) + t,
    ];
    let ob = get_element_bounds(e, map, false);
    let eb = [ob[0] - t, ob[1] - t, ob[2] + t, ob[3] + t];
    if !do_bounds_intersect(Some(sb), Some(eb)) {
        return false;
    }
    if should_test_inside(e) && is_point_in_element(last, e, map) {
        return true;
    }
    if e.is_freedraw() {
        let outline = get_freedraw_outline_points(e);
        if outline.len() < 2 {
            return false;
        }
        let tolerance = (5. / zoom).max(2.25);
        if get_freedraw_outline_as_segments(e, &outline, map)
            .iter()
            .any(|s| line_segments_distance(*s, seg) <= tolerance)
        {
            return true;
        }
        let poly: Vec<Point> = outline.iter().map(|p| [e.x + p[0], e.y + p[1]]).collect();
        return polygon_includes_point_non_zero(seg[0], &poly);
    }
    if e.is_arrow() || (e.is_line() && !e.is_line_polygon()) {
        let tolerance = e.stroke_width.max(e.stroke_width * 2. / zoom);
        return get_element_line_segments(e, map)
            .iter()
            .any(|s| line_segments_distance(*s, seg) <= tolerance);
    }
    if !intersect_element_with_line_segment(e, map, seg, 0., true).is_empty() {
        return true;
    }
    get_bound_text_element(e, map).is_some_and(|t| {
        let mut t = t.clone();
        [t.x, t.y] = compute_bound_text_position(e, &t, map);
        !intersect_element_with_line_segment(&t, map, seg, 0., true).is_empty()
    })
}

/// `getFreedrawOutlineAsSegments`: the outline as global segments, rotated
/// about the unrotated bounds' center.
pub fn get_freedraw_outline_as_segments(
    e: &Element,
    points: &[Point],
    map: &dyn ElementsMap,
) -> Vec<Segment> {
    let mut un = e.clone();
    un.angle = 0.;
    let b = get_element_bounds(&un, map, false);
    let c = [(b[0] + b[2]) / 2., (b[1] + b[3]) / 2.];
    let g = |p: Point| point_rotate_rads([p[0] + e.x, p[1] + e.y], c, e.angle);
    let mut out: Vec<Segment> = vec![[g(points[0]), g(points[1])]];
    for &p in &points[2..] {
        let prev = out[out.len() - 1][1];
        out.push([prev, g(p)]);
    }
    out
}

/// `eraseElements`: deletes what's pending erasure (with frame children and
/// labels of erased elements) and drops bindings to and from erased arrows
/// and shapes, without history entries upstream (raw `mutateElement`).
/// Returns whether anything was deleted (the app then captures history).
pub fn erase_elements(scene: &mut Scene, pending: &FxHashSet<String>) -> bool {
    let mut ids: Vec<&String> = pending.iter().collect();
    ids.sort();
    for id in ids {
        let Some(e) = scene.get_element(id).cloned() else {
            continue;
        };
        if e.is_binding_element(true) {
            for b in [
                e.linear().and_then(|l| l.start_binding.clone()),
                e.linear().and_then(|l| l.end_binding.clone()),
            ]
            .into_iter()
            .flatten()
            {
                scene.mutate_element(&b.element_id, false, |x| {
                    if let Some(be) = &mut x.bound_elements {
                        be.retain(|x| x.id != e.id)
                    }
                });
            }
        } else if e.is_bindable(true) {
            for b in e
                .bound_elements
                .iter()
                .flatten()
                .filter(|b| b.kind == BoundType::Arrow)
            {
                let Some(arrow) = scene.get_element(&b.id).cloned() else {
                    continue;
                };
                let l = arrow.linear();
                let (s, t) = (
                    l.and_then(|l| l.start_binding.as_ref())
                        .is_some_and(|x| x.element_id == e.id),
                    l.and_then(|l| l.end_binding.as_ref())
                        .is_some_and(|x| x.element_id == e.id),
                );
                scene.mutate_element(&b.id, false, |a| {
                    if let Some(l) = a.linear_mut() {
                        if s {
                            l.start_binding = None;
                        }
                        if t {
                            l.end_binding = None;
                        }
                    }
                });
            }
        }
    }
    let mut changed = false;
    let next: Vec<Element> = scene
        .elements_including_deleted()
        .iter()
        .map(|e| {
            let hit = pending.contains(&e.id)
                || e.frame_id.as_ref().is_some_and(|f| pending.contains(f))
                || e.container_id().is_some_and(|c| pending.contains(c));
            if hit {
                changed = true;
                new_element_with(e, |e| e.is_deleted = true, false)
            } else {
                e.clone()
            }
        })
        .collect();
    if changed {
        scene.replace_all_elements(next);
    }
    changed
}
