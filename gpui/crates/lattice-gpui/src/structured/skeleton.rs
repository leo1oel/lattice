//! A Markdown file's page on its way (`document-skeleton.tsx` with
//! `shape="page"`, `document-skeleton.css`'s `data-page="markdown"`):
//! "Preparing preview…" drawn where the visual editor's column will be,
//! a title and blocks of lines in the strong border's ink on the editor's
//! ground, at the typeset size and its 1.7 line, until the page has drawn.
//! It waits on the loading clock first, so a quick open shows nothing.

use std::{cell::Cell, rc::Rc, time::Instant};

use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, Pixels, Styled as _, Window, canvas, div, px,
};
use lattice_ui::{ActiveLattice as _, reveal::loading_opacity};

/// A heading's width, or a paragraph's line widths (%), as `PAGE_BLOCKS`.
const BLOCKS: &[&[f32]] = &[
    &[58.],
    &[100., 97., 46.],
    &[40.],
    &[99., 100., 95., 100., 62.],
    &[98., 100., 84.],
    &[34.],
    &[100., 96., 100., 93., 100., 38.],
    &[97., 100., 71.],
];
/// `--type-typeset-size`.
const SIZE: f32 = 14.;
/// The reading measure.
const MEASURE: f32 = 760.;
/// The block controls' lanes either side of the text: two 20px lanes, a
/// hairline and two 6px gaps.
const GUTTER: f32 = 2. * 20. + 1. + 2. * 6.;
/// From 480px wide the heading rail takes a lane of its own before them.
const RAIL_FROM: f32 = 480.;
const RAIL: f32 = 12. + 2. * 24.;

/// The skeleton over a page `width` wide, as last measured.
pub(super) fn markdown_page(
    started: Instant,
    width: Rc<Cell<Pixels>>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let opacity = loading_opacity("markdown-preview-skeleton", started, window, cx);
    let ink = palette.line_strong;
    let pitch = SIZE * 1.7;
    let shown = f32::from(width.get());
    let centering = (shown - MEASURE) / 2.;
    let end = GUTTER.max(centering);
    let start = if shown >= RAIL_FROM {
        (RAIL + GUTTER).max(centering)
    } else {
        end
    };
    let column = div()
        .w_full()
        .pt(px(64.))
        .pl(px(start))
        .pr(px(end))
        .opacity(opacity)
        .children(BLOCKS.iter().enumerate().map(|(ix, block)| {
            if block.len() == 1 {
                // The first is the title: 1.8em at a 1.2 line; the others
                // 1.4em at a 1.3 line, 1.6em above, 0.45em below.
                let (em, line, above) = if ix == 0 {
                    (1.8, 1.2, 0.)
                } else {
                    (1.4, 1.3, 1.6)
                };
                let height = SIZE * em * line;
                div()
                    .mt(px(SIZE * em * above))
                    .mb(px(SIZE * em * 0.45))
                    .h(px(height))
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .w(gpui::relative(block[0] / 100.))
                            .h(px(height - 2. * SIZE * em * 0.3))
                            .rounded_full()
                            .bg(ink),
                    )
                    .into_any_element()
            } else {
                div()
                    .mb(px(SIZE * 0.85))
                    .children(block.iter().map(|width| {
                        div().h(px(pitch)).flex().items_center().child(
                            div()
                                .w(gpui::relative(width / 100.))
                                .h(px(8.))
                                .rounded_full()
                                .bg(ink),
                        )
                    }))
                    .into_any_element()
            }
        }));
    div()
        .absolute()
        .inset_0()
        .overflow_hidden()
        .bg(palette.editor)
        .child(
            canvas(
                move |bounds, _, _| width.set(bounds.size.width),
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        )
        .child(column)
        .into_any_element()
}
