// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Actions: excalidraw/tests/elementLocking.test.tsx, actionStyles.test.tsx,
//! and excalidraw/actions/actionDeleteSelected.test.tsx,
//! actionElementLock.test.tsx, actionDuplicateSelection.test.tsx (frames,
//! frame children, labeled arrows), actionFlip.test.tsx ("flipping
//! arrowheads"), actionProperties.test.tsx (stroke widths) @ 3a317b5. Menu
//! clicks and shortcuts are calls of the action functions; "selected" in an
//! expectation is `selectedElementIds`.
//!
//! Skipped, with reasons:
//! - elementLocking: click / right-click / drag / double-click / text-tool /
//!   Enter hit testing ("click-selecting …", "dragging …", "clicking on a
//!   locked element …", "right-clicking …", "should ignore locked text …",
//!   "bound text shouldn't be editable …") is the app's selection and text
//!   tools; box selection is checked through `get_elements_within_selection`
//!   and group selection through `select_groups_for_selected_elements`.
//! - actionStyles: the color picker's hidden swatch and hotkeys (UI); the
//!   sticky roughness / roundness cases are the panel's actions on a note.
//! - actionElementLock "should not show unlockAllElements …": the context
//!   menu; its predicate is checked instead.
//! - actionDeleteSelected "cutting a selected frame …": cut is delete with
//!   frame children (clipboard writing is the app's).
//! - actionDuplicateSelection "duplicating multiple frames", "duplicating
//!   groups": covered by order.rs (duplicate.test.tsx's Cmd+D cases).
//! - actionFlip "flipping re-centers selection": elbow arrow drawn with the
//!   tool and dragged (resize.rs covers flipping elbow arrows).
//! - actionProperties: top picks, which panel sections show and button
//!   highlighting are UI; stroke widths are checked through the action and
//!   `get_form_value`.

use super::common::*;
use lattice_board_core::board::actions::*;
use lattice_board_core::board::app_state::{AppState, StrokeWidthKey};
use lattice_board_core::board::binding::NO_BINDING_HOOKS;
use lattice_board_core::board::bounds::BBoxMode;
use lattice_board_core::board::consts::*;
use lattice_board_core::board::duplicate::{get_orig_id, track_orig_ids};
use lattice_board_core::board::groups::select_groups_for_selected_elements;
use lattice_board_core::board::history::CaptureUpdateAction;
use lattice_board_core::board::new_element::*;
use lattice_board_core::board::selection::get_elements_within_selection;
use lattice_board_core::board::text_measure::TestMeasure;
use lattice_board_core::board::types::*;
use std::collections::BTreeSet;

const M: &TestMeasure = &TestMeasure;

fn sel(ids: &[&str]) -> AppState {
    AppState {
        selected_element_ids: ids.iter().map(|s| s.to_string()).collect(),
        ..AppState::default()
    }
}
fn frame(id: &str) -> Element {
    new_frame_element(opts(id, 0., 0., 100., 100.), None)
}
fn in_frame(mut e: Element, f: &str) -> Element {
    e.frame_id = Some(f.into());
    e
}
fn text(id: &str, container: Option<&str>, frame_id: Option<&str>) -> Element {
    let mut t = new_text_element(
        TextOpts {
            text: "ola".into(),
            font_size: Some(20.),
            container_id: container.map(String::from),
            ..Default::default()
        },
        opts(id, 0., 0., 200., 100.),
        M,
    );
    t.frame_id = frame_id.map(String::from);
    t
}
fn bind_text(mut c: Element, t: &str) -> Element {
    c.bound_elements = Some(vec![BoundElement {
        id: t.into(),
        kind: BoundType::Text,
    }]);
    c
}
fn get<'a>(es: &'a [Element], id: &str) -> &'a Element {
    es.iter().find(|e| e.id == id).unwrap()
}
fn apply(es: &[Element], a: &AppState, r: ActionResult) -> (Vec<Element>, AppState) {
    (
        r.elements.unwrap_or_else(|| es.to_vec()),
        r.app_state.unwrap_or_else(|| a.clone()),
    )
}
fn ids(a: &AppState) -> Vec<&str> {
    a.selected_element_ids.iter().map(|s| s.as_str()).collect()
}

// ---------------------------------------------------------------------------
// actionDeleteSelected.test.tsx
// ---------------------------------------------------------------------------

