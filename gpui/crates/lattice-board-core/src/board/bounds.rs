// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Element bounds. Port of Excalidraw `element/src/bounds.ts` @ 3a317b5,
//! with the pieces it leans on: the geometry half of
//! `linearElementEditor.ts` (absolute coords of lines, label positions, path
//! metrics), the text/container lookups of `textElement.ts`, the frame
//! helpers of `frame.ts` that `elementsOverlappingBBox` needs,
//! `getClosestElementBounds` (excalidraw/viewport.ts) and `rescalePoints`
//! (common/points.ts).
//!
//! Upstream caches bounds per element version in WeakMaps; callers here
//! cache what they need (the renderer keys on `version`). Linear elements
//! read their extent from the roughness-0 ops of `shape.rs`, as upstream
//! reads it from the rough.js shape.

use super::deconstruct::{
    LinearPathSegment, deconstruct_diamond_element, deconstruct_linear_or_freedraw_element,
    deconstruct_rectanguloid_element, get_linear_element_path_segments,
};
use super::math::*;
use super::shape::{
    GeometricShape, Op, get_element_shape, linear_shape_ops, points_on_bezier_curves,
};
use super::types::{Arrowhead, Element, ElementType, StartOrEnd};
use super::utils::ElementsMap;
use rustc_hash::{FxHashMap, FxHashSet};

/// `[minX, minY, maxX, maxY]`.
pub type Bounds = [f64; 4];

// textElement.ts

/// `getBoundTextElement`.
pub fn get_bound_text_element<'a>(e: &Element, map: &'a dyn ElementsMap) -> Option<&'a Element> {
    e.bound_text_id().and_then(|id| map.get_element(id))
}
/// `getContainerElement`.
pub fn get_container_element<'a>(e: &Element, map: &'a dyn ElementsMap) -> Option<&'a Element> {
    e.container_id().and_then(|id| map.get_element(id))
}
/// `getTextElementWithAccuratePosition`: an arrow label at the position its
/// arrow puts it (its stored `x`, `y` may be stale).
pub fn get_text_element_with_accurate_position(
    t: &Element,
    map: &dyn ElementsMap,
) -> Option<Element> {
    let c = get_container_element(t, map).filter(|c| c.is_arrow())?;
    let [x, y] = get_bound_text_element_position(c, t, map);
    let mut t = t.clone();
    t.x = x;
    t.y = y;
    Some(t)
}

// ElementBounds

/// `getElementBounds`: the axis-aligned bounds of the (rotated, unless
/// `non_rotated`) element.
pub fn get_element_bounds(e: &Element, map: &dyn ElementsMap, non_rotated: bool) -> Bounds {
    calculate_bounds(e, map, if non_rotated { 0. } else { e.angle })
}

fn calculate_bounds(e: &Element, map: &dyn ElementsMap, angle: f64) -> Bounds {
    let [x1, y1, x2, y2, cx, cy] = get_element_absolute_coords(e, map, false);
    let c = [cx, cy];
    let rot = |p: Point| point_rotate_rads(p, c, angle);
    let minmax = |pts: [Point; 4]| {
        let xs = pts.map(|p| p[0]);
        let ys = pts.map(|p| p[1]);
        [
            xs[0].min(xs[1]).min(xs[2]).min(xs[3]),
            ys[0].min(ys[1]).min(ys[2]).min(ys[3]),
            xs[0].max(xs[1]).max(xs[2]).max(xs[3]),
            ys[0].max(ys[1]).max(ys[2]).max(ys[3]),
        ]
    };
    match e.ty() {
        ElementType::FreeDraw => {
            let pts: Vec<Point> = e
                .points()
                .unwrap_or(&[])
                .iter()
                .map(|&p| point_rotate_rads(p, [cx - e.x, cy - e.y], angle))
                .collect();
            let [a, b, c, d] = get_bounds_from_points(&pts, 0.);
            [a + e.x, b + e.y, c + e.x, d + e.y]
        }
        ElementType::Line | ElementType::Arrow => {
            get_linear_element_rotated_bounds(e, cx, cy, map, angle)
        }
        ElementType::Diamond => {
            let [a, b, c, d] = minmax([rot([cx, y1]), rot([cx, y2]), rot([x1, cy]), rot([x2, cy])]);
            [a, b, c, d]
        }
        ElementType::Ellipse => {
            let (w, h) = ((x2 - x1) / 2., (y2 - y1) / 2.);
            let (s, co) = angle.sin_cos();
            let ww = (w * co).hypot(h * s);
            let hh = (h * co).hypot(w * s);
            [cx - ww, cy - hh, cx + ww, cy + hh]
        }
        _ => minmax([rot([x1, y1]), rot([x1, y2]), rot([x2, y2]), rot([x2, y1])]),
    }
}

/// `getElementAbsoluteCoords`: `[x1, y1, x2, y2, cx, cy]` of the unrotated
/// element in scene coordinates.
pub fn get_element_absolute_coords(
    e: &Element,
    map: &dyn ElementsMap,
    include_bound_text: bool,
) -> [f64; 6] {
    if e.is_freedraw() {
        return get_freedraw_element_absolute_coords(e);
    }
    if e.is_linear() {
        return get_linear_element_absolute_coords(e, map, include_bound_text);
    }
    if e.is_text()
        && let Some(c) = get_container_element(e, map).filter(|c| c.is_arrow())
    {
        let [x, y] = get_bound_text_element_position(c, e, map);
        return [
            x,
            y,
            x + e.width,
            y + e.height,
            x + e.width / 2.,
            y + e.height / 2.,
        ];
    }
    [
        e.x,
        e.y,
        e.x + e.width,
        e.y + e.height,
        e.x + e.width / 2.,
        e.y + e.height / 2.,
    ]
}

fn is_rectanguloid_for_segments(e: &Element) -> bool {
    matches!(
        e.ty(),
        ElementType::Rectangle
            | ElementType::StickyNote
            | ElementType::Image
            | ElementType::Iframe
            | ElementType::Embeddable
            | ElementType::Frame
            | ElementType::MagicFrame
    ) || (e.is_text() && e.container_id().is_none())
}

fn segments_on_curve(c: Curve, center: Point, angle: f64) -> Vec<Segment> {
    let pts = points_on_bezier_curves(&c, 10., None);
    pts.windows(2)
        .map(|w| {
            [
                point_rotate_rads(w[0], center, angle),
                point_rotate_rads(w[1], center, angle),
            ]
        })
        .collect()
}

