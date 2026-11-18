// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! rough.js `fillers/*.js` (hachure, cross-hatch, zigzag, zigzag-line, dots,
//! dashed; `solid` is the renderer's `solidFillPolygon`) and hachure-fill
//! 0.5.2's `hachureLines`, the scan-line algorithm they share.

use super::renderer::{double_line_fill_ops, ellipse};
use super::{FillStyle, Op, OpSet, OpSetType, Options, Random};
use crate::board::math::{Point, Segment, js_round};

/// `getFiller(o).fillPolygons(polygonList, o)` (solid falls back to
/// hachure, as there).
pub fn fill_polygons(polygons: &mut [Vec<Point>], o: &Options, r: &mut Random) -> OpSet {
    let ops = match o.fill_style {
        FillStyle::CrossHatch => {
            let mut ops = hachure_ops(polygons, o, r);
            let o2 = Options {
                hachure_angle: o.hachure_angle + 90.,
                ..o.clone()
            };
            ops.extend(hachure_ops(polygons, &o2, r));
            ops
        }
        FillStyle::Zigzag => zigzag(polygons, o, r),
        FillStyle::ZigzagLine => zigzag_line(polygons, o, r),
        FillStyle::Dots => dots(polygons, o, r),
        FillStyle::Dashed => dashed(polygons, o, r),
        FillStyle::Hachure | FillStyle::Solid => hachure_ops(polygons, o, r),
    };
    OpSet {
        ty: OpSetType::FillSketch,
        ops,
    }
}

fn line_length(l: &Segment) -> f64 {
    ((l[0][0] - l[1][0]).powi(2) + (l[0][1] - l[1][1]).powi(2)).sqrt()
}

fn render_lines(lines: &[Segment], o: &Options, r: &mut Random) -> Vec<Op> {
    let mut ops = vec![];
    for l in lines {
        ops.extend(double_line_fill_ops(
            l[0][0], l[0][1], l[1][0], l[1][1], o, r,
        ));
    }
    ops
}

fn hachure_ops(polygons: &mut [Vec<Point>], o: &Options, r: &mut Random) -> Vec<Op> {
    let lines = polygon_hachure_lines(polygons, o, r);
    render_lines(&lines, o, r)
}

fn gap_of(o: &Options) -> f64 {
    (if o.hachure_gap < 0. {
        o.stroke_width * 4.
    } else {
        o.hachure_gap
    })
    .max(0.1)
}

/// `polygonHachureLines`.
pub fn polygon_hachure_lines(
    polygons: &mut [Vec<Point>],
    o: &Options,
    r: &mut Random,
) -> Vec<Segment> {
    let angle = o.hachure_angle + 90.;
    let gap = gap_of(o);
    let mut skip = 1.;
    if o.roughness >= 1. {
        let v = if r.started() { r.next() } else { 0. };
        let v = if v != 0. { v } else { r.math_random() };
        if v > 0.7 {
            skip = gap;
        }
    }
    hachure_lines(polygons, gap, angle, if skip != 0. { skip } else { 1. })
}

fn rotate_points(points: &mut [Point], deg: f64) {
    let a = (std::f64::consts::PI / 180.) * deg;
    let (cos, sin) = (a.cos(), a.sin());
    for p in points {
        let [x, y] = *p;
        *p = [
            ((x - 0.) * cos) - ((y - 0.) * sin) + 0.,
            ((x - 0.) * sin) + ((y - 0.) * cos) + 0.,
        ];
    }
}

/// hachure-fill `hachureLines`: scan lines `gap` apart across the polygons
/// (even-odd) at `angle` degrees, every `step` px.
pub fn hachure_lines(polygons: &mut [Vec<Point>], gap: f64, angle: f64, step: f64) -> Vec<Segment> {
    let gap = gap.max(0.1);
    if angle != 0. {
        for p in polygons.iter_mut() {
            rotate_points(p, angle)
        }
    }
    let mut lines = straight_hachure_lines(polygons, gap, step);
    if angle != 0. {
        for p in polygons.iter_mut() {
            rotate_points(p, -angle)
        }
        for l in lines.iter_mut() {
            rotate_points(l, -angle)
        }
    }
    lines
}