/// `[id, isDeleted, selected]` per element, in order.
fn assert_deleted(es: &[Element], a: &AppState, expected: &[(&str, bool, bool)]) {
    let got: Vec<(&str, bool, bool)> = es
        .iter()
        .map(|e| {
            (
                e.id.as_str(),
                e.is_deleted,
                a.selected_element_ids.contains(&e.id),
            )
        })
        .collect();
    assert_eq!(got, expected);
}

#[test]
fn delete_frame_only_keeps_children_selected() {
    setup();
    let es = vec![frame("f1"), in_frame(rect("r1", 0., 0., 10., 10.), "f1")];
    let a = sel(&["f1"]);
    let (es, a) = apply(&es, &a, action_delete_selected(&es, &a, false));
    assert_deleted(&es, &a, &[("f1", true, false), ("r1", false, true)]);
    assert_eq!(get(&es, "r1").frame_id, None);
}

#[test]
fn delete_frame_with_text_container() {
    setup();
    // text's frameId set / not set / text selected too
    for (text_frame, selected) in [
        (Some("f1"), vec!["f1"]),
        (None, vec!["f1"]),
        (None, vec!["f1", "t1"]),
    ] {
        let es = vec![
            frame("f1"),
            bind_text(in_frame(rect("r1", 0., 0., 10., 10.), "f1"), "t1"),
            text("t1", Some("r1"), text_frame),
        ];
        let a = sel(&selected);
        let (es, a) = apply(&es, &a, action_delete_selected(&es, &a, false));
        assert_deleted(
            &es,
            &a,
            &[
                ("f1", true, false),
                ("r1", false, true),
                ("t1", false, false),
            ],
        );
    }
}

#[test]
fn delete_frame_with_labeled_arrow() {
    setup();
    let es = vec![
        frame("f1"),
        bind_text(
            in_frame(arrow("a1", 0., 0., vec![[0., 0.], [10., 10.]]), "f1"),
            "t1",
        ),
        text("t1", Some("a1"), None),
    ];
    let a = sel(&["f1", "t1"]);
    let (es, a) = apply(&es, &a, action_delete_selected(&es, &a, false));
    assert_deleted(
        &es,
        &a,
        &[
            ("f1", true, false),
            ("a1", false, true),
            ("t1", false, false),
        ],
    );
}

#[test]
fn delete_frame_with_children_selected() {
    setup();
    let es = vec![frame("f1"), in_frame(rect("r1", 0., 0., 10., 10.), "f1")];
    let a = sel(&["f1", "r1"]);
    let (es, a) = apply(&es, &a, action_delete_selected(&es, &a, false));
    assert_deleted(&es, &a, &[("f1", true, false), ("r1", false, true)]);
}

#[test]
fn cut_frame_takes_children_along() {
    setup();
    let scene = || {
        vec![
            frame("f1"),
            in_frame(rect("r1", 0., 0., 10., 10.), "f1"),
            bind_text(in_frame(rect("r2", 0., 0., 10., 10.), "f1"), "t1"),
            text("t1", Some("r2"), Some("f1")),
        ]
    };
    for selected in [vec!["f1"], vec!["f1", "r1", "r2"]] {
        let es = scene();
        let a = sel(&selected);
        let (es, _) = apply(&es, &a, action_delete_selected(&es, &a, true));
        assert!(es.iter().all(|e| e.is_deleted));
    }
}

#[test]
fn delete_selects_next_in_editing_group() {
    setup();
    let mut es = vec![
        rect("a", 0., 0., 10., 10.),
        rect("b", 0., 0., 10., 10.),
        rect("c", 0., 0., 10., 10.),
    ];
    for e in &mut es {
        e.group_ids = vec!["g".into()];
    }
    let a = AppState {
        editing_group_id: Some("g".into()),
        ..sel(&["a"])
    };
    let r = action_delete_selected(&es, &a, false);
    assert_eq!(r.capture_update, CaptureUpdateAction::Immediately);
    let (es, a) = apply(&es, &a, r);
    assert!(get(&es, "a").is_deleted);
    assert_eq!(ids(&a), ["b"]);
    assert_eq!(a.editing_group_id.as_deref(), Some("g"));
}

