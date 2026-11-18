// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Resizing, rotating, flipping: element/tests/resize.test.tsx,
//! excalidraw/tests/rotate.test.tsx, excalidraw/tests/flip.test.tsx.
//! `UI.resize` / `UI.rotate` are re-expressed as one `transform_elements`
//! call: the pointer goes down on the handle's center and moves by `move`,
//! less the resize offset (`get_resize_offset_xy`), as `maybeHandleResize`
//! does; grid and object snapping are off, as in those tests. `UI.createElement`
//! builds the element it would draw; `UI.editText` binds a label as the
//! editor's submit does (`redraw_text_bounding_box`). Text measures with
//! upstream's mock (`TestMeasure`). element/tests/sizeHelpers.test.ts is all
//! in board_geometry.rs already.
//!
//! Skipped, with reasons:
//! - resize "with bound arrow" cases (generic, text, image, multiple): commented
//!   out upstream; text "flips while resizing" and "resizes from center":
//!   `it.skip` upstream.
//! - resize "updates font size via keyboard": the font-size action and its
//!   shortcut (actions.rs).
//! - resize arrow "resizes with a label": the label staying at the path's
//!   arc-length midpoint is computed (`get_bound_text_element_position`),
//!   not stored, so only the sizes, font size and `labelPosition` are checked;
//!   the dense path sampling is upstream's check of that computation.
//! - the elbow-arrow fixed-point cases build the bound elbow arrow directly
//!   (fixed point [1.06, 0.75]) instead of drawing it with the elbow tool.
//! - flip "line/arrow outside min/max points bounds": `it.skip` upstream;
//!   the image cases paste a PNG: here an image element of the fixture's size.

use super::common::*;
use lattice_board_core::board::actions::*;
use lattice_board_core::board::app_state::AppState;
use lattice_board_core::board::binding::*;
use lattice_board_core::board::bounds::*;
use lattice_board_core::board::elbow::update_elbow_arrow_points;
use lattice_board_core::board::handles::*;
use lattice_board_core::board::math::*;
use lattice_board_core::board::new_element::*;
use lattice_board_core::board::resize::*;
use lattice_board_core::board::scene::Scene;
use lattice_board_core::board::text::*;
use lattice_board_core::board::text_measure::*;
use lattice_board_core::board::types::*;
use lattice_board_core::board::utils::{ElementsMap, get_size_from_points};
use std::f64::consts::PI;

const M: &TestMeasure = &TestMeasure;

/// Routes elbow arrows (the app's hooks do the same).
struct Elbow;
impl BindingHooks for Elbow {
    fn update_elbow_arrow_points(
        &self,
        arrow: &Element,
        map: &dyn ElementsMap,
        updates: &ElbowUpdate,
        opts: &ElbowOptions,
    ) -> ElbowUpdate {
        update_elbow_arrow_points(arrow, map, updates, opts)
    }
}

fn get<'a>(s: &'a Scene, id: &str) -> &'a Element {
    s.get_element(id).unwrap()
}
fn font_size(s: &Scene, id: &str) -> f64 {
    get(s, id).text().unwrap().font_size
}
fn xywh(s: &Scene, id: &str) -> [f64; 4] {
    let e = get(s, id);
    [e.x, e.y, e.width, e.height]
}
fn check(s: &Scene, id: &str, e: [f64; 4]) {
    let a = xywh(s, id);
    for i in 0..4 {
        close(a[i], e[i], 2);
    }
    close(get(s, id).angle, 0., 2);
}

/// `UI.createElement` of a shape (test env: sharp corners).
fn ui_shape(s: &mut Scene, ty: ElementType, id: &str, x: f64, y: f64, w: f64, h: f64) {
    let mut e = shape(ty, id, x, y, w, h);
    e.roundness = None;
    s.insert_element(e);
}
fn ui_line(s: &mut Scene, id: &str, x: f64, y: f64, points: Vec<Point>) {
    s.insert_element(line(id, x, y, points));
}
fn ui_arrow(s: &mut Scene, id: &str, x: f64, y: f64, points: Vec<Point>) {
    let mut a = arrow(id, x, y, points);
    a.roundness = None;
    s.insert_element(a);
}
fn ui_freedraw(s: &mut Scene, id: &str, x: f64, y: f64, points: Vec<Point>) {
    let (w, h) = get_size_from_points(&points);
    s.insert_element(new_free_draw_element(
        opts(id, x, y, w, h),
        points,
        vec![],
        true,
        None,
    ));
}
fn ui_image(s: &mut Scene, id: &str, x: f64, y: f64, w: f64, h: f64) {
    s.insert_element(new_image_element(
        opts(id, x, y, w, h),
        None,
        None,
        None,
        None,
    ));
}
/// The text tool: a click at `x`, `y` and typing `text` (font `size`).
fn ui_text(s: &mut Scene, id: &str, x: f64, y: f64, text: &str, size: f64) {
    s.insert_element(new_text_element(
        TextOpts {
            text: text.into(),
            font_size: Some(size),
            ..Default::default()
        },
        ElementOpts {
            id: Some(id.into()),
            ..ElementOpts::at(x, y)
        },
        M,
    ));
}
/// `UI.editText` on a container: a centered label (font `size`).
fn ui_label(s: &mut Scene, cid: &str, text: &str, size: f64) -> String {
    let c = get(s, cid).clone();
    let t = new_text_element(
        TextOpts {
            text: text.into(),
            font_size: Some(size),
            text_align: Some(TextAlign::Center),
            vertical_align: Some(VerticalAlign::Middle),
            container_id: Some(cid.into()),
            label_position: c.is_arrow().then_some(DEFAULT_BOUND_TEXT_LABEL_POSITION),
            ..Default::default()
        },
        ElementOpts {
            angle: if c.is_arrow() { 0. } else { c.angle },
            ..ElementOpts::at(c.x, c.y)
        },
        M,
    );
    let tid = t.id.clone();
    s.mutate_element(cid, true, |e| {
        e.bound_elements
            .get_or_insert_with(Vec::new)
            .push(BoundElement {
                id: tid.clone(),
                kind: BoundType::Text,
            })
    });
    let i = s.get_element_index(cid).unwrap();
    s.insert_elements_at_index(vec![t], Some(i + 1));
    let t = get(s, &tid).clone();
    redraw_text_bounding_box(s, &t, Some(cid), M);
    tid
}

#[derive(Clone, Copy, Default)]
struct Mods {
    shift: bool,
    alt: bool,
}
const NONE: Mods = Mods {
    shift: false,
    alt: false,
};
const SHIFT: Mods = Mods {
    shift: true,
    alt: false,
};
const ALT: Mods = Mods {
    shift: false,
    alt: true,
};

