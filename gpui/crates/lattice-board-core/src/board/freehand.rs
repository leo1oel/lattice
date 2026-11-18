// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Pressure-sensitive stroke outlines for freedraw elements. Port of
//! perfect-freehand 1.2.0 (MIT, Steve Ruiz, github.com/steveruizok/
//! perfect-freehand; `getStroke`, `getStrokePoints`,
//! `getStrokeOutlinePoints`, `getStrokeRadius`, `vec.ts`), the version
//! Excalidraw @ 3a317b5 pins. Only the options Excalidraw passes are
//! modelled: tapers are off (perfect-freehand's default), caps are on.
//! The package isn't vendored here; this follows its published source.

use super::math::Point;
use std::f64::consts::PI;

const RATE_OF_PRESSURE_CHANGE: f64 = 0.275;
const FIXED_PI: f64 = PI + 0.0001;
const DEFAULT_PRESSURE: f64 = 0.5;

#[derive(Clone, Copy)]
pub struct StrokeOptions {
    pub size: f64,
    pub thinning: f64,
    pub smoothing: f64,
    pub streamline: f64,
    pub easing: fn(f64) -> f64,
    pub simulate_pressure: bool,
    /// The stroke is complete (`last`).
    pub last: bool,
}

impl Default for StrokeOptions {
    fn default() -> Self {
        StrokeOptions {
            size: 16.,
            thinning: 0.5,
            smoothing: 0.5,
            streamline: 0.5,
            easing: |t| t,
            simulate_pressure: true,
            last: false,
        }
    }
}

/// An input point; `pressure` None stands for a point without one (upstream's
/// two-number points), which gets the defaults.
#[derive(Clone, Copy, Debug)]
pub struct InputPoint {
    pub point: Point,
    pub pressure: Option<f64>,
}

#[derive(Clone, Copy, Debug)]
pub struct StrokePoint {
    pub point: Point,
    pub pressure: f64,
    pub vector: Point,
    pub distance: f64,
    pub running_length: f64,
}

fn add(a: Point, b: Point) -> Point {
    [a[0] + b[0], a[1] + b[1]]
}
fn sub(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1]]
}
fn mul(a: Point, n: f64) -> Point {
    [a[0] * n, a[1] * n]
}
fn per(a: Point) -> Point {
    [a[1], -a[0]]
}
fn neg(a: Point) -> Point {
    [-a[0], -a[1]]
}
fn dpr(a: Point, b: Point) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn len(a: Point) -> f64 {
    a[0].hypot(a[1])
}
fn uni(a: Point) -> Point {
    let l = len(a);
    [a[0] / l, a[1] / l]
}
fn dist(a: Point, b: Point) -> f64 {
    (a[1] - b[1]).hypot(a[0] - b[0])
}
fn dist2(a: Point, b: Point) -> f64 {
    let d = sub(a, b);
    d[0] * d[0] + d[1] * d[1]
}
fn lrp(a: Point, b: Point, t: f64) -> Point {
    add(a, mul(sub(b, a), t))
}
fn prj(a: Point, b: Point, c: f64) -> Point {
    add(a, mul(b, c))
}
fn rot_around(a: Point, c: Point, r: f64) -> Point {
    let (s, co) = r.sin_cos();
    let (px, py) = (a[0] - c[0], a[1] - c[1]);
    [px * co - py * s + c[0], px * s + py * co + c[1]]
}

/// `getStrokeRadius`.
pub fn get_stroke_radius(size: f64, thinning: f64, pressure: f64, easing: fn(f64) -> f64) -> f64 {
    size * easing(0.5 - thinning * (0.5 - pressure))
}

/// `getStroke`: the outline polygon.
pub fn get_stroke(points: &[InputPoint], o: &StrokeOptions) -> Vec<Point> {
    get_stroke_outline_points(&get_stroke_points(points, o), o)
}

/// `getStrokePoints`: the streamlined centerline.
pub fn get_stroke_points(points: &[InputPoint], o: &StrokeOptions) -> Vec<StrokePoint> {
    if points.is_empty() {
        return vec![];
    }
    let t = 0.15 + (1. - o.streamline) * 0.85;
    let mut pts = points.to_vec();
    if pts.len() == 2 {
        // `lrp` is two-dimensional: the new points have no pressure
        let last = pts[1];
        pts.truncate(1);
        for i in 1..5 {
            pts.push(InputPoint {
                point: lrp(pts[0].point, last.point, i as f64 / 4.),
                pressure: None,
            });
        }
    }
    if pts.len() == 1 {
        pts.push(InputPoint {
            point: add(pts[0].point, [1., 1.]),
            pressure: pts[0].pressure,
        });
    }
    let pressure = |p: &InputPoint, d: f64| p.pressure.filter(|&v| v >= 0.).unwrap_or(d);
    let mut out = vec![StrokePoint {
        point: pts[0].point,
        pressure: pressure(&pts[0], 0.25),
        vector: [1., 1.],
        distance: 0.,
        running_length: 0.,
    }];
    let mut reached_min = false;
    let mut running = 0.;
    let mut prev = out[0];
    let max = pts.len() - 1;
    for (i, p) in pts.iter().enumerate().skip(1) {
        let point = if o.last && i == max {
            p.point
        } else {
            lrp(prev.point, p.point, t)
        };
        if prev.point == point {
            continue;
        }
        let distance = dist(point, prev.point);
        running += distance;
        if i < max && !reached_min {
            if running < o.size {
                continue;
            }
            reached_min = true;
        }
        prev = StrokePoint {
            point,
            pressure: pressure(p, DEFAULT_PRESSURE),
            vector: uni(sub(prev.point, point)),
            distance,
            running_length: running,
        };
        out.push(prev);
    }
    out[0].vector = out.get(1).map_or([0., 0.], |p| p.vector);
    out
}

