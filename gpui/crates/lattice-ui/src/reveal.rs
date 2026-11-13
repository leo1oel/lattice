//! Reveal: how things arrive and leave, on the motion tiers.
//!
//! The Tauri app's product surfaces reveal the way Fluid Functionalism's
//! product preset does (<https://www.fluidfunctionalism.com/docs/reveal>,
//! `.reveal-product`): a block fades in where it is, on the moderate tier,
//! and nothing moves on scroll; items that arrive together step in 40 ms
//! apart (`--duration-stagger`), eight steps at most. A dismissal is the
//! tier's exit, a plain ease-out one tier quicker, so it reads as final
//! rather than the entrance played backwards. A loading indicator waits
//! until the load outlasts a glance (150 ms, `loading-reveal.ts`) and then
//! fades in on the fast tier, so a quick load shows nothing.
//!
//! - [`reveal`]: an element's entrance, once, when it first draws.
//! - [`Presence`]: whether something still draws while it leaves, and its
//!   opacity, as `AnimatePresence` keeps an exiting element mounted.
//! - [`loading_opacity`]: the loading indicator's reveal.
//!
//! Under reduced motion the rise is dropped and the fades stay.

use std::time::{Duration, Instant};

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, ElementId, IntoElement, ParentElement as _,
    Styled as _, Window, div, px,
};

use crate::{
    interaction::fade,
    motion::{Motion, stagger},
};

/// How long a load runs before its indicator shows (`LOADING_REVEAL_DELAY_MS`).
pub const LOADING_DELAY: Duration = Duration::from_millis(150);

/// How a block arrives.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Arrival {
    pub motion: Motion,
    /// Pixels it rises into place; 0 for a fade in place (the product preset).
    pub rise: f32,
    /// Its place among things arriving together.
    pub index: usize,
}

impl Arrival {
    /// The product preset: a fade in place on the moderate tier.
    pub const PRODUCT: Arrival = Arrival {
        motion: Motion::Moderate,
        rise: 0.,
        index: 0,
    };

    /// A status line swapping in (`StateSwap`): 3px up on the moderate tier.
    pub const SWAP: Arrival = Arrival {
        motion: Motion::Moderate,
        rise: 3.,
        index: 0,
    };

    pub fn nth(mut self, index: usize) -> Self {
        self.index = index;
        self
    }

    /// The opacity and rise at `elapsed` since the block first drew.
    pub fn sample(self, elapsed: Duration, reduce_motion: bool) -> (f32, f32) {
        let Some(moving) = elapsed.checked_sub(stagger(self.index)) else {
            return (0., if reduce_motion { 0. } else { self.rise });
        };
        let t = (moving.as_secs_f32() / self.motion.duration().as_secs_f32()).min(1.);
        let progress = self.motion.sample(t);
        let rise = if reduce_motion {
            0.
        } else {
            self.rise * (1. - progress)
        };
        (progress.clamp(0., 1.), rise)
    }

    /// How long the whole arrival runs.
    pub fn duration(self) -> Duration {
        stagger(self.index) + self.motion.duration()
    }
}

/// `element`, arriving as `arrival` says the first time it draws under `id`.
pub fn reveal(
    id: impl Into<ElementId>,
    arrival: Arrival,
    element: impl IntoElement,
    cx: &App,
) -> AnyElement {
    let reduce = cx.reduce_motion();
    let duration = arrival.duration();
    div()
        .child(element)
        .with_animation(id, Animation::new(duration), move |this, t| {
            let (opacity, rise) = arrival.sample(duration.mul_f32(t), reduce);
            this.opacity(opacity).relative().top(px(rise))
        })
        .into_any_element()
}

/// Something that draws while it is shown and while it leaves.
pub struct Presence {
    /// 0..1: in on the tier, out on its exit.
    pub opacity: f32,
}

impl Presence {
    /// `None` once `shown` is false and the exit has run.
    pub fn new(
        id: impl Into<ElementId>,
        shown: bool,
        motion: Motion,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Self> {
        let opacity = fade(id, shown, motion, window, cx);
        (shown || opacity > 0.).then_some(Presence { opacity })
    }
}

/// A loading indicator's opacity, for a load that began at `started`:
/// nothing for 150 ms, then a fade in on the fast tier. It asks for frames
/// while it waits.
pub fn loading_opacity(
    id: impl Into<ElementId>,
    started: Instant,
    window: &mut Window,
    cx: &mut App,
) -> f32 {
    let shown = started.elapsed() >= LOADING_DELAY;
    if !shown {
        window.request_animation_frame();
    }
    fade(id, shown, Motion::Fast, window, cx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::{DURATION_MODERATE, DURATION_STAGGER};

    #[test]
    fn a_product_block_fades_in_place_on_the_moderate_tier() {
        let (opacity, rise) = Arrival::PRODUCT.sample(Duration::ZERO, false);
        assert_eq!((opacity, rise), (0., 0.));
        let (opacity, rise) = Arrival::PRODUCT.sample(DURATION_MODERATE, false);
        assert!((opacity - 1.).abs() < 1e-3);
        assert_eq!(rise, 0.);
    }

    #[test]
    fn items_step_in_forty_ms_apart_eight_steps_at_most() {
        let third = Arrival::PRODUCT.nth(2);
        assert_eq!(third.sample(DURATION_STAGGER, false).0, 0.);
        assert!(third.sample(DURATION_STAGGER * 3, false).0 > 0.);
        assert_eq!(
            Arrival::PRODUCT.nth(20).duration(),
            DURATION_STAGGER * 8 + DURATION_MODERATE
        );
    }

    #[test]
    fn a_swap_rises_three_pixels_unless_motion_is_reduced() {
        assert_eq!(Arrival::SWAP.sample(Duration::ZERO, false).1, 3.);
        assert_eq!(Arrival::SWAP.sample(DURATION_MODERATE, false).1, 0.);
        assert_eq!(Arrival::SWAP.sample(Duration::ZERO, true).1, 0.);
    }
}
