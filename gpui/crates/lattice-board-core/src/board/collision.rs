// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Hit testing. Port of Excalidraw `element/src/collision.ts` and
//! `element/src/distance.ts` @ 3a317b5. Upstream memoizes the last
//! `hitElementItself` call; that is an optimization of its event loop and
//! is left to the caller. `maxBindingDistance_simple` and `BASE_BINDING_GAP`
//! come from `binding.ts` for the binding hit tests.

use super::bounds::*;
use super::deconstruct::{
    deconstruct_diamond_element, deconstruct_linear_or_freedraw_element,
    deconstruct_rectanguloid_element,
};
use super::math::*;
use super::shape::{get_freedraw_fill_polygon, get_freedraw_max_stroke_radius};
use super::types::{Element, ElementType};
use super::utils::{ElementsMap, has_background, is_path_a_loop, is_transparent};

/// `shouldTestInside`: whether a point inside the outline hits the element.
pub fn should_test_inside(e: &Element) -> bool {
    if e.is_arrow() {
        return false;
    }
    let draggable_from_inside = (has_background(e.ty()) && !is_transparent(&e.background_color))
        || e.has_bound_text()
        || e.is_iframe_like()
        || e.is_text();
    if e.is_line() || e.is_freedraw() {
        return draggable_from_inside && is_path_a_loop(e.points().unwrap_or(&[]), 1.);
    }
    draggable_from_inside || e.is_image()
}

/// `FrameNameBounds`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameNameBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct HitTestArgs<'a> {
    pub point: Point,
    pub element: &'a Element,
    pub threshold: f64,
    pub map: &'a dyn ElementsMap,
    pub frame_name_bound: Option<FrameNameBounds>,
    pub override_should_test_inside: bool,
}

impl<'a> HitTestArgs<'a> {
    pub fn new(
        point: Point,
        element: &'a Element,
        threshold: f64,
        map: &'a dyn ElementsMap,
    ) -> Self {
        HitTestArgs {
            point,
            element,
            threshold,
            map,
            frame_name_bound: None,
            override_should_test_inside: false,
        }
    }
}

/// `hitElementItself`.
pub fn hit_element_itself(a: &HitTestArgs) -> bool {
    let (p, e, t) = (a.point, a.element, a.threshold);
    let hit_frame_name = a.frame_name_bound.is_some_and(|f| {
        is_point_within_bounds(
            [f.x - t, f.y - t],
            p,
            [f.x + f.width + t, f.y + f.height + t],
        )
    });
    let bounds = get_element_bounds(e, a.map, true);
    let tolerance = if e.is_freedraw() {
        t + get_freedraw_max_stroke_radius(e)
    } else {
        t
    };
    if !is_point_in_rotated_bounds(p, bounds, e.angle, tolerance) && !hit_frame_name {
        return false;
    }
    let accurate = if e.is_text() {
        get_text_element_with_accurate_position(e, a.map)
    } else {
        None
    };
    let e = accurate.as_ref().unwrap_or(e);
    let hit = if a.override_should_test_inside || should_test_inside(e) {
        is_point_in_element(p, e, a.map) || is_point_on_element_outline(p, e, a.map, t)
    } else {
        is_point_on_element_outline(p, e, a.map, t)
    };
    hit || hit_frame_name
}

fn is_point_in_rotated_bounds(p: Point, b: Bounds, angle: f64, tolerance: f64) -> bool {
    let q = if angle == 0. {
        p
    } else {
        point_rotate_rads(p, get_center_for_bounds(b), -angle)
    };
    is_point_within_bounds(
        [b[0] - tolerance, b[1] - tolerance],
        q,
        [b[2] + tolerance, b[3] + tolerance],
    )
}

/// `hitElementBoundingBox`.
pub fn hit_element_bounding_box(
    p: Point,
    e: &Element,
    map: &dyn ElementsMap,
    tolerance: f64,
) -> bool {
    is_point_in_rotated_bounds(p, get_element_bounds(e, map, true), e.angle, tolerance)
}