/// `getStrokeOutlinePoints`, without tapers.
pub fn get_stroke_outline_points(points: &[StrokePoint], o: &StrokeOptions) -> Vec<Point> {
    let size = o.size;
    if points.is_empty() || size <= 0. {
        return vec![];
    }
    let n = points.len();
    let total = points[n - 1].running_length;
    let min_distance = (size * o.smoothing).powi(2);
    let (mut left, mut right): (Vec<Point>, Vec<Point>) = (vec![], vec![]);
    let simulated = |prev: f64, p: &StrokePoint| {
        let sp = (p.distance / size).min(1.);
        let rp = (1. - sp).min(1.);
        (prev + (rp - prev) * (sp * RATE_OF_PRESSURE_CHANGE)).min(1.)
    };
    let mut prev_pressure = points.iter().take(10).fold(points[0].pressure, |acc, p| {
        let pressure = if o.simulate_pressure {
            simulated(acc, p)
        } else {
            p.pressure
        };
        (acc + pressure) / 2.
    });
    let mut radius = get_stroke_radius(size, o.thinning, points[n - 1].pressure, o.easing);
    let mut first_radius: Option<f64> = None;
    let mut prev_vector = points[0].vector;
    let (mut pl, mut pr) = (points[0].point, points[0].point);
    let (mut tl, mut tr);
    let mut prev_sharp = false;
    for i in 0..n {
        let StrokePoint {
            point,
            vector,
            running_length,
            mut pressure,
            ..
        } = points[i];
        if i < n - 1 && total - running_length < 3. {
            continue;
        }
        if o.thinning != 0. {
            if o.simulate_pressure {
                pressure = simulated(prev_pressure, &points[i]);
            }
            radius = get_stroke_radius(size, o.thinning, pressure, o.easing);
        } else {
            radius = size / 2.;
        }
        if first_radius.is_none() {
            first_radius = Some(radius);
        }
        radius = radius.max(0.01);
        let next_vector = if i < n - 1 {
            points[i + 1].vector
        } else {
            vector
        };
        let next_dpr = if i < n - 1 {
            dpr(vector, next_vector)
        } else {
            1.
        };
        let prev_dpr = dpr(vector, prev_vector);
        let sharp = prev_dpr < 0. && !prev_sharp;
        let next_sharp = next_dpr < 0.;
        if sharp || next_sharp {
            let offset = mul(per(prev_vector), radius);
            let (step, mut t) = (1. / 13., 0.);
            while t <= 1. {
                tl = rot_around(sub(point, offset), point, FIXED_PI * t);
                left.push(tl);
                tr = rot_around(add(point, offset), point, FIXED_PI * -t);
                right.push(tr);
                pl = tl;
                pr = tr;
                t += step;
            }
            if next_sharp {
                prev_sharp = true;
            }
            continue;
        }
        prev_sharp = false;
        if i == n - 1 {
            let offset = mul(per(vector), radius);
            left.push(sub(point, offset));
            right.push(add(point, offset));
            continue;
        }
        let offset = mul(per(lrp(next_vector, vector, next_dpr)), radius);
        tl = sub(point, offset);
        if i <= 1 || dist2(pl, tl) > min_distance {
            left.push(tl);
            pl = tl;
        }
        tr = add(point, offset);
        if i <= 1 || dist2(pr, tr) > min_distance {
            right.push(tr);
            pr = tr;
        }
        prev_pressure = pressure;
        prev_vector = vector;
    }
    let first = points[0].point;
    let last = if n > 1 {
        points[n - 1].point
    } else {
        add(points[0].point, [1., 1.])
    };
    if n == 1 {
        let start = prj(
            first,
            uni(per(sub(first, last))),
            -first_radius.unwrap_or(radius),
        );
        let (step, mut t, mut dot) = (1. / 13., 1. / 13., vec![]);
        while t <= 1. {
            dot.push(rot_around(start, first, FIXED_PI * 2. * t));
            t += step;
        }
        return dot;
    }
    let mut start_cap = vec![];
    if let Some(&r0) = right.first() {
        let (step, mut t) = (1. / 13., 1. / 13.);
        while t <= 1. {
            start_cap.push(rot_around(r0, first, FIXED_PI * t));
            t += step;
        }
    }
    let direction = per(neg(points[n - 1].vector));
    let mut end_cap = vec![];
    let start = prj(last, direction, radius);
    let (step, mut t) = (1. / 29., 1. / 29.);
    while t < 1. {
        end_cap.push(rot_around(start, last, FIXED_PI * 3. * t));
        t += step;
    }
    right.reverse();
    let mut out = left;
    out.extend(end_cap);
    out.extend(right);
    out.extend(start_cap);
    out
}
