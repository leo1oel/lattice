// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Elbow routing, the linear editor and flowcharts: upstream Excalidraw tests
//! @ 3a317b5 translated. Upstream drives pointer and keyboard gestures
//! through the React harness; here each gesture is the calls App.tsx makes
//! for it (`handle_pointer_down` → `handle_drag` → pointer up / finalize,
//! arrow creation as in board_binding.rs, Ctrl+arrow as `FlowChartCreator`
//! plus inserting the pending nodes), on the same elements, checked against
//! the same expectations:
//! - element/tests/elbowArrow.test.tsx
//! - element/tests/linearElementEditor.test.tsx
//! - element/tests/flowchart.test.tsx
//! - the elbow cases board_binding.rs skipped for want of routing
//!
//! `close_points` is upstream's `toCloselyEqualPoints` as it behaves: within
//! 10^precision, i.e. 100px by default, over the expected points only; where
//! that says little, point counts and exact values are checked as well.
//!
//! Skipped, with reasons:
//! - elbowArrow "can follow bound rotated shapes" (rotates through the stats
//!   panel) and the two duplication cases (duplicate.rs's, via actions);
//! - linearElementEditor: render counts and `hasBoundingBox` (rendering);
//!   entering the editor through the context menu, Enter / Ctrl+Enter and
//!   double clicks (key and action plumbing: `handle_double_click` and
//!   `toggle_linear_editor` are checked instead); hover highlighting; text
//!   editing and the text tool (binding text on double click / Enter, editor
//!   styles, wrapping, align tools, the context-menu unbind); resizing an
//!   arrow with its label (transform handles); the label grab against
//!   occluding elements (the app's hit test: `label_grabbable` comes in as a
//!   flag); "should not update label position when arrow dragged" (element
//!   dragging is drag.rs's);
//! - board_binding: "keeps an elbow arrow drawn inside the frame" (frame
//!   dragging) and the diamond midpoint / tip cases (UI pointer paths on
//!   rotated diamonds; their snapping is checked in board_binding.rs). The
//!   binding-disabled elbow case is checked below as a routed result.

mod board {
    use lattice_board_core::board::binding::*;
    use lattice_board_core::board::bounds::*;
    use lattice_board_core::board::elbow::*;
    use lattice_board_core::board::flowchart::*;
    use lattice_board_core::board::linear::*;
    use lattice_board_core::board::math::*;
    use lattice_board_core::board::mutate::fix_timestamp;
    use lattice_board_core::board::new_element::*;
    use lattice_board_core::board::random::reseed;
    use lattice_board_core::board::scene::Scene;
    use lattice_board_core::board::types::*;
    use lattice_board_core::board::utils::get_size_from_points;

