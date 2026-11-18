// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! 2D math for the board. Port of Excalidraw `packages/math/src` (angle,
//! constants, curve, ellipse, line, point, polygon, range, rectangle,
//! segment, triangle, utils, vector) @ 3a317b5. Numbers are `f64` like JS so
//! results match upstream to the last bit; global and local points share one
//! type.

pub type Point = [f64; 2];
pub type Vector = [f64; 2];
pub type Segment = [Point; 2];
pub type Line = [Point; 2];
/// Cubic bézier: start, two controls, end.
pub type Curve = [Point; 4];
/// [top-left, bottom-right].
pub type Rectangle = [Point; 2];
pub type Triangle = [Point; 3];
pub type Range = [f64; 2];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ellipse {
    pub center: Point,
    pub half_width: f64,
    pub half_height: f64,
}

pub const PRECISION: f64 = 10e-5;
pub const PI: f64 = std::f64::consts::PI;

// utils.ts

pub fn clamp(v: f64, min: f64, max: f64) -> f64 {
    v.max(min).min(max)
}
#[derive(Clone, Copy)]
pub enum RoundFn {
    Round,
    Floor,
    Ceil,
}
fn apply(f: RoundFn, v: f64) -> f64 {
    match f {
        RoundFn::Round => js_round(v),
        RoundFn::Floor => v.floor(),
        RoundFn::Ceil => v.ceil(),
    }
}
/// `Math.round`: halves go up (towards +∞), unlike `f64::round`.
pub fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}
pub fn round(v: f64, precision: i32, f: RoundFn) -> f64 {
    let m = 10f64.powi(precision);
    apply(f, (v + f64::EPSILON) * m) / m
}
pub fn round_to_step(v: f64, step: f64, f: RoundFn) -> f64 {
    let k = 1. / step;
    apply(f, v * k) / k
}
pub fn average(a: f64, b: f64) -> f64 {
    (a + b) / 2.
}
pub fn is_close_to(a: f64, b: f64, precision: f64) -> bool {
    (a - b).abs() < precision
}

// angle.ts

pub fn normalize_radians(a: f64) -> f64 {
    if a < 0. {
        a % (2. * PI) + 2. * PI
    } else {
        a % (2. * PI)
    }
}
pub fn cartesian_to_polar([x, y]: Point) -> [f64; 2] {
    [x.hypot(y), normalize_radians(y.atan2(x))]
}
pub fn degrees_to_radians(d: f64) -> f64 {
    d * PI / 180.
}
pub fn radians_to_degrees(r: f64) -> f64 {
    r * 180. / PI
}
pub fn is_right_angle_rads(r: f64) -> bool {
    (2. * r).sin().abs() < PRECISION
}
pub fn radians_between_angles(a: f64, min: f64, max: f64) -> bool {
    let (a, min, max) = (
        normalize_radians(a),
        normalize_radians(min),
        normalize_radians(max),
    );
    if min < max {
        a >= min && a <= max
    } else {
        a >= min || a <= max
    }
}
pub fn radians_difference(a: f64, b: f64) -> f64 {
    let mut d = normalize_radians(a) - normalize_radians(b);
    if d < -PI {
        d += 2. * PI
    } else if d > PI {
        d -= 2. * PI
    }
    d.abs()
}

// point.ts