/// `hitElementBoundingBoxOnly`: inside the box but not on the element nor
/// its label.
pub fn hit_element_bounding_box_only(a: &HitTestArgs) -> bool {
    !hit_element_itself(a)
        && !hit_element_bound_text(a.point, a.element, a.map)
        && hit_element_bounding_box(a.point, a.element, a.map, 0.)
}

/// `hitElementBoundText`.
pub fn hit_element_bound_text(p: Point, e: &Element, map: &dyn ElementsMap) -> bool {
    let Some(t) = get_bound_text_element(e, map) else {
        return false;
    };
    let accurate = get_text_element_with_accurate_position(t, map);
    is_point_in_element(p, accurate.as_ref().unwrap_or(t), map)
}

fn is_point_clipped_by_enclosing_frame(e: &Element, p: Point, map: &dyn ElementsMap) -> bool {
    let Some(f) = e.frame_id.as_deref().and_then(|id| map.get_element(id)) else {
        return false;
    };
    f.is_frame_like() && !point_inside_bounds(p, get_element_bounds(f, map, false))
}

/// `BASE_BINDING_GAP` (binding.ts).
pub const BASE_BINDING_GAP: f64 = 5.;

/// `maxBindingDistance_simple` (binding.ts).
pub fn max_binding_distance_simple(zoom: f64) -> f64 {
    let base = BASE_BINDING_GAP.max(15.);
    let z = if zoom < 1. { zoom } else { 1. };
    clamp(base / (z * 1.5), base, base * 2.)
}

fn bindable_element_border_distance_if_close(
    e: &Element,
    p: Point,
    map: &dyn ElementsMap,
    tolerance: f64,
) -> f64 {
    let t = tolerance.max(1.);
    if !do_bounds_intersect(
        Some([p[0] - t, p[1] - t, p[0] + t, p[1] + t]),
        Some(get_element_bounds(e, map, false)),
    ) {
        return f64::NEG_INFINITY;
    }
    let inside = is_point_in_element(p, e, map);
    // frames bind only from the outside
    if inside && e.is_frame_like() {
        return f64::NEG_INFINITY;
    }
    let d = distance_to_element(e, map, p);
    if inside {
        d
    } else if d > tolerance {
        f64::NEG_INFINITY
    } else {
        -d
    }
}

/// `isPointInBindingArea`.
pub fn is_point_in_binding_area(p: Point, e: &Element, map: &dyn ElementsMap, zoom: f64) -> bool {
    let max = max_binding_distance_simple(zoom);
    bindable_element_border_distance_if_close(e, p, map, max) > -max
}

/// `isOpaqueForBinding`.
pub fn is_opaque_for_binding(e: &Element) -> bool {
    e.is_image() || (has_background(e.ty()) && !is_transparent(&e.background_color))
}

/// `getBindingCandidates`: bindable elements near the point, front to back,
/// with their signed distance (positive inside).
fn get_binding_candidates<'a>(
    p: Point,
    elements: &'a [Element],
    map: &dyn ElementsMap,
    zoom: f64,
) -> Vec<(&'a Element, f64)> {
    let max = max_binding_distance_simple(zoom);
    let mut out = vec![];
    let mut occluding_frame: Option<&str> = None;
    for e in elements.iter().rev() {
        if e.is_deleted {
            continue;
        }
        if occluding_frame.is_some() && e.frame_id.as_deref() != occluding_frame {
            continue;
        }
        if !e.is_bindable(true) {
            continue;
        }
        if e.is_frame_like() && is_opaque_for_binding(e) && is_point_in_element(p, e, map) {
            occluding_frame = Some(&e.id);
        }
        if is_point_clipped_by_enclosing_frame(e, p, map) {
            continue;
        }
        let d = bindable_element_border_distance_if_close(e, p, map, max);
        if d > -max {
            if !e.locked {
                out.push((e, d));
            }
            if d >= 0. && is_opaque_for_binding(e) {
                break;
            }
        }
    }
    out
}