    fn setup() {
        reseed(7);
        fix_timestamp(Some(1));
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
    fn line(id: &str, x: f64, y: f64, points: Vec<Point>, roundness: Option<Roundness>) -> Element {
        let (w, h) = get_size_from_points(&points);
        new_linear_element(
            ElementOpts {
                roundness,
                roughness: 0.,
                ..opts(id, x, y, w, h)
            },
            points,
            None,
        )
    }
    fn arrow(
        id: &str,
        x: f64,
        y: f64,
        points: Vec<Point>,
        roundness: Option<Roundness>,
    ) -> Element {
        let (w, h) = get_size_from_points(&points);
        new_arrow_element(
            ElementOpts {
                roundness,
                roughness: 0.,
                ..opts(id, x, y, w, h)
            },
            points,
            None,
            Some(Arrowhead::Arrow),
            false,
            None,
        )
    }
    const ROUND: Option<Roundness> = Some(Roundness {
        kind: roundness::PROPORTIONAL_RADIUS,
        value: None,
    });
    fn get<'a>(s: &'a Scene, id: &str) -> &'a Element {
        s.get_element(id).unwrap()
    }
    fn points(s: &Scene, id: &str) -> Vec<Point> {
        get(s, id).points().unwrap().to_vec()
    }
    fn close(a: f64, e: f64, digits: i32) {
        assert!(
            (a - e).abs() < 10f64.powi(-digits) / 2.,
            "{a} not close to {e} ({digits} digits)"
        );
    }
    fn close_point(a: Point, e: Point, digits: i32) {
        close(a[0], e[0], digits);
        close(a[1], e[1], digits);
    }
    /// Upstream's `toCloselyEqualPoints` as it behaves: within 100px, over
    /// the expected points only.
    fn close_points(a: &[Point], e: &[Point]) {
        assert!(
            a.len() >= e.len()
                && e.iter()
                    .zip(a)
                    .all(|(q, p)| (p[0] - q[0]).abs() < 100. && (p[1] - q[1]).abs() < 100.),
            "{a:?} vs {e:?}"
        );
    }
    fn route(scene: &mut Scene, id: &str, points: Vec<Point>) {
        mutate_elbow_arrow(
            scene,
            id,
            &ElbowUpdate {
                points: Some(points),
                ..Default::default()
            },
            &ElbowOptions::default(),
            &NO_BINDING_HOOKS,
        );
    }
    fn drag1(i: usize, p: Point) -> PointsPositionUpdates {
        PointsPositionUpdates::from([(i, PointUpdate::at(p))])
    }
    fn move_by(s: &mut Scene, id: &str, dx: f64, dy: f64) {
        s.mutate_element(id, true, |e| {
            e.x += dx;
            e.y += dy;
        });
        update_bound_elements(id, s, &UpdateBoundOpts::default(), &NO_BINDING_HOOKS);
    }

    /// Draws elbow arrow `id` click by click from `from` to `to`, as the
    /// arrow tool does: the start binds on pointer down, the route follows
    /// the pointer (snapping to what it hovers), the second click binds the
    /// end.
    fn draw_elbow(
        s: &mut Scene,
        id: &str,
        from: Point,
        to: Point,
        end_arrowhead: Option<Arrowhead>,
    ) {
        let p = vec![[0., 0.], [to[0] - from[0], to[1] - from[1]]];
        let (w, h) = get_size_from_points(&p);
        s.insert_element(new_arrow_element(
            opts(id, from[0], from[1], w, h),
            p,
            None,
            end_arrowhead,
            true,
            None,
        ));
        let o = BindOpts {
            new_arrow: true,
            ..Default::default()
        };
        bind_or_unbind_binding_element(
            id,
            &drag1(0, [0., 0.]),
            from,
            s,
            &BindingCtx::default(),
            &o,
        );
        let a = get(s, id).clone();
        mutate_elbow_arrow(
            s,
            id,
            &ElbowUpdate {
                points: Some(vec![[0., 0.], [to[0] - a.x, to[1] - a.y]]),
                ..Default::default()
            },
            &ElbowOptions {
                is_dragging: true,
                ..Default::default()
            },
            &NO_BINDING_HOOKS,
        );
        let n = points(s, id).len();
        let last = points(s, id)[n - 1];
        bind_or_unbind_binding_element(id, &drag1(n - 1, last), to, s, &BindingCtx::default(), &o);
    }

    // -----------------------------------------------------------------------
    // the editor's gestures, as App.tsx drives them
    // -----------------------------------------------------------------------

    fn ctx() -> LinearCtx<'static> {
        LinearCtx::default()
    }
    fn new_ctx() -> LinearCtx<'static> {
        LinearCtx {
            new_element: true,
            ..LinearCtx::default()
        }
    }
    const NONE: Modifiers = Modifiers {
        shift: false,
        alt: false,
        ctrl_or_cmd: false,
    };
    const SHIFT: Modifiers = Modifiers {
        shift: true,
        alt: false,
        ctrl_or_cmd: false,
    };

    fn editor(s: &mut Scene, id: &str, editing: bool) -> LinearElementEditor {
        LinearElementEditor::new(id, s, editing).unwrap()
    }

    /// Pointer up after a gesture (App.tsx `handleCanvasPointerUp`).
    fn up(
        s: &mut Scene,
        ed: LinearElementEditor,
        at: Point,
        mods: Modifiers,
        hit_self: bool,
    ) -> LinearElementEditor {
        let ptr = FinalizePointer {
            scene_coords: at,
            mods,
            hit_bound_text: false,
        };
        if ed.is_editing {
            if !hit_self {
                // finalize without pointer data: leaves the editor
                let (_, next) = finalize_element(
                    &ed.element_id,
                    Some(&ed),
                    &FinalizeElement::default(),
                    s,
                    &ctx(),
                );
                return next.unwrap();
            }
            let le = ed.handle_pointer_up(mods.shift, 1., s, &NO_BINDING_HOOKS);
            finalize_linear_gesture(&ed, s, &ctx(), &ptr, false);
            return le;
        }
        if ed.elbowed {
            renormalize_elbow_arrow(s, &ed.element_id, &NO_BINDING_HOOKS);
        }
        if hit_self && ed.is_dragging {
            return finalize_linear_gesture(&ed, s, &ctx(), &ptr, false)
                .0
                .unwrap();
        }
        ed
    }

    /// Pointer down at `from`, one move to `to`, up there.
    fn drag(
        s: &mut Scene,
        ed: LinearElementEditor,
        from: Point,
        to: Point,
        mods: Modifiers,
    ) -> LinearElementEditor {
        let r = ed.handle_pointer_down(s, &ctx(), from, &mods, false);
        let hit = r.hit_element.is_some();
        let mut ed = r.linear_element_editor.unwrap_or(ed);
        match ed.handle_drag(s, &ctx(), to, &mods) {
            DragOutcome::Segment(e)
            | DragOutcome::FocusPoint(e)
            | DragOutcome::MidpointAdded(e)
            | DragOutcome::Dragged(e, _) => ed = e,
            DragOutcome::Ignored | DragOutcome::NotHandled => {}
        }
        up(s, ed, to, mods, hit)
    }
    fn click(s: &mut Scene, ed: LinearElementEditor, at: Point) -> LinearElementEditor {
        let r = ed.handle_pointer_down(s, &ctx(), at, &NONE, false);
        let hit = r.hit_element.is_some();
        up(s, r.linear_element_editor.unwrap_or(ed), at, NONE, hit)
    }
    fn mids(s: &Scene, id: &str, editing: bool) -> Vec<Option<Point>> {
        get_editor_mid_points(get(s, id), s, 1., editing)
    }

    // -----------------------------------------------------------------------
    // elbowArrow.test.tsx
    // -----------------------------------------------------------------------

    #[test]
    fn moves_the_second_segment_of_a_fully_connected_elbow_arrow() {
        setup();
        let mut s = Scene::new(vec![
            rect("r1", -100., -50., 100., 100.),
            rect("r2", 200., 150., 100., 100.),
        ]);
        draw_elbow(&mut s, "a", [0., 0.], [200., 200.], Some(Arrowhead::Arrow));
        let ed = editor(&mut s, "a", false);
        let ed = drag(&mut s, ed, [100., 100.], [115., 100.], NONE);
        assert_eq!(
            get(&s, "a")
                .elbow()
                .unwrap()
                .fixed_segments
                .as_ref()
                .map(|f| f.len()),
            Some(1)
        );
        close_points(
            &points(&s, "a"),
            &[[0., 0.], [110., 0.], [110., 200.], [190., 200.]],
        );
        // a double click on the fixed segment's midpoint lets it go
        let _ = ed.handle_double_click(&mut s, &ctx(), [105., 74.275], &NONE);
        close_points(
            &points(&s, "a"),
            &[[0., 0.], [110., 0.], [110., 200.], [190., 200.]],
        );
        assert!(validate_elbow_points(&points(&s, "a"), 1.));
    }

    #[test]
    fn moves_the_second_segment_of_an_unconnected_elbow_arrow() {
        setup();
        let mut s = Scene::new(vec![]);
        draw_elbow(&mut s, "a", [0., 0.], [250., 200.], Some(Arrowhead::Arrow));
        let ed = editor(&mut s, "a", false);
        let ed = drag(&mut s, ed, [125., 100.], [130., 100.], NONE);
        assert_eq!(
            points(&s, "a"),
            vec![[0., 0.], [130., 0.], [130., 200.], [250., 200.]]
        );
        match ed.handle_double_click(&mut s, &ctx(), [130., 100.], &NONE) {
            DoubleClickOutcome::SegmentReleased(_) => {}
            o => panic!("{o:?}"),
        }
        assert_eq!(
            points(&s, "a"),
            vec![[0., 0.], [125., 0.], [125., 200.], [250., 200.]]
        );
    }

    #[test]
    fn generates_orthogonal_arrow_points() {
        setup();
        let mut s = Scene::new(vec![elbow("a", 0., 0., vec![[0., 0.], [100., 100.]])]);
        route(&mut s, "a", vec![[-45., -100.1], [45., 99.9]]);
        let a = get(&s, "a");
        assert_eq!(
            a.points().unwrap(),
            &[[0., 0.], [0., 100.], [90., 100.], [90., 200.]]
        );
        assert_eq!((a.x, a.y, a.width, a.height), (-45., -100.1, 90., 200.));
    }

    #[test]
    fn moves_an_elbow_arrow_to_the_origin_while_routing() {
        setup();
        let mut s = Scene::new(vec![elbow("a", 5., 5., vec![[0., 0.], [100., 0.]])]);
        mutate_elbow_arrow(
            &mut s,
            "a",
            &ElbowUpdate {
                x: Some(0.),
                y: Some(0.),
                points: Some(vec![[0., 0.], [100., 0.]]),
                ..Default::default()
            },
            &ElbowOptions::default(),
            &NO_BINDING_HOOKS,
        );
        assert_eq!((get(&s, "a").x, get(&s, "a").y), (0., 0.));
    }

    #[test]
    fn generates_points_for_bound_elbow_arrow() {
        setup();
        let mut s = Scene::new(vec![
            rect("r1", -150., -150., 100., 100.),
            rect("r2", 50., 50., 100., 100.),
            elbow("a", -45., -100.1, vec![[0., 0.], [90., 200.]]),
        ]);
        bind_binding_element(
            "a",
            "r1",
            BindMode::Orbit,
            StartOrEnd::Start,
            &mut s,
            1.,
            None,
            true,
            true,
        );
        bind_binding_element(
            "a",
            "r2",
            BindMode::Orbit,
            StartOrEnd::End,
            &mut s,
            1.,
            None,
            true,
            true,
        );
        assert!(
            binding_of(get(&s, "a"), StartOrEnd::Start).is_some()
                && binding_of(get(&s, "a"), StartOrEnd::End).is_some()
        );
        route(&mut s, "a", vec![[0., 0.], [90., 200.]]);
        close_points(
            &points(&s, "a"),
            &[[0., 0.], [39., 0.], [39., 200.], [78., 200.]],
        );
        // from the right side to the left one, a binding gap off each
        let p = points(&s, "a");
        assert_eq!(p.len(), 4);
        close(get(&s, "a").x, -44., 6);
        close(get(&s, "a").x + p[3][0], 44., 6);
    }

    #[test]
    fn follows_bound_shapes() {
        setup();
        let mut s = Scene::new(vec![
            rect("r1", -150., -150., 100., 100.),
            rect("r2", 50., 50., 100., 100.),
        ]);
        draw_elbow(
            &mut s,
            "a",
            [-53., -99.],
            [53., 99.],
            Some(Arrowhead::Arrow),
        );
        let a = get(&s, "a");
        assert!(a.is_elbow_arrow());
        assert_eq!(binding_of(a, StartOrEnd::Start).unwrap().element_id, "r1");
        assert_eq!(binding_of(a, StartOrEnd::End).unwrap().element_id, "r2");
        close_points(
            &points(&s, "a"),
            &[[0., 0.], [39., 0.], [39., 200.], [78., 200.]],
        );
        // moving a bound shape reroutes it
        move_by(&mut s, "r2", 0., 100.);
        let p = points(&s, "a");
        assert!(validate_elbow_points(&p, 1.), "{p:?}");
        close(get(&s, "a").y + p[p.len() - 1][1], 200., 0);
    }

    // routes with one or two corners

    fn connect(s: &mut Scene, diamond_y: f64, end_arrowhead: Option<Arrowhead>) {
        // the rectangle's right side's middle is at y = 127.5
        s.insert_element(rect("r", 0., 100., 120., 55.));
        s.insert_element(shape(
            ElementType::Diamond,
            "d",
            220.,
            diamond_y,
            200.,
            124.,
        ));
        draw_elbow(s, "a", [120., 127.5], [320., diamond_y], end_arrowhead);
    }

    #[test]
    fn connects_elements_closer_than_the_padding_with_a_single_corner() {
        setup();
        let mut s = Scene::new(vec![]);
        // 40px from the rectangle's side to the diamond's top
        connect(&mut s, 167.5, Some(Arrowhead::Arrow));
        let p = points(&s, "a");
        assert_eq!(p.len(), 3, "{p:?}");
        close_points(&p, &[[0., 0.], [195., 0.], [195., 34.15]]);
    }

    #[test]
    fn routes_around_the_elements_when_a_single_corner_doesnt_fit() {
        setup();
        let mut s = Scene::new(vec![]);
        connect(&mut s, 167.5, Some(Arrowhead::Arrow));
        // the rectangle below the diamond's top: the corner would be inside it
        move_by(&mut s, "r", 0., 80.);
        assert!(points(&s, "a").len() > 3, "{:?}", points(&s, "a"));
    }

    #[test]
    fn doesnt_put_the_arrowhead_on_a_leg_too_short_for_it() {
        setup();
        let mut s = Scene::new(vec![]);
        // 25px from the rectangle's side to the diamond's top
        connect(&mut s, 152.5, Some(Arrowhead::Arrow));
        assert!(points(&s, "a").len() > 3, "{:?}", points(&s, "a"));
    }

    #[test]
    fn routes_again_to_fit_an_arrowhead_added_to_a_short_leg() {
        setup();
        let mut s = Scene::new(vec![]);
        // about 10px from the rectangle's side to the diamond's top
        connect(&mut s, 143.5, None);
        close_points(&points(&s, "a"), &[[0., 0.], [195., 0.], [195., 10.15]]);
        // actionChangeArrowhead: the arrowhead, then the route again
        s.mutate_element("a", true, |e| {
            e.linear_mut().unwrap().end_arrowhead = Some(Arrowhead::Arrow)
        });
        let u = update_elbow_arrow_route(get(&s, "a"), &s);
        s.mutate_element("a", true, |e| u.apply(e));
        let p = points(&s, "a");
        let (corner, end) = (p[p.len() - 2], p[p.len() - 1]);
        assert!(end[1] - corner[1] >= 25., "{p:?}");
    }

    #[test]
    fn doesnt_route_a_leg_too_short_to_keep_its_corner() {
        setup();
        let mut s = Scene::new(vec![
            rect("r1", 0., 0., 128., 100.),
            rect("r2", 100., 200., 128., 100.),
        ]);
        draw_elbow(
            &mut s,
            "a",
            [128., 50.],
            [139., 200.],
            Some(Arrowhead::Arrow),
        );
        let p = points(&s, "a");
        assert!(p.len() > 3, "{p:?}");
        assert!(validate_elbow_points(&p, 1.));
    }

    #[test]
    fn keeps_clear_of_an_element_by_its_binding_gap_thick_strokes_included() {
        let connect_ellipse = |stroke_width: f64| {
            setup();
            let mut e = shape(ElementType::Ellipse, "e", 220., 139.5, 200., 124.);
            e.stroke_width = stroke_width;
            let mut s = Scene::new(vec![rect("r", 0., 100., 120., 55.), e]);
            draw_elbow(&mut s, "a", [120., 127.5], [260., 151.9], None);
            points(&s, "a").len()
        };
        // a binding gap of 6px: the corner above the ellipse fits
        assert_eq!(connect_ellipse(2.), 3);
        // 15px: the first leg would run over the stroke
        assert!(connect_ellipse(20.) > 3);
    }

    #[test]
    fn connects_with_a_single_corner_when_a_fixed_segment_lines_up_with_the_start() {
        setup();
        let mut s = Scene::new(vec![]);
        connect(&mut s, 167.5, Some(Arrowhead::Arrow));
        // a step down: routed around the diamond, the segment above it fixed
        move_by(&mut s, "r", 0., 20.);
        let seg = FixedSegment {
            index: 3,
            start: [44., -20.],
            end: [195., -20.],
        };
        mutate_elbow_arrow(
            &mut s,
            "a",
            &ElbowUpdate {
                fixed_segments: Some(Some(vec![seg])),
                ..Default::default()
            },
            &ElbowOptions::default(),
            &NO_BINDING_HOOKS,
        );
        close_points(
            &points(&s, "a"),
            &[
                [0., 0.],
                [44., 0.],
                [44., -20.],
                [195., -20.],
                [195., 14.15],
            ],
        );
        // and back up: the first leg lines up with the fixed segment
        move_by(&mut s, "r", 0., -20.);
        renormalize_elbow_arrow(&mut s, "a", &NO_BINDING_HOOKS);
        assert_eq!(
            get(&s, "a")
                .elbow()
                .unwrap()
                .fixed_segments
                .clone()
                .unwrap_or_default(),
            vec![]
        );
        close_points(&points(&s, "a"), &[[0., 0.], [195., 0.], [195., 34.15]]);
    }

    fn connect_below(s: &mut Scene, gap: f64, end_arrowhead: Option<Arrowhead>) {
        s.insert_element(rect("r1", 0., 0., 278., 135.));
        s.insert_element(rect("r2", 518., 135. + gap, 278., 135.));
        draw_elbow(s, "a", [139., 135.], [657., 135. + gap], end_arrowhead);
    }

    #[test]
    fn connects_closer_than_the_padding_with_two_corners_turning_halfway() {
        setup();
        let mut s = Scene::new(vec![]);
        connect_below(&mut s, 84., None);
        let p = points(&s, "a");
        assert_eq!(p.len(), 4, "{p:?}");
        close_points(&p, &[[0., 0.], [0., 36.], [518., 36.], [518., 72.]]);
        close(p[1][1], p[3][1] / 2., 6);
    }

    #[test]
    fn turns_closer_to_the_end_without_an_arrowhead_to_leave_the_arrowhead_the_padding() {
        setup();
        let mut s = Scene::new(vec![]);
        connect_below(&mut s, 84., Some(Arrowhead::Arrow));
        let p = points(&s, "a");
        assert_eq!(p.len(), 4, "{p:?}");
        close_points(&p, &[[0., 0.], [0., 32.], [518., 32.], [518., 72.]]);
        close(p[3][1] - p[2][1], 40., 6);
    }

    #[test]
    fn turns_halfway_as_on_the_grid_when_theres_room() {
        setup();
        let mut s = Scene::new(vec![]);
        connect_below(&mut s, 120., Some(Arrowhead::Arrow));
        let p = points(&s, "a");
        assert_eq!(p.len(), 4, "{p:?}");
        close_points(&p, &[[0., 0.], [0., 54.], [518., 54.], [518., 108.]]);
    }

    #[test]
    fn doesnt_put_the_arrowhead_on_a_half_too_short_for_it() {
        setup();
        let mut s = Scene::new(vec![]);
        connect_below(&mut s, 40., Some(Arrowhead::Arrow));
        assert!(points(&s, "a").len() > 4, "{:?}", points(&s, "a"));
    }

    // board_binding.rs's skipped elbow case, and restore

    #[test]
    fn elbow_arrow_is_not_snapped_when_binding_is_disabled() {
        setup();
        let mut s = Scene::new(vec![
            rect("r", 100., 0., 100., 100.),
            elbow("a", 0., 50., vec![[0., 0.], [10., 0.]]),
        ]);
        let end = |s: &Scene| {
            let a = get(s, "a");
            let p = a.points().unwrap();
            [a.x + p[p.len() - 1][0], a.y + p[p.len() - 1][1]]
        };
        // dragging the end over the rectangle with binding off: no snap
        mutate_elbow_arrow(
            &mut s,
            "a",
            &ElbowUpdate {
                points: Some(vec![[0., 0.], [130., 20.]]),
                ..Default::default()
            },
            &ElbowOptions {
                is_dragging: true,
                is_binding_enabled: Some(false),
                ..Default::default()
            },
            &NO_BINDING_HOOKS,
        );
        assert_eq!(end(&s), [130., 70.]);
        // with binding on it snaps to the nearest side's outline, a gap off
        mutate_elbow_arrow(
            &mut s,
            "a",
            &ElbowUpdate {
                points: Some(vec![[0., 0.], [130., 20.]]),
                ..Default::default()
            },
            &ElbowOptions {
                is_dragging: true,
                ..Default::default()
            },
            &NO_BINDING_HOOKS,
        );
        assert_eq!(end(&s), [130., 106.]);
        assert!(validate_elbow_points(&points(&s, "a"), 1.));
    }

    #[test]
    fn restore_reroutes_unbound_elbow_arrows_with_invalid_points() {
        use lattice_board_core::board::restore::{RestoreOpts, restore_elements};
        setup();
        let raw = serde_json::json!([{ "id": "a", "type": "arrow", "elbowed": true, "x": 0, "y": 0, "width": 100, "height": 100,
            "points": [[0, 0], [100, 100]] }]);
        let out = restore_elements(
            Some(&raw),
            None,
            &RestoreOpts {
                repair_bindings: true,
                ..Default::default()
            },
        );
        let p = out[0].points().unwrap();
        assert!(validate_elbow_points(p, 1.) && p.len() > 2, "{p:?}");
        assert_eq!(p[p.len() - 1], [100., 100.]);
    }

    // -----------------------------------------------------------------------
    // linearElementEditor.test.tsx
    // -----------------------------------------------------------------------

    const P1: Point = [20., 20.];
    const P2: Point = [60., 20.];
    const MID: Point = [40., 20.];
    const DELTA: f64 = 50.;

    fn two_pointer(ty: ElementType, roundness: Option<Roundness>) -> Scene {
        setup();
        let pts = vec![[0., 0.], [P2[0] - P1[0], P2[1] - P1[1]]];
        Scene::new(vec![if ty == ElementType::Arrow {
            arrow("l", P1[0], P1[1], pts, roundness)
        } else {
            line("l", P1[0], P1[1], pts, roundness)
        }])
    }
    fn three_pointer(ty: ElementType, roundness: Option<Roundness>) -> Scene {
        setup();
        let p3 = [MID[0] + DELTA - P1[0], MID[1] + DELTA - P1[1]];
        let pts = vec![[0., 0.], p3, [P2[0] - P1[0], P2[1] - P1[1]]];
        Scene::new(vec![if ty == ElementType::Arrow {
            arrow("l", P1[0], P1[1], pts, roundness)
        } else {
            line("l", P1[0], P1[1], pts, roundness)
        }])
    }

    #[test]
    fn normalizes_the_element_points_at_creation() {
        setup();
        let mut s = Scene::new(vec![arrow(
            "a",
            0.,
            0.,
            vec![[0.5, 0.], [100., 100.]],
            None,
        )]);
        assert_eq!(points(&s, "a"), vec![[0.5, 0.], [100., 100.]]);
        editor(&mut s, "a", false);
        assert_eq!(points(&s, "a"), vec![[0., 0.], [99.5, 100.]]);
    }

    #[test]
    fn doesnt_drag_or_add_a_midpoint_until_dragged_beyond_a_threshold() {
        let mut s = two_pointer(ElementType::Line, None);
        let (x, y) = (get(&s, "l").x, get(&s, "l").y);
        let ed = editor(&mut s, "l", false);
        let ed = click(&mut s, ed, MID);
        let ed = drag(&mut s, ed, MID, [MID[0] + 1., MID[1] + 1.], NONE);
        assert_eq!(points(&s, "l").len(), 2);
        assert_eq!((get(&s, "l").x, get(&s, "l").y), (x, y));
        drag(&mut s, ed, MID, [MID[0] + DELTA, MID[1] + DELTA], NONE);
        assert_eq!((get(&s, "l").x, get(&s, "l").y), (x, y));
        assert_eq!(points(&s, "l").len(), 3);
    }

    #[test]
    fn drags_a_two_pointer_line_from_its_midpoint_outside_the_editor() {
        let mut s = two_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", false);
        drag(&mut s, ed, MID, [MID[0] + DELTA, MID[1] + DELTA], NONE);
        assert_eq!(points(&s, "l"), vec![[0., 0.], [70., 50.], [40., 0.]]);
    }

    #[test]
    fn toggles_the_editor() {
        let mut s = two_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", false);
        assert!(can_toggle_linear_editor(&[get(&s, "l")], Some(&ed)));
        // a double click on a line opens it
        assert_eq!(
            ed.handle_double_click(&mut s, &ctx(), MID, &NONE),
            DoubleClickOutcome::ToggleEditor
        );
        let ed = toggle_linear_editor(&ed);
        assert!(ed.is_editing && !can_toggle_linear_editor(&[get(&s, "l")], Some(&ed)));
        // simple arrows want Ctrl/Cmd; elbow arrows don't open at all
        let mut s = two_pointer(ElementType::Arrow, None);
        let ed = editor(&mut s, "l", false);
        assert_eq!(
            ed.handle_double_click(&mut s, &ctx(), MID, &NONE),
            DoubleClickOutcome::None
        );
        assert_eq!(
            ed.handle_double_click(
                &mut s,
                &ctx(),
                MID,
                &Modifiers {
                    ctrl_or_cmd: true,
                    ..NONE
                }
            ),
            DoubleClickOutcome::ToggleEditor
        );
        let e = elbow("e", 0., 0., vec![[0., 0.], [100., 0.]]);
        assert!(!can_toggle_linear_editor(&[&e], None));
    }

    // inside the editor

    #[test]
    fn inside_the_editor_a_midpoint_drag_adds_a_point_regardless_of_threshold() {
        let mut s = two_pointer(ElementType::Line, None);
        let (x, y) = (get(&s, "l").x, get(&s, "l").y);
        let ed = editor(&mut s, "l", true);
        let ed = click(&mut s, ed, MID);
        assert_eq!(points(&s, "l").len(), 2);
        drag(&mut s, ed, MID, [MID[0] + 1., MID[1] + 1.], NONE);
        assert_eq!((get(&s, "l").x, get(&s, "l").y), (x, y));
        assert_eq!(points(&s, "l").len(), 3);
    }

    #[test]
    fn inside_the_editor_drags_a_two_pointer_line_from_its_midpoint() {
        let mut s = two_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", true);
        drag(&mut s, ed, MID, [MID[0] + DELTA, MID[1] + DELTA], NONE);
        assert_eq!(points(&s, "l"), vec![[0., 0.], [70., 50.], [40., 0.]]);
    }

    #[test]
    fn updates_the_midpoints_when_the_roundness_changes() {
        let mut s = three_pointer(ElementType::Line, None);
        let sharp = mids(&s, "l", true);
        s.mutate_element("l", true, |e| e.roundness = ROUND);
        let round = mids(&s, "l", true);
        assert_ne!(round[0], sharp[0]);
        assert_ne!(round[1], sharp[1]);
        close_point(round[0].unwrap(), [54.27552, 46.16120], 5);
        close_point(round[1].unwrap(), [76.95494, 44.56052], 5);
    }

    #[test]
    fn updates_all_the_midpoints_when_the_element_moves() {
        let mut s = three_pointer(ElementType::Line, ROUND);
        let ed = editor(&mut s, "l", true);
        let pts = get_points_global_coordinates(get(&s, "l"), &s);
        assert_eq!([get(&s, "l").x, get(&s, "l").y], pts[0]);
        let m = mids(&s, "l", true);
        let start = point_center(pts[0], m[0].unwrap());
        // grabbing the line between handles is the app's element drag
        let r = ed.handle_pointer_down(&mut s, &ctx(), start, &NONE, false);
        assert_eq!(r.hit_element, None);
        assert_eq!(
            r.linear_element_editor.unwrap().handle_drag(
                &mut s,
                &ctx(),
                [start[0] + 50., start[1] + 20.],
                &NONE
            ),
            DragOutcome::NotHandled
        );
        move_by(&mut s, "l", 50., 20.);
        assert_eq!(
            [get(&s, "l").x, get(&s, "l").y],
            [pts[0][0] + 50., pts[0][1] + 20.]
        );
        let n = mids(&s, "l", true);
        close_point(n[0].unwrap(), [104.27552, 66.16120], 5);
        close_point(n[1].unwrap(), [126.95494, 64.56052], 5);
    }

    #[test]
    fn sharp_lines_drag_from_midpoints_between_segments() {
        let mut s = three_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", true);
        let (first, last) = ([55., 45.], [75., 40.]);
        let ed = drag(
            &mut s,
            ed,
            first,
            [first[0] + DELTA, first[1] + DELTA],
            NONE,
        );
        assert_eq!(points(&s, "l").len(), 4);
        drag(&mut s, ed, last, [last[0] + DELTA, last[1] + DELTA], NONE);
        assert_eq!(
            points(&s, "l"),
            vec![[0., 0.], [85., 75.], [70., 50.], [105., 70.], [40., 0.]]
        );
    }

    #[test]
    fn sharp_lines_update_only_the_first_segment_midpoint_when_its_point_is_dragged() {
        let mut s = three_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", true);
        let pts = get_points_global_coordinates(get(&s, "l"), &s);
        let m = mids(&s, "l", true);
        drag(
            &mut s,
            ed,
            pts[0],
            [pts[0][0] - DELTA, pts[0][1] - DELTA],
            NONE,
        );
        assert_eq!(
            get_points_global_coordinates(get(&s, "l"), &s)[0],
            [pts[0][0] - DELTA, pts[0][1] - DELTA]
        );
        let n = mids(&s, "l", true);
        assert_ne!(m[0], n[0]);
        assert_eq!(m[1], n[1]);
    }

    #[test]
    fn sharp_lines_hide_midpoints_when_points_move_close() {
        let mut s = three_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", true);
        let pts = get_points_global_coordinates(get(&s, "l"), &s);
        let m = mids(&s, "l", true);
        drag(
            &mut s,
            ed,
            pts[0],
            [pts[0][0] + DELTA, pts[0][1] + DELTA],
            NONE,
        );
        assert_eq!(
            get_points_global_coordinates(get(&s, "l"), &s)[0],
            [pts[0][0] + DELTA, pts[0][1] + DELTA]
        );
        let n = mids(&s, "l", true);
        assert_eq!(n[0], None);
        assert_eq!(m[1], n[1]);
    }

    #[test]
    fn sharp_lines_lose_the_midpoint_when_a_point_of_the_segment_is_deleted() {
        let mut s = three_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", true);
        let pts = get_points_global_coordinates(get(&s, "l"), &s);
        let last = [75., 40.];
        let ed = drag(&mut s, ed, last, [last[0] + 50., last[1] + 50.], NONE);
        assert_eq!(points(&s, "l").len(), 4);
        let m = mids(&s, "l", true);
        // click the 3rd point and press Delete
        let ed = click(&mut s, ed, pts[2]);
        delete_points(
            &mut s,
            "l",
            ed.selected_points_indices.as_deref().unwrap(),
            Some(&ed),
            &NO_BINDING_HOOKS,
        );
        assert_eq!(points(&s, "l").len(), 3);
        let n = mids(&s, "l", true);
        assert_eq!(n.len(), 2);
        assert_eq!((m[0], m[1]), (n[0], n[1]));
    }

    const ROUND_FIRST_MID: Point = [55.9697848965255, 47.442326230998205];
    const ROUND_LAST_MID: Point = [76.08587175006699, 43.294165939653226];

    #[test]
    fn round_lines_drag_from_midpoints_between_segments() {
        let mut s = three_pointer(ElementType::Line, ROUND);
        let ed = editor(&mut s, "l", true);
        let ed = drag(
            &mut s,
            ed,
            ROUND_FIRST_MID,
            [ROUND_FIRST_MID[0] + DELTA, ROUND_FIRST_MID[1] + DELTA],
            NONE,
        );
        assert_eq!(points(&s, "l").len(), 4);
        drag(
            &mut s,
            ed,
            ROUND_LAST_MID,
            [ROUND_LAST_MID[0] + DELTA, ROUND_LAST_MID[1] + DELTA],
            NONE,
        );
        let p = points(&s, "l");
        assert_eq!(p.len(), 5);
        for (a, e) in p.iter().zip([
            [0., 0.],
            [85.96978, 77.44233],
            [70., 50.],
            [106.08587, 73.29417],
            [40., 0.],
        ]) {
            close_point(*a, e, 5);
        }
    }

    #[test]
    fn round_lines_update_all_the_midpoints_when_a_point_is_dragged() {
        let mut s = three_pointer(ElementType::Line, ROUND);
        let ed = editor(&mut s, "l", true);
        let pts = get_points_global_coordinates(get(&s, "l"), &s);
        let m = mids(&s, "l", true);
        drag(
            &mut s,
            ed,
            pts[0],
            [pts[0][0] - DELTA, pts[0][1] - DELTA],
            NONE,
        );
        assert_eq!(
            get_points_global_coordinates(get(&s, "l"), &s)[0],
            [pts[0][0] - DELTA, pts[0][1] - DELTA]
        );
        let n = mids(&s, "l", true);
        assert_ne!(m[0], n[0]);
        assert_ne!(m[1], n[1]);
        close_point(n[0].unwrap(), [29.28349, 20.91105], 5);
        close_point(n[1].unwrap(), [78.86048, 46.12277], 5);
    }

    #[test]
    fn round_lines_hide_midpoints_when_points_move_close() {
        let mut s = three_pointer(ElementType::Line, ROUND);
        let ed = editor(&mut s, "l", true);
        let pts = get_points_global_coordinates(get(&s, "l"), &s);
        let m = mids(&s, "l", true);
        drag(
            &mut s,
            ed,
            pts[0],
            [pts[0][0] + DELTA, pts[0][1] + DELTA],
            NONE,
        );
        assert_eq!(
            get_points_global_coordinates(get(&s, "l"), &s)[0],
            [pts[0][0] + DELTA, pts[0][1] + DELTA]
        );
        let n = mids(&s, "l", true);
        assert_eq!(n[0], None);
        assert_ne!(n[1], m[1]);
    }

    #[test]
    fn round_lines_update_all_the_midpoints_when_a_point_is_deleted() {
        let mut s = three_pointer(ElementType::Line, ROUND);
        let ed = editor(&mut s, "l", true);
        let ed = drag(
            &mut s,
            ed,
            ROUND_LAST_MID,
            [ROUND_LAST_MID[0] + DELTA, ROUND_LAST_MID[1] + DELTA],
            NONE,
        );
        assert_eq!(points(&s, "l").len(), 4);
        let m = mids(&s, "l", true);
        let pts = get_points_global_coordinates(get(&s, "l"), &s);
        let ed = click(&mut s, ed, pts[2]);
        delete_points(
            &mut s,
            "l",
            ed.selected_points_indices.as_deref().unwrap(),
            Some(&ed),
            &NO_BINDING_HOOKS,
        );
        assert_eq!(points(&s, "l").len(), 3);
        let n = mids(&s, "l", true);
        assert_eq!(n.len(), 2);
        assert_ne!(m[0], n[0]);
        assert_ne!(m[1], n[1]);
        close_point(n[0].unwrap(), [54.27552, 46.16120], 5);
        close_point(n[1].unwrap(), [76.95494, 44.56052], 5);
    }

    #[test]
    fn drags_a_line_point_covered_by_another_element_in_the_editor() {
        let mut s = two_pointer(ElementType::Line, None);
        let l = get(&s, "l").clone();
        let mut r = rect("r", l.x - 50., l.y - 50., 100., 100.);
        r.background_color = "red".into();
        s.insert_element(r);
        let ed = editor(&mut s, "l", true);
        drag(&mut s, ed, [l.x, l.y], [100. + l.x, 100. + l.y], NONE);
        assert_eq!(points(&s, "l"), vec![[0., 0.], [-60., -100.]]);
    }

    // bound text

    fn with_label(s: &mut Scene) {
        let t = new_text_element(
            TextOpts {
                text: "Online whiteboard collaboration made easy".into(),
                container_id: Some("l".into()),
                ..Default::default()
            },
            ElementOpts {
                id: Some("t".into()),
                ..Default::default()
            },
            &lattice_board_core::board::text_measure::TestMeasure,
        );
        s.mutate_element("l", true, |e| {
            e.bound_elements = Some(vec![BoundElement {
                id: "t".into(),
                kind: BoundType::Text,
            }])
        });
        s.insert_element(t);
        s.mutate_element("t", true, |e| {
            e.width = 30.;
            e.height = 20.;
        });
    }

    #[test]
    fn label_position_for_a_two_pointer_arrow() {
        let mut s = two_pointer(ElementType::Arrow, None);
        with_label(&mut s);
        assert_eq!(
            get_bound_text_element_position(get(&s, "l"), get(&s, "t"), &s),
            [25., 10.]
        );
    }

    #[test]
    fn label_position_for_an_arrow_with_odd_points() {
        let mut s = three_pointer(ElementType::Arrow, ROUND);
        with_label(&mut s);
        assert_eq!(
            get_bound_text_element_position(get(&s, "l"), get(&s, "t"), &s),
            [75., 60.]
        );
    }

    #[test]
    fn label_position_for_an_arrow_with_even_points() {
        let mut s = three_pointer(ElementType::Arrow, ROUND);
        with_label(&mut s);
        let ed = editor(&mut s, "l", true);
        drag(
            &mut s,
            ed,
            ROUND_FIRST_MID,
            [ROUND_FIRST_MID[0] + DELTA, ROUND_FIRST_MID[1] + DELTA],
            NONE,
        );
        close_point(
            get_bound_text_element_position(get(&s, "l"), get(&s, "t"), &s),
            [86.17305, 76.11251],
            5,
        );
    }

    #[test]
    fn point_at_path_parameter_survives_midpoint_insertion() {
        setup();
        let mut s = Scene::new(vec![arrow("a", 0., 0., vec![[0., 0.], [100., 0.]], None)]);
        let before = get_point_at_path_parameter(get(&s, "a"), 0.25, &s).unwrap();
        close_point(before, [25., 0.], 2);
        s.mutate_element("a", true, |e| {
            *e.points_mut().unwrap() = vec![[0., 0.], [50., 0.], [100., 0.]]
        });
        close_point(
            get_point_at_path_parameter(get(&s, "a"), 0.25, &s).unwrap(),
            before,
            2,
        );
    }

    #[test]
    fn point_at_path_parameter_uses_the_unrounded_path_of_elbow_arrows() {
        setup();
        let s = Scene::new(vec![elbow(
            "a",
            0.,
            0.,
            vec![[0., 0.], [100., 0.], [100., 100.]],
        )]);
        let expected = [[0., 0.], [50., 0.], [100., 0.], [100., 50.], [100., 100.]];
        for (i, t) in [0., 0.25, 0.5, 0.75, 1.].into_iter().enumerate() {
            assert_eq!(
                get_point_at_path_parameter(get(&s, "a"), t, &s),
                Some(expected[i])
            );
        }
    }

    #[test]
    fn slides_the_label_along_the_arrow() {
        let mut s = two_pointer(ElementType::Arrow, None);
        with_label(&mut s);
        let ed = editor(&mut s, "l", false);
        // near the midpoint knob, the knob wins
        assert!(
            !ed.handle_pointer_down(&mut s, &ctx(), [30., 22.], &NONE, true)
                .hit_bound_text
        );
        // grabbed off its center (the label is centered on the midpoint)
        let r = ed.handle_pointer_down(&mut s, &ctx(), [50., 29.], &NONE, true);
        assert!(r.hit_bound_text && r.hit_element.is_some());
        let ed = r.linear_element_editor.unwrap();
        assert_eq!(ed.pointer_offset, [10., 9.]);
        let ed = ed.handle_bound_text_dragging(&mut s, [60., 29.]).unwrap();
        assert!(ed.is_dragging);
        close(
            get(&s, "t")
                .text()
                .unwrap()
                .label_position
                .unwrap()
                .unwrap(),
            0.75,
            6,
        );
        close_point(
            get_bound_text_element_position(get(&s, "l"), get(&s, "t"), &s),
            [35., 10.],
            6,
        );
    }

    // moving points

    #[test]
    fn moves_the_end_back_while_the_start_moves_forward() {
        let mut s = three_pointer(ElementType::Arrow, None);
        let (x, y) = (get(&s, "l").x, get(&s, "l").y);
        let p = points(&s, "l");
        let n = p.len();
        let u = PointsPositionUpdates::from([
            (0, PointUpdate::at([p[0][0] + 10., p[0][1] + 10.])),
            (
                n - 1,
                PointUpdate::at([p[n - 1][0] - 10., p[n - 1][1] - 10.]),
            ),
        ]);
        move_points(
            "l",
            &mut s,
            &u,
            None,
            &MovePointsOpts::default(),
            &NO_BINDING_HOOKS,
        );
        assert_eq!((get(&s, "l").x, get(&s, "l").y), (x + 10., y + 10.));
        assert_eq!(points(&s, "l")[n - 1], [20., -20.]);
    }

    #[test]
    fn moves_midpoints_with_the_element() {
        let mut s = three_pointer(ElementType::Arrow, None);
        let (x, y) = (get(&s, "l").x, get(&s, "l").y);
        let p = points(&s, "l");
        let u = PointsPositionUpdates::from([
            (0, PointUpdate::at([10., 10.])),
            (2, PointUpdate::at([p[2][0] + 10., p[2][1] + 10.])),
        ]);
        move_points(
            "l",
            &mut s,
            &u,
            None,
            &MovePointsOpts {
                move_mid_points_with_element: true,
                ..Default::default()
            },
            &NO_BINDING_HOOKS,
        );
        assert_eq!((get(&s, "l").x, get(&s, "l").y), (x + 10., y + 10.));
        assert_eq!(points(&s, "l")[1], p[1]);
        assert_eq!(points(&s, "l")[2], p[2]);
    }

    #[test]
    fn shift_drag_keeps_the_original_angle() {
        let mut s = two_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", true);
        let pts = get_points_global_coordinates(get(&s, "l"), &s);
        let angle = (pts[1][1] - pts[0][1]).atan2(pts[1][0] - pts[0][0]);
        drag(&mut s, ed, pts[1], [pts[1][0] + 4., pts[1][1] + 4.], SHIFT);
        let np = get_points_global_coordinates(get(&s, "l"), &s);
        assert!(((np[1][1] - np[0][1]).atan2(np[1][0] - np[0][0]) - angle).abs() < 0.01);
    }

    // the editor's other actions (no upstream test of their own)

    #[test]
    fn alt_adds_points_and_the_pending_point_follows_the_pointer() {
        let mut s = two_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", true);
        let alt = Modifiers { alt: true, ..NONE };
        // with Alt held, a pending point follows the pointer…
        let ed = ed
            .handle_pointer_move_in_edit_mode(&mut s, &ctx(), [100., 60.], &alt)
            .unwrap();
        assert_eq!(points(&s, "l"), vec![[0., 0.], [40., 0.], [80., 40.]]);
        let ed = ed
            .handle_pointer_move_in_edit_mode(&mut s, &ctx(), [110., 70.], &alt)
            .unwrap();
        assert_eq!(points(&s, "l"), vec![[0., 0.], [40., 0.], [90., 50.]]);
        // …and goes away when Alt is let go
        let ed = ed
            .handle_pointer_move_in_edit_mode(&mut s, &ctx(), [110., 70.], &NONE)
            .unwrap();
        assert_eq!(points(&s, "l").len(), 2);
        assert_eq!(ed.last_uncommitted_point, None);
        // an Alt click commits a point
        let r = ed.handle_pointer_down(&mut s, &ctx(), [120., 20.], &alt, false);
        assert!(r.did_add_point && r.capture);
        assert_eq!(points(&s, "l"), vec![[0., 0.], [40., 0.], [100., 0.]]);
        assert_eq!(
            r.linear_element_editor.unwrap().selected_points_indices,
            Some(vec![2])
        );
    }

    #[test]
    fn duplicates_the_selected_points() {
        let mut s = three_pointer(ElementType::Line, None);
        let mut ed = editor(&mut s, "l", true);
        ed.selected_points_indices = Some(vec![0, 2]);
        let ed = ed
            .duplicate_selected_points(&mut s, &NO_BINDING_HOOKS)
            .unwrap();
        assert_eq!(ed.selected_points_indices, Some(vec![1, 4]));
        assert_eq!(
            points(&s, "l"),
            vec![[0., 0.], [35., 25.], [70., 50.], [40., 0.], [70., 30.]]
        );
    }

    #[test]
    fn box_selection_selects_the_points_inside() {
        let mut s = three_pointer(ElementType::Line, None);
        let ed = editor(&mut s, "l", true);
        let ed = ed
            .handle_box_selection([0., 0., 70., 30.], false, &s)
            .unwrap();
        assert_eq!(ed.selected_points_indices, Some(vec![0, 2]));
        let ed = LinearElementEditor {
            selected_points_indices: Some(vec![1]),
            ..ed
        };
        assert_eq!(
            ed.handle_box_selection([0., 0., 30., 30.], true, &s)
                .unwrap()
                .selected_points_indices,
            Some(vec![0, 1])
        );
    }

    #[test]
    fn dragging_an_end_onto_the_other_closes_a_line_into_a_polygon() {
        setup();
        let mut s = Scene::new(vec![line(
            "l",
            0.,
            0.,
            vec![[0., 0.], [100., 0.], [100., 100.], [0., 100.]],
            None,
        )]);
        let ed = editor(&mut s, "l", true);
        drag(&mut s, ed, [0., 100.], [2., 3.], NONE);
        let l = get(&s, "l");
        assert!(l.is_line_polygon());
        let p = l.points().unwrap();
        assert_eq!(p[0], p[p.len() - 1]);
    }

    #[test]
    fn toggles_polygons() {
        setup();
        let l = line(
            "l",
            0.,
            0.,
            vec![[0., 0.], [100., 0.], [100., 100.], [0., 100.]],
            None,
        );
        assert!(can_toggle_polygon(&[&l]));
        let out = toggle_polygon(&[&l]).unwrap();
        assert!(out[0].is_line_polygon());
        assert_eq!(out[0].points().unwrap().len(), 5);
        let back = toggle_polygon(&[&out[0]]).unwrap();
        assert!(!back[0].is_line_polygon());
        assert_eq!(back[0].background_color, "transparent");
        let r = rect("r", 0., 0., 10., 10.);
        assert!(!can_toggle_polygon(&[&r]) && toggle_polygon(&[&r]).is_none());
    }

    #[test]
    fn finalizing_a_multi_point_line_drops_the_pending_point_and_closes_the_loop() {
        setup();
        // the last point followed the pointer; the one before is back near
        // the start
        let mut s = Scene::new(vec![line(
            "l",
            0.,
            0.,
            vec![[0., 0.], [100., 0.], [100., 100.], [3., 2.], [50., 50.]],
            None,
        )]);
        let mut ed = editor(&mut s, "l", false);
        ed.last_committed_point = Some([3., 2.]);
        let (commit, next) = finalize_element(
            "l",
            Some(&ed),
            &FinalizeElement {
                multi_element: true,
                touch: false,
            },
            &mut s,
            &new_ctx(),
        );
        assert!(!commit);
        let l = get(&s, "l");
        assert_eq!(l.points().unwrap().len(), 4);
        assert!(l.is_line_polygon());
        assert_eq!(l.points().unwrap()[3], [0., 0.]);
        assert!(!next.unwrap().is_editing);
    }

    #[test]
    fn finalizing_deletes_a_too_short_arrow() {
        setup();
        let mut s = Scene::new(vec![arrow("a", 0., 0., vec![[0., 0.], [0.05, 0.]], None)]);
        let ed = editor(&mut s, "a", false);
        let (_, deleted) = finalize_linear_gesture(
            &ed,
            &mut s,
            &new_ctx(),
            &FinalizePointer {
                scene_coords: [0.05, 0.],
                ..Default::default()
            },
            false,
        );
        assert!(deleted && get(&s, "a").is_deleted);
    }

    #[test]
    fn dragging_an_arrow_end_suggests_a_binding_moves_the_arrow_above_and_binds_on_release() {
        setup();
        let mut s = Scene::new(vec![
            arrow("a", 0., 0., vec![[0., 0.], [50., 0.]], None),
            rect("r", 100., -50., 100., 100.),
        ]);
        let ed = editor(&mut s, "a", false);
        let r = ed.handle_pointer_down(&mut s, &ctx(), [50., 0.], &NONE, false);
        assert_eq!(r.hit_element.as_deref(), Some("a"));
        let ed = r.linear_element_editor.unwrap();
        let (ed, suggested) = match ed.handle_drag(&mut s, &ctx(), [150., 0.], &NONE) {
            DragOutcome::Dragged(e, sb) => (e, sb),
            o => panic!("{o:?}"),
        };
        assert_eq!(suggested.map(|b| b.element), Some("r".to_string()));
        assert!(s.get_element_index("a") > s.get_element_index("r"));
        let ed = up(&mut s, ed, [150., 0.], NONE, true);
        assert_eq!(
            binding_of(get(&s, "a"), StartOrEnd::End).map(|b| b.element_id.as_str()),
            Some("r")
        );
        assert_eq!(ed.selected_points_indices, None);
    }

    // -----------------------------------------------------------------------
    // flowchart.test.tsx
    // -----------------------------------------------------------------------

    struct Chart {
        s: Scene,
        creator: FlowChartCreator,
        nav: FlowChartNavigator,
        selected: String,
    }

    impl Chart {
        fn new(root: Element) -> Chart {
            setup();
            let id = root.id.clone();
            Chart {
                s: Scene::new(vec![root]),
                creator: FlowChartCreator::default(),
                nav: FlowChartNavigator::default(),
                selected: id,
            }
        }
        /// Ctrl+arrow while Ctrl is held.
        fn press(&mut self, d: LinkDirection) {
            let sel = self.selected.clone();
            if get(&self.s, &sel).is_flowchart_node() {
                self.creator.create_nodes(
                    &sel,
                    Some(Arrowhead::Arrow),
                    1.,
                    d,
                    &mut self.s,
                    &NO_BINDING_HOOKS,
                );
            }
        }
        /// Ctrl released: the pending nodes go in, the first one selected.
        fn release(&mut self) {
            if !self.creator.is_creating_chart {
                return;
            }
            let nodes = self.creator.pending_nodes.clone().unwrap_or_default();
            self.creator.clear();
            if let Some(f) = nodes.first() {
                self.selected = f.id.clone();
            }
            self.s.insert_elements_at_index(nodes, None);
        }
        fn add(&mut self, d: LinkDirection, n: usize) {
            for _ in 0..n {
                self.press(d);
            }
            self.release();
        }
        fn create(&mut self, d: LinkDirection) -> String {
            self.add(d, 1);
            self.selected.clone()
        }
        fn navigate(&mut self, ds: &[LinkDirection]) {
            for &d in ds {
                let el = get(&self.s, &self.selected).clone();
                if let Some(n) = self.nav.explore_by_direction(&el, &self.s, d) {
                    self.selected = n;
                }
            }
            self.nav.clear();
        }
        fn count(&self, ty: ElementType) -> usize {
            self.s
                .non_deleted_elements()
                .filter(|e| e.ty() == ty)
                .count()
        }
        fn children(&self, parent: &str) -> Vec<Element> {
            self.s
                .non_deleted_elements()
                .filter(|e| e.ty() == ElementType::Rectangle && e.id != parent)
                .cloned()
                .collect()
        }
        fn pending_rects(&self) -> Vec<(f64, f64)> {
            self.creator
                .pending_nodes
                .iter()
                .flatten()
                .filter(|e| e.ty() == ElementType::Rectangle)
                .map(|e| (e.x, e.y))
                .collect()
        }
        fn set(&mut self, id: &str, f: impl FnOnce(&mut Element)) {
            self.s.mutate_element(id, true, f);
        }
    }
    use LinkDirection::*;
    fn overlaps(a: &Element, b: &Element) -> bool {
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    }
    fn root() -> Element {
        rect("root", 0., 0., 200., 100.)
    }

    #[test]
    fn creates_multiple_successor_nodes_at_once() {
        let mut c = Chart::new(root());
        c.add(Right, 2);
        assert_eq!(c.s.non_deleted_len(), 5);
        assert_eq!(
            (c.count(ElementType::Rectangle), c.count(ElementType::Arrow)),
            (3, 2)
        );
        // elbow arrows bound at both ends, routed
        for a in c.s.non_deleted_elements().filter(|e| e.is_arrow()) {
            assert!(a.is_elbow_arrow());
            assert_eq!(binding_of(a, StartOrEnd::Start).unwrap().element_id, "root");
            assert!(binding_of(a, StartOrEnd::End).is_some());
            assert!(validate_elbow_points(a.points().unwrap(), 1.));
        }
        // the root lists them (and, as upstream, the arrow of the first,
        // superseded pending node)
        let listed = get(&c.s, "root").bound_elements.clone().unwrap();
        assert!(
            c.s.non_deleted_elements()
                .filter(|e| e.is_arrow())
                .all(|a| listed.iter().any(|b| b.id == a.id))
        );
        assert_eq!(listed.len(), 3);
    }

    #[test]
    fn only_the_last_direction_applies() {
        let mut c = Chart::new(root());
        for d in [Right, Right, Right, Left, Up, Up, Up] {
            c.press(d);
        }
        c.release();
        assert_eq!(c.s.non_deleted_len(), 7);
        assert_eq!(
            (c.count(ElementType::Rectangle), c.count(ElementType::Arrow)),
            (4, 3)
        );
    }

    #[test]
    fn escape_creates_nothing() {
        let mut c = Chart::new(root());
        for d in [Right, Left, Up, Down] {
            c.press(d);
        }
        c.creator.clear();
        c.release();
        assert_eq!(c.s.non_deleted_len(), 1);
    }

    #[test]
    fn creates_nodes_one_at_a_time() {
        let mut c = Chart::new(root());
        let first = c.create(Right);
        assert_eq!(
            (c.count(ElementType::Rectangle), c.count(ElementType::Arrow)),
            (2, 1)
        );
        c.selected = "root".into();
        let second = c.create(Right);
        assert_eq!(
            (c.count(ElementType::Rectangle), c.count(ElementType::Arrow)),
            (3, 2)
        );
        assert_ne!(first, second);
        c.selected = "root".into();
        let third = c.create(Right);
        assert_eq!(
            (c.count(ElementType::Rectangle), c.count(ElementType::Arrow)),
            (4, 3)
        );
        assert_eq!(get(&c.s, &first).x, get(&c.s, &second).x);
        assert_eq!(get(&c.s, &second).x, get(&c.s, &third).x);
    }

    #[test]
    fn doesnt_overlap_existing_siblings_when_adding_more_children() {
        let mut c = Chart::new(rect("p", 0., 0., 400., 300.));
        for _ in 0..4 {
            c.selected = "p".into();
            c.add(Down, 1);
        }
        let ch = c.children("p");
        assert_eq!(ch.len(), 4);
        assert!(ch.iter().all(|e| e.y == ch[0].y));
        let mut sorted = ch.clone();
        sorted.sort_by(|a, b| a.x.total_cmp(&b.x));
        for w in sorted.windows(2) {
            assert!(w[1].x >= w[0].x + w[0].width);
        }
    }

    #[test]
    fn doesnt_overlap_a_previous_batch_of_children() {
        let mut c = Chart::new(rect("p", 0., 0., 400., 300.));
        c.add(Down, 3);
        c.selected = "p".into();
        c.add(Down, 2);
        let ch = c.children("p");
        assert_eq!(ch.len(), 5);
        for i in 0..ch.len() {
            for j in i + 1..ch.len() {
                assert!(!overlaps(&ch[i], &ch[j]));
            }
        }
    }

    #[test]
    fn doesnt_overlap_a_sibling_reached_through_a_shared_parent() {
        let mut c = Chart::new(root());
        c.add(Right, 2);
        let mut rc = c.children("root");
        rc.sort_by(|a, b| a.y.total_cmp(&b.y));
        let (upper, lower) = (rc[0].clone(), rc[1].clone());
        c.selected = upper.id.clone();
        c.add(Down, 1);
        let new = c
            .children("root")
            .into_iter()
            .find(|e| e.id != upper.id && e.id != lower.id)
            .unwrap();
        assert!(!overlaps(&new, &lower));
    }

    #[test]
    fn places_the_first_child_one_offset_away_in_every_direction() {
        for (d, x, y) in [
            (Right, 300., 0.),
            (Left, -300., 0.),
            (Down, 0., 200.),
            (Up, 0., -200.),
        ] {
            let mut c = Chart::new(root());
            c.add(d, 1);
            let ch = c.children("root");
            assert_eq!((ch[0].x, ch[0].y), (x, y), "{d:?}");
        }
    }

    #[test]
    fn slides_into_the_nearest_free_gap_between_obstacles() {
        let mut c = Chart::new(root());
        c.add(Down, 1);
        c.selected = "root".into();
        c.add(Down, 1);
        let mut ch = c.children("root");
        ch.sort_by(|a, b| a.x.total_cmp(&b.x));
        assert_eq!((ch[0].x, ch[1].x), (0., 300.));
        let (c1, c2) = (ch[0].id.clone(), ch[1].id.clone());
        c.set(&c2, |e| e.x = 600.);
        c.selected = "root".into();
        c.add(Down, 1);
        let c3 = c
            .children("root")
            .into_iter()
            .find(|e| e.id != c1 && e.id != c2)
            .unwrap();
        assert_eq!((c3.x, c3.y), (300., 200.));
        assert_eq!((get(&c.s, &c1).x, get(&c.s, &c1).y), (0., 200.));
        assert_eq!((get(&c.s, &c2).x, get(&c.s, &c2).y), (600., 200.));
    }

    #[test]
    fn centers_the_pending_cluster_while_it_grows() {
        let mut c = Chart::new(root());
        c.press(Right);
        assert_eq!(c.pending_rects(), vec![(300., 0.)]);
        c.press(Right);
        assert_eq!(c.pending_rects(), vec![(300., -100.), (300., 100.)]);
        c.press(Right);
        assert_eq!(
            c.pending_rects(),
            vec![(300., -200.), (300., 0.), (300., 200.)]
        );
        c.release();
    }

    #[test]
    fn keeps_pending_nodes_in_place_while_an_obstacle_blocks_the_centered_slot() {
        let mut c = Chart::new(root());
        let c1 = c.create(Right);
        c.set(&c1, |e| e.y = -250.);
        c.selected = "root".into();
        c.press(Right);
        assert_eq!(c.pending_rects(), vec![(300., 0.)]);
        c.press(Right);
        assert_eq!(c.pending_rects(), vec![(300., 0.), (300., 200.)]);
        c.press(Right);
        assert_eq!(
            c.pending_rects(),
            vec![(300., 0.), (300., 200.), (300., 400.)]
        );
        c.release();
    }

    #[test]
    fn keeps_a_gap_from_nodes_between_the_parents_row_and_the_band() {
        let mut c = Chart::new(root());
        c.add(Right, 2);
        c.selected = "root".into();
        c.press(Down);
        c.press(Down);
        assert_eq!(c.pending_rects(), vec![(-300., 200.), (0., 200.)]);
        c.release();
    }

    #[test]
    fn keeps_children_centered_beside_a_node_in_the_parents_row() {
        for (d, y, h) in [(Up, -0.1, 100.), (Down, 0.1, 100.3)] {
            let mut c = Chart::new(rect("root", 0., y, 200., h));
            c.add(Right, 1);
            c.selected = "root".into();
            c.press(d);
            c.press(d);
            assert_eq!(
                c.pending_rects().iter().map(|p| p.0).collect::<Vec<_>>(),
                vec![-150., 150.],
                "{d:?}"
            );
            c.release();
        }
    }

    #[test]
    fn repositions_the_whole_pending_cluster_when_it_no_longer_fits() {
        let mut c = Chart::new(root());
        let c1 = c.create(Right);
        c.set(&c1, |e| e.y = -300.);
        c.selected = "root".into();
        let c2 = c.create(Right);
        assert_eq!((get(&c.s, &c2).x, get(&c.s, &c2).y), (300., 0.));
        c.set(&c2, |e| e.y = 300.);
        c.selected = "root".into();
        c.press(Right);
        assert_eq!(c.pending_rects(), vec![(300., 0.)]);
        // growing can't extend at either end: the cluster moves as a whole
        c.press(Right);
        let p = c.pending_rects();
        assert_eq!(p.len(), 2);
        assert!(p.iter().all(|&(x, _)| x == 300.));
        c.release();
    }

    // navigation

    fn node(id: &str, x: f64, y: f64) -> Element {
        rect(id, x, y, 200., 80.)
    }
    fn link(id: &str, from: &str, to: &str, elbowed: bool) -> Element {
        let b = |e: &str| {
            Some(FixedPointBinding {
                element_id: e.into(),
                fixed_point: [0.5, 0.5],
                mode: BindMode::Orbit,
            })
        };
        let mut a = new_arrow_element(
            opts(id, 0., 0., 100., 100.),
            vec![[0., 0.], [100., 100.]],
            None,
            Some(Arrowhead::Arrow),
            elbowed,
            None,
        );
        let l = a.linear_mut().unwrap();
        (l.start_binding, l.end_binding) = (b(from), b(to));
        a
    }

    #[test]
    fn navigates_single_nodes_at_each_level() {
        let mut c = Chart::new(root());
        for _ in 0..4 {
            c.add(Right, 1);
        }
        assert_eq!(
            (c.count(ElementType::Rectangle), c.count(ElementType::Arrow)),
            (5, 4)
        );
        let right_most = c.selected.clone();
        c.navigate(&[Left, Left, Left, Left]);
        assert_eq!(c.selected, "root");
        c.navigate(&[Right, Right, Right, Right]);
        assert_eq!(c.selected, right_most);
    }

    #[test]
    fn navigates_to_the_node_visually_in_that_direction() {
        let mut c = Chart::new(root());
        let b = c.create(Right);
        c.create(Right);
        let d = c.create(Down);
        let e = c.create(Down);
        let f = c.create(Left);
        // straight up, not along the arrow back to E
        c.navigate(&[Up]);
        assert_eq!(c.selected, b);
        // nothing right of E
        c.selected = e.clone();
        c.navigate(&[Right]);
        assert_eq!(c.selected, e);
        // F is the only node more below A than beside it
        c.selected = "root".into();
        c.navigate(&[Down]);
        assert_eq!(c.selected, f);
        // B and F equally far: the upper one
        c.selected = d.clone();
        c.navigate(&[Left]);
        assert_eq!(c.selected, b);
        // A between the rows, overlapping D's by a sliver: B is nearer
        c.set("root", |x| x.y += 100.2);
        c.selected = "root".into();
        c.navigate(&[Right]);
        assert_eq!(c.selected, b);
    }

    #[test]
    fn navigation_breaks_ties_by_links_alignment_and_reading_order() {
        let mut c = Chart::new(rect("root", 0., 0.7, 200., 100.));
        c.add(Right, 2);
        let mut bc = c.children("root");
        bc.sort_by(|a, b| a.y.total_cmp(&b.y));
        let (b, cc) = (bc[0].id.clone(), bc[1].id.clone());
        c.selected = b.clone();
        let x = c.create(Left);
        c.selected = cc.clone();
        let y = c.create(Left);
        c.set(&y, |e| e.y += 10.);
        // siblings aren't linked, but C is right below B
        c.selected = b.clone();
        c.navigate(&[Down]);
        assert_eq!(c.selected, cc);
        // A and Y about equally far: C links to Y
        c.navigate(&[Left]);
        assert_eq!(c.selected, y);
        // B and C equally far, linked and level: the upper one
        c.selected = "root".into();
        c.navigate(&[Right]);
        assert_eq!(c.selected, b);
        // A and X equally far: B links to X
        c.selected = "root".into();
        c.navigate(&[Right, Left]);
        assert_eq!(c.selected, x);
        // P and Q in line with N, equally far, both linked: P is level
        let n = rect("n", 0., 0., 200., 200.);
        c.s = Scene::new(vec![
            n.clone(),
            node("q", 300., -30.),
            node("p", 300., 60.),
            link("l1", "n", "q", true),
            link("l2", "n", "p", true),
        ]);
        c.selected = "n".into();
        c.navigate(&[Right]);
        assert_eq!(c.selected, "p");
        // links still come first
        c.s = Scene::new(vec![
            n,
            node("q", 300., -30.),
            node("p", 300., 60.),
            link("l1", "n", "q", true),
        ]);
        c.selected = "n".into();
        c.navigate(&[Right]);
        assert_eq!(c.selected, "q");
    }

    #[test]
    fn navigation_prefers_in_line_then_linked_then_cone_then_any_ahead() {
        let mut c = Chart::new(root());
        let mut nav = |els: Vec<Element>, from: &str, d: LinkDirection| {
            c.s = Scene::new(els);
            c.selected = from.into();
            c.navigate(&[d]);
            c.selected.clone()
        };
        assert_eq!(
            nav(
                vec![
                    node("s", 450., 170.),
                    node("a", 0., 170.),
                    node("b", 150., 530.),
                    node("c", 750., 170.),
                    link("1", "s", "c", true),
                    link("2", "c", "a", true),
                    link("3", "s", "b", true)
                ],
                "s",
                Left
            ),
            "a"
        );
        assert_eq!(
            nav(
                vec![
                    node("d", 300., 80.),
                    node("a", 300., 260.),
                    node("b", 580., 520.),
                    node("s", 0., 620.),
                    link("1", "d", "a", false),
                    link("2", "d", "b", false),
                    link("3", "a", "s", false)
                ],
                "s",
                Right
            ),
            "a"
        );
        assert_eq!(
            nav(
                vec![
                    node("e", 0., -300.),
                    node("s", 0., 0.),
                    node("a", 150., 400.),
                    node("b", 400., 150.),
                    link("1", "e", "s", true),
                    link("2", "e", "a", true),
                    link("3", "e", "b", true)
                ],
                "s",
                Down
            ),
            "a"
        );
        let last = || {
            vec![
                node("d", 300., 80.),
                node("s", 300., 270.),
                node("a", 580., 470.),
                node("b", 0., 630.),
                node("f", 900., 400.),
                link("1", "d", "s", true),
                link("2", "d", "a", true),
                link("3", "s", "b", true),
                link("4", "d", "f", true),
            ]
        };
        assert_eq!(nav(last(), "s", Right), "a");
        assert_eq!(nav(last(), "s", Down), "b");
    }
}