// ---------------------------------------------------------------------------
// actionElementLock.test.tsx, elementLocking.test.tsx
// ---------------------------------------------------------------------------

#[test]
fn unlock_all_elements_selects_them() {
    setup();
    let mut es = vec![
        rect("a", 100., 100., 100., 100.),
        rect("b", 100., 100., 100., 100.),
        rect("c", 100., 100., 100., 100.),
    ];
    es[0].locked = true;
    es[1].locked = true;
    let a = AppState::default();
    assert!(can_unlock_all_elements(&es, &a));
    let (es, a) = apply(&es, &a, action_unlock_all_elements(&es, &a));
    assert_eq!(
        es.iter().map(|e| e.locked).collect::<Vec<_>>(),
        [false, false, false]
    );
    assert_eq!(ids(&a), ["a", "b"]);
    assert!(!can_unlock_all_elements(
        &[rect("x", 0., 0., 1., 1.)],
        &AppState::default()
    ));
}

#[test]
fn box_selecting_a_locked_element_is_disabled() {
    setup();
    let mut r = rect("r", 100., 100., 100., 100.);
    r.locked = true;
    let es = vec![r];
    let selection = shape(ElementType::Selection, "sel", 50., 50., 200., 200.);
    assert!(
        get_elements_within_selection(&es, &selection, &es, true, BBoxMode::Contain).is_empty()
    );
}

#[test]
fn select_all_skips_locked_elements() {
    setup();
    let mut es = vec![rect("a", 0., 0., 10., 10.), rect("b", 0., 0., 10., 10.)];
    es[1].locked = true;
    let (_, a) = apply(
        &es,
        &AppState::default(),
        action_select_all(&es, &AppState::default()),
    );
    assert_eq!(ids(&a), ["a"]);
}

#[test]
fn selecting_a_group_selects_locked_members() {
    setup();
    let mut es = vec![
        rect("a", 0., 0., 100., 100.),
        rect("b", 200., 200., 100., 100.),
    ];
    for e in &mut es {
        e.group_ids = vec!["g1".into()];
    }
    es[1].locked = true;
    // clicking the unlocked member selects it, and with it its group
    let s = select_groups_for_selected_elements(&BTreeSet::from(["a".to_string()]), None, &es);
    assert_eq!(s.selected_element_ids.len(), 2);
}

#[test]
fn locking_includes_bound_text() {
    setup();
    let es = vec![
        bind_text(rect("c", 0., 0., 100., 100.), "t"),
        text("t", Some("c"), None),
    ];
    let a = sel(&["c"]);
    assert!(can_toggle_element_lock(&es, &a));
    let (es, a) = apply(&es, &a, action_toggle_element_lock(&es, &a));
    assert!(es.iter().all(|e| e.locked));
    // the label is selected along, so the two lock as one temporary group
    assert!(a.selected_element_ids.is_empty());
    assert!(
        a.active_locked_id
            .as_ref()
            .is_some_and(|g| a.locked_multi_selections.contains(g))
    );
    // unlocking selects them again
    let a = AppState {
        locked_multi_selections: a.locked_multi_selections,
        ..sel(&["c"])
    };
    let (es, a) = apply(&es, &a, action_toggle_element_lock(&es, &a));
    assert!(es.iter().all(|e| !e.locked));
    assert_eq!(ids(&a), ["c", "t"]);
}

#[test]
fn locking_several_groups_them_temporarily() {
    setup();
    let es = vec![rect("a", 0., 0., 10., 10.), rect("b", 20., 0., 10., 10.)];
    let a = sel(&["a", "b"]);
    let (es, a) = apply(&es, &a, action_toggle_element_lock(&es, &a));
    let g = a.active_locked_id.clone().unwrap();
    assert!(a.locked_multi_selections.contains(&g));
    assert!(es.iter().all(|e| e.locked && e.group_ids == [g.clone()]));
    let a = sel(&["a", "b"]);
    let a = AppState {
        locked_multi_selections: BTreeSet::from([g.clone()]),
        ..a
    };
    let (es, a) = apply(&es, &a, action_toggle_element_lock(&es, &a));
    assert!(es.iter().all(|e| !e.locked && e.group_ids.is_empty()));
    assert!(a.locked_multi_selections.is_empty());
}

// ---------------------------------------------------------------------------
// actionStyles.test.tsx
// ---------------------------------------------------------------------------