/// `getElementLineSegments`: the outline as segments, for visual (rather
/// than bounding box) intersection tests such as frames.
pub fn get_element_line_segments(e: &Element, map: &dyn ElementsMap) -> Vec<Segment> {
    let shape = get_element_shape(e, map);
    let [x1, y1, x2, y2, cx, cy] = get_element_absolute_coords(e, map, false);
    let center = [cx, cy];
    match shape {
        GeometricShape::Polycurve(curves) => {
            let on: Vec<Vec<Point>> = curves
                .iter()
                .map(|c| points_on_bezier_curves(c, 10., None))
                .collect();
            if (e.is_line() && !e.is_line_polygon()) || e.is_arrow() {
                on.iter()
                    .flat_map(|pts| pts.windows(2).map(|w| [w[0], w[1]]).collect::<Vec<_>>())
                    .collect()
            } else {
                let flat: Vec<Point> = on.into_iter().flatten().collect();
                flat.windows(2).map(|w| [w[0], w[1]]).collect()
            }
        }
        GeometricShape::Polyline(segs) => segs,
        _ if is_rectanguloid_for_segments(e) || e.ty() == ElementType::Diamond => {
            let (sides, corners) = if e.ty() == ElementType::Diamond {
                deconstruct_diamond_element(e, 0.)
            } else {
                deconstruct_rectanguloid_element(e, 0.)
            };
            let mut out: Vec<Segment> = sides
                .iter()
                .map(|s| {
                    [
                        point_rotate_rads(s[0], center, e.angle),
                        point_rotate_rads(s[1], center, e.angle),
                    ]
                })
                .collect();
            for c in corners {
                out.extend(segments_on_curve(c, center, e.angle));
            }
            out
        }
        GeometricShape::Polygon(pts) => {
            if e.is_text() && get_container_element(e, map).is_some_and(|c| c.is_linear()) {
                return vec![
                    [[x1, y1], [x2, y1]],
                    [[x2, y1], [x2, y2]],
                    [[x2, y2], [x1, y2]],
                    [[x1, y2], [x1, y1]],
                ];
            }
            pts.windows(2).map(|w| [w[0], w[1]]).collect()
        }
        GeometricShape::Ellipse { .. } => get_segments_on_ellipse(e),
        _ => {
            let r = |p: Point| point_rotate_rads(p, center, e.angle);
            let (nw, ne, sw, se, w, ea) = (
                r([x1, y1]),
                r([x2, y1]),
                r([x1, y2]),
                r([x2, y2]),
                r([x1, cy]),
                r([x2, cy]),
            );
            vec![
                [nw, ne],
                [sw, se],
                [nw, sw],
                [ne, se],
                [nw, ea],
                [sw, ea],
                [ne, w],
                [se, w],
            ]
        }
    }
}

fn get_segments_on_ellipse(e: &Element) -> Vec<Segment> {
    let c = [e.x + e.width / 2., e.y + e.height / 2.];
    let (a, b) = (e.width / 2., e.height / 2.);
    const N: usize = 90;
    let dt = PI * 2. / N as f64;
    let pts: Vec<Point> = (0..N)
        .map(|i| {
            let t = i as f64 * dt;
            point_rotate_rads([c[0] + a * t.cos(), c[1] + b * t.sin()], c, e.angle)
        })
        .collect();
    let mut out: Vec<Segment> = pts.windows(2).map(|w| [w[0], w[1]]).collect();
    out.push([pts[N - 1], pts[0]]);
    out
}

/// `getRectangleBoxAbsoluteCoords` for `(x, y, width, height)`.
pub fn get_rectangle_box_absolute_coords(x: f64, y: f64, w: f64, h: f64) -> [f64; 6] {
    [x, y, x + w, y + h, x + w / 2., y + h / 2.]
}

/// `getDiamondPoints`: top, right, bottom, left (x, y pairs), local.
pub fn get_diamond_points(e: &Element) -> [f64; 8] {
    // +1 so these are never 0: rough.js used to throw on it
    let top_x = (e.width / 2.).floor() + 1.;
    let right_y = (e.height / 2.).floor() + 1.;
    [top_x, 0., e.width, right_y, top_x, e.height, 0., right_y]
}

fn bezier_value(t: f64, p0: f64, p1: f64, p2: f64, p3: f64) -> f64 {
    let u = 1. - t;
    u.powi(3) * p0 + 3. * u.powi(2) * t * p1 + 3. * u * t.powi(2) * p2 + t.powi(3) * p3
}
fn solve_quadratic(p0: f64, p1: f64, p2: f64, p3: f64) -> Option<[Option<f64>; 2]> {
    let (i, j, k) = (p1 - p0, p2 - p1, p3 - p2);
    let a = 3. * i - 6. * j + 3. * k;
    let b = 6. * j - 6. * i;
    let c = 3. * i;
    let sqrt_part = b * b - 4. * a * c;
    if sqrt_part < 0. || sqrt_part.is_nan() {
        return None;
    }
    let (t1, t2) = if a == 0. {
        (-c / b, -c / b)
    } else {
        (
            (-b + sqrt_part.sqrt()) / (2. * a),
            (-b - sqrt_part.sqrt()) / (2. * a),
        )
    };
    let s = |t: f64| {
        (0. ..=1.)
            .contains(&t)
            .then(|| bezier_value(t, p0, p1, p2, p3))
    };
    Some([s(t1), s(t2)])
}

/// `getCubicBezierCurveBound`.
pub fn get_cubic_bezier_curve_bound(p0: Point, p1: Point, p2: Point, p3: Point) -> Bounds {
    let axis = |k: usize| {
        let (mut lo, mut hi) = (p0[k].min(p3[k]), p0[k].max(p3[k]));
        if let Some(sol) = solve_quadratic(p0[k], p1[k], p2[k], p3[k]) {
            for v in sol.into_iter().flatten() {
                lo = lo.min(v);
                hi = hi.max(v);
            }
        }
        (lo, hi)
    };
    let ((x0, x1), (y0, y1)) = (axis(0), axis(1));
    [x0, y0, x1, y1]
}

/// `getMinMaxXYFromCurvePathOps`. Moves don't count; segments count by
/// their end points (rough.js emits them as cubics with inner controls).
pub fn get_min_max_xy_from_curve_path_ops(
    ops: &[Op],
    transform: Option<&dyn Fn(Point) -> Point>,
) -> Bounds {
    let t = |p: Point| transform.map_or(p, |f| f(p));
    let mut cur = [0., 0.];
    let mut b = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut add = |r: Bounds| {
        b[0] = b[0].min(r[0]);
        b[1] = b[1].min(r[1]);
        b[2] = b[2].max(r[2]);
        b[3] = b[3].max(r[3]);
    };
    for o in ops {
        match *o {
            Op::Move(p) => cur = p,
            Op::BCurveTo(p1, p2, p3) => {
                add(get_cubic_bezier_curve_bound(t(cur), t(p1), t(p2), t(p3)));
                cur = p3;
            }
            Op::LineTo(p) => {
                let (a, c) = (t(cur), t(p));
                add([
                    a[0].min(c[0]),
                    a[1].min(c[1]),
                    a[0].max(c[0]),
                    a[1].max(c[1]),
                ]);
                cur = p;
            }
        }
    }
    b
}

