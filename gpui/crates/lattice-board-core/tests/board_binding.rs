// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Arrow bindings: upstream Excalidraw tests @ 3a317b5 translated. The
//! upstream cases drive pointer gestures through the React harness; here
//! each gesture is the binding call the editor makes for it, on the same
//! elements, checked against the same expectations:
//! - element/tests/binding.test.tsx
//! - excalidraw/tests/arrowBinding.test.tsx
//! - excalidraw/tests/arrowEndpointTextBinding.test.tsx
//!
//! A new arrow is drawn as the editor does it: pointer down binds the start
//! (`bind_or_unbind_binding_element` with the start point dragged), the drag
//! binds the end with the linear editor's `origin` / `arrowStartIsInside`.
//!
//! Skipped, with reasons:
//! - elbow arrows' routes (binding.test "keeps an elbow arrow drawn inside the
//!   frame", the elbow halves of "midpoint snapping on diamonds", "elbow
//!   arrow binds above the top vertex / next to the tip of a thin rotated
//!   diamond / snaps to a diamond's edge midpoint"; arrowBinding "elbow arrow
//!   does not snap … when binding is disabled", "does not snap an
//!   angle-locked elbow binding"): they check routed points through UI
//!   pointer paths; elbow routing is tested in board_linear.rs (with the
//!   binding-disabled case). The elbow fixed point of the point-like case is
//!   checked.
//! - binding.test "self-binding single-click finalize" (5 cases), "editing
//!   arrow … should end up selecting A": multi-click creation, selection and
//!   the linear editor's mode, app state not in binding.ts.
//! - binding.test "should unbind arrow when arrow is resized / rotated":
//!   transform handles and resizing aren't ported.
//! - binding.test "to text elements" (wrap in container, editing text) and
//!   "updateBoundElements with a render environment": text editing and label
//!   layout are the text module's (`BindingHooks::handle_bind_text_resize`).
//! - binding.test "should create orbit binding when one of the cursor is
//!   inside rectangle" is `it.skip` upstream.
//! - arrowBinding: `actionToggleArrowBinding`, the Ctrl toggle, the
//!   `event.repeat` and view-mode guards: actions and keyboard handling.
//! - arrowEndpointTextBinding: hover affordance in app state
//!   (`textToolHover`, label midpoints, escape, tool switching, ctrl toggle),
//!   drag-sizing, occlusion, history, text-tool interaction, empty submit,
//!   "keeps the bound side midpoint pinned as the text grows": the text
//!   tool and text layout. The endpoint lookup, the placement, and the tip
//!   staying put are checked.
//!
//! Adapted:
//! - "3+ point arrow should be dragged along with the bindable": upstream's
//!   drag starts inside a transparent rectangle, which doesn't grab it, so
//!   nothing moves; here the rectangle does move and the inner points keep
//!   their scene positions (the intent).
//! - "should create an `inside` binding": the first move is checked; the
//!   later gestures drag from spots the earlier moves left empty.

mod board {
    use lattice_board_core::board::arrow_text::*;
    use lattice_board_core::board::binding::*;
    use lattice_board_core::board::bounds::get_point_at_index_global_coordinates;
    use lattice_board_core::board::deconstruct::get_all_midpoints;
    use lattice_board_core::board::history::{ElementMap, HistoryHooks, NoHooks};
    use lattice_board_core::board::math::*;
    use lattice_board_core::board::mutate::fix_timestamp;
    use lattice_board_core::board::new_element::*;
    use lattice_board_core::board::random::reseed;
    use lattice_board_core::board::restore::{RestoreOpts, restore_elements};
    use lattice_board_core::board::scene::Scene;
    use lattice_board_core::board::types::*;
    use lattice_board_core::board::utils::{ElementsMap, get_size_from_points};
    use rustc_hash::{FxHashMap, FxHashSet};
    use serde_json::json;