#[test]
fn copy_and_paste_styles() {
    setup();
    let es = vec![
        rect("r1", 10., 10., 10., 10.),
        rect("r2", 10., 10., 10., 10.),
    ];
    // change some styles of the second rectangle
    let a = sel(&["r2"]);
    let (es, a) = apply(&es, &a, action_change_stroke_color(&es, &a, "#e03131"));
    let (es, a) = apply(&es, &a, action_change_background_color(&es, &a, "#a5d8ff"));
    let (es, a) = apply(
        &es,
        &a,
        action_change_fill_style(&es, &a, FillStyle::CrossHatch),
    );
    let (es, a) = apply(
        &es,
        &a,
        action_change_stroke_width(&es, &a, StrokeWidthKey::Bold),
    );
    let (es, a) = apply(
        &es,
        &a,
        action_change_stroke_style(&es, &a, StrokeStyle::Dotted),
    );
    let (es, a) = apply(&es, &a, action_change_sloppiness(&es, &a, 2.));
    let (es, a) = apply(&es, &a, action_change_opacity(&es, &a, 60.));
    let copied = action_copy_styles(&es, &a);
    assert_eq!(copied[0].id, "r2");
    let a = sel(&["r1"]);
    let (es, _) = apply(
        &es,
        &a,
        action_paste_styles(&es, &a, &copied, M, &NO_BINDING_HOOKS),
    );
    let r1 = get(&es, "r1");
    assert_eq!(r1.stroke_color, "#e03131");
    assert_eq!(r1.background_color, "#a5d8ff");
    assert_eq!(r1.fill_style, FillStyle::CrossHatch);
    assert_eq!(r1.stroke_width, STROKE_WIDTH[2]);
    assert_eq!(r1.stroke_style, StrokeStyle::Dotted);
    assert_eq!(r1.roughness, 2.);
    assert_eq!(r1.opacity, 60.);
}

#[test]
fn sticky_note_roughness_and_roundness() {
    setup();
    let mut n = new_sticky_note_element(opts("n", 0., 0., 250., 250.), None);
    n.roughness = 0.;
    n.roundness = None;
    let es = vec![n];
    let a = sel(&["n"]);
    let (es, a) = apply(&es, &a, action_change_sloppiness(&es, &a, 2.));
    assert_eq!(es[0].roughness, 2.);
    let (es, _) = apply(
        &es,
        &a,
        action_change_roundness(
            &es,
            &a,
            lattice_board_core::board::app_state::StrokeRoundness::Round,
        ),
    );
    assert_eq!(
        es[0].roundness,
        Some(Roundness {
            kind: roundness::PROPORTIONAL_RADIUS,
            value: None
        })
    );
}

#[test]
fn sticky_note_stroke_color_tracked_separately() {
    setup();
    let mut n = new_sticky_note_element(opts("n", 0., 0., 250., 250.), None);
    n.stroke_color = "#1e1e1e".into();
    let es = vec![n];
    let a = AppState {
        current_item_stroke_color: "#e03131".into(),
        current_item_stickynote_stroke_color: "#1e1e1e".into(),
        ..sel(&["n"])
    };
    let (es, a) = apply(&es, &a, action_change_stroke_color(&es, &a, "#1971c2"));
    assert_eq!(es[0].stroke_color, "#1971c2");
    assert_eq!(a.current_item_stickynote_stroke_color, "#1971c2");
    assert_eq!(a.current_item_stroke_color, "#e03131");
}

// ---------------------------------------------------------------------------
// actionDuplicateSelection.test.tsx
// ---------------------------------------------------------------------------

/// The element's original id if it's a duplicate, else its own id with `=`.
fn origin(e: &Element) -> String {
    get_orig_id(&e.id).map_or_else(|| format!("={}", e.id), |o| format!("{o}'"))
}
fn dup_of<'a>(es: &'a [Element], orig: &str) -> &'a Element {
    es.iter()
        .find(|e| get_orig_id(&e.id).as_deref() == Some(orig))
        .unwrap()
}

fn duplicate(es: Vec<Element>, selected: &[&str]) -> (Vec<Element>, AppState) {
    track_orig_ids(true);
    let a = sel(selected);
    let r = action_duplicate_selection(&es, &a, &NO_BINDING_HOOKS);
    apply(&es, &a, r)
}

