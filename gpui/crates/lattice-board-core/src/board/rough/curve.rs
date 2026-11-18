// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! points-on-curve 0.2.0 / 1.0.1 (MIT, Preet Shihn): `pointsOnBezierCurves`,
//! `simplify` (Ramer–Douglas–Peucker) and `curveToBezier`.

use crate::board::math::Point;

fn lerp(a: Point, b: Point, t: f64) -> Point {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}
fn dist_sq(a: Point, b: Point) -> f64 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)
}
fn dist_to_segment_sq(p: Point, v: Point, w: Point) -> f64 {
    let l2 = dist_sq(v, w);
    if l2 == 0. {
        return dist_sq(p, v);
    }
    let t = (((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2).clamp(0., 1.);
    dist_sq(p, lerp(v, w, t))
}

fn flatness(p: &[Point]) -> f64 {
    let mut ux = 3. * p[1][0] - 2. * p[0][0] - p[3][0];
    ux *= ux;
    let mut uy = 3. * p[1][1] - 2. * p[0][1] - p[3][1];
    uy *= uy;
    let mut vx = 3. * p[2][0] - 2. * p[3][0] - p[0][0];
    vx *= vx;
    let mut vy = 3. * p[2][1] - 2. * p[3][1] - p[0][1];
    vy *= vy;
    if ux < vx {
        ux = vx
    }
    if uy < vy {
        uy = vy
    }
    ux + uy
}

fn points_on_bezier_with_splitting(p: &[Point], tolerance: f64, out: &mut Vec<Point>) {
    if flatness(p) < tolerance {
        let p0 = p[0];
        match out.last() {
            Some(&last) => {
                if dist_sq(last, p0).sqrt() > 1. {
                    out.push(p0)
                }
            }
            None => out.push(p0),
        }
        out.push(p[3]);
    } else {
        let (q1, q2, q3) = (
            lerp(p[0], p[1], 0.5),
            lerp(p[1], p[2], 0.5),
            lerp(p[2], p[3], 0.5),
        );
        let (r1, r2) = (lerp(q1, q2, 0.5), lerp(q2, q3, 0.5));
        let red = lerp(r1, r2, 0.5);
        points_on_bezier_with_splitting(&[p[0], q1, r1, red], tolerance, out);
        points_on_bezier_with_splitting(&[red, r2, q3, p[3]], tolerance, out);
    }
}

/// `simplify`.
pub fn simplify(points: &[Point], distance: f64) -> Vec<Point> {
    let mut out = vec![];
    if !points.is_empty() {
        simplify_points(points, 0, points.len(), distance, &mut out);
    }
    out
}

/// `simplifyPoints`.
pub fn simplify_points(p: &[Point], start: usize, end: usize, eps: f64, out: &mut Vec<Point>) {
    let (s, e) = (p[start], p[end - 1]);
    let (mut max_sq, mut max_i) = (0., 1);
    for (i, &q) in p.iter().enumerate().take(end - 1).skip(start + 1) {
        let d = dist_to_segment_sq(q, s, e);
        if d > max_sq {
            max_sq = d;
            max_i = i;
        }
    }
    if max_sq.sqrt() > eps {
        simplify_points(p, start, max_i + 1, eps, out);
        simplify_points(p, max_i, end, eps, out);
    } else {
        if out.is_empty() {
            out.push(s)
        }
        out.push(e);
    }
}

/// `pointsOnBezierCurves`: `points` is a start point plus three per cubic;
/// the default tolerance is 0.15.
pub fn points_on_bezier_curves(
    points: &[Point],
    tolerance: f64,
    distance: Option<f64>,
) -> Vec<Point> {
    let mut out = vec![];
    let mut i = 0;
    while i + 3 < points.len() {
        points_on_bezier_with_splitting(&points[i..i + 4], tolerance, &mut out);
        i += 3;
    }
    match distance {
        Some(d) if d > 0. && !out.is_empty() => {
            let mut s = vec![];
            simplify_points(&out, 0, out.len(), d, &mut s);
            s
        }
        _ => out,
    }
}

/// `curveToBezier` (curveTightness 0); fewer than three points come back as
/// they are (upstream throws).
pub fn curve_to_bezier(pts: &[Point]) -> Vec<Point> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    if pts.len() == 3 {
        return vec![pts[0], pts[1], pts[2], pts[2]];
    }
    let mut p = vec![pts[0], pts[0]];
    p.extend_from_slice(&pts[1..]);
    p.push(pts[pts.len() - 1]);
    let s = 1.;
    let mut out = vec![p[0]];
    for i in 1..p.len() - 2 {
        let c = p[i];
        out.push([
            c[0] + (s * p[i + 1][0] - s * p[i - 1][0]) / 6.,
            c[1] + (s * p[i + 1][1] - s * p[i - 1][1]) / 6.,
        ]);
        out.push([
            p[i + 1][0] + (s * p[i][0] - s * p[i + 2][0]) / 6.,
            p[i + 1][1] + (s * p[i][1] - s * p[i + 2][1]) / 6.,
        ]);
        out.push(p[i + 1]);
    }
    out
}