struct Edge {
    ymin: f64,
    ymax: f64,
    x: f64,
    islope: f64,
}

fn straight_hachure_lines(polygons: &[Vec<Point>], gap: f64, step: f64) -> Vec<Segment> {
    let mut edges: Vec<Edge> = vec![];
    for poly in polygons {
        if poly.is_empty() {
            continue;
        }
        let mut v = poly.clone();
        if v[0] != v[v.len() - 1] {
            v.push(v[0]);
        }
        if v.len() <= 2 {
            continue;
        }
        for w in v.windows(2) {
            let (p1, p2) = (w[0], w[1]);
            if p1[1] != p2[1] {
                let ymin = p1[1].min(p2[1]);
                edges.push(Edge {
                    ymin,
                    ymax: p1[1].max(p2[1]),
                    x: if ymin == p1[1] { p1[0] } else { p2[0] },
                    islope: (p2[0] - p1[0]) / (p2[1] - p1[1]),
                });
            }
        }
    }
    use std::cmp::Ordering::*;
    edges.sort_by(|a, b| {
        if a.ymin < b.ymin {
            return Less;
        }
        if a.ymin > b.ymin {
            return Greater;
        }
        if a.x < b.x {
            return Less;
        }
        if a.x > b.x {
            return Greater;
        }
        if a.ymax == b.ymax {
            return Equal;
        }
        if a.ymax < b.ymax { Less } else { Greater }
    });
    let mut lines = vec![];
    if edges.is_empty() {
        return lines;
    }
    let mut edges: std::collections::VecDeque<Edge> = edges.into();
    let mut active: Vec<Edge> = vec![];
    let mut y = edges[0].ymin;
    let mut iteration = 0f64;
    while !active.is_empty() || !edges.is_empty() {
        while edges.front().is_some_and(|e| e.ymin <= y) {
            active.push(edges.pop_front().unwrap());
        }
        active.retain(|e| e.ymax > y);
        active.sort_by(|a, b| {
            if a.x == b.x {
                Equal
            } else if a.x < b.x {
                Less
            } else {
                Greater
            }
        });
        if (step != 1. || iteration % gap == 0.) && active.len() > 1 {
            let mut i = 0;
            while i + 1 < active.len() {
                lines.push([[js_round(active[i].x), y], [js_round(active[i + 1].x), y]]);
                i += 2;
            }
        }
        y += step;
        for e in active.iter_mut() {
            e.x += step * e.islope;
        }
        iteration += 1.;
    }
    lines
}

fn zigzag(polygons: &mut [Vec<Point>], o: &Options, r: &mut Random) -> Vec<Op> {
    let gap = gap_of(o);
    let o2 = Options {
        hachure_gap: gap,
        ..o.clone()
    };
    let lines = polygon_hachure_lines(polygons, &o2, r);
    let a = (std::f64::consts::PI / 180.) * o.hachure_angle;
    let (dgx, dgy) = (gap * 0.5 * a.cos(), gap * 0.5 * a.sin());
    let mut zz = vec![];
    for [p1, p2] in lines {
        if line_length(&[p1, p2]) != 0. {
            zz.push([[p1[0] - dgx, p1[1] + dgy], p2]);
            zz.push([[p1[0] + dgx, p1[1] - dgy], p2]);
        }
    }
    render_lines(&zz, o, r)
}

/// A line's ends left to right and its slope angle (`atan`).
fn ordered(l: &Segment) -> (Point, Point, f64) {
    let (p1, p2) = if l[0][0] > l[1][0] {
        (l[1], l[0])
    } else {
        (l[0], l[1])
    };
    (p1, p2, ((p2[1] - p1[1]) / (p2[0] - p1[0])).atan())
}