#[test]
fn duplicate_frame_selected_only() {
    setup();
    let (es, a) = duplicate(
        vec![frame("f"), in_frame(rect("r", 0., 0., 10., 10.), "f")],
        &["f"],
    );
    assert_eq!(
        es.iter().map(origin).collect::<Vec<_>>(),
        ["=f", "=r", "r'", "f'"]
    );
    let f2 = dup_of(&es, "f").id.clone();
    assert_eq!(dup_of(&es, "r").frame_id.as_deref(), Some(f2.as_str()));
    assert_eq!(get(&es, "r").frame_id.as_deref(), Some("f"));
    assert_eq!(ids(&a), [f2.as_str()]);
    track_orig_ids(false);
}

#[test]
fn duplicate_frame_with_text_container() {
    setup();
    let scene = || {
        vec![
            frame("f"),
            bind_text(in_frame(rect("r", 0., 0., 10., 10.), "f"), "t"),
            text("t", Some("r"), Some("f")),
        ]
    };
    // frame only; frame + container (order A)
    for selected in [vec!["f"], vec!["f", "r"]] {
        let (es, a) = duplicate(scene(), &selected);
        assert_eq!(
            es.iter().map(origin).collect::<Vec<_>>(),
            ["=f", "=r", "=t", "r'", "t'", "f'"]
        );
        let (f2, r2) = (dup_of(&es, "f").id.clone(), dup_of(&es, "r").id.clone());
        assert_eq!(dup_of(&es, "r").frame_id.as_deref(), Some(f2.as_str()));
        assert_eq!(
            (
                dup_of(&es, "t").container_id(),
                dup_of(&es, "t").frame_id.as_deref()
            ),
            (Some(r2.as_str()), Some(f2.as_str()))
        );
        assert_eq!(ids(&a), [f2.as_str()]);
    }
    // order B
    let es = vec![
        text("t", Some("r"), Some("f")),
        bind_text(in_frame(rect("r", 0., 0., 10., 10.), "f"), "t"),
        frame("f"),
    ];
    let (es, a) = duplicate(es, &["r", "f"]);
    assert_eq!(
        es.iter().map(origin).collect::<Vec<_>>(),
        ["=r", "=t", "=f", "r'", "t'", "f'"]
    );
    let (f2, r2) = (dup_of(&es, "f").id.clone(), dup_of(&es, "r").id.clone());
    assert_eq!(
        (
            dup_of(&es, "t").container_id(),
            dup_of(&es, "t").frame_id.as_deref()
        ),
        (Some(r2.as_str()), Some(f2.as_str()))
    );
    assert_eq!(ids(&a), [f2.as_str()]);
    track_orig_ids(false);
}

#[test]
fn duplicate_frame_children() {
    setup();
    // frame child selected
    let (es, a) = duplicate(
        vec![frame("f"), in_frame(rect("r", 0., 0., 10., 10.), "f")],
        &["r"],
    );
    assert_eq!(
        es.iter().map(origin).collect::<Vec<_>>(),
        ["=f", "=r", "r'"]
    );
    assert_eq!(dup_of(&es, "r").frame_id.as_deref(), Some("f"));
    assert_eq!(ids(&a), [dup_of(&es, "r").id.as_str()]);
    // container selected, or only its text
    for selected in ["r", "t"] {
        let es = vec![
            frame("f"),
            bind_text(in_frame(rect("r", 0., 0., 10., 10.), "f"), "t"),
            text("t", Some("r"), Some("f")),
        ];
        let (es, a) = duplicate(es, &[selected]);
        assert_eq!(
            es.iter().map(origin).collect::<Vec<_>>(),
            ["=f", "=r", "=t", "r'", "t'"]
        );
        let r2 = dup_of(&es, "r").id.clone();
        assert_eq!(dup_of(&es, "r").frame_id.as_deref(), Some("f"));
        assert_eq!(
            (
                dup_of(&es, "t").container_id(),
                dup_of(&es, "t").frame_id.as_deref()
            ),
            (Some(r2.as_str()), Some("f"))
        );
        assert_eq!(ids(&a), [r2.as_str()]);
    }
    // container whose text doesn't exist
    let (es, a) = duplicate(
        vec![
            frame("f"),
            bind_text(in_frame(rect("r", 0., 0., 10., 10.), "f"), "t"),
        ],
        &["r"],
    );
    assert_eq!(
        es.iter().map(origin).collect::<Vec<_>>(),
        ["=f", "=r", "r'"]
    );
    assert_eq!(ids(&a), [dup_of(&es, "r").id.as_str()]);
    // text whose container doesn't exist
    let (es, a) = duplicate(vec![frame("f"), text("t", Some("r"), Some("f"))], &["t"]);
    assert_eq!(
        es.iter().map(origin).collect::<Vec<_>>(),
        ["=f", "=t", "t'"]
    );
    assert_eq!(dup_of(&es, "t").frame_id.as_deref(), Some("f"));
    assert_eq!(ids(&a), [dup_of(&es, "t").id.as_str()]);
    // text without a frameId
    let (es, a) = duplicate(
        vec![
            frame("f"),
            bind_text(in_frame(rect("r", 0., 0., 10., 10.), "f"), "t"),
            text("t", Some("r"), None),
        ],
        &["r"],
    );
    assert_eq!(
        es.iter().map(origin).collect::<Vec<_>>(),
        ["=f", "=r", "=t", "r'", "t'"]
    );
    let r2 = dup_of(&es, "r").id.clone();
    assert_eq!(
        (
            dup_of(&es, "t").container_id(),
            dup_of(&es, "t").frame_id.as_deref()
        ),
        (Some(r2.as_str()), None)
    );
    assert_eq!(ids(&a), [r2.as_str()]);
    track_orig_ids(false);
}

