// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The board's geometry: upstream Excalidraw tests @ 3a317b5 translated with
//! their inputs and expected values, plus SVG export checks.
//! - element/tests/bounds.test.ts, shape.test.ts, sizeHelpers.test.ts,
//!   collision.test.tsx
//!
//! Skipped or adapted, with reasons:
//! - collision "hitElementItself cache": the four tests spy on how often
//!   `distanceToElement` runs to check upstream's memo, which we don't have;
//!   their hit results are kept.
//! - collision "check rotated elements can be hit" draws the arrow through
//!   the UI (React); the same arrow (curved, the default arrow type) is
//!   built directly.
//! - Constant-width freedraw uses a perfect-freehand stand-in for
//!   `@excalidraw/laser-pointer` (see shape.rs); its tests pass with it.

// The ported tests keep Excalidraw's helper signatures, so each stays
// traceable to its upstream counterpart.
#![allow(clippy::too_many_arguments)]

mod board {
    use lattice_board_core::board::bounds::*;
    use lattice_board_core::board::collision::*;
    use lattice_board_core::board::deconstruct::get_all_midpoints;
    use lattice_board_core::board::display::*;
    use lattice_board_core::board::export_svg::*;
    use lattice_board_core::board::math::*;
    use lattice_board_core::board::mutate::fix_timestamp;
    use lattice_board_core::board::new_element::*;
    use lattice_board_core::board::random::reseed;
    use lattice_board_core::board::restore::{RestoreOpts, load_file};
    use lattice_board_core::board::shape::*;
    use lattice_board_core::board::size_helpers::*;
    use lattice_board_core::board::text_measure::TestMeasure;
    use lattice_board_core::board::types::*;
    use lattice_board_core::board::utils::get_size_from_points;

    fn setup() {
        reseed(7);
        fix_timestamp(Some(1));
    }

    fn opts(x: f64, y: f64, w: f64, h: f64) -> ElementOpts {
        ElementOpts {
            x,
            y,
            width: w,
            height: h,
            seed: Some(1),
            ..Default::default()
        }
    }
    fn round() -> Option<Roundness> {
        Some(Roundness {
            kind: roundness::PROPORTIONAL_RADIUS,
            value: None,
        })
    }
    fn rect(x: f64, y: f64, w: f64, h: f64) -> Element {
        new_element(ElementType::Rectangle, opts(x, y, w, h))
    }
    fn with(mut e: Element, f: impl FnOnce(&mut Element)) -> Element {
        f(&mut e);
        e
    }
    fn close(a: f64, e: f64, digits: i32) {
        assert!(
            (a - e).abs() < 10f64.powi(-digits) / 2.,
            "{a} not close to {e} ({digits} digits)"
        );
    }
    fn arrow(
        points: Vec<Point>,
        end: Option<Arrowhead>,
        roundness: Option<Roundness>,
        elbowed: bool,
        sw: f64,
    ) -> Element {
        let (w, h) = get_size_from_points(&points);
        new_arrow_element(
            ElementOpts {
                roundness,
                roughness: 0.,
                stroke_width: sw,
                ..opts(0., 0., w, h)
            },
            points,
            None,
            end,
            elbowed,
            None,
        )
    }

    // bounds.test.ts

    /// `_ce`: a rounded, solid shape of roughness 0.
    fn ce(x: f64, y: f64, w: f64, h: f64, a: f64, ty: ElementType) -> Element {
        let o = ElementOpts {
            stroke_color: "#000".into(),
            background_color: "#000".into(),
            stroke_width: 1.,
            roundness: round(),
            roughness: 0.,
            opacity: 1.,
            angle: a,
            ..opts(x, y, w, h)
        };
        new_element(ty, o)
    }

    #[test]
    fn absolute_coords() {
        let e = ce(10., 20., 10., 0., 0., ElementType::Rectangle);
        let v = vec![e.clone()];
        assert_eq!(get_element_absolute_coords(&e, &v, false)[0], 10.);
        assert_eq!(get_element_absolute_coords(&e, &v, false)[2], 20.);
        let e = ce(0., 10., 0., 10., 0., ElementType::Rectangle);
        let v = vec![e.clone()];
        assert_eq!(get_element_absolute_coords(&e, &v, false)[1], 10.);
        assert_eq!(get_element_absolute_coords(&e, &v, false)[3], 20.);
    }