/// `UI.resize` / `UI.rotate`: down on the handle's center, one move by `mv`,
/// through `transform_elements` as `maybeHandleResize` calls it.
fn transform(
    s: &mut Scene,
    ids: &[&str],
    h: HandleType,
    mv: Point,
    m: Mods,
    hooks: &dyn BindingHooks,
) {
    let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
    let original: Vec<Element> = s.non_deleted_elements().cloned().collect();
    let sel: Vec<&Element> = ids.iter().map(|id| get(s, id)).collect();
    let handles = if sel.len() == 1 {
        get_transform_handles(sel[0], 1., s, PointerType::Mouse, OmitSides::default())
    } else {
        let [x1, y1, x2, y2] = get_common_bounds(sel.iter().copied(), s);
        let omit = if sel.iter().any(|e| e.is_frame_like()) {
            OMIT_SIDES_FOR_FRAME
        } else {
            OMIT_SIDES_FOR_MULTIPLE_ELEMENTS
        };
        get_transform_handles_from_coords(
            [x1, y1, x2, y2, (x1 + x2) / 2., (y1 + y2) / 2.],
            0.,
            1.,
            PointerType::Mouse,
            omit,
            4.,
            2.,
        )
    };
    let hc = handles
        .get(h)
        .unwrap_or_else(|| panic!("no {} handle", h.as_str()));
    let (cx, cy) = (hc[0] + hc[2] / 2., hc[1] + hc[3] / 2.);
    let off = get_resize_offset_xy(Some(h), &sel, s, cx, cy);
    let [x1, y1, x2, y2] = get_common_bounds(sel.iter().copied(), s);
    let center = [(x1 + x2) / 2., (y1 + y2) / 2.];
    let proportional = sel.iter().any(|e| e.is_image())
        || (sel.len() == 1
            && sel[0].is_sticky_note()
            && matches!(
                h,
                HandleType::Nw | HandleType::Ne | HandleType::Sw | HandleType::Se
            ));
    let o = TransformOpts {
        rotate_with_discrete_angle: m.shift,
        resize_from_center: m.alt,
        maintain_aspect_ratio: m.shift != proportional,
    };
    transform_elements(
        &original,
        h,
        &ids,
        s,
        o,
        [cx + mv[0] - off[0], cy + mv[1] - off[1]],
        center,
        M,
        hooks,
    );
}
fn resize(s: &mut Scene, ids: &[&str], h: &str, mv: [f64; 2], m: Mods) {
    transform(s, ids, handle(h), mv, m, &NO_BINDING_HOOKS)
}
fn rotate(s: &mut Scene, ids: &[&str], mv: [f64; 2], m: Mods) {
    transform(s, ids, HandleType::Rotation, mv, m, &NO_BINDING_HOOKS)
}
fn handle(h: &str) -> HandleType {
    HandleType::ORDER
        .into_iter()
        .find(|t| t.as_str() == h)
        .unwrap()
}

/// `getBoundsFromPoints` (resize.test.tsx).
fn points_bounds(e: &Element) -> Bounds {
    if e.is_linear() {
        return get_element_points_coords(e, e.points().unwrap());
    }
    let p = e.points().unwrap();
    let (xs, ys) = (p.iter().map(|p| p[0]), p.iter().map(|p| p[1]));
    [
        xs.clone().fold(f64::INFINITY, f64::min) + e.x,
        ys.clone().fold(f64::INFINITY, f64::min) + e.y,
        xs.fold(f64::NEG_INFINITY, f64::max) + e.x,
        ys.fold(f64::NEG_INFINITY, f64::max) + e.y,
    ]
}

// ---------------------------------------------------------------------------
// resize.test.tsx: generic element
// ---------------------------------------------------------------------------

#[test]
fn generic_resizes_with_each_handle() {
    for (h, mv, size, xy) in [
        ("n", [10., -27.], [200., 127.], [0., -27.]),
        ("e", [67., -45.], [267., 100.], [0., 0.]),
        ("s", [-50., -39.], [200., 61.], [0., 0.]),
        ("w", [20., 90.], [180., 100.], [20., 0.]),
        ("ne", [5., -33.], [205., 133.], [0., -33.]),
        ("se", [-30., -81.], [170., 19.], [0., 0.]),
        ("sw", [37., 25.], [163., 125.], [37., 0.]),
        ("nw", [-34., 42.], [234., 58.], [-34., 42.]),
    ] {
        setup();
        let mut s = Scene::default();
        ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 200., 100.);
        resize(&mut s, &["r"], h, mv, NONE);
        check(&s, "r", [xy[0], xy[1], size[0], size[1]]);
    }
}

#[test]
fn generic_flips_while_resizing() {
    for (h, mv, size, xy) in [
        ("n", [15., 139.], [200., 39.], [0., 100.]),
        ("e", [-245., 67.], [45., 100.], [-45., 0.]),
        ("s", [-26., -210.], [200., 110.], [0., -110.]),
        ("w", [241., 0.], [41., 100.], [200., 0.]),
        ("ne", [-250., 125.], [50., 25.], [-50., 100.]),
        ("se", [-283., -58.], [83., 42.], [-83., 0.]),
        ("sw", [40., -123.], [160., 23.], [40., -23.]),
        ("nw", [270., 133.], [70., 33.], [200., 100.]),
    ] {
        setup();
        let mut s = Scene::default();
        ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 200., 100.);
        resize(&mut s, &["r"], h, mv, NONE);
        check(&s, "r", [xy[0], xy[1], size[0], size[1]]);
    }
}

#[test]
fn generic_resizes_with_locked_aspect_ratio() {
    setup();
    let mut s = Scene::default();
    ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 200., 100.);
    resize(&mut s, &["r"], "se", [100., 10.], SHIFT);
    check(&s, "r", [0., 0., 300., 150.]);
    resize(&mut s, &["r"], "n", [30., 50.], SHIFT);
    check(&s, "r", [50., 50., 200., 100.]);
}

#[test]
fn generic_resizes_from_center() {
    setup();
    let mut s = Scene::default();
    ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 200., 100.);
    resize(&mut s, &["r"], "nw", [20., 10.], ALT);
    check(&s, "r", [20., 10., 160., 80.]);
    resize(&mut s, &["r"], "e", [15., 43.], ALT);
    check(&s, "r", [5., 10., 190., 80.]);
}

fn centered(s: &Scene, tid: &str, cid: &str) {
    let (t, c) = (get(s, tid), get(s, cid));
    close(t.x + t.width / 2., c.x + c.width / 2., 2);
    close(t.y + t.height / 2., c.y + c.height / 2., 2);
    close(t.angle, c.angle, 2);
}

#[test]
fn generic_resizes_with_a_label() {
    setup();
    let mut s = Scene::default();
    ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 200., 100.);
    let t = ui_label(&mut s, "r", "Hello world", 20.);
    resize(&mut s, &["r"], "se", [50., 50.], NONE);
    centered(&s, &t, "r");
    assert_eq!(font_size(&s, &t), 20.);
    resize(&mut s, &["r"], "w", [190., 0.], NONE);
    centered(&s, &t, "r");
    assert_eq!(font_size(&s, &t), 20.);
}

