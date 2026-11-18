// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Board tools: lasso, eraser, snapping, crop, images, clipboard, file
//! loading and skeleton transform. Upstream Excalidraw tests @ 3a317b5
//! translated with their inputs and expected values; UI-driven cases are
//! re-expressed as direct calls with the same setup. Measuring is upstream's
//! test mock (`TestMeasure`). `fixtures/board/lasso.json` holds the element
//! and path literals of lasso.test.tsx, evaluated as written: [basic
//! elements, the four basic paths, frame elements, frame path, group
//! elements, group path].
//!
//! - excalidraw/tests/lasso.test.tsx: all.
//! - element/tests/cropElement.test.tsx: "Crop an image" (UI.crop as
//!   `crop_element` at the handle's center; UI.resize in the crop editor at
//!   the dragged corner/side, as the app's resize offset puts it; image
//!   drags as `move_crop`; random natural sizes fixed at 3x).
//! - excalidraw/tests/clipboard.test.tsx: general paste, text as lines /
//!   single element (count, spacing, blank lines), bound text containers,
//!   pasting & frames (the frame under the cursor passed in).
//! - element/src/__tests__/transform.test.ts: ids, shapes, text containers,
//!   labelled arrows, frames, bindings without / with ids, duplicate ids,
//!   customData, sticky notes, label position clamping (values from the
//!   snapshots where the test only snapshots).
//! - excalidraw/tests/image.test.tsx: none of it is element logic; image
//!   helpers get their own tests here.
//! - eraser and snapping have no upstream tests; own tests below.
//!
//! Skipped, with reasons:
//! - cropElement "Enter and leave the crop editor" (pointer / keyboard
//!   state machine), "double-clicking … the arrow following the image" and
//!   undo (binding update and history are the app's), "Cropping and other
//!   features" (duplication, resize, flip and export of crops are covered by
//!   their modules; nothing crop-specific is computed there).
//! - clipboard: "should not make a pasted text wider than the view", the
//!   TEXT_MAX_WRAP_WIDTH / styles panel / stats panel cases and "move a
//!   pasted text that wraps into view" (viewport and side panel layout: the
//!   app passes `max_text_width`), mermaid (not ported), copy/cut events,
//!   paste routing to embeddables / host onPaste / charts (not ported), and
//!   the image-URL mixed content (fetching is the app's).
//! - image.test.tsx: resizing (pica), dropped/pasted/tool image
//!   initialization timing and host image options: DOM and app plumbing.
//! - transform: full snapshot comparisons (key values checked instead),
//!   render-environment measurement spies, elbow routing cases (the elbow
//!   router is another module's), the layout-engine placement cases
//!   (extension / unbinding beyond binding areas) beyond one check.
//! - pixelSnap.test.tsx is about rendering pixel snapping, not snapping.ts.

mod board {
    use lattice_board_core::board::app_state::{AppState, ToolType};
    use lattice_board_core::board::binding::NO_BINDING_HOOKS;
    use lattice_board_core::board::bounds::get_element_bounds;
    use lattice_board_core::board::clipboard::*;
    use lattice_board_core::board::consts::*;
    use lattice_board_core::board::crop::*;
    use lattice_board_core::board::encode::*;
    use lattice_board_core::board::eraser::*;
    use lattice_board_core::board::handles::{HandleType, PointerType, get_transform_handles};
    use lattice_board_core::board::image::*;
    use lattice_board_core::board::lasso::*;
    use lattice_board_core::board::math::Point;
    use lattice_board_core::board::mutate::fix_timestamp;
    use lattice_board_core::board::new_element::*;
    use lattice_board_core::board::random::reseed;
    use lattice_board_core::board::restore::*;
    use lattice_board_core::board::scene::Scene;
    use lattice_board_core::board::snapping::*;
    use lattice_board_core::board::text_measure::*;
    use lattice_board_core::board::transform::*;
    use lattice_board_core::board::types::*;
    use lattice_board_core::board::utils::array_to_map;
    use rustc_hash::FxHashSet;
    use serde_json::{Value, json};
    use std::collections::{BTreeMap, BTreeSet};