    #[test]
    fn element_bounds_rectangle_diamond_ellipse() {
        for (ty, want) in [
            (
                ElementType::Rectangle,
                [
                    39.39339828220179,
                    24.393398282201787,
                    60.60660171779821,
                    45.60660171779821,
                ],
            ),
            (
                ElementType::Diamond,
                [
                    42.928932188134524,
                    27.928932188134524,
                    57.071067811865476,
                    42.071067811865476,
                ],
            ),
            (
                ElementType::Ellipse,
                [
                    42.09430584957905,
                    27.09430584957905,
                    57.90569415042095,
                    42.90569415042095,
                ],
            ),
        ] {
            let e = ce(40., 30., 20., 10., PI / 4., ty);
            assert_eq!(
                get_element_bounds(&e, &vec![e.clone()], false),
                want,
                "{ty:?}"
            );
        }
    }

    #[test]
    fn element_bounds_curved_line() {
        let base = ce(
            449.58203125,
            186.0625,
            170.12890625,
            92.48828125,
            0.6447741904932416,
            ElementType::Rectangle,
        );
        let e = new_linear_element(
            ElementOpts::from_element(&base),
            vec![
                [0., 0.],
                [67.33984375, 92.48828125],
                [-102.7890625, 52.15625],
            ],
            None,
        );
        assert_eq!(
            get_element_bounds(&e, &vec![e.clone()], false),
            [
                360.9291017525165,
                185.24770129343722,
                481.4815539037601,
                319.8162855827246
            ]
        );
    }

    fn overlap(mode: BBoxMode) -> Vec<String> {
        let els = vec![
            rect(110., 110., 100., 100.),
            rect(10., 10., 85., 85.),
            rect(-10., -10., 110., 110.),
            rect(-10., -10., 50., 50.),
        ];
        let ids: Vec<String> = els.iter().map(|e| e.id.clone()).collect();
        let q = OverlapQuery {
            bounds: [0., 0., 100., 100.],
            mode,
            exclude_elements_in_frames: false,
            ignore: None,
            include_stroke: true,
        };
        elements_overlapping_bbox(&els, &els, &q)
            .iter()
            .map(|e| ids.iter().position(|i| *i == e.id).unwrap().to_string())
            .collect()
    }

    #[test]
    fn elements_overlapping_bbox_overlap_and_contain() {
        setup();
        assert_eq!(overlap(BBoxMode::Overlap), ["1", "3"]);
        assert_eq!(overlap(BBoxMode::Contain), ["1"]);
    }

    // the last segment is 7px long, the previous one turns into it by ~67°
    const PREV: Segment = [[0., 0.], [24., 10.]];
    const LAST: f64 = 7.;
    const TIP: Point = [24., 17.];

    fn end_points(
        head: Arrowhead,
        roundness: Option<Roundness>,
        part: Option<Arrowhead>,
        offset: f64,
    ) -> Vec<f64> {
        let a = arrow(
            vec![PREV[0], PREV[1], TIP],
            Some(head),
            roundness,
            false,
            2.,
        );
        get_arrowhead_points(
            &a,
            &linear_shape_ops(&a),
            StartOrEnd::End,
            part.unwrap_or(head),
            offset,
        )
        .unwrap()
    }

    #[test]
    fn arrowhead_triangle_covers_short_segment() {
        let p = end_points(Arrowhead::Triangle, None, None, 0.);
        assert!(p[1] - (p[3] + p[5]) / 2. > LAST);
    }

    #[test]
    fn arrowhead_arrow_grows_clear_of_previous() {
        let p = end_points(Arrowhead::Arrow, None, None, 0.);
        assert!(p[1] - (p[3] + p[5]) / 2. > LAST * 0.75);
        for side in [[p[2], p[3]], [p[4], p[5]]] {
            assert!(distance_to_line_segment(side, PREV) > 2.);
        }
    }

    #[test]
    fn arrowhead_curved_doesnt_grow() {
        let p = end_points(Arrowhead::Triangle, round(), None, 0.);
        assert!(p[1] - (p[3] + p[5]) / 2. <= LAST / 2.);
    }

    #[test]
    fn arrowhead_circle_grows_also_curved() {
        for r in [None, round()] {
            assert!(end_points(Arrowhead::Circle, r, None, 0.)[2] > LAST);
        }
    }

    #[test]
    fn arrowhead_cardinality_fits_short_segment() {
        let apex = end_points(
            Arrowhead::CardinalityOneOrMany,
            None,
            Some(Arrowhead::CardinalityMany),
            0.,
        );
        let bar = end_points(
            Arrowhead::CardinalityOneOrMany,
            None,
            Some(Arrowhead::CardinalityOne),
            CARDINALITY_ONE_OR_MANY_BAR_OFFSET,
        );
        let crows = point_distance([apex[0], apex[1]], TIP);
        let bar_len = point_distance([bar[2], bar[3]], [bar[4], bar[5]]);
        assert!(crows > LAST / 2.);
        assert!(crows <= LAST);
        let want = 2.
            * get_arrowhead_size(Arrowhead::CardinalityOne)
            * degrees_to_radians(get_arrowhead_angle(Arrowhead::CardinalityOne, None)).sin()
            / get_arrowhead_size(Arrowhead::CardinalityMany);
        close(bar_len / crows, want, 2);
    }

