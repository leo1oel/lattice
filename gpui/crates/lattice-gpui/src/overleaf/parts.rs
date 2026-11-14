//! The pieces Settings › Overleaf and the picker share
//! (`overleaf-connect-parts.tsx`, `overleaf-connect.css`): the tinted glyph
//! tile every Overleaf card, empty state and prompt is anchored by, the
//! sign-in controls, the retry row, a line of what is happening, and the
//! picker's centred stage messages.

use gpui::{
    AnimationExt as _, AnyElement, App, Entity, Hsla, IntoElement, ParentElement as _, Pixels,
    SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, ButtonSize, ButtonVariant},
    tokens::{RADIUS_CONTROL, RADIUS_PANEL},
};

use super::account::Login;
use crate::{build::chip_mark::infinity_loader, history::widgets::inline_message};

/// The tile's tint.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Warning,
    Danger,
    Neutral,
}

impl Tone {
    fn ink(self, cx: &App) -> Hsla {
        let palette = cx.palette();
        match self {
            Tone::Warning => palette.warning,
            Tone::Danger => palette.danger,
            Tone::Neutral => palette.text_secondary,
        }
    }
}

/// `color` at `share` of its alpha (`color-mix(in srgb, color N%, transparent)`).
pub fn wash(color: Hsla, share: f32) -> Hsla {
    Hsla {
        a: color.a * share,
        ..color
    }
}

/// A small tinted tile holding an icon (`.overleaf-glyph`): 28px with a
/// 15px icon and the control radius, or 44px with a 20px icon and the
/// panel radius; the tint at 12% behind its own ink.
pub fn glyph(icon: Icon, tone: Tone, large: bool, cx: &App) -> AnyElement {
    let ink = tone.ink(cx);
    let (size, icon_size, radius): (Pixels, Pixels, _) = if large {
        (px(44.), px(20.), RADIUS_PANEL)
    } else {
        (px(28.), px(15.), RADIUS_CONTROL)
    };
    div()
        .flex_none()
        .size(size)
        .flex()
        .items_center()
        .justify_center()
        .rounded(radius)
        .bg(wash(ink, 0.12))
        .child(icon.element(icon_size, ink))
        .into_any_element()
}

/// A spinner beside a line of what is happening (`.overleaf-loading`,
/// `.overleaf-waiting`): caption, secondary ink, the loader in the accent's
/// running ink.
pub fn working_line(
    id: impl Into<gpui::ElementId>,
    text: impl Into<SharedString>,
    cx: &App,
) -> gpui::Div {
    let palette = cx.palette().clone();
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .text_role(TextRole::Caption, cx)
        .text_color(palette.text_secondary)
        .child(infinity_loader(id, px(15.), &palette))
        .child(div().min_w_0().child(text.into()))
}

/// The hint under a sign-in button (`.overleaf-hint`): micro, secondary,
/// 60 characters wide at most.
pub fn hint(text: impl Into<SharedString>, cx: &App) -> AnyElement {
    div()
        .max_w(px(420.))
        .text_role(TextRole::Micro, cx)
        .text_color(cx.palette().text_secondary)
        .child(text.into())
        .into_any_element()
}

/// How the last sign-in attempt ended, when that needs saying.
pub fn login_messages(login: &Entity<Login>, cx: &App) -> Vec<AnyElement> {
    let login = login.read(cx);
    login
        .error
        .clone()
        .map(|error| {
            div()
                .mt(px(10.))
                .child(inline_message(error, true, cx))
                .into_any_element()
        })
        .into_iter()
        .chain(login.notice.clone().map(|notice| {
            div()
                .mt(px(10.))
                .child(inline_message(notice, false, cx))
                .into_any_element()
        }))
        .collect()
}

