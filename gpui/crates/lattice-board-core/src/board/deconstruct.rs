// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Elements taken apart into segments and cubics for hit tests. Port of the
//! shape half of Excalidraw `element/src/utils.ts` @ 3a317b5
//! (`deconstructLinearOrFreeDrawElement`, `getLinearElementPathSegments`,
//! `deconstructRectanguloidElement`, `getDiamondBaseCorners`,
//! `deconstructDiamondElement`, `getAllMidpoints`). The midpoint snapping and
//! fixed-point projection of the same file need binding and come with it.
//! Upstream caches results per version; callers cache here.

use super::bounds::{element_center_point, get_diamond_points};
use super::math::*;
use super::shape::{Op, generate_linear_collision_shape};
use super::sticky::get_sticky_note_corner_radius;
use super::types::{Element, ElementType};
use super::utils::{ElementsMap, get_corner_radius};

/// Segments and cubics.
pub type ElementParts = (Vec<Segment>, Vec<Curve>);

/// A piece of a linear element's path.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LinearPathSegment {
    Line(Segment),
    Curve(Curve),
}

impl LinearPathSegment {
    pub fn length(&self) -> f64 {
        match *self {
            LinearPathSegment::Line(s) => point_distance(s[0], s[1]),
            LinearPathSegment::Curve(c) => curve_length(c),
        }
    }
    /// Parameter (0-1) of the closest point and its distance.
    pub fn closest_parameter(&self, p: Point) -> (f64, f64) {
        match *self {
            LinearPathSegment::Curve(c) => {
                let t = curve_closest_parameter(c, p, 1e-3);
                (t, point_distance(p, bezier_equation(c, t)))
            }
            LinearPathSegment::Line(s) => {
                let t = line_segment_closest_parameter(p, s);
                (t, point_distance(p, line_segment_point_at(s, t)))
            }
        }
    }
    pub fn length_at_parameter(&self, t: f64, length: f64) -> f64 {
        match *self {
            LinearPathSegment::Curve(c) => curve_length_at_parameter(c, t),
            LinearPathSegment::Line(_) => t * length,
        }
    }
    pub fn point_at_length(&self, fraction: f64, length: f64) -> Point {
        match *self {
            LinearPathSegment::Curve(c) => curve_point_at_length(c, fraction, Some(length)),
            LinearPathSegment::Line(s) => line_segment_point_at(s, fraction),
        }
    }
}

/// `deconstructLinearOrFreeDrawElement`: the **rotated** parts of a line,
/// arrow or freedraw outline, in scene coordinates.
pub fn deconstruct_linear_or_freedraw_element(e: &Element, map: &dyn ElementsMap) -> ElementParts {
    let ops = generate_linear_collision_shape(e, map);
    let (mut lines, mut curves) = (vec![], vec![]);
    let g = |p: Point| [e.x + p[0], e.y + p[1]];
    for i in 0..ops.len() {
        let Some(prev) = i.checked_sub(1).map(|j| ops[j].end()) else {
            continue;
        };
        match ops[i] {
            Op::Move(_) => {}
            Op::LineTo(p) => lines.push([g(prev), g(p)]),
            Op::BCurveTo(a, b, c) => curves.push([g(prev), g(a), g(b), g(c)]),
        }
    }
    (lines, curves)
}

/// `getLinearElementPathSegments`: elbow arrows as their unrounded route.
pub fn get_linear_element_path_segments(
    e: &Element,
    map: &dyn ElementsMap,
) -> Vec<LinearPathSegment> {
    if e.is_elbow_arrow() {
        let p = e.points().unwrap_or(&[]);
        return p
            .windows(2)
            .map(|w| {
                LinearPathSegment::Line([
                    [e.x + w[0][0], e.y + w[0][1]],
                    [e.x + w[1][0], e.y + w[1][1]],
                ])
            })
            .collect();
    }
    let (lines, curves) = deconstruct_linear_or_freedraw_element(e, map);
    if !curves.is_empty() {
        curves.into_iter().map(LinearPathSegment::Curve).collect()
    } else {
        lines.into_iter().map(LinearPathSegment::Line).collect()
    }
}

fn offset_corners(base: [Curve; 4], offset: f64) -> Vec<Vec<Curve>> {
    if offset > 0. {
        base.iter()
            .map(|&c| {
                curve_catmull_rom_cubic_approx_points(&curve_offset_points(c, offset, 50), 0.5)
                    .unwrap_or_default()
            })
            .collect()
    } else {
        base.iter().map(|&c| vec![c]).collect()
    }
}

