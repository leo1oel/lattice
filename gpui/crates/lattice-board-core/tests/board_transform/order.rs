// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Z-order, duplication, aligning and distributing:
//! element/tests/selection.test.ts, zindex.test.tsx, duplicate.test.tsx,
//! align.test.tsx, distribute.test.tsx @ 3a317b5. `populate` is upstream's
//! `populateElements` (100×100 rectangles at 100,100; text when it has a
//! container; groups selected as `selectGroupsForSelectedElements` selects
//! them). An element spec is `"id flags…"`: `d` deleted, `s` selected,
//! `g=a,b` groupIds, `c=X` containerId, `f=F` frameId, `t=frame` type. In
//! expected id lists `X'` is the duplicate of `X` (`getCloneByOrigId`).
//! The UI-built align / distribute scenes (tool drags, shift-clicks,
//! `actionGroup`, double-click into a group) are built directly with the
//! elements, groups and selection those steps leave.
//!
//! Skipped, with reasons:
//! - selection.test.ts `makeNextSelectedElementIds`: keeps the previous
//!   object for React identity; our selection is a value (`BTreeSet`).
//! - duplicate.test.tsx: the alt-drag cases ("alt-duplicating …", "… with
//!   alt+drag …") drive the app's alt-drag (App.duplicate pointer flow); the
//!   list-item and "alt-dragging the text being edited" suites are the app's
//!   (list markers advance after the commit; `board_text.rs` covers
//!   `advance_duplicated_list_markers`); the prototype assertions of "clones
//!   arrow element" are JS-specific (Rust clones deeply).
//! - zindex.test.tsx: all translated.

use super::common::*;
use lattice_board_core::board::actions::*;
use lattice_board_core::board::align::*;
use lattice_board_core::board::app_state::AppState;
use lattice_board_core::board::binding::{BindingHooks, NO_BINDING_HOOKS};
use lattice_board_core::board::duplicate::*;
use lattice_board_core::board::fractional_index::sync_invalid_indices;
use lattice_board_core::board::groups::select_groups_for_selected_elements;
use lattice_board_core::board::new_element::*;
use lattice_board_core::board::selection::{SelectedOpts, get_selected_elements};
use lattice_board_core::board::text_measure::TestMeasure;
use lattice_board_core::board::types::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::{BTreeMap, BTreeSet};

type Op = fn(&[Element], &AppState) -> ActionResult;
fn back(e: &[Element], a: &AppState) -> ActionResult {
    action_send_backward(e, a)
}
fn fwd(e: &[Element], a: &AppState) -> ActionResult {
    action_bring_forward(e, a)
}
fn to_back(e: &[Element], a: &AppState) -> ActionResult {
    action_send_to_back(e, a)
}
fn to_front(e: &[Element], a: &AppState) -> ActionResult {
    action_bring_to_front(e, a)
}
fn dup(e: &[Element], a: &AppState) -> ActionResult {
    action_duplicate_selection(e, a, &NO_BINDING_HOOKS)
}

/// `populateElements`.
fn populate_at(
    specs: &[&str],
    editing: Option<&str>,
    selected_groups: Option<&[&str]>,
) -> (Vec<Element>, AppState) {
    let mut els = vec![];
    let mut selected = BTreeSet::new();
    for s in specs {
        let mut it = s.split(' ');
        let id = it.next().unwrap();
        let mut o = opts(id, 100., 100., 100., 100.);
        let (mut deleted, mut container, mut ty) = (false, None, None);
        for f in it {
            match f.split_once('=') {
                None if f == "d" => deleted = true,
                None if f == "s" => {
                    selected.insert(id.to_string());
                }
                Some(("g", g)) => o.group_ids = g.split(',').map(String::from).collect(),
                Some(("c", c)) => container = Some(c.to_string()),
                Some(("f", fr)) => o.frame_id = Some(fr.into()),
                Some(("t", t)) => ty = Some(t.to_string()),
                _ => panic!("bad spec {s}"),
            }
        }
        let mut e = match (ty.as_deref(), &container) {
            (Some("frame"), _) => new_frame_element(o, None),
            (_, Some(c)) => {
                let mut t = new_text_element(
                    TextOpts {
                        container_id: Some(c.clone()),
                        ..Default::default()
                    },
                    o,
                    &TestMeasure,
                );
                (t.x, t.y, t.width, t.height) = (100., 100., 100., 100.);
                t
            }
            _ => new_element(ElementType::Rectangle, o),
        };
        e.is_deleted = deleted;
        els.push(e);
    }
    // `boundElements` on containers followed by their text
    for i in 0..els.len().saturating_sub(1) {
        if els[i + 1].container_id() == Some(els[i].id.as_str()) {
            let t = els[i + 1].id.clone();
            els[i].bound_elements = Some(vec![BoundElement {
                id: t,
                kind: BoundType::Text,
            }]);
        }
    }
    sync_invalid_indices(&mut els);
    let mut a = AppState::default();
    let g = select_groups_for_selected_elements(&selected, editing, &els);
    a.selected_group_ids = match selected_groups {
        Some(gs) => gs.iter().map(|g| (g.to_string(), true)).collect(),
        None => g.selected_group_ids,
    };
    a.editing_group_id = editing.map(String::from);
    a.selected_element_ids = selected;
    (els, a)
}
fn populate(specs: &[&str], editing: Option<&str>) -> (Vec<Element>, AppState) {
    populate_at(specs, editing, None)
}

fn ids(els: &[Element]) -> Vec<String> {
    els.iter()
        .map(|e| match get_orig_id(&e.id) {
            Some(o) => format!("{o}'"),
            None => e.id.clone(),
        })
        .collect()
}

fn assert_zindex(specs: &[&str], editing: Option<&str>, ops: &[(Op, &[&str])]) {
    setup();
    let (mut els, a) = populate(specs, editing);
    for (op, expected) in ops {
        let r = op(&els, &a);
        els = r.elements.unwrap();
        assert_eq!(ids(&els), *expected);
        assert_eq!(
            r.app_state.unwrap().selected_element_ids,
            a.selected_element_ids
        );
    }
}

/// `assertReorderPreservesElements`: each op on a fresh (broken) state.
fn assert_reorder(specs: &[&str], editing: Option<&str>, ops: &[(Op, &[&str])]) {
    for (op, expected) in ops {
        setup();
        let (els, a) = populate(specs, editing);
        let after = ids(&op(&els, &a).elements.unwrap());
        assert_eq!(after.len(), els.len());
        assert_eq!(after.iter().collect::<FxHashSet<_>>().len(), after.len());
        assert_eq!(after, *expected);
    }
}

fn assert_dup(
    specs: &[&str],
    editing: Option<&str>,
    selected_groups: Option<&[&str]>,
    expected: &[&str],
) {
    setup();
    track_orig_ids(true);
    let (els, a) = populate_at(specs, editing, selected_groups);
    let next = dup(&els, &a).elements.unwrap();
    assert_eq!(ids(&next), expected);
    track_orig_ids(false);
}

// ---------------------------------------------------------------------------
// zindex.test.tsx
// ---------------------------------------------------------------------------