/// The sign-in button, or the wait for the sign-in window, plus how the
/// last attempt ended (`LoginControls`). `centered`: in the picker's stage.
pub fn login_controls(
    id: &'static str,
    login: &Entity<Login>,
    label: SharedString,
    hint_text: Option<SharedString>,
    centered: bool,
    _: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state = login.read(cx);
    let body = if state.pending {
        let cancel = login.clone();
        let waiting = working_line(
            (id, 0usize),
            t!("Waiting for you to sign in in the Overleaf window…"),
            cx,
        )
        .min_h(px(28.))
        .child(
            Button::new((id, 1usize), t!("Cancel"))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Compact)
                .on_click(move |_, _, cx| cancel.update(cx, |login, cx| login.cancel(cx))),
        );
        div()
            .flex()
            .flex_col()
            .when(centered, |this| this.items_center())
            .child(waiting)
            .children(
                state
                    .hint
                    .clone()
                    .map(|text| div().mt(px(10.)).child(hint(text, cx))),
            )
            .into_any_element()
    } else {
        let begin = login.clone();
        let button = Button::new((id, 2usize), label)
            .variant(ButtonVariant::Primary)
            .icon(Icon::CLOUD)
            .on_click(move |_, _, cx| begin.update(cx, |login, cx| login.begin(cx)));
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .when(centered, |this| this.items_center())
            .child(button)
            .children(hint_text.map(|text| hint(text, cx)))
            .into_any_element()
    };
    div()
        .flex()
        .flex_col()
        .when(centered, |this| this.items_center())
        .child(body)
        .children(login_messages(login, cx))
        .into_any_element()
}

/// An error line with a button to try the failed load again (`RetryRow`).
pub fn retry_row(
    id: &'static str,
    error: SharedString,
    busy: bool,
    label: SharedString,
    on_retry: impl Fn(&mut Window, &mut App) + 'static,
    centered: bool,
    cx: &App,
) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .when(centered, |this| this.items_center())
        .child(inline_message(error, true, cx))
        .child(
            Button::new(id, label)
                .size(ButtonSize::Compact)
                .icon(Icon::REFRESH)
                .disabled(busy)
                .on_click(move |_, window, cx| on_retry(window, cx)),
        )
        .into_any_element()
}

/// The centred state of the picker's list frame when there is no list to
/// show (`StageMessage`): one layout, so moving between them never jumps.
pub fn stage_message(glyph: Option<AnyElement>, children: Vec<AnyElement>) -> AnyElement {
    div()
        .flex_1()
        .py(px(24.))
        .px(px(32.))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(12.))
        .children(glyph)
        .children(children)
        .into_any_element()
}

/// A stage message's sentence (`.overleaf-stage-text`, `.overleaf-empty`):
/// caption, secondary, centred, 44 characters wide at most.
pub fn stage_text(text: impl Into<SharedString>, strong: bool, cx: &App) -> AnyElement {
    let palette = cx.palette();
    div()
        .max_w(px(320.))
        .text_center()
        .text_role(TextRole::Caption, cx)
        .text_color(if strong {
            palette.text
        } else {
            palette.text_secondary
        })
        .when(strong, |this| {
            this.font_weight(lattice_ui::tokens::FONT_WEIGHT_SEMIBOLD)
        })
        .child(text.into())
        .into_any_element()
}

/// A skeleton's sheen (`.loading-sheen`): a band of the surface the
/// skeleton sits on crossing it every 1.6 s as a translation. Lay it last in
/// a positioned, clipped skeleton.
pub fn sheen(id: impl Into<gpui::ElementId>, surface: Hsla) -> AnyElement {
    let band = wash(surface, 0.8);
    let clear = wash(surface, 0.);
    // The app's band: clear to 30%, the surface at 50%, clear from 70%.
    let half = |from: Hsla, to: Hsla| {
        div()
            .h_full()
            .w(gpui::relative(0.2))
            .bg(gpui::linear_gradient(
                90.,
                gpui::linear_color_stop(from, 0.),
                gpui::linear_color_stop(to, 1.),
            ))
    };
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left_0()
        .w_full()
        .flex()
        .child(div().h_full().w(gpui::relative(0.3)))
        .child(half(clear, band))
        .child(half(band, clear))
        .with_animation(
            id,
            gpui::Animation::new(std::time::Duration::from_millis(1_600))
                .repeat()
                .with_easing(gpui::ease_in_out),
            |this, t| this.left(gpui::relative(-1. + 2. * t)),
        )
        .into_any_element()
}
