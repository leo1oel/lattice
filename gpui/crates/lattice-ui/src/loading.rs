//! Loading motion: the busy spinner and a skeleton's sheen, as the Tauri app
//! draws them.
//!
//! - [`spinner`]: Lucide's loader circle turning once every 0.8 s, linear
//!   (`.spin` in `app-shell.css`, which `activity-icons.tsx` puts on a busy
//!   loader). [`Icon::element`] draws an icon still; a busy mark goes
//!   through here, and a Button or IconButton showing [`Icon::LOADER`] turns
//!   it by itself.
//! - [`sheen`]: a band crossing a skeleton every 1.6 s on ease-in-out
//!   (`loading-status.css`, `.loading-sheen::after`): transparent, then the
//!   surface the skeleton sits on at 80%, then transparent again, from
//!   30% to 70% of the band.
//!
//! Under reduced motion (`adaptive-feedback.css`) the spinner holds still
//! and the sheen is not drawn: the loops rest on their resting frame.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, ElementId, Hsla, IntoElement,
    ParentElement as _, Pixels, Styled as _, Transformation, div, linear_color_stop,
    linear_gradient, percentage, relative,
};

use crate::{Icon, token_types::Ease};

/// One turn of a busy loader (`animation: spin 0.8s linear infinite`).
pub const TURN: Duration = Duration::from_millis(800);
/// One crossing of a skeleton's sheen.
pub const SHEEN: Duration = Duration::from_millis(1600);
/// CSS `ease-in-out`.
const EASE_IN_OUT: Ease = Ease::CubicBezier(0.42, 0., 0.58, 1.);

/// `icon` at `size` in `color`, turning as a busy loader turns; keyed by
/// `id`, so it keeps its place in the turn from frame to frame.
pub fn spinner(
    id: impl Into<ElementId>,
    icon: Icon,
    size: Pixels,
    color: Hsla,
    cx: &App,
) -> AnyElement {
    let mark = icon.element(size, color);
    if cx.reduce_motion() {
        return mark.into_any_element();
    }
    mark.with_animation(id, Animation::new(TURN).repeat(), |mark, t| {
        mark.with_transformation(Transformation::rotate(percentage(t)))
    })
    .into_any_element()
}

/// [`spinner`] for [`Icon::LOADER`], the app's one busy mark.
pub fn loader(id: impl Into<ElementId>, size: Pixels, color: Hsla, cx: &App) -> AnyElement {
    spinner(id, Icon::LOADER, size, color, cx)
}

/// `icon`, turning when it is [`Icon::LOADER`] and still otherwise: for a
/// control that shows its busy state in its icon's place.
pub fn mark(id: impl Into<ElementId>, icon: Icon, size: Pixels, color: Hsla, cx: &App) -> AnyElement {
    if icon == Icon::LOADER {
        spinner(id, icon, size, color, cx)
    } else {
        icon.element(size, color).into_any_element()
    }
}

/// A skeleton's sheen, laid over it (absolute, filling it; the skeleton
/// clips it): `surface` is the colour the skeleton sits on. Nothing under
/// reduced motion.
pub fn sheen(id: impl Into<ElementId>, surface: Hsla, cx: &App) -> Option<AnyElement> {
    if cx.reduce_motion() {
        return None;
    }
    let band = surface.opacity(surface.a * 0.8);
    let clear = surface.opacity(0.);
    // The gradient's 30%–70% stretch, as two halves of one band.
    let half = |from: Hsla, to: Hsla| {
        div()
            .h_full()
            .w(relative(0.5))
            .bg(linear_gradient(
                90.,
                linear_color_stop(from, 0.),
                linear_color_stop(to, 1.),
            ))
    };
    Some(
        div()
            .absolute()
            .inset_0()
            .overflow_hidden()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .w(relative(0.4))
                    .flex()
                    .child(half(clear, band))
                    .child(half(band, clear))
                    .with_animation(
                        id,
                        Animation::new(SHEEN)
                            .repeat()
                            .with_easing(|t| EASE_IN_OUT.sample(t)),
                        // translateX(-100%) to translateX(100%) of the
                        // skeleton; the band sits in its middle 40%.
                        |band, t| band.left(relative(-0.7 + 2. * t)),
                    ),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_loops_run_at_the_css_rates() {
        assert_eq!(TURN, Duration::from_millis(800));
        assert_eq!(SHEEN, Duration::from_millis(1600));
        assert!((EASE_IN_OUT.sample(0.5) - 0.5).abs() < 1e-3);
    }
}