// ---------------------------------------------------------------------------
// actionFlip.test.tsx: flipping arrowheads
// ---------------------------------------------------------------------------

fn bound_arrow(
    start: Option<&str>,
    end: Option<&str>,
    sa: Option<Arrowhead>,
    ea: Option<Arrowhead>,
) -> Element {
    let mut a = arrow("arrow1", 0., 0., vec![[0., 0.], [100., 0.]]);
    let b = |id: Option<&str>| {
        id.map(|id| FixedPointBinding {
            element_id: id.into(),
            fixed_point: [0.5, 0.5],
            mode: BindMode::Orbit,
        })
    };
    if let Some(l) = a.linear_mut() {
        l.start_arrowhead = sa;
        l.end_arrowhead = ea;
        l.start_binding = b(start);
        l.end_binding = b(end);
    }
    a
}
fn with_arrow(mut e: Element) -> Element {
    e.bound_elements = Some(vec![BoundElement {
        id: "arrow1".into(),
        kind: BoundType::Arrow,
    }]);
    e
}
fn heads(es: &[Element]) -> (Option<Arrowhead>, Option<Arrowhead>) {
    let l = get(es, "arrow1").linear().unwrap();
    (l.start_arrowhead, l.end_arrowhead)
}
fn flip(es: Vec<Element>, a: &AppState, horizontal: bool) -> Vec<Element> {
    let r = if horizontal {
        action_flip_horizontal(&es, a, M, &NO_BINDING_HOOKS)
    } else {
        action_flip_vertical(&es, a, M, &NO_BINDING_HOOKS)
    };
    apply(&es, a, r).0
}

#[test]
fn flipping_bound_arrow_flips_arrowheads_only() {
    setup();
    let (ar, ci) = (Some(Arrowhead::Arrow), Some(Arrowhead::Circle));
    let a = sel(&["arrow1"]);
    let es = vec![
        with_arrow(rect("rect", 200., 200., 100., 100.)),
        bound_arrow(None, Some("rect"), ar, None),
    ];
    let es = flip(es, &a, true);
    assert_eq!(heads(&es), (None, ar));
    let es = flip(es, &a, true);
    assert_eq!(heads(&es), (ar, None));
    let es = flip(es, &a, false);
    assert_eq!(heads(&es), (None, ar));
    // bound at both ends
    let es = vec![
        with_arrow(rect("rect", 200., 200., 100., 100.)),
        with_arrow(rect("rect2", 400., 0., 100., 100.)),
        bound_arrow(Some("rect"), Some("rect2"), ar, ci),
    ];
    let es = flip(es, &a, true);
    assert_eq!(heads(&es), (ci, ar));
    let es = flip(es, &a, false);
    assert_eq!(heads(&es), (ar, ci));
}