#[test]
fn labeled_containers_flip_horizontally_while_resizing() {
    for ty in [
        ElementType::Rectangle,
        ElementType::Ellipse,
        ElementType::Diamond,
    ] {
        for proportional in [false, true] {
            setup();
            let mut s = Scene::default();
            ui_shape(&mut s, ty, "c", 0., 0., 200., 100.);
            let t = ui_label(&mut s, "c", "Hello", 20.);
            resize(
                &mut s,
                &["c"],
                if proportional { "se" } else { "e" },
                [-500., 0.],
                if proportional { SHIFT } else { NONE },
            );
            let c = get(&s, "c");
            close(c.x, -300., 2);
            close(c.y, 0., 2);
            close(c.width, 300., 2);
            close(c.height, if proportional { 150. } else { 100. }, 2);
            let l = get(&s, &t);
            close(l.x + l.width / 2., c.x + c.width / 2., 0);
            close(l.y + l.height / 2., c.y + c.height / 2., 0);
            assert_eq!(l.angle, 0.);
            if proportional {
                assert!(font_size(&s, &t) > 20.);
            } else {
                assert_eq!(font_size(&s, &t), 20.);
            }
        }
    }
}

#[test]
fn resizes_from_center_with_multi_line_label_respecting_min_height() {
    for (h, mv) in [("n", [0., 100.]), ("s", [0., -100.])] {
        setup();
        let mut s = Scene::default();
        ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 200., 100.);
        let t = ui_label(&mut s, "r", "hello\nhello\nhello\nhello\nhello", 20.);
        let r = get(&s, "r");
        let init_cy = r.y + r.height / 2.;
        let min_h =
            compute_container_dimension_for_bound_text(get(&s, &t).height, ElementType::Rectangle);
        resize(&mut s, &["r"], h, mv, ALT);
        let r = get(&s, "r");
        close(r.y + r.height / 2., init_cy, 2);
        close(r.height, min_h, 2);
    }
}

#[test]
fn keeps_the_flipped_corner_anchored_while_wrapped_text_sets_min_height() {
    setup();
    let mut s = Scene::default();
    ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 200., 200.);
    let t = ui_label(&mut s, "r", "first second third fourth", 20.);
    let original: Vec<Element> = s.non_deleted_elements().cloned().collect();
    let orig = get(&s, "r").clone();
    let mut min_h = 0.;
    for nh in [-10., -40., -80., -200.] {
        resize_single_element(
            80.,
            nh,
            "r",
            &orig,
            &original,
            &mut s,
            HandleType::Se,
            SingleOpts::default(),
            M,
            &NO_BINDING_HOOKS,
        );
        let (r, l) = (get(&s, "r"), get(&s, &t));
        assert_eq!(r.x, orig.x);
        assert_eq!(r.y + r.height, orig.y);
        assert!(l.y > r.y);
        assert!(l.y + l.height < r.y + r.height);
        if nh == -10. {
            min_h = r.height;
            assert!(min_h > 80.);
        }
        assert_eq!(r.height, f64::max(min_h, -nh));
    }
}

// ---------------------------------------------------------------------------
// resize.test.tsx: line / freedraw
// ---------------------------------------------------------------------------

const FREEDRAW: [Point; 4] = [
    [0., 0.],
    [-2.474600807561444, 41.021700699972],
    [3.6627956000014024, 47.84174560617245],
    [40.495224145598115, 47.15909710753482],
];

#[test]
fn freedraw_resizes() {
    setup();
    let mut s = Scene::default();
    ui_freedraw(&mut s, "f", 0., 0., FREEDRAW.to_vec());
    let b = points_bounds(get(&s, "f"));
    resize(&mut s, &["f"], "ne", [30., -60.], NONE);
    let n = points_bounds(get(&s, "f"));
    for (a, e) in n.iter().zip([b[0], b[1] - 60., b[2] + 30., b[3]]) {
        close(*a, e, 2);
    }
    close(get(&s, "f").angle, 0., 2);
}

#[test]
fn freedraw_flips_while_resizing() {
    setup();
    let mut s = Scene::default();
    ui_freedraw(&mut s, "f", 0., 0., FREEDRAW.to_vec());
    let b = points_bounds(get(&s, "f"));
    resize(&mut s, &["f"], "sw", [140., -80.], NONE);
    let n = points_bounds(get(&s, "f"));
    for (a, e) in n.iter().zip([b[2], b[3] - 80., b[0] + 140., b[1]]) {
        close(*a, e, 2);
    }
}

#[test]
fn freedraw_resizes_with_locked_aspect_ratio() {
    setup();
    let mut s = Scene::default();
    ui_freedraw(&mut s, "f", 0., 0., FREEDRAW.to_vec());
    let b = points_bounds(get(&s, "f"));
    resize(&mut s, &["f"], "ne", [30., -60.], SHIFT);
    let n = points_bounds(get(&s, "f"));
    let scale = 1. + 60. / (b[3] - b[1]);
    for (a, e) in n
        .iter()
        .zip([b[0], b[1] - 60., b[0] + (b[2] - b[0]) * scale, b[3]])
    {
        close(*a, e, 2);
    }
}

#[test]
fn freedraw_resizes_from_center() {
    setup();
    let mut s = Scene::default();
    ui_freedraw(&mut s, "f", 0., 0., FREEDRAW.to_vec());
    let b = points_bounds(get(&s, "f"));
    resize(&mut s, &["f"], "nw", [-20., -30.], ALT);
    let n = points_bounds(get(&s, "f"));
    for (a, e) in n
        .iter()
        .zip([b[0] - 20., b[1] - 30., b[2] + 20., b[3] + 30.])
    {
        close(*a, e, 2);
    }
}

const LINE: [Point; 4] = [[0., 0.], [60., -20.], [20., 40.], [-40., 0.]];

#[test]
fn line_resizes() {
    setup();
    let mut s = Scene::default();
    ui_line(&mut s, "l", 0., 0., LINE.to_vec());
    let e = get(&s, "l").clone();
    let (nw, nh) = (e.width + 30., e.height + 30.);
    resize_single_element(
        nw,
        nh,
        "l",
        &e,
        &s.non_deleted_elements().cloned().collect::<Vec<_>>(),
        &mut s,
        HandleType::Ne,
        SingleOpts::default(),
        M,
        &NO_BINDING_HOOKS,
    );
    let n = get(&s, "l");
    assert!(n.x != e.x && n.y != e.y);
    assert_eq!((n.width, n.height), (nw, nh));
    assert_eq!(n.points().unwrap()[0], [0., 0.]);
    assert_eq!(
        get_size_from_points(n.points().unwrap()),
        (n.width, n.height)
    );
}

