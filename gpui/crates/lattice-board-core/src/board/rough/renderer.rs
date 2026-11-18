// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! rough.js `renderer.js`: the sketchy primitives. Every function draws its
//! random numbers from `r` in the order rough.js does, so a seed gives the
//! same ops.

use super::path_data::Seg;
use super::{Op, OpSet, OpSetType, Options, Random, fillers};
use crate::board::math::Point;
use std::f64::consts::PI;

pub fn line(x1: f64, y1: f64, x2: f64, y2: f64, o: &Options, r: &mut Random) -> OpSet {
    OpSet::path(double_line(x1, y1, x2, y2, o, r, false))
}

pub fn linear_path(points: &[Point], close: bool, o: &Options, r: &mut Random) -> OpSet {
    let len = points.len();
    if len > 2 {
        let mut ops = vec![];
        for i in 0..len - 1 {
            ops.extend(double_line(
                points[i][0],
                points[i][1],
                points[i + 1][0],
                points[i + 1][1],
                o,
                r,
                false,
            ));
        }
        if close {
            ops.extend(double_line(
                points[len - 1][0],
                points[len - 1][1],
                points[0][0],
                points[0][1],
                o,
                r,
                false,
            ));
        }
        OpSet::path(ops)
    } else if len == 2 {
        line(points[0][0], points[0][1], points[1][0], points[1][1], o, r)
    } else {
        OpSet::path(vec![])
    }
}

pub fn polygon(points: &[Point], o: &Options, r: &mut Random) -> OpSet {
    linear_path(points, true, o, r)
}

pub fn rectangle(x: f64, y: f64, w: f64, h: f64, o: &Options, r: &mut Random) -> OpSet {
    polygon(&[[x, y], [x + w, y], [x + w, y + h], [x, y + h]], o, r)
}

pub fn curve(points: &[Point], o: &Options, r: &mut Random) -> OpSet {
    let mut o1 = curve_with_offset(points, 1. * (1. + o.roughness * 0.2), o, r);
    if !o.disable_multi_stroke {
        let (o2, mut r2) = clone_options_alter_seed(o);
        o1.extend(curve_with_offset(
            points,
            1.5 * (1. + o.roughness * 0.22),
            &o2,
            &mut r2,
        ));
    }
    OpSet::path(o1)
}

