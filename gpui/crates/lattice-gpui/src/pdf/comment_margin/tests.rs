//! The Tauri app's `pdf-comment-margin.test.ts`, case for case.

use super::*;

fn card(id: &str, anchor: f32, height: f32) -> MarginCard {
    MarginCard {
        id: id.into(),
        anchor,
        height,
    }
}

fn tops(cards: &[MarginCard], active: Option<&str>, gap: f32) -> Vec<(String, f32)> {
    let mut placed: Vec<_> = cards
        .iter()
        .map(|card| card.id.clone())
        .zip(layout_margin_cards(cards, active, gap))
        .collect();
    placed.sort_by(|a, b| a.0.cmp(&b.0));
    placed
}

fn expect(pairs: &[(&str, f32)]) -> Vec<(String, f32)> {
    let mut pairs: Vec<_> = pairs
        .iter()
        .map(|(id, top)| (id.to_string(), *top))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    pairs
}

#[test]
fn stands_each_card_level_with_its_mark_when_they_have_room() {
    let cards = [card("b", 400., 60.), card("a", 120., 80.)];
    assert_eq!(
        tops(&cards, None, MARGIN_CARD_GAP),
        expect(&[("a", 120.), ("b", 400.)])
    );
}

#[test]
fn moves_a_card_down_just_clear_of_the_one_above_in_the_marks_order() {
    let cards = [
        card("a", 100., 80.),
        card("b", 120., 40.),
        card("c", 130., 40.),
        card("d", 600., 40.),
    ];
    assert_eq!(
        tops(&cards, None, 8.),
        expect(&[("a", 100.), ("b", 188.), ("c", 236.), ("d", 600.)])
    );
}

#[test]
fn keeps_the_open_card_level_moving_cards_before_it_up_and_after_it_down() {
    let cards = [
        card("a", 100., 80.),
        card("b", 120., 40.),
        card("c", 130., 40.),
    ];
    assert_eq!(
        tops(&cards, Some("b"), 8.),
        expect(&[("a", 32.), ("b", 120.), ("c", 168.)])
    );
}

#[test]
fn leaves_the_cards_before_the_open_one_when_it_is_far_below_them() {
    let cards = [
        card("a", 100., 80.),
        card("b", 110., 40.),
        card("c", 500., 40.),
    ];
    let laid = expect(&[("a", 100.), ("b", 188.), ("c", 500.)]);
    assert_eq!(tops(&cards, None, 8.), laid);
    assert_eq!(tops(&cards, Some("c"), 8.), laid);
}

#[test]
fn lays_out_from_the_top_as_usual_when_the_open_card_is_first() {
    let cards = [card("a", 100., 80.), card("b", 120., 40.)];
    assert_eq!(
        tops(&cards, Some("a"), 8.),
        expect(&[("a", 100.), ("b", 188.)])
    );
}

#[test]
fn keeps_two_marks_at_one_height_in_the_order_given() {
    let cards = [card("second", 50., 20.), card("first", 50., 20.)];
    assert_eq!(
        tops(&cards, None, 4.),
        expect(&[("second", 50.), ("first", 74.)])
    );
}