    #[test]
    fn arrowhead_cardinality_before_elbow_corner() {
        let last = 19.;
        let a = arrow(
            vec![
                [0., 0.],
                [40., 0.],
                [40., 30.],
                [70., 30.],
                [70., 30. + last],
            ],
            Some(Arrowhead::CardinalityMany),
            None,
            true,
            2.,
        );
        let p = get_arrowhead_points(
            &a,
            &linear_shape_ops(&a),
            StartOrEnd::End,
            Arrowhead::CardinalityMany,
            0.,
        )
        .unwrap();
        let crows = 30. + last - p[1];
        assert!(crows > last / 2.);
        close(crows, last - last / 2. / 2., 2);
    }

    #[test]
    fn arrowhead_bar_ends_closer_to_tip() {
        let p = end_points(Arrowhead::Bar, None, None, 0.);
        let tip = [p[0], p[1]];
        for end in [[p[2], p[3]], [p[4], p[5]]] {
            let len = point_distance(end, tip);
            assert!(len > LAST);
            assert!(distance_to_line_segment(end, PREV) > len - 0.01);
        }
    }

    #[test]
    fn arrowhead_diamond_reaches_segment_start() {
        let p = end_points(Arrowhead::Diamond, None, None, 0.);
        close(point_distance([p[0], p[1]], [p[4], p[5]]), LAST, 2);
    }

    // shape.test.ts

    #[test]
    fn arrowhead_fills_follow_outline() {
        for head in [
            Arrowhead::Triangle,
            Arrowhead::DiamondOutline,
            Arrowhead::Circle,
        ] {
            let a = with(
                arrow(vec![[0., 0.], [100., 0.]], Some(head), None, false, 2.),
                |e| e.roughness = 2.,
            );
            let ElementShape::Linear(parts) = generate_element_shape(&a) else {
                panic!()
            };
            let head = &parts[1].drawable;
            let (fill, outline) = (&head.sets[0], &head.sets[1]);
            assert_eq!(
                (fill.ty, outline.ty),
                (OpSetType::FillPath, OpSetType::Path)
            );
            // the fill only joins up the outline's curves
            let curves = |ops: &[Op]| {
                ops.iter()
                    .filter(|o| matches!(o, Op::BCurveTo(..)))
                    .copied()
                    .collect::<Vec<_>>()
            };
            assert_eq!(curves(&fill.ops), curves(&outline.ops));
        }
    }

    fn corners(points: &[Point]) -> usize {
        generate_elbow_arrow_shape(points, ELBOW_ARROW_CORNER_RADIUS)
            .iter()
            .filter(|c| matches!(c, PathCmd::QuadTo(..)))
            .count()
    }

    #[test]
    fn elbow_shapes() {
        assert_eq!(
            corners(&[
                [0., 0.],
                [44., 0.],
                [44., -1e-12],
                [195., -1e-12],
                [195., 34.]
            ]),
            1
        );
        assert_eq!(
            corners(&[
                [0., 0.],
                [100., 0.],
                [100., 0.5],
                [100.5, 0.5],
                [100.5, 100.]
            ]),
            3
        );
        assert_eq!(
            corners(&[[0., 0.], [100., 0.], [100., 0.5], [0., 0.5], [0., 50.]]),
            3
        );
    }

    // sizeHelpers.test.ts

    #[test]
    fn perfect_element_size() {
        let t = |ty: ElementType, w: f64, h: f64, ew: f64, eh: f64| {
            let (a, b) = get_perfect_element_size(Some(ty), w, h);
            close(a, ew, 3);
            close(b, eh, 3);
        };
        t(ElementType::Line, 149., 10., 149., 0.);
        t(ElementType::Line, 10., 140., 0., 140.);
        t(ElementType::Arrow, 200., 20., 200., 0.);
        t(ElementType::Arrow, 10., 100., 0., 100.);
        t(ElementType::Arrow, 120., 185., 120., 207.846);
        t(ElementType::Arrow, 135., 145., 135., 135.);
        t(ElementType::Arrow, 0., 0., 0., 0.);
    }

    // collision.test.tsx

