//! The card's raw log (`.compile-log`): the latexmk log in the editor's
//! face, opened where a failed build went wrong, floating at most 220px
//! tall or filling the docked strip.

use gpui::{
    AnyElement, App, IntoElement as _, ListState, ParentElement as _, Pixels, Styled as _, div,
    list, px, relative,
};
use lattice_ui::ActiveLattice as _;

use crate::build_panel::{BuildPanel, LastBuild};

/// The raw log's type and insets, which the floating box sizes itself by.
const LOG_TEXT_SIZE: f32 = 11.;
const LOG_LINE_HEIGHT: f32 = 1.45;
const LOG_PADDING_Y: f32 = 8.;
/// The floating log's cap (`.compile-log`'s `max-height`).
const LOG_MAX_HEIGHT: f32 = 220.;

pub(super) fn log_view(panel: &BuildPanel, last: &LastBuild, docked: bool, cx: &App) -> AnyElement {
    let lines = log_lines(&panel.card_log, last, cx);
    if docked {
        lines.flex_1().min_h_0().into_any_element()
    } else {
        lines
            .h(floating_log_height(last.log_lines.len()))
            .into_any_element()
    }
}

/// The floating log fits a short log and stops at its cap. The list only
/// measures the rows in view, so the box is sized from the line count: a
/// line that wraps only makes the log taller than this.
fn floating_log_height(lines: usize) -> Pixels {
    let content = lines as f32 * LOG_TEXT_SIZE * LOG_LINE_HEIGHT;
    px((content + 2. * LOG_PADDING_Y + 2.).min(LOG_MAX_HEIGHT))
}

/// The raw log, opened where a failed build went wrong rather than at
/// TeX's banner (the build panel scrolls it to the error's line). Its
/// lines wrap, so they are not one height: a `list` lays out only the
/// rows in view.
pub(super) fn log_lines(rows: &ListState, last: &LastBuild, cx: &App) -> gpui::Div {
    let palette = cx.palette().clone();
    let font = cx.lattice().fonts.editor.clone();
    let lines = last.log_lines.clone();
    div()
        .flex()
        .flex_col()
        .border_1()
        .border_color(palette.line_strong)
        .rounded(px(6.))
        .bg(palette.raised.opacity(0.9))
        .font_family(font)
        .text_size(px(LOG_TEXT_SIZE))
        .line_height(relative(LOG_LINE_HEIGHT))
        .text_color(palette.text)
        .child(
            list(rows.clone(), move |ix, _, _| {
                div().child(lines[ix].clone()).into_any_element()
            })
            .flex_1()
            .min_h_0()
            .py(px(LOG_PADDING_Y))
            .px(px(10.)),
        )
}
