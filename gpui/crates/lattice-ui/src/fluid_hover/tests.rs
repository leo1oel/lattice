//! The fluid hover's picking, gliding and hand-over rules.

use super::*;
use gpui::{bounds, point, size};

fn row(top: f32) -> Bounds<Pixels> {
    bounds(point(px(0.), px(top)), size(px(100.), px(28.)))
}

/// A menu: two rows, a separator's 9px (4 + 1 + 4), two rows.
fn menu() -> Vec<(usize, Bounds<Pixels>)> {
    vec![(0, row(0.)), (1, row(28.)), (2, row(65.)), (3, row(93.))]
}

#[test]
fn the_row_under_the_pointer_wins() {
    assert_eq!(
        pick(menu(), point(px(10.), px(30.)), Axis::Vertical),
        Some(1)
    );
    assert_eq!(
        pick(menu(), point(px(10.), px(64.5)), Axis::Vertical),
        Some(2)
    );
}

#[test]
fn a_hairline_gap_lights_its_neighbour_and_a_separator_does_not() {
    // 2px under row 1: within the tolerance.
    assert_eq!(
        pick(menu(), point(px(10.), px(58.)), Axis::Vertical),
        Some(1)
    );
    // The separator's middle, 4.5px from either row: dark.
    assert_eq!(pick(menu(), point(px(10.), px(60.5)), Axis::Vertical), None);
    // Beside the list: dark.
    assert_eq!(pick(menu(), point(px(120.), px(30.)), Axis::Vertical), None);
}

#[test]
fn a_strip_measures_along_its_own_axis() {
    let tabs = vec![
        (0, bounds(point(px(0.), px(0.)), size(px(80.), px(28.)))),
        (1, bounds(point(px(82.), px(0.)), size(px(80.), px(28.)))),
    ];
    assert_eq!(
        pick(tabs.clone(), point(px(81.), px(10.)), Axis::Horizontal),
        Some(1)
    );
    assert_eq!(pick(tabs, point(px(170.), px(10.)), Axis::Horizontal), None);
}

fn state_with_menu() -> FluidHoverState {
    let mut state = FluidHoverState::default();
    for (ix, bounds) in menu() {
        let section = if ix < 2 { 0 } else { 1 };
        state.record(ix, bounds, ItemKind::target().section(section));
    }
    state
}

#[test]
fn within_a_section_the_fill_glides_on_the_fast_tier() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
    state.reconcile(start, false);
    // It came onto the list: a fade in place, no travel.
    let lit = state.lit.unwrap();
    assert_eq!(lit.rect.value(start), row(0.));
    assert_eq!(lit.opacity.value(start), 0.);
    let later = start + crate::tokens::DURATION_FAST;
    state.pointer_moved(point(px(10.), px(40.)), true, false, Axis::Vertical, later);
    assert!(state.reconcile(later, false));
    let lit = state.lit.unwrap();
    assert_eq!(lit.index, 1);
    assert_eq!(
        lit.rect.value(later),
        row(0.),
        "the glide starts where the fill was"
    );
    let halfway = later + crate::tokens::DURATION_FAST / 2;
    let y = f32::from(lit.rect.value(halfway).origin.y);
    assert!(y > 0. && y < 28., "mid-glide {y}");
    assert_eq!(
        lit.rect.value(later + crate::tokens::DURATION_FAST * 2),
        row(28.)
    );
    assert!(state.leaving.is_empty(), "a glide leaves nothing behind");
}