// send back
#[test]
fn zindex_send_back() {
    assert_zindex(
        &["A", "B d", "C d", "D s"],
        None,
        &[(back, &["D", "A", "B", "C"]), (back, &["D", "A", "B", "C"])],
    );
    assert_zindex(&["A s", "B s", "C s"], None, &[(back, &["A", "B", "C"])]);
    assert_zindex(
        &["A d", "B", "C d", "D s"],
        None,
        &[(back, &["A", "D", "B", "C"])],
    );
    assert_zindex(
        &["A", "B d", "C d", "D s", "E s", "F"],
        None,
        &[
            (back, &["D", "E", "A", "B", "C", "F"]),
            (back, &["D", "E", "A", "B", "C", "F"]),
        ],
    );
    assert_zindex(
        &["A", "B", "C d", "D d", "E s", "F", "G s"],
        None,
        &[
            (back, &["A", "E", "B", "C", "D", "G", "F"]),
            (back, &["E", "A", "G", "B", "C", "D", "F"]),
            (back, &["E", "G", "A", "B", "C", "D", "F"]),
            (back, &["E", "G", "A", "B", "C", "D", "F"]),
        ],
    );
    assert_zindex(
        &["A", "B", "C d", "D s", "E d", "F s", "G"],
        None,
        &[
            (back, &["A", "D", "E", "F", "B", "C", "G"]),
            (back, &["D", "E", "F", "A", "B", "C", "G"]),
            (back, &["D", "E", "F", "A", "B", "C", "G"]),
        ],
    );
    assert_zindex(
        &["A c=C", "B", "C s"],
        None,
        &[(back, &["A", "C", "B"]), (back, &["A", "C", "B"])],
    );
    assert_zindex(
        &["A", "B g=g1", "C g=g1", "D d", "E d", "F s"],
        None,
        &[
            (back, &["A", "F", "B", "C", "D", "E"]),
            (back, &["F", "A", "B", "C", "D", "E"]),
            (back, &["F", "A", "B", "C", "D", "E"]),
        ],
    );
    assert_zindex(
        &["A", "B g=g2,g1", "C g=g2,g1", "D g=g1", "E d", "F s"],
        None,
        &[
            (back, &["A", "F", "B", "C", "D", "E"]),
            (back, &["F", "A", "B", "C", "D", "E"]),
            (back, &["F", "A", "B", "C", "D", "E"]),
        ],
    );
    assert_zindex(
        &["A", "B g=g1", "C g=g2,g1", "D g=g2,g1", "E d", "F s"],
        None,
        &[
            (back, &["A", "F", "B", "C", "D", "E"]),
            (back, &["F", "A", "B", "C", "D", "E"]),
            (back, &["F", "A", "B", "C", "D", "E"]),
        ],
    );
    assert_zindex(
        &["A", "B1 g=g1", "C1 g=g1", "D2 s g=g2", "E2 s g=g2"],
        None,
        &[(back, &["A", "D2", "E2", "B1", "C1"])],
    );
    assert_zindex(
        &["A", "B g=g1", "C g=g2,g1", "D s g=g2,g1"],
        Some("g2"),
        &[(back, &["A", "B", "D", "C"]), (back, &["A", "B", "D", "C"])],
    );
    assert_zindex(
        &["A", "B g=g2,g1", "C g=g2,g1", "D s g=g1"],
        Some("g1"),
        &[(back, &["A", "D", "B", "C"]), (back, &["A", "D", "B", "C"])],
    );
    assert_zindex(
        &["A", "B g=g1", "C s g=g2,g1", "D d g=g2,g1", "E s g=g2,g1"],
        Some("g1"),
        &[
            (back, &["A", "C", "D", "E", "B"]),
            (back, &["A", "C", "D", "E", "B"]),
        ],
    );
    assert_zindex(
        &[
            "A",
            "B g=g1",
            "C g=g2,g1",
            "D g=g2,g1",
            "E s g=g3,g1",
            "F s g=g3,g1",
        ],
        Some("g1"),
        &[
            (back, &["A", "B", "E", "F", "C", "D"]),
            (back, &["A", "E", "F", "B", "C", "D"]),
            (back, &["A", "E", "F", "B", "C", "D"]),
        ],
    );
    assert_zindex(
        &["A g=g1", "B g=g2", "C g=g1", "D s g=g2", "E s g=g2"],
        Some("g2"),
        &[
            (back, &["A", "D", "E", "B", "C"]),
            (back, &["A", "D", "E", "B", "C"]),
        ],
    );
    assert_zindex(
        &["A g=g1", "B g=g2", "C g=g1", "D s g=g2", "F", "G s g=g2"],
        Some("g2"),
        &[
            (back, &["A", "D", "G", "B", "C", "F"]),
            (back, &["A", "D", "G", "B", "C", "F"]),
        ],
    );
}

// bring forward
#[test]
fn zindex_bring_forward() {
    assert_zindex(
        &["A", "B s", "C s", "D d", "E"],
        None,
        &[
            (fwd, &["A", "D", "E", "B", "C"]),
            (fwd, &["A", "D", "E", "B", "C"]),
        ],
    );
    assert_zindex(&["A s", "B s", "C s"], None, &[(fwd, &["A", "B", "C"])]);
    assert_zindex(
        &["A s", "B d", "C d", "D", "E s", "F d", "G"],
        None,
        &[
            (fwd, &["B", "C", "D", "A", "F", "G", "E"]),
            (fwd, &["B", "C", "D", "F", "G", "A", "E"]),
            (fwd, &["B", "C", "D", "F", "G", "A", "E"]),
        ],
    );
    assert_zindex(
        &["A s", "B d", "C d", "D g=g1", "E g=g1", "F"],
        None,
        &[
            (fwd, &["B", "C", "D", "E", "A", "F"]),
            (fwd, &["B", "C", "D", "E", "F", "A"]),
            (fwd, &["B", "C", "D", "E", "F", "A"]),
        ],
    );
    assert_zindex(
        &["A", "B s", "C g=g2,g1", "D g=g2,g1", "E g=g1", "F"],
        None,
        &[
            (fwd, &["A", "C", "D", "E", "B", "F"]),
            (fwd, &["A", "C", "D", "E", "F", "B"]),
            (fwd, &["A", "C", "D", "E", "F", "B"]),
        ],
    );
    assert_zindex(
        &["A", "B s", "C g=g1", "D g=g2,g1", "E g=g2,g1", "F"],
        None,
        &[
            (fwd, &["A", "C", "D", "E", "B", "F"]),
            (fwd, &["A", "C", "D", "E", "F", "B"]),
            (fwd, &["A", "C", "D", "E", "F", "B"]),
        ],
    );
    assert_zindex(
        &["A", "B s g=g2,g1", "C g=g2,g1", "D g=g1"],
        Some("g2"),
        &[(fwd, &["A", "C", "B", "D"]), (fwd, &["A", "C", "B", "D"])],
    );
    assert_zindex(
        &["A s g=g1", "B g=g2,g1", "C g=g2,g1", "D"],
        Some("g1"),
        &[(fwd, &["B", "C", "A", "D"]), (fwd, &["B", "C", "A", "D"])],
    );
    assert_zindex(
        &["A s g=g2,g1", "B s g=g2,g1", "C g=g1", "D"],
        Some("g1"),
        &[(fwd, &["C", "A", "B", "D"]), (fwd, &["C", "A", "B", "D"])],
    );
    assert_zindex(
        &["A s g=g2", "B s g=g2", "C g=g1", "D g=g2", "E g=g1"],
        Some("g2"),
        &[
            (fwd, &["C", "D", "A", "B", "E"]),
            (fwd, &["C", "D", "A", "B", "E"]),
        ],
    );
    assert_zindex(
        &["A s g=g2", "B", "C s g=g2", "D g=g1", "E g=g2", "F g=g1"],
        Some("g2"),
        &[
            (fwd, &["B", "D", "E", "A", "C", "F"]),
            (fwd, &["B", "D", "E", "A", "C", "F"]),
        ],
    );
}

// bring to front
#[test]
fn zindex_bring_to_front() {
    assert_zindex(
        &["0", "A s", "B d", "C d", "D", "E s", "F d", "G"],
        None,
        &[
            (to_front, &["0", "B", "C", "D", "F", "G", "A", "E"]),
            (to_front, &["0", "B", "C", "D", "F", "G", "A", "E"]),
        ],
    );
    assert_zindex(
        &["A s", "B s", "C s"],
        None,
        &[(to_front, &["A", "B", "C"])],
    );
    assert_zindex(&["A", "B s", "C s"], None, &[(to_front, &["A", "B", "C"])]);
    assert_zindex(
        &["A s", "B s", "C"],
        None,
        &[(to_front, &["C", "A", "B"]), (to_front, &["C", "A", "B"])],
    );
    assert_zindex(
        &[
            "A",
            "B g=g1",
            "C s g=g1",
            "D g=g1",
            "E s g=g1",
            "F g=g2,g1",
            "G g=g2,g1",
            "H g=g3,g1",
            "I g=g3,g1",
        ],
        Some("g1"),
        &[
            (to_front, &["A", "B", "D", "F", "G", "H", "I", "C", "E"]),
            (to_front, &["A", "B", "D", "F", "G", "H", "I", "C", "E"]),
        ],
    );
    assert_zindex(
        &["A", "B s g=g2,g1", "D g=g2,g1", "C g=g1"],
        Some("g2"),
        &[
            (to_front, &["A", "D", "B", "C"]),
            (to_front, &["A", "D", "B", "C"]),
        ],
    );
    assert_zindex(
        &["A s g=g2,g3", "B g=g1,g3", "C g=g2,g3", "D g=g1,g3"],
        Some("g2"),
        &[
            (to_front, &["B", "C", "A", "D"]),
            (to_front, &["B", "C", "A", "D"]),
        ],
    );
    assert_zindex(
        &["A s g=g2", "B g=g1", "C g=g2", "D g=g1"],
        Some("g2"),
        &[
            (to_front, &["B", "C", "A", "D"]),
            (to_front, &["B", "C", "A", "D"]),
        ],
    );
}