#[test]
fn line_flips_while_resizing() {
    setup();
    let mut s = Scene::default();
    ui_line(&mut s, "l", 0., 0., LINE.to_vec());
    let e = get(&s, "l").clone();
    resize_single_element(
        -e.width,
        -e.height,
        "l",
        &e,
        &s.non_deleted_elements().cloned().collect::<Vec<_>>(),
        &mut s,
        HandleType::Se,
        SingleOpts::default(),
        M,
        &NO_BINDING_HOOKS,
    );
    let n = get(&s, "l");
    assert_eq!((n.width, n.height), (e.width, e.height));
    for (p, q) in n.points().unwrap().iter().zip(e.points().unwrap()) {
        close(p[0], -q[0], 2);
        close(p[1], -q[1], 2);
    }
}

#[test]
fn line_resizes_with_locked_aspect_ratio() {
    setup();
    let mut s = Scene::default();
    ui_line(&mut s, "l", 0., 0., LINE.to_vec());
    let (pw, ph) = (get(&s, "l").width, get(&s, "l").height);
    resize(&mut s, &["l"], "ne", [30., -60.], SHIFT);
    let n = get(&s, "l");
    close(n.width / pw, n.height / ph, 2);
}

#[test]
fn line_resizes_from_center() {
    setup();
    let mut s = Scene::default();
    ui_line(
        &mut s,
        "l",
        0.,
        0.,
        vec![
            [0., 0.],
            [338.05644048727373, -180.4761618151104],
            [338.05644048727373, 180.4761618151104],
            [-338.05644048727373, 180.4761618151104],
            [-338.05644048727373, -180.4761618151104],
        ],
    );
    let e = get(&s, "l").clone();
    let xs = |e: &Element| {
        let p = e.points().unwrap();
        (
            p.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min),
            p.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max),
        )
    };
    let (pmin, pmax) = xs(&e);
    resize_single_element(
        e.width + 20.,
        e.height,
        "l",
        &e,
        &s.non_deleted_elements().cloned().collect::<Vec<_>>(),
        &mut s,
        HandleType::E,
        SingleOpts {
            resize_from_center: true,
            ..Default::default()
        },
        M,
        &NO_BINDING_HOOKS,
    );
    let n = get(&s, "l");
    close(n.width, e.width + 20., 2);
    close(n.height, e.height, 2);
    close(n.x, e.x, 2);
    close(n.y, e.y, 2);
    let (min, max) = xs(n);
    close(pmin - min, 10., 2);
    close(max - pmax, 10., 2);
}

// ---------------------------------------------------------------------------
// resize.test.tsx: arrow element
// ---------------------------------------------------------------------------

#[test]
fn arrow_resizes_with_a_label() {
    setup();
    let mut s = Scene::default();
    ui_arrow(
        &mut s,
        "a",
        0.,
        0.,
        vec![[0., 0.], [40., 140.], [80., 60.], [180., 20.], [200., 120.]],
    );
    let t = ui_label(&mut s, "a", "Hello", 20.);
    let label_ok = |s: &Scene| {
        assert_eq!(get(s, &t).text().unwrap().label_position, Some(Some(0.5)));
        close(get(s, &t).angle, 0., 2);
    };
    label_ok(&s);
    resize(&mut s, &["a"], "se", [50., 30.], NONE);
    label_ok(&s);
    assert_eq!(font_size(&s, &t), 20.);
    resize(&mut s, &["a"], "w", [20., 0.], NONE);
    label_ok(&s);
    assert_eq!(font_size(&s, &t), 20.);
    let a = get(&s, "a").clone();
    let original: Vec<Element> = s.non_deleted_elements().cloned().collect();
    resize_single_element(
        -2. * a.width,
        2. * a.height,
        "a",
        &a,
        &original,
        &mut s,
        HandleType::Se,
        SingleOpts {
            maintain_aspect_ratio: true,
            ..Default::default()
        },
        M,
        &NO_BINDING_HOOKS,
    );
    close(points_bounds(get(&s, "a"))[2], a.x, 2);
    close(get(&s, "a").width, 2. * a.width, 2);
    close(font_size(&s, &t), 40., 2);
    label_ok(&s);
}

fn elbow_bound_to_rect(s: &mut Scene) {
    ui_shape(s, ElementType::Rectangle, "r", -100., -75., 95., 100.);
    let (w, h) = (125., 200.);
    let mut a = new_arrow_element(
        opts("a", -5., 0., w, h),
        vec![[0., 0.], [w, h]],
        None,
        Some(Arrowhead::Arrow),
        true,
        None,
    );
    if let Some(l) = a.linear_mut() {
        l.start_binding = Some(FixedPointBinding {
            element_id: "r".into(),
            fixed_point: [1.06, 0.75],
            mode: BindMode::Orbit,
        });
    }
    s.insert_element(a);
    s.mutate_element("r", true, |e| {
        e.bound_elements = Some(vec![BoundElement {
            id: "a".into(),
            kind: BoundType::Arrow,
        }])
    });
}
fn start_fixed(s: &Scene) -> [f64; 2] {
    get(s, "a")
        .linear()
        .unwrap()
        .start_binding
        .as_ref()
        .unwrap()
        .fixed_point
}

#[test]
fn elbow_fixed_point_survives_negative_resize_of_single_bindable() {
    setup();
    let mut s = Scene::default();
    elbow_bound_to_rect(&mut s);
    transform(&mut s, &["r"], HandleType::Se, [-200., -150.], NONE, &Elbow);
    let f = start_fixed(&s);
    close(f[0], 1.06, 2);
    close(f[1], 0.75, 2);
}

#[test]
fn elbow_fixed_point_flips_on_negative_resize_of_group_selection() {
    setup();
    let mut s = Scene::default();
    elbow_bound_to_rect(&mut s);
    transform(
        &mut s,
        &["r", "a"],
        HandleType::Nw,
        [300., 350.],
        NONE,
        &Elbow,
    );
    let f = start_fixed(&s);
    close(f[0], -0.06, 2);
    close(f[1], 0.25, 2);
}

// ---------------------------------------------------------------------------
// resize.test.tsx: text element
// ---------------------------------------------------------------------------

#[test]
fn text_resizes() {
    setup();
    let mut s = Scene::default();
    ui_text(&mut s, "t", 0., 0., "hello\nworld", 20.);
    let ([_, _, w, h], f) = (xywh(&s, "t"), font_size(&s, "t"));
    let scale = 40. / h + 1.;
    resize(&mut s, &["t"], "se", [30., 40.], NONE);
    check(&s, "t", [0., 0., w * scale, h * scale]);
    close(font_size(&s, "t"), f * scale, 2);
}

#[test]
fn text_resizes_by_corner_following_the_axis_it_grows_most() {
    setup();
    let mut s = Scene::default();
    ui_text(&mut s, "t", 0., 0., "hello\nworld", 20.);
    let ([_, _, w, h], f) = (xywh(&s, "t"), font_size(&s, "t"));
    let scale = 60. / w + 1.;
    resize(&mut s, &["t"], "se", [60., 5.], NONE);
    let [_, _, nw, nh] = xywh(&s, "t");
    close(nw, w * scale, 2);
    close(nh, h * scale, 2);
    close(font_size(&s, "t"), f * scale, 2);
}

