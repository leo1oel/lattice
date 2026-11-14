//! The history's empty states, as the Tauri app draws them (`EmptyState`
//! with `fill`, `ResearchArt` and `DATED_DRAFTS`, `.history-empty`): drafts
//! stacked a little apart with their dated tabs showing, in isometric, over
//! the title in the subtitle role, the whole centred in the room under the
//! toolbar.
//!
//! The drawing is `crate::research_art`'s, read from the Tauri app's module.

use gpui::{AnyElement, App, IntoElement, ParentElement as _, SharedString, Styled as _, div, px};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _};

use crate::research_art::{Drawing, research_art};

/// `EmptyState fill` with the drawing: the art, then the title, centred in
/// the room left, 16px in (`.history-empty`: 16px over and under, 12px a side).
pub fn empty_state(
    title: impl Into<SharedString>,
    narrow: bool,
    action: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .py(px(16.))
        .px(px(12.))
        .child(research_art(
            Drawing::DatedDrafts,
            px(if narrow { 96. } else { 128. }),
            palette.input,
            cx,
        ))
        .child(
            div()
                .text_role(TextRole::Subtitle, cx)
                .text_color(palette.text)
                .text_center()
                .child(title.into()),
        )
        .children(action.map(|action| div().pt(px(6.)).child(action)))
        .into_any_element()
}