// send to back
#[test]
fn zindex_send_to_back() {
    assert_zindex(
        &["A", "B d", "C", "D d", "E s", "F d", "G", "H s", "I"],
        None,
        &[
            (to_back, &["E", "H", "A", "B", "C", "D", "F", "G", "I"]),
            (to_back, &["E", "H", "A", "B", "C", "D", "F", "G", "I"]),
        ],
    );
    assert_zindex(&["A s", "B s", "C s"], None, &[(to_back, &["A", "B", "C"])]);
    assert_zindex(&["A s", "B s", "C"], None, &[(to_back, &["A", "B", "C"])]);
    assert_zindex(
        &["A", "B s", "C s"],
        None,
        &[(to_back, &["B", "C", "A"]), (to_back, &["B", "C", "A"])],
    );
    assert_zindex(
        &[
            "A",
            "B g=g2,g1",
            "C g=g2,g1",
            "D g=g3,g1",
            "E g=g3,g1",
            "F s g=g1",
            "G g=g1",
            "H s g=g1",
            "I g=g1",
        ],
        Some("g1"),
        &[
            (to_back, &["A", "F", "H", "B", "C", "D", "E", "G", "I"]),
            (to_back, &["A", "F", "H", "B", "C", "D", "E", "G", "I"]),
        ],
    );
    assert_zindex(
        &["A", "B g=g1", "C g=g2,g1", "D s g=g2,g1"],
        Some("g2"),
        &[
            (to_back, &["A", "B", "D", "C"]),
            (to_back, &["A", "B", "D", "C"]),
        ],
    );
    assert_zindex(
        &["A g=g1,g3", "B g=g2,g3", "C g=g1,g3", "D s g=g2,g3"],
        Some("g2"),
        &[
            (to_back, &["A", "D", "B", "C"]),
            (to_back, &["A", "D", "B", "C"]),
        ],
    );
    assert_zindex(
        &["A g=g1", "B g=g2", "C g=g1", "D s g=g2"],
        Some("g2"),
        &[
            (to_back, &["A", "D", "B", "C"]),
            (to_back, &["A", "D", "B", "C"]),
        ],
    );
}

// text-container binding should be atomic
#[test]
fn zindex_text_container_binding_should_be_atomic() {
    assert_zindex(
        &["A s", "B", "C c=B"],
        None,
        &[(fwd, &["B", "C", "A"]), (back, &["A", "B", "C"])],
    );
    assert_zindex(
        &["A", "B s", "C c=B"],
        None,
        &[(back, &["B", "C", "A"]), (fwd, &["A", "B", "C"])],
    );
    assert_zindex(
        &["A s g=g1", "B g=g1", "C g=g1 c=B"],
        Some("g1"),
        &[(fwd, &["B", "C", "A"]), (back, &["A", "B", "C"])],
    );
    assert_zindex(
        &["A g=g1", "B s g=g1", "C g=g1 c=B"],
        Some("g1"),
        &[(back, &["B", "C", "A"]), (fwd, &["A", "B", "C"])],
    );
    assert_zindex(
        &["A g=g1", "B s g=g1", "C", "D c=C"],
        Some("g1"),
        &[(fwd, &["A", "B", "C", "D"])],
    );
}

// moving whole frame by one (normalized)
#[test]
fn zindex_moving_whole_frame_by_one_normalized() {
    assert_zindex(
        &["F1_1 f=F1", "F1_2 f=F1", "F1 s t=frame", "R1", "R2"],
        None,
        &[
            (fwd, &["R1", "F1_1", "F1_2", "F1", "R2"]),
            (fwd, &["R1", "R2", "F1_1", "F1_2", "F1"]),
            (fwd, &["R1", "R2", "F1_1", "F1_2", "F1"]),
            (back, &["R1", "F1_1", "F1_2", "F1", "R2"]),
            (back, &["F1_1", "F1_2", "F1", "R1", "R2"]),
            (back, &["F1_1", "F1_2", "F1", "R1", "R2"]),
        ],
    );
}

// moving whole frame by one (DENORMALIZED)
#[test]
fn zindex_moving_whole_frame_by_one_denormalized() {
    assert_zindex(
        &["F1_1 f=F1", "F1 s t=frame", "F1_2 f=F1", "R1", "R2"],
        None,
        &[
            (fwd, &["R1", "F1_1", "F1", "F1_2", "R2"]),
            (fwd, &["R1", "R2", "F1_1", "F1", "F1_2"]),
            (fwd, &["R1", "R2", "F1_1", "F1", "F1_2"]),
        ],
    );
    assert_zindex(
        &["F1_1 f=F1", "F1 s t=frame", "R1", "F1_2 f=F1", "R2"],
        None,
        &[
            (fwd, &["R1", "F1_1", "F1", "R2", "F1_2"]),
            (fwd, &["R1", "R2", "F1_1", "F1", "F1_2"]),
            (fwd, &["R1", "R2", "F1_1", "F1", "F1_2"]),
        ],
    );
    assert_zindex(
        &["F1_1 f=F1", "R1", "F1 s t=frame", "R2", "F1_2 f=F1", "R3"],
        None,
        &[
            (fwd, &["R1", "F1_1", "R2", "F1", "R3", "F1_2"]),
            (fwd, &["R1", "R2", "F1_1", "R3", "F1", "F1_2"]),
            (fwd, &["R1", "R2", "R3", "F1_1", "F1", "F1_2"]),
        ],
    );
    assert_zindex(
        &["F1_1 f=F1", "R1", "F1 s t=frame", "R2", "F1_2 f=F1", "R3"],
        None,
        &[
            (back, &["F1_1", "F1", "R1", "F1_2", "R2", "R3"]),
            (back, &["F1_1", "F1", "F1_2", "R1", "R2", "R3"]),
        ],
    );
}

// moving selected frame children by one (normalized)
#[test]
fn zindex_moving_selected_frame_children_by_one_normalized() {
    assert_zindex(
        &["F1_1 s f=F1", "F1_2 f=F1", "F1 t=frame", "R1"],
        None,
        &[
            (fwd, &["F1_2", "F1_1", "F1", "R1"]),
            (fwd, &["F1_2", "F1_1", "F1", "R1"]),
        ],
    );
    assert_zindex(
        &[
            "F1_1 s f=F1",
            "F1_2 f=F1",
            "F1 t=frame",
            "R1",
            "F2_1 s f=F2",
            "F2_2 f=F2",
            "F2 t=frame",
            "R2",
        ],
        None,
        &[
            (
                fwd,
                &["F1_2", "F1_1", "F1", "R1", "F2_2", "F2_1", "F2", "R2"],
            ),
            (
                fwd,
                &["F1_2", "F1_1", "F1", "R1", "F2_2", "F2_1", "F2", "R2"],
            ),
        ],
    );
}

// moving selected frame children by one (DENORMALIZED)
#[test]
fn zindex_moving_selected_frame_children_by_one_denormalized() {
    assert_zindex(
        &["F1_1 s f=F1", "F1 t=frame", "F1_2 f=F1", "R1"],
        None,
        &[
            (fwd, &["F1", "F1_2", "F1_1", "R1"]),
            (fwd, &["F1", "F1_2", "F1_1", "R1"]),
            (back, &["F1", "F1_1", "F1_2", "R1"]),
            (back, &["F1", "F1_1", "F1_2", "R1"]),
        ],
    );
    assert_zindex(
        &["F1_1 s f=F1", "R1", "F1 t=frame", "F1_2 f=F1", "R2"],
        None,
        &[
            (fwd, &["R1", "F1", "F1_2", "F1_1", "R2"]),
            (fwd, &["R1", "F1", "F1_2", "F1_1", "R2"]),
            (back, &["R1", "F1", "F1_1", "F1_2", "R2"]),
            (back, &["R1", "F1", "F1_1", "F1_2", "R2"]),
        ],
    );
}

// moving whole frame to front/end
#[test]
fn zindex_moving_whole_frame_to_front_end() {
    assert_zindex(
        &["F1_1 f=F1", "F1_2 f=F1", "F1 s t=frame", "R1", "R2"],
        None,
        &[
            (to_front, &["R1", "R2", "F1_1", "F1_2", "F1"]),
            (to_front, &["R1", "R2", "F1_1", "F1_2", "F1"]),
            (to_back, &["F1_1", "F1_2", "F1", "R1", "R2"]),
            (to_back, &["F1_1", "F1_2", "F1", "R1", "R2"]),
        ],
    );
    assert_zindex(
        &["F1_1 f=F1", "F1 s t=frame", "F1_2 f=F1", "R1", "R2"],
        None,
        &[
            (to_front, &["R1", "R2", "F1_1", "F1", "F1_2"]),
            (to_front, &["R1", "R2", "F1_1", "F1", "F1_2"]),
            (to_back, &["F1_1", "F1", "F1_2", "R1", "R2"]),
            (to_back, &["F1_1", "F1", "F1_2", "R1", "R2"]),
        ],
    );
    assert_zindex(
        &["F1_1 f=F1", "F1 s t=frame", "R1", "F1_2 f=F1", "R2"],
        None,
        &[(to_front, &["R1", "R2", "F1_1", "F1", "F1_2"])],
    );
    assert_zindex(
        &["F1_1 f=F1", "R1", "F1 s t=frame", "R2", "F1_2 f=F1", "R3"],
        None,
        &[(to_front, &["R1", "R2", "R3", "F1_1", "F1", "F1_2"])],
    );
}