#[test]
fn text_can_be_resized_from_e_and_w() {
    setup();
    let mut s = Scene::default();
    ui_text(&mut s, "t", 0., 0., "Excalidraw\nEditor", 20.);
    let [_, _, w, h] = xywh(&s, "t");
    resize(&mut s, &["t"], "e", [30., 0.], NONE);
    assert_eq!((get(&s, "t").width, get(&s, "t").height), (w + 30., h));
    resize(&mut s, &["t"], "e", [-30., 0.], NONE);
    assert_eq!((get(&s, "t").width, get(&s, "t").height), (w, h));
    resize(&mut s, &["t"], "w", [-50., 0.], NONE);
    assert_eq!((get(&s, "t").width, get(&s, "t").height), (w + 50., h));
    resize(&mut s, &["t"], "w", [50., 0.], NONE);
    assert_eq!((get(&s, "t").width, get(&s, "t").height), (w, h));
}

#[test]
fn text_wraps_when_narrower_than_its_text() {
    setup();
    let mut s = Scene::default();
    ui_text(&mut s, "t", 0., 0., "Excalidraw\nEditor", 20.);
    let (pw, ph, pt) = (
        get(&s, "t").width,
        get(&s, "t").height,
        get(&s, "t").text().unwrap().text.clone(),
    );
    let state = |s: &Scene| {
        let e = get(s, "t");
        let d = e.text().unwrap();
        (e.width, e.height, d.text.clone(), d.auto_resize)
    };
    resize(&mut s, &["t"], "w", [50., 0.], NONE);
    let (w, h, t, ar) = state(&s);
    assert!(w == pw - 50. && h > ph && t != pt && !ar);
    resize(&mut s, &["t"], "w", [-50., 0.], NONE);
    assert_eq!(state(&s), (pw, ph, pt.clone(), false));
    resize(&mut s, &["t"], "e", [-20., 0.], NONE);
    let (w, h, t, ar) = state(&s);
    assert!(w == pw - 20. && h > ph && t != pt && !ar);
    resize(&mut s, &["t"], "e", [20., 0.], NONE);
    assert_eq!(state(&s), (pw, ph, pt, false));
}

#[test]
fn text_keeps_properties_when_wrapped() {
    setup();
    let mut s = Scene::default();
    ui_text(&mut s, "t", 0., 0., "Excalidraw\nEditor", 20.);
    let d0 = get(&s, "t").text().unwrap().clone();
    for dx in [-60., 60.] {
        resize(&mut s, &["t"], "e", [dx, 0.], NONE);
        let d = get(&s, "t").text().unwrap();
        assert_eq!(
            (d.text_align, d.font_size, d.font_family, d.auto_resize),
            (d0.text_align, d0.font_size, d0.font_family, false)
        );
    }
}

#[test]
fn text_has_a_minimum_width_when_wrapped() {
    setup();
    let mut s = Scene::default();
    ui_text(&mut s, "t", 0., 0., "Excalidraw\nEditor", 20.);
    let w = get(&s, "t").width;
    resize(&mut s, &["t"], "e", [-w, 0.], NONE);
    assert_ne!(get(&s, "t").width, 0.);
    let cw = get(&s, "t").width;
    resize(&mut s, &["t"], "e", [w - cw, 0.], NONE);
    assert_eq!(get(&s, "t").width, w);
    resize(&mut s, &["t"], "w", [w, 0.], NONE);
    assert_ne!(get(&s, "t").width, 0.);
    let cw = get(&s, "t").width;
    resize(&mut s, &["t"], "w", [cw - w, 0.], NONE);
    assert_eq!(get(&s, "t").width, w);
    assert!(!get(&s, "t").text().unwrap().auto_resize);
}

// ---------------------------------------------------------------------------
// resize.test.tsx: image element
// ---------------------------------------------------------------------------

fn scale(s: &Scene, id: &str) -> [f64; 2] {
    get(s, id).image().unwrap().scale
}

#[test]
fn image_resizes() {
    setup();
    let mut s = Scene::default();
    ui_image(&mut s, "i", 0., 0., 100., 100.);
    resize(&mut s, &["i"], "ne", [-20., -30.], NONE);
    check(&s, "i", [0., -30., 130., 130.]);
    assert_eq!(scale(&s, "i"), [1., 1.]);
}

#[test]
fn image_flips_while_resizing() {
    setup();
    let mut s = Scene::default();
    ui_image(&mut s, "i", 0., 0., 100., 100.);
    resize(&mut s, &["i"], "sw", [150., -150.], NONE);
    check(&s, "i", [100., -50., 50., 50.]);
    assert_eq!(scale(&s, "i"), [-1., -1.]);
}

#[test]
fn image_resizes_with_locked_and_unlocked_aspect_ratio() {
    setup();
    let mut s = Scene::default();
    ui_image(&mut s, "i", 0., 0., 100., 100.);
    resize(&mut s, &["i"], "ne", [30., -20.], NONE);
    check(&s, "i", [0., -30., 130., 130.]);
    resize(&mut s, &["i"], "ne", [-30., 50.], SHIFT);
    check(&s, "i", [0., 20., 100., 80.]);
}

#[test]
fn image_resizes_from_center() {
    setup();
    let mut s = Scene::default();
    ui_image(&mut s, "i", 0., 0., 100., 100.);
    resize(&mut s, &["i"], "nw", [25., 15.], ALT);
    check(&s, "i", [15., 15., 70., 70.]);
    assert_eq!(scale(&s, "i"), [1., 1.]);
}

// ---------------------------------------------------------------------------
// resize.test.tsx: multiple selection
// ---------------------------------------------------------------------------

#[test]
fn multi_keeps_a_flipped_text_container_anchored() {
    setup();
    let mut s = Scene::default();
    ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 200., 35.);
    let t = ui_label(&mut s, "r", "hello", 20.);
    ui_shape(&mut s, ElementType::Rectangle, "o", 300., 0., 100., 100.);
    let oh = get(&s, "r").height;
    resize(&mut s, &["r", "o"], "se", [-200., -150.], SHIFT);
    close(font_size(&s, &t), 10., 2);
    assert_eq!(get(&s, &t).text().unwrap().text, "hello");
    let r = get(&s, "r");
    assert!(r.height > oh / 2.);
    close(r.y + r.height, 0., 2);
}

