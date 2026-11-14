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

/// A value that can travel between two of itself.
pub trait Tweenable: Copy + PartialEq {
    /// `self` toward `to` by `t`; a spring's `t` may pass 1.
    fn tween(self, to: Self, t: f32) -> Self;
}

impl Tweenable for f32 {
    fn tween(self, to: Self, t: f32) -> Self {
        self + (to - self) * t
    }
}

impl Tweenable for gpui::Pixels {
    fn tween(self, to: Self, t: f32) -> Self {
        self + (to - self) * t
    }
}

impl Tweenable for gpui::Bounds<gpui::Pixels> {
    fn tween(self, to: Self, t: f32) -> Self {
        gpui::Bounds {
            origin: gpui::point(
                self.origin.x.tween(to.origin.x, t),
                self.origin.y.tween(to.origin.y, t),
            ),
            size: gpui::size(
                self.size.width.tween(to.size.width, t),
                self.size.height.tween(to.size.height, t),
            ),
        }
    }
}

/// One value moving on a tier, retargetable mid-flight: what a Motion
/// `animate` prop does in the Tauri app, for state a GPUI element keeps
/// itself (a glide's rect, a fade's opacity, a thumb's width).
///
/// A retarget starts the new leg from where the value is drawn now, so an
/// interrupted move never jumps; the leg takes the tier's whole duration, as
/// a spring restarted from its current position does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tween<T> {
    from: T,
    to: T,
    started: std::time::Instant,
    token: MotionToken,
    /// How long the leg holds `from` before it moves (a CSS
    /// `transition-delay`).
    delay: Duration,
    /// At rest: the value is `to`.
    snap: bool,
}

impl<T: Tweenable> Tween<T> {
    /// At rest on `value`.
    pub fn settled(value: T, now: std::time::Instant) -> Self {
        Self {
            from: value,
            to: value,
            started: now,
            token: MOTION_FAST,
            delay: Duration::ZERO,
            snap: true,
        }
    }

    /// Where the value is drawn at `now`.
    pub fn value(&self, now: std::time::Instant) -> T {
        if self.snap || self.from == self.to {
            return self.to;
        }
        let elapsed = now.saturating_duration_since(self.started);
        let Some(moving) = elapsed.checked_sub(self.delay) else {
            return self.from;
        };
        let t = moving.as_secs_f32() / self.token.duration.as_secs_f32().max(f32::EPSILON);
        if t >= 1. {
            self.to
        } else {
            self.from.tween(self.to, self.token.ease.sample(t))
        }
    }

    /// Where the value is going.
    pub fn target(&self) -> T {
        self.to
    }

    /// Whether the value still moves at `now`; while it does, the element
    /// drawing it asks for another frame.
    pub fn is_running(&self, now: std::time::Instant) -> bool {
        !self.snap
            && self.from != self.to
            && now.saturating_duration_since(self.started) < self.delay + self.token.duration
    }

    /// Move toward `to` on `motion`, from where the value is now.
    pub fn retarget(&mut self, to: T, motion: Motion, now: std::time::Instant) {
        self.retarget_on(to, motion.token(), Duration::ZERO, now);
    }

    /// Move toward `to` on a curve and duration of its own, after `delay`:
    /// a CSS transition whose duration, easing and delay are written apart
    /// (the scrollbar's fade runs `--motion-fast`'s curve over
    /// `--duration-moderate`, and waits `--duration-moderate` to hide).
    pub fn retarget_on(
        &mut self,
        to: T,
        token: MotionToken,
        delay: Duration,
        now: std::time::Instant,
    ) {
        if to == self.to {
            return;
        }
        let from = self.value(now);
        *self = Self {
            from,
            to,
            started: now,
            token,
            delay,
            snap: false,
        };
    }

    /// Jump to `value`, as reduced motion moves things, or a fresh entrance
    /// places what then fades in.
    pub fn jump(&mut self, value: T, now: std::time::Instant) {
        *self = Self::settled(value, now);
    }
}

