//! A control's hover and press, eased on the motion tiers.
//!
//! GPUI's `.hover()` and `.active()` styles switch at once. Lattice's states
//! fade: hover and focus on the fast tier (80 ms), back on its exit (60 ms
//! ease-out), as `--motion-fast` and `--motion-fast-exit` animate them in the
//! app. A control keeps its pointer state in keyed element state, and GPUI
//! Kit's value transition eases a 0..1 progress for each, which the control
//! mixes its colours with.
//!
//! Under reduced motion the fades still run: they are not spatial motion
//! (DESIGN.md asks only that one-shot moments finish at once).

use std::sync::Arc;

use gpui::{App, ElementId, Entity, Hsla, MouseButton, Rgba, StatefulInteractiveElement, Window};
use gpui_kit::base::{ReducedMotion, Transition, transition};

use crate::motion::Motion;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pointer {
    pub hovered: bool,
    pub pressed: bool,
}

/// This frame's eased state of one control.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Interaction {
    /// 0 at rest, 1 under the pointer.
    pub hover: f32,
    /// 0 at rest, 1 while the button is held.
    pub press: f32,
    pub pointer: Pointer,
}

impl Interaction {
    /// The colour for this frame: `rest`, toward `hover` under the pointer,
    /// toward `pressed` while held.
    pub fn wash(&self, rest: Hsla, hover: Hsla, pressed: Hsla) -> Hsla {
        mix(mix(rest, hover, self.hover), pressed, self.press)
    }
}

/// The control's eased state, and the handle its listeners update.
pub fn use_interaction(
    id: impl Into<ElementId>,
    window: &mut Window,
    cx: &mut App,
) -> (Interaction, Entity<Pointer>) {
    let id: ElementId = id.into();
    let child = |name: &'static str| ElementId::NamedChild(Arc::new(id.clone()), name.into());
    let state = window.use_keyed_state(child("pointer"), cx, |_, _| Pointer::default());
    let pointer = *state.read(cx);
    let hover = fade(child("hover"), pointer.hovered, Motion::Fast, window, cx);
    // A press deepens the wash on the same tier and lifts on its exit.
    let press = fade(child("press"), pointer.pressed, Motion::Fast, window, cx);
    (
        Interaction {
            hover,
            press,
            pointer,
        },
        state,
    )
}

/// Wire an element's pointer listeners to its state.
pub fn track_pointer<E: StatefulInteractiveElement>(element: E, state: Entity<Pointer>) -> E {
    track_pointer_and_hover(element, state, |_, _, _| {})
}

/// [`track_pointer`], also handing each change of hover to `on_hover`: an
/// element takes one hover listener, so a control that reports its hover
/// shares the one that eases its wash.
pub fn track_pointer_and_hover<E: StatefulInteractiveElement>(
    element: E,
    state: Entity<Pointer>,
    on_hover: impl Fn(&bool, &mut Window, &mut App) + 'static,
) -> E {
    let hover = state.clone();
    let down = state.clone();
    let up = state.clone();
    let out = state;
    element
        .on_hover(move |hovered, window, cx| {
            hover.update(cx, |pointer, cx| {
                if pointer.hovered != *hovered {
                    pointer.hovered = *hovered;
                    if !hovered {
                        pointer.pressed = false;
                    }
                    cx.notify();
                }
            });
            on_hover(hovered, window, cx);
        })
        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
            down.update(cx, |pointer, cx| {
                pointer.pressed = true;
                cx.notify();
            })
        })
        .on_mouse_up(MouseButton::Left, move |_, _, cx| {
            up.update(cx, |pointer, cx| {
                pointer.pressed = false;
                cx.notify();
            })
        })
        .on_mouse_up_out(MouseButton::Left, move |_, _, cx| {
            out.update(cx, |pointer, cx| {
                if pointer.pressed {
                    pointer.pressed = false;
                    cx.notify();
                }
            })
        })
}

/// Make an enabled control a keyboard tab stop: Tab reaches it, its
/// `focus_visible` ring shows, and Enter or Space fire its `on_click`. A
/// press does not take focus, as a button in the app's web view does not, so
/// clicking a control leaves the editor focused and draws no ring.
pub fn tab_stop<E: StatefulInteractiveElement>(element: E) -> E {
    element
        .tab_index(0)
        .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
}

/// A 0..1 progress toward `on`, on `motion` going in and its exit coming
/// back.
pub fn fade(
    id: impl Into<ElementId>,
    on: bool,
    motion: Motion,
    window: &mut Window,
    cx: &mut App,
) -> f32 {
    let tier = if on { motion } else { motion.exit() };
    let token = tier.token();
    let policy = Transition::new(token.duration)
        .ease(move |t| token.ease.sample(t))
        .reduced_motion(ReducedMotion::Continue);
    transition(id.into(), if on { 1.0f32 } else { 0.0 }, policy, window, cx)
}

/// `a` toward `b` by `t`, in sRGB with premultiplied alpha, as CSS
/// transitions a colour: a wash fading in from transparent keeps its hue.
pub fn mix(a: Hsla, b: Hsla, t: f32) -> Hsla {
    if t <= 0. {
        return a;
    }
    if t >= 1. {
        return b;
    }
    let (a, b) = (Rgba::from(a), Rgba::from(b));
    let alpha = a.a + (b.a - a.a) * t;
    if alpha <= f32::EPSILON {
        return Rgba { a: 0., ..b }.into();
    }
    let channel = |x: f32, xa: f32, y: f32, ya: f32| (x * xa + (y * ya - x * xa) * t) / alpha;
    Rgba {
        r: channel(a.r, a.a, b.r, b.a),
        g: channel(a.g, a.a, b.g, b.a),
        b: channel(a.b, a.a, b.b, b.a),
        a: alpha,
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{hsla, transparent_black};

    #[test]
    fn a_wash_fading_in_from_transparent_keeps_its_colour() {
        let wash = hsla(0.6, 0.5, 0.4, 0.08);
        let halfway = Rgba::from(mix(transparent_black(), wash, 0.5));
        let target = Rgba::from(wash);
        assert!((halfway.a - 0.04).abs() < 1e-4);
        assert!((halfway.r - target.r).abs() < 1e-3);
        assert!((halfway.b - target.b).abs() < 1e-3);
    }

    #[test]
    fn the_ends_are_exact() {
        let (a, b) = (hsla(0., 0., 0.2, 1.), hsla(0., 0., 0.9, 1.));
        assert_eq!(mix(a, b, 0.), a);
        assert_eq!(mix(a, b, 1.), b);
    }
}
