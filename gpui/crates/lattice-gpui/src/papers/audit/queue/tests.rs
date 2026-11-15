//! The queue as `bibliography-audit.tsx` walks it: `current`, `nextAfter`,
//! `step` and the J/K handler's clamped walk.

use super::*;
use Bucket::*;

fn listing(buckets: &[Bucket]) -> Listing {
    Listing::new(buckets.to_vec(), |_| Some(FixGroup::Published), None)
}

#[test]
fn the_list_shows_findings_by_what_they_ask_and_disputed_fixes_last() {
    let groups = [FixGroup::Disputed, FixGroup::Published, FixGroup::Cosmetic];
    let listing = Listing::new(
        vec![Verified, Fix, Review, Fix, Fix],
        |index| {
            [
                None,
                Some(groups[0]),
                None,
                Some(groups[1]),
                Some(groups[2]),
            ][index]
        },
        None,
    );
    assert_eq!(listing.shown, [3, 4, 1, 2, 0]);
}

#[test]
fn a_filter_whose_findings_are_gone_shows_everything() {
    let listing = Listing::new(vec![Fix, Verified], |_| None, Some(Review));
    assert_eq!(listing.view, None);
    assert_eq!(listing.shown, [0, 1]);
    let filtered = Listing::new(vec![Fix, Verified], |_| None, Some(Verified));
    assert_eq!(filtered.shown, [1]);
}

#[test]
fn the_queue_opens_on_the_first_finding_to_act_on() {
    // Shown: the review (1) before the inconclusive one (0).
    let listing = listing(&[Incomplete, Review, Verified]);
    assert_eq!(listing.current(None, true, false), Some(1));
    // Below the queue's width nothing opens until the writer opens it.
    assert_eq!(listing.current(None, false, false), None);
    // The writer's own choice holds while it is shown.
    assert_eq!(listing.current(Some(2), true, false), Some(2));
    // Nothing to act on: the first reference shown.
    let nothing_to_act_on = Listing::new(vec![Incomplete, Verified], |_| None, None);
    assert_eq!(nothing_to_act_on.current(None, true, false), Some(0));
}

#[test]
fn a_settled_report_opens_nothing() {
    let done = listing(&[Verified, Kept]);
    assert!(done.settled(false));
    assert_eq!(done.current(None, true, false), None);
    // While a check runs it is not settled: the first shown opens, the
    // kept one (Kept is listed before Verified).
    assert!(!done.settled(true));
    assert_eq!(done.current(None, true, true), Some(1));
}

#[test]
fn next_after_moves_on_through_the_findings_then_wraps_to_the_first_left() {
    // Shown: 1 (fix), 3 (fix), 0 (review), 2 (verified).
    let listing = listing(&[Review, Fix, Verified, Fix]);
    assert_eq!(listing.shown, [1, 3, 0, 2]);
    assert_eq!(listing.next_after(1), Some(3));
    assert_eq!(listing.next_after(3), Some(0));
    // From the last finding, back to the first one left.
    assert_eq!(listing.next_after(0), Some(1));
    // From a verified row, the first finding left.
    assert_eq!(listing.next_after(2), Some(1));
    // The only finding has none after it.
    assert_eq!(
        super::Listing::new(vec![Fix, Verified], |_| None, None).next_after(0),
        None
    );
}

#[test]
fn the_stepper_counts_the_open_finding_among_those_like_it() {
    let listing = listing(&[Review, Fix, Fix, Fix]);
    assert_eq!(listing.step(2), Some((2, 3)));
    // Alone in its bucket: no stepper.
    assert_eq!(listing.step(0), None);
}

#[test]
fn j_and_k_walk_the_list_and_stop_at_its_ends() {
    let listing = listing(&[Fix, Review, Verified]);
    assert_eq!(listing.walk(None, true), Some(0));
    assert_eq!(listing.walk(None, false), Some(0));
    assert_eq!(listing.walk(Some(0), true), Some(1));
    assert_eq!(listing.walk(Some(2), true), Some(2));
    assert_eq!(listing.walk(Some(1), false), Some(0));
    assert_eq!(listing.walk(Some(0), false), Some(0));
    assert_eq!(Listing::default().walk(None, true), None);
}
