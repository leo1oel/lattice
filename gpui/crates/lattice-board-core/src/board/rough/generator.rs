// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! rough.js `generator.js` (`RoughGenerator`): drawables from options. Each
//! call starts a fresh randomizer from `o.seed`, as rough.js's `_o` copy
//! does.

use super::curve::{curve_to_bezier, points_on_bezier_curves};
use super::path_data::{Seg, absolutize, normalize, parse_path, points_on_path};
use super::renderer::{
    self as rd, arc as arc_ops, curve as curve_set, ellipse_with_params, generate_ellipse_params,
    linear_path as linear_set, pattern_fill_arc, pattern_fill_polygons, solid_fill_polygon,
    svg_path,
};
use super::{Drawable, FillStyle, Op, OpSet, OpSetType, Options, Random, ShapeKind};
use crate::board::math::Point;

fn d(shape: ShapeKind, sets: Vec<OpSet>, o: &Options) -> Drawable {
    Drawable {
        shape,
        sets,
        options: o.clone(),
    }
}

fn has_fill(o: &Options) -> bool {
    o.fill.as_deref().is_some_and(|f| !f.is_empty())
}

pub fn line(x1: f64, y1: f64, x2: f64, y2: f64, o: &Options) -> Drawable {
    let mut r = Random::new(o.seed);
    d(
        ShapeKind::Line,
        vec![rd::line(x1, y1, x2, y2, o, &mut r)],
        o,
    )
}

