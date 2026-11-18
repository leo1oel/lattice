// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Cardinal directions for binding and elbow routing. Port of Excalidraw
//! `element/src/heading.ts` @ 3a317b5. Upstream's dev-only invariants on
//! diamonds (zero size, point at the center) are left out.

use super::bounds::{Bounds, get_center_for_bounds};
use super::math::*;
use super::types::{Element, ElementType};

/// One of the four unit vectors below.
pub type Heading = [f64; 2];
pub const HEADING_RIGHT: Heading = [1., 0.];
pub const HEADING_DOWN: Heading = [0., 1.];
pub const HEADING_LEFT: Heading = [-1., 0.];
pub const HEADING_UP: Heading = [0., -1.];

pub fn vector_to_heading([x, y]: Vector) -> Heading {
    let (ax, ay) = (x.abs(), y.abs());
    if x > ay {
        HEADING_RIGHT
    } else if x <= -ay {
        HEADING_LEFT
    } else if y > ax {
        HEADING_DOWN
    } else {
        HEADING_UP
    }
}
pub fn heading_for_point(p: Point, o: Point) -> Heading {
    vector_to_heading(vector_from_point(p, o))
}
pub fn heading_for_point_is_horizontal(p: Point, o: Point) -> bool {
    heading_is_horizontal(heading_for_point(p, o))
}
pub fn compare_heading(a: Heading, b: Heading) -> bool {
    a[0] == b[0] && a[1] == b[1]
}
pub fn heading_is_horizontal(a: Heading) -> bool {
    compare_heading(a, HEADING_RIGHT) || compare_heading(a, HEADING_LEFT)
}
pub fn heading_is_vertical(a: Heading) -> bool {
    !heading_is_horizontal(a)
}
pub fn flip_heading(h: Heading) -> Heading {
    h.map(|v| {
        if v == 0. {
            0.
        } else if v > 0. {
            -1.
        } else {
            1.
        }
    })
}

fn heading_for_point_from_diamond_element(e: &Element, aabb: Bounds, p: Point) -> Heading {
    let mid = get_center_for_bounds(aabb);
    // rounded elements tolerance
    const SHRINK: f64 = 0.95;
    let at = |x: f64, y: f64| {
        point_from_vector(
            vector_scale(
                vector_from_point(point_rotate_rads([x, y], mid, e.angle), mid),
                SHRINK,
            ),
            mid,
        )
    };
    let top = at(e.x + e.width / 2., e.y);
    let right = at(e.x + e.width, e.y + e.height / 2.);
    let bottom = at(e.x + e.width / 2., e.y + e.height);
    let left = at(e.x, e.y + e.height / 2.);
    let cross = |a: Point, b: Point, c: Point| {
        vector_cross(vector_from_point(p, a), vector_from_point(b, c))
    };
    // corners
    if cross(top, top, right) <= 0. && cross(top, top, left) > 0. {
        return heading_for_point(top, mid);
    }
    if cross(right, right, bottom) <= 0. && cross(right, right, top) > 0. {
        return heading_for_point(right, mid);
    }
    if cross(bottom, bottom, left) <= 0. && cross(bottom, bottom, right) > 0. {
        return heading_for_point(bottom, mid);
    }
    if cross(left, left, top) <= 0. && cross(left, left, bottom) > 0. {
        return heading_for_point(left, mid);
    }
    // sides
    let side = |a: Point, b: Point| {
        vector_cross(vector_from_point(p, mid), vector_from_point(a, mid)) <= 0.
            && vector_cross(vector_from_point(p, mid), vector_from_point(b, mid)) > 0.
    };
    let wide = e.width > e.height;
    let q = if side(top, right) {
        if wide { top } else { right }
    } else if side(right, bottom) {
        if wide { bottom } else { right }
    } else if side(bottom, left) {
        if wide { bottom } else { left }
    } else if wide {
        top
    } else {
        left
    };
    heading_for_point(q, mid)
}

/// `headingForPointFromElement`: which side of `e` (its rotated `aabb`) the
/// point is on, by four search cones around the center.
pub fn heading_for_point_from_element(e: &Element, aabb: Bounds, p: Point) -> Heading {
    const SEARCH_CONE_MULTIPLIER: f64 = 2.;
    let mid = get_center_for_bounds(aabb);
    if e.ty() == ElementType::Diamond {
        return heading_for_point_from_diamond_element(e, aabb, p);
    }
    let s = |x: f64, y: f64| point_scale_from_origin([x, y], mid, SEARCH_CONE_MULTIPLIER);
    let (tl, tr, bl, br) = (
        s(aabb[0], aabb[1]),
        s(aabb[2], aabb[1]),
        s(aabb[0], aabb[3]),
        s(aabb[2], aabb[3]),
    );
    if triangle_includes_point([tl, tr, mid], p) {
        HEADING_UP
    } else if triangle_includes_point([tr, br, mid], p) {
        HEADING_RIGHT
    } else if triangle_includes_point([br, bl, mid], p) {
        HEADING_DOWN
    } else {
        HEADING_LEFT
    }
}