    fn setup() {
        reseed(7);
        fix_timestamp(Some(1));
    }
    fn close(a: f64, e: f64, digits: i32) {
        assert!(
            (a - e).abs() < 10f64.powi(-digits) / 2.,
            "{a} not close to {e} ({digits} digits)"
        );
    }
    fn opts(id: &str, x: f64, y: f64, w: f64, h: f64) -> ElementOpts {
        ElementOpts {
            id: Some(id.into()),
            x,
            y,
            width: w,
            height: h,
            ..Default::default()
        }
    }
    fn shape(ty: ElementType, id: &str, x: f64, y: f64, w: f64, h: f64) -> Element {
        new_element(ty, opts(id, x, y, w, h))
    }
    fn rect(id: &str, x: f64, y: f64, w: f64, h: f64) -> Element {
        shape(ElementType::Rectangle, id, x, y, w, h)
    }
    fn arrow(id: &str, x: f64, y: f64, points: Vec<Point>) -> Element {
        let (w, h) = get_size_from_points(&points);
        new_arrow_element(
            opts(id, x, y, w, h),
            points,
            None,
            Some(Arrowhead::Arrow),
            false,
            None,
        )
    }
    fn elbow(id: &str, x: f64, y: f64, points: Vec<Point>) -> Element {
        let (w, h) = get_size_from_points(&points);
        new_arrow_element(
            opts(id, x, y, w, h),
            points,
            None,
            Some(Arrowhead::Arrow),
            true,
            None,
        )
    }
    fn drag(i: usize, p: Point) -> PointsPositionUpdates {
        PointsPositionUpdates::from([(i, PointUpdate::at(p))])
    }
    fn get<'a>(s: &'a Scene, id: &str) -> &'a Element {
        s.get_element(id).unwrap()
    }
    fn start(s: &Scene, id: &str) -> Option<FixedPointBinding> {
        get(s, id).linear().unwrap().start_binding.clone()
    }
    fn end(s: &Scene, id: &str) -> Option<FixedPointBinding> {
        get(s, id).linear().unwrap().end_binding.clone()
    }
    fn end_point(s: &Scene, id: &str) -> Point {
        get_point_at_index_global_coordinates(get(s, id), -1, s)
    }
    fn in_unit(b: &FixedPointBinding) -> bool {
        b.fixed_point.iter().all(|v| (0. ..=1.).contains(v))
    }
    fn move_by(s: &mut Scene, id: &str, dx: f64, dy: f64) {
        s.mutate_element(id, true, |e| {
            e.x += dx;
            e.y += dy;
        });
        update_bound_elements(id, s, &UpdateBoundOpts::default(), &NO_BINDING_HOOKS);
    }

    /// Draws arrow `id` from `from` to `to` as the arrow tool does.
    fn draw(
        s: &mut Scene,
        id: &str,
        from: Point,
        to: Point,
        ctx: &BindingCtx,
        angle_locked: bool,
        end_local: Option<Point>,
    ) {
        let to_local = end_local.unwrap_or([to[0] - from[0], to[1] - from[1]]);
        s.insert_element(arrow(id, from[0], from[1], vec![[0., 0.], to_local]));
        let o = BindOpts {
            new_arrow: true,
            angle_locked,
            ..Default::default()
        };
        bind_or_unbind_binding_element(id, &drag(0, [0., 0.]), from, s, ctx, &o);
        let st = LinearDragState {
            origin: Some(from),
            arrow_start_is_inside: start(s, id).is_some_and(|b| b.mode == BindMode::Inside),
            ..Default::default()
        };
        let p = *get(s, id).points().unwrap().last().unwrap();
        bind_or_unbind_binding_element(
            id,
            &drag(1, p),
            to,
            s,
            &BindingCtx {
                drag: Some(&st),
                ..*ctx
            },
            &o,
        );
    }
    fn ctx() -> BindingCtx<'static> {
        BindingCtx::default()
    }

    // -----------------------------------------------------------------------
    // binding.test.tsx
    // -----------------------------------------------------------------------

    #[test]
    fn both_endpoints_inside_the_same_element_bind_inside() {
        setup();
        let mut s = Scene::new(vec![rect("rect", 100., 100., 100., 100.)]);
        draw(
            &mut s,
            "arrow",
            [110., 110.],
            [160., 160.],
            &ctx(),
            false,
            None,
        );
        let a = get(&s, "arrow");
        assert_eq!((a.x, a.y), (110., 110.));
        let (sb, eb) = (start(&s, "arrow").unwrap(), end(&s, "arrow").unwrap());
        assert_eq!(
            (sb.element_id.as_str(), eb.element_id.as_str()),
            ("rect", "rect")
        );
        assert!(in_unit(&sb) && in_unit(&eb));
        assert_eq!((sb.mode, eb.mode), (BindMode::Inside, BindMode::Inside));
        // move the bindable: the arrow moves with it
        move_by(&mut s, "rect", 180., -40.);
        let a = get(&s, "arrow");
        assert_eq!((a.x, a.y), (290., 70.));
        // drag the start point (the linear editor), then move the bindable again
        let p = [10., 10.];
        bind_or_unbind_binding_element(
            "arrow",
            &drag(0, p),
            [300., 80.],
            &mut s,
            &ctx(),
            &BindOpts::default(),
        );
        let before = (get(&s, "arrow").x, get(&s, "arrow").y);
        assert_eq!(start(&s, "arrow").unwrap().mode, BindMode::Inside);
        move_by(&mut s, "rect", 150., 0.);
        let a = get(&s, "arrow");
        close(a.x, before.0 + 150., 6);
        close(a.y, before.1, 6);
    }

    #[test]
    fn multi_point_arrow_keeps_its_inner_points_when_one_end_moves() {
        setup();
        let mut a = arrow(
            "arrow",
            100.,
            50.,
            vec![[0., 0.], [50., -20.], [150., 20.], [200., 0.]],
        );
        let l = a.linear_mut().unwrap();
        l.start_binding = Some(FixedPointBinding {
            element_id: "left".into(),
            fixed_point: [0.5, 0.5],
            mode: BindMode::Orbit,
        });
        l.end_binding = Some(FixedPointBinding {
            element_id: "right".into(),
            fixed_point: [0.5, 0.5],
            mode: BindMode::Orbit,
        });
        let mut left = rect("left", 0., 0., 100., 100.);
        let mut right = rect("right", 300., 0., 100., 100.);
        for r in [&mut left, &mut right] {
            r.bound_elements = Some(vec![BoundElement {
                id: "arrow".into(),
                kind: BoundType::Arrow,
            }]);
        }
        let mut s = Scene::new(vec![left, right, a]);
        let inner = |s: &Scene| {
            let a = get(s, "arrow");
            let p = a.points().unwrap();
            [
                [a.x + p[1][0], a.y + p[1][1]],
                [a.x + p[2][0], a.y + p[2][1]],
            ]
        };
        let before = inner(&s);
        move_by(&mut s, "right", 0., 50.);
        let after = inner(&s);
        for (b, a) in before.iter().zip(&after) {
            close(a[0], b[0], 9);
            close(a[1], b[1], 9);
        }
    }

    fn frame_scene() -> Scene {
        let frame = new_frame_element(opts("frame", 200., 200., 400., 400.), None);
        let mut child = rect("child", 300., 300., 100., 100.);
        child.frame_id = Some("frame".into());
        Scene::new(vec![frame, child])
    }

    #[test]
    fn binding_to_frames() {
        setup();
        // an arrow ending in the frame's empty interior doesn't bind
        let mut s = frame_scene();
        draw(&mut s, "a", [50., 50.], [500., 500.], &ctx(), false, None);
        assert_eq!(end(&s, "a"), None);
        // one ending on a frame child binds to the child
        let mut s = frame_scene();
        draw(&mut s, "a", [50., 50.], [350., 350.], &ctx(), false, None);
        assert_eq!(end(&s, "a").unwrap().element_id, "child");
        // one ending just outside the frame binds to the frame, orbiting
        let mut s = frame_scene();
        draw(&mut s, "a", [50., 50.], [500., 610.], &ctx(), false, None);
        let b = end(&s, "a").unwrap();
        assert_eq!((b.element_id.as_str(), b.mode), ("frame", BindMode::Orbit));
    }

    #[test]
    fn binds_an_arrow_dropped_at_a_circles_exact_center() {
        setup();
        let mut s = Scene::new(vec![shape(
            ElementType::Ellipse,
            "circle",
            100.,
            -100.,
            200.,
            200.,
        )]);
        draw(&mut s, "a", [-100., 0.], [200., 0.], &ctx(), false, None);
        assert_eq!(end(&s, "a").unwrap().element_id, "circle");
    }

    #[test]
    fn simple_arrow_ends_a_binding_gap_outside_a_diamonds_left_vertex() {
        for rounded in [false, true] {
            setup();
            let mut d = shape(ElementType::Diamond, "diamond", 100., -100., 200., 200.);
            if rounded {
                d.roundness = Some(Roundness {
                    kind: roundness::PROPORTIONAL_RADIUS,
                    value: None,
                });
            }
            let [_, _, left, _] = get_all_midpoints(&d, &vec![d.clone()]);
            let gap = get_binding_gap(d.stroke_width);
            let mut s = Scene::new(vec![d]);
            // near (not on) the vertex, so the end snaps to it
            draw(
                &mut s,
                "a",
                [-200., left[1]],
                [left[0] - 4., left[1] + 2.],
                &ctx(),
                false,
                None,
            );
            assert_eq!(end(&s, "a").unwrap().element_id, "diamond");
            let [x, y] = end_point(&s, "a");
            close(x, left[0] - gap, 0);
            close(y, left[1], 0);
        }
    }

    #[test]
    fn new_arrow_start_point_binding() {
        setup();
        let mut s = Scene::new(vec![rect("rect", 100., 100., 100., 100.)]);
        // start close to the rectangle, end outside
        draw(&mut s, "a", [205., 150.], [250., 150.], &ctx(), false, None);
        let b = start(&s, "a").unwrap();
        assert_eq!((b.element_id.as_str(), b.mode), ("rect", BindMode::Orbit));
        assert_eq!(end(&s, "a"), None);
    }

    #[test]
    fn new_arrow_end_point_binding() {
        setup();
        let mut s = Scene::new(vec![rect("rect", 100., 100., 100., 100.)]);
        // end near the rectangle's corner: orbit
        draw(&mut s, "a", [50., 150.], [95., 95.], &ctx(), false, None);
        let b = end(&s, "a").unwrap();
        assert_eq!((b.element_id.as_str(), b.mode), ("rect", BindMode::Orbit));
        assert_eq!(start(&s, "a"), None);
    }

    #[test]
    fn unbinds_on_bound_element_deletion() {
        setup();
        let mut s = Scene::new(vec![rect("rect", 60., 0., 100., 100.)]);
        draw(&mut s, "a", [0., 5.], [70., 75.], &ctx(), false, None);
        assert_eq!(end(&s, "a").unwrap().element_id, "rect");
        s.mutate_element("rect", true, |e| e.is_deleted = true);
        let deleted = vec![get(&s, "rect").clone()];
        fix_bindings_after_deletion(&mut s, &deleted);
        assert_eq!(end(&s, "a"), None);
    }

    #[test]
    fn duplicating_bound_elements_together_keeps_the_bindings() {
        setup();
        let mut s = Scene::new(vec![
            rect("left", 0., 0., 200., 500.),
            rect("right", 400., 200., 200., 500.),
        ]);
        draw(
            &mut s,
            "arrow",
            [190., 250.],
            [407., 251.],
            &ctx(),
            false,
            None,
        );
        assert_eq!(start(&s, "arrow").unwrap().element_id, "left");
        assert_eq!(end(&s, "arrow").unwrap().element_id, "right");
        let ids = ["left", "right", "arrow"];
        let map: FxHashMap<String, String> = ids
            .iter()
            .map(|id| (id.to_string(), format!("{id}-copy")))
            .collect();
        let mut dups: Vec<Element> = ids
            .iter()
            .map(|id| {
                let mut e = get(&s, id).clone();
                e.id = map[*id].clone();
                e
            })
            .collect();
        let lookup = dups.clone();
        fix_duplicated_bindings_after_duplication(&mut dups, &map, &lookup, &NO_BINDING_HOOKS);
        for e in &dups {
            if let Some(l) = e.linear() {
                assert_eq!(l.start_binding.as_ref().unwrap().element_id, "left-copy");
                assert_eq!(l.end_binding.as_ref().unwrap().element_id, "right-copy");
            } else {
                assert_eq!(e.bound_elements.as_ref().unwrap()[0].id, "arrow-copy");
            }
        }
        // only part of it duplicated: bindings to the rest are dropped
        let map: FxHashMap<String, String> = [("arrow".to_string(), "a2".to_string())]
            .into_iter()
            .collect();
        let mut dups = vec![get(&s, "arrow").clone()];
        fix_duplicated_bindings_after_duplication(&mut dups, &map, &s, &NO_BINDING_HOOKS);
        assert_eq!(
            (
                &dups[0].linear().unwrap().start_binding,
                &dups[0].linear().unwrap().end_binding
            ),
            (&None, &None)
        );
    }

    #[test]
    fn point_like_element_binds_to_its_center_and_the_arrow_stays_put_when_it_grows() {
        for elbowed in [false, true] {
            setup();
            let r = rect("rect", 200., 50., 0.00005, 0.00005);
            let a = if elbowed {
                elbow("arrow", 0., 50., vec![[0., 0.], [195., 0.]])
            } else {
                arrow("arrow", 0., 50., vec![[0., 0.], [195., 0.]])
            };
            let mut s = Scene::new(vec![r, a]);
            bind_binding_element(
                "arrow",
                "rect",
                BindMode::Orbit,
                StartOrEnd::End,
                &mut s,
                1.,
                None,
                true,
                true,
            );
            let b = end(&s, "arrow").unwrap();
            assert_eq!(b.element_id, "rect");
            // 0.5 is normalized to 0.5001
            close(b.fixed_point[0], 0.5001, 2);
            close(b.fixed_point[1], 0.5001, 2);
            s.mutate_element("rect", true, |e| {
                e.width = 300.;
                e.height = 200.;
            });
            update_bound_elements(
                "rect",
                &mut s,
                &UpdateBoundOpts::default(),
                &NO_BINDING_HOOKS,
            );
            let a = get(&s, "arrow");
            assert!(
                a.width.abs() < 1000. && a.height.abs() < 1000.,
                "{} x {}",
                a.width,
                a.height
            );
        }
    }

    // -----------------------------------------------------------------------
    // arrowBinding.test.tsx
    // -----------------------------------------------------------------------

    #[test]
    fn arrow_drawing_with_binding_disabled() {
        setup();
        // baseline: binding on, the start inside the rectangle binds
        let mut s = Scene::new(vec![rect("baselineRect", 100., 100., 400., 200.)]);
        draw(&mut s, "a", [200., 200.], [700., 200.], &ctx(), false, None);
        assert_eq!(start(&s, "a").unwrap().element_id, "baselineRect");
        let off = BindingCtx {
            is_binding_enabled: false,
            ..ctx()
        };
        let mut s = Scene::new(vec![rect("rect1", 100., 100., 400., 200.)]);
        draw(&mut s, "a", [200., 200.], [700., 200.], &off, false, None);
        assert_eq!(start(&s, "a"), None);
        let mut s = Scene::new(vec![rect("rect2", 500., 100., 300., 200.)]);
        draw(&mut s, "a", [100., 200.], [600., 200.], &off, false, None);
        assert_eq!(end(&s, "a"), None);
    }

    #[test]
    fn does_not_snap_to_midpoint_when_midpoint_snapping_is_off() {
        setup();
        let r = rect("rectNoMidSnap", 100., 100., 400., 200.);
        let a = arrow("a", 0., 250., vec![[0., 0.], [502., -48.]]);
        let map = vec![r.clone(), a.clone()];
        let p = [502., 202.];
        assert_eq!(
            project_fixed_point_onto_diagonal(&a, p, &r, StartOrEnd::End, &map, 1., true),
            Some([500., 200.])
        );
        assert_ne!(
            project_fixed_point_onto_diagonal(&a, p, &r, StartOrEnd::End, &map, 1., false),
            Some([500., 200.])
        );
    }

    #[test]
    fn angle_locked_binding_does_not_snap_to_the_grid_when_grid_mode_is_off() {
        setup();
        let mut s = Scene::new(vec![rect("rect", 600., 300., 200., 200.)]);
        let c = BindingCtx {
            grid_mode_enabled: false,
            grid_size: 20.,
            ..ctx()
        };
        // shift locks the drag to horizontal: the end is at y 333, the pointer at 347
        draw(
            &mut s,
            "a",
            [300., 333.],
            [596., 347.],
            &c,
            true,
            Some([296., 0.]),
        );
        assert_eq!(end(&s, "a").unwrap().element_id, "rect");
        let a = get(&s, "a");
        close(
            a.y + a.points().unwrap().last().unwrap()[1],
            a.y + a.points().unwrap()[0][1],
            2,
        );
    }

    #[test]
    fn grid_axis_follows_the_incoming_direction_on_rotated_bindables() {
        setup();
        let mut e = shape(ElementType::Ellipse, "ellipse", 610., 300., 240., 120.);
        e.angle = PI / 3.;
        let mut s = Scene::new(vec![e]);
        let c = BindingCtx {
            grid_mode_enabled: true,
            grid_size: 20.,
            ..ctx()
        };
        // the editor snaps the end to the grid (660, 360); the pointer is at 658
        draw(
            &mut s,
            "a",
            [400., 360.],
            [658., 360.],
            &c,
            false,
            Some([260., 0.]),
        );
        assert_eq!(end(&s, "a").unwrap().element_id, "ellipse");
        let a = get(&s, "a");
        close(
            a.y + a.points().unwrap().last().unwrap()[1],
            a.y + a.points().unwrap()[0][1],
            1,
        );
    }

    // -----------------------------------------------------------------------
    // arrowEndpointTextBinding.test.tsx
    // -----------------------------------------------------------------------

    fn ep_arrow(id: &str, from: Point, to: Point, sw: f64) -> Element {
        let mut a = arrow(
            id,
            from[0],
            from[1],
            vec![[0., 0.], [to[0] - from[0], to[1] - from[1]]],
        );
        a.stroke_width = sw;
        a
    }

    #[test]
    fn finds_free_arrow_endpoints() {
        setup();
        let els = vec![ep_arrow("arrow", [100., 300.], [100., 100.], 2.)];
        assert_eq!(
            get_unbound_arrow_endpoint_at_point([100., 100.], &els, &els, 1.),
            Some(ArrowEndpoint {
                arrow: "arrow".into(),
                start_or_end: StartOrEnd::End
            })
        );
        assert_eq!(
            get_unbound_arrow_endpoint_at_point([400., 400.], &els, &els, 1.),
            None
        );
        // an endpoint already bound isn't offered
        let mut a = ep_arrow("arrow", [100., 300.], [100., 100.], 2.);
        a.linear_mut().unwrap().end_binding = Some(FixedPointBinding {
            element_id: "other".into(),
            fixed_point: [0.5001, 0.5001],
            mode: BindMode::Orbit,
        });
        let els = vec![a, rect("other", 400., 400., 100., 100.)];
        assert_eq!(
            get_unbound_arrow_endpoint_at_point([100., 100.], &els, &els, 1.),
            None
        );
        // the start, when that is the endpoint under the cursor
        assert_eq!(
            get_unbound_arrow_endpoint_at_point([100., 300.], &els, &els, 1.)
                .unwrap()
                .start_or_end,
            StartOrEnd::Start
        );
    }

    #[test]
    fn placement_strategy() {
        setup();
        let cases = [
            (
                [100., 300.],
                [100., 100.],
                [0.5001, 1.],
                TextAlign::Center,
                VerticalAlign::Bottom,
            ),
            (
                [100., 100.],
                [300., 100.],
                [0., 0.5001],
                TextAlign::Left,
                VerticalAlign::Middle,
            ),
            (
                [100., 100.],
                [100., 300.],
                [0.5001, 0.],
                TextAlign::Center,
                VerticalAlign::Top,
            ),
            (
                [300., 100.],
                [100., 100.],
                [1., 0.5001],
                TextAlign::Right,
                VerticalAlign::Middle,
            ),
        ];
        for (from, to, fp, ta, va) in cases {
            let a = ep_arrow("arrow", from, to, 2.);
            let b = get_text_binding_for_arrow_endpoint(&a, StartOrEnd::End, &vec![a.clone()], 2.)
                .unwrap();
            assert_eq!(
                (b.fixed_point, b.text_align, b.vertical_align),
                (fp, ta, va)
            );
        }
        // the start point: the arrow leaves the tip heading right, so the
        // text sits to its left
        let a = ep_arrow("arrow", [100., 100.], [300., 100.], 2.);
        let b = get_text_binding_for_arrow_endpoint(&a, StartOrEnd::Start, &vec![a.clone()], 2.)
            .unwrap();
        assert_eq!(
            (b.fixed_point, b.text_align),
            ([1., 0.5001], TextAlign::Right)
        );
    }

    /// A text of `w` x `h` placed as the text tool places it for `b`, bound
    /// to the arrow's end.
    fn bind_text(a: &Element, b: &EndpointTextBinding, w: f64, h: f64, sw: f64) -> Scene {
        let (rx, ry) = get_text_anchor_ratios(b.text_align, b.vertical_align);
        let mut t = rect("text", b.anchor[0] - w * rx, b.anchor[1] - h * ry, w, h);
        t.kind = Kind::Text(TextData {
            font_size: 20.,
            font_family: 5,
            base_font_size: None,
            text: "x".into(),
            text_align: b.text_align,
            vertical_align: b.vertical_align,
            container_id: None,
            original_text: "x".into(),
            auto_resize: true,
            line_height: 1.25,
            label_position: None,
        });
        t.stroke_width = sw;
        let mut s = Scene::new(vec![a.clone(), t]);
        bind_binding_element_to_fixed_point(&a.id, "text", StartOrEnd::End, b.fixed_point, &mut s);
        s
    }
    /// Grows the text about its anchor, as typing does, and re-places bound arrows.
    fn grow(s: &mut Scene, w: f64, h: f64) {
        let t = get(s, "text").clone();
        let (rx, ry) = {
            let d = t.text().unwrap();
            get_text_anchor_ratios(d.text_align, d.vertical_align)
        };
        let (ax, ay) = (t.x + t.width * rx, t.y + t.height * ry);
        s.mutate_element("text", true, |e| {
            e.width = w;
            e.height = h;
            e.x = ax - w * rx;
            e.y = ay - h * ry;
        });
        update_bound_elements("text", s, &UpdateBoundOpts::default(), &NO_BINDING_HOOKS);
    }
    fn assert_tip(s: &Scene, tip: Point) {
        let p = end_point(s, "arrow");
        close(p[0], tip[0], 1);
        close(p[1], tip[1], 1);
    }

    #[test]
    fn the_arrow_stays_put() {
        setup();
        // created and typed into
        let a = ep_arrow("arrow", [100., 300.], [100., 100.], 2.);
        let tip = [100., 100.];
        let b =
            get_text_binding_for_arrow_endpoint(&a, StartOrEnd::End, &vec![a.clone()], 2.).unwrap();
        let mut s = bind_text(&a, &b, 60., 25., 2.);
        assert_eq!(
            get(&s, "text").bound_elements.as_ref().unwrap()[0].id,
            "arrow"
        );
        assert!(is_endpoint_bound_text(get(&s, "text"), &s));
        grow(&mut s, 70., 25.);
        assert_tip(&s, tip);
        grow(&mut s, 190., 50.);
        assert_tip(&s, tip);
        // diagonal arrows: the anchor sits back along the arrow, not along
        // the side's normal
        for from in [[100., 100.], [160., 100.], [100., 160.]] {
            let a = ep_arrow("arrow", from, [300., 300.], 2.);
            let b = get_text_binding_for_arrow_endpoint(&a, StartOrEnd::End, &vec![a.clone()], 2.)
                .unwrap();
            let mut s = bind_text(&a, &b, 12., 25., 2.);
            grow(&mut s, 14., 25.);
            assert_tip(&s, [300., 300.]);
            grow(&mut s, 250., 25.);
            assert_tip(&s, [300., 300.]);
        }
        // the gap comes from the text's stroke width, not the arrow's
        for (arrow_sw, text_sw) in [(2., 4.), (4., 1.), (1., 2.)] {
            let a = ep_arrow("arrow", [100., 300.], [100., 100.], arrow_sw);
            let b =
                get_text_binding_for_arrow_endpoint(&a, StartOrEnd::End, &vec![a.clone()], text_sw)
                    .unwrap();
            let mut s = bind_text(&a, &b, 12., 25., text_sw);
            grow(&mut s, 14., 25.);
            assert_tip(&s, tip);
            grow(&mut s, 250., 25.);
            assert_tip(&s, tip);
        }
    }

    #[test]
    fn reroutes_other_arrows_bound_to_a_moved_text() {
        setup();
        let mut t = rect("text", 200., 280., 300., 50.);
        t.kind = Kind::Text(TextData {
            font_size: 20.,
            font_family: 5,
            base_font_size: None,
            text: "x".into(),
            text_align: TextAlign::Right,
            vertical_align: VerticalAlign::Middle,
            container_id: None,
            original_text: "x".into(),
            auto_resize: false,
            line_height: 1.25,
            label_position: None,
        });
        t.bound_elements = Some(vec![BoundElement {
            id: "fromTop".into(),
            kind: BoundType::Arrow,
        }]);
        let mut a = ep_arrow("fromTop", [350., 120.], [350., 260.], 2.);
        a.linear_mut().unwrap().end_binding = Some(FixedPointBinding {
            element_id: "text".into(),
            fixed_point: [0.5001, 0.],
            mode: BindMode::Orbit,
        });
        let mut s = Scene::new(vec![t, a]);
        let tip_before = end_point(&s, "fromTop");
        // the text unwraps about its right-middle anchor
        s.mutate_element("text", true, |e| {
            e.x = 100.;
            e.y = 292.5;
            e.width = 400.;
            e.height = 25.;
        });
        update_bound_elements(
            "text",
            &mut s,
            &UpdateBoundOpts::default(),
            &NO_BINDING_HOOKS,
        );
        let text = get(&s, "text").clone();
        let tip = end_point(&s, "fromTop");
        assert_ne!(tip, tip_before);
        // still just clear of the top edge, and closer to the new centre
        assert!(tip[1] < text.y);
        let centre = text.x + text.width / 2.;
        assert!((tip[0] - centre).abs() < (tip_before[0] - centre).abs());
        let (_, anchor_x) = get_endpoint_bound_text_drag_anchor(&text);
        assert_eq!(anchor_x, 500.);
    }

    // -----------------------------------------------------------------------
    // ours
    // -----------------------------------------------------------------------

    #[test]
    fn unbinding_keeps_the_listing_while_the_other_end_is_bound_there() {
        setup();
        let mut s = Scene::new(vec![rect("rect", 100., 100., 100., 100.)]);
        draw(&mut s, "a", [110., 110.], [160., 160.], &ctx(), false, None);
        assert_eq!(get(&s, "rect").bound_elements.as_ref().unwrap().len(), 1);
        assert_eq!(
            unbind_binding_element("a", StartOrEnd::Start, &mut s),
            Some("rect".into())
        );
        assert_eq!(get(&s, "rect").bound_elements.as_ref().unwrap().len(), 1);
        unbind_binding_element("a", StartOrEnd::End, &mut s);
        assert!(get(&s, "rect").bound_elements.as_ref().unwrap().is_empty());
    }

    #[test]
    fn history_hooks_update_bound_arrows() {
        setup();
        let mut s = Scene::new(vec![
            rect("left", 0., 0., 100., 100.),
            rect("right", 300., 0., 100., 100.),
        ]);
        draw(&mut s, "a", [105., 50.], [295., 50.], &ctx(), false, None);
        let mut m: ElementMap = s.elements_including_deleted().iter().cloned().collect();
        let before = get_point_at_index_global_coordinates(m.get("a").unwrap(), -1, &m);
        m.mutate("right", |e| e.x += 100.);
        let mut hooks = BindingHistoryHooks {
            text: NoHooks,
            hooks: &NO_BINDING_HOOKS,
        };
        hooks.update_bound_elements("right", &mut m, &FxHashSet::default());
        let after = get_point_at_index_global_coordinates(m.get("a").unwrap(), -1, &m);
        close(after[0], before[0] + 100., 6);
    }

    #[test]
    fn restore_migrates_v1_bindings() {
        setup();
        let r = json!({"type": "rectangle", "id": "r", "x": 100, "y": 100, "width": 100, "height": 100, "strokeWidth": 2});
        // the start inside the rectangle: inside, at the start
        let inside = json!({"type": "arrow", "id": "a", "x": 150, "y": 150, "points": [[0, 0], [200, 0]], "width": 200, "height": 0,
            "startBinding": {"elementId": "r", "focus": 0.2, "gap": 4}});
        let out = restore_elements(
            Some(&json!([r, inside])),
            None,
            &RestoreOpts {
                repair_bindings: true,
                ..Default::default()
            },
        );
        let b = out[1].linear().unwrap().start_binding.clone().unwrap();
        assert_eq!(
            (b.element_id.as_str(), b.mode, b.fixed_point),
            ("r", BindMode::Inside, [0.5001, 0.5001])
        );
        // outside: orbit, on the rectangle's right midpoint (snapped)
        let outside = json!({"type": "arrow", "id": "a", "x": 205, "y": 150, "points": [[0, 0], [200, 0]], "width": 200, "height": 0,
            "startBinding": {"elementId": "r", "focus": 0, "gap": 5}});
        let out = restore_elements(
            Some(&json!([r, outside])),
            None,
            &RestoreOpts {
                repair_bindings: true,
                ..Default::default()
            },
        );
        let b = out[1].linear().unwrap().start_binding.clone().unwrap();
        assert_eq!((b.mode, b.fixed_point), (BindMode::Orbit, [1., 0.5001]));
    }

    #[test]
    fn global_fixed_points_and_side_midpoints() {
        setup();
        let mut r = rect("r", 0., 0., 100., 50.);
        r.angle = PI / 2.;
        let mut a = arrow("a", 200., 200., vec![[0., 0.], [100., 0.]]);
        a.linear_mut().unwrap().start_binding = Some(FixedPointBinding {
            element_id: "r".into(),
            fixed_point: [1., 0.5001],
            mode: BindMode::Orbit,
        });
        let m = vec![r, a.clone()];
        let [s, e] = get_global_fixed_points(&a, &m);
        // the right side's midpoint, turned a quarter around the center
        close(s[0], 50., 2);
        close(s[1], 75., 2);
        assert_eq!(e, [300., 200.]);
        let side =
            get_binding_side_mid_point(a.linear().unwrap().start_binding.as_ref().unwrap(), &m)
                .unwrap();
        close(side[0], 50., 1);
        close(side[1], 75., 1);
        let _ = m.get_element("r");
    }
}