#[test]
fn flipping_unbound_or_mixed_selection_keeps_arrowheads() {
    setup();
    let (ar, ci) = (Some(Arrowhead::Arrow), Some(Arrowhead::Circle));
    let es = flip(
        vec![bound_arrow(None, None, ar, ci)],
        &sel(&["arrow1"]),
        true,
    );
    assert_eq!(heads(&es), (ar, ci));
    let es = vec![
        with_arrow(rect("rect", 200., 200., 100., 100.)),
        bound_arrow(None, Some("rect"), ar, None),
    ];
    let es = flip(es, &sel(&["rect", "arrow1"]), true);
    assert_eq!(heads(&es), (ar, None));
}

// ---------------------------------------------------------------------------
// actionProperties.test.tsx: stroke widths
// ---------------------------------------------------------------------------

fn freedraw(id: &str, stroke_width: f64) -> Element {
    let mut f = new_free_draw_element(
        opts(id, 0., 0., 10., 10.),
        vec![[0., 0.], [10., 10.]],
        vec![],
        true,
        None,
    );
    f.stroke_width = stroke_width;
    f
}
fn common_width_key(es: &[Element], a: &AppState) -> Option<StrokeWidthKey> {
    get_form_value(es, a, get_stroke_width_key_for_element, |_| true, |_| None)
}

#[test]
fn common_stroke_width_of_selection() {
    setup();
    let mut r1 = rect("r1", 0., 0., 10., 10.);
    let mut r2 = rect("r2", 0., 0., 10., 10.);
    (r1.stroke_width, r2.stroke_width) = (STROKE_WIDTH[0], STROKE_WIDTH[0]);
    assert_eq!(
        common_width_key(&[r1.clone(), r2.clone()], &sel(&["r1", "r2"])),
        Some(StrokeWidthKey::Thin)
    );
    // across freedraw and non-freedraw
    let mut r = rect("r", 0., 0., 10., 10.);
    r.stroke_width = STROKE_WIDTH[1];
    assert_eq!(
        common_width_key(
            &[r, freedraw("f", FREEDRAW_STROKE_WIDTH[1])],
            &sel(&["r", "f"])
        ),
        Some(StrokeWidthKey::Medium)
    );
    // no common style
    r2.stroke_width = STROKE_WIDTH[2];
    assert_eq!(common_width_key(&[r1, r2], &sel(&["r1", "r2"])), None);
}

#[test]
fn stroke_width_applies_by_element_type() {
    setup();
    let mut r = rect("r", 0., 0., 10., 10.);
    r.stroke_width = STROKE_WIDTH[0];
    let es = vec![r, freedraw("f", FREEDRAW_STROKE_WIDTH[0])];
    let a = sel(&["r", "f"]);
    let (es, a) = apply(
        &es,
        &a,
        action_change_stroke_width(&es, &a, StrokeWidthKey::Bold),
    );
    assert_eq!(
        (get(&es, "r").stroke_width, get(&es, "f").stroke_width),
        (STROKE_WIDTH[2], FREEDRAW_STROKE_WIDTH[2])
    );
    assert_eq!(a.current_item_stroke_width_key, StrokeWidthKey::Bold);
    assert_eq!(
        (
            a.current_item_stroke_width(false),
            a.current_item_stroke_width(true)
        ),
        (STROKE_WIDTH[2], FREEDRAW_STROKE_WIDTH[2])
    );
}

// ---------------------------------------------------------------------------
// own: group / ungroup, deselect, text auto-resize, arrow type
// ---------------------------------------------------------------------------

#[test]
fn group_and_ungroup() {
    setup();
    let es = vec![
        rect("a", 0., 0., 10., 10.),
        rect("x", 0., 0., 10., 10.),
        rect("b", 20., 0., 10., 10.),
    ];
    let a = sel(&["a", "b"]);
    assert!(can_group(&es, &a));
    let (es, a) = apply(&es, &a, action_group(&es, &a));
    // the group moves up to its topmost member, keeping its order
    assert_eq!(
        es.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        ["x", "a", "b"]
    );
    let g = get(&es, "a").group_ids.clone();
    assert_eq!(g.len(), 1);
    assert_eq!(get(&es, "b").group_ids, g);
    assert_eq!(a.selected_group_ids.get(&g[0]), Some(&true));
    assert!(!can_group(&es, &a));
    assert!(can_ungroup(&a));
    let (es, a) = apply(&es, &a, action_ungroup(&es, &a));
    assert!(es.iter().all(|e| e.group_ids.is_empty()));
    assert_eq!(ids(&a), ["a", "b"]);
    assert!(a.selected_group_ids.is_empty());
}