pub fn point_from_vector(v: Vector, offset: Point) -> Point {
    [offset[0] + v[0], offset[1] + v[1]]
}
pub fn points_equal(a: Point, b: Point, tolerance: f64) -> bool {
    (a[0] - b[0]).abs() < tolerance && (a[1] - b[1]).abs() < tolerance
}
pub fn point_rotate_rads(p: Point, c: Point, angle: f64) -> Point {
    if angle == 0. {
        return p;
    }
    let ([x, y], [cx, cy]) = (p, c);
    let (s, co) = angle.sin_cos();
    [
        (x - cx) * co - (y - cy) * s + cx,
        (x - cx) * s + (y - cy) * co + cy,
    ]
}
pub fn point_rotate_degs(p: Point, c: Point, angle: f64) -> Point {
    point_rotate_rads(p, c, degrees_to_radians(angle))
}
pub fn point_translate(p: Point, v: Vector) -> Point {
    [p[0] + v[0], p[1] + v[1]]
}
pub fn point_center(a: Point, b: Point) -> Point {
    [(a[0] + b[0]) / 2., (a[1] + b[1]) / 2.]
}
pub fn point_distance(a: Point, b: Point) -> f64 {
    (b[0] - a[0]).hypot(b[1] - a[1])
}
pub fn point_distance_sq(a: Point, b: Point) -> f64 {
    let (x, y) = (b[0] - a[0], b[1] - a[1]);
    x * x + y * y
}
pub fn point_scale_from_origin(p: Point, mid: Point, k: f64) -> Point {
    point_translate(mid, vector_scale(vector_from_point(p, mid), k))
}
pub fn is_point_within_bounds(p: Point, q: Point, r: Point) -> bool {
    q[0] <= p[0].max(r[0])
        && q[0] >= p[0].min(r[0])
        && q[1] <= p[1].max(r[1])
        && q[1] >= p[1].min(r[1])
}
pub fn is_valid_point(p: Point) -> bool {
    p[0].is_finite() && p[1].is_finite()
}
/// `isPoint` on untyped input: two numbers, neither NaN (∞ passes).
pub fn is_point(p: &[f64]) -> bool {
    p.len() == 2 && !p[0].is_nan() && !p[1].is_nan()
}

// vector.ts

pub fn vector(x: f64, y: f64) -> Vector {
    [x, y]
}
pub fn vector_from_point(p: Point, origin: Point) -> Vector {
    [p[0] - origin[0], p[1] - origin[1]]
}
/// `vectorFromPoint` with a threshold: shorter than it gives `default`.
pub fn vector_from_point_or(p: Point, origin: Point, threshold: f64, default: Vector) -> Vector {
    let v = vector_from_point(p, origin);
    if threshold != 0. && vector_magnitude_sq(v) < threshold * threshold {
        default
    } else {
        v
    }
}
pub fn vector_cross(a: Vector, b: Vector) -> f64 {
    a[0] * b[1] - b[0] * a[1]
}
pub fn vector_dot(a: Vector, b: Vector) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
pub fn vector_add(a: Vector, b: Vector) -> Vector {
    [a[0] + b[0], a[1] + b[1]]
}
pub fn vector_subtract(a: Vector, b: Vector) -> Vector {
    [a[0] - b[0], a[1] - b[1]]
}
pub fn vector_scale(v: Vector, k: f64) -> Vector {
    [v[0] * k, v[1] * k]
}
pub fn vector_magnitude_sq(v: Vector) -> f64 {
    v[0] * v[0] + v[1] * v[1]
}
pub fn vector_magnitude(v: Vector) -> f64 {
    vector_magnitude_sq(v).sqrt()
}
pub fn vector_normalize(v: Vector) -> Vector {
    let m = vector_magnitude(v);
    if m == 0. {
        [0., 0.]
    } else {
        [v[0] / m, v[1] / m]
    }
}
pub fn vector_normal(v: Vector) -> Vector {
    [v[1], -v[0]]
}

// range.ts

pub fn ranges_overlap([a0, a1]: Range, [b0, b1]: Range) -> bool {
    if a0 <= b0 { a1 >= b0 } else { b1 >= a0 }
}
pub fn range_intersection([a0, a1]: Range, [b0, b1]: Range) -> Option<Range> {
    let (s, e) = (a0.max(b0), a1.min(b1));
    (s <= e).then_some([s, e])
}
pub fn range_inclusive(start: f64, end: f64) -> Range {
    [start, end]
}
pub fn range_includes_value(v: f64, [min, max]: Range) -> bool {
    v >= min && v <= max
}

// line.ts

pub fn lines_intersect_at(a: Line, b: Line) -> Option<Point> {
    let (a1, b1) = (a[1][1] - a[0][1], a[0][0] - a[1][0]);
    let (a2, b2) = (b[1][1] - b[0][1], b[0][0] - b[1][0]);
    let d = a1 * b2 - a2 * b1;
    if d == 0. {
        return None;
    }
    let c1 = a1 * a[0][0] + b1 * a[0][1];
    let c2 = a2 * b[0][0] + b2 * b[0][1];
    Some([(c1 * b2 - c2 * b1) / d, (a1 * c2 - a2 * c1) / d])
}