/// `getBoundsFromPoints`.
pub fn get_bounds_from_points(points: &[Point], padding: f64) -> Bounds {
    let mut b = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for &[x, y] in points {
        b[0] = b[0].min(x);
        b[1] = b[1].min(y);
        b[2] = b[2].max(x);
        b[3] = b[3].max(y);
    }
    [
        b[0] - padding,
        b[1] - padding,
        b[2] + padding,
        b[3] + padding,
    ]
}

fn get_freedraw_element_absolute_coords(e: &Element) -> [f64; 6] {
    let [a, b, c, d] = get_bounds_from_points(e.points().unwrap_or(&[]), 0.);
    let (x1, y1, x2, y2) = (a + e.x, b + e.y, c + e.x, d + e.y);
    [x1, y1, x2, y2, (x1 + x2) / 2., (y1 + y2) / 2.]
}

// arrowheads

const CARDINALITY_MARKER_SIZE: f64 = 20.;
const CROWFOOT_ARROWHEAD_SIZE: f64 = 15.;
/// Layout of the parts of composite cardinality markers, in multiples of the
/// part's size (negative offsets move a part toward the tip).
pub const CARDINALITY_ONE_OR_MANY_BAR_OFFSET: f64 = -0.25;
pub const CARDINALITY_INNER_BAR_OFFSET: f64 = -0.5;
pub const CARDINALITY_ZERO_CIRCLE_OFFSET: f64 = 1.5;
pub const CARDINALITY_ZERO_CIRCLE_SCALE: f64 = 0.8;

/// `getArrowheadSize`, px.
pub fn get_arrowhead_size(a: Arrowhead) -> f64 {
    use Arrowhead::*;
    match a {
        Arrow => 25.,
        Diamond | DiamondOutline => 12.,
        CardinalityMany | CardinalityOneOrMany | CardinalityZeroOrMany => CROWFOOT_ARROWHEAD_SIZE,
        CardinalityOne | CardinalityExactlyOne | CardinalityZeroOrOne => CARDINALITY_MARKER_SIZE,
        _ => 15.,
    }
}

const ARROW_ARROWHEAD_ANGLE: f64 = 20.;
const ARROW_ARROWHEAD_WIDEST_ANGLE: f64 = 30.;
const ARROW_ARROWHEAD_WIDEST_SIZE: f64 = 10.;

/// `getArrowheadAngle`, degrees, for the head drawn at `size` (None: full).
pub fn get_arrowhead_angle(a: Arrowhead, size: Option<f64>) -> f64 {
    match a {
        Arrowhead::Bar => 90.,
        Arrowhead::Arrow => {
            let full = get_arrowhead_size(a);
            let shrinkage = clamp(
                (full - size.unwrap_or(full)) / (full - ARROW_ARROWHEAD_WIDEST_SIZE),
                0.,
                1.,
            );
            ARROW_ARROWHEAD_ANGLE
                + (ARROW_ARROWHEAD_WIDEST_ANGLE - ARROW_ARROWHEAD_ANGLE) * shrinkage
        }
        _ => 25.,
    }
}

struct ArrowheadCorner {
    length: f64,
    prev_length: f64,
    turn: f64,
}

fn get_arrowhead_corner(e: &Element, position: StartOrEnd) -> Option<ArrowheadCorner> {
    let p = e.points()?;
    let n = p.len();
    if n < 3 {
        return None;
    }
    let (tip, corner, prev) = if position == StartOrEnd::End {
        (p[n - 1], p[n - 2], p[n - 3])
    } else {
        (p[0], p[1], p[2])
    };
    let (mut length, mut prev_length) = (point_distance(tip, corner), point_distance(corner, prev));
    if length == 0. || prev_length == 0. {
        return None;
    }
    // elbow arrows round their corners off, the arrow turns halfway into it
    if e.is_elbow_arrow() {
        let rounding = super::shape::ELBOW_ARROW_CORNER_RADIUS
            .min(length / 2.)
            .min(prev_length / 2.)
            / 2.;
        length -= rounding;
        prev_length -= rounding;
    }
    let turn = clamp(
        vector_dot(
            vector_from_point(tip, corner),
            vector_from_point(corner, prev),
        ) / (length * prev_length),
        -1.,
        1.,
    )
    .acos();
    Some(ArrowheadCorner {
        length,
        prev_length,
        turn,
    })
}

fn get_sides_clear_size(c: &ArrowheadCorner, side_angle: f64, clearance: f64) -> f64 {
    let angle = degrees_to_radians(side_angle);
    if c.turn <= angle {
        return f64::INFINITY;
    }
    (c.length * c.turn.sin() - clearance) / (c.turn - angle).sin()
}

fn is_cardinality(a: Arrowhead) -> bool {
    a.as_str().starts_with("cardinality_")
}

fn get_cardinality_marker_scale(marker: Arrowhead, c: &ArrowheadCorner, sw: f64) -> f64 {
    let bar = |offset: f64| {
        let a = degrees_to_radians(get_arrowhead_angle(Arrowhead::CardinalityOne, None));
        c.length
            / (get_arrowhead_size(Arrowhead::CardinalityOne)
                * (offset + a.cos() + a.sin() * (c.turn / 2.).tan()))
    };
    let crows_foot = || c.length / get_arrowhead_size(Arrowhead::CardinalityMany);
    let circle = || {
        (c.length - (sw - 2.) * CARDINALITY_ZERO_CIRCLE_SCALE / 2. - sw)
            / (get_arrowhead_size(Arrowhead::CircleOutline)
                * (CARDINALITY_ZERO_CIRCLE_OFFSET + CARDINALITY_ZERO_CIRCLE_SCALE / 2.))
    };
    use Arrowhead::*;
    match marker {
        CardinalityOne => bar(0.).min(1.),
        CardinalityMany => crows_foot().min(1.),
        CardinalityOneOrMany => crows_foot()
            .min(bar(CARDINALITY_ONE_OR_MANY_BAR_OFFSET))
            .min(1.),
        CardinalityExactlyOne => bar(CARDINALITY_INNER_BAR_OFFSET).min(bar(0.)).min(1.),
        CardinalityZeroOrOne => circle().min(bar(CARDINALITY_INNER_BAR_OFFSET)).min(1.),
        CardinalityZeroOrMany => crows_foot().min(circle()).min(1.),
        _ => 1.,
    }
}

