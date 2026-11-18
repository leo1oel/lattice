// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! element/tests/dragElements.test.ts, element/tests/frame.test.tsx and
//! excalidraw/tests/move.test.tsx @ 3a317b5. A pointer drag of the selection
//! is `drag_selected_elements` with the pointer's offset from where it went
//! down; dropping it (pointer up) is `drop_selection_into_frame` with the
//! frame the app's hit test found under the pointer; drawing a frame is
//! `get_elements_in_new_frame` + `add_elements_to_frame`, resizing one is
//! `get_elements_in_resizing_frame` + `replace_all_elements_in_frame`, as the
//! app's pointer up does.
//!
//! Skipped, with reasons:
//! - dragElements "passes every bound-arrow update the same moved-element
//!   array": a spy on the per-array id-set cache we don't have; the moves are
//!   checked instead.
//! - frame: "highlight the target frame while creating / hovering", "not add
//!   a newly created element / not drag an element into a frame behind a
//!   non-frame element" and their "over a non-frame element" twins, "keep
//!   dragging a frame child over a non-frame element", "not add grid-snapped
//!   text outside the frame": the app's frame hit test under the pointer
//!   (`getTopLayerFrameAtSceneCoords`), not frame.ts.
//! - frame: "preview a dragged element above the highest frame child" and
//!   "not preview reorder …": the renderer's renderable-element order.
//! - frame: the `describe.skip` / `it.skip` cases upstream skips.
//! - frame: "select an arrow by its part outside its frame" (hit testing),
//!   the export half of "not clip an arrow" (canvas / SVG export events),
//!   "take an arrow out of its frame when neither of its ends is in it"
//!   (linear editor point drag), "… from the stats panel" (both: stats
//!   panel UI), "… when resizing the frame leaves its ends out" (resize is
//!   resize.rs'), the elbow fixed-segment cases (elbow routing is elbow.rs').
//! - move: the render-count snapshots; "duplicate element on move when ALT
//!   is clicked" (duplication during a drag is the app's / duplicate.rs').
//!   "shift-drag moves along one axis only": the axis lock is the selection
//!   tool's; checked as the offset it hands over.

use super::common::*;
use lattice_board_core::board::actions::*;
use lattice_board_core::board::app_state::{AppState, ToolType};
use lattice_board_core::board::binding::{NO_BINDING_HOOKS, bind_binding_element};
use lattice_board_core::board::bounds::get_point_at_index_global_coordinates;
use lattice_board_core::board::drag::*;
use lattice_board_core::board::frame::*;
use lattice_board_core::board::groups::GroupSelection;
use lattice_board_core::board::new_element::*;
use lattice_board_core::board::scene::Scene;
use lattice_board_core::board::text_measure::TestMeasure;
use lattice_board_core::board::types::*;
use lattice_board_core::board::utils::array_to_map;
use std::collections::BTreeSet;