/// `ellipse`: the outline ops.
pub fn ellipse(x: f64, y: f64, w: f64, h: f64, o: &Options, r: &mut Random) -> OpSet {
    let p = generate_ellipse_params(w, h, o, r);
    ellipse_with_params(x, y, o, &p, r).1
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EllipseParams {
    pub increment: f64,
    pub rx: f64,
    pub ry: f64,
}

pub fn generate_ellipse_params(w: f64, h: f64, o: &Options, r: &mut Random) -> EllipseParams {
    let psq = (PI * 2. * (((w / 2.).powi(2) + (h / 2.).powi(2)) / 2.).sqrt()).sqrt();
    let step_count = o
        .curve_step_count
        .max((o.curve_step_count / 200f64.sqrt()) * psq)
        .ceil();
    let increment = (PI * 2.) / step_count;
    let mut rx = (w / 2.).abs();
    let mut ry = (h / 2.).abs();
    let fit = 1. - o.curve_fitting;
    rx += offset_opt(rx * fit, o, r, 1.);
    ry += offset_opt(ry * fit, o, r, 1.);
    EllipseParams { increment, rx, ry }
}

/// `ellipseWithParams`: (estimated points, outline).
pub fn ellipse_with_params(
    x: f64,
    y: f64,
    o: &Options,
    p: &EllipseParams,
    r: &mut Random,
) -> (Vec<Point>, OpSet) {
    let inner = offset(0.4, 1., o, r, 1.);
    let overlap = p.increment * offset(0.1, inner, o, r, 1.);
    let (ap1, cp1) = compute_ellipse_points(p.increment, x, y, p.rx, p.ry, 1., overlap, o, r);
    let mut o1 = curve_ops(&ap1, o, r);
    if !o.disable_multi_stroke && o.roughness != 0. {
        let (ap2, _) = compute_ellipse_points(p.increment, x, y, p.rx, p.ry, 1.5, 0., o, r);
        o1.extend(curve_ops(&ap2, o, r));
    }
    (cp1, OpSet::path(o1))
}

#[allow(clippy::too_many_arguments)]
pub fn arc(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    start: f64,
    stop: f64,
    closed: bool,
    rough_closure: bool,
    o: &Options,
    r: &mut Random,
) -> OpSet {
    let (cx, cy) = (x, y);
    let mut rx = (w / 2.).abs();
    let mut ry = (h / 2.).abs();
    rx += offset_opt(rx * 0.01, o, r, 1.);
    ry += offset_opt(ry * 0.01, o, r, 1.);
    let (strt, stp) = arc_range(start, stop);
    let ellipse_inc = (PI * 2.) / o.curve_step_count;
    let arc_inc = (ellipse_inc / 2.).min((stp - strt) / 2.);
    let mut ops = arc_ops(arc_inc, cx, cy, rx, ry, strt, stp, 1., o, r);
    if !o.disable_multi_stroke {
        ops.extend(arc_ops(arc_inc, cx, cy, rx, ry, strt, stp, 1.5, o, r));
    }
    if closed {
        if rough_closure {
            ops.extend(double_line(
                cx,
                cy,
                cx + rx * strt.cos(),
                cy + ry * strt.sin(),
                o,
                r,
                false,
            ));
            ops.extend(double_line(
                cx,
                cy,
                cx + rx * stp.cos(),
                cy + ry * stp.sin(),
                o,
                r,
                false,
            ));
        } else {
            ops.push(Op::LineTo([cx, cy]));
            ops.push(Op::LineTo([cx + rx * strt.cos(), cy + ry * strt.sin()]));
        }
    }
    OpSet::path(ops)
}

fn arc_range(start: f64, stop: f64) -> (f64, f64) {
    let (mut strt, mut stp) = (start, stop);
    while strt < 0. {
        strt += PI * 2.;
        stp += PI * 2.;
    }
    if stp - strt > PI * 2. {
        strt = 0.;
        stp = PI * 2.;
    }
    (strt, stp)
}

/// `svgPath` over absolute, normalized segments.
pub fn svg_path(segs: &[Seg], o: &Options, r: &mut Random) -> OpSet {
    let mut ops = vec![];
    let (mut first, mut cur) = ([0., 0.], [0., 0.]);
    for Seg { key, data } in segs {
        match key {
            'M' => {
                cur = [data[0], data[1]];
                first = cur;
            }
            'L' => {
                ops.extend(double_line(cur[0], cur[1], data[0], data[1], o, r, false));
                cur = [data[0], data[1]];
            }
            'C' => {
                ops.extend(bezier_to(
                    data[0], data[1], data[2], data[3], data[4], data[5], cur, o, r,
                ));
                cur = [data[4], data[5]];
            }
            'Z' => {
                ops.extend(double_line(cur[0], cur[1], first[0], first[1], o, r, false));
                cur = first;
            }
            _ => {}
        }
    }
    OpSet::path(ops)
}

// fills

pub fn solid_fill_polygon(polygons: &[Vec<Point>], o: &Options, r: &mut Random) -> OpSet {
    let mut ops = vec![];
    for points in polygons {
        let off = o.max_randomness_offset;
        if points.len() > 2 {
            let x = points[0][0] + offset_opt(off, o, r, 1.);
            ops.push(Op::Move([x, points[0][1] + offset_opt(off, o, r, 1.)]));
            for p in &points[1..] {
                let x = p[0] + offset_opt(off, o, r, 1.);
                ops.push(Op::LineTo([x, p[1] + offset_opt(off, o, r, 1.)]));
            }
        }
    }
    OpSet {
        ty: OpSetType::FillPath,
        ops,
    }
}

/// `patternFillPolygons`. The polygons are rotated and back in place, as
/// hachure-fill does (the round trip can move them by an ulp).
pub fn pattern_fill_polygons(polygons: &mut [Vec<Point>], o: &Options, r: &mut Random) -> OpSet {
    fillers::fill_polygons(polygons, o, r)
}

#[allow(clippy::too_many_arguments)]
pub fn pattern_fill_arc(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    start: f64,
    stop: f64,
    o: &Options,
    r: &mut Random,
) -> OpSet {
    let (cx, cy) = (x, y);
    let mut rx = (w / 2.).abs();
    let mut ry = (h / 2.).abs();
    rx += offset_opt(rx * 0.01, o, r, 1.);
    ry += offset_opt(ry * 0.01, o, r, 1.);
    let (strt, stp) = arc_range(start, stop);
    let increment = (stp - strt) / o.curve_step_count;
    let mut points = vec![];
    let mut a = strt;
    while a <= stp {
        points.push([cx + rx * a.cos(), cy + ry * a.sin()]);
        a += increment;
    }
    points.push([cx + rx * stp.cos(), cy + ry * stp.sin()]);
    points.push([cx, cy]);
    pattern_fill_polygons(&mut [points], o, r)
}

/// `doubleLineFillOps`.
pub fn double_line_fill_ops(
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    o: &Options,
    r: &mut Random,
) -> Vec<Op> {
    double_line(x1, y1, x2, y2, o, r, true)
}

// private helpers

fn clone_options_alter_seed(o: &Options) -> (Options, Random) {
    let mut c = o.clone();
    if o.seed != 0 {
        c.seed = o.seed + 1;
    }
    let r = Random::new(c.seed);
    (c, r)
}

fn offset(min: f64, max: f64, o: &Options, r: &mut Random, gain: f64) -> f64 {
    o.roughness * gain * ((r.next() * (max - min)) + min)
}
fn offset_opt(x: f64, o: &Options, r: &mut Random, gain: f64) -> f64 {
    offset(-x, x, o, r, gain)
}

fn double_line(
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    o: &Options,
    r: &mut Random,
    filling: bool,
) -> Vec<Op> {
    let single = if filling {
        o.disable_multi_stroke_fill
    } else {
        o.disable_multi_stroke
    };
    let mut o1 = line_ops(x1, y1, x2, y2, o, r, true, false);
    if single {
        return o1;
    }
    o1.extend(line_ops(x1, y1, x2, y2, o, r, true, true));
    o1
}

#[allow(clippy::too_many_arguments)]
fn line_ops(
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    o: &Options,
    r: &mut Random,
    mv: bool,
    overlay: bool,
) -> Vec<Op> {
    let length_sq = (x1 - x2).powi(2) + (y1 - y2).powi(2);
    let length = length_sq.sqrt();
    let gain = if length < 200. {
        1.
    } else if length > 500. {
        0.4
    } else {
        (-0.0016668) * length + 1.233334
    };
    let mut off = o.max_randomness_offset;
    if (off * off * 100.) > length_sq {
        off = length / 10.;
    }
    let half = off / 2.;
    let diverge = 0.2 + r.next() * 0.2;
    let mut mid_x = o.bowing * o.max_randomness_offset * (y2 - y1) / 200.;
    let mut mid_y = o.bowing * o.max_randomness_offset * (x1 - x2) / 200.;
    mid_x = offset_opt(mid_x, o, r, gain);
    mid_y = offset_opt(mid_y, o, r, gain);
    let pv = o.preserve_vertices;
    let mut ops = Vec::with_capacity(2);
    let jitter = |r: &mut Random| {
        if overlay {
            offset_opt(half, o, r, gain)
        } else {
            offset_opt(off, o, r, gain)
        }
    };
    if mv {
        let x = x1 + if pv { 0. } else { jitter(r) };
        let y = y1 + if pv { 0. } else { jitter(r) };
        ops.push(Op::Move([x, y]));
    }
    let a = mid_x + x1 + (x2 - x1) * diverge + jitter(r);
    let b = mid_y + y1 + (y2 - y1) * diverge + jitter(r);
    let c = mid_x + x1 + 2. * (x2 - x1) * diverge + jitter(r);
    let d = mid_y + y1 + 2. * (y2 - y1) * diverge + jitter(r);
    let e = x2 + if pv { 0. } else { jitter(r) };
    let f = y2 + if pv { 0. } else { jitter(r) };
    ops.push(Op::BCurveTo([a, b], [c, d], [e, f]));
    ops
}

fn curve_with_offset(points: &[Point], off: f64, o: &Options, r: &mut Random) -> Vec<Op> {
    let mut ps = Vec::with_capacity(points.len() + 2);
    let jit = |p: Point, r: &mut Random| {
        let x = p[0] + offset_opt(off, o, r, 1.);
        [x, p[1] + offset_opt(off, o, r, 1.)]
    };
    ps.push(jit(points[0], r));
    ps.push(jit(points[0], r));
    for i in 1..points.len() {
        ps.push(jit(points[i], r));
        if i == points.len() - 1 {
            ps.push(jit(points[i], r));
        }
    }
    curve_ops(&ps, o, r)
}

/// `_curve` (no close point: rough.js never passes one here).
fn curve_ops(points: &[Point], o: &Options, r: &mut Random) -> Vec<Op> {
    let len = points.len();
    let mut ops = vec![];
    if len > 3 {
        let s = 1. - o.curve_tightness;
        ops.push(Op::Move(points[1]));
        let mut i = 1;
        while i + 2 < len {
            let c = points[i];
            let b1 = [
                c[0] + (s * points[i + 1][0] - s * points[i - 1][0]) / 6.,
                c[1] + (s * points[i + 1][1] - s * points[i - 1][1]) / 6.,
            ];
            let b2 = [
                points[i + 1][0] + (s * points[i][0] - s * points[i + 2][0]) / 6.,
                points[i + 1][1] + (s * points[i][1] - s * points[i + 2][1]) / 6.,
            ];
            ops.push(Op::BCurveTo(b1, b2, points[i + 1]));
            i += 1;
        }
    } else if len == 3 {
        ops.push(Op::Move(points[1]));
        ops.push(Op::BCurveTo(points[1], points[2], points[2]));
    } else if len == 2 {
        ops.extend(double_line(
            points[0][0],
            points[0][1],
            points[1][0],
            points[1][1],
            o,
            r,
            false,
        ));
    }
    ops
}

#[allow(clippy::too_many_arguments)]
fn compute_ellipse_points(
    increment: f64,
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    off: f64,
    overlap: f64,
    o: &Options,
    r: &mut Random,
) -> (Vec<Point>, Vec<Point>) {
    let (mut core, mut all) = (vec![], vec![]);
    if o.roughness == 0. {
        let increment = increment / 4.;
        all.push([cx + rx * (-increment).cos(), cy + ry * (-increment).sin()]);
        let mut a = 0.;
        while a <= PI * 2. {
            let p = [cx + rx * a.cos(), cy + ry * a.sin()];
            core.push(p);
            all.push(p);
            a += increment;
        }
        all.push([cx + rx * 0f64.cos(), cy + ry * 0f64.sin()]);
        all.push([cx + rx * increment.cos(), cy + ry * increment.sin()]);
    } else {
        let rad = offset_opt(0.5, o, r, 1.) - (PI / 2.);
        let pt = |k: f64, a: f64, r: &mut Random| {
            let x = offset_opt(off, o, r, 1.) + cx + k * rx * a.cos();
            [x, offset_opt(off, o, r, 1.) + cy + k * ry * a.sin()]
        };
        all.push(pt(0.9, rad - increment, r));
        let end = PI * 2. + rad - 0.01;
        let mut a = rad;
        while a < end {
            let p = pt(1., a, r);
            core.push(p);
            all.push(p);
            a += increment;
        }
        all.push(pt(1., rad + PI * 2. + overlap * 0.5, r));
        all.push(pt(0.98, rad + overlap, r));
        all.push(pt(0.9, rad + overlap * 0.5, r));
    }
    (all, core)
}

#[allow(clippy::too_many_arguments)]
fn arc_ops(
    increment: f64,
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    strt: f64,
    stp: f64,
    off: f64,
    o: &Options,
    r: &mut Random,
) -> Vec<Op> {
    let rad = strt + offset_opt(0.1, o, r, 1.);
    let mut points = vec![];
    let pt = |k: f64, a: f64, r: &mut Random| {
        let x = offset_opt(off, o, r, 1.) + cx + k * rx * a.cos();
        [x, offset_opt(off, o, r, 1.) + cy + k * ry * a.sin()]
    };
    points.push(pt(0.9, rad - increment, r));
    let mut a = rad;
    while a <= stp {
        points.push(pt(1., a, r));
        a += increment;
    }
    points.push([cx + rx * stp.cos(), cy + ry * stp.sin()]);
    points.push([cx + rx * stp.cos(), cy + ry * stp.sin()]);
    curve_ops(&points, o, r)
}

#[allow(clippy::too_many_arguments)]
fn bezier_to(
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    x: f64,
    y: f64,
    cur: Point,
    o: &Options,
    r: &mut Random,
) -> Vec<Op> {
    let mut ops = vec![];
    let m = if o.max_randomness_offset != 0. {
        o.max_randomness_offset
    } else {
        1.
    };
    let ros = [m, m + 0.3];
    let iterations = if o.disable_multi_stroke { 1 } else { 2 };
    let pv = o.preserve_vertices;
    for (i, &ro) in ros.iter().enumerate().take(iterations) {
        if i == 0 {
            ops.push(Op::Move(cur));
        } else {
            let mx = cur[0] + if pv { 0. } else { offset_opt(ros[0], o, r, 1.) };
            let my = cur[1] + if pv { 0. } else { offset_opt(ros[0], o, r, 1.) };
            ops.push(Op::Move([mx, my]));
        }
        let f = if pv {
            [x, y]
        } else {
            let fx = x + offset_opt(ro, o, r, 1.);
            [fx, y + offset_opt(ro, o, r, 1.)]
        };
        let a = x1 + offset_opt(ro, o, r, 1.);
        let b = y1 + offset_opt(ro, o, r, 1.);
        let c = x2 + offset_opt(ro, o, r, 1.);
        let d = y2 + offset_opt(ro, o, r, 1.);
        ops.push(Op::BCurveTo([a, b], [c, d], f));
    }
    ops
}