// bringing to front / sending to back children of MULTIPLE frames at once moves all of them
#[test]
fn zindex_bringing_to_front_sending_to_back_children_of_multiple_frames_at_once_moves_all_of_them()
{
    assert_zindex(
        &[
            "F1_1 s f=F1",
            "F1_2 f=F1",
            "F1 t=frame",
            "F2_1 s f=F2",
            "F2_2 f=F2",
            "F2 t=frame",
        ],
        None,
        &[
            (to_front, &["F1_2", "F1", "F1_1", "F2_2", "F2", "F2_1"]),
            (to_back, &["F1_1", "F1_2", "F1", "F2_1", "F2_2", "F2"]),
        ],
    );
}

// send to back / bring to front of a grouped frame child (in group-editing mode) must not duplicate elements
#[test]
fn zindex_send_to_back_bring_to_front_of_a_grouped_frame_child_in_group_editing_mode_must_not_duplicate_elements()
 {
    assert_zindex(
        &[
            "F1_1 g=g1 f=F1",
            "F1_2 s g=g1 f=F1",
            "F1 t=frame",
            "F2_1 g=g2 f=F2",
            "F2_2 g=g2 f=F2",
            "F2 t=frame",
        ],
        Some("g1"),
        &[
            (to_back, &["F1_2", "F1_1", "F1", "F2_1", "F2_2", "F2"]),
            (to_front, &["F1_1", "F1", "F1_2", "F2_1", "F2_2", "F2"]),
        ],
    );
}

// discontiguous frame children (foreign frame's child interleaved in span)
#[test]
fn zindex_discontiguous_frame_children_foreign_frame_s_child_interleaved_in_span() {
    assert_reorder(
        &[
            "F1_1 s f=F1",
            "F2_1 f=F2",
            "F1_2 f=F1",
            "F1 t=frame",
            "F2 t=frame",
        ],
        None,
        &[
            (fwd, &["F2_1", "F1_2", "F1_1", "F1", "F2"]),
            (back, &["F1_1", "F2_1", "F1_2", "F1", "F2"]),
            (to_front, &["F2_1", "F1_2", "F1", "F1_1", "F2"]),
            (to_back, &["F1_1", "F2_1", "F1_2", "F1", "F2"]),
        ],
    );
}

// discontiguous group, whole group selected
#[test]
fn zindex_discontiguous_group_whole_group_selected() {
    assert_reorder(
        &["A s g=g1", "B", "C s g=g1", "D"],
        None,
        &[
            (fwd, &["B", "A", "D", "C"]),
            (back, &["A", "C", "B", "D"]),
            (to_front, &["B", "D", "A", "C"]),
            (to_back, &["A", "C", "B", "D"]),
        ],
    );
}

// discontiguous group, single member selected in group-editing mode
#[test]
fn zindex_discontiguous_group_single_member_selected_in_group_editing_mode() {
    assert_reorder(
        &["A g=g1", "B", "C s g=g1", "D"],
        Some("g1"),
        &[
            (fwd, &["A", "B", "C", "D"]),
            (back, &["C", "A", "B", "D"]),
            (to_front, &["A", "B", "C", "D"]),
            (to_back, &["C", "A", "B", "D"]),
        ],
    );
}

// two interleaved groups, both fully selected
#[test]
fn zindex_two_interleaved_groups_both_fully_selected() {
    assert_reorder(
        &["A s g=g1", "X s g=g2", "C s g=g1", "Y s g=g2", "Z"],
        None,
        &[
            (fwd, &["Z", "A", "X", "C", "Y"]),
            (back, &["A", "X", "C", "Y", "Z"]),
            (to_front, &["Z", "A", "X", "C", "Y"]),
            (to_back, &["A", "X", "C", "Y", "Z"]),
        ],
    );
}

// does not duplicate or drop elements when selected elements fall outside the edited group scope
#[test]
fn zindex_does_not_duplicate_or_drop_elements_when_selected_elements_fall_outside_the_edited_group_scope()
 {
    assert_zindex(
        &["A s g=g1", "C g=g1", "X g=g2", "Y g=g2", "R"],
        Some("g2"),
        &[(to_back, &["A", "C", "X", "Y", "R"])],
    );
    assert_zindex(
        &["A g=g1", "C g=g1", "X s g=g2", "Y g=g2", "R"],
        Some("g1"),
        &[(to_front, &["A", "C", "X", "Y", "R"])],
    );
}

// duplicating elements should retain zindex integrity
#[test]
fn zindex_duplicating_elements_should_retain_zindex_integrity() {
    assert_dup(&["A s", "B s"], None, None, &["A", "A'", "B", "B'"]);
    assert_dup(
        &["A g=g1 s", "B g=g1 s"],
        None,
        None,
        &["A", "B", "A'", "B'"],
    );
    assert_dup(
        &["A g=g1 s", "B g=g1 s", "C"],
        None,
        None,
        &["A", "B", "A'", "B'", "C"],
    );
    assert_dup(
        &["A g=g1 s", "B g=g1 s", "C s"],
        None,
        None,
        &["A", "B", "A'", "B'", "C", "C'"],
    );
    assert_dup(
        &["A g=g1 s", "B g=g1 s", "C g=g2 s", "D g=g2 s"],
        None,
        None,
        &["A", "B", "A'", "B'", "C", "D", "C'", "D'"],
    );
    assert_dup(
        &["A g=g1,g2 s", "B g=g1,g2 s", "C g=g2 s"],
        None,
        Some(&["g1"]),
        &["A", "B", "A'", "B'", "C", "C'"],
    );
    assert_dup(
        &["A g=g1,g2 s", "B g=g1,g2 s", "C g=g2 s"],
        None,
        Some(&["g2"]),
        &["A", "B", "C", "A'", "B'", "C'"],
    );
    assert_dup(
        &[
            "A g=g1,g2 s",
            "B g=g1,g2 s",
            "C g=g2 s",
            "D g=g3,g4 s",
            "E g=g3,g4 s",
            "F g=g4 s",
        ],
        None,
        Some(&["g2", "g4"]),
        &[
            "A", "B", "C", "A'", "B'", "C'", "D", "E", "F", "D'", "E'", "F'",
        ],
    );
    assert_dup(
        &["A g=g1,g2 s", "B g=g1,g2", "C g=g2"],
        Some("g1"),
        None,
        &["A", "A'", "B", "C"],
    );
    assert_dup(
        &["A g=g1,g2", "B g=g1,g2 s", "C g=g2"],
        Some("g1"),
        None,
        &["A", "B", "B'", "C"],
    );
    assert_dup(
        &["A g=g1,g2 s", "B g=g1,g2 s", "C g=g2"],
        Some("g1"),
        None,
        &["A", "A'", "B", "B'", "C"],
    );
}

#[test]
fn zindex_duplicating_incorrectly_interleaved_elements_should_still_produce_reasonable_result() {
    assert_dup(
        &["A g=g1 s", "B", "C g=g1 s"],
        None,
        None,
        &["A", "C", "A'", "C'", "B"],
    );
}

#[test]
fn zindex_group_selected_duplication_should_include_deleted_elements_that_werent_selected() {
    let (_, a) = populate(&["A g=g1 d", "B g=g1 s", "C g=g1 s", "D"], None);
    assert_eq!(
        a.selected_group_ids,
        BTreeMap::from([("g1".to_string(), true)])
    );
    assert_dup(
        &["A g=g1 d", "B g=g1 s", "C g=g1 s", "D"],
        None,
        None,
        &["A", "B", "C", "A'", "B'", "C'", "D"],
    );
}

// ---------------------------------------------------------------------------
// duplicate.test.tsx
// ---------------------------------------------------------------------------

fn fpb(id: &str) -> FixedPointBinding {
    FixedPointBinding {
        element_id: id.into(),
        fixed_point: [0.5, 1.],
        mode: BindMode::Orbit,
    }
}
fn bound(list: &[(&str, BoundType)]) -> Option<Vec<BoundElement>> {
    Some(
        list.iter()
            .map(|(id, k)| BoundElement {
                id: id.to_string(),
                kind: *k,
            })
            .collect(),
    )
}
fn text_in(id: &str, container: &str) -> Element {
    new_text_element(
        TextOpts {
            container_id: Some(container.into()),
            ..Default::default()
        },
        opts(id, 0., 0., 0., 0.),
        &TestMeasure,
    )
}
fn arrow_b(id: &str, start: Option<&str>, end: Option<&str>) -> Element {
    let mut a = arrow(id, 0., 0., vec![[0., 0.], [100., 100.]]);
    let l = a.linear_mut().unwrap();
    l.start_binding = start.map(fpb);
    l.end_binding = end.map(fpb);
    a
}
fn everything(els: &[Element]) -> Duplication {
    duplicate_elements(
        els,
        DuplicateMode::Everything {
            preserve_frame_children_order: false,
        },
        false,
        None,
        &NO_BINDING_HOOKS,
    )
}

