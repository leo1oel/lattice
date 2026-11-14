//! One row of the history timeline, whatever recorded it, ported from the
//! Tauri app's `HistoryRow` (`history-row.tsx`, `history-timeline.css`).
//!
//! A row: a 24px glyph on the day's rail (a hairline through the glyphs from
//! the day's first row to its last), then a head (its title in the body
//! role, the clock time at its right, who and what in a caption meta line)
//! that lights on the fast tier, the row's tools waiting behind the time
//! until the pointer reaches the row, the two cross-fading; opened, the
//! body fades in under the head on the moderate tier, its height not
//! animated, so the rows below move once.

use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
    relative,
};
use lattice_ui::Motion;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    interaction::{fade, track_pointer, use_interaction},
    reveal::{Arrival, reveal},
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD, RADIUS_CONTROL, RADIUS_PILL},
    typography::tabular_nums,
};

use crate::history::widgets::{ClickHandler, initials, peer_color};

/// How much a row asks to be read.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Weight {
    /// A version someone chose to keep: a filled glyph and a medium title.
    Named,
    Plain,
    /// A version Lattice made on its own.
    Quiet,
}

/// One row of the timeline, whatever recorded it.
pub struct RowParts {
    pub key: String,
    pub glyph: Icon,
    pub glyph_size: f32,
    pub weight: Weight,
    pub title: SharedString,
    pub meta: Option<AnyElement>,
    pub time: SharedString,
    /// The full date and time, in the time's tooltip.
    pub time_title: SharedString,
    pub tools: Vec<AnyElement>,
    pub body: Option<AnyElement>,
    pub on_toggle: Box<ClickHandler>,
    /// The parity region this row is, for the first of its kind.
    pub probe: Option<&'static str>,
    /// The row's place on its day's rail.
    pub first: bool,
    pub last: bool,
}

/// A person in a meta line: initials in their colour, then the name, which
/// gives way first when the row narrows.
pub fn person(name: &str) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(4.))
        .min_w(px(16.))
        .overflow_hidden()
        .flex_shrink(1.)
        .child(
            div()
                .flex_none()
                .size(px(16.))
                .rounded(RADIUS_PILL)
                .flex()
                .items_center()
                .justify_center()
                .bg(peer_color(name))
                .text_color(gpui::white())
                .text_size(px(11. * 0.73))
                .font_weight(FONT_WEIGHT_SEMIBOLD)
                .line_height(relative(1.))
                .child(initials(name)),
        )
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .child(name.to_string()),
        )
        .into_any_element()
}

/// One row: the glyph on the rail, the head, the tools behind the time, the
/// body under the head.
pub fn history_row(parts: RowParts, window: &mut Window, cx: &mut App) -> AnyElement {
    let palette = cx.palette().clone();
    let id = SharedString::from(format!("history-row-{}", parts.key));
    let probe = parts.probe;
    let sub = |part: &str| probe.map(|name| SharedString::from(format!("{name}/{part}")));
    let (row, row_pointer) = use_interaction(id.clone(), window, cx);
    let has_tools = !parts.tools.is_empty();
    let tools_shown = if has_tools {
        fade(
            SharedString::from(format!("{id}-tools")),
            row.pointer.hovered,
            Motion::Fast,
            window,
            cx,
        )
    } else {
        0.
    };
    let head_id = SharedString::from(format!("{id}-head"));
    let (head, head_pointer) = use_interaction(head_id.clone(), window, cx);
    let wash = head.wash(gpui::transparent_black(), palette.hover, palette.pressed);

    // The rail: a hairline through the glyphs, from the day's first glyph to its last.
    let top = if parts.first { 16. } else { 0. };
    let rail = div()
        .absolute()
        .left(px(11.5))
        .w(px(1.))
        .top(px(top))
        .bg(palette.line);
    let rail = if parts.last {
        rail.h(px((16. - top).max(0.)))
    } else {
        rail.bottom_0()
    };
    let named = parts.weight == Weight::Named;
    let glyph_ink = if named {
        palette.input
    } else {
        palette.text_secondary
    };
    let glyph = div()
        .relative()
        .children(sub("glyph").and_then(lattice_ui::parity::probe))
        .flex_none()
        .mt(px(4.))
        .size(px(24.))
        .rounded(RADIUS_PILL)
        .flex()
        .items_center()
        .justify_center()
        .map(|this| {
            if named {
                this.bg(palette.text)
            } else {
                this.bg(palette.input).border_1().border_color(palette.line)
            }
        })
        .child(
            div()
                .when(parts.weight == Weight::Quiet, |this| this.opacity(0.7))
                .child(parts.glyph.element(px(parts.glyph_size), glyph_ink)),
        );

    let title = div()
        .relative()
        .children(
            sub("title")
                .and_then(|name| lattice_ui::parity::text_probe(name, 0, parts.title.clone())),
        )
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .text_ellipsis()
        .whitespace_nowrap()
        .text_role(TextRole::Body, cx)
        .text_color(if parts.weight == Weight::Quiet {
            palette.text_secondary
        } else {
            palette.text
        })
        .when(named, |this| this.font_weight(FONT_WEIGHT_MEDIUM))
        .child(parts.title.clone());
    let time_title = parts.time_title.clone();
    let time = div()
        .id(SharedString::from(format!("{id}-time")))
        .tooltip(move |_, cx| {
            lattice_ui::components::LatticeTooltip::view(time_title.clone(), None, cx)
        })
        .relative()
        .children(
            sub("time")
                .and_then(|name| lattice_ui::parity::text_probe(name, 0, parts.time.clone())),
        )
        .flex_none()
        .text_role(TextRole::Caption, cx)
        .text_color(palette.text_secondary)
        .font_features(tabular_nums())
        .whitespace_nowrap()
        .when(has_tools, |this| this.min_w(px(52.)).flex().justify_end())
        .opacity(1. - tools_shown)
        .child(parts.time.clone());
    let meta = parts.meta.map(|meta| {
        div()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(meta)
    });
    let on_toggle = parts.on_toggle;
    let head = track_pointer(
        div()
            .id(head_id)
            .cursor_pointer()
            .on_click(move |event, window, cx| on_toggle(event, window, cx)),
        head_pointer,
    )
    .relative()
    .children(sub("head").and_then(lattice_ui::parity::probe))
    .flex()
    .flex_col()
    .gap(px(2.))
    .min_w_0()
    .pt(px(6.))
    .px(px(6.))
    .pb(px(8.))
    .rounded(RADIUS_CONTROL)
    .bg(wash)
    .child(
        div()
            .flex()
            .items_baseline()
            .gap(px(8.))
            .min_w_0()
            .child(title)
            .child(time),
    )
    .children(meta);
    let body = parts.body.map(|body| {
        reveal(
            SharedString::from(format!("{id}-body")),
            Arrival::PRODUCT,
            div()
                .min_w_0()
                .pt(px(2.))
                .px(px(6.))
                .pb(px(16.))
                .child(body),
            cx,
        )
    });
    let tools = (has_tools && tools_shown > 0.).then(|| {
        div()
            .absolute()
            .top(px(4.))
            .right(px(4.))
            .flex()
            .gap(px(2.))
            .opacity(tools_shown)
            .children(parts.tools)
    });
    track_pointer(div().id(id), row_pointer)
        .relative()
        .children(probe.and_then(lattice_ui::parity::probe))
        .flex()
        .gap(px(6.))
        .min_w_0()
        .child(rail)
        .child(glyph)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(head)
                .children(body),
        )
        .children(tools)
        .into_any_element()
}