    #[test]
    fn rotated_arrow_hit() {
        setup();
        let a = with(
            arrow(
                vec![[0., 0.], [120., -198.], [-4., -302.]],
                Some(Arrowhead::Arrow),
                round(),
                false,
                2.,
            ),
            |e| e.angle = 1.8700426423973724,
        );
        let v = vec![a.clone()];
        assert!(hit_element_itself(&HitTestArgs::new(
            [88., -68.],
            &a,
            10.,
            &v
        )));
    }

    #[test]
    fn hit_results_of_cache_tests() {
        setup();
        let filled = with(rect(0., 0., 100., 100.), |e| {
            e.background_color = "#ffffff".into()
        });
        let v = vec![filled.clone()];
        assert!(hit_element_itself(&HitTestArgs::new(
            [100.5, 50.],
            &filled,
            1.,
            &v
        )));
        assert!(hit_element_itself(&HitTestArgs::new(
            [100.5, 50.],
            &filled,
            10.,
            &v
        )));
        let moved = with(filled.clone(), |e| {
            e.version += 1;
            e.version_nonce += 1
        });
        assert!(hit_element_itself(&HitTestArgs::new(
            [100.5, 50.],
            &moved,
            1.,
            &v
        )));
        let hollow = rect(0., 0., 100., 100.);
        let v = vec![hollow.clone()];
        assert!(hit_element_itself(&HitTestArgs::new(
            [105., 50.],
            &hollow,
            10.,
            &v
        )));
        assert!(hit_element_itself(&HitTestArgs::new(
            [105., 50.],
            &hollow,
            6.,
            &v
        )));
        assert!(!hit_element_itself(&HitTestArgs::new(
            [50., 50.],
            &hollow,
            10.,
            &v
        )));
        assert!(hit_element_itself(&HitTestArgs {
            override_should_test_inside: true,
            ..HitTestArgs::new([50., 50.], &hollow, 10., &v)
        }));
    }

    #[test]
    fn rechecks_bound_label_when_arrow_moves() {
        setup();
        let mut a = new_arrow_element(
            opts(200., 200., 300., 0.),
            vec![[0., 0.], [300., 0.]],
            None,
            Some(Arrowhead::Arrow),
            false,
            None,
        );
        let mut label = new_text_element(
            TextOpts {
                text: "label".into(),
                container_id: Some(a.id.clone()),
                ..Default::default()
            },
            opts(325., 187.5, 0., 0.),
            &TestMeasure,
        );
        (label.x, label.y) = (325., 187.5);
        assert_eq!((label.width, label.height), (50., 25.));
        a.bound_elements = Some(vec![BoundElement {
            id: label.id.clone(),
            kind: BoundType::Text,
        }]);
        let v = vec![a.clone(), label.clone()];
        assert!(hit_element_itself(&HitTestArgs::new(
            [350., 200.],
            &label,
            1.,
            &v
        )));
        a.x = 500.;
        let v = vec![a, label.clone()];
        assert!(!hit_element_itself(&HitTestArgs::new(
            [350., 200.],
            &label,
            1.,
            &v
        )));
        assert!(hit_element_itself(&HitTestArgs::new(
            [650., 200.],
            &label,
            1.,
            &v
        )));
    }

    fn stroke(variability: StrokeVariability) -> Element {
        let pts: Vec<Point> = (0..21).map(|i| [i as f64 * 5., 0.]).collect();
        new_free_draw_element(
            ElementOpts {
                stroke_width: 10.,
                ..opts(0., 0., 100., 0.)
            },
            pts,
            vec![],
            true,
            Some(StrokeOptions {
                variability,
                streamline: 0.5,
            }),
        )
    }
    fn dist_at(e: &Element, x: f64, y: f64) -> f64 {
        distance_to_element(e, &vec![e.clone()], [x, y])
    }
    fn hit_at(e: &Element, x: f64, y: f64) -> bool {
        hit_element_itself(&HitTestArgs::new([x, y], e, 1., &vec![e.clone()]))
    }

    #[test]
    fn freedraw_collision_matches_stroke_width() {
        setup();
        let (var, con) = (
            stroke(StrokeVariability::Variable),
            stroke(StrokeVariability::Constant),
        );
        assert_eq!(dist_at(&var, 50., 0.), 0.);
        assert_eq!(dist_at(&con, 50., 0.), 0.);
        assert_eq!(dist_at(&var, 50., 20.), 0.);
        let (vd, cd) = (dist_at(&var, 50., 20.), dist_at(&con, 50., 20.));
        assert!(cd > 0. && vd < cd);
        assert!(dist_at(&var, 50., 45.) > 0.);
        assert!(hit_at(&var, 50., 20.));
        assert!(hit_at(&var, 50., -20.));
        assert!(hit_at(&con, 50., 10.));
        assert!(!hit_at(&con, 50., 20.));
        assert!(!hit_at(&var, 50., 45.));
    }