pub fn rectangle(x: f64, y: f64, w: f64, h: f64, o: &Options) -> Drawable {
    let mut r = Random::new(o.seed);
    let mut paths = vec![];
    let outline = rd::rectangle(x, y, w, h, o, &mut r);
    if has_fill(o) {
        let mut points = vec![vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
        paths.push(if o.fill_style == FillStyle::Solid {
            solid_fill_polygon(&points, o, &mut r)
        } else {
            pattern_fill_polygons(&mut points, o, &mut r)
        });
    }
    if o.stroke.is_some() {
        paths.push(outline);
    }
    d(ShapeKind::Rectangle, paths, o)
}

pub fn ellipse(x: f64, y: f64, w: f64, h: f64, o: &Options) -> Drawable {
    let mut r = Random::new(o.seed);
    let mut paths = vec![];
    let params = generate_ellipse_params(w, h, o, &mut r);
    let (estimated, outline) = ellipse_with_params(x, y, o, &params, &mut r);
    if has_fill(o) {
        if o.fill_style == FillStyle::Solid {
            let mut shape = ellipse_with_params(x, y, o, &params, &mut r).1;
            shape.ty = OpSetType::FillPath;
            paths.push(shape);
        } else {
            paths.push(pattern_fill_polygons(&mut [estimated], o, &mut r));
        }
    }
    if o.stroke.is_some() {
        paths.push(outline);
    }
    d(ShapeKind::Ellipse, paths, o)
}

pub fn circle(x: f64, y: f64, diameter: f64, o: &Options) -> Drawable {
    Drawable {
        shape: ShapeKind::Circle,
        ..ellipse(x, y, diameter, diameter, o)
    }
}

pub fn linear_path(points: &[Point], o: &Options) -> Drawable {
    let mut r = Random::new(o.seed);
    d(
        ShapeKind::LinearPath,
        vec![linear_set(points, false, o, &mut r)],
        o,
    )
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
    o: &Options,
) -> Drawable {
    let mut r = Random::new(o.seed);
    let mut paths = vec![];
    let outline = arc_ops(x, y, w, h, start, stop, closed, true, o, &mut r);
    if closed && has_fill(o) {
        if o.fill_style == FillStyle::Solid {
            let fo = Options {
                disable_multi_stroke: true,
                ..o.clone()
            };
            let mut shape = arc_ops(x, y, w, h, start, stop, true, false, &fo, &mut r);
            shape.ty = OpSetType::FillPath;
            paths.push(shape);
        } else {
            paths.push(pattern_fill_arc(x, y, w, h, start, stop, o, &mut r));
        }
    }
    if o.stroke.is_some() {
        paths.push(outline);
    }
    d(ShapeKind::Arc, paths, o)
}

/// The options rough.js fills a curve or path with solidly.
fn solid_fill_options(o: &Options) -> Options {
    Options {
        disable_multi_stroke: true,
        roughness: if o.roughness != 0. {
            o.roughness + o.fill_shape_roughness_gain
        } else {
            0.
        },
        ..o.clone()
    }
}

pub fn curve(points: &[Point], o: &Options) -> Drawable {
    let mut r = Random::new(o.seed);
    let mut paths = vec![];
    let outline = curve_set(points, o, &mut r);
    if has_fill(o) && o.fill.as_deref() != Some("none") && points.len() >= 3 {
        if o.fill_style == FillStyle::Solid {
            let fill = curve_set(points, &solid_fill_options(o), &mut r);
            paths.push(OpSet {
                ty: OpSetType::FillPath,
                ops: merged_shape(fill.ops),
            });
        } else {
            let poly = points_on_bezier_curves(
                &curve_to_bezier(points),
                10.,
                Some((1. + o.roughness) / 2.),
            );
            paths.push(pattern_fill_polygons(&mut [poly], o, &mut r));
        }
    }
    if o.stroke.is_some() {
        paths.push(outline);
    }
    d(ShapeKind::Curve, paths, o)
}

pub fn polygon(points: &[Point], o: &Options) -> Drawable {
    let mut r = Random::new(o.seed);
    let mut paths = vec![];
    let outline = linear_set(points, true, o, &mut r);
    if has_fill(o) {
        let mut polys = vec![points.to_vec()];
        paths.push(if o.fill_style == FillStyle::Solid {
            solid_fill_polygon(&polys, o, &mut r)
        } else {
            pattern_fill_polygons(&mut polys, o, &mut r)
        });
    }
    if o.stroke.is_some() {
        paths.push(outline);
    }
    d(ShapeKind::Polygon, paths, o)
}

/// `path(d)` for an SVG path string.
pub fn path(data: &str, o: &Options) -> Drawable {
    if data.is_empty() {
        return d(ShapeKind::Path, vec![], o);
    }
    let data = data.replace('\n', " ").replace("- ", "-");
    path_segs(&parse_path(&data), o)
}

/// `path(d)` for parsed segments (absolutized and normalized here).
pub fn path_segs(segs: &[Seg], o: &Options) -> Drawable {
    if segs.is_empty() {
        return d(ShapeKind::Path, vec![], o);
    }
    let segs = normalize(&absolutize(segs));
    let mut r = Random::new(o.seed);
    let mut paths = vec![];
    let fill = has_fill(o) && !matches!(o.fill.as_deref(), Some("transparent" | "none"));
    let simplified = o.simplification.is_some_and(|s| s != 0. && s < 1.);
    let distance = if simplified {
        4. - 4. * o.simplification.unwrap_or(1.)
    } else {
        (1. + o.roughness) / 2.
    };
    let mut sets = points_on_path(&segs, 1., Some(distance));
    let shape = svg_path(&segs, o, &mut r);
    if fill {
        if o.fill_style == FillStyle::Solid {
            if sets.len() == 1 {
                let f = svg_path(&segs, &solid_fill_options(o), &mut r);
                paths.push(OpSet {
                    ty: OpSetType::FillPath,
                    ops: merged_shape(f.ops),
                });
            } else {
                paths.push(solid_fill_polygon(&sets, o, &mut r));
            }
        } else {
            paths.push(pattern_fill_polygons(&mut sets, o, &mut r));
        }
    }
    if o.stroke.is_some() {
        if simplified {
            for s in &sets {
                paths.push(linear_set(s, false, o, &mut r));
            }
        } else {
            paths.push(shape);
        }
    }
    d(ShapeKind::Path, paths, o)
}

/// `_mergedShape`: one move, at the start.
fn merged_shape(ops: Vec<Op>) -> Vec<Op> {
    ops.into_iter()
        .enumerate()
        .filter(|(i, o)| *i == 0 || !matches!(o, Op::Move(_)))
        .map(|(_, o)| o)
        .collect()
}