/// `getAllHoveredElementAtPoint`. `elements` in z-order (back to front).
pub fn get_all_hovered_element_at_point<'a>(
    p: Point,
    elements: &'a [Element],
    map: &dyn ElementsMap,
    zoom: f64,
) -> Vec<&'a Element> {
    get_binding_candidates(p, elements, map, zoom)
        .into_iter()
        .map(|(e, _)| e)
        .collect()
}

/// `getHoveredElementForBinding`.
pub fn get_hovered_element_for_binding<'a>(
    p: Point,
    elements: &'a [Element],
    map: &dyn ElementsMap,
    zoom: f64,
) -> Option<&'a Element> {
    let mut c = get_binding_candidates(p, elements, map, zoom);
    if c.len() <= 1 {
        return c.first().map(|c| c.0);
    }
    c.sort_by(|a, b| a.1.abs().total_cmp(&b.1.abs()));
    let (cand, cd) = c[0];
    let [cx1, cy1, cx2, cy2] = get_element_bounds(cand, map, false);
    let cand_area = ((cx2 - cx1).abs() * (cy2 - cy1).abs()).max(0.00001);
    let overlap = c
        .iter()
        .filter(|(e, d)| !std::ptr::eq(*e, cand) && *d >= 0.)
        .find(|(e, _)| {
            let [x1, y1, x2, y2] = get_element_bounds(e, map, false);
            let ow = (x2.min(cx2) - x1.max(cx1)).max(0.);
            let oh = (y2.min(cy2) - y1.max(cy1)).max(0.);
            let area = ((x2 - x1).abs() * (y2 - y1).abs()).max(0.00001);
            oh * ow / area > 0.25 && area / cand_area < 0.75
        });
    Some(match overlap {
        Some((e, _)) if cd >= 0. => e,
        _ => cand,
    })
}

/// `intersectElementWithLineSegment`: where the segment crosses the outline
/// (grown by `offset`).
pub fn intersect_element_with_line_segment(
    e: &Element,
    map: &dyn ElementsMap,
    line: Segment,
    offset: f64,
    only_first: bool,
) -> Vec<Point> {
    let ib = [
        line[0][0].min(line[1][0]) - offset,
        line[0][1].min(line[1][1]) - offset,
        line[0][0].max(line[1][0]) + offset,
        line[0][1].max(line[1][1]) + offset,
    ];
    if !do_bounds_intersect(Some(ib), Some(get_element_bounds(e, map, false))) {
        return vec![];
    }
    match e.ty() {
        ElementType::Diamond
        | ElementType::Rectangle
        | ElementType::StickyNote
        | ElementType::Image
        | ElementType::Text
        | ElementType::Iframe
        | ElementType::Embeddable
        | ElementType::Frame
        | ElementType::Selection
        | ElementType::MagicFrame => {
            let c = element_center_point(e, map, 0., 0.);
            let r = [
                point_rotate_rads(line[0], c, -e.angle),
                point_rotate_rads(line[1], c, -e.angle),
            ];
            let (sides, corners) = if e.ty() == ElementType::Diamond {
                deconstruct_diamond_element(e, offset)
            } else {
                deconstruct_rectanguloid_element(e, offset)
            };
            let mut out = vec![];
            line_intersections(&sides, r, &mut out, c, e.angle, only_first);
            if only_first && !out.is_empty() {
                return out;
            }
            curve_intersections(&corners, r, &mut out, c, e.angle, only_first);
            out
        }
        ElementType::Ellipse => {
            let c = element_center_point(e, map, 0., 0.);
            let r = [
                point_rotate_rads(line[0], c, -e.angle),
                point_rotate_rads(line[1], c, -e.angle),
            ];
            ellipse_segment_intercept_points(
                ellipse(c, e.width / 2. + offset, e.height / 2. + offset),
                r,
            )
            .into_iter()
            .map(|p| point_rotate_rads(p, c, e.angle))
            .collect()
        }
        ElementType::Line | ElementType::FreeDraw | ElementType::Arrow => {
            // the only one whose parts come rotated already
            let (lines, curves) = deconstruct_linear_or_freedraw_element(e, map);
            let mut out = vec![];
            for l in lines {
                if let Some(p) = line_segment_intersection_points(l, line, PRECISION) {
                    out.push(p);
                    if only_first {
                        return out;
                    }
                }
            }
            let b2 = [
                line[0][0].min(line[1][0]),
                line[0][1].min(line[1][1]),
                line[0][0].max(line[1][0]),
                line[0][1].max(line[1][1]),
            ];
            for c in curves {
                if !do_bounds_intersect(
                    Some(get_cubic_bezier_curve_bound(c[0], c[1], c[2], c[3])),
                    Some(b2),
                ) {
                    continue;
                }
                let hits = curve_intersect_line_segment(c, line, 1e-2, 10);
                if !hits.is_empty() {
                    out.extend(hits);
                    if only_first {
                        return out;
                    }
                }
            }
            out
        }
    }
}

