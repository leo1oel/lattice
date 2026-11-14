//! The editor's attention motions: the moments a source editor marks text
//! for the writer's eye, as `editor-workspace.css` keys them.
//!
//! - [`reveal_flash`]: a jump's target line (`editor-reveal.ts`) comes up in
//!   the find-match colour, holds it for 55% of the linger tier and fades.
//! - [`change_wash`]: lines an outside edit landed (`change-marks.ts`: the
//!   Agent's, another app's) come up on the success wash within 8%, hold it
//!   to 45% and let it go.
//! - [`accept`]: an accepted suggestion, one edit after another, 40 ms
//!   apart: the old words are struck through, then fold away, then the new
//!   words settle in on the change wash. This is the settle primitive the
//!   proofread card's Accept and an Agent proposal's Accept draw with.
//!
//! Each is a pure function of the time since the moment began, so whoever
//! paints the mark (the editor adapter's highlights, a block widget) asks
//! for frames while [`Moment::is_running`] and draws the alpha it returns.
//!
//! Under reduced motion (`adaptive-feedback.css`) a flash or a wash stays
//! put at full strength for its moment instead of fading, the replaced words
//! go at once and the new ones show with the wash.

use std::time::Duration;

use crate::{
    motion::Keyframes,
    tokens::{
        DURATION_FAST, DURATION_LINGER, DURATION_MODERATE, DURATION_STAGGER, EASE_EXIT,
        EASE_MODERATE,
    },
};

/// `reveal-flash`: held, then faded, on the linger tier's ease-out.
const FLASH: Keyframes = Keyframes {
    stops: &[(0., 1.), (0.55, 1.), (1., 0.)],
    ease: EASE_EXIT,
};

/// `change-wash`: up quickly, held, let go.
const WASH: Keyframes = Keyframes {
    stops: &[(0., 0.), (0.08, 1.), (0.45, 1.), (1., 0.)],
    ease: EASE_EXIT,
};

/// One attention moment's length: the linger tier, 1.6 s.
pub const LINGER: Duration = DURATION_LINGER;

/// The share of the mark's colour to paint `elapsed` into a jump's flash,
/// 0 once it is over. The colour is `--highlight-match-surface`
/// (`Palette::search_match`).
pub fn reveal_flash(elapsed: Duration, reduce_motion: bool) -> f32 {
    linger(FLASH, elapsed, reduce_motion)
}

/// The share of `--status-success-soft` (`Palette::success_soft`) to paint
/// `elapsed` into an outside edit's wash, 0 once it is over.
pub fn change_wash(elapsed: Duration, reduce_motion: bool) -> f32 {
    linger(WASH, elapsed, reduce_motion)
}

fn linger(track: Keyframes, elapsed: Duration, reduce_motion: bool) -> f32 {
    if elapsed >= LINGER {
        return 0.;
    }
    if reduce_motion {
        return 1.;
    }
    track.sample(elapsed.as_secs_f32() / LINGER.as_secs_f32())
}

/// What an accepted edit draws at one moment of its choreography.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AcceptFrame {
    /// How much of the strike through the old words is drawn, from their
    /// start: 0..=1 (`accept-strike`, a `scaleX` from the left).
    pub strike: f32,
    /// How much of the old words' drawn width is left: 1 whole, 0 folded
    /// away (`accept-fold`'s `max-width`).
    pub ghost_width: f32,
    /// The old words' opacity as they fold.
    pub ghost_opacity: f32,
    /// The new words' opacity as they settle in (`accept-settle`).
    pub insert_opacity: f32,
    /// The share of the change wash under the new words.
    pub wash: f32,
}

/// One accepted edit's moment: the `order`th of its suggestion's edits,
/// `elapsed` after the suggestion was accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Moment {
    pub order: usize,
    pub elapsed: Duration,
}

impl Moment {
    pub fn new(order: usize, elapsed: Duration) -> Self {
        Self { order, elapsed }
    }

    /// How long this edit waits for the ones before it
    /// (`--change-mark-order` × `--duration-stagger`).
    fn delay(self) -> Duration {
        DURATION_STAGGER * self.order as u32
    }

    /// When the whole choreography is over, the new words' wash last.
    pub fn duration(self) -> Duration {
        self.delay() + DURATION_MODERATE + DURATION_FAST + LINGER
    }

    pub fn is_running(self) -> bool {
        self.elapsed < self.duration()
    }
}