/// `getArrowheadSizeBeyondLastSegment`: how big a head may grow when the
/// last segment is too short for it; 0 if it shouldn't grow.
fn get_arrowhead_size_beyond_last_segment(e: &Element, position: StartOrEnd, a: Arrowhead) -> f64 {
    let Some(c) = get_arrowhead_corner(e, position) else {
        return 0.;
    };
    let max_size = (c.length + c.prev_length) / 2.;
    let curved = e.roundness.is_some() && !e.is_elbow_arrow();
    let lin = e.linear();
    let marker = lin.and_then(|l| {
        if position == StartOrEnd::Start {
            l.start_arrowhead
        } else {
            l.end_arrowhead
        }
    });
    if let Some(m) = marker.filter(|&m| is_cardinality(m)) {
        return if curved {
            0.
        } else {
            get_arrowhead_size(a) * get_cardinality_marker_scale(m, &c, e.stroke_width)
        };
    }
    if matches!(a, Arrowhead::Circle | Arrowhead::CircleOutline) {
        return max_size;
    }
    if curved {
        return 0.;
    }
    use Arrowhead::*;
    match a {
        Bar => max_size.min(c.length / (c.turn / 2.).tan()),
        Diamond | DiamondOutline => c.length / 2.,
        Triangle | TriangleOutline => {
            max_size.min(get_sides_clear_size(&c, get_arrowhead_angle(a, None), 0.))
        }
        Arrow => {
            let legible = get_arrowhead_size(a) / 2.;
            legible
                .min(max_size)
                .min(get_sides_clear_size(
                    &c,
                    get_arrowhead_angle(a, Some(legible)),
                    e.stroke_width,
                ))
                .min(get_sides_clear_size(
                    &c,
                    get_arrowhead_angle(a, Some(0.)),
                    e.stroke_width,
                ))
        }
        _ => 0.,
    }
}

/// `getArrowheadPoints`, local coordinates. `ops` is the arrow's
/// `linear_shape_ops`. Returns `[x, y, diameter]` for circles, `[tip,
/// side, back, side]` pairs for diamonds and `[tip, side, side]` pairs
/// otherwise (crow's feet: apex first).
pub fn get_arrowhead_points(
    e: &Element,
    ops: &[Op],
    position: StartOrEnd,
    arrowhead: Arrowhead,
    offset_multiplier: f64,
) -> Option<Vec<f64>> {
    if ops.len() < 2 {
        return None;
    }
    let index = if position == StartOrEnd::Start {
        1
    } else {
        ops.len() - 1
    };
    let p0 = ops[index - 1].end();
    let (p1, p2, p3) = match ops[index] {
        Op::BCurveTo(a, b, c) => (a, b, c),
        // rough.js draws a segment as a cubic with controls along it
        Op::LineTo(c) => (lerp_pt(p0, c, 0.3), lerp_pt(p0, c, 0.6), c),
        Op::Move(_) => return None,
    };
    let eq = |t: f64, i: usize| {
        (1. - t).powi(3) * p3[i]
            + 3. * t * (1. - t).powi(2) * p2[i]
            + 3. * t.powi(2) * (1. - t) * p1[i]
            + p0[i] * t.powi(3)
    };
    let [x2, y2] = if position == StartOrEnd::Start {
        p0
    } else {
        p3
    };
    let (x1, y1) = (eq(0.3, 0), eq(0.3, 1));
    let distance = (x2 - x1).hypot(y2 - y1);
    let (nx, ny) = ((x2 - x1) / distance, (y2 - y1) / distance);
    let size = get_arrowhead_size(arrowhead);
    let points = e.points().unwrap_or(&[]);
    let n = points.len();
    let length = {
        let [cx, cy] = if position == StartOrEnd::End {
            points[n - 1]
        } else {
            points[0]
        };
        let [px, py] = if n > 1 {
            if position == StartOrEnd::End {
                points[n - 2]
            } else {
                points[1]
            }
        } else {
            [0., 0.]
        };
        (cx - px).hypot(cy - py)
    };
    let mult = if matches!(arrowhead, Arrowhead::Diamond | Arrowhead::DiamondOutline) {
        0.25
    } else {
        0.5
    };
    let mut min_size = size.min(length * mult);
    if min_size < size {
        min_size = size.min(min_size.max(get_arrowhead_size_beyond_last_segment(
            e, position, arrowhead,
        )));
    }
    let tx = x2 - nx * min_size * offset_multiplier;
    let ty = y2 - ny * min_size * offset_multiplier;
    let xs = tx - nx * min_size;
    let ys = ty - ny * min_size;
    if matches!(arrowhead, Arrowhead::Circle | Arrowhead::CircleOutline) {
        return Some(vec![tx, ty, (ys - ty).hypot(xs - tx) + e.stroke_width - 2.]);
    }
    let angle = get_arrowhead_angle(arrowhead, Some(min_size));
    if matches!(
        arrowhead,
        Arrowhead::CardinalityMany | Arrowhead::CardinalityOneOrMany
    ) {
        let [x3, y3] = point_rotate_rads([tx, ty], [xs, ys], degrees_to_radians(-angle));
        let [x4, y4] = point_rotate_rads([tx, ty], [xs, ys], degrees_to_radians(angle));
        return Some(vec![xs, ys, x3, y3, x4, y4]);
    }
    let [x3, y3] = point_rotate_rads([xs, ys], [tx, ty], -angle * PI / 180.);
    let [x4, y4] = point_rotate_rads([xs, ys], [tx, ty], degrees_to_radians(angle));
    if matches!(arrowhead, Arrowhead::Diamond | Arrowhead::DiamondOutline) {
        let [ox, oy] = if position == StartOrEnd::Start {
            let [px, py] = if n > 1 { points[1] } else { [0., 0.] };
            point_rotate_rads([tx + min_size * 2., ty], [tx, ty], (py - ty).atan2(px - tx))
        } else {
            let [px, py] = if n > 1 { points[n - 2] } else { [0., 0.] };
            point_rotate_rads([tx - min_size * 2., ty], [tx, ty], (ty - py).atan2(tx - px))
        };
        return Some(vec![tx, ty, x3, y3, ox, oy, x4, y4]);
    }
    Some(vec![tx, ty, x3, y3, x4, y4])
}