#[test]
fn a_glide_retargeted_mid_flight_keeps_moving_instead_of_restarting() {
    let start = Instant::now();
    let mut state = FluidHoverState::default();
    for ix in 0..4 {
        state.record(ix, row(28. * ix as f32), ItemKind::target());
    }
    state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
    state.reconcile(start, false);
    let shown = start + crate::tokens::DURATION_FAST;
    state.pointer_moved(point(px(10.), px(40.)), true, false, Axis::Vertical, shown);
    state.reconcile(shown, false);
    // The pointer reaches the third row 20 ms into the glide to the second.
    let crossing = shown + Duration::from_millis(20);
    let before = state.lit.unwrap().rect.value(crossing).origin.y;
    state.pointer_moved(
        point(px(10.), px(70.)),
        true,
        false,
        Axis::Vertical,
        crossing,
    );
    state.reconcile(crossing, false);
    let lit = state.lit.unwrap();
    assert_eq!(lit.index, 2);
    assert_eq!(lit.rect.value(crossing).origin.y, before, "no jump");
    // Every frame after moves it on toward the third row, never back.
    let mut last = before;
    for frame in 1..=12 {
        let at = crossing + Duration::from_micros(8_333 * frame);
        let y = lit.rect.value(at).origin.y;
        assert!(y >= last, "frame {frame}: {y:?} after {last:?}");
        assert!(y <= px(56.) + px(0.05), "frame {frame} overshoots: {y:?}");
        last = y;
    }
    assert!(
        lit.rect.velocity(crossing).origin.y > px(0.),
        "the glide is still moving when it is retargeted"
    );
}

#[test]
fn crossing_a_separator_fades_out_and_in_instead_of_sliding() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.pointer_moved(point(px(10.), px(40.)), true, false, Axis::Vertical, start);
    state.reconcile(start, false);
    let later = start + crate::tokens::DURATION_FAST;
    state.pointer_moved(point(px(10.), px(70.)), true, false, Axis::Vertical, later);
    state.reconcile(later, false);
    let lit = state.lit.unwrap();
    assert_eq!(lit.index, 2);
    assert_eq!(lit.rect.value(later), row(65.), "placed, not travelling");
    assert_eq!(state.leaving.len(), 1);
    assert_eq!(state.leaving[0].rect, row(28.));
    // The old fill is gone after the fast exit (60 ms), before the new
    // one is fully in (80 ms).
    let exit = later + crate::tokens::DURATION_FAST_EXIT;
    state.reconcile(exit, false);
    assert!(state.leaving.is_empty());
    assert!(state.lit.unwrap().opacity.value(exit) < 1.);
}

#[test]
fn leaving_the_list_fades_the_fill_out_where_it_was() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
    state.reconcile(start, false);
    let shown = start + crate::tokens::DURATION_FAST;
    assert!(state.pointer_moved(
        point(px(300.), px(10.)),
        false,
        false,
        Axis::Vertical,
        shown
    ));
    state.reconcile(shown, false);
    assert!(state.lit.is_none());
    assert_eq!(state.leaving.len(), 1);
    assert_eq!(state.leaving[0].rect, row(0.));
    assert!(!state.reconcile(shown + crate::tokens::DURATION_FAST_EXIT, false));
}

#[test]
fn a_skipped_row_clears_the_fill() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.record(1, row(28.), ItemKind::skip());
    state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
    state.reconcile(start, false);
    state.pointer_moved(point(px(10.), px(40.)), true, false, Axis::Vertical, start);
    state.reconcile(start, false);
    assert!(state.lit.is_none());
}

#[test]
fn a_scroll_under_a_resting_pointer_lights_the_row_that_comes_under_it() {
    let start = Instant::now();
    let mut state = state_with_menu();
    let at = point(px(10.), px(10.));
    state.pointer_moved(at, true, false, Axis::Vertical, start);
    state.reconcile(start, false);
    assert_eq!(state.lit.unwrap().index, 0);
    assert!(state.scrolled(start));
    // A repeated position is still no pointer move.
    assert!(!state.pointer_moved(at, true, false, Axis::Vertical, start));
    // The next frame lays the rows out 28px higher: row 1 is under the
    // pointer now, and the fill glides to it.
    state.frame += 1;
    for (ix, bounds) in menu() {
        let section = if ix < 2 { 0 } else { 1 };
        let moved = Bounds {
            origin: point(bounds.origin.x, bounds.origin.y - px(28.)),
            ..bounds
        };
        state.record(ix, moved, ItemKind::target().section(section));
    }
    state.reconcile(start, false);
    assert_eq!(state.wanted, Some(1));
    assert_eq!(state.lit.unwrap().index, 1);
    assert!(state.leaving.is_empty(), "a glide, not a fade");
}