#[test]
fn duplicate_preserves_created_on_a_deep_copy_and_resets_it_for_a_new_instance() {
    for created in [Some(123), Some(0), None] {
        setup();
        lattice_board_core::board::mutate::fix_timestamp(Some(5));
        let e = new_element(
            ElementType::Rectangle,
            ElementOpts {
                created: Some(created),
                ..Default::default()
            },
        );
        let cloned = e.clone();
        let d = duplicate_element(None, &mut FxHashMap::default(), &e, false);
        assert_eq!(cloned, e);
        assert_eq!(
            (d.created, d.version, d.version_nonce),
            (Some(5), e.version, e.version_nonce)
        );
        assert_ne!(d.id, e.id);
        assert_eq!(e.created, created);
    }
}

#[test]
fn duplicate_clones_arrow_element() {
    setup();
    let mut e = new_arrow_element(
        ElementOpts {
            stroke_color: "#000000".into(),
            background_color: "transparent".into(),
            fill_style: FillStyle::Hachure,
            stroke_width: 1.,
            roundness: Some(Roundness {
                kind: roundness::PROPORTIONAL_RADIUS,
                value: None,
            }),
            roughness: 1.,
            opacity: 100.,
            ..Default::default()
        },
        vec![[0., 0.]],
        None,
        Some(Arrowhead::Arrow),
        false,
        None,
    );
    lattice_board_core::board::mutate::mutate_element(&mut e, |e| {
        *e.points_mut().unwrap() = vec![[1., 2.], [3., 4.]]
    });
    let copy = duplicate_element(None, &mut FxHashMap::default(), &e, true);
    assert_ne!(copy.id, e.id);
    assert_ne!(copy.seed, e.seed);
    let expected = Element {
        id: copy.id.clone(),
        seed: copy.seed,
        version: copy.version,
        version_nonce: copy.version_nonce,
        ..e.clone()
    };
    assert_eq!(copy, expected);
}

#[test]
fn duplicate_clones_text_element() {
    setup();
    let e = new_text_element(
        TextOpts {
            text: "hello".into(),
            font_size: Some(20.),
            font_family: Some(1),
            text_align: Some(TextAlign::Left),
            vertical_align: Some(VerticalAlign::Top),
            ..Default::default()
        },
        ElementOpts {
            stroke_color: "#000000".into(),
            fill_style: FillStyle::Hachure,
            stroke_width: 1.,
            roughness: 1.,
            opacity: 100.,
            ..Default::default()
        },
        &TestMeasure,
    );
    let copy = duplicate_element(None, &mut FxHashMap::default(), &e, false);
    assert!(copy.points().is_none());
    assert_ne!(copy.id, e.id);
    assert_eq!(copy.text(), e.text());
}

#[test]
fn duplicate_elements_should_clone_bindings() {
    setup();
    let mut r1 = rect("rectangle1", 0., 0., 100., 100.);
    r1.bound_elements = bound(&[
        ("arrow1", BoundType::Arrow),
        ("arrow2", BoundType::Arrow),
        ("text1", BoundType::Text),
    ]);
    let t1 = text_in("text1", "rectangle1");
    let a1 = arrow_b("arrow1", Some("rectangle1"), None);
    let mut a2 = arrow_b("arrow2", None, Some("rectangle1"));
    a2.bound_elements = bound(&[("text2", BoundType::Text)]);
    let t2 = text_in("text2", "arrow2");
    let orig = vec![r1, t1, a1, a2, t2];
    let d = everything(&orig).duplicated_elements;
    assert_eq!(
        orig.iter().map(|e| e.ty()).collect::<Vec<_>>(),
        d.iter().map(|e| e.ty()).collect::<Vec<_>>()
    );
    for (o, c) in orig.iter().zip(&d) {
        assert_ne!(o.id, c.id);
        if let Some(oc) = o.container_id() {
            assert_ne!(Some(oc), c.container_id());
        }
        if let (Some(ol), Some(cl)) = (o.linear(), c.linear()) {
            match &ol.end_binding {
                Some(b) => assert_ne!(
                    Some(&b.element_id),
                    cl.end_binding.as_ref().map(|b| &b.element_id)
                ),
                None => assert!(cl.end_binding.is_none()),
            }
            match &ol.start_binding {
                Some(b) => assert_ne!(
                    Some(&b.element_id),
                    cl.start_binding.as_ref().map(|b| &b.element_id)
                ),
                None => assert!(cl.start_binding.is_none()),
            }
        }
    }
    let (cr, ct1, ca2, cl) = (&d[0], &d[1], &d[3], &d[4]);
    assert_eq!(ct1.container_id(), Some(cr.id.as_str()));
    assert!(
        cr.bound_elements
            .as_ref()
            .unwrap()
            .iter()
            .any(|b| b.id == ct1.id && b.kind == BoundType::Text)
    );
    for a in d.iter().filter(|e| e.is_arrow()) {
        assert!(
            cr.bound_elements
                .as_ref()
                .unwrap()
                .iter()
                .any(|b| b.id == a.id && b.kind == BoundType::Arrow)
        );
        let l = a.linear().unwrap();
        if let Some(b) = &l.end_binding {
            assert_eq!(b.element_id, cr.id);
        }
        if let Some(b) = &l.start_binding {
            assert_eq!(b.element_id, cr.id);
        }
    }
    assert_eq!(ca2.bound_elements, bound(&[(&cl.id, BoundType::Text)]));
    assert_eq!(cl.container_id(), Some(ca2.id.as_str()));
}

#[test]
fn duplicate_should_remove_id_references_of_elements_that_arent_found() {
    setup();
    let mut r1 = rect("rectangle1", 0., 0., 100., 100.);
    r1.bound_elements = bound(&[
        ("arrow1", BoundType::Arrow),
        ("arrow-not-exists", BoundType::Arrow),
        ("text-not-exists", BoundType::Text),
    ]);
    let t1 = text_in("text1", "rectangle-not-exists");
    let a1 = arrow_b("arrow1", Some("rectangle1"), None);
    let a2 = arrow_b("arrow2", Some("rectangle1"), Some("rectangle-not-exists"));
    let a3 = arrow_b("arrow3", Some("rectangle-not-exists"), Some("rectangle1"));
    let d = everything(&[r1, t1, a1, a2, a3]).duplicated_elements;
    let (cr, ct1, ca1, ca2, ca3) = (&d[0], &d[1], &d[2], &d[3], &d[4]);
    assert_eq!(cr.bound_elements, bound(&[(&ca1.id, BoundType::Arrow)]));
    assert_eq!(ct1.container_id(), None);
    assert_eq!(ca2.linear().unwrap().start_binding, Some(fpb(&cr.id)));
    assert_eq!(ca2.linear().unwrap().end_binding, None);
    assert_eq!(ca3.linear().unwrap().start_binding, None);
    assert_eq!(ca3.linear().unwrap().end_binding, Some(fpb(&cr.id)));
}

#[test]
fn duplicate_should_regenerate_all_group_ids_and_keep_them_consistent_across_elements() {
    setup();
    let g = |ids: &[&str], id: &str| {
        let mut r = rect(id, 0., 0., 10., 10.);
        r.group_ids = ids.iter().map(|s| s.to_string()).collect();
        r
    };
    let (r1, r2, r3) = (
        g(&["g1"], "r1"),
        g(&["g2", "g1"], "r2"),
        g(&["g2", "g1"], "r3"),
    );
    let d = everything(&[r1.clone(), r2.clone(), r3]).duplicated_elements;
    assert_ne!(r1.group_ids[0], d[0].group_ids[0]);
    assert_ne!(r2.group_ids[0], d[1].group_ids[0]);
    assert_ne!(r2.group_ids[1], d[1].group_ids[1]);
    assert_eq!(d[0].group_ids[0], d[1].group_ids[1]);
    assert_eq!(d[1].group_ids[0], d[2].group_ids[0]);
    assert_eq!(d[1].group_ids[1], d[2].group_ids[1]);
}

#[test]
fn duplicate_should_keep_and_regenerate_ids_of_groups_even_if_invalid() {
    setup();
    let mut r1 = rect("r1", 0., 0., 10., 10.);
    r1.group_ids = vec!["g1".into()];
    let d = everything(std::slice::from_ref(&r1)).duplicated_elements;
    assert_eq!(d[0].group_ids.len(), 1);
    assert_ne!(r1.group_ids[0], d[0].group_ids[0]);
}