    #[test]
    fn freedraw_short_stroke_start_cap() {
        setup();
        let e = new_free_draw_element(
            ElementOpts {
                stroke_width: 1.,
                ..opts(0., 0., 0., 0.)
            },
            vec![[0., 0.], [0.01, 0.], [2.9, 0.]],
            vec![1., 1., 1.],
            false,
            Some(StrokeOptions {
                variability: StrokeVariability::Variable,
                streamline: 0.5,
            }),
        );
        assert_eq!(dist_at(&e, 0.1, 4.9), 0.);
        assert!(hit_element_itself(&HitTestArgs::new(
            [0.1, 4.9],
            &e,
            0.6,
            &vec![e.clone()]
        )));
    }

    fn circle_points() -> Vec<Point> {
        (0..81)
            .map(|i| {
                let t = i as f64 / 80. * 2. * PI;
                [80. + 80. * t.cos(), 40. + 40. * t.sin()]
            })
            .collect()
    }

    fn create_loop(
        angle: f64,
        bg: &str,
        variability: StrokeVariability,
        points: Option<Vec<Point>>,
    ) -> Element {
        let points = points.unwrap_or_else(circle_points);
        let (w, h) = get_size_from_points(&points);
        new_free_draw_element(
            ElementOpts {
                angle,
                stroke_width: 2.,
                background_color: bg.into(),
                ..opts(300., 200., w, h)
            },
            points,
            vec![],
            true,
            Some(StrokeOptions {
                variability,
                streamline: 0.5,
            }),
        )
    }
    fn lp(points: Vec<Point>) -> Element {
        create_loop(0., "#ffc9c9", StrokeVariability::Variable, Some(points))
    }
    fn inside(e: &Element, p: Point) -> bool {
        is_point_in_element(p, e, &vec![e.clone()])
    }

    #[test]
    fn freedraw_loop_containment() {
        setup();
        for var in [StrokeVariability::Variable, StrokeVariability::Constant] {
            for angle in [0., PI / 4.] {
                let e = create_loop(angle, "#ffc9c9", var, None);
                let p = point_rotate_rads([400., 250.], [380., 240.], angle);
                assert!(dist_at(&e, p[0], p[1]) > 10.);
                assert!(inside(&e, p));
                assert!(hit_at(&e, p[0], p[1]));
                let e = create_loop(angle, "transparent", var, None);
                assert!(!hit_at(&e, p[0], p[1]));
            }
            let e = create_loop(0., "#ffc9c9", var, None);
            assert!(!inside(&e, [310., 210.]));
            assert!(!hit_at(&e, 310., 210.));
        }
    }

    #[test]
    fn freedraw_loop_fill_containment() {
        setup();
        for angle in [0., PI / 4.] {
            let e = create_loop(angle, "#ffc9c9", StrokeVariability::Variable, None);
            let c = [380., 240.];
            for p in [c, [400., 240.], [380., 250.]] {
                assert!(
                    inside(&e, point_rotate_rads(p, c, angle)),
                    "{p:?} at {angle}"
                );
            }
            // implicitly closes an unsnapped loop
            let mut pts = circle_points();
            *pts.last_mut().unwrap() = [160., 36.];
            let e = with(e, |e| *e.points_mut().unwrap() = pts);
            assert!(inside(&e, point_rotate_rads([440., 239.5], c, angle)));
        }
        let tri = vec![[0., 0.], [200., 0.], [0., 100.], [0., 0.]];
        let e = create_loop(
            PI / 4.,
            "#ffc9c9",
            StrokeVariability::Variable,
            Some(tri.clone()),
        );
        assert!(inside(
            &e,
            point_rotate_rads([330., 205.], [400., 250.], e.angle)
        ));
        // smoothed fill outside the rotated bounds of the points
        let e = create_loop(
            2. * PI / 3.,
            "#ffc9c9",
            StrokeVariability::Variable,
            Some(tri),
        );
        let p = point_rotate_rads([436., 240.], [400., 250.], e.angle);
        let [x1, y1, x2, y2] = get_element_bounds(&e, &vec![e.clone()], false);
        assert!(p[0] < x1 || p[0] > x2 || p[1] < y1 || p[1] > y2);
        assert!(inside(&e, p));
        assert!(hit_at(&e, p[0], p[1]));
        assert!(!inside(
            &lp(vec![[0., 0.], [100., 100.], [0., 0.]]),
            [350., 250.]
        ));
        assert!(!inside(
            &lp(vec![[0., 0.], [0.3, 0.], [0.3, 0.3], [0., 0.3], [0., 0.]]),
            [300.15, 200.15]
        ));
        assert!(inside(
            &lp(vec![[0., 0.], [100., 100.], [3., 0.]]),
            [350., 250.]
        ));
        assert!(inside(
            &lp(vec![
                [200., 100.],
                [100., 200.],
                [0., 100.],
                [100., 0.],
                [200., 100.]
            ]),
            [305., 285.]
        ));
        let star = (0..6)
            .map(|i| {
                let a = -PI / 2. + ((i * 2) % 5) as f64 / 5. * 2. * PI;
                [100. + 95. * a.cos(), 100. + 95. * a.sin()]
            })
            .collect();
        assert!(!inside(&lp(star), [400., 300.]));
        let e = create_loop(0., "#ffc9c9", StrokeVariability::Variable, None);
        assert!(inside(&e, [415., 255.]));
        let e = with(e, |e| {
            *e.points_mut().unwrap() = vec![[0., 0.], [160., 0.], [0., 80.], [0., 0.]]
        });
        assert!(!inside(&e, [415., 255.]));
    }