fn lerp_pt(a: Point, b: Point, t: f64) -> Point {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn get_linear_element_rotated_bounds(
    e: &Element,
    cx: f64,
    cy: f64,
    map: &dyn ElementsMap,
    angle: f64,
) -> Bounds {
    let text = get_bound_text_element(e, map);
    let pts = e.points().unwrap_or(&[]);
    let with_text = |b: Bounds| match text {
        Some(t) => {
            let r = get_min_max_xy_with_bound_text(e, map, b, t, angle);
            [r[0], r[1], r[2], r[3]]
        }
        None => b,
    };
    if pts.len() < 2 {
        let p = pts.first().copied().unwrap_or([0., 0.]);
        let [x, y] = point_rotate_rads([e.x + p[0], e.y + p[1]], [cx, cy], angle);
        return with_text([x, y, x, y]);
    }
    let ops = linear_shape_ops(e);
    let t = |p: Point| point_rotate_rads([e.x + p[0], e.y + p[1]], [cx, cy], angle);
    with_text(get_min_max_xy_from_curve_path_ops(&ops, Some(&t)))
}

/// `getCommonBounds`: `[0, 0, 0, 0]` for no elements.
pub fn get_common_bounds<'a>(
    elements: impl IntoIterator<Item = &'a Element>,
    map: &dyn ElementsMap,
) -> Bounds {
    let mut b = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut any = false;
    for e in elements {
        any = true;
        let [x1, y1, x2, y2] = get_element_bounds(e, map, false);
        b = [b[0].min(x1), b[1].min(y1), b[2].max(x2), b[3].max(y2)];
    }
    if any { b } else { [0., 0., 0., 0.] }
}

pub fn get_dragged_elements_bounds<'a>(
    elements: impl IntoIterator<Item = &'a Element>,
    map: &dyn ElementsMap,
    dx: f64,
    dy: f64,
) -> Bounds {
    let [a, b, c, d] = get_common_bounds(elements, map);
    [a + dx, b + dy, c + dx, d + dy]
}

/// `rescalePoints` (common/points.ts).
pub fn rescale_points(
    dimension: usize,
    new_size: f64,
    points: &[Point],
    normalize: bool,
) -> Vec<Point> {
    let coords = points.iter().map(|p| p[dimension]);
    let max = coords.clone().fold(f64::NEG_INFINITY, f64::max);
    let min = coords.fold(f64::INFINITY, f64::min);
    let size = max - min;
    let scale = if size == 0. { 1. } else { new_size / size };
    let mut next_min = f64::INFINITY;
    let scaled: Vec<Point> = points
        .iter()
        .map(|p| {
            let mut q = *p;
            q[dimension] = p[dimension] * scale;
            next_min = next_min.min(q[dimension]);
            q
        })
        .collect();
    if !normalize || scaled.len() == 2 {
        return scaled;
    }
    let translation = min - next_min;
    scaled
        .into_iter()
        .map(|mut q| {
            q[dimension] += translation;
            q
        })
        .collect()
}

/// `getResizedElementAbsoluteCoords`.
pub fn get_resized_element_absolute_coords(e: &Element, w: f64, h: f64, normalize: bool) -> Bounds {
    let Some(pts) = e.points() else {
        return [e.x, e.y, e.x + w, e.y + h];
    };
    let pts = rescale_points(0, w, &rescale_points(1, h, pts, normalize), normalize);
    let [a, b, c, d] = if e.is_freedraw() {
        get_bounds_from_points(&pts, 0.)
    } else {
        // upstream draws a curve or a linear path here, never an elbow route
        let ops = super::shape::points_curve_ops(e, &pts);
        get_min_max_xy_from_curve_path_ops(&ops, None)
    };
    [a + e.x, b + e.y, c + e.x, d + e.y]
}

/// `getElementPointsCoords`.
pub fn get_element_points_coords(e: &Element, points: &[Point]) -> Bounds {
    let ops = super::shape::points_curve_ops(e, points);
    let [a, b, c, d] = get_min_max_xy_from_curve_path_ops(&ops, None);
    [a + e.x, b + e.y, c + e.x, d + e.y]
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoundingBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
    pub mid_x: f64,
    pub mid_y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn get_common_bounding_box<'a>(
    elements: impl IntoIterator<Item = &'a Element>,
    map: &dyn ElementsMap,
) -> BoundingBox {
    let [min_x, min_y, max_x, max_y] = get_common_bounds(elements, map);
    BoundingBox {
        min_x,
        min_y,
        max_x,
        max_y,
        width: max_x - min_x,
        height: max_y - min_y,
        mid_x: (min_x + max_x) / 2.,
        mid_y: (min_y + max_y) / 2.,
    }
}

/// `getVisibleSceneBounds`: scene coordinates of the viewport.
pub fn get_visible_scene_bounds(
    scroll_x: f64,
    scroll_y: f64,
    width: f64,
    height: f64,
    zoom: f64,
) -> Bounds {
    [
        -scroll_x,
        -scroll_y,
        -scroll_x + width / zoom,
        -scroll_y + height / zoom,
    ]
}

pub fn get_center_for_bounds(b: Bounds) -> Point {
    [b[0] + (b[2] - b[0]) / 2., b[1] + (b[3] - b[1]) / 2.]
}

/// `aabbForElement`; `offset` is top, right, bottom, left.
pub fn aabb_for_element(e: &Element, map: &dyn ElementsMap, offset: Option<[f64; 4]>) -> Bounds {
    let c = element_center_point(e, map, 0., 0.);
    let r = |x: f64, y: f64| point_rotate_rads([x, y], c, e.angle);
    let pts = [
        r(e.x, e.y),
        r(e.x + e.width, e.y),
        r(e.x + e.width, e.y + e.height),
        r(e.x, e.y + e.height),
    ];
    let b = get_bounds_from_points(&pts, 0.);
    match offset {
        Some([t, rt, d, l]) => [b[0] - l, b[1] - t, b[2] + rt, b[3] + d],
        None => b,
    }
}

pub fn point_inside_bounds(p: Point, b: Bounds) -> bool {
    p[0] > b[0] && p[0] < b[2] && p[1] > b[1] && p[1] < b[3]
}
pub fn point_inside_bounds_inclusive(p: Point, b: Bounds) -> bool {
    p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]
}
pub fn do_bounds_intersect(a: Option<Bounds>, b: Option<Bounds>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}
pub fn bounds_contain_bounds(outer: Bounds, inner: Bounds) -> bool {
    [
        [inner[0], inner[1]],
        [inner[0], inner[3]],
        [inner[2], inner[1]],
        [inner[2], inner[3]],
    ]
    .iter()
    .all(|&p| point_inside_bounds_inclusive(p, outer))
}