/// A value that a [`Spring`] can move: a fixed number of independent
/// channels (a rect's four, a length's one).
pub trait Springable: Copy + PartialEq {
    const CHANNELS: usize;
    fn channel(&self, index: usize) -> f32;
    /// `self` with every channel replaced by `channels(index)`.
    fn with_channels(self, channels: impl Fn(usize) -> f32) -> Self;
}

impl Springable for f32 {
    const CHANNELS: usize = 1;
    fn channel(&self, _: usize) -> f32 {
        *self
    }
    fn with_channels(self, channels: impl Fn(usize) -> f32) -> Self {
        channels(0)
    }
}

impl Springable for gpui::Pixels {
    const CHANNELS: usize = 1;
    fn channel(&self, _: usize) -> f32 {
        f32::from(*self)
    }
    fn with_channels(self, channels: impl Fn(usize) -> f32) -> Self {
        gpui::px(channels(0))
    }
}

impl Springable for gpui::Bounds<gpui::Pixels> {
    const CHANNELS: usize = 4;
    fn channel(&self, index: usize) -> f32 {
        f32::from(match index {
            0 => self.origin.x,
            1 => self.origin.y,
            2 => self.size.width,
            _ => self.size.height,
        })
    }
    fn with_channels(self, channels: impl Fn(usize) -> f32) -> Self {
        gpui::Bounds {
            origin: gpui::point(gpui::px(channels(0)), gpui::px(channels(1))),
            size: gpui::size(gpui::px(channels(2)), gpui::px(channels(3))),
        }
    }
}

/// `x` where a critically damped spring released from rest, `(1 + x)
/// e^-x`, has `0.001` of its travel left: Motion's `safeMin`, the share at
/// which a spring with a `duration` counts as done.
const SETTLE: f32 = 9.2335;
/// Below both, a channel is at rest (Motion's `restDelta` and `restSpeed`
/// for pixel values, a little tighter so a fill never visibly snaps).
const REST_DELTA: f32 = 0.05;
const REST_SPEED: f32 = 2.;
const MAX_CHANNELS: usize = 4;

/// One value moving on a spring tier, as `transition={spring.fast}` moves a
/// Motion value: a critically damped spring (`bounce: 0`) whose velocity
/// carries across a retarget.
///
/// A [`Tween`] retargeted mid-flight starts its new leg from rest, so a fill
/// chased across rows by a quick pointer slows to a stop at every row and
/// sets off again, which reads as stepping. A spring keeps the speed it has
/// and bends toward the new target instead, which is how Fluid
/// Functionalism's highlight (`useFluidHover`, Motion's `x`/`y` on
/// `spring.fast`) travels. The tier's duration sets the stiffness: released
/// from rest, the value has 0.1% of its travel left after the tier's
/// duration, and the curve it follows is the tier's own `linear()` curve
/// (the fast tier's stops are this spring at `ω = 115.4 rad/s` to within
/// 0.001), so a glide that is not interrupted moves exactly as a [`Tween`]
/// on the tier would.
///
/// Evaluated in closed form at the frame's time, so a dropped frame skips
/// ahead instead of slowing the motion down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spring<T> {
    to: T,
    /// Each channel's distance from `to`, and its velocity (units per
    /// second), at `started`.
    offset: [f32; MAX_CHANNELS],
    velocity: [f32; MAX_CHANNELS],
    started: std::time::Instant,
    /// The undamped angular frequency, rad/s.
    omega: f32,
}

impl<T: Springable> Spring<T> {
    /// At rest on `value`.
    pub fn settled(value: T, now: std::time::Instant) -> Self {
        assert!(T::CHANNELS <= MAX_CHANNELS);
        Self {
            to: value,
            offset: [0.; MAX_CHANNELS],
            velocity: [0.; MAX_CHANNELS],
            started: now,
            omega: SETTLE / DURATION_FAST.as_secs_f32(),
        }
    }

    /// The angular frequency a tier's spring runs at: Motion's `duration`
    /// with `bounce: 0`.
    pub fn omega(motion: Motion) -> f32 {
        SETTLE / motion.duration().as_secs_f32().max(f32::EPSILON)
    }

