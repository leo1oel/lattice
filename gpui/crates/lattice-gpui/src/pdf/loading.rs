//! A PDF on its way, as the Tauri app's `pdf-loading.tsx` shows it: one
//! indicator. The first load is a skeleton of the page where the page will
//! be; a refresh of a PDF already on screen is a small "Updating…" status
//! over it. Either waits on the loading clock first (150 ms, then a fade on
//! the fast tier), so a PDF that loads at once flashes neither.
//!
//! The skeleton (`.pdf-skeleton`, `pdf-viewer.css`): a Letter page (the size
//! LaTeX's classes default to; the paper's own size is not known yet) inside
//! the same 8px border as the pages, at the top, as wide as a width-fitted
//! page, as tall as a height-fitted one, or at the zoom's width. It is a
//! raised card with a hairline ring in each theme rather than paper: a
//! bright page that is not the paper yet would glare in the dark theme. On
//! it, in the strong border's ink: a title, a short title, a byline, an
//! abstract, two columns of prose, a figure and two more columns, with the
//! sheen passing over them. The download's progress bar is not drawn: the
//! file is read whole from disk, so there is no progress to show.

use std::time::Instant;

use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, Pixels, Styled as _, Window, div,
    prelude::FluentBuilder as _, px, relative,
};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, reveal::loading_opacity};

use super::layout::{FitMode, PAGE_INSET};

/// A US Letter page's width in points: its width at 100%.
const LETTER_WIDTH: f32 = 612.;
/// Letter's height over its width.
const LETTER_RATIO: f32 = 11. / 8.5;

/// Line widths (%) of the skeleton's two text columns, varied so they read
/// as prose; 0 is a paragraph break (`COLUMNS`).
const COLUMNS: [[f32; 12]; 2] = [
    [100., 94., 98., 88., 100., 62., 0., 96., 100., 91., 97., 70.],
    [
        97., 100., 90., 100., 84., 0., 100., 95., 99., 87., 100., 58.,
    ],
];
const ABSTRACT: [f32; 4] = [100., 100., 100., 74.];
/// `--space-2`, between the skeleton's lines.
const LINE_GAP: f32 = 4.;

/// The first load's skeleton over an area `area` wide and high (the pages'
/// viewport with its border), for a page that opens at `fit`, or at
/// `scale` when it opens at a zoom.
pub(super) fn skeleton(
    started: Instant,
    area: (Pixels, Pixels),
    fit: Option<FitMode>,
    scale: f32,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let opacity = loading_opacity("pdf-skeleton", started, window, cx);
    let inner_width = (f32::from(area.0) - 2. * PAGE_INSET).max(0.);
    let inner_height = (f32::from(area.1) - 2. * PAGE_INSET).max(0.);
    let width = match fit {
        Some(FitMode::Width) => inner_width,
        Some(FitMode::Height) => inner_height / LETTER_RATIO,
        None => (LETTER_WIDTH * scale).round(),
    };
    let height = width * LETTER_RATIO;
    // `padding: 9% 8%`, both of the page's width; the lines' heights are of
    // what is left of its height.
    let (pad_y, pad_x) = (width * 0.09, width * 0.08);
    let content = width - 2. * pad_x;
    let tall = height - 2. * pad_y;
    let line_height = (tall * 0.011).max(3.);
    let ink = palette.line_strong;
    let bar = |percent: f32, height: f32| {
        div()
            .flex_none()
            .w(relative(percent / 100.))
            .h(px(height))
            .rounded_full()
            .bg(ink)
    };
    let columns =
        |reverse: bool| {
            div()
                .w_full()
                .flex()
                .gap(px(content * 0.07))
                .children(COLUMNS.iter().map(|lines| {
                    let mut lines = lines.to_vec();
                    if reverse {
                        lines.reverse();
                    }
                    div().flex_1().flex().flex_col().gap(px(LINE_GAP)).children(
                        lines.into_iter().map(|percent| {
                            // A paragraph break keeps its line's place, unseen.
                            bar(if percent == 0. { 100. } else { percent }, line_height)
                                .when(percent == 0., |line| line.bg(gpui::transparent_black()))
                        }),
                    )
                }))
        };
    let page = div()
        .relative()
        .overflow_hidden()
        .flex_none()
        .w(px(width))
        .h(px(height))
        .mx_auto()
        .py(px(pad_y))
        .px(px(pad_x))
        .rounded(lattice_ui::tokens::RADIUS_COMPACT)
        .bg(palette.raised)
        .border_1()
        .border_color(palette.line)
        .flex()
        .flex_col()
        .items_center()
        .gap(px(LINE_GAP))
        .child(bar(72., (tall * 0.024).max(3.)))
        .child(bar(48., (tall * 0.024).max(3.)))
        .child(
            bar(36., line_height)
                .mt(px(content * 0.03))
                .mb(px(content * 0.05)),
        )
        .child(
            div()
                .w(relative(0.78))
                .mb(px(content * 0.06))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(LINE_GAP))
                .children(ABSTRACT.iter().map(|percent| bar(*percent, line_height))),
        )
        .child(columns(false))
        .child(
            div()
                .flex_none()
                .w(relative(0.64))
                .h(px(tall * 0.16))
                .my(px(content * 0.05))
                .rounded(lattice_ui::tokens::RADIUS_COMPACT)
                .bg(palette.line),
        )
        .child(columns(true))
        .children(lattice_ui::loading::sheen(
            "pdf-skeleton-sheen",
            palette.raised,
            cx,
        ));
    div()
        .absolute()
        .inset_0()
        .overflow_hidden()
        .p(px(PAGE_INSET))
        .opacity(opacity)
        .flex()
        .flex_col()
        .child(page)
        .into_any_element()
}

/// A refresh of the PDF on screen: "Updating…" over the top of the pages
/// (`.pdf-loading.pdf-loading-quiet`), at 85%.
pub(super) fn updating(started: Instant, window: &mut Window, cx: &mut App) -> AnyElement {
    let palette = cx.palette().clone();
    let opacity = loading_opacity("pdf-updating", started, window, cx);
    div()
        .absolute()
        .top(px(12.))
        .left_0()
        .right_0()
        .flex()
        .justify_center()
        .opacity(opacity * 0.85)
        .child(
            div()
                .max_w(relative(1.))
                .mx(px(8.))
                .min_h(lattice_ui::tokens::SPACING_CONTROL_COMPACT)
                .px(px(10.))
                .py(px(4.))
                .rounded(lattice_ui::tokens::RADIUS_CONTROL)
                .bg(palette.raised)
                .shadow(lattice_ui::Elevation::Popover.shadows(&palette))
                .flex()
                .flex_wrap()
                .items_center()
                .justify_center()
                .gap(px(6.))
                .text_role(TextRole::Micro, cx)
                .text_color(palette.text_secondary)
                .child(crate::build::chip_mark::infinity_loader(
                    "pdf-updating-loader",
                    px(14.),
                    &palette,
                ))
                .child(t!("Updating…")),
        )
        .into_any_element()
}

impl super::PdfView {
    /// Which indicator a load under way shows: `"skeleton"` for a first
    /// load, `"updating"` for a refresh of the PDF on screen; `None` when
    /// nothing loads. For a scenario.
    pub fn loading_indicator(&self) -> Option<&'static str> {
        self.loading.then(|| {
            if self.document.is_some() {
                "updating"
            } else {
                "skeleton"
            }
        })
    }
}