fn frame(id: &str, x: f64, y: f64, w: f64, h: f64) -> Element {
    new_frame_element(opts(id, x, y, w, h), None)
}
fn in_frame(mut e: Element, f: &str) -> Element {
    e.frame_id = Some(f.into());
    e
}
fn text(id: &str, x: f64, y: f64, w: f64, h: f64, container: Option<&str>) -> Element {
    let mut t = new_text_element(
        TextOpts {
            text: "test".into(),
            container_id: container.map(String::from),
            ..Default::default()
        },
        opts(id, x, y, w, h),
        &TestMeasure,
    );
    (t.x, t.y, t.width, t.height) = (x, y, w, h);
    t
}
fn ids(els: &[Element]) -> Vec<&str> {
    els.iter().map(|e| e.id.as_str()).collect()
}
fn get<'a>(els: &'a [Element], id: &str) -> &'a Element {
    els.iter().find(|e| e.id == id).unwrap()
}
fn sel(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// The drag test's `drag`: a pointer-down snapshot, then one move.
fn drag(scene: &mut Scene, selected: &[&str], offset: [f64; 2]) {
    let ds = DragState::new(scene);
    drag_selected_elements(
        &ds,
        &sel(selected),
        offset,
        scene,
        [0., 0.],
        None,
        &NO_BINDING_HOOKS,
    );
}

/// Drag the selection by `offset` and drop it over `frame`.
fn drag_and_drop(
    els: Vec<Element>,
    selected: &[&str],
    offset: [f64; 2],
    frame: Option<&str>,
) -> Vec<Element> {
    let mut scene = Scene::new(els);
    drag(&mut scene, selected, offset);
    let mut all = scene.into_elements();
    let a = AppState {
        selected_element_ids: selected.iter().map(|s| s.to_string()).collect(),
        frame_to_highlight: frame.map(String::from),
        ..Default::default()
    };
    drop_selection_into_frame(&mut all, frame, &FrameState::new(&a, true));
    all
}

/// `dragElementIntoFrame`: the element's centre to the frame's.
fn drag_element_into_frame(els: Vec<Element>, f: &str, e: &str) -> Vec<Element> {
    let (fe, ee) = (get(&els, f).clone(), get(&els, e).clone());
    let off = [
        fe.x + fe.width / 2. - (ee.x + ee.width / 2.),
        fe.y + fe.height / 2. - (ee.y + ee.height / 2.),
    ];
    drag_and_drop(els, &[e], off, Some(f))
}

// ---------------------------------------------------------------------------
// dragElements.test.ts
// ---------------------------------------------------------------------------

fn bound_arrow_scene() -> Scene {
    let mut r = rect("rectangle", 0., 0., 100., 100.);
    r.bound_elements = Some(vec![BoundElement {
        id: "arrow".into(),
        kind: BoundType::Arrow,
    }]);
    let mut a = arrow("arrow", 25., 25., vec![[0., 0.], [200., 0.]]);
    a.linear_mut().unwrap().start_binding = Some(FixedPointBinding {
        element_id: "rectangle".into(),
        fixed_point: [0.25, 0.25],
        mode: BindMode::Inside,
    });
    Scene::new(vec![r, a])
}

#[test]
fn drag_moves_each_selected() {
    setup();
    let els: Vec<Element> = (0..3)
        .map(|i| rect(&format!("r{i}"), i as f64 * 200., 0., 100., 100.))
        .collect();
    let mut s = Scene::new(els);
    drag(&mut s, &["r0", "r1", "r2"], [20., 30.]);
    let xy: Vec<(f64, f64)> = s.non_deleted_elements().map(|e| (e.x, e.y)).collect();
    assert_eq!(xy, [(20., 30.), (220., 30.), (420., 30.)]);
}

#[test]
fn drag_moves_grouped_elements_and_label_across_z_order() {
    setup();
    let mut r = rect("rectangle", 0., 0., 100., 100.);
    r.group_ids = vec!["group".into()];
    r.bound_elements = Some(vec![BoundElement {
        id: "label".into(),
        kind: BoundType::Text,
    }]);
    let mut label = text("label", 10., 15., 80., 20., Some("rectangle"));
    label.group_ids = vec!["group".into()];
    let unrelated = rect("unrelated", 500., 600., 100., 100.);
    let mut second = rect("second", 200., 300., 100., 100.);
    second.group_ids = vec!["group".into()];
    let mut s = Scene::new(vec![r, label, unrelated, second]);
    drag(&mut s, &["rectangle", "second"], [20., 30.]);
    let xy: Vec<(f64, f64)> = s.non_deleted_elements().map(|e| (e.x, e.y)).collect();
    assert_eq!(xy, [(20., 30.), (30., 45.), (500., 600.), (220., 330.)]);
    assert_eq!(
        ids(s.elements_including_deleted()),
        ["rectangle", "label", "unrelated", "second"]
    );
}

#[test]
fn drag_moves_frame_and_children_once() {
    setup();
    let f = frame("frame", 0., 0., 400., 400.);
    let els = vec![
        in_frame(rect("selectedChild", 10., 0., 100., 100.), "frame"),
        in_frame(rect("otherChild", 200., 0., 100., 100.), "frame"),
        f,
    ];
    let mut s = Scene::new(els);
    let versions: Vec<i64> = s.non_deleted_elements().map(|e| e.version).collect();
    drag(&mut s, &["frame", "selectedChild"], [20., 30.]);
    let xy: Vec<(f64, f64)> = s.non_deleted_elements().map(|e| (e.x, e.y)).collect();
    assert_eq!(xy, [(30., 30.), (220., 30.), (20., 30.)]);
    let next: Vec<i64> = s.non_deleted_elements().map(|e| e.version).collect();
    assert_eq!(next, versions.iter().map(|v| v + 1).collect::<Vec<_>>());
}

#[test]
fn drag_updates_an_unselected_bound_arrow() {
    setup();
    let mut s = bound_arrow_scene();
    drag(&mut s, &["rectangle"], [20., 30.]);
    let r = s.get_element("rectangle").unwrap();
    assert_eq!((r.x, r.y), (20., 30.));
    let a = s.get_element("arrow").unwrap();
    assert_eq!(get_point_at_index_global_coordinates(a, 0, &s), [45., 55.]);
    assert_eq!(
        get_point_at_index_global_coordinates(a, -1, &s),
        [225., 25.]
    );
    assert_eq!(
        a.linear()
            .unwrap()
            .start_binding
            .as_ref()
            .unwrap()
            .element_id,
        "rectangle"
    );
}

#[test]
fn drag_preserves_bindings_translating_arrow_with_its_element() {
    setup();
    let mut s = bound_arrow_scene();
    let a0 = s.get_element("arrow").unwrap().clone();
    drag(&mut s, &["rectangle", "arrow"], [20., 30.]);
    let a = s.get_element("arrow").unwrap();
    assert_eq!((a.x, a.y, a.version), (45., 55., a0.version + 1));
    assert_eq!(
        a.linear()
            .unwrap()
            .start_binding
            .as_ref()
            .unwrap()
            .element_id,
        "rectangle"
    );
    assert_eq!(a.points(), a0.points());
    assert_eq!(
        s.get_element("rectangle").unwrap().bound_elements,
        Some(vec![BoundElement {
            id: "arrow".into(),
            kind: BoundType::Arrow
        }])
    );
}

#[test]
fn drag_unbinds_translated_arrow_from_unselected_element() {
    setup();
    let mut s = bound_arrow_scene();
    drag(&mut s, &["arrow"], [20., 30.]);
    let a = s.get_element("arrow").unwrap();
    assert_eq!((a.x, a.y), (45., 55.));
    assert!(a.linear().unwrap().start_binding.is_none());
    let r = s.get_element("rectangle").unwrap();
    assert_eq!((r.x, r.y, r.bound_elements.clone()), (0., 0., Some(vec![])));
}

#[test]
fn drag_does_not_mutate_for_unchanged_coordinates() {
    setup();
    let mut s = Scene::new(vec![
        rect("a", 0., 0., 100., 100.),
        rect("b", 200., 0., 100., 100.),
    ]);
    let ds = DragState::new(&s);
    let versions =
        |s: &Scene| -> Vec<i64> { s.non_deleted_elements().map(|e| e.version).collect() };
    let initial = versions(&s);
    let ab = sel(&["a", "b"]);
    drag_selected_elements(
        &ds,
        &ab,
        [0., 0.],
        &mut s,
        [0., 0.],
        None,
        &NO_BINDING_HOOKS,
    );
    assert_eq!(versions(&s), initial);
    drag_selected_elements(
        &ds,
        &ab,
        [20., 30.],
        &mut s,
        [0., 0.],
        None,
        &NO_BINDING_HOOKS,
    );
    let moved = versions(&s);
    assert_eq!(moved, initial.iter().map(|v| v + 1).collect::<Vec<_>>());
    drag_selected_elements(
        &ds,
        &ab,
        [20., 30.],
        &mut s,
        [0., 0.],
        None,
        &NO_BINDING_HOOKS,
    );
    assert_eq!(versions(&s), moved);
}

// ---------------------------------------------------------------------------
// frame.test.tsx: adding elements to frames
// ---------------------------------------------------------------------------

// API.createElement: height defaults to width
fn frame0() -> Element {
    frame("id0", 0., 0., 150., 150.)
}
fn rect2() -> Element {
    rect("id2", 200., 0., 50., 50.)
}

#[test]
fn element_fully_containing_frame_overlaps_it() {
    setup();
    let els = vec![rect("c", -50., -50., 250., 250.), frame0()];
    let map = array_to_map(&els);
    assert!(lattice_board_core::board::bounds::element_overlaps_with_frame(&els[0], &els[1], &map));
}

#[test]
fn new_frame_matching_group_edge_to_edge_adds_it() {
    setup();
    let rects: Vec<Element> = [(100. - 1e-8, 100.), (200., 100. + 1e-8)]
        .iter()
        .enumerate()
        .map(|(i, &(x, w))| {
            let mut r = rect(&format!("r{i}"), x, 100., w, 100.);
            r.stroke_width = 4.;
            r.group_ids = vec!["group".into()];
            r
        })
        .collect();
    let mut s = Scene::new(rects);
    s.insert_element(new_frame_element(ElementOpts::at(100., 100.), None));
    let fid = s
        .non_deleted_elements()
        .find(|e| e.is_frame())
        .unwrap()
        .id
        .clone();
    drag_new_element(
        &mut s,
        &fid,
        &DragNewOpts::new(ToolType::Frame, [100., 100.], [300., 200.], 1.),
        &TestMeasure,
    );
    let f = s.get_element(&fid).unwrap().clone();
    assert_eq!((f.x, f.y, f.width), (100., 100., 200.));
    let mut all = s.into_elements();
    let map = array_to_map(&all);
    let inside: Vec<String> = get_elements_in_new_frame(&all, &f, &map)
        .into_iter()
        .map(|e| e.id.clone())
        .collect();
    add_elements_to_frame(&mut all, &inside, &fid);
    assert_eq!(
        [
            get(&all, "r0").frame_id.as_deref(),
            get(&all, "r1").frame_id.as_deref()
        ],
        [Some(fid.as_str()); 2]
    );
}

/// The app's pointer up after resizing `frame` to `w` × `h`.
fn resize_frame(all: &mut Vec<Element>, f: &str, w: f64, h: f64) {
    let i = all.iter().position(|e| e.id == f).unwrap();
    (all[i].width, all[i].height) = (w, h);
    let fe = all[i].clone();
    let map = array_to_map(all);
    let next: Vec<String> =
        get_elements_in_resizing_frame(all, &fe, &GroupSelection::default(), &map)
            .into_iter()
            .map(|e| e.id.clone())
            .collect();
    replace_all_elements_in_frame(all, &next, f);
}

#[test]
fn resized_frame_matching_group_edge_to_edge_adds_it() {
    setup();
    let mut all = vec![frame0()];
    for (i, &(x, w)) in [(160., 40.), (200., 50. + 1e-8)].iter().enumerate() {
        let mut r = rect(&format!("r{i}"), x, 0., w, 100.);
        r.group_ids = vec!["group".into()];
        all.push(r);
    }
    resize_frame(&mut all, "id0", 250., 100.);
    assert_eq!(
        [
            get(&all, "r0").frame_id.as_deref(),
            get(&all, "r1").frame_id.as_deref()
        ],
        [Some("id0"); 2]
    );
}

#[test]
fn clips_frame_child_even_inside_it() {
    setup();
    let els = vec![
        in_frame(rect("child", 1e-7, 1e-7, 150. - 2e-7, 100. - 2e-7), "id0"),
        frame0(),
    ];
    let map = array_to_map(&els);
    let a = AppState::default();
    assert!(should_apply_frame_clip(
        &els[0],
        &els[1],
        &FrameState::new(&a, false),
        &els,
        &map,
        None
    ));
}

#[test]
fn does_not_clip_child_dragged_out_of_its_frame() {
    setup();
    let els = vec![in_frame(rect("child", 300., 0., 50., 50.), "id0"), frame0()];
    let map = array_to_map(&els);
    let a = AppState {
        selected_element_ids: BTreeSet::from(["child".to_string()]),
        ..Default::default()
    };
    assert!(!should_apply_frame_clip(
        &els[0],
        &els[1],
        &FrameState::new(&a, true),
        &els,
        &map,
        None
    ));
}

/// A rectangle drawn from (20, 20) to (40, 40) into the frame.
fn create_into_frame(mut all: Vec<Element>) -> Vec<Element> {
    all.push(rect("created", 20., 20., 20., 20.));
    add_elements_to_frame(&mut all, &sel(&["created"]), "id0");
    all
}

#[test]
fn new_frame_child_goes_just_below_its_frame() {
    setup();
    let all = Scene::new(vec![
        in_frame(rect("under", 10., 10., 80., 80.), "id0"),
        in_frame(rect("other", 100., 20., 20., 20.), "id0"),
        frame0(),
    ])
    .into_elements();
    let all = create_into_frame(all);
    assert_eq!(get(&all, "created").frame_id.as_deref(), Some("id0"));
    assert_eq!(ids(&all), ["under", "other", "created", "id0"]);
}

#[test]
fn new_frame_child_goes_below_frame_despite_deleted_children_above() {
    setup();
    let mut deleted = in_frame(rect("deleted", 100., 60., 20., 20.), "id0");
    deleted.is_deleted = true;
    let all = Scene::new(vec![
        in_frame(rect("child", 100., 20., 20., 20.), "id0"),
        frame0(),
        deleted,
    ])
    .into_elements();
    let all = create_into_frame(all);
    assert_eq!(ids(&all), ["child", "created", "id0", "deleted"]);
}

#[test]
fn new_frame_child_goes_above_highest_frame_child() {
    setup();
    let all = Scene::new(vec![
        frame0(),
        in_frame(rect("under", 10., 10., 80., 80.), "id0"),
        in_frame(rect("other", 100., 20., 20., 20.), "id0"),
    ])
    .into_elements();
    let all = create_into_frame(all);
    assert_eq!(ids(&all), ["id0", "under", "other", "created"]);
    let idx = |id: &str| get(&all, id).index.clone().unwrap();
    assert!(idx("created") > idx("other"));
}

#[test]
fn resizing_adds_arrow_bound_with_text_when_frame_is_above() {
    setup();
    let mut a = arrow("id6", 100., 0., vec![[0., 0.], [100., 100.]]);
    a.bound_elements = Some(vec![BoundElement {
        id: "id5".into(),
        kind: BoundType::Text,
    }]);
    let mut all =
        Scene::new(vec![a, text("id5", 100., 0., 100., 100., None), frame0()]).into_elements();
    // to the arrow's bottom right + 50
    resize_frame(&mut all, "id0", 250., 150.);
    assert_eq!(get(&all, "id6").frame_id.as_deref(), Some("id0"));
    assert_eq!(get(&all, "id5").frame_id.as_deref(), Some("id0"));
    assert_eq!(ids(&all), ["id6", "id5", "id0"]);
}

// dragging elements into the frame

#[test]
fn adds_dragged_element_fully_containing_frame() {
    setup();
    let all = drag_element_into_frame(vec![frame0(), rect("c", 220., 20., 300., 300.)], "id0", "c");
    assert_eq!(get(&all, "c").frame_id.as_deref(), Some("id0"));
}

#[test]
fn drags_element_into_frame() {
    setup();
    let all = drag_element_into_frame(vec![rect2(), frame0()], "id0", "id2");
    assert_eq!(get(&all, "id2").frame_id.as_deref(), Some("id0"));
}

#[test]
fn moves_element_dragged_from_one_frame_into_another() {
    setup();
    let els = vec![
        frame0(),
        in_frame(rect("frameChild", 50., 50., 20., 20.), "id0"),
        frame("otherFrame", 300., 0., 150., 150.),
    ];
    let all = drag_element_into_frame(els, "otherFrame", "frameChild");
    assert_eq!(
        get(&all, "frameChild").frame_id.as_deref(),
        Some("otherFrame")
    );
}

#[test]
fn layers_dragged_element_above_highest_frame_child() {
    setup();
    let els = vec![
        frame0(),
        in_frame(rect("frameChild", 10., 10., 20., 20.), "id0"),
        rect2(),
    ];
    let all = drag_element_into_frame(els, "id0", "id2");
    assert_eq!(get(&all, "id2").frame_id.as_deref(), Some("id0"));
    assert_eq!(ids(&all), ["id0", "frameChild", "id2"]);
    let idx = |id: &str| get(&all, id).index.clone().unwrap();
    assert!(idx("id2") > idx("frameChild") && idx("id2") > idx("id0"));
}

#[test]
fn puts_dragged_mixed_selection_above_highest_frame_child() {
    setup();
    let mut child = in_frame(rect("frameChild", 50., 10., 20., 20.), "id0");
    child.bound_elements = Some(vec![BoundElement {
        id: "boundText".into(),
        kind: BoundType::Text,
    }]);
    let els = vec![
        frame0(),
        child,
        in_frame(
            text("boundText", 50., 10., 20., 20., Some("frameChild")),
            "id0",
        ),
        in_frame(rect("otherFrameChild", 80., 10., 20., 20.), "id0"),
        rect("nonFrameElement", 155., 10., 20., 20.),
    ];
    // from the non-frame element's centre to (frame right - 5, its y + 10)
    let all = drag_and_drop(
        els,
        &["frameChild", "nonFrameElement"],
        [145. - 165., 20. - 20.],
        Some("id0"),
    );
    for id in ["frameChild", "boundText", "nonFrameElement"] {
        assert_eq!(get(&all, id).frame_id.as_deref(), Some("id0"), "{id}");
    }
    assert_eq!(
        ids(&all),
        [
            "id0",
            "otherFrameChild",
            "frameChild",
            "boundText",
            "nonFrameElement"
        ]
    );
}

#[test]
fn does_not_reorder_dragged_elements_already_in_frame() {
    setup();
    let els = vec![
        frame0(),
        in_frame(rect("frameChild", 50., 10., 20., 20.), "id0"),
        in_frame(rect("otherFrameChild", 80., 10., 20., 20.), "id0"),
    ];
    let all = drag_and_drop(els, &["frameChild"], [5., 0.], Some("id0"));
    assert_eq!(get(&all, "frameChild").frame_id.as_deref(), Some("id0"));
    assert_eq!(ids(&all), ["id0", "frameChild", "otherFrameChild"]);
}

#[test]
fn random_order_01() {
    setup();
    let els = vec![
        frame("f1", 0., 0., 100., 100.),
        in_frame(rect("r4", 350., 25., 50., 50.), "f3"),
        in_frame(rect("r1", 25., 25., 50., 50.), "f1"),
        in_frame(rect("r3", 325., 25., 50., 50.), "f3"),
        frame("f3", 300., 0., 100., 100.),
        in_frame(rect("r2", 225., 25., 50., 50.), "f2"),
        frame("f2", 200., 0., 100., 100.),
    ];
    let all = drag_element_into_frame(els, "f3", "r2");
    assert_eq!(all.len(), 7);
}

#[test]
fn random_order_02() {
    setup();
    let els = vec![
        in_frame(rect("r1", 25., 25., 50., 50.), "f1"),
        in_frame(rect("r2", 225., 25., 50., 50.), "f2"),
        frame("f1", 0., 0., 100., 100.),
        frame("f2", 200., 0., 100., 100.),
    ];
    let all = drag_element_into_frame(els, "f2", "r1");
    assert_eq!(all.len(), 4);
}

// ---------------------------------------------------------------------------
// frame.test.tsx: arrows in frames
// ---------------------------------------------------------------------------

fn frames_scene() -> Vec<Element> {
    vec![
        in_frame(rect("rectA", 50., 100., 100., 100.), "frameA"),
        frame("frameA", 0., 0., 300., 300.),
        in_frame(rect("rectB", 600., 100., 100., 100.), "frameB"),
        frame("frameB", 500., 0., 300., 300.),
    ]
}

fn inside(id: &str) -> Option<FixedPointBinding> {
    Some(FixedPointBinding {
        element_id: id.into(),
        fixed_point: [0.5, 0.5],
        mode: BindMode::Inside,
    })
}

/// An arrow in frame A from `start` to rectB's centre, bound to rectB (and
/// to `start_bound` at its start), with `mid` points relative to `start`.
fn arrow_between_frames(
    mut els: Vec<Element>,
    start: [f64; 2],
    start_bound: Option<&str>,
    mid: &[[f64; 2]],
) -> Vec<Element> {
    // the bound ends where their fixed points (0.5 is normalized to 0.5001) put them
    let start = if start_bound.is_some() {
        [start[0] + 0.01, start[1] + 0.01]
    } else {
        start
    };
    let end = [650.01 - start[0], 150.01 - start[1]];
    let mut points = vec![[0., 0.]];
    points.extend_from_slice(mid);
    points.push(end);
    let mut a = in_frame(arrow("arrow", start[0], start[1], points), "frameA");
    {
        let l = a.linear_mut().unwrap();
        l.start_binding = start_bound.and_then(inside);
        l.end_binding = inside("rectB");
    }
    for e in els.iter_mut() {
        if Some(e.id.as_str()) == start_bound || e.id == "rectB" {
            e.bound_elements
                .get_or_insert_with(Vec::new)
                .push(BoundElement {
                    id: "arrow".into(),
                    kind: BoundType::Arrow,
                });
        }
    }
    els.push(a);
    Scene::new(els).into_elements()
}

fn points_of(s: &Scene) -> Vec<[f64; 2]> {
    let a = s.get_element("arrow").unwrap();
    (0..a.points().unwrap().len())
        .map(|i| get_point_at_index_global_coordinates(a, i as isize, s))
        .collect()
}

fn labeled_arrow_out_of_frame() -> Vec<Element> {
    let mut a = in_frame(
        arrow("arrow", 100., 150., vec![[0., 0.], [550., 0.]]),
        "frameA",
    );
    a.bound_elements = Some(vec![BoundElement {
        id: "label".into(),
        kind: BoundType::Text,
    }]);
    let label = in_frame(text("label", 400., 140., 50., 20., Some("arrow")), "frameA");
    let f = frames_scene();
    vec![
        f[0].clone(),
        a,
        label,
        f[1].clone(),
        f[2].clone(),
        f[3].clone(),
    ]
}

#[test]
fn does_not_clip_arrow_to_its_frame() {
    setup();
    let els = labeled_arrow_out_of_frame();
    let map = array_to_map(&els);
    let a = AppState::default();
    assert!(!should_apply_frame_clip(
        get(&els, "arrow"),
        get(&els, "frameA"),
        &FrameState::new(&a, false),
        &els,
        &map,
        None
    ));
    assert!(!should_apply_frame_clip(
        get(&els, "label"),
        get(&els, "frameA"),
        &FrameState::new(&a, false),
        &els,
        &map,
        None
    ));
}

#[test]
fn exports_arrow_reaching_into_frame_from_another() {
    setup();
    let els = labeled_arrow_out_of_frame();
    let map = array_to_map(&els);
    let got: Vec<&str> = get_elements_overlapping_frame(&els, get(&els, "frameB"), &map)
        .iter()
        .map(|e| e.id.as_str())
        .collect();
    assert_eq!(got, ["arrow", "label", "rectB", "frameB"]);
}

#[test]
fn keeps_arrow_bound_to_element_in_another_frame_when_dragging_its_frame() {
    setup();
    let mut s = Scene::new(arrow_between_frames(
        frames_scene(),
        [100., 150.],
        Some("rectA"),
        &[],
    ));
    let (y, end) = (s.get_element("arrow").unwrap().y, points_of(&s)[1]);
    drag(&mut s, &["frameA"], [0., 100.]);
    assert_eq!(s.get_element("frameA").unwrap().y, 100.);
    let a = s.get_element("arrow").unwrap();
    assert_eq!(
        a.linear()
            .unwrap()
            .start_binding
            .as_ref()
            .unwrap()
            .element_id,
        "rectA"
    );
    assert_eq!(
        a.linear().unwrap().end_binding.as_ref().unwrap().element_id,
        "rectB"
    );
    assert_eq!(a.y, y + 100.);
    assert_eq!(points_of(&s)[1], end);
}

#[test]
fn takes_arrow_out_of_frame_when_what_its_bound_to_leaves() {
    setup();
    let els = arrow_between_frames(frames_scene(), [100., 150.], Some("rectA"), &[]);
    let all = drag_and_drop(els, &["rectA"], [-300., 0.], None);
    assert_eq!(get(&all, "rectA").frame_id, None);
    assert_eq!(
        get(&all, "arrow")
            .linear()
            .unwrap()
            .start_binding
            .as_ref()
            .unwrap()
            .element_id,
        "rectA"
    );
    assert_eq!(get(&all, "arrow").frame_id, None);
}

#[test]
fn takes_arrow_out_of_frame_when_nudging_its_ends_out() {
    setup();
    let mut all = frames_scene();
    all.push(in_frame(
        arrow("arrow", 291., 50., vec![[0., 0.], [5., 0.]]),
        "frameA",
    ));
    // shift+arrow right: by 5, then the nudge's frame check
    for expected in [Some("frameA"), None] {
        let i = all.iter().position(|e| e.id == "arrow").unwrap();
        lattice_board_core::board::mutate::mutate_element(&mut all[i], |e| e.x += 5.);
        remove_arrows_without_end_in_frame(&sel(&["arrow"]), &mut all);
        assert_eq!(get(&all, "arrow").frame_id.as_deref(), expected);
    }
}

#[test]
fn moves_midpoints_of_arrow_bound_at_both_ends_elsewhere_with_its_frame() {
    setup();
    // a loop on rectB, bending in frame A
    let mut els = arrow_between_frames(frames_scene(), [250., 250.], None, &[[100., 100.]]);
    let i = els.iter().position(|e| e.id == "arrow").unwrap();
    lattice_board_core::board::mutate::mutate_element(&mut els[i], |e| {
        let l = e.linear_mut().unwrap();
        l.points = vec![[400.01, -99.99], [100., 100.], [400.01, -99.99]];
        l.start_binding = l.end_binding.clone();
    });
    let mut s = Scene::new(els);
    let before = points_of(&s);
    drag(&mut s, &["frameA"], [0., 100.]);
    let a = s.get_element("arrow").unwrap();
    assert_eq!(
        a.linear()
            .unwrap()
            .start_binding
            .as_ref()
            .unwrap()
            .element_id,
        "rectB"
    );
    assert_eq!(
        a.linear().unwrap().end_binding.as_ref().unwrap().element_id,
        "rectB"
    );
    let after = points_of(&s);
    for (k, dy) in [(0, 0.), (1, 100.), (2, 0.)] {
        close(after[k][0], before[k][0], 6);
        close(after[k][1], before[k][1] + dy, 6);
    }
}

#[test]
fn moves_arrow_bound_to_element_in_another_frame_when_nudging_its_frame() {
    setup();
    let mut s = Scene::new(arrow_between_frames(
        frames_scene(),
        [100., 250.],
        None,
        &[[100., 0.]],
    ));
    let before = points_of(&s);
    // arrow right: by ELEMENT_TRANSLATE_AMOUNT
    drag(&mut s, &["frameA"], [1., 0.]);
    assert_eq!(s.get_element("frameA").unwrap().x, 1.);
    let after = points_of(&s);
    assert_eq!(
        after,
        [
            [before[0][0] + 1., before[0][1]],
            [before[1][0] + 1., before[1][1]],
            before[2]
        ]
    );
}

// ---------------------------------------------------------------------------
// move.test.tsx
// ---------------------------------------------------------------------------

#[test]
fn move_rectangle() {
    setup();
    let mut s = Scene::new(vec![]);
    s.insert_element(new_element(
        ElementType::Rectangle,
        opts("r", 30., 20., 0., 0.),
    ));
    drag_new_element(
        &mut s,
        "r",
        &DragNewOpts::new(ToolType::Rectangle, [30., 20.], [60., 70.], 1.),
        &TestMeasure,
    );
    let r = s.get_element("r").unwrap();
    assert_eq!((r.x, r.y, r.width, r.height), (30., 20., 30., 50.));
    // pointer from (50, 20) to (20, 40)
    drag(&mut s, &["r"], [-30., 20.]);
    let r = s.get_element("r").unwrap();
    assert_eq!((r.x, r.y), (0., 40.));
}

#[test]
fn shift_drag_moves_along_one_axis() {
    setup();
    let mut s = Scene::new(vec![rect("r", 0., 0., 100., 100.)]);
    // (50, 50) → (90, 60) with shift: the tool locks to the longer axis
    drag(&mut s, &["r"], [40., 0.]);
    let r = s.get_element("r").unwrap();
    assert_eq!((r.x, r.y), (40., 0.));
}

#[test]
fn move_rectangles_with_binding_arrow() {
    setup();
    let mut s = Scene::new(vec![
        rect("A", 0., 0., 100., 100.),
        rect("B", 200., 0., 300., 300.),
        arrow(
            "arrow",
            106.00000000000001,
            55.6867741935484,
            vec![[0., 0.], [88., 88.]],
        ),
    ]);
    // where the arrow tool left it, its start snapped next to A
    bind_binding_element(
        "arrow",
        "A",
        BindMode::Orbit,
        StartOrEnd::Start,
        &mut s,
        1.,
        None,
        true,
        true,
    );
    bind_binding_element(
        "arrow",
        "B",
        BindMode::Orbit,
        StartOrEnd::End,
        &mut s,
        1.,
        None,
        true,
        true,
    );
    // arrow keys: right, down, down
    drag(&mut s, &["B"], [1., 2.]);
    let b = s.get_element("B").unwrap();
    assert_eq!((b.x, b.y), (201., 2.));
    let a = s.get_element("arrow").unwrap();
    close(a.x, 106., 0);
    close(a.y, 55.6867741935484, 0);
    close(a.width, 89., 0);
    close(a.height, 90., 0);
}

// ---------------------------------------------------------------------------
// drag_new_element
// ---------------------------------------------------------------------------

#[test]
fn drag_new_element_shift_and_alt() {
    setup();
    let mut s = Scene::new(vec![new_element(
        ElementType::Rectangle,
        opts("r", 0., 0., 0., 0.),
    )]);
    let mut o = DragNewOpts::new(ToolType::Rectangle, [100., 100.], [60., 130.], 1.);
    o.maintain_aspect_ratio = true;
    drag_new_element(&mut s, "r", &o, &TestMeasure);
    let r = s.get_element("r").unwrap();
    assert_eq!((r.x, r.y, r.width, r.height), (60., 100., 40., 40.));
    o.resize_from_center = true;
    drag_new_element(&mut s, "r", &o, &TestMeasure);
    let r = s.get_element("r").unwrap();
    assert_eq!((r.x, r.y, r.width, r.height), (60., 60., 80., 80.));
}

// ---------------------------------------------------------------------------
// actionFrame
// ---------------------------------------------------------------------------

#[test]
fn wrap_selection_in_frame_and_unwrap() {
    setup();
    let els = Scene::new(vec![
        rect("a", 0., 0., 100., 100.),
        rect("b", 200., 0., 50., 50.),
    ])
    .into_elements();
    let st = AppState {
        selected_element_ids: BTreeSet::from(["a".to_string(), "b".to_string()]),
        ..Default::default()
    };
    let r = action_wrap_selection_in_frame(&els, &st);
    let els = r.elements.unwrap();
    let f = els.iter().find(|e| e.is_frame()).unwrap();
    assert_eq!((f.x, f.y, f.width, f.height), (-16., -16., 282., 132.));
    assert_eq!(ids(&els), ["a", "b", f.id.as_str()]);
    assert!(
        els.iter()
            .filter(|e| !e.is_frame())
            .all(|e| e.frame_id.as_deref() == Some(f.id.as_str()))
    );
    let st = r.app_state.unwrap();
    assert_eq!(st.selected_element_ids, BTreeSet::from([f.id.clone()]));
    let fid = f.id.clone();
    // selecting all its children unwraps it
    let r = action_select_all_elements_in_frame(&els, &st);
    let st = r.app_state.unwrap();
    assert_eq!(
        st.selected_element_ids,
        BTreeSet::from(["a".to_string(), "b".to_string()])
    );
    let r = action_wrap_selection_in_frame(&els, &st);
    let els = r.elements.unwrap();
    assert!(get(&els, &fid).is_deleted);
    assert!(els.iter().all(|e| e.frame_id.is_none()));
    assert_eq!(
        r.app_state.unwrap().selected_element_ids,
        BTreeSet::from(["a".to_string(), "b".to_string()])
    );
}