#[test]
fn duplicate_action_duplicating_within_group() {
    setup();
    track_orig_ids(true);
    let mut r1 = rect("r1", 0., 0., 100., 100.);
    let mut r2 = rect("r2", 10., 10., 100., 100.);
    r1.group_ids = vec!["group1".into()];
    r2.group_ids = vec!["group1".into()];
    let mut els = vec![r1, r2];
    sync_invalid_indices(&mut els);
    let a = AppState {
        selected_element_ids: BTreeSet::from(["r2".to_string()]),
        editing_group_id: Some("group1".into()),
        ..Default::default()
    };
    let r = dup(&els, &a);
    let (next, app) = (r.elements.unwrap(), r.app_state.unwrap());
    assert_eq!(ids(&next), ["r1", "r2", "r2'"]);
    assert_eq!(
        app.selected_element_ids,
        BTreeSet::from([next[2].id.clone()])
    );
    assert_eq!(next[2].group_ids, ["group1"]);
    assert_eq!(app.editing_group_id.as_deref(), Some("group1"));
    track_orig_ids(false);
}

fn dup_z_order(selected: &str, expected: &[&str]) {
    setup();
    track_orig_ids(true);
    let mut els = vec![
        rect("r1", 0., 0., 100., 100.),
        rect("r2", 10., 10., 100., 100.),
        rect("r3", 20., 20., 100., 100.),
    ];
    sync_invalid_indices(&mut els);
    let a = AppState {
        selected_element_ids: BTreeSet::from([selected.to_string()]),
        ..Default::default()
    };
    let r = dup(&els, &a);
    let (next, app) = (r.elements.unwrap(), r.app_state.unwrap());
    assert_eq!(ids(&next), expected);
    let clone = next
        .iter()
        .find(|e| get_orig_id(&e.id).as_deref() == Some(selected))
        .unwrap();
    assert_eq!(app.selected_element_ids, BTreeSet::from([clone.id.clone()]));
    // offset by half a grid cell
    let orig = els.iter().find(|e| e.id == selected).unwrap();
    assert_eq!((clone.x, clone.y), (orig.x + 10., orig.y + 10.));
    track_orig_ids(false);
}

#[test]
fn duplication_z_order_with_cmd_d_for_the_lowest_z_ordered_element_should_be_plus_1_for_the_clone()
{
    dup_z_order("r1", &["r1", "r1'", "r2", "r3"]);
}
#[test]
fn duplication_z_order_with_cmd_d_for_the_highest_z_ordered_element_should_be_plus_1_for_the_clone()
{
    dup_z_order("r3", &["r1", "r2", "r3", "r3'"]);
}

// ---------------------------------------------------------------------------
// align.test.tsx
// ---------------------------------------------------------------------------

type AlignOp = fn(&[Element], &AppState, &dyn BindingHooks) -> ActionResult;

fn scene(
    rects: &[(&str, f64, f64, f64, &[&str])],
    selected: &[&str],
    selected_groups: &[&str],
    editing: Option<&str>,
) -> (Vec<Element>, AppState) {
    setup();
    let mut els: Vec<Element> = rects
        .iter()
        .map(|&(id, x, y, s, g)| {
            let mut r = rect(id, x, y, s, s);
            r.group_ids = g.iter().map(|s| s.to_string()).collect();
            r
        })
        .collect();
    sync_invalid_indices(&mut els);
    let a = AppState {
        selected_element_ids: selected.iter().map(|s| s.to_string()).collect(),
        selected_group_ids: selected_groups
            .iter()
            .map(|g| (g.to_string(), true))
            .collect(),
        editing_group_id: editing.map(String::from),
        ..Default::default()
    };
    (els, a)
}
fn create_and_select_two_rectangles() -> (Vec<Element>, AppState) {
    scene(
        &[("r1", 0., 0., 100., &[]), ("r2", 110., 110., 100., &[])],
        &["r1", "r2"],
        &[],
        None,
    )
}
fn create_and_select_two_rectangles_with_different_sizes() -> (Vec<Element>, AppState) {
    scene(
        &[("r1", 0., 0., 100., &[]), ("r2", 110., 110., 110., &[])],
        &["r1", "r2"],
        &[],
        None,
    )
}
fn create_and_select_group_and_rectangle() -> (Vec<Element>, AppState) {
    scene(
        &[
            ("r1", 0., 0., 100., &["A"]),
            ("r2", 100., 100., 100., &["A"]),
            ("r3", 200., 200., 100., &[]),
        ],
        &["r1", "r2", "r3"],
        &["A"],
        None,
    )
}
fn create_and_select_two_groups() -> (Vec<Element>, AppState) {
    scene(
        &[
            ("r1", 0., 0., 100., &["A"]),
            ("r2", 100., 100., 100., &["A"]),
            ("r3", 200., 200., 100., &["B"]),
            ("r4", 300., 300., 100., &["B"]),
        ],
        &["r1", "r2", "r3", "r4"],
        &["A", "B"],
        None,
    )
}
fn create_and_select_nested_group_and_rectangle() -> (Vec<Element>, AppState) {
    scene(
        &[
            ("r1", 0., 0., 100., &["A", "B"]),
            ("r2", 100., 100., 100., &["A", "B"]),
            ("r3", 200., 200., 100., &["B"]),
            ("r4", 300., 300., 100., &[]),
        ],
        &["r1", "r2", "r3", "r4"],
        &["B"],
        None,
    )
}
fn create_group_and_select_in_edit_group_mode() -> (Vec<Element>, AppState) {
    scene(
        &[
            ("r1", 0., 0., 100., &["A"]),
            ("r2", 100., 100., 100., &["A"]),
        ],
        &["r1", "r2"],
        &[],
        Some("A"),
    )
}
fn create_nested_group_and_select_in_edit_group_mode() -> (Vec<Element>, AppState) {
    scene(
        &[
            ("r1", 0., 0., 100., &["A", "B"]),
            ("r2", 100., 100., 100., &["A", "B"]),
            ("r3", 200., 200., 100., &["B"]),
        ],
        &["r1", "r2", "r3"],
        &["A"],
        Some("B"),
    )
}
fn create_and_select_single_group() -> (Vec<Element>, AppState) {
    scene(
        &[
            ("r1", 0., 0., 100., &["A"]),
            ("r2", 100., 100., 100., &["A"]),
        ],
        &["r1", "r2"],
        &["A"],
        None,
    )
}
fn create_and_select_single_group_with_nested_group() -> (Vec<Element>, AppState) {
    scene(
        &[
            ("r1", 0., 0., 100., &["A", "B"]),
            ("r2", 100., 100., 100., &["A", "B"]),
            ("r3", 200., 200., 100., &["B"]),
        ],
        &["r1", "r2", "r3"],
        &["B"],
        None,
    )
}

fn check_align(
    setup: fn() -> (Vec<Element>, AppState),
    op: AlignOp,
    expected: &[(usize, char, f64)],
) {
    let (els, a) = setup();
    let next = op(&els, &a, &NO_BINDING_HOOKS).elements.unwrap();
    let sel = get_selected_elements(&next, &a.selected_element_ids, SelectedOpts::default());
    for &(i, axis, v) in expected {
        assert_eq!(
            if axis == 'x' { sel[i].x } else { sel[i].y },
            v,
            "selected[{i}].{axis}"
        );
    }
}