    fn hovered(els: &[Element], p: Point, zoom: f64) -> (Option<String>, Vec<String>) {
        (
            get_hovered_element_for_binding(p, els, &els.to_vec(), zoom).map(|e| e.id.clone()),
            get_all_hovered_element_at_point(p, els, &els.to_vec(), zoom)
                .iter()
                .map(|e| e.id.clone())
                .collect(),
        )
    }
    fn named(
        id: &str,
        ty: ElementType,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        bg: &str,
        locked: bool,
    ) -> Element {
        let mut e = new_element(
            ty,
            ElementOpts {
                id: Some(id.into()),
                background_color: bg.into(),
                locked,
                ..opts(x, y, w, h)
            },
        );
        if ty == ElementType::Image {
            e.kind = Kind::Image(ImageData {
                file_id: None,
                status: ImageStatus::Pending,
                scale: [1., 1.],
                crop: None,
            });
        }
        e
    }
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn binding_hit_tests() {
        setup();
        let r = named(
            "rect",
            ElementType::Rectangle,
            0.,
            0.,
            100.,
            100.,
            "transparent",
            false,
        );
        assert_eq!(
            hovered(std::slice::from_ref(&r), [120., 50.], 1.),
            (None, vec![])
        );
        assert_eq!(
            hovered(std::slice::from_ref(&r), [120., 50.], 0.4),
            (Some("rect".into()), s(&["rect"]))
        );

        let hidden = named(
            "hidden",
            ElementType::Rectangle,
            30.,
            30.,
            40.,
            40.,
            "transparent",
            false,
        );
        let cover = |bg: &str| {
            named(
                "cover",
                ElementType::Rectangle,
                0.,
                0.,
                100.,
                100.,
                bg,
                false,
            )
        };
        assert_eq!(
            hovered(&[hidden.clone(), cover("#ffc9c9")], [50., 50.], 1.),
            (Some("cover".into()), s(&["cover"]))
        );
        assert_eq!(
            hovered(&[hidden.clone(), cover("transparent")], [50., 50.], 1.),
            (Some("hidden".into()), s(&["cover", "hidden"]))
        );

        let image = named(
            "image",
            ElementType::Image,
            0.,
            0.,
            100.,
            100.,
            "transparent",
            false,
        );
        assert_eq!(
            hovered(&[hidden.clone(), image], [50., 50.], 1.),
            (Some("image".into()), s(&["image"]))
        );
        let locked = |bg: &str| {
            named(
                "locked",
                ElementType::Rectangle,
                0.,
                0.,
                100.,
                100.,
                bg,
                true,
            )
        };
        assert_eq!(
            hovered(&[hidden.clone(), locked("#ffc9c9")], [50., 50.], 1.),
            (None, vec![])
        );
        assert_eq!(
            hovered(&[hidden.clone(), locked("transparent")], [50., 50.], 1.),
            (Some("hidden".into()), s(&["hidden"]))
        );

        let rc = |id: &str, x: f64, y: f64, w: f64, h: f64| {
            named(id, ElementType::Rectangle, x, y, w, h, "transparent", false)
        };
        let (container, child) = (
            rc("container", 0., 0., 200., 200.),
            rc("child", 18., 80., 60., 40.),
        );
        assert_eq!(
            hovered(&[container.clone(), child.clone()], [5., 100.], 1.)
                .0
                .as_deref(),
            Some("container")
        );
        assert_eq!(
            hovered(&[container.clone(), child], [10., 100.], 1.)
                .0
                .as_deref(),
            Some("child")
        );
        let badge = rc("badge", -30., 80., 60., 40.);
        assert_eq!(
            hovered(&[container.clone(), badge.clone()], [3., 92.], 1.)
                .0
                .as_deref(),
            Some("badge")
        );
        assert_eq!(
            hovered(&[container, badge], [-5., 108.], 1.).0.as_deref(),
            Some("container")
        );

        let hidden = rc("hidden", 90., 90., 20., 20.);
        let circle = |bg: &str| {
            named(
                "circle",
                ElementType::Ellipse,
                0.,
                0.,
                200.,
                200.,
                bg,
                false,
            )
        };
        assert_eq!(
            hovered(&[circle("transparent")], [100., 100.], 1.)
                .0
                .as_deref(),
            Some("circle")
        );
        assert_eq!(
            hovered(&[hidden, circle("#ffc9c9")], [100., 100.], 1.),
            (Some("circle".into()), s(&["circle"]))
        );
    }