#[test]
fn multi_resizes_with_generic_elements() {
    setup();
    let mut s = Scene::default();
    ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 100., 80.);
    let t = ui_label(&mut s, "r", "hello\nworld", 20.);
    ui_shape(&mut s, ElementType::Diamond, "d", 140., 40., 80., 80.);
    ui_shape(&mut s, ElementType::Ellipse, "e", 40., 100., 80., 60.);
    let k = f64::max(1. + 50. / 220., 1. + 30. / 160.);
    resize(&mut s, &["r", "d", "e"], "se", [50., 30.], SHIFT);
    check(&s, "r", [0., 0., 100. * k, 80. * k]);
    assert_eq!(get(&s, &t).container_id(), Some("r"));
    centered(&s, &t, "r");
    close(font_size(&s, &t), 20. * k, -1);
    check(&s, "d", [140. * k, 40. * k, 80. * k, 80. * k]);
    check(&s, "e", [40. * k, 100. * k, 80. * k, 60. * k]);
}

#[test]
fn multi_resizes_with_linear_elements_of_more_than_two_points() {
    setup();
    let mut s = Scene::default();
    ui_line(
        &mut s,
        "l",
        60.,
        40.,
        vec![
            [0., 0.],
            [-40., 40.],
            [-60., 0.],
            [0., -40.],
            [40., 20.],
            [0., 40.],
        ],
    );
    ui_freedraw(
        &mut s,
        "f",
        63.56072661326618,
        100.,
        vec![
            [0., 0.],
            [-43.56072661326618, 18.15048126846341],
            [-43.56072661326618, 29.041198460587566],
            [-38.115368017204105, 42.652452795512204],
            [-19.964886748740696, 66.24829266003775],
            [19.056612930986716, 77.1390098521619],
        ],
    );
    let k = f64::max(1. - 25. / 100., 1. - 25. / 177.1390098521619);
    resize(&mut s, &["l", "f"], "se", [-25., -25.], SHIFT);
    check(&s, "l", [60. * k, 40. * k, 100. * k, 80. * k]);
    check(
        &s,
        "f",
        [
            63.56072661326618 * k,
            100. * k,
            62.6173395442529 * k,
            77.1390098521619 * k,
        ],
    );
}

#[test]
fn multi_resizes_with_two_point_lines() {
    setup();
    let mut s = Scene::default();
    // at roughness 0: the selection's bounds follow the rough.js curve, and
    // its jitter (seed-dependent) would move the anchor off the points
    for (id, x, y, p) in [
        ("h", 0., 0., [120., 0.]),
        ("v", 0., 20., [0., 80.]),
        ("d", 40., 40., [60., 60.]),
    ] {
        let mut l = line(id, x, y, vec![[0., 0.], p]);
        l.roughness = 0.;
        s.insert_element(l);
    }
    let (sw, sh) = (120., 100.);
    let k = f64::max(1. - 40. / sw, 1. - 40. / sh);
    resize(&mut s, &["h", "v", "d"], "nw", [40., 40.], SHIFT);
    check(&s, "h", [sw * (1. - k), sh * (1. - k), 120. * k, 0.]);
    check(
        &s,
        "v",
        [sw * (1. - k), (sh - 20.) * (1. - k) + 20., 0., 80. * k],
    );
    check(
        &s,
        "d",
        [
            (sw - 40.) * (1. - k) + 40.,
            (sh - 40.) * (1. - k) + 40.,
            60. * k,
            60. * k,
        ],
    );
}

#[test]
fn multi_resizes_with_labeled_arrows() {
    setup();
    let mut s = Scene::default();
    ui_arrow(&mut s, "top", 0., 20., vec![[0., 0.], [220., 0.]]);
    let tl = ui_label(&mut s, "top", "lorem ipsum", 20.);
    ui_arrow(&mut s, "bot", 0., 80., vec![[0., 0.], [220., 0.]]);
    let bl = ui_label(&mut s, "bot", "dolor\nsit amet", 28.);
    let sel_top = 20. - get(&s, &tl).height / 2.;
    let k = 80. / 220. + 1.;
    resize(&mut s, &["top", "bot"], "se", [80., 0.], SHIFT);
    for (a, l, y, f) in [("top", &tl, 20., 20.), ("bot", &bl, 80., 28.)] {
        let (ae, le) = (get(&s, a), get(&s, l));
        close(ae.x, 0., 2);
        close(ae.y, sel_top + (y - sel_top) * k, 2);
        close(ae.width, 300., 2);
        assert_eq!(ae.points().unwrap(), &[[0., 0.], [300., 0.]]);
        let p = get_bound_text_element_position(ae, le, &s);
        close(p[0] + le.width / 2., ae.width / 2., 2);
        close(p[1] + le.height / 2., ae.y, 2);
        close(le.text().unwrap().font_size, f * k, 2);
    }
}

#[test]
fn multi_resizes_with_text_elements() {
    setup();
    let mut s = Scene::default();
    ui_text(&mut s, "top", 0., 0., "lorem ipsum", 20.);
    ui_text(&mut s, "bot", 40., 40., "dolor\nsit amet", 28.);
    let (sw, sh) = (40. + get(&s, "bot").width, 40. + get(&s, "bot").height);
    let k = f64::max(1. + 30. / sw, 1. + 40. / sh);
    resize(&mut s, &["top", "bot"], "ne", [30., -40.], SHIFT);
    close(get(&s, "top").x, 0., 2);
    close(get(&s, "top").y, -sh * (k - 1.), 2);
    close(font_size(&s, "top"), 20. * k, 2);
    close(get(&s, "bot").x, 40. * k, 2);
    close(get(&s, "bot").y, 40. - (sh - 40.) * (k - 1.), 2);
    close(font_size(&s, "bot"), 28. * k, 2);
}

#[test]
fn multi_resizes_with_images_proportionally() {
    setup();
    let mut s = Scene::default();
    ui_image(&mut s, "t", 0., 0., 200., 100.);
    ui_image(&mut s, "b", 30., 150., 120., 80.);
    let k = f64::max(1. - 50. / 200., 1. - 50. / 230.);
    resize(&mut s, &["t", "b"], "se", [-50., -50.], NONE);
    check(&s, "t", [0., 0., 200. * k, 100. * k]);
    check(&s, "b", [30. * k, 150. * k, 120. * k, 80. * k]);
    assert_eq!((scale(&s, "t"), scale(&s, "b")), ([1., 1.], [1., 1.]));
}

#[test]
fn multi_resizes_from_center() {
    setup();
    let mut s = Scene::default();
    ui_shape(
        &mut s,
        ElementType::Rectangle,
        "r",
        -200.,
        -140.,
        120.,
        100.,
    );
    ui_shape(&mut s, ElementType::Ellipse, "e", 60., 60., 140., 80.);
    let k = f64::max(1. - 160. / 400., 1. - 160. / 280.);
    resize(
        &mut s,
        &["r", "e"],
        "se",
        [-80., -80.],
        Mods {
            shift: true,
            alt: true,
        },
    );
    check(&s, "r", [-200. * k, -140. * k, 120. * k, 100. * k]);
    check(&s, "e", [60. * k, 60. * k, 140. * k, 80. * k]);
}