fn sides_and_corners(corners: Vec<Vec<Curve>>) -> ElementParts {
    let last = |i: usize| corners[i][corners[i].len() - 1][3];
    let sides = vec![
        [last(0), corners[1][0][0]],
        [last(1), corners[2][0][0]],
        [last(2), corners[3][0][0]],
        [last(3), corners[0][0][0]],
    ];
    (sides, corners.into_iter().flatten().collect())
}

/// `deconstructRectanguloidElement`: **unrotated** sides and corner cubics,
/// grown by `offset`.
pub fn deconstruct_rectanguloid_element(e: &Element, offset: f64) -> ElementParts {
    let mut radius = if e.ty() == ElementType::StickyNote {
        get_sticky_note_corner_radius(e)
    } else {
        get_corner_radius(e.width.min(e.height), e)
    };
    if radius == 0. {
        radius = 0.01;
    }
    let r = [[e.x, e.y], [e.x + e.width, e.y + e.height]];
    let top = [[r[0][0] + radius, r[0][1]], [r[1][0] - radius, r[0][1]]];
    let right = [[r[1][0], r[0][1] + radius], [r[1][0], r[1][1] - radius]];
    let bottom = [[r[0][0] + radius, r[1][1]], [r[1][0] - radius, r[1][1]]];
    let left = [[r[0][0], r[1][1] - radius], [r[0][0], r[0][1] + radius]];
    let k =
        |a: Point, cx: f64, cy: f64| [a[0] + 2. / 3. * (cx - a[0]), a[1] + 2. / 3. * (cy - a[1])];
    let base = [
        [
            left[1],
            k(left[1], r[0][0], r[0][1]),
            k(top[0], r[0][0], r[0][1]),
            top[0],
        ],
        [
            top[1],
            k(top[1], r[1][0], r[0][1]),
            k(right[0], r[1][0], r[0][1]),
            right[0],
        ],
        [
            right[1],
            k(right[1], r[1][0], r[1][1]),
            k(bottom[1], r[1][0], r[1][1]),
            bottom[1],
        ],
        [
            bottom[0],
            k(bottom[0], r[0][0], r[1][1]),
            k(left[0], r[0][0], r[1][1]),
            left[0],
        ],
    ];
    sides_and_corners(offset_corners(base, offset))
}

/// `getDiamondBaseCorners`: right, bottom, left, top corner cubics.
pub fn get_diamond_base_corners(e: &Element) -> [Curve; 4] {
    let [tx, ty, rx, ry, bx, by, lx, ly] = get_diamond_points(e);
    let v = if e.roundness.is_some() {
        get_corner_radius((tx - lx).abs(), e)
    } else {
        (tx - lx) * 0.01
    };
    let h = if e.roundness.is_some() {
        get_corner_radius((ry - ty).abs(), e)
    } else {
        (ry - ty) * 0.01
    };
    let (top, right, bottom, left) = (
        [e.x + tx, e.y + ty],
        [e.x + rx, e.y + ry],
        [e.x + bx, e.y + by],
        [e.x + lx, e.y + ly],
    );
    [
        [
            [right[0] - v, right[1] - h],
            right,
            right,
            [right[0] - v, right[1] + h],
        ],
        [
            [bottom[0] + v, bottom[1] - h],
            bottom,
            bottom,
            [bottom[0] - v, bottom[1] - h],
        ],
        [
            [left[0] + v, left[1] + h],
            left,
            left,
            [left[0] + v, left[1] - h],
        ],
        [[top[0] - v, top[1] + h], top, top, [top[0] + v, top[1] + h]],
    ]
}

/// `deconstructDiamondElement`: **unrotated** sides and corner cubics.
pub fn deconstruct_diamond_element(e: &Element, offset: f64) -> ElementParts {
    sides_and_corners(offset_corners(get_diamond_base_corners(e), offset))
}

/// `getAllMidpoints`: right, bottom, left, top midpoints of the outline.
pub fn get_all_midpoints(e: &Element, map: &dyn ElementsMap) -> [Point; 4] {
    let c = element_center_point(e, map, 0., 0.);
    if e.ty() == ElementType::Diamond {
        return get_diamond_base_corners(e)
            .map(|k| point_rotate_rads(bezier_equation(k, 0.5), c, e.angle));
    }
    [
        [e.width, e.height / 2.],
        [e.width / 2., e.height],
        [0., e.height / 2.],
        [e.width / 2., 0.],
    ]
    .map(|[x, y]| point_rotate_rads([e.x + x, e.y + y], c, e.angle))
}