#[test]
fn a_quiet_list_stays_dark_until_the_scroll_settles() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.quiet_after_scroll = Some(Duration::from_millis(150));
    let at = point(px(10.), px(10.));
    state.pointer_moved(at, true, false, Axis::Vertical, start);
    state.scrolled(start);
    assert!(
        state.reconcile(start, false),
        "it keeps drawing while quiet"
    );
    assert_eq!(state.wanted, None);
    state.pointer_moved(point(px(11.), px(10.)), true, false, Axis::Vertical, start);
    assert_eq!(state.wanted, None);
    // Once the quiet spell is over, the row under the resting pointer lights.
    let settled = start + Duration::from_millis(151);
    state.reconcile(settled, false);
    assert_eq!(state.wanted, Some(0));
}

#[test]
fn the_keys_move_the_same_fill_until_the_pointer_moves() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.follow(Some(0));
    state.reconcile(start, false);
    assert_eq!(state.lit.unwrap().index, 0);
    state.follow(Some(1));
    state.reconcile(start, false);
    assert_eq!(state.lit.unwrap().index, 1);
    // A keyboard-owned fill survives the pointer leaving and a scroll.
    state.pointer_moved(point(px(300.), px(0.)), false, false, Axis::Vertical, start);
    assert!(!state.scrolled(start));
    assert_eq!(state.wanted, Some(1));
    // The pointer moving over the list takes it back.
    state.pointer_moved(point(px(10.), px(100.)), true, false, Axis::Vertical, start);
    assert_eq!(state.wanted, Some(3));
    // The list adopting the pointer's row as current changes no hands.
    state.follow(Some(3));
    state.pointer_moved(point(px(300.), px(0.)), false, false, Axis::Vertical, start);
    assert_eq!(state.wanted, None);
}

#[test]
fn a_key_to_the_keys_last_row_takes_the_fill_back_from_the_pointer() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.follow(Some(1));
    state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
    assert_eq!(state.wanted, Some(0));
    state.follow(Some(1));
    assert_eq!(state.wanted, Some(0));
    state.key_to(Some(1));
    state.reconcile(start, false);
    assert_eq!(state.wanted, Some(1));
    assert_eq!(state.lit.unwrap().index, 1);
}

#[test]
fn a_held_button_or_a_press_clears_it() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.pointer_moved(point(px(10.), px(10.)), true, true, Axis::Vertical, start);
    assert_eq!(state.wanted, None);
    state.pointer_moved(point(px(10.), px(11.)), true, false, Axis::Vertical, start);
    assert!(state.pressed());
}

#[test]
fn reduced_motion_lands_the_travel_and_keeps_the_fades() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
    state.reconcile(start, true);
    state.pointer_moved(point(px(10.), px(40.)), true, false, Axis::Vertical, start);
    state.reconcile(start, true);
    let lit = state.lit.unwrap();
    assert_eq!(lit.rect.value(start), row(28.));
    assert!(lit.opacity.is_running(start), "the fade still runs");
}

#[test]
fn a_row_gone_from_the_frame_is_not_lit() {
    let start = Instant::now();
    let mut state = state_with_menu();
    state.pointer_moved(point(px(10.), px(10.)), true, false, Axis::Vertical, start);
    state.reconcile(start, false);
    // The next frame lays out no rows at all.
    state.frame += 1;
    state.reconcile(start, false);
    assert!(state.lit.is_none());
}