fn zigzag_line(polygons: &mut [Vec<Point>], o: &Options, r: &mut Random) -> Vec<Op> {
    let gap = if o.hachure_gap < 0. {
        o.stroke_width * 4.
    } else {
        o.hachure_gap
    };
    let zo = if o.zigzag_offset < 0. {
        gap
    } else {
        o.zigzag_offset
    };
    let o = Options {
        hachure_gap: gap + zo,
        ..o.clone()
    };
    let lines = polygon_hachure_lines(polygons, &o, r);
    let mut ops = vec![];
    for l in &lines {
        let length = line_length(l);
        let count = js_round(length / (2. * zo));
        let (p1, _, alpha) = ordered(l);
        let mut i = 0.;
        while i < count {
            let lstart = i * 2. * zo;
            let lend = (i + 1.) * 2. * zo;
            let dz = (2. * zo.powi(2)).sqrt();
            let start = [p1[0] + (lstart * alpha.cos()), p1[1] + lstart * alpha.sin()];
            let end = [p1[0] + (lend * alpha.cos()), p1[1] + (lend * alpha.sin())];
            let mid = [
                start[0] + dz * (alpha + std::f64::consts::PI / 4.).cos(),
                start[1] + dz * (alpha + std::f64::consts::PI / 4.).sin(),
            ];
            ops.extend(double_line_fill_ops(
                start[0], start[1], mid[0], mid[1], &o, r,
            ));
            ops.extend(double_line_fill_ops(mid[0], mid[1], end[0], end[1], &o, r));
            i += 1.;
        }
    }
    ops
}

fn dots(polygons: &mut [Vec<Point>], o: &Options, r: &mut Random) -> Vec<Op> {
    let o = Options {
        hachure_angle: 0.,
        ..o.clone()
    };
    let lines = polygon_hachure_lines(polygons, &o, r);
    let gap = gap_of(&o);
    let fweight = o.fill_weight_or_default();
    let ro = gap / 4.;
    let mut ops = vec![];
    for l in &lines {
        let length = line_length(l);
        let count = (length / gap).ceil() - 1.;
        let off = length - (count * gap);
        let x = ((l[0][0] + l[1][0]) / 2.) - (gap / 4.);
        let min_y = l[0][1].min(l[1][1]);
        let mut i = 0.;
        while i < count {
            let y = min_y + off + (i * gap);
            let cx = (x - ro) + r.math_random() * 2. * ro;
            let cy = (y - ro) + r.math_random() * 2. * ro;
            ops.extend(ellipse(cx, cy, fweight, fweight, &o, r).ops);
            i += 1.;
        }
    }
    ops
}

fn dashed(polygons: &mut [Vec<Point>], o: &Options, r: &mut Random) -> Vec<Op> {
    let lines = polygon_hachure_lines(polygons, o, r);
    let dflt = if o.hachure_gap < 0. {
        o.stroke_width * 4.
    } else {
        o.hachure_gap
    };
    let offset = if o.dash_offset < 0. {
        dflt
    } else {
        o.dash_offset
    };
    let gap = if o.dash_gap < 0. { dflt } else { o.dash_gap };
    let mut ops = vec![];
    for l in &lines {
        let length = line_length(l);
        let count = (length / (offset + gap)).floor();
        let start_offset = (length + gap - (count * (offset + gap))) / 2.;
        let (p1, _, alpha) = ordered(l);
        let mut i = 0.;
        while i < count {
            let lstart = i * (offset + gap);
            let lend = lstart + offset;
            let start = [
                p1[0] + (lstart * alpha.cos()) + (start_offset * alpha.cos()),
                p1[1] + lstart * alpha.sin() + (start_offset * alpha.sin()),
            ];
            let end = [
                p1[0] + (lend * alpha.cos()) + (start_offset * alpha.cos()),
                p1[1] + (lend * alpha.sin()) + (start_offset * alpha.sin()),
            ];
            ops.extend(double_line_fill_ops(
                start[0], start[1], end[0], end[1], o, r,
            ));
            i += 1.;
        }
    }
    ops
}