#[test]
fn deselect_leaves_editing_group_for_its_parent() {
    setup();
    let mut es = vec![
        rect("a", 0., 0., 10., 10.),
        rect("b", 20., 0., 10., 10.),
        rect("c", 40., 0., 10., 10.),
    ];
    es[0].group_ids = vec!["inner".into(), "outer".into()];
    es[1].group_ids = vec!["inner".into(), "outer".into()];
    es[2].group_ids = vec!["outer".into()];
    let a = AppState {
        editing_group_id: Some("inner".into()),
        ..sel(&["a"])
    };
    let (_, a) = apply(&es, &a, action_deselect(&es, &a));
    assert_eq!(a.editing_group_id.as_deref(), Some("outer"));
    assert_eq!(ids(&a), ["a", "b"]);
    assert_eq!(a.selected_group_ids.get("inner"), Some(&true));
    let a = AppState {
        editing_group_id: None,
        ..a
    };
    let (_, a) = apply(&es, &a, action_deselect(&es, &a));
    assert!(a.selected_element_ids.is_empty() && a.selected_group_ids.is_empty());
}

#[test]
fn text_auto_resize_keeps_alignment_anchor() {
    setup();
    let mut t = new_text_element(
        TextOpts {
            text: "hello world".into(),
            font_size: Some(20.),
            text_align: Some(TextAlign::Right),
            ..Default::default()
        },
        opts("t", 0., 0., 50., 50.),
        M,
    );
    (t.x, t.width, t.height) = (0., 50., 50.);
    if let Some(d) = t.text_mut() {
        d.auto_resize = false;
        d.text = "hello\nworld".into();
    }
    let es = vec![t];
    let a = sel(&["t"]);
    let (es, _) = apply(
        &es,
        &a,
        action_text_auto_resize(&es, &a, None, M, &NO_BINDING_HOOKS),
    );
    let t = &es[0];
    let d = t.text().unwrap();
    assert!(d.auto_resize);
    assert_eq!(d.text, "hello world");
    close(t.width, 110., 6);
    // the right edge stays
    close(t.x + t.width, 50., 6);
}

#[test]
fn set_link_normalizes() {
    setup();
    let es = vec![rect("r", 0., 0., 10., 10.)];
    let (es, _) = apply(
        &es,
        &AppState::default(),
        action_set_link(&es, &AppState::default(), "r", "  https://example.com  "),
    );
    assert_eq!(es[0].link.as_deref(), Some("https://example.com"));
    let (es, _) = apply(
        &es,
        &AppState::default(),
        action_set_link(&es, &AppState::default(), "r", ""),
    );
    assert_eq!(es[0].link, None);
}

#[test]
fn change_arrow_type_to_elbow_and_back() {
    setup();
    let es = vec![arrow("a", 10., 10., vec![[0., 0.], [100., 50.]])];
    let a = sel(&["a"]);
    let (es, a) = apply(
        &es,
        &a,
        action_change_arrow_type(
            &es,
            &a,
            lattice_board_core::board::app_state::ArrowType::Elbow,
        ),
    );
    assert!(es[0].is_elbow_arrow());
    assert_eq!(es[0].roundness, None);
    let p = es[0].points().unwrap();
    // the ends stay where they were
    assert_eq!((es[0].x + p[0][0], es[0].y + p[0][1]), (10., 10.));
    let last = p[p.len() - 1];
    assert_eq!((es[0].x + last[0], es[0].y + last[1]), (110., 60.));
    let (es, _) = apply(
        &es,
        &a,
        action_change_arrow_type(
            &es,
            &a,
            lattice_board_core::board::app_state::ArrowType::Round,
        ),
    );
    assert!(es[0].is_simple_arrow());
    assert_eq!(
        es[0].roundness.map(|r| r.kind),
        Some(roundness::PROPORTIONAL_RADIUS)
    );
    assert_eq!(es[0].points().unwrap().len(), 2);
}