    #[test]
    fn ellipse_outline_not_hit_from_center_line() {
        let e = new_element(ElementType::Ellipse, opts(0., 0., 400., 100.));
        assert!(!hit_element_itself(&HitTestArgs::new(
            [210., 50.],
            &e,
            10.,
            &vec![e.clone()]
        )));
    }

    #[test]
    fn rounded_diamond_corner_intersection() {
        let d = new_element(
            ElementType::Diamond,
            ElementOpts {
                roundness: round(),
                ..opts(100., -100., 200., 200.)
            },
        );
        let v = vec![d.clone()];
        let [_, _, left, _] = get_all_midpoints(&d, &v);
        let hits = intersect_element_with_line_segment(
            &d,
            &v,
            [[200., left[1]], [-200., left[1]]],
            6.,
            false,
        );
        assert!(!hits.is_empty());
        close(hits[0][0], left[0] - 6., 0);
        close(hits[0][1], left[1], 2);
    }

    // SVG export

    const FIXTURE: &str = include_str!("fixtures/board/all-elements.excalidraw");

    fn attr(svg: &str, name: &str) -> String {
        let i = svg.find(&format!(" {name}=\"")).unwrap() + name.len() + 3;
        svg[i..i + svg[i..].find('"').unwrap()].to_string()
    }

