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

/// How a floating surface arrives: the tier it moves on, the scale it grows
/// from and the few pixels it travels into place, as the app's CSS has them.
/// It fades in on the same tier, except where [`Entrance::fade`] says.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Entrance {
    pub motion: Motion,
    /// The fade's tier, when it is not the movement's.
    pub fade: Option<Motion>,
    /// The scale it starts at; it ends at 1.
    pub from_scale: f32,
    /// How far it travels, in pixels, from the side it comes from.
    pub travel: f32,
}

impl Entrance {
    /// Menus, selects and popovers (`popup-motion.css`): the pop tier, from
    /// 95% about the trigger's side and 6px towards it.
    pub const POPUP: Entrance = Entrance {
        motion: Motion::Pop,
        fade: None,
        from_scale: 0.95,
        travel: 6.,
    };

    /// Tooltips (`chrome.css`, `ui-tooltip-enter`): the fast tier, from 98%
    /// and `--space-2` away.
    pub const TOOLTIP: Entrance = Entrance {
        motion: Motion::Fast,
        fade: None,
        from_scale: 0.98,
        travel: 4.,
    };

    /// Dialogs and sheets (`dialogs.css`, `modal-rise`): the slow tier, from
    /// 98% about the centre, rising `--space-3`.
    pub const DIALOG: Entrance = Entrance {
        motion: Motion::Slow,
        fade: None,
        from_scale: 0.98,
        travel: 6.,
    };

    /// Toasts (`toast-stack.css`): the card drops in its own height from the
    /// stack's edge (see `toast_in`, which travels by that height rather than
    /// by `travel`), from 96%, on the slow tier, and fades on the moderate.
    pub const TOAST: Entrance = Entrance {
        motion: Motion::Slow,
        fade: Some(Motion::Moderate),
        from_scale: 0.96,
        travel: 0.,
    };

    /// The scale at the movement's progress `p` (a spring may overshoot 1).
    pub fn scale(self, progress: f32) -> f32 {
        self.from_scale + (1. - self.from_scale) * progress
    }

    /// How long the entrance runs: its longer tier.
    pub fn duration(self) -> Duration {
        self.fade
            .map_or(self.motion.duration(), |fade| fade.duration())
            .max(self.motion.duration())
    }

    /// The movement's and the fade's progress `elapsed` into the entrance,
    /// each on its own curve; the fade is clamped to 0..=1.
    pub fn sample(self, elapsed: Duration) -> (f32, f32) {
        let at = |motion: Motion| {
            let t = elapsed.as_secs_f32() / motion.duration().as_secs_f32();
            motion.sample(t.clamp(0., 1.))
        };
        let movement = at(self.motion);
        let fade = at(self.fade.unwrap_or(self.motion)).clamp(0., 1.);
        (movement, fade)
    }

    /// A GPUI animation over the whole entrance, linear: feed its progress
    /// to [`Entrance::sample_at`].
    pub fn animation(self) -> Animation {
        Animation::new(self.duration())
    }

    /// [`Entrance::sample`] at the linear progress `t` of [`Entrance::animation`].
    pub fn sample_at(self, t: f32) -> (f32, f32) {
        self.sample(self.duration().mul_f32(t.clamp(0., 1.)))
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
    fn entrances_grow_from_the_css_scales_and_land_at_full_size() {
        assert_eq!(Entrance::POPUP.scale(0.), 0.95);
        assert_eq!(Entrance::DIALOG.scale(0.), 0.98);
        assert_eq!(Entrance::TOAST.scale(0.), 0.96);
        for entrance in [
            Entrance::POPUP,
            Entrance::TOOLTIP,
            Entrance::DIALOG,
            Entrance::TOAST,
        ] {
            let (movement, fade) = entrance.sample_at(1.);
            assert!((entrance.scale(movement) - 1.).abs() < 1e-3);
            assert!((fade - 1.).abs() < 1e-3);
            assert_eq!(entrance.sample_at(0.), (0., 0.));
        }
    }

    #[test]
    fn a_toast_fades_in_on_the_moderate_tier_while_it_moves_on_the_slow() {
        let toast = Entrance::TOAST;
        assert_eq!(toast.duration(), DURATION_SLOW);
        // The fade is done at the moderate tier's end, and ahead of the drop
        // before it.
        let (_, fade) = toast.sample(DURATION_MODERATE);
        assert!((fade - 1.).abs() < 1e-3);
        let (movement, fade) = toast.sample(DURATION_MODERATE / 2);
        assert!(fade > movement, "fade {fade}, movement {movement}");
    }

    #[test]
    fn exits_are_one_tier_quicker() {
        assert!(Motion::Pop.exit().duration() < Motion::Pop.duration());
        assert_eq!(Motion::Pop.exit(), Motion::PopExit);
        assert_eq!(stagger(20), DURATION_STAGGER * 8);
    }
}