/// The accepted edit's frame at `moment`.
pub fn accept(moment: Moment, reduce_motion: bool) -> AcceptFrame {
    if reduce_motion {
        // The ghost is not drawn at all and the new words show with the
        // wash, held for its moment.
        let washing = moment.elapsed < moment.duration();
        return AcceptFrame {
            strike: 0.,
            ghost_width: 0.,
            ghost_opacity: 0.,
            insert_opacity: 1.,
            wash: if washing { 1. } else { 0. },
        };
    }
    // `animation-fill-mode: both`: each holds its first frame through its
    // delay and its last after it.
    let tween = |delay: Duration, length: Duration| {
        let Some(moving) = moment.elapsed.checked_sub(delay) else {
            return 0.;
        };
        let t = (moving.as_secs_f32() / length.as_secs_f32()).min(1.);
        EASE_MODERATE.sample(t)
    };
    let delay = moment.delay();
    let strike = tween(delay, DURATION_MODERATE);
    let fold = tween(delay + DURATION_MODERATE, DURATION_MODERATE);
    let settle_delay = delay + DURATION_MODERATE + DURATION_FAST;
    let insert_opacity = tween(settle_delay, DURATION_MODERATE);
    let wash = match moment.elapsed.checked_sub(settle_delay) {
        Some(washing) => change_wash(washing, false),
        None => 0.,
    };
    AcceptFrame {
        strike,
        ghost_width: 1. - fold,
        ghost_opacity: 1. - fold,
        insert_opacity,
        wash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flash_holds_then_fades_over_the_linger_tier() {
        assert_eq!(reveal_flash(Duration::ZERO, false), 1.);
        assert_eq!(reveal_flash(LINGER.mul_f32(0.5), false), 1.);
        let fading = reveal_flash(LINGER.mul_f32(0.8), false);
        assert!(fading > 0. && fading < 1., "{fading}");
        assert_eq!(reveal_flash(LINGER, false), 0.);
    }

    #[test]
    fn a_wash_rises_fast_holds_and_lets_go() {
        assert_eq!(change_wash(Duration::ZERO, false), 0.);
        assert!(change_wash(LINGER.mul_f32(0.04), false) > 0.4);
        assert_eq!(change_wash(LINGER.mul_f32(0.3), false), 1.);
        assert!(change_wash(LINGER.mul_f32(0.9), false) < 0.3);
        assert_eq!(change_wash(LINGER, false), 0.);
    }

    #[test]
    fn reduced_motion_holds_the_mark_for_its_moment() {
        assert_eq!(reveal_flash(LINGER.mul_f32(0.9), true), 1.);
        assert_eq!(change_wash(Duration::ZERO, true), 1.);
        assert_eq!(change_wash(LINGER, true), 0.);
        let frame = accept(Moment::new(2, Duration::ZERO), true);
        assert_eq!((frame.ghost_width, frame.insert_opacity, frame.wash), (0., 1., 1.));
    }

    #[test]
    fn an_accept_strikes_then_folds_then_settles() {
        let at = |ms| accept(Moment::new(0, Duration::from_millis(ms)), false);
        // Struck, nothing folded or settled yet.
        let struck = at(160);
        assert!((struck.strike - 1.).abs() < 1e-3);
        assert_eq!(struck.ghost_width, 1.);
        assert_eq!(struck.insert_opacity, 0.);
        // The new words start settling in a fast tier after the fold began,
        // while the old ones are still folding away.
        let folding = at(240);
        assert!(folding.ghost_width > 0. && folding.ghost_width < 1.);
        assert_eq!(folding.insert_opacity, 0.);
        let folded = at(320);
        assert!(folded.ghost_width.abs() < 1e-3);
        assert!(folded.insert_opacity > 0. && folded.insert_opacity < 1.);
        let settled = at(400);
        assert!((settled.insert_opacity - 1.).abs() < 1e-3);
        assert!(settled.wash > 0.9);
        assert!(!Moment::new(0, Moment::new(0, Duration::ZERO).duration()).is_running());
    }

    #[test]
    fn later_edits_wait_their_turn() {
        let first = accept(Moment::new(0, Duration::from_millis(60)), false);
        let third = accept(Moment::new(2, Duration::from_millis(60)), false);
        assert!(first.strike > 0.);
        assert_eq!(third.strike, 0.);
        assert_eq!(
            Moment::new(2, Duration::ZERO).duration() - Moment::new(0, Duration::ZERO).duration(),
            DURATION_STAGGER * 2
        );
    }
}
