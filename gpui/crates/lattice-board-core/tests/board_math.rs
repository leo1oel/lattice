// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/math/tests/*.test.ts` @ 3a317b5 (curve,
//! ellipse, line, point, polygon, range, segment). Same inputs and expected
//! values; pca and vector are not ported.

use lattice_board_core::board::math::*;

/// Jest `toBeCloseTo(e, digits)`: |a - e| < 10^-digits / 2.
fn close(a: f64, e: f64, digits: i32) {
    assert!(
        (a - e).abs() < 10f64.powi(-digits) / 2.,
        "{a} not close to {e} ({digits} digits)"
    );
}
/// Upstream `toCloselyEqualPoints` with no precision: `Math.pow(10, 2)`, i.e.
/// within 100 (sic). Indexes `received` by `expected`, so a shorter one fails.
fn close_pts(r: &[Point], e: &[Point]) {
    assert!(r.len() >= e.len(), "{r:?} vs {e:?}");
    for (r, e) in r.iter().zip(e) {
        assert!(
            (r[0] - e[0]).abs() < 100. && (r[1] - e[1]).abs() < 100.,
            "{r:?} vs {e:?}"
        );
    }
}
fn cis(c: Curve, l: Segment) -> Vec<Point> {
    curve_intersect_line_segment(c, l, 1e-2, 4)
}

// curve.test.ts

#[test]
fn curve_intersect_same_control_points() {
    close_pts(
        &cis(
            [[100., 0.], [100., 100.], [100., 100.], [0., 100.]],
            [[0., 0.], [200., 200.]],
        ),
        &[[87.5, 87.5]],
    );
}
#[test]
fn curve_intersect_different_control_points() {
    close_pts(
        &cis(
            [[100., 0.], [100., 60.], [60., 100.], [0., 100.]],
            [[0., 0.], [200., 200.]],
        ),
        &[[72.5, 72.5]],
    );
}
#[test]
fn curve_intersect_sliced_at_3_points() {
    close_pts(
        &cis(
            [[-50., -50.], [10., -50.], [10., 50.], [50., 50.]],
            [[10., -60.], [10., 60.]],
        ),
        &[[9.99, 5.05]],
    );
}
#[test]
fn curve_intersect_overly_precise_determinant() {
    let c = [
        [41.028864759926016, 12.226249068355052],
        [41.028864759926016, 33.55958240168839],
        [30.362198093259348, 44.22624906835505],
        [9.028864759926016, 44.22624906835505],
    ];
    let l = [
        [-82.30963544324186, -41.19949363038283],
        [188.2149592542487, 134.75505940984908],
    ];
    close_pts(&cis(c, l), &[[34.4, 34.71]]);
}
#[test]
fn curve_closest_point_found() {
    let c = [[-50., -50.], [10., -50.], [10., 50.], [50., 50.]];
    close_pts(
        &[bezier_equation(
            c,
            curve_closest_parameter(c, [0., 0.], 1e-3),
        )],
        &[[5.965462100367372, -3.04104878946646]],
    );
}
#[test]
fn curve_point_shortest_distance() {
    let c = [[-50., -50.], [10., -50.], [10., 50.], [50., 50.]];
    close(
        curve_point_distance(c, [0., 0.], 1e-3),
        6.695873043213627,
        2,
    );
}

// ellipse.test.ts