/// What `elementsOverlappingBBox` selects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BBoxMode {
    Overlap,
    Contain,
}

pub struct OverlapQuery<'a> {
    pub bounds: Bounds,
    pub mode: BBoxMode,
    pub exclude_elements_in_frames: bool,
    pub ignore: Option<&'a dyn Fn(&Element) -> bool>,
    /// Whether elements extend by their stroke, as they render (default).
    pub include_stroke: bool,
}

/// `elementsOverlappingBBox`: the elements a selection box picks, in their
/// order. (Upstream also takes an element as the box; pass its bounds.)
pub fn elements_overlapping_bbox<'e>(
    elements: &'e [Element],
    map: &dyn ElementsMap,
    q: &OverlapQuery,
) -> Vec<&'e Element> {
    let sel = q.bounds;
    let [sx1, sy1, sx2, sy2] = sel;
    let edges = [
        [[sx1, sy1], [sx2, sy1]],
        [[sx2, sy1], [sx2, sy2]],
        [[sx2, sy2], [sx1, sy2]],
        [[sx1, sy2], [sx1, sy1]],
    ];
    let mut frames_in_selection: Option<FxHashSet<&str>> =
        q.exclude_elements_in_frames.then(FxHashSet::default);
    let mut groups: FxHashMap<&str, Vec<usize>> = FxHashMap::default();
    let mut picked: FxHashSet<usize> = FxHashSet::default();
    for (i, e) in elements.iter().enumerate() {
        if q.ignore.is_some_and(|f| f(e)) {
            continue;
        }
        if let Some(g) = e.group_ids.last() {
            groups.entry(g.as_str()).or_default().push(i);
        }
        let sw = if q.include_stroke { e.stroke_width } else { 0. };
        let b = get_element_bounds(e, map, false);
        let mut aabb = [
            b[0] - sw / 2.,
            b[1] - sw / 2.,
            b[2] + sw / 2.,
            b[3] + sw / 2.,
        ];
        let mut label: Option<Bounds> = None;
        if e.is_arrow()
            && let Some(t) = get_bound_text_element(e, map)
        {
            let [x, y] = get_bound_text_element_position(e, t, map);
            label = Some([x, y, x + t.width, y + t.height]);
        }
        if let Some(frame) = get_containing_frame(e, map)
            && is_frame_clippable(e, map)
            && element_overlaps_with_frame(e, frame, map)
        {
            let f = get_element_bounds(frame, map, false);
            let clip = move |b: Bounds| -> Bounds {
                [
                    b[0].max(f[0]),
                    b[1].max(f[1]),
                    b[2].min(f[2]),
                    b[3].min(f[3]),
                ]
            };
            label = label.map(clip);
            aabb = [
                aabb[0].max(f[0]),
                aabb[1].max(f[1]),
                aabb[2].min(f[2]),
                aabb[3].min(f[3]),
            ];
        }
        let common = label.map_or(aabb, |l| {
            [
                l[0].min(aabb[0]),
                l[1].min(aabb[1]),
                l[2].max(aabb[2]),
                l[3].max(aabb[3]),
            ]
        });
        if bounds_contain_bounds(sel, common) {
            if let Some(f) = frames_in_selection.as_mut()
                && e.is_frame_like()
            {
                f.insert(&e.id);
            }
            picked.insert(i);
            continue;
        }
        if q.mode == BBoxMode::Overlap && label.is_some() && do_bounds_intersect(Some(sel), label) {
            picked.insert(i);
            continue;
        }
        if q.mode == BBoxMode::Overlap && do_bounds_intersect(Some(sel), Some(aabb)) {
            let center = element_center_point(e, map, 0., 0.);
            let mut hit = if let Some(pts) = e.points() {
                pts.iter().any(|p| {
                    point_inside_bounds(
                        point_rotate_rads([e.x + p[0], e.y + p[1]], center, e.angle),
                        sel,
                    )
                })
            } else {
                let n = get_element_bounds(e, map, true);
                [
                    [(n[0] + n[2]) / 2., n[1]],
                    [n[2], (n[1] + n[3]) / 2.],
                    [(n[0] + n[2]) / 2., n[3]],
                    [n[0], (n[1] + n[3]) / 2.],
                ]
                .iter()
                // (upstream rotates these twice)
                .any(|&p| {
                    point_inside_bounds(
                        point_rotate_rads(point_rotate_rads(p, center, e.angle), center, e.angle),
                        sel,
                    )
                })
            };
            if !hit {
                hit = edges.iter().any(|&edge| {
                    !super::collision::intersect_element_with_line_segment(
                        e,
                        map,
                        edge,
                        sw / 2.,
                        true,
                    )
                    .is_empty()
                });
            }
            if hit {
                if let Some(f) = frames_in_selection.as_mut()
                    && e.is_frame_like()
                {
                    f.insert(&e.id);
                }
                picked.insert(i);
                continue;
            }
        }
    }
    if let Some(frames) = &frames_in_selection {
        picked.retain(|&i| {
            !elements[i]
                .frame_id
                .as_deref()
                .is_some_and(|f| frames.contains(f))
        });
    }
    match q.mode {
        BBoxMode::Overlap => {
            let extra: Vec<usize> = picked
                .iter()
                .filter_map(|&i| elements[i].group_ids.last())
                .filter_map(|g| groups.get(g.as_str()))
                .flatten()
                .copied()
                .collect();
            picked.extend(extra);
        }
        BBoxMode::Contain => {
            let snapshot = picked.clone();
            picked.retain(|&i| {
                elements[i]
                    .group_ids
                    .last()
                    .and_then(|g| groups.get(g.as_str()))
                    .is_none_or(|g| g.iter().all(|j| snapshot.contains(j)))
            });
        }
    }
    elements
        .iter()
        .enumerate()
        .filter(|(i, _)| picked.contains(i))
        .map(|(_, e)| e)
        .collect()
}

/// `elementCenterPoint`.
pub fn element_center_point(e: &Element, map: &dyn ElementsMap, dx: f64, dy: f64) -> Point {
    if e.is_linear() || e.is_freedraw() {
        let [x1, y1, x2, y2, ..] = get_element_absolute_coords(e, map, false);
        return [(x1 + x2) / 2. + dx, (y1 + y2) / 2. + dy];
    }
    let [x, y] = get_center_for_bounds(get_element_bounds(e, map, false));
    [x + dx, y + dy]
}