#[test]
fn multi_flips_while_resizing() {
    setup();
    let mut s = Scene::default();
    ui_image(&mut s, "i", 60., 100., 100., 100.);
    s.mutate_element("i", true, |e| e.angle = PI * 7. / 6.);
    ui_line(
        &mut s,
        "l",
        60.,
        0.,
        vec![
            [0., 0.],
            [-40., 40.],
            [-20., 60.],
            [20., 20.],
            [40., 40.],
            [-20., 100.],
            [-60., 60.],
        ],
    );
    ui_shape(&mut s, ElementType::Rectangle, "r", 180., 60., 160., 80.);
    s.mutate_element("r", true, |e| e.angle = PI / 6.);
    let rl = ui_label(&mut s, "r", "hello\nworld", 20.);
    draw_arrow(&mut s, "a", [380., 240.], [320., 160.]);
    let al = ui_label(&mut s, "a", "test", 20.);
    let sx = -800. / 380. + 1.;
    let sy = -sx;
    let lb = points_bounds(get(&s, "l"));
    resize(&mut s, &["l", "i", "r", "a"], "se", [-800., 0.], SHIFT);
    let (l, nb) = (get(&s, "l"), points_bounds(get(&s, "l")));
    close(l.x, 60. * sx, 2);
    close(l.y, 0., 2);
    close(nb[0], (lb[2] - lb[0]) * sx, 2);
    close(nb[1], 0., 2);
    close(nb[3], (lb[3] - lb[1]) * sy, 2);
    close(nb[2], 0., 2);
    assert_eq!(l.angle, 0.);
    let i = get(&s, "i");
    for (a, e) in [
        (i.x, 160. * sx),
        (i.y, 100. * sy),
        (i.width, 100. * -sx),
        (i.height, 100. * sy),
        (i.angle, PI * 5. / 6.),
    ] {
        close(a, e, 2);
    }
    assert_eq!(scale(&s, "i"), [-1., 1.]);
    let r = get(&s, "r");
    for (a, e) in [
        (r.x, 340. * sx),
        (r.y, 60. * sy),
        (r.width, 160. * -sx),
        (r.height, 80. * sy),
    ] {
        close(a, e, 2);
    }
    assert_eq!(r.angle, PI * 11. / 6.);
    centered(&s, &rl, "r");
    close(font_size(&s, &rl), 20. * sy, 2);
    let a = get(&s, "a");
    close(a.x, 380. * sx, 2);
    close(a.y, 240. * sy, 2);
    let p1 = a.points().unwrap()[1];
    close(p1[0], 63.40354208105561, 2);
    close(p1[1], -84.53805610807356, 2);
    let lp = get_bound_text_element_position(a, get(&s, &al), &s);
    let le = get(&s, &al);
    close(lp[0] + le.width / 2., a.x + p1[0] / 2., 2);
    close(lp[1] + le.height / 2., a.y + p1[1] / 2., 2);
    assert_eq!(le.angle, 0.);
    close(le.text().unwrap().font_size, 20. * sy, 2);
}

// ---------------------------------------------------------------------------
// rotate.test.tsx
// ---------------------------------------------------------------------------

/// The arrow tool's draw from `from` to `to`, binding its ends.
fn draw_arrow(s: &mut Scene, id: &str, from: Point, to: Point) {
    let ctx = BindingCtx::default();
    ui_arrow(
        s,
        id,
        from[0],
        from[1],
        vec![[0., 0.], [to[0] - from[0], to[1] - from[1]]],
    );
    let o = BindOpts {
        new_arrow: true,
        ..Default::default()
    };
    bind_or_unbind_binding_element(
        id,
        &PointsPositionUpdates::from([(0, PointUpdate::at([0., 0.]))]),
        from,
        s,
        &ctx,
        &o,
    );
    let st = LinearDragState {
        origin: Some(from),
        ..Default::default()
    };
    let p = *get(s, id).points().unwrap().last().unwrap();
    bind_or_unbind_binding_element(
        id,
        &PointsPositionUpdates::from([(1, PointUpdate::at(p))]),
        to,
        s,
        &BindingCtx {
            drag: Some(&st),
            ..ctx
        },
        &o,
    );
}
fn end_of(s: &Scene, id: &str) -> Option<String> {
    get(s, id)
        .linear()
        .unwrap()
        .end_binding
        .as_ref()
        .map(|b| b.element_id.clone())
}

#[test]
fn unselected_bound_arrow_updates_when_rotating_its_target() {
    setup();
    let mut s = Scene::default();
    ui_shape(&mut s, ElementType::Rectangle, "r", 0., 0., 200., 100.);
    draw_arrow(&mut s, "a", [-80., 50.], [5., 50.]);
    assert_eq!(end_of(&s, "a").as_deref(), Some("r"));
    rotate(&mut s, &["r"], [60., 36.], SHIFT);
    assert_eq!(end_of(&s, "a").as_deref(), Some("r"));
    let a = get(&s, "a");
    close(a.x, -80., 2);
    close(a.y, 50., 2);
    close(a.width, 132.491, 1);
    close(a.height, 82.267, 1);
}

#[test]
fn unselected_bound_arrows_update_when_rotating_their_targets() {
    setup();
    let mut s = Scene::default();
    ui_shape(&mut s, ElementType::Ellipse, "e", 0., 80., 300., 120.);
    draw_arrow(&mut s, "ea", [-10., 80.], [40., 140.]);
    ui_text(&mut s, "t", 220., 220., "test", 20.);
    draw_arrow(&mut s, "ta", [360., 300.], [220., 240.]);
    assert_eq!(end_of(&s, "ea").as_deref(), Some("e"));
    assert_eq!(end_of(&s, "ta").as_deref(), Some("t"));
    rotate(&mut s, &["e", "t"], [-82., 23.], SHIFT);
    assert_eq!(end_of(&s, "ea").as_deref(), Some("e"));
    let a = get(&s, "ea");
    assert_eq!((a.x, a.y, a.points().unwrap()[0]), (-10., 80., [0., 0.]));
    close(a.points().unwrap()[1][0], 66.317, 1);
    close(a.points().unwrap()[1][1], 144.38, 1);
    assert_eq!(end_of(&s, "ta").as_deref(), Some("t"));
    let a = get(&s, "ta");
    assert_eq!((a.x, a.y, a.points().unwrap()[0]), (360., 300., [0., 0.]));
    close(a.points().unwrap()[1][0], -95.4635969899922, 0);
    close(a.points().unwrap()[1][1], -126.8785027399889, 0);
}

// ---------------------------------------------------------------------------
// flip.test.tsx
// ---------------------------------------------------------------------------