    #[test]
    fn svg_export_smoke() {
        let scene = load_file(FIXTURE, &RestoreOpts::load()).unwrap();
        let opts = SvgExportOpts {
            background: scene.app_state.view_background_color.clone(),
            ..Default::default()
        };
        let svg = export_to_svg(&scene.elements, &scene.files, &TestMeasure, &opts);
        // well-formed: tags balance
        let mut stack: Vec<String> = vec![];
        let mut rest = svg.as_str();
        while let Some(i) = rest.find('<') {
            rest = &rest[i + 1..];
            if rest.starts_with("!--") {
                rest = &rest[rest.find("-->").unwrap() + 3..];
                continue;
            }
            let end = rest.find('>').unwrap();
            let tag = &rest[..end];
            if let Some(name) = tag.strip_prefix('/') {
                assert_eq!(stack.pop().as_deref(), Some(name), "unbalanced at {tag}");
            } else if !tag.ends_with('/') {
                stack.push(tag.split([' ', '>']).next().unwrap().to_string());
            }
            rest = &rest[end + 1..];
        }
        assert!(stack.is_empty(), "unclosed {stack:?}");
        // viewBox: common bounds of the root elements and frame labels, padded
        let map = scene.elements.clone();
        let roots: Vec<&Element> = scene
            .elements
            .iter()
            .filter(|e| {
                !e.is_deleted
                    && !e
                        .container_id()
                        .is_some_and(|c| map.iter().any(|m| m.id == c))
            })
            .collect();
        let mut b = get_common_bounds(roots.iter().copied(), &map);
        for f in scene.elements.iter().filter(|e| e.is_frame_like()) {
            let (_, [x, y, w, h]) = frame_label(f, &TestMeasure);
            b = [b[0].min(x), b[1].min(y), b[2].max(x + w), b[3].max(y + h)];
        }
        let vb: Vec<f64> = attr(&svg, "viewBox")
            .split(' ')
            .map(|v| v.parse().unwrap())
            .collect();
        assert_eq!(vb[..2], [0., 0.]);
        close(vb[2], b[2] - b[0] + 20., 6);
        close(vb[3], b[3] - b[1] + 20., 6);
        // one transformed group per visible element
        let visible = scene.elements.iter().filter(|e| !e.is_deleted).count();
        assert_eq!(svg.matches("<g transform=\"translate(").count(), visible);
        assert!(svg.contains(r##"fill="#f8f9fa""##));
        assert!(svg.contains("<text "));
        assert!(svg.contains("clip-path=\"url(#clip-frame1)\""));
    }

    /// Writes the fixture's SVG (and a PNG via `qlmanage` when available) to
    /// `$TMPDIR/board-geometry/` for looking at.
    #[test]
    #[ignore]
    fn write_fixture_svg() {
        let scene = load_file(FIXTURE, &RestoreOpts::load()).unwrap();
        let opts = SvgExportOpts {
            background: scene.app_state.view_background_color.clone(),
            ..Default::default()
        };
        let mut els = scene.elements.clone();
        // extra shapes the fixture lacks
        let extra = [
            new_element(
                ElementType::Diamond,
                ElementOpts {
                    roundness: round(),
                    background_color: "#ffc9c9".into(),
                    fill_style: FillStyle::Zigzag,
                    ..opts_at(420., 650., 160., 110.)
                },
            ),
            new_element(
                ElementType::Diamond,
                ElementOpts {
                    background_color: "#d0bfff".into(),
                    fill_style: FillStyle::Hachure,
                    stroke_style: StrokeStyle::Dashed,
                    ..opts_at(620., 650., 120., 90.)
                },
            ),
            new_linear_element(
                ElementOpts {
                    roundness: round(),
                    stroke_width: 4.,
                    ..opts_at(420., 820., 0., 0.)
                },
                vec![[0., 0.], [80., -60.], [160., 20.], [260., -30.]],
                None,
            ),
            new_arrow_element(
                ElementOpts {
                    roundness: round(),
                    ..opts_at(800., 650., 0., 0.)
                },
                vec![[0., 0.], [60., 100.], [150., 60.]],
                Some(Arrowhead::CircleOutline),
                Some(Arrowhead::DiamondOutline),
                false,
                None,
            ),
            new_arrow_element(
                opts_at(800., 820., 0., 0.),
                vec![[0., 0.], [80., 0.], [80., 80.], [160., 80.]],
                Some(Arrowhead::CardinalityOneOrMany),
                Some(Arrowhead::CardinalityZeroOrMany),
                true,
                None,
            ),
        ];
        els.extend(extra);
        let svg = export_to_svg(&els, &scene.files, &TestMeasure, &opts);
        let dir = std::env::temp_dir().join("board-geometry");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("all-elements.svg");
        std::fs::write(&path, &svg).unwrap();
        let _ = std::process::Command::new("qlmanage")
            .args(["-t", "-s", "1400", "-o"])
            .arg(&dir)
            .arg(&path)
            .output();
        eprintln!("wrote {}", path.display());
    }

    fn opts_at(x: f64, y: f64, w: f64, h: f64) -> ElementOpts {
        ElementOpts {
            stroke_color: "#1e1e1e".into(),
            roughness: 0.,
            ..opts(x, y, w, h)
        }
    }

    #[test]
    fn display_list_styles() {
        let e = new_element(
            ElementType::Rectangle,
            ElementOpts {
                background_color: "#a5d8ff".into(),
                fill_style: FillStyle::Hachure,
                stroke_style: StrokeStyle::Dashed,
                ..opts(0., 0., 100., 50.)
            },
        );
        let d =
            element_display(&e, &vec![e.clone()], &TestMeasure, &RenderOpts::default()).unwrap();
        let DisplayItem::Path {
            stroke: Some(hatch),
            fill: None,
            cmds,
        } = &d.items[0]
        else {
            panic!("{:?}", d.items[0])
        };
        assert_eq!(hatch.width, 1.);
        assert!(cmds.len() > 10);
        let DisplayItem::Path {
            stroke: Some(s), ..
        } = &d.items[1]
        else {
            panic!()
        };
        assert_eq!((s.width, s.dash.clone()), (2.5, Some(vec![8., 10.])));
        // hachure lines stay about inside the shape: rough.js jitters them, and
        // hachure-fill's sparse scans (every `gap` rows, one time in three)
        // start new edges where they begin, up to a gap behind
        let ends: Vec<Point> = cmds
            .iter()
            .filter_map(|c| {
                if let PathCmd::MoveTo(p) = c {
                    Some(*p)
                } else {
                    None
                }
            })
            .collect();
        assert!(
            ends.iter()
                .all(|p| p[0] >= -10. && p[0] <= 110. && p[1] >= -10. && p[1] <= 60.),
            "{ends:?}"
        );
    }
}