    const M: &TestMeasure = &TestMeasure;
    const LASSO: &str = include_str!("fixtures/board/lasso.json");
    fn setup() {
        reseed(1);
        fix_timestamp(Some(1));
    }
    fn restore(v: &Value) -> Vec<Element> {
        restore_elements(Some(v), None, &RestoreOpts::default())
    }
    fn el(ty: ElementType, id: &str, x: f64, y: f64, w: f64, h: f64) -> Element {
        new_element(
            ty,
            ElementOpts {
                id: Some(id.into()),
                x,
                y,
                width: w,
                height: h,
                ..Default::default()
            },
        )
    }
    fn rect(id: &str, x: f64, y: f64, w: f64, h: f64) -> Element {
        el(ElementType::Rectangle, id, x, y, w, h)
    }
    fn pts(v: &Value) -> Vec<Point> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()])
            .collect()
    }
    fn ids(s: &BTreeSet<String>) -> Vec<&str> {
        s.iter().map(String::as_str).collect()
    }

    // ---------------------------------------------------------------------------
    // lasso.test.tsx
    // ---------------------------------------------------------------------------

    /// `updatePath`: the trail's points, `getLassoSelectedElementIds` (no
    /// simplification), then `selectElementsFromIds`.
    fn update_path(
        elements: &[Element],
        start: Point,
        rel: &[Point],
        mode: BoxSelectionMode,
    ) -> LassoSelection {
        let mut path = vec![start];
        path.extend(rel.iter().map(|p| [start[0] + p[0], start[1] + p[1]]));
        let map = array_to_map(elements);
        let segments = elements_segments(elements, &map);
        let ids = get_lasso_selected_element_ids(&LassoQuery {
            lasso_path: &path,
            elements,
            scene: elements,
            map: &map,
            segments: &segments,
            simplify_distance: None,
            mode,
        });
        LassoTrail::default().select_elements_from_ids(&ids, elements, &BTreeSet::new(), None)
    }
    fn selected<'a>(elements: &'a [Element], s: &LassoSelection) -> Vec<&'a Element> {
        elements
            .iter()
            .filter(|e| s.selected_element_ids.contains(&e.id))
            .collect()
    }
    fn count(v: &[&Element], t: ElementType) -> usize {
        v.iter().filter(|e| e.ty() == t).count()
    }
    fn fixtures() -> Vec<Value> {
        serde_json::from_str::<Vec<Value>>(LASSO).unwrap()
    }

    #[test]
    fn lasso_none_selected() {
        let f = fixtures();
        let els = restore(&f[0]);
        let s = update_path(&els, [-533., 611.], &pts(&f[1]), BoxSelectionMode::Overlap);
        assert_eq!(selected(&els, &s).len(), 0);
    }

    #[test]
    fn lasso_intersects_some() {
        let f = fixtures();
        let els = restore(&f[0]);
        let s = update_path(&els, [-311., 50.], &pts(&f[2]), BoxSelectionMode::Overlap);
        let sel = selected(&els, &s);
        assert_eq!(sel.len(), 3);
        assert_eq!(count(&sel, ElementType::Arrow), 1);
        assert_eq!(count(&sel, ElementType::Rectangle), 1);
        assert_eq!(count(&sel, ElementType::FreeDraw), 1);
    }

    #[test]
    fn lasso_intersects_and_encloses_some() {
        let f = fixtures();
        let els = restore(&f[0]);
        let s = update_path(&els, [112., -190.], &pts(&f[3]), BoxSelectionMode::Overlap);
        let sel = selected(&els, &s);
        assert_eq!(sel.len(), 4);
        for t in [
            ElementType::Line,
            ElementType::Ellipse,
            ElementType::Diamond,
            ElementType::FreeDraw,
        ] {
            assert_eq!(count(&sel, t), 1, "{t:?}");
        }
    }

    #[test]
    fn lasso_single_linear_element() {
        let f = fixtures();
        let els = restore(&f[0]);
        let s = update_path(&els, [62., -200.], &pts(&f[4]), BoxSelectionMode::Overlap);
        assert_eq!(selected(&els, &s).len(), 1);
        assert!(s.selected_linear_element.is_some());
    }

    #[test]
    fn lasso_selects_only_frame_with_children() {
        let f = fixtures();
        let els = restore(&f[5]);
        let s = update_path(&els, [-352., -64.], &pts(&f[6]), BoxSelectionMode::Overlap);
        let sel = selected(&els, &s);
        assert_eq!(sel.len(), 1);
        assert_eq!(sel[0].ty(), ElementType::Frame);
    }

    #[test]
    fn lasso_selects_whole_group() {
        let f = fixtures();
        let els = restore(&f[7]);
        let s = update_path(&els, [117., 463.], &pts(&f[8]), BoxSelectionMode::Overlap);
        assert_eq!(selected(&els, &s).len(), 16);
        assert_eq!(
            s.selected_group_ids.get("-9NzH7Fa5JaHu4ArEFpa_"),
            Some(&true)
        );
    }

    #[test]
    fn lasso_respects_box_selection_mode() {
        setup();
        let els = vec![
            rect("rect1", 100., 100., 50., 50.),
            rect("rect2", 300., 300., 50., 50.),
        ];
        let p = [
            [0., 0.],
            [100., 0.],
            [240., 240.],
            [240., 320.],
            [0., 320.],
            [0., 0.],
        ];
        let s = update_path(&els, [80., 80.], &p, BoxSelectionMode::Overlap);
        assert_eq!(ids(&s.selected_element_ids), ["rect1", "rect2"]);
        let s = update_path(&els, [80., 80.], &p, BoxSelectionMode::Contain);
        assert_eq!(ids(&s.selected_element_ids), ["rect1"]);
    }

    /// `drawLasso`: through the trail (simplified at zoom 1).
    fn draw_lasso(els: &[Element], p: &[Point], mode: BoxSelectionMode) -> Vec<String> {
        let mut t = LassoTrail::default();
        t.start_path(p[0][0], p[0][1], false);
        let mut s = LassoSelection::default();
        for q in &p[1..] {
            s = t.add_point_to_path(
                q[0],
                q[1],
                false,
                els,
                els,
                (0., 0., 1.),
                mode,
                &BTreeSet::new(),
                None,
            );
        }
        t.end_path();
        s.selected_element_ids.into_iter().collect()
    }
    fn closed(p: &[[f64; 2]]) -> Vec<Point> {
        let mut v = p.to_vec();
        v.push(p[0]);
        v
    }

    #[test]
    fn box_selection_enclosing_one_cutting_another() {
        setup();
        let els = vec![
            rect("enclosed", 100., 100., 50., 50.),
            rect("crossed", 300., 100., 50., 50.),
        ];
        let l = [
            [80., 80.],
            [320., 80.],
            [320., 220.],
            [80., 220.],
            [80., 80.],
        ];
        assert_eq!(
            draw_lasso(&els, &l, BoxSelectionMode::Contain),
            ["enclosed"]
        );
        assert_eq!(
            draw_lasso(&els, &l, BoxSelectionMode::Overlap),
            ["crossed", "enclosed"]
        );
    }

    #[test]
    fn box_selection_lasso_cutting_through_isnt_containing() {
        setup();
        let els = vec![rect("rect", 100., 100., 50., 50.)];
        let l = [
            [80., 80.],
            [120., 80.],
            [120., 125.],
            [130., 125.],
            [130., 80.],
            [170., 80.],
            [170., 170.],
            [80., 170.],
            [80., 80.],
        ];
        assert!(draw_lasso(&els, &l, BoxSelectionMode::Contain).is_empty());
        assert_eq!(draw_lasso(&els, &l, BoxSelectionMode::Overlap), ["rect"]);
    }

    #[test]
    fn box_selection_label_alone_doesnt_select_container() {
        setup();
        let mut c = rect("container", 100., 100., 200., 100.);
        c.bound_elements = Some(vec![BoundElement {
            id: "label".into(),
            kind: BoundType::Text,
        }]);
        let mut t = new_text_element(
            TextOpts {
                text: "label".into(),
                container_id: Some("container".into()),
                ..Default::default()
            },
            ElementOpts {
                id: Some("label".into()),
                x: 140.,
                y: 130.,
                ..Default::default()
            },
            M,
        );
        (t.width, t.height) = (80., 25.);
        let els = vec![c, t];
        let l = [
            [130., 120.],
            [230., 120.],
            [230., 165.],
            [130., 165.],
            [130., 120.],
        ];
        assert!(draw_lasso(&els, &l, BoxSelectionMode::Contain).is_empty());
        assert_eq!(
            draw_lasso(&els, &l, BoxSelectionMode::Overlap),
            ["container"]
        );
    }

    #[test]
    fn box_selection_groups() {
        setup();
        let mut a = rect("member1", 100., 100., 50., 50.);
        let mut b = rect("member2", 300., 100., 50., 50.);
        a.group_ids = vec!["group".into()];
        b.group_ids = vec!["group".into()];
        let els = vec![a, b];
        let l = [
            [80., 80.],
            [200., 80.],
            [200., 200.],
            [80., 200.],
            [80., 80.],
        ];
        assert!(draw_lasso(&els, &l, BoxSelectionMode::Contain).is_empty());
        assert_eq!(
            draw_lasso(&els, &l, BoxSelectionMode::Overlap),
            ["member1", "member2"]
        );
        let all = [
            [80., 80.],
            [400., 80.],
            [400., 200.],
            [80., 200.],
            [80., 80.],
        ];
        assert_eq!(
            draw_lasso(&els, &all, BoxSelectionMode::Contain),
            ["member1", "member2"]
        );
    }

    #[test]
    fn box_selection_frame_clipped_part() {
        setup();
        let frame = new_frame_element(
            ElementOpts {
                id: Some("frame".into()),
                width: 200.,
                height: 200.,
                ..Default::default()
            },
            None,
        );
        let mut r = rect("overflowing", 150., 50., 100., 50.);
        r.frame_id = Some("frame".into());
        let els = vec![frame, r];
        let l = [
            [140., 40.],
            [210., 40.],
            [210., 110.],
            [140., 110.],
            [140., 40.],
        ];
        assert_eq!(
            draw_lasso(&els, &l, BoxSelectionMode::Contain),
            ["overflowing"]
        );
    }

    #[test]
    fn box_selection_freedraw_dot() {
        setup();
        let dot = new_free_draw_element(
            ElementOpts {
                id: Some("dot".into()),
                x: 100.,
                y: 100.,
                ..Default::default()
            },
            vec![[0., 0.]],
            vec![],
            true,
            None,
        );
        let els = vec![dot];
        let l = [
            [80., 80.],
            [120., 80.],
            [120., 120.],
            [80., 120.],
            [80., 80.],
        ];
        assert_eq!(draw_lasso(&els, &l, BoxSelectionMode::Contain), ["dot"]);
    }

    #[test]
    fn box_selection_outline_on_the_path() {
        setup();
        let els = vec![rect("rect", 100., 100., 50., 50.)];
        let sides: [(&str, [[f64; 2]; 4]); 4] = [
            (
                "right",
                [[80., 80.], [150., 80.], [150., 200.], [80., 200.]],
            ),
            (
                "left",
                [[100., 80.], [200., 80.], [200., 200.], [100., 200.]],
            ),
            (
                "top",
                [[80., 100.], [200., 100.], [200., 200.], [80., 200.]],
            ),
            (
                "bottom",
                [[80., 50.], [200., 50.], [200., 150.], [80., 150.]],
            ),
        ];
        for (side, l) in sides {
            assert_eq!(
                draw_lasso(&els, &closed(&l), BoxSelectionMode::Contain),
                ["rect"],
                "{side}"
            );
        }
    }

    #[test]
    fn lasso_start_path_clears_unless_kept() {
        let mut t = LassoTrail::default();
        assert!(t.start_path(0., 0., false));
        assert!(!t.start_path(0., 0., true));
        let els = vec![rect("a", 0., 0., 10., 10.), rect("b", 100., 0., 10., 10.)];
        let prev: BTreeSet<String> = ["b".to_string()].into();
        let s = t.select_elements_from_ids(&["a".into()], &els, &prev, None);
        assert_eq!(ids(&s.selected_element_ids), ["a", "b"]);
    }

    // ---------------------------------------------------------------------------
    // eraser (own tests)
    // ---------------------------------------------------------------------------

    #[test]
    fn eraser_hits_stroke_not_transparent_inside() {
        setup();
        let els = vec![rect("r", 0., 0., 100., 100.)];
        let mut t = EraserTrail::default();
        t.start_path(40., 40.);
        assert!(
            t.add_point_to_path(60., 60., false, &els, &els, 1.)
                .is_empty()
        );
        // crossing the left edge
        t.start_path(-10., 50.);
        assert_eq!(t.add_point_to_path(10., 50., false, &els, &els, 1.), ["r"]);
        // a filled shape is hit from inside
        let mut filled = rect("f", 0., 0., 100., 100.);
        filled.background_color = "#ff0000".into();
        let els = vec![filled];
        t.start_path(40., 40.);
        assert_eq!(t.add_point_to_path(60., 60., false, &els, &els, 1.), ["f"]);
        // locked elements are never erased
        let mut l = rect("l", 0., 0., 100., 100.);
        l.locked = true;
        let els = vec![l];
        t.start_path(-10., 50.);
        assert!(
            t.add_point_to_path(10., 50., false, &els, &els, 1.)
                .is_empty()
        );
    }

    #[test]
    fn eraser_expands_groups_and_labels_and_restores() {
        setup();
        let mut a = rect("a", 0., 0., 100., 100.);
        let mut b = rect("b", 300., 0., 100., 100.);
        a.group_ids = vec!["g".into()];
        b.group_ids = vec!["g".into()];
        let mut c = rect("c", 0., 200., 100., 100.);
        c.bound_elements = Some(vec![BoundElement {
            id: "t".into(),
            kind: BoundType::Text,
        }]);
        let t = new_text_element(
            TextOpts {
                text: "x".into(),
                container_id: Some("c".into()),
                ..Default::default()
            },
            ElementOpts {
                id: Some("t".into()),
                x: 40.,
                y: 240.,
                ..Default::default()
            },
            M,
        );
        let els = vec![a, b, c, t];
        let mut tr = EraserTrail::default();
        tr.start_path(-10., 50.);
        assert_eq!(
            tr.add_point_to_path(10., 50., false, &els, &els, 1.),
            ["a", "b"]
        );
        tr.add_point_to_path(-10., 250., false, &els, &els, 1.);
        let got = tr.add_point_to_path(10., 250., false, &els, &els, 1.);
        assert_eq!(got, ["a", "b", "c", "t"]);
        // alt: crossing again un-marks (the group, the label)
        let got = tr.add_point_to_path(-10., 250., true, &els, &els, 1.);
        assert_eq!(got, ["a", "b"]);
        tr.add_point_to_path(-10., 50., true, &els, &els, 1.);
        assert!(
            tr.add_point_to_path(10., 50., true, &els, &els, 1.)
                .is_empty()
        );
        tr.end_path();
        assert!(tr.points.is_empty() && tr.elements_to_erase.is_empty());
    }

    #[test]
    fn eraser_lines_and_freedraw() {
        setup();
        let line = new_linear_element(
            ElementOpts {
                id: Some("l".into()),
                x: 0.,
                y: 0.,
                width: 100.,
                ..Default::default()
            },
            vec![[0., 0.], [100., 0.]],
            None,
        );
        let fd = new_free_draw_element(
            ElementOpts {
                id: Some("fd".into()),
                x: 0.,
                y: 100.,
                width: 100.,
                ..Default::default()
            },
            vec![[0., 0.], [50., 0.], [100., 0.]],
            vec![],
            true,
            None,
        );
        let els = vec![line, fd];
        assert!(eraser_test([[50., -10.], [50., 10.]], &els[0], &els, 1.));
        assert!(!eraser_test([[50., -30.], [50., -10.]], &els[0], &els, 1.));
        assert!(eraser_test([[50., 90.], [50., 110.]], &els[1], &els, 1.));
        assert!(!eraser_test([[50., 140.], [60., 150.]], &els[1], &els, 1.));
    }

    #[test]
    fn eraser_erase_elements_unbinds_and_deletes() {
        setup();
        let mut r = rect("r", 0., 0., 100., 100.);
        r.bound_elements = Some(vec![BoundElement {
            id: "arrow".into(),
            kind: BoundType::Arrow,
        }]);
        let mut a = new_arrow_element(
            ElementOpts {
                id: Some("arrow".into()),
                x: 150.,
                y: 50.,
                width: 100.,
                ..Default::default()
            },
            vec![[0., 0.], [100., 0.]],
            None,
            Some(Arrowhead::Arrow),
            false,
            None,
        );
        a.linear_mut().unwrap().start_binding = Some(FixedPointBinding {
            element_id: "r".into(),
            fixed_point: [1., 0.5],
            mode: BindMode::Orbit,
        });
        let mut child = rect("child", 300., 0., 10., 10.);
        child.frame_id = Some("frame".into());
        let frame = new_frame_element(
            ElementOpts {
                id: Some("frame".into()),
                x: 290.,
                width: 50.,
                height: 50.,
                ..Default::default()
            },
            None,
        );
        let mut scene = Scene::new(vec![r, a, child, frame]);
        let pending: FxHashSet<String> =
            ["r".to_string(), "frame".to_string()].into_iter().collect();
        assert!(erase_elements(&mut scene, &pending));
        let g = |id: &str| scene.get_element(id).unwrap().clone();
        assert!(g("r").is_deleted && g("frame").is_deleted && g("child").is_deleted);
        assert!(!g("arrow").is_deleted);
        assert!(g("arrow").linear().unwrap().start_binding.is_none());
        assert!(!erase_elements(&mut scene, &FxHashSet::default()));
    }

    // ---------------------------------------------------------------------------
    // snapping (own tests)
    // ---------------------------------------------------------------------------

    fn ctx(app: &AppState) -> SnapCtx<'_> {
        SnapCtx {
            app,
            width: 1000.,
            height: 1000.,
            dragging_selection: false,
        }
    }

    #[test]
    fn snapping_enabled_rules() {
        let mut app = AppState::default();
        assert_eq!(get_snap_distance(2.), 4.);
        let arrow = new_arrow_element(
            ElementOpts::default(),
            vec![[0., 0.], [10., 0.]],
            None,
            None,
            false,
            None,
        );
        app.objects_snap_mode_enabled = true;
        assert!(is_snapping_enabled(&ctx(&app), None, &[]));
        assert!(!is_snapping_enabled(&ctx(&app), None, &[&arrow]));
        assert!(is_snapping_enabled(
            &ctx(&app),
            Some(SnapModifiers { ctrl_or_cmd: false }),
            &[]
        ));
        assert!(!is_snapping_enabled(
            &ctx(&app),
            Some(SnapModifiers { ctrl_or_cmd: true }),
            &[]
        ));
        app.objects_snap_mode_enabled = false;
        assert!(is_snapping_enabled(
            &ctx(&app),
            Some(SnapModifiers { ctrl_or_cmd: true }),
            &[]
        ));
        app.grid_mode_enabled = true;
        assert!(!is_snapping_enabled(
            &ctx(&app),
            Some(SnapModifiers { ctrl_or_cmd: true }),
            &[]
        ));
        app.objects_snap_mode_enabled = true;
        app.active_tool.ty = ToolType::Lasso;
        assert!(!is_snapping_enabled(
            &ctx(&app),
            Some(SnapModifiers::default()),
            &[]
        ));
        let mut c = ctx(&app);
        c.dragging_selection = true;
        assert!(is_snapping_enabled(&c, Some(SnapModifiers::default()), &[]));
        assert!(
            is_active_tool_non_linear_snappable(ToolType::Rectangle)
                && !is_active_tool_non_linear_snappable(ToolType::Arrow)
        );
    }

    #[test]
    fn snapping_corners() {
        let r = rect("r", 0., 0., 100., 50.);
        let d = el(ElementType::Diamond, "d", 0., 0., 100., 50.);
        let els = vec![r.clone(), d.clone()];
        assert_eq!(
            get_elements_corners(&[&r], &els, CornersOpts::default()),
            vec![[0., 0.], [100., 0.], [0., 50.], [100., 50.], [50., 25.]]
        );
        assert_eq!(
            get_elements_corners(
                &[&d],
                &els,
                CornersOpts {
                    omit_center: true,
                    ..Default::default()
                }
            ),
            vec![[0., 25.], [50., 0.], [100., 25.], [50., 50.]]
        );
        assert_eq!(
            get_elements_corners(
                &[&d],
                &els,
                CornersOpts {
                    bounding_box_corners: true,
                    omit_center: true,
                    drag_offset: Some([1., 2.])
                }
            ),
            vec![[1., 2.], [101., 2.], [1., 52.], [101., 52.]]
        );
        let s = rect("s", 200., 100., 10., 10.);
        let els = vec![r.clone(), s.clone()];
        assert_eq!(
            get_elements_corners(&[&r, &s], &els, CornersOpts::default()),
            vec![[0., 0.], [210., 0.], [0., 110.], [210., 110.], [105., 55.]]
        );
    }

    #[test]
    fn snapping_dragged_point_and_gap_snaps() {
        let mut app = AppState {
            objects_snap_mode_enabled: true,
            ..Default::default()
        };
        let a = rect("a", 0., 0., 100., 100.);
        let b = rect("b", 200., 0., 100., 100.);
        app.selected_element_ids = ["b".to_string()].into();
        let els = vec![a.clone(), b.clone()];
        let c = ctx(&app);
        let mut cache = SnapCache::default();
        cache.maybe_cache_reference_snap_points(&els, &[&b], &c, &els, None, false);
        cache.maybe_cache_visible_gaps(&els, &[&b], &c, &els, None, false);
        assert_eq!(cache.reference_snap_points.as_ref().unwrap().len(), 5);
        let r = snap_dragged_elements(&els, [-97., 3.], &c, None, &els, &cache);
        assert_eq!(r.snap_offset, [-3., -3.]);
        assert!(
            r.snap_lines
                .iter()
                .any(|l| matches!(l, SnapLine::Points(p) if p.contains(&[100., 0.])))
        );
        // equal spacing between a and d
        let d = rect("d", 300., 0., 100., 100.);
        let e = rect("e", 172., 20., 50., 50.);
        app.selected_element_ids = ["e".to_string()].into();
        let els = vec![a, d, e.clone()];
        let c = ctx(&app);
        let mut cache = SnapCache::default();
        cache.maybe_cache_reference_snap_points(&els, &[&e], &c, &els, None, false);
        cache.maybe_cache_visible_gaps(&els, &[&e], &c, &els, None, false);
        let g = cache.visible_gaps.as_ref().unwrap();
        assert_eq!(g.horizontal_gaps.len(), 1);
        assert_eq!(g.horizontal_gaps[0].length, 200.);
        let r = snap_dragged_elements(&els, [0., 0.], &c, None, &els, &cache);
        assert_eq!(r.snap_offset, [3., 5.]);
        assert!(r.snap_lines.iter().any(|l| matches!(
            l,
            SnapLine::Gap {
                direction: LineDirection::Horizontal,
                ..
            }
        )));
        // disabled (ctrl held with the mode on)
        assert_eq!(
            snap_dragged_elements(
                &els,
                [0., 0.],
                &c,
                Some(SnapModifiers { ctrl_or_cmd: true }),
                &els,
                &cache
            ),
            SnapResult::default()
        );
    }

    #[test]
    fn snapping_resize_new_and_pointer() {
        let app = AppState {
            objects_snap_mode_enabled: true,
            ..Default::default()
        };
        let a = rect("a", 0., 0., 100., 100.);
        let b = rect("b", 200., 0., 50., 50.);
        let els = vec![a.clone(), b.clone()];
        let c = ctx(&app);
        let mut cache = SnapCache::default();
        cache.maybe_cache_reference_snap_points(&els, &[&b], &c, &els, None, false);
        // b's south-east corner dragged to y 97: snaps to a's bottom
        let r = snap_resizing_elements(
            &[&b],
            &[&b],
            &c,
            None,
            [0., 47.],
            Some(HandleType::Se),
            &els,
            &cache,
        );
        assert_eq!(r.snap_offset, [0., 3.]);
        let r = snap_new_element(&b, &c, None, [195., 0.], [0., 98.], &els, &cache);
        assert_eq!(r.snap_offset, [0., 2.]);
        let (off, lines) = get_snap_lines_at_pointer(&els, &c, [103., 52.], None, &els);
        assert_eq!(off, [-3., -2.]);
        assert!(lines.iter().any(|l| matches!(l, SnapLine::Pointer { direction: LineDirection::Vertical, points } if points[0] == [100., 0.])));
    }

    // ---------------------------------------------------------------------------
    // cropElement.test.tsx
    // ---------------------------------------------------------------------------

    fn image(x: f64, y: f64, w: f64, h: f64) -> Element {
        new_image_element(
            ElementOpts {
                id: Some("img".into()),
                x,
                y,
                width: w,
                height: h,
                ..Default::default()
            },
            None,
            Some("file".into()),
            None,
            None,
        )
    }
    /// `UI.crop`: `cropElement` at the handle's center moved by `d`.
    fn ui_crop(e: &mut Element, h: HandleType, nw: f64, nh: f64, d: [f64; 2], keep_ratio: bool) {
        let map = vec![e.clone()];
        let hc = get_transform_handles(e, 1., &map, PointerType::Mouse, Default::default())
            .get(h)
            .unwrap();
        let u = crop_element(
            e,
            &map,
            h,
            nw,
            nh,
            hc[0] + hc[2] / 2. + d[0],
            hc[1] + hc[3] / 2. + d[1],
            CropOpts {
                maintain_aspect_ratio: keep_ratio,
                ..Default::default()
            },
        );
        u.apply(e);
    }
    /// A resize in the crop editor: the dragged corner / side at `p`.
    fn crop_to(e: &mut Element, h: HandleType, p: Point, o: CropOpts) {
        let map = vec![e.clone()];
        crop_element(e, &map, h, 400., 200., p[0], p[1], o).apply(e);
    }

    #[test]
    fn crop_changes_the_dimension() {
        let mut e = image(0., 0., 200., 100.);
        ui_crop(&mut e, HandleType::W, 600., 300., [100., 0.], false);
        assert!(e.width < 200.);
        ui_crop(&mut e, HandleType::N, 600., 300., [0., 50.], false);
        assert!(e.height < 100.);
    }

    #[test]
    fn crop_dragging_handle_then_image() {
        let mut e = image(0., 0., 200., 100.);
        crop_to(&mut e, HandleType::Nw, [50., 25.], CropOpts::default());
        assert_eq!((e.x, e.y, e.width), (50., 25., 150.));
        let c = e.image().unwrap().crop.unwrap();
        assert_eq!((c.x, c.y), (100., 50.));
        // 20px to the right = 40px of the file
        let mv = |e: &mut Element, d: [f64; 2]| {
            let map = vec![e.clone()];
            let c = move_crop(e, &map, d, 400., 200.).unwrap();
            e.image_mut().unwrap().crop = Some(c);
        };
        mv(&mut e, [20., 0.]);
        assert_eq!((e.x, e.y, e.width), (50., 25., 150.));
        assert_eq!(e.image().unwrap().crop.unwrap().x, 60.);
        // with shift, along x only
        mv(&mut e, [10., 0.]);
        let c = e.image().unwrap().crop.unwrap();
        assert_eq!((c.x, c.y), (40., 50.));
        // past the file's edge, and back
        mv(&mut e, [40., 0.]);
        assert_eq!(e.image().unwrap().crop.unwrap().x, 0.);
        mv(&mut e, [-10., 0.]);
        let c = e.image().unwrap().crop.unwrap();
        assert_eq!((c.x, c.y), (20., 50.));
    }

    #[test]
    fn crop_alt_drag_from_center() {
        let mut e = image(0., 0., 200., 100.);
        let orig = e.clone();
        crop_to(&mut e, HandleType::E, [170., 50.], CropOpts::default());
        assert_eq!((e.x, e.width), (0., 170.));
        let mut e = orig.clone();
        crop_to(
            &mut e,
            HandleType::E,
            [170., 50.],
            CropOpts {
                resize_from_center: true,
                ..Default::default()
            },
        );
        assert_eq!((e.x, e.width), (30., 140.));
        let mut e = orig;
        crop_to(
            &mut e,
            HandleType::E,
            [170., 50.],
            CropOpts {
                resize_from_center: true,
                ..Default::default()
            },
        );
        let c = e.image().unwrap().crop.unwrap();
        assert_eq!((c.x, c.width), (60., 280.));
        crop_to(
            &mut e,
            HandleType::E,
            [135., 50.],
            CropOpts {
                resize_from_center: true,
                maintain_aspect_ratio: true,
            },
        );
        assert_eq!((e.x, e.y, e.width, e.height), (65., 25., 70., 50.));
    }

    #[test]
    fn crop_uncrop_sides() {
        let mut e = image(50., 25., 100., 50.);
        e.image_mut().unwrap().crop = Some(ImageCrop {
            x: 100.,
            y: 50.,
            width: 200.,
            height: 100.,
            natural_width: 400.,
            natural_height: 200.,
        });
        let map = vec![e.clone()];
        let u = uncrop_element_sides(&e, &map, HandleType::Ne, false).unwrap();
        assert_eq!((u.x, u.y, u.width, u.height), (50., 0., 150., 75.));
        let c = u.crop.unwrap();
        assert_eq!((c.y, c.width), (0., 300.));
        let u = uncrop_element_sides(&e, &map, HandleType::W, true).unwrap();
        assert_eq!((u.x, u.y, u.width, u.height), (0., 25., 200., 50.));
        let c = u.crop.unwrap();
        assert_eq!((c.x, c.width), (0., 400.));
        let whole = get_uncropped_image_element(&e, &map);
        assert_eq!(
            (whole.x, whole.y, whole.width, whole.height),
            (0., 0., 200., 100.)
        );
        assert_eq!(get_flip_adjusted_crop_position(&e, false), Some([50., 25.]));
        assert_eq!(get_uncropped_width_and_height(&e), (200., 100.));
    }

    #[test]
    fn crop_minimal_sizes() {
        let mut e = image(0., 0., 200., 100.);
        ui_crop(&mut e, HandleType::W, 600., 300., [200., 0.], false);
        assert!(e.width < 200. && e.width > 0.);
        ui_crop(&mut e, HandleType::W, 600., 300., [-200., 0.], false);
        ui_crop(&mut e, HandleType::N, 600., 300., [0., 100.], false);
        assert!(e.height < 100. && e.height > 0.);
    }

    #[test]
    fn crop_preserve_aspect_ratio() {
        let (nw, nh) = (600., 300.);
        let mut e = image(0., 0., 200., 100.);
        ui_crop(&mut e, HandleType::W, nw, nh, [200. / 3., 0.], false);
        let (rw, rh) = (e.width, e.height);
        // max height: keeping the ratio changes nothing
        ui_crop(&mut e, HandleType::W, nw, nh, [-200. / 3., 0.], true);
        assert!((e.width - rw).abs() < 1e-10 && (e.height - rh).abs() < 1e-10);
        ui_crop(&mut e, HandleType::W, nw, nh, [-200. / 3., 0.], false);
        ui_crop(&mut e, HandleType::S, nw, nh, [0., -50.], false);
        ui_crop(&mut e, HandleType::E, nw, nh, [-200. / 3., 0.], false);
        let (rw, rh) = (e.width, e.height);
        ui_crop(&mut e, HandleType::Se, nw, nh, [200., 0.], true);
        assert!((e.width / e.height - rw / rh).abs() < 1e-12);
        assert!(e.width <= 200.0001 && e.height <= 100.0001);
        let mut e = image(0., 0., 200., 100.);
        ui_crop(&mut e, HandleType::Nw, nw, nh, [150., 50.], false);
        ui_crop(&mut e, HandleType::N, nw, nh, [0., -100.], true);
        assert!((e.width - e.height).abs() < 1e-6);
        assert!((e.height - 50.).abs() < 1e-6);
        ui_crop(&mut e, HandleType::Nw, nw, nh, [-150., -100.], true);
        assert!((e.width - e.height).abs() < 1e-6);
        assert!((e.height - 100.).abs() < 1e-6 && (e.width - 100.).abs() < 1e-6);
    }

    // ---------------------------------------------------------------------------
    // images (own tests: image.ts, blob.ts helpers)
    // ---------------------------------------------------------------------------

    #[test]
    fn image_file_helpers() {
        assert_eq!(
            generate_id_from_file(b"abc"),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        let url = get_data_url(b"hi there", mime::PNG);
        assert_eq!(url, "data:image/png;base64,aGkgdGhlcmU=");
        assert_eq!(
            data_url_to_bytes(&url),
            Some((mime::PNG.to_string(), b"hi there".to_vec()))
        );
        assert_eq!(
            data_url_to_bytes("data:image/svg+xml,%3Csvg%3E"),
            Some((mime::SVG.to_string(), b"<svg>".to_vec()))
        );
        assert_eq!(get_mime_type("a.excalidraw"), mime::JSON);
        assert_eq!(get_mime_type("a.jpeg"), mime::JPG);
        assert_eq!(
            sniff_image_mime_type(&[137, 80, 78, 71, 13, 10, 26, 10, 0]),
            Some(mime::PNG)
        );
        assert_eq!(
            sniff_image_mime_type(b"RIFF\x01\x02\x03\x04WEBPVP8 "),
            Some(mime::WEBP)
        );
        assert_eq!(
            normalize_file_mime_type("x.png", "image/png", &[255, 216, 255, 0]),
            mime::JPG
        );
        assert_eq!(
            normalize_file_mime_type("s.excalidraw", "", b"{}"),
            mime::EXCALIDRAW
        );
        assert!(
            is_supported_image_file_type(mime::SVG) && !is_supported_image_file_type(mime::BINARY)
        );
    }

    #[test]
    fn image_normalize_svg() {
        let s = normalize_svg(r#"<svg viewBox="0 0 120 80.5"><rect/></svg>"#).unwrap();
        assert_eq!(
            s,
            r#"<svg viewBox="0 0 120 80.5" xmlns="http://www.w3.org/2000/svg" width="120" height="80.5"><rect/></svg>"#
        );
        let s =
            normalize_svg(r#"<?xml version="1.0"?><svg width="100%" height="30" xmlns="x"></svg>"#)
                .unwrap();
        assert_eq!(
            s,
            r#"<?xml version="1.0"?><svg width="50" height="30" xmlns="x" viewBox="0 0 50 30"></svg>"#
        );
        assert!(normalize_svg("<html></html>").is_err());
    }

    #[test]
    fn image_cache_and_insertion() {
        setup();
        let mut files = BTreeMap::new();
        let f = |id: &str, mime: &str| FileData {
            id: id.into(),
            mime_type: mime.into(),
            data_url: Some("data:".into()),
            path: None,
            created: 1,
            last_retrieved: None,
            version: None,
            extra: Default::default(),
        };
        files.insert("a".to_string(), f("a", mime::PNG));
        files.insert("b".to_string(), f("b", mime::BINARY));
        let mut cache: ImageCache<u32> = ImageCache::default();
        let r = cache.update(&["a", "b", "a", "missing"], &files, |_| Ok(7));
        assert_eq!(r.updated_files.len(), 2);
        assert_eq!(r.errored_files.into_iter().collect::<Vec<_>>(), ["b"]);
        assert_eq!(cache.get("a").unwrap().image, 7);
        let mut els = vec![image(0., 0., 10., 10.)];
        els[0].image_mut().unwrap().file_id = Some("b".into());
        assert!(mark_errored_images(
            &mut els,
            &["b".to_string()].into_iter().collect()
        ));
        assert_eq!(els[0].image().unwrap().status, ImageStatus::Error);
        assert_eq!(uncached_image_file_ids(&els, &cache), ["b"]);
        // a placeholder, 100px on screen, then the image at its natural size
        let app = AppState {
            zoom: 2.,
            ..Default::default()
        };
        let p = new_image_placeholder(&app, 100., 100., None, None);
        assert_eq!((p.x, p.y, p.width, p.height), (75., 75., 50., 50.));
        let i = initialize_image_element(&p, "file", Some((400., 200.)), 1000., 2.);
        assert_eq!(i.image().unwrap().file_id.as_deref(), Some("file"));
        // at most half the view height (at zoom 2: 250), and its natural size
        assert_eq!((i.x, i.y, i.width, i.height), (-100., 0., 400., 200.));
        let units: Vec<Vec<Element>> = (0..3)
            .map(|i| vec![rect(&format!("r{i}"), 0., 0., 10., 10.)])
            .collect();
        let laid = position_elements_on_grid(&units, 0., 0., 10.);
        assert_eq!(
            laid.iter().map(|e| (e.x, e.y)).collect::<Vec<_>>(),
            [(-15., -15.), (5., -15.), (-5., 5.)]
        );
    }

    // ---------------------------------------------------------------------------
    // encode / loading files
    // ---------------------------------------------------------------------------

    fn tiny_png() -> Vec<u8> {
        encode_png_chunks(&[
            (*b"IHDR", vec![0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
            (*b"IDAT", vec![1, 2, 3]),
            (*b"IEND", vec![]),
        ])
    }
    const SCENE: &str = r##"{"type":"excalidraw","version":2,"source":"x","elements":[{"id":"r","type":"rectangle","x":1,"y":2,"width":30,"height":40}],"appState":{"viewBackgroundColor":"#123456"},"files":{}}"##;

    #[test]
    fn encode_round_trips() {
        for compress in [true, false] {
            let d = encode("héllo ✓", compress);
            assert_eq!(decode(&d).unwrap(), "héllo ✓");
        }
        let png = encode_png_metadata(&tiny_png(), SCENE).unwrap();
        assert_eq!(
            png_chunks(&png)
                .unwrap()
                .iter()
                .map(|c| c.0)
                .collect::<Vec<_>>(),
            [*b"IHDR", *b"IDAT", *b"tEXt", *b"IEND"]
        );
        assert_eq!(decode_png_metadata(&png).unwrap(), SCENE);
        assert_eq!(
            decode_png_metadata(&tiny_png()),
            Err(SceneDataError::NoScene)
        );
        let svg = format!(
            "<svg><metadata>{}</metadata></svg>",
            encode_svg_base64_payload(SCENE)
        );
        assert_eq!(decode_svg_base64_payload(&svg).unwrap(), SCENE);
        assert_eq!(
            decode_svg_base64_payload("<svg/>"),
            Err(SceneDataError::NoScene)
        );
        // version 1: base64 of UTF-8, and legacy un-encoded scene JSON
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(SCENE);
        let v1 = format!(
            "<svg><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-start -->{b64}<!-- payload-end --></svg>"
        );
        assert_eq!(decode_svg_base64_payload(&v1).unwrap(), SCENE);
        let broken = "<svg><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-start -->e30=<!-- payload-end --></svg>";
        assert_eq!(
            decode_svg_base64_payload(broken),
            Err(SceneDataError::Failed)
        );
    }

    #[test]
    fn load_from_blob_formats() {
        let o = RestoreOpts::load();
        let s = load_from_blob(SCENE.as_bytes(), "", "a.excalidraw", None, None, &o).unwrap();
        assert_eq!(s.elements.len(), 1);
        assert_eq!(s.app_state.view_background_color, "#123456");
        let png = encode_png_metadata(&tiny_png(), SCENE).unwrap();
        assert_eq!(
            load_from_blob(&png, mime::PNG, "a.png", None, None, &o)
                .unwrap()
                .elements[0]
                .id,
            "r"
        );
        let svg = format!("<svg>{}</svg>", encode_svg_base64_payload(SCENE));
        assert_eq!(
            load_from_blob(svg.as_bytes(), mime::SVG, "a.svg", None, None, &o)
                .unwrap()
                .elements[0]
                .width,
            30.
        );
        assert_eq!(
            load_from_blob(&tiny_png(), mime::PNG, "a.png", None, None, &o),
            Err(LoadError::ImageWithoutScene)
        );
        assert_eq!(
            load_from_blob(
                br#"{"type":"excalidrawlib","version":2}"#,
                "",
                "l.excalidrawlib",
                None,
                None,
                &o
            ),
            Err(LoadError::Library)
        );
        assert_eq!(
            load_from_blob(b"nope", "", "x.json", None, None, &o),
            Err(LoadError::Invalid)
        );
        // drops: a lone PNG with a scene, plain images, scene files
        let files = [DroppedFile {
            name: "a.png",
            mime_type: mime::PNG,
            bytes: &png,
        }];
        assert!(matches!(route_drop(&files, None), DropContent::Scene(_)));
        let plain = tiny_png();
        let files = [DroppedFile {
            name: "a.png",
            mime_type: mime::PNG,
            bytes: &plain,
        }];
        assert_eq!(route_drop(&files, None), DropContent::Images(vec![0]));
        let files = [DroppedFile {
            name: "s.excalidraw",
            mime_type: "",
            bytes: SCENE.as_bytes(),
        }];
        assert!(matches!(
            route_drop(&files, None),
            DropContent::SceneFile(_)
        ));
    }

    // ---------------------------------------------------------------------------
    // clipboard.test.tsx
    // ---------------------------------------------------------------------------

    struct Paste {
        scene: Scene,
        files: BTreeMap<String, FileData>,
        app: AppState,
    }
    impl Paste {
        fn new(elements: Vec<Element>) -> Self {
            Paste {
                scene: Scene::new(elements),
                files: BTreeMap::new(),
                app: AppState::default(),
            }
        }
        /// A paste event with this text at `at` (the frame under the cursor
        /// as the app finds it).
        fn paste(
            &mut self,
            text: &str,
            plain: bool,
            at: Point,
            frame: Option<&str>,
        ) -> Option<PasteResult> {
            let data = parse_clipboard(Some(text), None, plain);
            match route_paste(&data, &[], plain) {
                PasteContent::Elements { elements, .. } => {
                    let els = restore_pasted_elements(&elements);
                    let o = PasteOpts {
                        scene_point: at,
                        grid_size: None,
                        retain_seed: plain,
                        preserve_frame_children_order: true,
                        top_layer_frame: frame,
                        measure: M,
                        hooks: &NO_BINDING_HOOKS,
                    };
                    add_elements_from_paste_or_library(
                        &mut self.scene,
                        &mut self.files,
                        &els,
                        None,
                        &self.app,
                        &o,
                    )
                }
                PasteContent::Text(t) => {
                    let els =
                        text_elements_from_paste(&t, plain, at, &self.app, 10000., M, &|_| None);
                    let mut all = self.scene.elements_including_deleted().to_vec();
                    all.extend(els);
                    self.scene.replace_all_elements(all);
                    None
                }
                _ => None,
            }
        }
        fn els(&self) -> &[Element] {
            self.scene.elements_including_deleted()
        }
    }
    fn clip(elements: &[&Element]) -> String {
        serialize_as_clipboard_json(elements, None)
    }

    #[test]
    fn paste_randomizes_seed_unless_plain() {
        setup();
        let r = rect("r", 0., 0., 10., 10.);
        let mut p = Paste::new(vec![]);
        p.paste(&clip(&[&r]), false, [0., 0.], None);
        assert_eq!(p.els().len(), 1);
        assert_ne!(p.els()[0].seed, r.seed);
        let mut p = Paste::new(vec![]);
        p.paste(&clip(&[&r]), true, [0., 0.], None);
        assert_eq!(p.els().len(), 1);
        assert_eq!(p.els()[0].seed, r.seed);
    }

    #[test]
    fn paste_text_as_lines() {
        setup();
        let mut p = Paste::new(vec![]);
        p.paste("sajgfakfn\naaksfnknas\nakefnkasf", false, [0., 0.], None);
        assert_eq!(p.els().len(), 3);
        let mut p = Paste::new(vec![]);
        p.paste(
            "\n\nsajgfakfn\n\n\naaksfnknas\n\nakefnkasf\n\n\n",
            false,
            [0., 0.],
            None,
        );
        assert_eq!(p.els().len(), 3);
        let mut p = Paste::new(vec![]);
        p.paste("\n\n\n\n\n", false, [0., 0.], None);
        assert_eq!(p.els().len(), 0);
        let mut p = Paste::new(vec![]);
        p.paste("sajgfakfn\naaksfnknas\nakefnkasf", true, [0., 0.], None);
        assert_eq!(p.els().len(), 1);
    }

    #[test]
    fn paste_text_spacing() {
        setup();
        let app = AppState::default();
        let lh = get_line_height_in_px(
            app.current_item_font_size,
            get_line_height(app.current_item_font_family),
        ) + 10.;
        let mut p = Paste::new(vec![]);
        p.paste("hkhkjhki\njgkjhffjh\njgkjhffjh", false, [100., 100.], None);
        let els = p.els().to_vec();
        let y0 = get_element_bounds(&els[0], &els, false)[1];
        for (i, e) in els.iter().enumerate().skip(1) {
            assert_eq!(get_element_bounds(e, &els, false)[1], y0 + lh * i as f64);
        }
        let mut p = Paste::new(vec![]);
        p.paste("hkhkjhki\n\njgkjhffjh", false, [100., 100.], None);
        let els = p.els().to_vec();
        assert_eq!(
            get_element_bounds(&els[1], &els, false)[1],
            get_element_bounds(&els[0], &els, false)[1] + lh * 2.
        );
    }

    fn bound_text_clip(ty: &str) -> String {
        json!({"type": "excalidraw/clipboard", "elements": [
            {"type": ty, "id": "container-id", "x": 554.984375, "y": 196.0234375, "width": 166, "height": 187.01953125, "roundness": {"type": 2},
             "boundElements": [{"type": "text", "id": "text-id"}]},
            {"type": "text", "id": "text-id", "x": 560.51171875, "y": 202.033203125, "width": 154, "height": 175, "fontSize": 20, "fontFamily": 1,
             "text": "Excalidraw is a\nvirtual \nopensource \nwhiteboard for \nsketching \nhand-drawn like\ndiagrams", "baseline": 168,
             "textAlign": "center", "verticalAlign": "middle", "containerId": "container-id",
             "originalText": "Excalidraw is a virtual opensource whiteboard for sketching hand-drawn like diagrams"},
        ]}).to_string()
    }

    #[test]
    fn paste_bound_text_container() {
        setup();
        let mut p = Paste::new(vec![]);
        p.paste(&bound_text_clip("ellipse"), true, [0., 0.], None);
        assert_eq!(p.els().len(), 2);
        assert_eq!((p.els()[0].height, p.els()[0].width), (368., 166.));
        let mut p = Paste::new(vec![]);
        p.paste(&bound_text_clip("diamond"), true, [0., 0.], None);
        assert_eq!((p.els()[0].height, p.els()[0].width), (770., 166.));
    }

    fn frame(id: &str, x: f64, y: f64, w: f64, h: f64) -> Element {
        new_frame_element(
            ElementOpts {
                id: Some(id.into()),
                x,
                y,
                width: w,
                height: h,
                ..Default::default()
            },
            None,
        )
    }

    #[test]
    fn paste_into_frame_under_cursor() {
        setup();
        let f = frame("frame", 0., 0., 100., 100.);
        let r = rect("r", 0., 0., 10., 10.);
        let mut p = Paste::new(vec![f.clone()]);
        p.paste(&clip(&[&r]), false, [50., 50.], Some("frame"));
        let e = p.els();
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].ty(), ElementType::Rectangle);
        assert_eq!(e[0].frame_id.as_deref(), Some("frame"));
        assert_eq!(e[1].id, "frame");
        assert!(e[0].index < e[1].index);
    }

    #[test]
    fn paste_above_highest_frame_child() {
        setup();
        let f = frame("frame", 0., 0., 100., 100.);
        let mut child = rect("frameChild", 10., 10., 20., 20.);
        child.frame_id = Some("frame".into());
        let r = rect("r", 0., 0., 10., 10.);
        let mut p = Paste::new(vec![child, f]);
        p.paste(&clip(&[&r]), false, [50., 50.], Some("frame"));
        let e = p.els();
        assert_eq!(e.len(), 3);
        assert_eq!(e[1].frame_id.as_deref(), Some("frame"));
        assert_eq!(
            [e[0].id.as_str(), e[2].id.as_str()],
            ["frameChild", "frame"]
        );
        assert!(e[1].index > e[0].index && e[1].index < e[2].index);
    }

    #[test]
    fn paste_frame_with_denormalized_child_order() {
        setup();
        let f = frame("frame", 0., 0., 100., 100.);
        let mut child = rect("child", 10., 10., 20., 20.);
        child.frame_id = Some("frame".into());
        let mut p = Paste::new(vec![]);
        p.paste(&clip(&[&f, &child]), false, [200., 200.], None);
        let e = p.els();
        assert_eq!(e.len(), 2);
        assert_eq!(
            (e[0].ty(), e[1].ty()),
            (ElementType::Frame, ElementType::Rectangle)
        );
        assert_eq!(e[1].frame_id.as_ref(), Some(&e[0].id));
    }

    #[test]
    fn paste_outside_frame_leaves_it() {
        setup();
        let f = frame("frame", 0., 0., 100., 100.);
        let mut r = rect("r", 10., 10., 50., 50.);
        r.frame_id = Some("frame".into());
        let mut p = Paste::new(vec![f]);
        p.paste(&clip(&[&r]), false, [150., 150.], None);
        assert_eq!(p.els().len(), 2);
        assert_eq!(p.els()[1].frame_id, None);
    }

    #[test]
    fn paste_filters_elements_not_overlapping_frame() {
        setup();
        let f = frame("frame", 0., 0., 100., 100.);
        let (r1, r2) = (
            rect("r1", 0., 0., 50., 50.),
            rect("r2", 100., 100., 50., 50.),
        );
        let mut p = Paste::new(vec![f.clone()]);
        p.paste(&clip(&[&r1, &r2]), false, [90., 90.], Some("frame"));
        let e = p.els();
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].frame_id.as_deref(), Some("frame"));
        assert_eq!(e[1].id, "frame");
        assert_eq!(e[2].frame_id, None);
        // unless grouped
        let (mut g1, mut g2) = (r1.clone(), r2.clone());
        g1.group_ids = vec!["g1".into()];
        g2.group_ids = vec!["g1".into()];
        let mut p = Paste::new(vec![f.clone()]);
        p.paste(&clip(&[&g1, &g2]), false, [90., 90.], Some("frame"));
        let e = p.els();
        assert_eq!(e.len(), 3);
        assert_eq!(
            (
                e[0].frame_id.as_deref(),
                e[1].frame_id.as_deref(),
                e[2].id.as_str()
            ),
            (Some("frame"), Some("frame"), "frame")
        );
    }

    #[test]
    fn paste_keeps_other_frames_and_children() {
        setup();
        let f = frame("frame", 0., 0., 100., 100.);
        let mut r = rect("r", 0., 0., 50., 50.);
        r.group_ids = vec!["g1".into()];
        let f2 = frame("frame2", 0., 0., 75., 75.);
        let mut r2 = rect("r2", 55., 55., 50., 50.);
        r2.frame_id = Some("frame2".into());
        let mut p = Paste::new(vec![f]);
        p.paste(&clip(&[&r, &r2, &f2]), false, [90., 90.], Some("frame"));
        let e = p.els();
        assert_eq!(e.len(), 4);
        assert_eq!(e[0].frame_id.as_deref(), Some("frame"));
        assert_eq!(e[1].id, "frame");
        assert_eq!(e[2].frame_id.as_ref(), Some(&e[3].id));
        assert_eq!(
            (e[3].ty(), e[3].frame_id.as_deref()),
            (ElementType::Frame, None)
        );
    }

    #[test]
    fn clipboard_json_and_parsing() {
        setup();
        let mut img = image(0., 0., 10., 10.);
        img.image_mut().unwrap().file_id = Some("f1".into());
        let mut files = BTreeMap::new();
        files.insert(
            "f1".to_string(),
            FileData {
                id: "f1".into(),
                mime_type: mime::PNG.into(),
                data_url: Some("data:image/png;base64,AA==".into()),
                path: None,
                created: 1,
                last_retrieved: None,
                version: None,
                extra: Default::default(),
            },
        );
        files.insert("unused".to_string(), files["f1"].clone());
        let json = serialize_as_clipboard_json(&[&img], Some(&files));
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "excalidraw/clipboard");
        assert_eq!(
            v["files"].as_object().unwrap().keys().collect::<Vec<_>>(),
            ["f1"]
        );
        assert!(!serialize_as_clipboard_json(&[&img], None).contains("\"files\""));
        let out = copy_to_clipboard(&[&img], None);
        assert_eq!(
            out.iter().map(|o| o.0).collect::<Vec<_>>(),
            [mime::EXCALIDRAW_CLIPBOARD, mime::TEXT]
        );
        let d = parse_clipboard(Some(&json), None, false);
        assert!(d.elements.is_some() && d.files.is_some() && d.text.is_none());
        let d = parse_clipboard(Some(&json), None, true);
        assert!(d.text.is_some());
        let d = parse_clipboard(
            Some(
                r#"{"type":"excalidraw-api/clipboard","elements":[{"type":"rectangle","x":0,"y":0}]}"#,
            ),
            None,
            false,
        );
        assert!(d.programmatic_api);
        assert!(matches!(
            route_paste(&d, &[], false),
            PasteContent::Elements {
                skeletons: true,
                ..
            }
        ));
        // HTML: mixed content unless it's all text
        let html = r#"<html><body><p>Hello</p><img src="https://x/y.png"><img src="data:z"></body></html>"#;
        let d = parse_clipboard(Some("Hello"), Some(html), false);
        assert_eq!(
            d.mixed_content,
            Some(vec![
                MixedItem::Text("Hello".into()),
                MixedItem::ImageUrl("https://x/y.png".into())
            ])
        );
        let d = parse_clipboard(None, Some("<p> a </p><div>b</div>"), false);
        assert_eq!(d.text.as_deref(), Some("a\nb"));
        let d = parse_clipboard(Some("  <svg></svg> "), None, false);
        assert_eq!(
            route_paste(&d, &[], false),
            PasteContent::SvgText("<svg></svg>".into())
        );
        assert_eq!(
            route_paste(&d, &[mime::PNG], false),
            PasteContent::ImageFiles(vec![0])
        );
        assert_eq!(
            route_paste(&parse_clipboard(Some(""), None, false), &[], false),
            PasteContent::Nothing
        );
        // copying: the selection with bound text and frame children
        let mut c = rect("c", 0., 0., 10., 10.);
        c.bound_elements = Some(vec![BoundElement {
            id: "t".into(),
            kind: BoundType::Text,
        }]);
        let t = new_text_element(
            TextOpts {
                text: "x".into(),
                container_id: Some("c".into()),
                ..Default::default()
            },
            ElementOpts {
                id: Some("t".into()),
                ..Default::default()
            },
            M,
        );
        let els = vec![c, t, rect("other", 0., 0., 1., 1.)];
        let app = AppState {
            selected_element_ids: ["c".to_string()].into(),
            ..Default::default()
        };
        assert_eq!(
            get_elements_to_copy(&els, &app)
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "t"]
        );
    }

    // ---------------------------------------------------------------------------
    // transform.test.ts
    // ---------------------------------------------------------------------------

    fn convert(v: Value, regenerate_ids: bool) -> Vec<Element> {
        convert_to_excalidraw_elements(
            &v,
            &TransformOpts {
                regenerate_ids,
                measure: M,
                hooks: &NO_BINDING_HOOKS,
            },
        )
        .unwrap()
    }

    #[test]
    fn transform_ids() {
        setup();
        let v = json!([{"type": "rectangle", "x": 100, "y": 100, "id": "rect-1"}]);
        let d = convert(v.clone(), true);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].id, "id0");
        assert_eq!(convert(v, false)[0].id, "rect-1");
    }

    #[test]
    fn transform_regular_shapes() {
        setup();
        let d = convert(
            json!([
                {"type": "rectangle", "x": 100, "y": 100},
                {"type": "diamond", "x": 300, "y": 400, "width": 200, "height": 100, "backgroundColor": "#a5d8ff", "strokeColor": "#1971c2",
                 "strokeStyle": "dashed", "fillStyle": "cross-hatch", "strokeWidth": 2},
            ]),
            false,
        );
        assert_eq!(
            (d[0].x, d[0].y, d[0].width, d[0].height),
            (100., 100., 100., 100.)
        );
        assert_eq!(d[1].ty(), ElementType::Diamond);
        assert_eq!(
            (
                d[1].width,
                d[1].stroke_style,
                d[1].fill_style,
                d[1].stroke_color.as_str()
            ),
            (200., StrokeStyle::Dashed, FillStyle::CrossHatch, "#1971c2")
        );
        assert!(d.iter().all(|e| e.index.is_some()));
    }

    #[test]
    fn transform_text_and_linear() {
        setup();
        let d = convert(
            json!([
                {"type": "text", "x": 100, "y": 100, "text": "HELLO WORLD!"},
                {"type": "line", "x": 100, "y": 60},
                {"type": "arrow", "x": 100, "y": 20, "points": [[0, 0], [50, 30]]},
            ]),
            false,
        );
        assert_eq!((d[0].width, d[0].height), (120., 25.));
        assert_eq!(d[1].points().unwrap(), [[0., 0.], [100., 0.]]);
        assert_eq!((d[1].width, d[1].height), (100., 0.));
        assert_eq!(d[2].linear().unwrap().end_arrowhead, Some(Arrowhead::Arrow));
        assert_eq!((d[2].width, d[2].height), (50., 30.));
    }

    #[test]
    fn transform_text_containers() {
        setup();
        let d = convert(
            json!([
                {"type": "rectangle", "x": 100, "y": 100, "label": {"text": "RECTANGLE TEXT CONTAINER"}},
                {"type": "ellipse", "x": 500, "y": 100, "width": 200, "label": {"text": "ELLIPSE TEXT CONTAINER"}},
                {"type": "diamond", "x": 100, "y": 150, "width": 280, "label": {"text": "DIAMOND\nTEXT CONTAINER"}},
                {"type": "diamond", "x": 100, "y": 400, "width": 300, "backgroundColor": "#fff3bf", "strokeWidth": 2,
                 "label": {"text": "STYLED DIAMOND TEXT CONTAINER", "strokeColor": "#099268", "fontSize": 20}},
                {"type": "rectangle", "x": 500, "y": 300, "width": 200, "strokeColor": "#c2255c",
                 "label": {"text": "TOP LEFT ALIGNED RECTANGLE TEXT CONTAINER", "textAlign": "left", "verticalAlign": "top", "fontSize": 20}},
                {"type": "ellipse", "x": 500, "y": 500, "strokeColor": "#f08c00", "backgroundColor": "#ffec99", "width": 200,
                 "label": {"text": "STYLED ELLIPSE TEXT CONTAINER", "strokeColor": "#c2255c"}},
            ]),
            false,
        );
        assert_eq!(d.len(), 12);
        assert_eq!(
            (d[0].x, d[0].y, d[0].width, d[0].height),
            (100., 100., 250., 35.)
        );
        let t = &d[6];
        assert_eq!(t.container_id(), Some(d[0].id.as_str()));
        assert_eq!((t.x, t.y, t.width, t.height), (105., 105., 240., 25.));
        assert_eq!(d[0].bound_text_id(), Some(t.id.as_str()));
        assert_eq!(d[9].stroke_color, "#099268");
        assert_eq!(d[10].text().unwrap().text_align, TextAlign::Left);
        assert_eq!(d[11].stroke_color, "#c2255c");
    }

    #[test]
    fn transform_labelled_arrows() {
        setup();
        let d = convert(
            json!([
                {"type": "arrow", "x": 100, "y": 100, "label": {"text": "LABELED ARROW"}},
                {"type": "arrow", "x": 100, "y": 200, "label": {"text": "STYLED LABELED ARROW", "strokeColor": "#099268", "fontSize": 20}},
                {"type": "arrow", "x": 100, "y": 300, "strokeColor": "#1098ad", "strokeWidth": 2, "label": {"text": "ANOTHER STYLED LABELLED ARROW"}},
                {"type": "arrow", "x": 100, "y": 400, "strokeColor": "#1098ad", "strokeWidth": 2, "label": {"text": "ANOTHER STYLED LABELLED ARROW", "strokeColor": "#099268"}},
            ]),
            false,
        );
        assert_eq!(d.len(), 8);
        assert_eq!((d[0].width, d[0].height), (100., 0.));
        let t = &d[4];
        assert_eq!(t.text().unwrap().label_position, Some(Some(0.5)));
        assert_eq!((t.x, t.y, t.width, t.height), (85., 87.5, 130., 25.));
        assert_eq!(d[6].stroke_color, "#1098ad");
        assert_eq!(d[7].stroke_color, "#099268");
    }

    fn frame_skeletons(extra: Value) -> Value {
        let mut f = json!({"type": "frame", "children": ["1", "2"], "name": "My frame"});
        for (k, v) in extra.as_object().unwrap() {
            f[k] = v.clone();
        }
        json!([
            {"type": "rectangle", "x": 10, "y": 10, "strokeWidth": 2, "id": "1"},
            {"type": "diamond", "x": 120, "y": 20, "backgroundColor": "#fff3bf", "strokeWidth": 2, "label": {"text": "HELLO EXCALIDRAW", "strokeColor": "#099268", "fontSize": 30}, "id": "2"},
            f,
        ])
    }

    #[test]
    fn transform_frames() {
        setup();
        let d = convert(frame_skeletons(json!({})), true);
        assert_eq!(d.len(), 4);
        let f = d.iter().find(|e| e.is_frame()).unwrap();
        assert_eq!(f.frame_name(), Some("My frame"));
        assert!(
            d.iter()
                .filter(|e| !e.is_frame())
                .all(|e| e.frame_id.as_ref() == Some(&f.id))
        );
        assert_eq!((f.x, f.y), (0., 0.));
        let d = convert(frame_skeletons(json!({"width": 800, "height": 100})), false);
        let f = d.iter().find(|e| e.is_frame()).unwrap();
        assert_eq!((f.width, f.height), (800., 100.));
        let d = convert(frame_skeletons(json!({"x": 100, "y": 300})), false);
        let f = d.iter().find(|e| e.is_frame()).unwrap();
        assert_eq!((f.x, f.y), (100., 300.));
        let bad = convert_to_excalidraw_elements(
            &json!([{"type": "frame", "children": ["nope"]}]),
            &TransformOpts {
                regenerate_ids: false,
                measure: M,
                hooks: &NO_BINDING_HOOKS,
            },
        );
        assert!(bad.is_err());
    }

    #[test]
    fn transform_binds_arrows_to_created_shapes() {
        setup();
        let d = convert(
            json!([{"type": "arrow", "x": 255, "y": 239, "label": {"text": "HELLO WORLD!!"}, "start": {"type": "rectangle"}, "end": {"type": "ellipse"}}]),
            false,
        );
        assert_eq!(d.len(), 4);
        let (arrow, text, r, e) = (&d[0], &d[1], &d[2], &d[3]);
        assert!((arrow.y - 239.).abs() < 0.05);
        assert_eq!(arrow.x, 261.);
        assert_eq!(arrow.bound_text_id(), Some(text.id.as_str()));
        let l = arrow.linear().unwrap();
        assert_eq!(l.start_binding.as_ref().unwrap().element_id, r.id);
        assert_eq!(l.end_binding.as_ref().unwrap().element_id, e.id);
        assert!((text.x - 240.).abs() < 0.05 && (text.y - 226.5).abs() < 0.05);
        assert_eq!(text.text().unwrap().text, "HELLO WORLD!!");
        assert_eq!((r.x, r.y, r.ty()), (155., 189., ElementType::Rectangle));
        assert_eq!(
            r.bound_elements,
            Some(vec![BoundElement {
                id: arrow.id.clone(),
                kind: BoundType::Arrow
            }])
        );
        assert_eq!((e.x, e.y, e.ty()), (355., 189., ElementType::Ellipse));
    }

    #[test]
    fn transform_binds_arrows_to_existing_by_id() {
        setup();
        let d = convert(
            json!([
                {"type": "ellipse", "id": "ellipse-1", "strokeColor": "#66a80f", "x": 630, "y": 316, "width": 300, "height": 300, "backgroundColor": "#d8f5a2"},
                {"type": "diamond", "id": "diamond-1", "strokeColor": "#9c36b5", "width": 140, "x": 96, "y": 400},
                {"type": "arrow", "x": 247, "y": 420, "width": 395, "height": 35, "strokeColor": "#1864ab", "start": {"type": "rectangle", "width": 300, "height": 300}, "end": {"id": "ellipse-1"}},
                {"type": "arrow", "x": 227, "y": 450, "width": 400, "strokeColor": "#e67700", "start": {"id": "diamond-1"}, "end": {"id": "ellipse-1"}},
            ]),
            false,
        );
        assert_eq!(d.len(), 5);
        let ell = d.iter().find(|e| e.id == "ellipse-1").unwrap();
        assert_eq!(ell.bound_elements.as_ref().unwrap().len(), 2);
        assert_eq!(
            (ell.x, ell.width, ell.stroke_color.as_str()),
            (630., 300., "#66a80f")
        );
        let arrows: Vec<&Element> = d.iter().filter(|e| e.is_arrow()).collect();
        assert_eq!(
            arrows[1]
                .linear()
                .unwrap()
                .start_binding
                .as_ref()
                .unwrap()
                .element_id,
            "diamond-1"
        );
        assert!(
            arrows.iter().all(
                |a| a.linear().unwrap().end_binding.as_ref().unwrap().element_id == "ellipse-1"
            )
        );
        let r = d.iter().find(|e| e.ty() == ElementType::Rectangle).unwrap();
        assert_eq!((r.width, r.height), (300., 300.));
    }

    #[test]
    fn transform_duplicate_ids_and_custom_data() {
        setup();
        let d = convert(
            json!([
                {"type": "rectangle", "x": 300, "y": 100, "id": "rect-1", "width": 100, "height": 200},
                {"type": "rectangle", "x": 100, "y": 200, "id": "rect-1", "width": 100, "height": 200},
            ]),
            false,
        );
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].x, 300.);
        let d = convert(
            json!([{"type": "rectangle", "x": 100, "y": 100, "customData": {"createdBy": "user01"}}]),
            false,
        );
        assert_eq!(d[0].custom_data, Some(json!({"createdBy": "user01"})));
    }

    #[test]
    fn transform_sticky_notes() {
        setup();
        let d = convert(json!([{"type": "stickynote", "x": 100, "y": 100}]), false);
        assert_eq!(d.len(), 1);
        assert_eq!(
            (d[0].width, d[0].height),
            (DEFAULT_STICKY_NOTE_SIZE, DEFAULT_STICKY_NOTE_SIZE)
        );
        assert_eq!(
            d[0].kind,
            Kind::StickyNote {
                base_height: DEFAULT_STICKY_NOTE_SIZE
            }
        );
        assert_eq!(
            (d[0].background_color.as_str(), d[0].fill_style),
            (DEFAULT_STICKY_NOTE_BG, FillStyle::Solid)
        );
        let d = convert(
            json!([{"type": "stickynote", "x": 0, "y": 0, "width": 10, "height": 300, "backgroundColor": "transparent", "strokeColor": "transparent"}]),
            false,
        );
        assert_eq!((d[0].width, d[0].height), (STICKY_NOTE_MIN_SIZE, 300.));
        assert_eq!(d[0].background_color, DEFAULT_STICKY_NOTE_BG);
        assert_ne!(d[0].stroke_color, "transparent");
        let d = convert(
            json!([{"type": "stickynote", "x": 0, "y": 0, "strokeColor": "#1971c2", "label": {"text": "hello", "strokeColor": "#e03131"}}]),
            false,
        );
        assert_eq!(
            (d[0].stroke_color.as_str(), d[1].stroke_color.as_str()),
            ("#e03131", "#e03131")
        );
        let d = convert(
            json!([{"type": "stickynote", "x": 100, "y": 100, "strokeColor": "#1971c2", "label": {"text": "hello", "fontSize": 28}}]),
            false,
        );
        assert_eq!(d.len(), 2);
        let t = d[1].text().unwrap();
        assert_eq!(d[1].container_id(), Some(d[0].id.as_str()));
        assert_eq!((t.base_font_size, t.font_size), (Some(28.), 28.));
        assert_eq!(d[1].stroke_color, "#1971c2");
        assert_eq!(d[0].height, DEFAULT_STICKY_NOTE_SIZE);
        let long = vec!["abcdefghijklmnopqrstuvwx"; 40].join("\n");
        let d = convert(
            json!([{"type": "stickynote", "x": 0, "y": 0, "label": {"text": long, "fontSize": 28}}]),
            false,
        );
        assert_eq!(d[1].text().unwrap().font_size, STICKY_NOTE_MIN_FONT_SIZE);
        assert!(d[0].height > DEFAULT_STICKY_NOTE_SIZE);
    }

    #[test]
    fn transform_clamps_label_positions() {
        setup();
        let d = convert(
            json!([
                {"type": "arrow", "x": 0, "y": 0, "label": {"text": "a", "labelPosition": 2}},
                {"type": "arrow", "x": 0, "y": 100, "label": {"text": "b", "labelPosition": -1}},
                {"type": "arrow", "x": 0, "y": 200, "label": {"text": "c", "labelPosition": 0.25}},
            ]),
            false,
        );
        let lp = |i: usize| d[i].text().unwrap().label_position.flatten();
        assert_eq!((lp(3), lp(4), lp(5)), (Some(1.), Some(0.), Some(0.25)));
    }
}