// segment.ts

/// `isLineSegment` on untyped input.
pub fn is_line_segment(s: &[&[f64]]) -> bool {
    s.len() == 2 && is_point(s[0]) && is_point(s[1])
}
pub fn line_segment_rotate(l: Segment, angle: f64, origin: Option<Point>) -> Segment {
    let o = origin.unwrap_or_else(|| point_center(l[0], l[1]));
    [
        point_rotate_rads(l[0], o, angle),
        point_rotate_rads(l[1], o, angle),
    ]
}
pub fn segments_intersect_at(a: Segment, b: Segment) -> Option<Point> {
    let (a0, a1, b0, b1) = (a[0], a[1], b[0], b[1]);
    let r = vector_subtract(a1, a0);
    let s = vector_subtract(b1, b0);
    let den = vector_cross(r, s);
    if den == 0. {
        return None;
    }
    let i = vector_subtract(b0, a0);
    let u = vector_cross(i, r) / den;
    let t = vector_cross(i, s) / den;
    if u == 0. {
        return None;
    }
    let p = vector_add(a0, vector_scale(r, t));
    ((0. ..1.).contains(&t) && (0. ..1.).contains(&u)).then_some(p)
}
pub fn point_on_line_segment(p: Point, l: Segment, threshold: f64) -> bool {
    let d = distance_to_line_segment(p, l);
    d == 0. || d < threshold
}
pub fn distance_to_line_segment(p: Point, l: Segment) -> f64 {
    point_distance(
        p,
        line_segment_point_at(l, line_segment_closest_parameter(p, l)),
    )
}
pub fn line_segment_point_at([[x1, y1], [x2, y2]]: Segment, t: f64) -> Point {
    [x1 + t * (x2 - x1), y1 + t * (y2 - y1)]
}
pub fn line_segment_intersection_points(l: Segment, s: Segment, threshold: f64) -> Option<Point> {
    let c = lines_intersect_at(l, s)?;
    (point_on_line_segment(c, s, threshold) && point_on_line_segment(c, l, threshold)).then_some(c)
}
pub fn line_segments_distance(s1: Segment, s2: Segment) -> f64 {
    if line_segment_intersection_points(s1, s2, PRECISION).is_some() {
        return 0.;
    }
    distance_to_line_segment(s1[0], s2)
        .min(distance_to_line_segment(s1[1], s2))
        .min(distance_to_line_segment(s2[0], s1))
        .min(distance_to_line_segment(s2[1], s1))
}
pub fn line_segment_closest_parameter([x, y]: Point, [[x1, y1], [x2, y2]]: Segment) -> f64 {
    let (a, b, c, d) = (x - x1, y - y1, x2 - x1, y2 - y1);
    let len_sq = c * c + d * d;
    let param = if len_sq != 0. {
        (a * c + b * d) / len_sq
    } else {
        0.
    };
    param.clamp(0., 1.)
}

// polygon.ts