#[test]
fn point_on_ellipse() {
    let t = ellipse([1., 2.], 2., 1.);
    for p in [[1., 3.], [1., 1.], [3., 2.], [-1., 2.]] {
        assert!(ellipse_touches_point(p, t, PRECISION));
    }
    assert!(ellipse_touches_point([-0.4, 2.7], t, 0.1));
    assert!(ellipse_touches_point([-0.4, 2.71], t, 0.01));
    assert!(ellipse_touches_point([2.4, 2.7], t, 0.1));
    assert!(ellipse_touches_point([2.4, 2.71], t, 0.01));
    assert!(ellipse_touches_point([2., 1.14], t, 0.1));
    assert!(ellipse_touches_point([2., 1.14], t, 0.01));
    assert!(ellipse_touches_point([0., 1.14], t, 0.1));
    assert!(ellipse_touches_point([0., 1.14], t, 0.01));
    assert!(!ellipse_touches_point([0., 2.8], t, PRECISION));
    assert!(!ellipse_touches_point([2., 1.2], t, PRECISION));
}
#[test]
fn point_in_ellipse() {
    let t = ellipse([0., 0.], 2., 1.);
    for p in [[0., 1.], [0., -1.], [2., 0.], [-2., 0.]] {
        assert!(ellipse_includes_point(p, t));
    }
    assert!(ellipse_includes_point([-1., 0.8], t));
    assert!(ellipse_includes_point([1., -0.8], t));
    assert!(ellipse_includes_point([2., 0.], t));
    assert!(!ellipse_includes_point([-1., 1.], t));
    assert!(!ellipse_includes_point([-1.4, 0.8], t));
}
#[test]
fn ellipse_distance_circle_center() {
    let c = ellipse([0., 0.], 100., 100.);
    assert_eq!(ellipse_distance_from_point([0., 0.], c), 100.);
    assert_eq!(ellipse_distance_from_point([1., 0.], c), 99.);
    assert_eq!(ellipse_distance_from_point([30., 40.], c), 50.);
}
#[test]
fn ellipse_distance_axes_non_circular() {
    let w = ellipse([0., 0.], 200., 50.);
    close(ellipse_distance_from_point([0., 0.], w), 50., 2);
    close(ellipse_distance_from_point([10., 0.], w), 49.93, 1);
    close(ellipse_distance_from_point([-150., 0.], w), 31.62, 1);
    close(ellipse_distance_from_point([0., 10.], w), 40., 2);
    close(ellipse_distance_from_point([250., 0.], w), 50., 2);
}
#[test]
fn ellipse_segment_detects_outside() {
    let e = ellipse([0., 0.], 2., 2.);
    assert_eq!(
        ellipse_segment_intercept_points(e, [[-100., 0.], [-10., 0.]]),
        Vec::<Point>::new()
    );
    assert_eq!(
        ellipse_segment_intercept_points(e, [[-10., 0.], [10., 0.]]),
        vec![[-2., 0.], [2., 0.]]
    );
    assert_eq!(
        ellipse_segment_intercept_points(e, [[-10., -2.], [10., -2.]]),
        vec![[0., -2.]]
    );
    assert_eq!(
        ellipse_segment_intercept_points(e, [[0., -1.], [0., 1.]]),
        Vec::<Point>::new()
    );
}
#[test]
fn ellipse_line_outside() {
    assert_eq!(
        ellipse_line_intersection_points(ellipse([0., 0.], 2., 2.), [[-10., -10.], [10., -10.]]),
        Vec::<Point>::new()
    );
}
#[test]
fn ellipse_line_intersecting() {
    let e = ellipse([0., 0.], 2., 2.);
    assert_eq!(
        ellipse_line_intersection_points(e, [[0., -1.], [0., 1.]]),
        vec![[0., 2.], [0., -2.]]
    );
    let r: Vec<Point> = ellipse_line_intersection_points(e, [[-100., 0.], [-10., 0.]])
        .into_iter()
        .map(|[x, y]| [js_round(x), js_round(y)])
        .collect();
    assert_eq!(r, vec![[2., 0.], [-2., 0.]]);
}
#[test]
fn ellipse_line_touching() {
    assert_eq!(
        ellipse_line_intersection_points(ellipse([0., 0.], 2., 2.), [[-2., -2.], [2., -2.]]),
        vec![[0., -2.]]
    );
}

// line.test.ts

#[test]
fn lines_intersect_at_origin() {
    assert_eq!(
        lines_intersect_at([[-5., -5.], [5., 5.]], [[5., -5.], [-5., 5.]]),
        Some([0., 0.])
    );
}
#[test]
fn lines_intersect_at_non_origin() {
    assert_eq!(
        lines_intersect_at([[0., 0.], [10., 10.]], [[10., 0.], [0., 10.]]),
        Some([5., 5.])
    );
}
#[test]
fn lines_parallel() {
    assert_eq!(
        lines_intersect_at([[0., 0.], [0., 10.]], [[10., 0.], [10., 10.]]),
        None
    );
}

// point.test.ts

#[test]
fn point_rotate() {
    let (x1, y1, x2, y2) = (10., 20., 20., 30.);
    let angle = PI / 2.;
    let [rx, ry] = point_rotate_rads([x1, y1], [x2, y2], angle);
    assert_eq!([rx, ry], [30., 20.]);
    assert_eq!(point_rotate_rads([rx, ry], [x2, y2], -angle), [x1, x2]);
}

// polygon.test.ts

const SQUARE: [Point; 4] = [[0., 0.], [10., 0.], [10., 10.], [0., 10.]];
fn rev(p: &[Point]) -> Vec<Point> {
    p.iter().rev().copied().collect()
}
fn with(p: &[Point], extra: &[Point]) -> Vec<Point> {
    [p, extra].concat()
}

#[test]
fn polygon_area_either_winding() {
    assert_eq!(polygon_area(&SQUARE, PRECISION), 100.);
    assert_eq!(polygon_area(&rev(&SQUARE), PRECISION), 100.);
}
#[test]
fn polygon_area_ignores_closing_vertex() {
    assert_eq!(polygon_area(&with(&SQUARE, &[SQUARE[0]]), PRECISION), 100.);
}
#[test]
fn polygon_signed_area_winding() {
    assert_eq!(polygon_signed_area(&SQUARE, PRECISION), 100.);
    assert_eq!(polygon_signed_area(&rev(&SQUARE), PRECISION), -100.);
}
#[test]
fn convex_hull_drops_inside_points() {
    let hull = convex_hull(&with(&SQUARE, &[[5., 5.]]));
    assert_eq!(hull.len(), 4);
    for p in SQUARE {
        assert!(hull.contains(&p));
    }
}
#[test]
fn convex_hull_drops_collinear() {
    assert_eq!(convex_hull(&with(&SQUARE, &[[5., 0.]])).len(), 4);
}
#[test]
fn convex_hull_point_cloud_any_order() {
    let cloud: Vec<Point> = (0..30)
        .map(|i| [(i as f64 * 2.4).cos() * 10., (i as f64 * 2.4).sin() * 10.])
        .collect();
    let hull = convex_hull(&cloud);
    close(
        polygon_area(&hull, PRECISION),
        polygon_area(&convex_hull(&rev(&cloud)), PRECISION),
        2,
    );
    assert!(polygon_area(&hull, PRECISION) > 250.);
    assert!(polygon_area(&hull, PRECISION) <= PI * 100.);
}
#[test]
fn convex_hull_degenerate() {
    assert_eq!(convex_hull(&SQUARE[..2]), SQUARE[..2].to_vec());
}