/// `getClosestElementBounds` (excalidraw/viewport.ts): bounds of the element
/// whose center is nearest to `from`.
pub fn get_closest_element_bounds(
    elements: &[Element],
    from: Point,
    map: &dyn ElementsMap,
) -> Bounds {
    let Some(first) = elements.first() else {
        return [0., 0., 0., 0.];
    };
    let (mut min, mut closest) = (f64::INFINITY, first);
    for e in elements {
        let [x1, y1, x2, y2] = get_element_bounds(e, map, false);
        let d = point_distance([(x1 + x2) / 2., (y1 + y2) / 2.], from);
        if d < min {
            min = d;
            closest = e;
        }
    }
    get_element_bounds(closest, map, false)
}

// frame.ts

/// `getContainingFrame`.
pub fn get_containing_frame<'a>(e: &Element, map: &'a dyn ElementsMap) -> Option<&'a Element> {
    e.frame_id.as_deref().and_then(|id| map.get_element(id))
}

/// `isFrameClippable`: arrows and their labels aren't clipped by frames.
pub fn is_frame_clippable(e: &Element, map: &dyn ElementsMap) -> bool {
    if e.is_arrow() {
        return false;
    }
    if let Some(c) = e.container_id() {
        return !map.get_element(c).is_some_and(|c| c.is_arrow());
    }
    true
}

fn frame_inner_bounds(frame: &Element, map: &dyn ElementsMap) -> Bounds {
    let [a, b, c, d] = get_element_bounds(frame, map, false);
    [a - PRECISION, b - PRECISION, c + PRECISION, d + PRECISION]
}

/// `isElementIntersectingFrame`.
pub fn is_element_intersecting_frame(e: &Element, frame: &Element, map: &dyn ElementsMap) -> bool {
    let fs = get_element_line_segments(frame, map);
    let es = get_element_line_segments(e, map);
    fs.iter()
        .any(|f| es.iter().any(|s| segments_intersect_at(*f, *s).is_some()))
}

/// `elementOverlapsWithFrame`.
pub fn element_overlaps_with_frame(e: &Element, frame: &Element, map: &dyn ElementsMap) -> bool {
    let [fx1, fy1, fx2, fy2] = frame_inner_bounds(frame, map);
    let [x1, y1, x2, y2] = get_element_bounds(e, map, false);
    (fx1 <= x1 && fy1 <= y1 && fx2 >= x2 && fy2 >= y2)
        || is_element_intersecting_frame(e, frame, map)
        || bounds_contain_bounds(
            get_element_bounds(e, map, false),
            get_element_bounds(frame, map, false),
        )
}

// linearElementEditor.ts (geometry)

fn get_linear_element_absolute_coords(
    e: &Element,
    map: &dyn ElementsMap,
    include_bound_text: bool,
) -> [f64; 6] {
    let [a, b, c, d] = get_min_max_xy_from_curve_path_ops(&linear_shape_ops(e), None);
    let (x1, y1, x2, y2) = (a + e.x, b + e.y, c + e.x, d + e.y);
    if include_bound_text && let Some(t) = get_bound_text_element(e, map) {
        return get_min_max_xy_with_bound_text(e, map, [x1, y1, x2, y2], t, e.angle);
    }
    [x1, y1, x2, y2, (x1 + x2) / 2., (y1 + y2) / 2.]
}

/// `LinearElementEditor.getPointGlobalCoordinates`.
pub fn get_point_global_coordinates(e: &Element, p: Point, map: &dyn ElementsMap) -> Point {
    let [x1, y1, x2, y2, ..] = get_element_absolute_coords(e, map, false);
    point_rotate_rads(
        [e.x + p[0], e.y + p[1]],
        [(x1 + x2) / 2., (y1 + y2) / 2.],
        e.angle,
    )
}

/// `LinearElementEditor.getPointsGlobalCoordinates`.
pub fn get_points_global_coordinates(e: &Element, map: &dyn ElementsMap) -> Vec<Point> {
    let [x1, y1, x2, y2, ..] = get_element_absolute_coords(e, map, false);
    let c = [(x1 + x2) / 2., (y1 + y2) / 2.];
    e.points()
        .unwrap_or(&[])
        .iter()
        .map(|p| point_rotate_rads([e.x + p[0], e.y + p[1]], c, e.angle))
        .collect()
}

/// `LinearElementEditor.getPointAtIndexGlobalCoordinates`; negative indexes
/// count from the end.
pub fn get_point_at_index_global_coordinates(
    e: &Element,
    index: isize,
    map: &dyn ElementsMap,
) -> Point {
    let pts = e.points().unwrap_or(&[]);
    let i = if index < 0 {
        pts.len() as isize + index
    } else {
        index
    };
    let [.., cx, cy] = get_element_absolute_coords(e, map, false);
    let p = usize::try_from(i)
        .ok()
        .and_then(|i| pts.get(i))
        .copied()
        .unwrap_or([0., 0.]);
    point_rotate_rads([e.x + p[0], e.y + p[1]], [cx, cy], e.angle)
}

/// `LinearElementEditor.POINT_HANDLE_SIZE`.
pub const POINT_HANDLE_SIZE: f64 = 10.;

/// `LinearElementEditor.pointFromAbsoluteCoords`: a scene point in `e`'s
/// local (unrotated, relative to `x`, `y`) coordinates. Elbow arrows don't
/// rotate.
pub fn point_from_absolute_coords(e: &Element, p: Point, map: &dyn ElementsMap) -> Point {
    if e.is_elbow_arrow() {
        return [p[0] - e.x, p[1] - e.y];
    }
    let [x1, y1, x2, y2, ..] = get_element_absolute_coords(e, map, false);
    let [x, y] = point_rotate_rads(p, [(x1 + x2) / 2., (y1 + y2) / 2.], -e.angle);
    [x - e.x, y - e.y]
}

/// `LinearElementEditor.createPointAt`: like `point_from_absolute_coords`,
/// snapped to the grid first and rotated for elbow arrows too.
pub fn create_point_at(
    e: &Element,
    map: &dyn ElementsMap,
    x: f64,
    y: f64,
    grid_size: Option<f64>,
) -> Point {
    let g = super::utils::get_grid_point(x, y, grid_size);
    let [x1, y1, x2, y2, ..] = get_element_absolute_coords(e, map, false);
    let [rx, ry] = point_rotate_rads(g, [(x1 + x2) / 2., (y1 + y2) / 2.], -e.angle);
    [rx - e.x, ry - e.y]
}