/// Closes the polygon (repeats the first point) unless it already is.
pub fn polygon_from_points(pts: &[Point]) -> Vec<Point> {
    let mut v = pts.to_vec();
    if !pts.is_empty() && !polygon_is_closed(pts, PRECISION) {
        v.push(pts[0]);
    }
    v
}
pub fn polygon_includes_point([x, y]: Point, poly: &[Point]) -> bool {
    let mut inside = false;
    let n = poly.len();
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let ([xi, yi], [xj, yj]) = (poly[i], poly[j]);
        if ((yi > y && yj <= y) || (yi <= y && yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}
pub fn polygon_includes_point_non_zero([x, y]: Point, poly: &[Point]) -> bool {
    let mut w = 0i32;
    for i in 0..poly.len() {
        let ([xi, yi], [xj, yj]) = (poly[i], poly[(i + 1) % poly.len()]);
        let side = (xj - xi) * (y - yi) - (x - xi) * (yj - yi);
        if yi <= y {
            if yj > y && side > 0. {
                w += 1
            }
        } else if yj <= y && side < 0. {
            w -= 1
        }
    }
    w != 0
}
pub fn polygon_is_closed(poly: &[Point], tolerance: f64) -> bool {
    points_equal(poly[0], poly[poly.len() - 1], tolerance)
}
pub fn polygon_signed_area(poly: &[Point], tolerance: f64) -> f64 {
    let pts = if polygon_is_closed(poly, tolerance) {
        &poly[..poly.len() - 1]
    } else {
        poly
    };
    let mut sum = 0.;
    let n = pts.len();
    if n == 0 {
        return 0.;
    }
    let mut j = n - 1;
    for i in 0..n {
        sum += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        j = i;
    }
    sum / 2.
}
pub fn polygon_area(poly: &[Point], tolerance: f64) -> f64 {
    polygon_signed_area(poly, tolerance).abs()
}
pub fn convex_hull(points: &[Point]) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| {
        if a[0] == b[0] {
            a[1].total_cmp(&b[1])
        } else {
            a[0].total_cmp(&b[0])
        }
    });
    let cross = |o: Point, a: Point, b: Point| {
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    };
    let half = |pts: &mut dyn Iterator<Item = Point>| {
        let mut c: Vec<Point> = vec![];
        for p in pts {
            while c.len() >= 2 && cross(c[c.len() - 2], c[c.len() - 1], p) <= 0. {
                c.pop();
            }
            c.push(p);
        }
        c.pop();
        c
    };
    let mut hull = half(&mut sorted.iter().copied());
    hull.extend(half(&mut sorted.iter().rev().copied()));
    if hull.len() >= 3 {
        hull
    } else {
        points.to_vec()
    }
}
pub fn simplify_convex_polygon(poly: &[Point], angle_threshold: f64) -> Vec<Point> {
    let n = poly.len();
    if n < 3 {
        return poly.to_vec();
    }
    let turn_at = |i: usize| {
        let (prev, cur, next) = (poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]);
        let a_in = (cur[1] - prev[1]).atan2(cur[0] - prev[0]);
        let a_out = (next[1] - cur[1]).atan2(next[0] - cur[0]);
        normalize_turn(a_out - a_in).abs()
    };
    let mut start = 0;
    for i in 1..n {
        if turn_at(i) > turn_at(start) {
            start = i
        }
    }
    let (mut out, mut acc) = (vec![], 0.);
    for k in 0..n {
        let i = (start + k) % n;
        acc += turn_at(i);
        if acc >= angle_threshold {
            out.push(poly[i]);
            acc = 0.;
        }
    }
    if out.len() >= 3 { out } else { poly.to_vec() }
}
fn normalize_turn(mut a: f64) -> f64 {
    while a > PI {
        a -= 2. * PI
    }
    while a < -PI {
        a += 2. * PI
    }
    a
}

// rectangle.ts

