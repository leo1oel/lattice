//! "Show me" (`ShowMeRing`, `.get-started-show-me`): a ring round the place
//! a step is about, with a word on it, following that place as panels move.
//! Nothing is dimmed and nothing takes the pointer; it goes after a while,
//! at the next press anywhere, or at Escape. It draws above the workspace
//! and below every dialog and menu, and not at all while one is up.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, Bounds, BoxShadow, DispatchPhase, IntoElement,
    MouseDownEvent, ParentElement as _, Pixels, Styled as _, Window, canvas, div, point, px,
};
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_DIALOG, RADIUS_PILL},
};

/// How long the ring stays up when nothing else takes it down.
pub const SHOW_ME: Duration = Duration::from_secs(8);

/// A place is worth pointing at only when enough of it is on screen.
pub fn visible(bounds: Bounds<Pixels>, window: Bounds<Pixels>) -> Option<Bounds<Pixels>> {
    let size = bounds.size;
    let off = bounds.right() < px(8.)
        || bounds.bottom() < px(8.)
        || bounds.left() > window.right() - px(8.)
        || bounds.top() > window.bottom() - px(8.);
    (size.width >= px(24.) && size.height >= px(16.) && !off).then_some(bounds)
}

/// The ring and its word over `bounds` (window coordinates); `done` runs at
/// the next press anywhere. (Escape is the window's to hear: a key reaches
/// only the focused element's path, which the ring is never on.)
pub fn ring(
    bounds: Bounds<Pixels>,
    hint: String,
    done: impl Fn(&mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let accent = palette.accent;
    let glow = move |spread: f32, alpha: f32| {
        vec![
            BoxShadow {
                color: accent,
                offset: point(px(0.), px(0.)),
                blur_radius: px(0.),
                spread_radius: px(2.),
                inset: false,
            },
            BoxShadow {
                color: accent.opacity(alpha),
                offset: point(px(0.), px(0.)),
                blur_radius: px(0.),
                spread_radius: px(spread),
                inset: false,
            },
        ]
    };
    // The pulse (`get-started-pulse`): the halo breathes out and fades at
    // the half, eased both ways, every 1.6s.
    let ring = div()
        .absolute()
        .left(bounds.left())
        .top(bounds.top())
        .w(bounds.size.width)
        .h(bounds.size.height)
        .rounded(RADIUS_DIALOG)
        .with_animation(
            "get-started-pulse",
            Animation::new(Duration::from_millis(1600)).repeat(),
            move |ring, delta| {
                let half = if delta < 0.5 {
                    delta * 2.
                } else {
                    (1. - delta) * 2.
                };
                let eased = gpui::ease_in_out(half);
                ring.shadow(glow(8. + 4. * eased, 0.18 - 0.10 * eased))
            },
        );
    let pill = div()
        .flex_none()
        .px(px(12.))
        .py(px(6.))
        .rounded(RADIUS_PILL)
        .bg(palette.text)
        .text_color(palette.raised)
        .text_role(TextRole::BodyCompact, cx)
        .font_weight(FONT_WEIGHT_MEDIUM)
        .whitespace_nowrap()
        .shadow(Elevation::Dialog.shadows(&palette))
        .child(hint);
    let word = div()
        .absolute()
        .left(bounds.left())
        .w(bounds.size.width)
        .top(bounds.top() + (bounds.size.height * 0.3).min(px(160.)))
        .flex()
        .justify_center()
        .child(pill);
    let done = std::rc::Rc::new(done);
    let listen = canvas(
        |_, _, _| (),
        move |_, _, window, _| {
            let on_press = done.clone();
            window.on_mouse_event(move |_: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Capture {
                    on_press(window, cx);
                }
            });
        },
    )
    .absolute()
    .size_0();
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .child(ring)
        .child(word)
        .child(listen)
        .into_any_element()
}