#[test]
fn aligns_two_objects_correctly_to_the_top() {
    check_align(
        create_and_select_two_rectangles,
        action_align_top,
        &[(0, 'x', 0.), (1, 'x', 110.), (0, 'y', 0.), (1, 'y', 0.)],
    );
}
#[test]
fn aligns_two_objects_correctly_to_the_bottom() {
    check_align(
        create_and_select_two_rectangles,
        action_align_bottom,
        &[(0, 'x', 0.), (1, 'x', 110.), (0, 'y', 110.), (1, 'y', 110.)],
    );
}
#[test]
fn aligns_two_objects_correctly_to_the_left() {
    check_align(
        create_and_select_two_rectangles,
        action_align_left,
        &[(0, 'x', 0.), (1, 'x', 0.), (0, 'y', 0.), (1, 'y', 110.)],
    );
}
#[test]
fn aligns_two_objects_correctly_to_the_right() {
    check_align(
        create_and_select_two_rectangles,
        action_align_right,
        &[(0, 'x', 110.), (1, 'x', 110.), (0, 'y', 0.), (1, 'y', 110.)],
    );
}
#[test]
fn centers_two_objects_with_different_sizes_correctly_vertically() {
    check_align(
        create_and_select_two_rectangles_with_different_sizes,
        action_align_vertically_centered,
        &[(0, 'x', 0.), (1, 'x', 110.), (0, 'y', 60.), (1, 'y', 55.)],
    );
}
#[test]
fn centers_two_objects_with_different_sizes_correctly_horizontally() {
    check_align(
        create_and_select_two_rectangles_with_different_sizes,
        action_align_horizontally_centered,
        &[(0, 'x', 60.), (1, 'x', 55.), (0, 'y', 0.), (1, 'y', 110.)],
    );
}
#[test]
fn aligns_a_group_with_another_element_correctly_to_the_top() {
    check_align(
        create_and_select_group_and_rectangle,
        action_align_top,
        &[(0, 'y', 0.), (1, 'y', 100.), (2, 'y', 0.)],
    );
}
#[test]
fn aligns_a_group_with_another_element_correctly_to_the_bottom() {
    check_align(
        create_and_select_group_and_rectangle,
        action_align_bottom,
        &[(0, 'y', 100.), (1, 'y', 200.), (2, 'y', 200.)],
    );
}
#[test]
fn aligns_a_group_with_another_element_correctly_to_the_left() {
    check_align(
        create_and_select_group_and_rectangle,
        action_align_left,
        &[(0, 'x', 0.), (1, 'x', 100.), (2, 'x', 0.)],
    );
}
#[test]
fn aligns_a_group_with_another_element_correctly_to_the_right() {
    check_align(
        create_and_select_group_and_rectangle,
        action_align_right,
        &[(0, 'x', 100.), (1, 'x', 200.), (2, 'x', 200.)],
    );
}
#[test]
fn centers_a_group_with_another_element_correctly_vertically() {
    check_align(
        create_and_select_group_and_rectangle,
        action_align_vertically_centered,
        &[(0, 'y', 50.), (1, 'y', 150.), (2, 'y', 100.)],
    );
}
#[test]
fn centers_a_group_with_another_element_correctly_horizontally() {
    check_align(
        create_and_select_group_and_rectangle,
        action_align_horizontally_centered,
        &[(0, 'x', 50.), (1, 'x', 150.), (2, 'x', 100.)],
    );
}
#[test]
fn aligns_two_groups_correctly_to_the_top() {
    check_align(
        create_and_select_two_groups,
        action_align_top,
        &[(0, 'y', 0.), (1, 'y', 100.), (2, 'y', 0.), (3, 'y', 100.)],
    );
}
#[test]
fn aligns_two_groups_correctly_to_the_bottom() {
    check_align(
        create_and_select_two_groups,
        action_align_bottom,
        &[
            (0, 'y', 200.),
            (1, 'y', 300.),
            (2, 'y', 200.),
            (3, 'y', 300.),
        ],
    );
}
#[test]
fn aligns_two_groups_correctly_to_the_left() {
    check_align(
        create_and_select_two_groups,
        action_align_left,
        &[(0, 'x', 0.), (1, 'x', 100.), (2, 'x', 0.), (3, 'x', 100.)],
    );
}
#[test]
fn aligns_two_groups_correctly_to_the_right() {
    check_align(
        create_and_select_two_groups,
        action_align_right,
        &[
            (0, 'x', 200.),
            (1, 'x', 300.),
            (2, 'x', 200.),
            (3, 'x', 300.),
        ],
    );
}
#[test]
fn centers_two_groups_correctly_vertically() {
    check_align(
        create_and_select_two_groups,
        action_align_vertically_centered,
        &[
            (0, 'y', 100.),
            (1, 'y', 200.),
            (2, 'y', 100.),
            (3, 'y', 200.),
        ],
    );
}
#[test]
fn centers_two_groups_correctly_horizontally() {
    check_align(
        create_and_select_two_groups,
        action_align_horizontally_centered,
        &[
            (0, 'x', 100.),
            (1, 'x', 200.),
            (2, 'x', 100.),
            (3, 'x', 200.),
        ],
    );
}
#[test]
fn aligns_nested_group_and_other_element_correctly_to_the_top() {
    check_align(
        create_and_select_nested_group_and_rectangle,
        action_align_top,
        &[(0, 'y', 0.), (1, 'y', 100.), (2, 'y', 200.), (3, 'y', 0.)],
    );
}
#[test]
fn aligns_nested_group_and_other_element_correctly_to_the_bottom() {
    check_align(
        create_and_select_nested_group_and_rectangle,
        action_align_bottom,
        &[
            (0, 'y', 100.),
            (1, 'y', 200.),
            (2, 'y', 300.),
            (3, 'y', 300.),
        ],
    );
}
#[test]
fn aligns_nested_group_and_other_element_correctly_to_the_left() {
    check_align(
        create_and_select_nested_group_and_rectangle,
        action_align_left,
        &[(0, 'x', 0.), (1, 'x', 100.), (2, 'x', 200.), (3, 'x', 0.)],
    );
}
#[test]
fn aligns_nested_group_and_other_element_correctly_to_the_right() {
    check_align(
        create_and_select_nested_group_and_rectangle,
        action_align_right,
        &[
            (0, 'x', 100.),
            (1, 'x', 200.),
            (2, 'x', 300.),
            (3, 'x', 300.),
        ],
    );
}
#[test]
fn centers_nested_group_and_other_element_correctly_vertically() {
    check_align(
        create_and_select_nested_group_and_rectangle,
        action_align_vertically_centered,
        &[
            (0, 'y', 50.),
            (1, 'y', 150.),
            (2, 'y', 250.),
            (3, 'y', 150.),
        ],
    );
}
#[test]
fn centers_nested_group_and_other_element_correctly_horizontally() {
    check_align(
        create_and_select_nested_group_and_rectangle,
        action_align_horizontally_centered,
        &[
            (0, 'x', 50.),
            (1, 'x', 150.),
            (2, 'x', 250.),
            (3, 'x', 150.),
        ],
    );
}
#[test]
fn aligns_elements_within_a_group_while_in_group_edit_mode_correctly_to_the_top() {
    check_align(
        create_group_and_select_in_edit_group_mode,
        action_align_top,
        &[(0, 'y', 0.), (1, 'y', 0.)],
    );
}
#[test]
fn aligns_elements_within_a_group_while_in_group_edit_mode_correctly_to_the_bottom() {
    check_align(
        create_group_and_select_in_edit_group_mode,
        action_align_bottom,
        &[(0, 'y', 100.), (1, 'y', 100.)],
    );
}
#[test]
fn aligns_elements_within_a_group_while_in_group_edit_mode_correctly_to_the_left() {
    check_align(
        create_group_and_select_in_edit_group_mode,
        action_align_left,
        &[(0, 'x', 0.), (1, 'x', 0.)],
    );
}
#[test]
fn aligns_elements_within_a_group_while_in_group_edit_mode_correctly_to_the_right() {
    check_align(
        create_group_and_select_in_edit_group_mode,
        action_align_right,
        &[(0, 'x', 100.), (1, 'x', 100.)],
    );
}
#[test]
fn aligns_elements_within_a_group_while_in_group_edit_mode_correctly_to_the_vertical_center() {
    check_align(
        create_group_and_select_in_edit_group_mode,
        action_align_vertically_centered,
        &[(0, 'y', 50.), (1, 'y', 50.)],
    );
}
#[test]
fn aligns_elements_within_a_group_while_in_group_edit_mode_correctly_to_the_horizontal_center() {
    check_align(
        create_group_and_select_in_edit_group_mode,
        action_align_horizontally_centered,
        &[(0, 'x', 50.), (1, 'x', 50.)],
    );
}
#[test]
fn aligns_element_and_nested_group_while_in_group_edit_mode_correctly_to_the_top() {
    check_align(
        create_nested_group_and_select_in_edit_group_mode,
        action_align_top,
        &[(0, 'y', 0.), (1, 'y', 100.), (2, 'y', 0.)],
    );
}
#[test]
fn aligns_element_and_nested_group_while_in_group_edit_mode_correctly_to_the_bottom() {
    check_align(
        create_nested_group_and_select_in_edit_group_mode,
        action_align_bottom,
        &[(0, 'y', 100.), (1, 'y', 200.), (2, 'y', 200.)],
    );
}
#[test]
fn aligns_element_and_nested_group_while_in_group_edit_mode_correctly_to_the_left() {
    check_align(
        create_nested_group_and_select_in_edit_group_mode,
        action_align_left,
        &[(0, 'x', 0.), (1, 'x', 100.), (2, 'x', 0.)],
    );
}
#[test]
fn aligns_element_and_nested_group_while_in_group_edit_mode_correctly_to_the_right() {
    check_align(
        create_nested_group_and_select_in_edit_group_mode,
        action_align_right,
        &[(0, 'x', 100.), (1, 'x', 200.), (2, 'x', 200.)],
    );
}
#[test]
fn aligns_element_and_nested_group_while_in_group_edit_mode_correctly_to_the_vertical_center() {
    check_align(
        create_nested_group_and_select_in_edit_group_mode,
        action_align_vertically_centered,
        &[(0, 'y', 50.), (1, 'y', 150.), (2, 'y', 100.)],
    );
}
#[test]
fn aligns_elements_and_nested_group_within_a_group_while_in_group_edit_mode_correctly_to_the_horizontal_center()
 {
    check_align(
        create_nested_group_and_select_in_edit_group_mode,
        action_align_horizontally_centered,
        &[(0, 'x', 50.), (1, 'x', 150.), (2, 'x', 100.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_correctly_to_the_top() {
    check_align(
        create_and_select_single_group,
        action_align_top,
        &[(0, 'y', 0.), (1, 'y', 0.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_correctly_to_the_bottom() {
    check_align(
        create_and_select_single_group,
        action_align_bottom,
        &[(0, 'y', 100.), (1, 'y', 100.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_correctly_to_the_left() {
    check_align(
        create_and_select_single_group,
        action_align_left,
        &[(0, 'x', 0.), (1, 'x', 0.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_correctly_to_the_right() {
    check_align(
        create_and_select_single_group,
        action_align_right,
        &[(0, 'x', 100.), (1, 'x', 100.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_correctly_to_the_vertical_center() {
    check_align(
        create_and_select_single_group,
        action_align_vertically_centered,
        &[(0, 'y', 50.), (1, 'y', 50.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_correctly_to_the_horizontal_center() {
    check_align(
        create_and_select_single_group,
        action_align_horizontally_centered,
        &[(0, 'x', 50.), (1, 'x', 50.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_containing_a_nested_group_correctly_to_the_top() {
    check_align(
        create_and_select_single_group_with_nested_group,
        action_align_top,
        &[(0, 'y', 0.), (1, 'y', 100.), (2, 'y', 0.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_containing_a_nested_group_correctly_to_the_bottom()
 {
    check_align(
        create_and_select_single_group_with_nested_group,
        action_align_bottom,
        &[(0, 'y', 100.), (1, 'y', 200.), (2, 'y', 200.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_containing_a_nested_group_correctly_to_the_left()
{
    check_align(
        create_and_select_single_group_with_nested_group,
        action_align_left,
        &[(0, 'x', 0.), (1, 'x', 100.), (2, 'x', 0.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_containing_a_nested_group_correctly_to_the_right()
{
    check_align(
        create_and_select_single_group_with_nested_group,
        action_align_right,
        &[(0, 'x', 100.), (1, 'x', 200.), (2, 'x', 200.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_containing_a_nested_group_correctly_to_the_vertical_center()
 {
    check_align(
        create_and_select_single_group_with_nested_group,
        action_align_vertically_centered,
        &[(0, 'y', 50.), (1, 'y', 150.), (2, 'y', 100.)],
    );
}
#[test]
fn aligns_elements_within_a_single_selected_group_containing_a_nested_group_correctly_to_the_horizontal_center()
 {
    check_align(
        create_and_select_single_group_with_nested_group,
        action_align_horizontally_centered,
        &[(0, 'x', 50.), (1, 'x', 150.), (2, 'x', 100.)],
    );
}

fn group_with_bound_text_and_rectangle() -> (Vec<Element>, AppState) {
    setup();
    let g = vec!["group-with-bound-text".to_string()];
    let mut container = rect("container", 100., 100., 100., 100.);
    container.group_ids = g.clone();
    container.bound_elements = bound(&[("bound-text", BoundType::Text)]);
    let mut t = text_in("bound-text", "container");
    (t.x, t.y, t.width, t.height, t.group_ids) = (120., 140., 60., 20., g.clone());
    let mut gr = rect("grouped-rectangle", 100., 200., 100., 100.);
    gr.group_ids = g;
    let mut els = vec![
        container,
        t,
        gr,
        rect("standalone-rectangle", 0., 0., 100., 100.),
    ];
    sync_invalid_indices(&mut els);
    let mut a = AppState::default();
    // `API.setSelectedElements` selects the groups too
    a.selected_element_ids = ["container", "grouped-rectangle", "standalone-rectangle"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.selected_group_ids =
        select_groups_for_selected_elements(&a.selected_element_ids, None, &els).selected_group_ids;
    (els, a)
}
fn get<'a>(els: &'a [Element], id: &str) -> &'a Element {
    els.iter().find(|e| e.id == id).unwrap()
}

#[test]
fn keeps_a_bound_text_within_its_container_when_aligning_a_group_to_the_top() {
    let (els, a) = group_with_bound_text_and_rectangle();
    let n = action_align_top(&els, &a, &NO_BINDING_HOOKS)
        .elements
        .unwrap();
    assert_eq!(get(&n, "standalone-rectangle").y, 0.);
    assert_eq!(get(&n, "container").y, 0.);
    assert_eq!(get(&n, "grouped-rectangle").y, 100.);
    assert_eq!(
        (get(&n, "bound-text").x, get(&n, "bound-text").y),
        (120., 40.)
    );
}

#[test]
fn keeps_a_bound_text_within_its_container_when_aligning_a_group_to_the_left() {
    let (els, a) = group_with_bound_text_and_rectangle();
    let n = action_align_left(&els, &a, &NO_BINDING_HOOKS)
        .elements
        .unwrap();
    assert_eq!(get(&n, "standalone-rectangle").x, 0.);
    assert_eq!(get(&n, "container").x, 0.);
    assert_eq!(get(&n, "grouped-rectangle").x, 0.);
    assert_eq!(
        (get(&n, "bound-text").x, get(&n, "bound-text").y),
        (20., 140.)
    );
}

#[test]
fn align_predicate() {
    let (els, a) = create_and_select_single_group();
    // one group alone: by its members (single selected group case)
    assert!(align_actions_predicate(&els, &a));
    let (els, mut a) = create_and_select_two_rectangles();
    assert!(align_actions_predicate(&els, &a));
    assert!(!distribute_actions_predicate(&els, &a));
    a.selected_element_ids.remove("r2");
    assert!(!align_actions_predicate(&els, &a));
}

// ---------------------------------------------------------------------------
// distribute.test.tsx
// ---------------------------------------------------------------------------

fn three(gap: bool) -> (Vec<Element>, AppState) {
    if gap {
        scene(
            &[
                ("r1", 0., 0., 100., &[]),
                ("r2", 10., 10., 100., &[]),
                ("r3", 300., 300., 100., &[]),
            ],
            &["r1", "r2", "r3"],
            &[],
            None,
        )
    } else {
        scene(
            &[
                ("r1", 0., 0., 100., &[]),
                ("r2", 10., 10., 200., &[]),
                ("r3", 200., 200., 100., &[]),
            ],
            &["r1", "r2", "r3"],
            &[],
            None,
        )
    }
}
fn check_distribute(gap: bool, op: AlignOp, axis: char, expected: [f64; 3]) {
    let (els, a) = three(gap);
    assert!(distribute_actions_predicate(&els, &a));
    let next = op(&els, &a, &NO_BINDING_HOOKS).elements.unwrap();
    let sel = get_selected_elements(&next, &a.selected_element_ids, SelectedOpts::default());
    assert_eq!(
        sel.iter()
            .map(|e| if axis == 'x' { e.x } else { e.y })
            .collect::<Vec<_>>(),
        expected
    );
}

#[test]
fn should_distribute_selected_elements_horizontally() {
    check_distribute(true, action_distribute_horizontally, 'x', [0., 150., 300.]);
}
#[test]
fn should_distribute_selected_elements_vertically() {
    check_distribute(true, action_distribute_vertically, 'y', [0., 150., 300.]);
}
#[test]
fn should_distribute_selected_elements_horizontally_based_on_their_centers() {
    check_distribute(false, action_distribute_horizontally, 'x', [0., 50., 200.]);
}
#[test]
fn should_distribute_selected_elements_vertically_with_based_on_their_centers() {
    check_distribute(false, action_distribute_vertically, 'y', [0., 50., 200.]);
}

// ---------------------------------------------------------------------------
// positionElementsOnGrid (no upstream test; the layout math checked by hand)
// ---------------------------------------------------------------------------

#[test]
fn position_elements_on_grid_centers_rows() {
    setup();
    let els = vec![
        rect("a", 0., 0., 100., 100.),
        rect("b", 500., 500., 100., 100.),
        rect("c", -50., 0., 100., 50.),
    ];
    let out = position_each_element_on_grid(&els, 0., 0., 50.);
    // two columns: [a b] (250 wide, 100 tall), [c]; total height 100 + 50 + 50
    assert_eq!(
        out.iter().map(|e| (e.x, e.y)).collect::<Vec<_>>(),
        [(-125., -100.), (25., -100.), (-50., 50.)]
    );
}