const CURVE_BOUNDS_EPSILON: f64 = 1e-6;

fn curve_intersections(
    curves: &[Curve],
    s: Segment,
    out: &mut Vec<Point>,
    center: Point,
    angle: f64,
    only_first: bool,
) {
    // padded, so a segment through the joint of two curves still overlaps
    let b2 = [
        s[0][0].min(s[1][0]) - CURVE_BOUNDS_EPSILON,
        s[0][1].min(s[1][1]) - CURVE_BOUNDS_EPSILON,
        s[0][0].max(s[1][0]) + CURVE_BOUNDS_EPSILON,
        s[0][1].max(s[1][1]) + CURVE_BOUNDS_EPSILON,
    ];
    for &c in curves {
        if !do_bounds_intersect(
            Some(get_cubic_bezier_curve_bound(c[0], c[1], c[2], c[3])),
            Some(b2),
        ) {
            continue;
        }
        let hits = curve_intersect_line_segment(c, s, 1e-2, 4);
        if !hits.is_empty() {
            out.extend(
                hits.into_iter()
                    .map(|j| point_rotate_rads(j, center, angle)),
            );
            if only_first {
                return;
            }
        }
    }
}

fn line_intersections(
    lines: &[Segment],
    s: Segment,
    out: &mut Vec<Point>,
    center: Point,
    angle: f64,
    only_first: bool,
) {
    for &l in lines {
        if let Some(p) = line_segment_intersection_points(l, s, PRECISION) {
            out.push(point_rotate_rads(p, center, angle));
            if only_first {
                return;
            }
        }
    }
}

/// `isPointOnElementOutline` (tolerance 1 upstream).
pub fn is_point_on_element_outline(
    p: Point,
    e: &Element,
    map: &dyn ElementsMap,
    tolerance: f64,
) -> bool {
    distance_to_element(e, map, p) <= tolerance
}

/// `isPointInElement`: strictly inside the outline.
pub fn is_point_in_element(p: Point, e: &Element, map: &dyn ElementsMap) -> bool {
    if let Some(pts) = e.points()
        && !is_path_a_loop(pts, 1.)
    {
        return false;
    }
    if e.is_freedraw() {
        // before the rotated-bounds check: the smoothed fill can bulge past
        // the points
        let [x1, y1, x2, y2] = get_element_bounds(e, map, true);
        let [px, py] = point_rotate_rads(p, [(x1 + x2) / 2., (y1 + y2) / 2.], -e.angle);
        return polygon_includes_point([px - e.x, py - e.y], &get_freedraw_fill_polygon(e));
    }
    let [x1, y1, x2, y2] = get_element_bounds(e, map, false);
    if !is_point_within_bounds([x1, y1], p, [x2, y2]) {
        return false;
    }
    let c = [(x1 + x2) / 2., (y1 + y2) / 2.];
    let other = point_from_vector(
        vector_scale(
            vector_normalize(vector_from_point_or(p, c, 0.1, [0., 1.])),
            e.width.max(e.height) * 2.,
        ),
        c,
    );
    let hits = intersect_element_with_line_segment(e, map, [p, other], 0., false);
    let mut uniq: Vec<Point> = vec![];
    for h in hits {
        if !uniq.iter().any(|q| points_equal(*q, h, PRECISION)) {
            uniq.push(h)
        }
    }
    uniq.len() % 2 == 1
}

