//! The motion system: three spring tiers and a pop tier, exits one tier
//! quicker as plain ease-out tweens.
//!
//! - fast 80 ms: hover, focus, fades;
//! - moderate 160 ms: tab indicators, switches, rows, a view switch's fade;
//! - slow 240 ms with a small bounce: dialogs, drawers, panes;
//! - pop 220 ms with a soft bounce: menus, selects, popovers, completions.
//!
//! The curves are the same `linear()` spring samples the CSS uses, sampled
//! the way a browser does (piecewise linear between evenly spaced stops), so
//! a GPUI animation follows the app's curve point for point.

use std::time::Duration;

use gpui::Animation;

use crate::{token_types::MotionToken, tokens::*};

/// The tiers, entering and exiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Motion {
    Fast,
    Moderate,
    Slow,
    Pop,
    FastExit,
    ModerateExit,
    SlowExit,
    PopExit,
    /// Off-tier moments, each played once.
    Draw,
    Flourish,
    Linger,
}

impl Motion {
    pub fn token(self) -> MotionToken {
        match self {
            Motion::Fast => MOTION_FAST,
            Motion::Moderate => MOTION_MODERATE,
            Motion::Slow => MOTION_SLOW,
            Motion::Pop => MOTION_POP,
            Motion::FastExit => MOTION_FAST_EXIT,
            Motion::ModerateExit => MOTION_MODERATE_EXIT,
            Motion::SlowExit => MOTION_SLOW_EXIT,
            Motion::PopExit => MOTION_POP_EXIT,
            Motion::Draw => MOTION_DRAW,
            Motion::Flourish => MOTION_FLOURISH,
            Motion::Linger => MOTION_LINGER,
        }
    }

    pub fn duration(self) -> Duration {
        self.token().duration
    }

    /// The curve's progress at `t` in 0..=1; a spring may overshoot 1.
    pub fn sample(self, t: f32) -> f32 {
        self.token().ease.sample(t)
    }

    /// A GPUI animation of this tier, on its own curve.
    pub fn animation(self) -> Animation {
        let ease = self.token().ease;
        Animation::new(self.duration()).with_easing(move |t| ease.sample(t))
    }

    /// The exit tier that dismisses what this tier brought in.
    pub fn exit(self) -> Motion {
        match self {
            Motion::Fast => Motion::FastExit,
            Motion::Moderate => Motion::ModerateExit,
            Motion::Slow => Motion::SlowExit,
            Motion::Pop => Motion::PopExit,
            other => other,
        }
    }
}

/// Things that arrive in turn wait this long each, eight turns at most.
pub fn stagger(index: usize) -> Duration {
    DURATION_STAGGER * index.min(8) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token_types::Ease;

    #[test]
    fn every_tier_starts_at_rest_and_lands() {
        for motion in [
            Motion::Fast,
            Motion::Moderate,
            Motion::Slow,
            Motion::Pop,
            Motion::FastExit,
            Motion::PopExit,
        ] {
            assert!(motion.sample(0.).abs() < 1e-6, "{motion:?} starts at 0");
            assert!((motion.sample(1.) - 1.).abs() < 1e-3, "{motion:?} lands");
        }
    }

    #[test]
    fn the_pop_spring_overshoots_as_the_css_curve_does() {
        let peak = (0..=100)
            .map(|step| Motion::Pop.sample(step as f32 / 100.))
            .fold(0f32, f32::max);
        assert!((peak - 1.015).abs() < 1e-3, "peak {peak}");
    }

    #[test]
    fn linear_stops_interpolate_between_samples() {
        let ease = Ease::Linear(&[0., 0.5, 1.]);
        assert!((ease.sample(0.25) - 0.25).abs() < 1e-6);
        assert!((ease.sample(0.75) - 0.75).abs() < 1e-6);
    }

    #[test]
    fn exits_are_one_tier_quicker() {
        assert!(Motion::Pop.exit().duration() < Motion::Pop.duration());
        assert_eq!(Motion::Pop.exit(), Motion::PopExit);
        assert_eq!(stagger(20), DURATION_STAGGER * 8);
    }
}