    /// Channel `index`'s distance from the target and velocity at `now`.
    fn channel_at(&self, index: usize, now: std::time::Instant) -> (f32, f32) {
        let (d0, v0) = (self.offset[index], self.velocity[index]);
        if d0 == 0. && v0 == 0. {
            return (0., 0.);
        }
        let t = now.saturating_duration_since(self.started).as_secs_f32();
        let w = self.omega;
        // x(t) = (d0 + (v0 + w d0) t) e^(-w t), the critically damped
        // oscillator released at d0 with velocity v0.
        let decay = (-w * t).exp();
        let b = v0 + w * d0;
        let offset = (d0 + b * t) * decay;
        let velocity = (v0 - w * b * t) * decay;
        if offset.abs() < REST_DELTA && velocity.abs() < REST_SPEED {
            (0., 0.)
        } else {
            (offset, velocity)
        }
    }

    /// Where the value is drawn at `now`.
    pub fn value(&self, now: std::time::Instant) -> T {
        let to = self.to;
        to.with_channels(|ix| to.channel(ix) + self.channel_at(ix, now).0)
    }

    /// How fast each channel moves at `now`, units per second.
    pub fn velocity(&self, now: std::time::Instant) -> T {
        self.to.with_channels(|ix| self.channel_at(ix, now).1)
    }

    /// Where the value is going.
    pub fn target(&self) -> T {
        self.to
    }

    /// Whether the value still moves at `now`.
    pub fn is_running(&self, now: std::time::Instant) -> bool {
        (0..T::CHANNELS).any(|ix| self.channel_at(ix, now) != (0., 0.))
    }

    /// Spring toward `to` on `motion`'s stiffness, from where the value is
    /// drawn at `now` and at the speed it moves there.
    pub fn retarget(&mut self, to: T, motion: Motion, now: std::time::Instant) {
        if to == self.to {
            return;
        }
        let mut offset = [0.; MAX_CHANNELS];
        let mut velocity = [0.; MAX_CHANNELS];
        for ix in 0..T::CHANNELS {
            let (d, v) = self.channel_at(ix, now);
            offset[ix] = self.to.channel(ix) + d - to.channel(ix);
            velocity[ix] = v;
        }
        *self = Self {
            to,
            offset,
            velocity,
            started: now,
            omega: Self::omega(motion),
        };
    }

    /// Jump to `value` and stop, as reduced motion moves things.
    pub fn jump(&mut self, value: T, now: std::time::Instant) {
        *self = Self::settled(value, now);
    }
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
    fn a_tween_follows_its_tier_and_lands() {
        let start = std::time::Instant::now();
        let mut tween = Tween::settled(0f32, start);
        assert!(!tween.is_running(start));
        tween.retarget(10., Motion::Fast, start);
        let half = start + DURATION_FAST / 2;
        let expected = 10. * Motion::Fast.sample(0.5);
        assert!((tween.value(half) - expected).abs() < 1e-3);
        assert!(tween.is_running(half));
        let end = start + DURATION_FAST;
        assert_eq!(tween.value(end), 10.);
        assert!(!tween.is_running(end));
    }

    #[test]
    fn a_retarget_starts_from_where_the_value_is_drawn() {
        let start = std::time::Instant::now();
        let mut tween = Tween::settled(0f32, start);
        tween.retarget(10., Motion::Moderate, start);
        let midway = start + DURATION_MODERATE / 4;
        let drawn = tween.value(midway);
        tween.retarget(-10., Motion::Moderate, midway);
        assert!((tween.value(midway) - drawn).abs() < 1e-4);
        assert_eq!(tween.value(midway + DURATION_MODERATE), -10.);
    }