/// `isBindableElementInsideOtherBindable`: all corners of `inner` (pulled in
/// by 5%) inside `outer`.
pub fn is_bindable_element_inside_other_bindable(
    inner: &Element,
    outer: &Element,
    map: &dyn ElementsMap,
) -> bool {
    let offset = -inner.width.max(inner.height) / 20.;
    let (x, y, w, h) = (inner.x, inner.y, inner.width, inner.height);
    let c = element_center_point(inner, map, 0., 0.);
    let corners: Vec<Point> = match inner.ty() {
        ElementType::Diamond => {
            let [tx, ty, rx, ry, bx, by, lx, ly] = get_diamond_points(inner);
            vec![
                [x + tx, y + ty - offset],
                [x + rx + offset, y + ry],
                [x + bx, y + by + offset],
                [x + lx - offset, y + ly],
            ]
        }
        ElementType::Ellipse => {
            let (cx, cy, rx, ry) = (x + w / 2., y + h / 2., w / 2., h / 2.);
            vec![
                [cx, cy - ry - offset],
                [cx + rx + offset, cy],
                [cx, cy + ry + offset],
                [cx - rx - offset, cy],
            ]
        }
        _ => vec![
            [x - offset, y - offset],
            [x + w + offset, y - offset],
            [x + w + offset, y + h + offset],
            [x - offset, y + h + offset],
        ],
    };
    corners
        .into_iter()
        .all(|p| is_point_in_element(point_rotate_rads(p, c, inner.angle), outer, map))
}

// distance.ts

/// `distanceToElement`: distance from the point to the outline (freedraw: 0
/// inside the ink).
pub fn distance_to_element(e: &Element, map: &dyn ElementsMap, p: Point) -> f64 {
    let min = |a: f64, b: f64| a.min(b);
    match e.ty() {
        ElementType::Diamond
        | ElementType::Selection
        | ElementType::Rectangle
        | ElementType::StickyNote
        | ElementType::Image
        | ElementType::Text
        | ElementType::Iframe
        | ElementType::Embeddable
        | ElementType::Frame
        | ElementType::MagicFrame => {
            let c = element_center_point(e, map, 0., 0.);
            let r = point_rotate_rads(p, c, -e.angle);
            let (sides, corners) = if e.ty() == ElementType::Diamond {
                deconstruct_diamond_element(e, 0.)
            } else {
                deconstruct_rectanguloid_element(e, 0.)
            };
            sides
                .iter()
                .map(|s| distance_to_line_segment(r, *s))
                .chain(corners.iter().map(|k| curve_point_distance(*k, r, 1e-3)))
                .fold(f64::INFINITY, min)
        }
        ElementType::Ellipse => {
            let c = element_center_point(e, map, 0., 0.);
            ellipse_distance_from_point(
                point_rotate_rads(p, c, -e.angle),
                ellipse(c, e.width / 2., e.height / 2.),
            )
        }
        ElementType::Line | ElementType::Arrow => {
            let (lines, curves) = deconstruct_linear_or_freedraw_element(e, map);
            lines
                .iter()
                .map(|s| distance_to_line_segment(p, *s))
                .chain(curves.iter().map(|k| curve_point_distance(*k, p, 1e-3)))
                .fold(f64::INFINITY, min)
        }
        ElementType::FreeDraw => {
            let (lines, _) = deconstruct_linear_or_freedraw_element(e, map);
            if lines.is_empty() {
                return f64::INFINITY;
            }
            let poly: Vec<Point> = lines.iter().map(|l| l[0]).collect();
            if polygon_includes_point_non_zero(p, &poly) {
                return 0.;
            }
            lines
                .iter()
                .map(|s| distance_to_line_segment(p, *s))
                .fold(f64::INFINITY, min)
        }
    }
}