/// `LinearElementEditor.getSegmentMidPoint`: middle of segment `index`
/// (1-based: the segment ending at point `index`).
pub fn get_segment_mid_point(e: &Element, index: usize, map: &dyn ElementsMap) -> Point {
    let pts = e.points().unwrap_or(&[]);
    if e.is_elbow_arrow() {
        let p = point_center(pts[index - 1], pts[index]);
        return [e.x + p[0], e.y + p[1]];
    }
    let (lines, curves) = deconstruct_linear_or_freedraw_element(e, map);
    if let Some(s) = lines.get(index - 1) {
        return point_center(s[0], s[1]);
    }
    if let Some(&c) = curves.get(index - 1) {
        return curve_point_at_length(c, 0.5, None);
    }
    [e.x, e.y]
}

/// `LinearElementEditor.getBoundTextElementCenter`.
pub fn get_bound_text_element_center(e: &Element, map: &dyn ElementsMap) -> Point {
    let pts = e.points().unwrap_or(&[]);
    if pts.len() % 2 == 1 {
        return get_point_global_coordinates(e, pts[pts.len() / 2], map);
    }
    get_segment_mid_point(e, pts.len() / 2, map)
}

/// `LinearElementEditor.getBoundTextElementPosition`: top-left of an arrow's
/// (or line's) label.
pub fn get_bound_text_element_position(e: &Element, t: &Element, map: &dyn ElementsMap) -> Point {
    if e.points().is_none_or(|p| p.len() < 2) {
        return [t.x, t.y];
    }
    if e.is_arrow()
        && let Some(Some(pos)) = t.text().and_then(|t| t.label_position)
        && let Some(p) = get_point_at_path_parameter(e, pos, map)
    {
        return [p[0] - t.width / 2., p[1] - t.height / 2.];
    }
    let c = get_bound_text_element_center(e, map);
    [c[0] - t.width / 2., c[1] - t.height / 2.]
}

/// `LinearElementEditor.getMinMaxXYWithBoundText`, for the element drawn at
/// `angle`.
pub fn get_min_max_xy_with_bound_text(
    e: &Element,
    map: &dyn ElementsMap,
    b: Bounds,
    t: &Element,
    angle: f64,
) -> [f64; 6] {
    let [mut x1, mut y1, mut x2, mut y2] = b;
    let (cx, cy) = ((x1 + x2) / 2., (y1 + y2) / 2.);
    let [tx1, ty1] = get_bound_text_element_position(e, t, map);
    let (tx2, ty2) = (tx1 + t.width, ty1 + t.height);
    let c = [cx, cy];
    let tl = point_rotate_rads([x1, y1], c, angle);
    let tr = point_rotate_rads([x2, y1], c, angle);
    let ctl = point_rotate_rads([tx1, ty1], c, -angle);
    let ctr = point_rotate_rads([tx2, ty1], c, -angle);
    let cbl = point_rotate_rads([tx1, ty2], c, -angle);
    let cbr = point_rotate_rads([tx2, ty2], c, -angle);
    if tl[0] < tr[0] && tl[1] >= tr[1] {
        x1 = x1.min(cbl[0]);
        x2 = x2.max(ctr[0].max(cbr[0]));
        y1 = y1.min(ctl[1]);
        y2 = y2.max(cbr[1]);
    } else if tl[0] >= tr[0] && tl[1] > tr[1] {
        x1 = x1.min(cbr[0]);
        x2 = x2.max(ctl[0].max(ctr[0]));
        y1 = y1.min(cbl[1]);
        y2 = y2.max(ctr[1]);
    } else if tl[0] >= tr[0] {
        x1 = x1.min(ctr[0]);
        x2 = x2.max(cbl[0]);
        y1 = y1.min(cbr[1]);
        y2 = y2.max(ctl[1]);
    } else if tl[1] <= tr[1] {
        x1 = x1.min(ctr[0].min(ctl[0]));
        x2 = x2.max(cbr[0]);
        y1 = y1.min(ctr[1]);
        y2 = y2.max(cbl[1]);
    }
    [x1, y1, x2, y2, cx, cy]
}

/// The arc-length table of a linear element's path.
pub struct PathMetrics {
    pub segments: Vec<LinearPathSegment>,
    pub lengths: Vec<f64>,
    pub prefix_sums: Vec<f64>,
    pub total_length: f64,
}

pub fn get_linear_element_path_metrics(e: &Element, map: &dyn ElementsMap) -> PathMetrics {
    let segments = get_linear_element_path_segments(e, map);
    let lengths: Vec<f64> = segments.iter().map(|s| s.length()).collect();
    let mut prefix_sums = vec![0.];
    for l in &lengths {
        prefix_sums.push(prefix_sums[prefix_sums.len() - 1] + l);
    }
    let total_length = prefix_sums[lengths.len()];
    PathMetrics {
        segments,
        lengths,
        prefix_sums,
        total_length,
    }
}

/// `LinearElementEditor.getPathLength`.
pub fn get_path_length(e: &Element, map: &dyn ElementsMap) -> f64 {
    get_linear_element_path_metrics(e, map).total_length
}

/// `LinearElementEditor.getPathParameterAtPoint`: 0-1 along the path at the
/// point closest to `p`.
pub fn get_path_parameter_at_point(e: &Element, p: Point, map: &dyn ElementsMap) -> Option<f64> {
    let m = get_linear_element_path_metrics(e, map);
    if m.segments.is_empty() || m.total_length == 0. {
        return None;
    }
    let (mut best_d, mut best_i, mut best_t) = (f64::INFINITY, 0, 0.);
    for (i, s) in m.segments.iter().enumerate() {
        let (t, d) = s.closest_parameter(p);
        if d < best_d {
            best_d = d;
            best_i = i;
            best_t = t;
        }
    }
    let within = m.segments[best_i].length_at_parameter(best_t, m.lengths[best_i]);
    Some(clamp(
        (m.prefix_sums[best_i] + within) / m.total_length,
        0.,
        1.,
    ))
}

/// `LinearElementEditor.getPointAtPathParameter`.
pub fn get_point_at_path_parameter(e: &Element, t: f64, map: &dyn ElementsMap) -> Option<Point> {
    if !t.is_finite() {
        return None;
    }
    let m = get_linear_element_path_metrics(e, map);
    if m.segments.is_empty() {
        return None;
    }
    let target = clamp(t, 0., 1.) * m.total_length;
    let i = (0..m.segments.len())
        .find(|&i| target <= m.prefix_sums[i + 1])
        .unwrap_or(m.segments.len() - 1);
    let frac = if m.lengths[i] == 0. {
        0.
    } else {
        clamp((target - m.prefix_sums[i]) / m.lengths[i], 0., 1.)
    };
    Some(m.segments[i].point_at_length(frac, m.lengths[i]))
}