    #[test]
    fn a_delayed_leg_holds_then_moves_on_its_own_curve() {
        let start = std::time::Instant::now();
        let mut tween = Tween::settled(1f32, start);
        let token = MotionToken::new(DURATION_FAST, EASE_FAST);
        tween.retarget_on(0., token, DURATION_MODERATE, start);
        assert_eq!(tween.value(start + DURATION_MODERATE / 2), 1.);
        assert!(tween.is_running(start + DURATION_MODERATE));
        let halfway = start + DURATION_MODERATE + DURATION_FAST / 2;
        assert!((tween.value(halfway) - (1. - EASE_FAST.sample(0.5))).abs() < 1e-4);
        assert_eq!(tween.value(start + DURATION_MODERATE + DURATION_FAST), 0.);
    }

    #[test]
    fn a_jump_lands_at_once() {
        let start = std::time::Instant::now();
        let mut tween = Tween::settled(gpui::px(0.), start);
        tween.retarget(gpui::px(8.), Motion::Slow, start);
        tween.jump(gpui::px(4.), start);
        assert_eq!(tween.value(start), gpui::px(4.));
        assert!(!tween.is_running(start));
    }

    #[test]
    fn a_spring_released_from_rest_follows_its_tiers_curve() {
        let start = std::time::Instant::now();
        let mut spring = Spring::settled(0f32, start);
        spring.retarget(1., Motion::Fast, start);
        for step in 0..=8 {
            let at = start + DURATION_FAST.mul_f32(step as f32 / 8.);
            let expected = Motion::Fast.sample(step as f32 / 8.);
            assert!(
                (spring.value(at) - expected).abs() < 0.01,
                "step {step}: {} against {expected}",
                spring.value(at)
            );
        }
        assert!(!spring.is_running(start + DURATION_FAST * 2));
        assert_eq!(spring.value(start + DURATION_FAST * 2), 1.);
    }

    #[test]
    fn a_retargeted_spring_keeps_its_speed() {
        let start = std::time::Instant::now();
        let mut spring = Spring::settled(0f32, start);
        spring.retarget(100., Motion::Fast, start);
        let midway = start + DURATION_FAST / 4;
        let (drawn, speed) = (spring.value(midway), spring.velocity(midway));
        assert!(speed > 0.);
        spring.retarget(200., Motion::Fast, midway);
        assert!((spring.value(midway) - drawn).abs() < 1e-3);
        assert!((spring.velocity(midway) - speed).abs() < 1e-2);
        // A tween restarts the leg from rest; the spring is already moving,
        // so a moment later it is further along than a fresh leg would be.
        let soon = midway + std::time::Duration::from_millis(4);
        let mut fresh = Spring::settled(drawn, midway);
        fresh.retarget(200., Motion::Fast, midway);
        assert!(spring.value(soon) > fresh.value(soon));
        assert!(!spring.is_running(midway + DURATION_FAST * 3));
        assert_eq!(spring.value(midway + DURATION_FAST * 3), 200.);
    }

    #[test]
    fn a_spring_moves_every_channel_of_a_rect() {
        let start = std::time::Instant::now();
        let from = gpui::bounds(
            gpui::point(gpui::px(0.), gpui::px(0.)),
            gpui::size(gpui::px(100.), gpui::px(28.)),
        );
        let to = gpui::bounds(
            gpui::point(gpui::px(0.), gpui::px(56.)),
            gpui::size(gpui::px(100.), gpui::px(32.)),
        );
        let mut spring = Spring::settled(from, start);
        spring.retarget(to, Motion::Fast, start);
        let half = spring.value(start + DURATION_FAST / 4);
        assert!(half.origin.y > gpui::px(0.) && half.origin.y < gpui::px(56.));
        assert!(half.size.height > gpui::px(28.) && half.size.height < gpui::px(32.));
        assert_eq!(half.origin.x, gpui::px(0.));
        assert_eq!(spring.value(start + DURATION_FAST * 2), to);
    }

    #[test]
    fn exits_are_one_tier_quicker() {
        assert!(Motion::Pop.exit().duration() < Motion::Pop.duration());
        assert_eq!(Motion::Pop.exit(), Motion::PopExit);
        assert_eq!(stagger(20), DURATION_STAGGER * 8);
    }
}
