//! "Show me" (`ShowMeRing`, `.get-started-show-me`): a ring round the place
//! a step is about, with a word on it, following that place as panels move.
//! Nothing is dimmed and nothing takes the pointer; it goes after a while,
//! at the next press anywhere, or at Escape. It draws above the workspace
//! and below every dialog and menu, and not at all while one is up.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, Bounds, DispatchPhase, IntoElement,
    MouseDownEvent, ParentElement as _, Pixels, Styled as _, Window, canvas, div, px,
};
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    shape::RADIUS_MODAL,
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_PILL},
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
    // CSS draws the ring as two outer box-shadows (`0 0 0 2px` and a wider
    // translucent halo), which paint only outside the box. A GPUI shadow
    // fills its whole rounded rect, and the ring has no background to cover
    // it, so shadows here would paint over the place being pointed at. Each
    // band is drawn instead as the border of a box grown past `bounds` by
    // the band's outer edge, its radius grown with it as a CSS spread's is.
    let band = move |outset: f32, width: f32| {
        div()
            .absolute()
            .left(bounds.left() - px(outset))
            .top(bounds.top() - px(outset))
            .w(bounds.size.width + px(2. * outset))
            .h(bounds.size.height + px(2. * outset))
            .rounded(RADIUS_MODAL + px(outset))
            .border(px(width))
    };
    // The pulse (`get-started-pulse`): the halo breathes out from 8px to
    // 12px and fades from 18% to 8% at the half, eased both ways, every
    // 1.6s. It starts past the 2px ring, which covers it there in CSS.
    let halo = band(8., 6.).with_animation(
        "get-started-pulse",
        Animation::new(Duration::from_millis(1600)).repeat(),
        move |halo, delta| {
            let half = if delta < 0.5 {
                delta * 2.
            } else {
                (1. - delta) * 2.
            };
            let eased = gpui::ease_in_out(half);
            let spread = 8. + 4. * eased;
            halo.left(bounds.left() - px(spread))
                .top(bounds.top() - px(spread))
                .w(bounds.size.width + px(2. * spread))
                .h(bounds.size.height + px(2. * spread))
                .rounded(RADIUS_MODAL + px(spread))
                .border(px(spread - 2.))
                .border_color(accent.opacity(0.18 - 0.10 * eased))
        },
    );
    let ring = band(2., 2.).border_color(accent);
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
        .child(halo)
        .child(ring)
        .child(word)
        .child(listen)
        .into_any_element()
}