fn circle(n: usize) -> Vec<Point> {
    (0..n)
        .map(|i| {
            [
                ((i as f64 * 2. * PI) / n as f64).cos() * 100.,
                ((i as f64 * 2. * PI) / n as f64).sin() * 100.,
            ]
        })
        .collect()
}
#[test]
fn simplify_keeps_corners_drops_wobble() {
    let wobbly = convex_hull(&with(
        &SQUARE,
        &[[5., -0.2], [10.2, 5.], [5., 10.2], [-0.2, 5.]],
    ));
    assert_eq!(simplify_convex_polygon(&wobbly, (25. * PI) / 180.).len(), 4);
}
#[test]
fn simplify_spreads_ellipse_turn() {
    let corners = simplify_convex_polygon(&convex_hull(&circle(64)), (25. * PI) / 180.);
    assert!(corners.len() > 10);
    assert!(corners.len() <= 15);
}
#[test]
fn simplify_independent_of_hull_start() {
    let hull = convex_hull(&with(&SQUARE, &[[5., -0.2], [10.2, 5.]]));
    let rotated = [&hull[2..], &hull[..2]].concat();
    assert_eq!(
        simplify_convex_polygon(&rotated, (25. * PI) / 180.).len(),
        simplify_convex_polygon(&hull, (25. * PI) / 180.).len()
    );
}
#[test]
fn simplify_degenerate() {
    assert_eq!(
        simplify_convex_polygon(&SQUARE[..2], 0.4),
        SQUARE[..2].to_vec()
    );
}

// range.test.ts

const R1_4: Range = [1., 4.];
#[test]
fn range_overlap_a_contains_b() {
    assert!(ranges_overlap(R1_4, range_inclusive(2., 3.)));
    assert!(ranges_overlap(R1_4, R1_4));
    assert!(ranges_overlap(R1_4, range_inclusive(1., 3.)));
    assert!(ranges_overlap(R1_4, range_inclusive(2., 4.)));
}
#[test]
fn range_overlap_b_contains_a() {
    assert!(ranges_overlap(range_inclusive(2., 3.), R1_4));
    assert!(ranges_overlap(range_inclusive(1., 3.), R1_4));
    assert!(ranges_overlap(range_inclusive(2., 4.), R1_4));
}
#[test]
fn range_overlap_intersecting() {
    assert!(ranges_overlap(R1_4, range_inclusive(2., 5.)));
}
#[test]
fn range_intersection_with_itself() {
    assert_eq!(range_intersection(R1_4, R1_4), Some(R1_4));
}
#[test]
fn range_intersection_any_order() {
    assert_eq!(
        range_intersection(R1_4, range_inclusive(2., 3.)),
        Some([2., 3.])
    );
    assert_eq!(
        range_intersection(range_inclusive(2., 3.), R1_4),
        Some([2., 3.])
    );
    assert_eq!(
        range_intersection(R1_4, range_inclusive(3., 5.)),
        Some(range_inclusive(3., 4.))
    );
    assert_eq!(
        range_intersection(range_inclusive(3., 5.), R1_4),
        Some(range_inclusive(3., 4.))
    );
}
#[test]
fn range_intersection_at_edge() {
    assert_eq!(
        range_intersection(R1_4, range_inclusive(4., 5.)),
        Some(range_inclusive(4., 4.))
    );
}
#[test]
fn range_no_intersection() {
    assert_eq!(range_intersection(R1_4, range_inclusive(5., 7.)), None);
}

// segment.test.ts

#[test]
fn segment_intersection() {
    assert_eq!(
        line_segment_intersection_points([[0., 0.], [5., 0.]], [[2., -2.], [3., 2.]], PRECISION),
        Some([2.5, 0.])
    );
}
#[test]
fn segment_non_intersection() {
    assert_eq!(
        line_segment_intersection_points([[0., 0.], [5., 0.]], [[3., 1.], [4., 4.]], PRECISION),
        None
    );
}
#[test]
fn is_line_segment_valid() {
    assert!(is_line_segment(&[&[0., 0.], &[1., 1.]]));
}
/// Upstream passes the string "not-a-point"; the closest untyped stand-in is
/// a slice that is not two numbers.
#[test]
fn is_line_segment_second_not_point() {
    assert!(!is_line_segment(&[&[0., 0.], &[]]));
}
#[test]
fn is_line_segment_wrong_length() {
    assert!(!is_line_segment(&[&[0., 0.]]));
}