fn selected(ids: &[&str]) -> AppState {
    AppState {
        selected_element_ids: ids.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}
fn flip(s: &mut Scene, ids: &[&str], dirs: &[FlipDirection]) {
    for d in dirs {
        let a = selected(ids);
        let els = s.elements_including_deleted().to_vec();
        let r = match d {
            FlipDirection::Horizontal => action_flip_horizontal(&els, &a, M, &NO_BINDING_HOOKS),
            FlipDirection::Vertical => action_flip_vertical(&els, &a, M, &NO_BINDING_HOOKS),
        };
        *s = Scene::new(r.elements.unwrap());
    }
}
/// `checkElementsBoundingBox`: the size stays (to -1 digits, as upstream).
fn same_size(a: &Element, b: &Element) {
    let ([x1, y1, x2, y2, ..], [u1, v1, u2, v2, ..]) = (
        get_element_absolute_coords(a, &vec![a.clone()], false),
        get_element_absolute_coords(b, &vec![b.clone()], false),
    );
    close(x2 - x1, u2 - u1, -1);
    close(y2 - y1, v2 - v1, -1);
}
fn check_flip(s: &mut Scene, dirs: &[FlipDirection], angle: Option<f64>) {
    let id = s.elements_including_deleted()[0].id.clone();
    let before = get(s, &id).clone();
    flip(s, &[&id], dirs);
    let after = get(s, &id);
    if let Some(a) = angle {
        close(after.angle, a, 2);
    }
    same_size(&before, after);
}
use FlipDirection::{Horizontal as H, Vertical as V};

fn one(ty: ElementType, angle: f64) -> Scene {
    let mut s = Scene::default();
    match ty {
        ElementType::Arrow => ui_arrow(&mut s, "x", 0., 0., vec![[0., 0.], [100., 50.]]),
        ElementType::Line => ui_line(&mut s, "x", 0., 0., vec![[0., 0.], [100., 50.]]),
        ElementType::FreeDraw => ui_freedraw(&mut s, "x", 0., 0., vec![[0., 0.], [50., 100.]]),
        _ => ui_shape(&mut s, ty, "x", 0., 0., 100., 50.),
    }
    if angle != 0. {
        s.mutate_element("x", true, |e| e.angle = angle);
    }
    s
}

#[test]
fn flips_shapes() {
    for (ty, a, e) in [
        (ElementType::Rectangle, 3. * PI / 4., 5. * PI / 4.),
        (ElementType::Diamond, 5. * PI / 4., 3. * PI / 4.),
        (ElementType::Ellipse, 7. * PI / 4., PI / 4.),
        (ElementType::FreeDraw, PI / 4., 7. * PI / 4.),
    ] {
        for dir in [H, V] {
            setup();
            check_flip(&mut one(ty, 0.), &[dir], None);
            check_flip(&mut one(ty, a), &[dir], Some(e));
        }
    }
}

#[test]
fn flips_two_point_arrows_and_lines() {
    for ty in [ElementType::Arrow, ElementType::Line] {
        for dir in [H, V] {
            setup();
            check_flip(&mut one(ty, 0.), &[dir], None);
            let mut s = one(ty, 0.);
            let before = get(&s, "x").points().unwrap().to_vec();
            flip(&mut s, &["x"], &[dir]);
            let after = get(&s, "x").points().unwrap();
            for (p, q) in before.iter().zip(after) {
                let (fx, fy) = if dir == H { (-1., 1.) } else { (1., -1.) };
                close(p[0], fx * q[0], 5);
                close(p[1], fy * q[1], 5);
            }
        }
    }
}

/// `createLinearElementWithCurveInsideMinMaxPoints`.
fn curve_inside(ty: ElementType) -> Scene {
    let o = ElementOpts {
        id: Some("x".into()),
        x: 2256.910668124894,
        y: -2412.5069664197654,
        width: 1750.4888916015625,
        height: 410.51605224609375,
        stroke_width: 1.,
        roundness: Some(Roundness {
            kind: roundness::PROPORTIONAL_RADIUS,
            value: None,
        }),
        ..Default::default()
    };
    let pts = vec![
        [0., 0.],
        [-922.4761962890625, 300.3277587890625],
        [828.0126953125, 410.51605224609375],
    ];
    let e = if ty == ElementType::Arrow {
        new_arrow_element(o, pts, None, Some(Arrowhead::Arrow), false, None)
    } else {
        new_linear_element(o, pts, None)
    };
    Scene::new(vec![e])
}

#[test]
fn flips_curved_arrows_and_lines_inside_min_max_points() {
    for ty in [ElementType::Arrow, ElementType::Line] {
        for dir in [H, V] {
            setup();
            check_flip(&mut curve_inside(ty), &[dir], None);
            let mut s = curve_inside(ty);
            s.mutate_element("x", true, |e| e.angle = PI / 4.);
            check_flip(&mut s, &[dir], Some(7. * PI / 4.));
        }
    }
}

#[test]
fn flips_images() {
    // the smiley fixture: 56 × 77
    let image = |angle: f64| {
        let mut s = Scene::default();
        ui_image(&mut s, "x", 0., 0., 56., 77.);
        s.mutate_element("x", true, |e| e.angle = angle);
        s
    };
    for (dirs, sc) in [
        (&[H][..], [-1., 1.]),
        (&[V][..], [1., -1.]),
        (&[H, V][..], [-1., -1.]),
    ] {
        setup();
        let mut s = image(0.);
        check_flip(&mut s, dirs, Some(0.));
        assert_eq!(scale(&s, "x"), sc);
        if dirs.len() == 1 {
            let mut s = image(PI / 4.);
            check_flip(&mut s, dirs, Some(7. * PI / 4.));
            assert_eq!(scale(&s, "x"), sc);
        }
    }
}

#[test]
fn flips_multiple_elements_with_bound_text() {
    setup();
    let mut s = Scene::default();
    ui_arrow(&mut s, "a", 0., 0., vec![[0., 0.], [180., 80.]]);
    let at = ui_label(&mut s, "a", "arrow", 20.);
    ui_shape(&mut s, ElementType::Rectangle, "r", 0., 100., 100., 100.);
    let rt = ui_label(&mut s, "r", "rect\ntext", 20.);
    flip(&mut s, &["a", "r"], &[H, V]);
    let (a, t) = (get(&s, "a"), get(&s, &at));
    let p = get_bound_text_element_position(a, t, &s);
    close(a.x, 180., 2);
    close(a.y, 200., 2);
    close(a.points().unwrap()[1][0], -180., 2);
    close(a.points().unwrap()[1][1], -80., 2);
    close(p[0] - (a.x - a.width), a.x - (p[0] + t.width), 2);
    close(p[1] - (a.y - a.height), a.y - (p[1] + t.height), 2);
    let (r, t) = (get(&s, "r"), get(&s, &rt));
    close(r.x, 80., 2);
    close(r.y, 0., 2);
    close(t.x - r.x, r.x + r.width - (t.x + t.width), 2);
    close(t.y - r.y, r.y + r.height - (t.y + t.height), 2);
}