pub fn rectangle_from_numbers(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Rectangle {
    [[min_x, min_y], [max_x, max_y]]
}
pub fn rectangle_intersect_line_segment(r: Rectangle, l: Segment) -> Vec<Point> {
    let (tr, bl) = ([r[1][0], r[0][1]], [r[0][0], r[1][1]]);
    [[r[0], tr], [tr, r[1]], [r[1], bl], [bl, r[0]]]
        .into_iter()
        .filter_map(|s| line_segment_intersection_points(l, s, PRECISION))
        .collect()
}
pub fn rectangle_intersect_rectangle(a: Rectangle, b: Rectangle) -> bool {
    let ([[ax0, ay0], [ax1, ay1]], [[bx0, by0], [bx1, by1]]) = (a, b);
    ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0
}

// triangle.ts

pub fn triangle_includes_point([a, b, c]: Triangle, p: Point) -> bool {
    let sign = |p1: Point, p2: Point, p3: Point| {
        (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    };
    let (d1, d2, d3) = (sign(p, a, b), sign(p, b, c), sign(p, c, a));
    let neg = d1 < 0. || d2 < 0. || d3 < 0.;
    let pos = d1 > 0. || d2 > 0. || d3 > 0.;
    !(neg && pos)
}

// ellipse.ts

pub fn ellipse(center: Point, half_width: f64, half_height: f64) -> Ellipse {
    Ellipse {
        center,
        half_width,
        half_height,
    }
}
pub fn ellipse_includes_point(p: Point, e: Ellipse) -> bool {
    let nx = (p[0] - e.center[0]) / e.half_width;
    let ny = (p[1] - e.center[1]) / e.half_height;
    nx * nx + ny * ny <= 1.
}
pub fn ellipse_touches_point(p: Point, e: Ellipse, threshold: f64) -> bool {
    ellipse_distance_from_point(p, e) <= threshold
}
pub fn ellipse_distance_from_point(p: Point, e: Ellipse) -> f64 {
    let (a, b) = (e.half_width, e.half_height);
    let t = vector_add(p, vector_scale(e.center, -1.));
    if a == b {
        return (t[0].hypot(t[1]) - a).abs();
    }
    let (px, py) = (t[0].abs(), t[1].abs());
    let (mut tx, mut ty) = (0.707f64, 0.707f64);
    for _ in 0..3 {
        let (x, y) = (a * tx, b * ty);
        let ex = (a * a - b * b) * tx.powi(3) / a;
        let ey = (b * b - a * a) * ty.powi(3) / b;
        let (rx, ry, qx, qy) = (x - ex, y - ey, px - ex, py - ey);
        let r = ry.hypot(rx);
        let q = qy.hypot(qx);
        if q == 0. {
            break;
        }
        tx = 1f64.min(0f64.max((qx * r / q + ex) / a));
        ty = 1f64.min(0f64.max((qy * r / q + ey) / b));
        let h = ty.hypot(tx);
        tx /= h;
        ty /= h;
    }
    let min = [
        a * tx * if t[0] < 0. { -1. } else { 1. },
        b * ty * if t[1] < 0. { -1. } else { 1. },
    ];
    point_distance(t, min)
}
pub fn ellipse_segment_intercept_points(e: Ellipse, s: Segment) -> Vec<Point> {
    let (rx, ry) = (e.half_width, e.half_height);
    let dir = vector_from_point(s[1], s[0]);
    let diff = [s[0][0] - e.center[0], s[0][1] - e.center[1]];
    let m_dir = [dir[0] / (rx * rx), dir[1] / (ry * ry)];
    let m_diff = [diff[0] / (rx * rx), diff[1] / (ry * ry)];
    let a = vector_dot(dir, m_dir);
    let b = vector_dot(dir, m_diff);
    let c = vector_dot(diff, m_diff) - 1.;
    let d = b * b - a * c;
    let at = |t: f64| {
        [
            s[0][0] + (s[1][0] - s[0][0]) * t,
            s[0][1] + (s[1][1] - s[0][1]) * t,
        ]
    };
    let mut out = vec![];
    if d > 0. {
        let ta = (-b - d.sqrt()) / a;
        let tb = (-b + d.sqrt()) / a;
        if (0. ..=1.).contains(&ta) {
            out.push(at(ta))
        }
        if (0. ..=1.).contains(&tb) {
            out.push(at(tb))
        }
    } else if d == 0. {
        let t = -b / a;
        if (0. ..=1.).contains(&t) {
            out.push(at(t))
        }
    }
    out
}
pub fn ellipse_line_intersection_points(e: Ellipse, [g, h]: Line) -> Vec<Point> {
    let [cx, cy] = e.center;
    let (x1, y1, x2, y2) = (g[0] - cx, g[1] - cy, h[0] - cx, h[1] - cy);
    let (w2, h2) = (e.half_width.powi(2), e.half_height.powi(2));
    let a = (x2 - x1).powi(2) / w2 + (y2 - y1).powi(2) / h2;
    let b = 2. * (x1 * (x2 - x1) / w2 + y1 * (y2 - y1) / h2);
    let c = x1.powi(2) / w2 + y1.powi(2) / h2 - 1.;
    let disc = (b.powi(2) - 4. * a * c).sqrt();
    let t1 = (-b + disc) / (2. * a);
    let t2 = (-b - disc) / (2. * a);
    let cand: Vec<Point> = [
        [x1 + t1 * (x2 - x1) + cx, y1 + t1 * (y2 - y1) + cy],
        [x1 + t2 * (x2 - x1) + cx, y1 + t2 * (y2 - y1) + cy],
    ]
    .into_iter()
    .filter(|p| !p[0].is_nan() && !p[1].is_nan())
    .collect();
    if cand.len() == 2 && points_equal(cand[0], cand[1], PRECISION) {
        return vec![cand[0]];
    }
    cand
}

// curve.ts

#[allow(clippy::excessive_precision)]
const LG_T: [f64; 24] = [
    -0.0640568928626056260850430826247450385909,
    0.0640568928626056260850430826247450385909,
    -0.1911188674736163091586398207570696318404,
    0.1911188674736163091586398207570696318404,
    -0.3150426796961633743867932913198102407864,
    0.3150426796961633743867932913198102407864,
    -0.4337935076260451384870842319133497124524,
    0.4337935076260451384870842319133497124524,
    -0.5454214713888395356583756172183723700107,
    0.5454214713888395356583756172183723700107,
    -0.6480936519369755692524957869107476266696,
    0.6480936519369755692524957869107476266696,
    -0.7401241915785543642438281030999784255232,
    0.7401241915785543642438281030999784255232,
    -0.8200019859739029219539498726697452080761,
    0.8200019859739029219539498726697452080761,
    -0.8864155270044010342131543419821967550873,
    0.8864155270044010342131543419821967550873,
    -0.9382745520027327585236490017087214496548,
    0.9382745520027327585236490017087214496548,
    -0.9747285559713094981983919930081690617411,
    0.9747285559713094981983919930081690617411,
    -0.9951872199970213601799974097007368118745,
    0.9951872199970213601799974097007368118745,
];
#[allow(clippy::excessive_precision)]
const LG_C: [f64; 24] = [
    0.1279381953467521569740561652246953718517,
    0.1279381953467521569740561652246953718517,
    0.1258374563468282961213753825111836887264,
    0.1258374563468282961213753825111836887264,
    0.121670472927803391204463153476262425607,
    0.121670472927803391204463153476262425607,
    0.1155056680537256013533444839067835598622,
    0.1155056680537256013533444839067835598622,
    0.1074442701159656347825773424466062227946,
    0.1074442701159656347825773424466062227946,
    0.0976186521041138882698806644642471544279,
    0.0976186521041138882698806644642471544279,
    0.086190161531953275917185202983742667185,
    0.086190161531953275917185202983742667185,
    0.0733464814110803057340336152531165181193,
    0.0733464814110803057340336152531165181193,
    0.0592985849154367807463677585001085845412,
    0.0592985849154367807463677585001085845412,
    0.0442774388174198061686027482113382288593,
    0.0442774388174198061686027482113382288593,
    0.0285313886289336631813078159518782864491,
    0.0285313886289336631813078159518782864491,
    0.0123412297999871995468056670700372915759,
    0.0123412297999871995468056670700372915759,
];

fn solve_with_jacobian(
    c: Curve,
    l: Segment,
    mut t0: f64,
    mut s0: f64,
    tolerance: f64,
    iter_limit: u32,
) -> Option<[f64; 2]> {
    let mut err = f64::INFINITY;
    let mut iter = 0;
    while err >= tolerance {
        if iter >= iter_limit {
            return None;
        }
        let bt = 1. - t0;
        let (bt2, t02) = (bt * bt, t0 * t0);
        let (bt3, t03) = (bt2 * bt, t02 * t0);
        let bx = bt3 * c[0][0] + 3. * bt2 * t0 * c[1][0] + 3. * bt * t02 * c[2][0] + t03 * c[3][0];
        let by = bt3 * c[0][1] + 3. * bt2 * t0 * c[1][1] + 3. * bt * t02 * c[2][1] + t03 * c[3][1];
        let lx = l[0][0] + s0 * (l[1][0] - l[0][0]);
        let ly = l[0][1] + s0 * (l[1][1] - l[0][1]);
        let (fx, fy) = (bx - lx, by - ly);
        err = fx.abs() + fy.abs();
        if err < tolerance {
            break;
        }
        let d = |k: usize| {
            -3. * bt2 * c[0][k] + 3. * bt2 * c[1][k] - 6. * bt * t0 * c[1][k] - 3. * t02 * c[2][k]
                + 6. * bt * t0 * c[2][k]
                + 3. * t02 * c[3][k]
        };
        let (dfx_dt, dfy_dt) = (d(0), d(1));
        let dfx_ds = -(l[1][0] - l[0][0]);
        let dfy_ds = -(l[1][1] - l[0][1]);
        let det = dfx_dt * dfy_ds - dfx_ds * dfy_dt;
        if det.abs() < 1e-12 {
            return None;
        }
        let inv = 1. / det;
        t0 += inv * (dfy_ds * -fx - dfx_ds * -fy);
        s0 += inv * (-dfy_dt * -fx + dfx_dt * -fy);
        iter += 1;
    }
    Some([t0, s0])
}
pub fn bezier_equation(c: Curve, t: f64) -> Point {
    let u = 1. - t;
    let f = |k: usize| {
        u.powi(3) * c[0][k]
            + 3. * u.powi(2) * t * c[1][k]
            + 3. * u * t.powi(2) * c[2][k]
            + t.powi(3) * c[3][k]
    };
    [f(0), f(1)]
}
/// Defaults upstream: tolerance 1e-2, iteration limit 4.
pub fn curve_intersect_line_segment(
    c: Curve,
    l: Segment,
    tolerance: f64,
    iter_limit: u32,
) -> Vec<Point> {
    for guess in [[0.5, 0.], [0.2, 0.], [0.8, 0.]] {
        if let Some([t, s]) = solve_with_jacobian(c, l, guess[0], guess[1], tolerance, iter_limit)
            && (0. ..=1.).contains(&t)
            && (0. ..=1.).contains(&s)
        {
            return vec![bezier_equation(c, t)];
        }
    }
    vec![]
}
pub fn curve_closest_parameter(c: Curve, p: Point, tolerance: f64) -> f64 {
    let f = |t: f64| point_distance(p, bezier_equation(c, t));
    const STEPS: i32 = 30;
    let (mut min, mut closest) = (f64::INFINITY, 0);
    for step in 0..=STEPS {
        let d = f(step as f64 / STEPS as f64);
        if d < min {
            min = d;
            closest = step;
        }
    }
    let mut m = ((closest - 1) as f64 / STEPS as f64).max(0.);
    let mut n = ((closest + 1) as f64 / STEPS as f64).min(1.);
    let mut k = None;
    while n - m > tolerance {
        let kk = (n + m) / 2.;
        k = Some(kk);
        if f(kk - tolerance) < f(kk + tolerance) {
            n = kk
        } else {
            m = kk
        }
    }
    k.unwrap_or(closest as f64 / STEPS as f64)
}
pub fn curve_closest_point(c: Curve, p: Point, tolerance: f64) -> Point {
    bezier_equation(c, curve_closest_parameter(c, p, tolerance))
}
pub fn curve_point_distance(c: Curve, p: Point, tolerance: f64) -> f64 {
    point_distance(p, curve_closest_point(c, p, tolerance))
}
pub fn curve_tangent([p0, p1, p2, p3]: Curve, t: f64) -> Vector {
    let u = 1. - t;
    let f = |k: usize| {
        -3. * u * u * p0[k] + 3. * u * u * p1[k] - 6. * t * u * p1[k] - 3. * t * t * p2[k]
            + 6. * t * u * p2[k]
            + 3. * t * t * p3[k]
    };
    [f(0), f(1)]
}
/// Control point and end of each quadratic segment (tension 0.5 upstream).
pub fn curve_catmull_rom_quadratic_approx_points(
    pts: &[Point],
    tension: f64,
) -> Option<Vec<[Point; 2]>> {
    if pts.len() < 2 {
        return None;
    }
    let n = pts.len();
    Some(
        (0..n - 1)
            .map(|i| {
                let (p0, p1, p2) = (pts[i.saturating_sub(1)], pts[i], pts[(i + 1).min(n - 1)]);
                [
                    [
                        p1[0] + (p2[0] - p0[0]) * tension / 2.,
                        p1[1] + (p2[1] - p0[1]) * tension / 2.,
                    ],
                    p2,
                ]
            })
            .collect(),
    )
}
pub fn curve_catmull_rom_cubic_approx_points(pts: &[Point], tension: f64) -> Option<Vec<Curve>> {
    if pts.len() < 2 {
        return None;
    }
    let n = pts.len();
    Some(
        (0..n - 1)
            .map(|i| {
                let (p0, p1, p2, p3) = (
                    pts[i.saturating_sub(1)],
                    pts[i],
                    pts[(i + 1).min(n - 1)],
                    pts[(i + 2).min(n - 1)],
                );
                let t1 = [(p2[0] - p0[0]) * tension, (p2[1] - p0[1]) * tension];
                let t2 = [(p3[0] - p1[0]) * tension, (p3[1] - p1[1]) * tension];
                [
                    p1,
                    [p1[0] + t1[0] / 3., p1[1] + t1[1] / 3.],
                    [p2[0] - t2[0] / 3., p2[1] - t2[1] / 3.],
                    p2,
                ]
            })
            .collect(),
    )
}
pub fn curve_offset_points(c: Curve, offset: f64, steps: usize) -> Vec<Point> {
    (0..=steps)
        .map(|i| {
            let t = i as f64 / steps as f64;
            let n = vector_normal(vector_normalize(curve_tangent(c, t)));
            point_from_vector(vector_scale(n, offset), bezier_equation(c, t))
        })
        .collect()
}
pub fn offset_points_for_quadratic_bezier(
    p0: Point,
    p1: Point,
    p2: Point,
    offset: f64,
    steps: usize,
) -> Vec<Point> {
    (0..=steps)
        .map(|i| {
            let t = i as f64 / steps as f64;
            let u = 1. - t;
            let p = [
                u * u * p0[0] + 2. * u * t * p1[0] + t * t * p2[0],
                u * u * p0[1] + 2. * u * t * p1[1] + t * t * p2[1],
            ];
            let tan = [
                2. * u * (p1[0] - p0[0]) + 2. * t * (p2[0] - p1[0]),
                2. * u * (p1[1] - p0[1]) + 2. * t * (p2[1] - p1[1]),
            ];
            point_from_vector(
                vector_scale(vector_normal(vector_normalize(tan)), offset),
                p,
            )
        })
        .collect()
}
pub fn curve_length(c: Curve) -> f64 {
    let z2 = 0.5;
    let sum: f64 = (0..24)
        .map(|i| LG_C[i] * vector_magnitude(curve_tangent(c, z2 * LG_T[i] + z2)))
        .sum();
    z2 * sum
}
pub fn curve_length_at_parameter(c: Curve, t: f64) -> f64 {
    if t <= 0. {
        return 0.;
    }
    if t >= 1. {
        return curve_length(c);
    }
    let z = t / 2.;
    let sum: f64 = (0..24)
        .map(|i| LG_C[i] * vector_magnitude(curve_tangent(c, z * LG_T[i] + z)))
        .sum();
    z * sum
}
pub fn curve_point_at_length(c: Curve, percent: f64, total: Option<f64>) -> Point {
    if percent <= 0. {
        return bezier_equation(c, 0.);
    }
    if percent >= 1. {
        return bezier_equation(c, 1.);
    }
    let total = total.unwrap_or_else(|| curve_length(c));
    let target = total * percent;
    let (mut lo, mut hi, mut t) = (0., 1., percent);
    let tol = total * 0.0001;
    for _ in 0..20 {
        let cur = curve_length_at_parameter(c, t);
        if (cur - target).abs() < tol {
            break;
        }
        if cur < target {
            lo = t
        } else {
            hi = t
        }
        t = (lo + hi) / 2.;
    }
    bezier_equation(c, t)
}
