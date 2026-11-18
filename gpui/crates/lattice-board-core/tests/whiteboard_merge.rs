// Lattice's test of the merge it adds to quiet.md's board model.

//! An outside change to a `.excalidraw` file merged into the open board
//! (`Board::reconcile`).

use lattice_board_core::board::new_element::{ElementOpts, new_element};
use lattice_board_core::board::types::{Element, ElementType};
use lattice_board_core::whiteboard::Board;

fn rect(id: &str, x: f64, version: i64, index: &str) -> Element {
    let mut e = new_element(
        ElementType::Rectangle,
        ElementOpts {
            x,
            ..Default::default()
        },
    );
    e.id = id.into();
    e.version = version;
    e.version_nonce = 1;
    e.index = Some(index.into());
    e
}

fn board(elements: Vec<Element>) -> Board {
    Board {
        elements,
        ..Default::default()
    }
}

fn ids(v: &[Element]) -> Vec<(&str, f64)> {
    v.iter()
        .filter(|e| !e.is_deleted)
        .map(|e| (e.id.as_str(), e.x))
        .collect()
}

#[test]
fn the_later_version_of_each_element_wins() {
    let base = board(vec![rect("a", 0., 1, "a0"), rect("b", 0., 1, "a1")]);
    let local = vec![rect("a", 10., 2, "a0"), rect("b", 0., 1, "a1")];
    let remote = board(vec![rect("a", 0., 1, "a0"), rect("b", 20., 2, "a1")]);
    assert_eq!(
        ids(&Board::reconcile(&local, &base, remote)),
        [("a", 10.), ("b", 20.)]
    );
}

#[test]
fn deletions_outside_apply_and_local_additions_stay() {
    let base = board(vec![rect("a", 0., 1, "a0"), rect("b", 0., 1, "a1")]);
    let local = vec![
        rect("a", 0., 1, "a0"),
        rect("b", 0., 1, "a1"),
        rect("c", 5., 1, "a2"),
    ];
    let remote = board(vec![rect("a", 0., 1, "a0"), rect("d", 7., 1, "a3")]);
    assert_eq!(
        ids(&Board::reconcile(&local, &base, remote)),
        [("a", 0.), ("c", 5.), ("d", 7.)]
    );
}

#[test]
fn an_element_changed_here_survives_its_deletion_outside() {
    let base = board(vec![rect("a", 0., 1, "a0")]);
    let local = vec![rect("a", 3., 2, "a0")];
    assert_eq!(
        ids(&Board::reconcile(&local, &base, board(vec![]))),
        [("a", 3.)]
    );
}
