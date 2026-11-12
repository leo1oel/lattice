//! Letter spacing: CSS's `letter-spacing`, for type that tracks its caps.
//!
//! A text style's `letter_spacing` (pixels, rems, or a fraction of the font
//! size, which is CSS's `em`) is resolved where a text element measures its
//! text, and is in effect on the window's line layout cache while that text
//! is shaped. The cache shapes as before and then spaces the glyphs, the way
//! it forces glyph widths for `force_width`: every glyph cluster moves right
//! by the spacing of the clusters before it, and the line grows by one
//! spacing per cluster, the last one included, as CSS lays it out. The
//! spacing is part of the cache key, so a line shaped at one spacing is never
//! handed out at another. Wrapping reads the spaced positions, so a line
//! breaks where the spaced text overflows.
//!
//! Limits, none of which the interface's tracked labels reach: the spacing
//! is per element rather than per run; ligatures stay joined and count as one
//! cluster, where a browser would split them; and truncation's first guess
//! sums unspaced character widths, before it is fitted to the shaped width.

use crate::{LineLayout, LineLayoutCache, Pixels, WindowTextSystem};
use std::cell::Cell;

/// The letter spacing lines are shaped with, kept on the line layout cache
/// (`LineShaping`).
#[derive(Default)]
pub(crate) struct LetterSpacing(Cell<Pixels>);

/// The spacing in effect on `cache`, which lines it shapes now are spaced by
/// and keyed with.
#[inline]
pub(crate) fn current(cache: &LineLayoutCache) -> Pixels {
    cache.shaping.letter_spacing.0.get()
}

/// Puts `spacing` in effect on the window's text system, returning the
/// spacing it replaces, to be put back with [`restore`].
pub(crate) fn begin(text_system: &WindowTextSystem, spacing: Pixels) -> Pixels {
    text_system
        .line_layout_cache
        .shaping
        .letter_spacing
        .0
        .replace(spacing)
}

/// Puts back the spacing [`begin`] replaced.
pub(crate) fn restore(text_system: &WindowTextSystem, previous: Pixels) {
    text_system
        .line_layout_cache
        .shaping
        .letter_spacing
        .0
        .set(previous);
}

/// Spaces a freshly shaped line by `spacing` after every glyph cluster.
pub(crate) fn apply(layout: &mut LineLayout, spacing: Pixels) {
    if spacing == Pixels::ZERO {
        return;
    }
    let mut clusters = 0;
    let mut cluster = None;
    for run in &mut layout.runs {
        for glyph in &mut run.glyphs {
            if cluster != Some(glyph.index) {
                if cluster.is_some() {
                    clusters += 1;
                }
                cluster = Some(glyph.index);
            }
            glyph.position.x += spacing * clusters as f32;
        }
    }
    if cluster.is_some() {
        clusters += 1;
    }
    layout.width += spacing * clusters as f32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        FontId, GlyphId, ShapedGlyph, ShapedRun, TestAppContext, div, point, prelude::*, px,
        relative,
    };

    fn glyph(x: f32, index: usize) -> ShapedGlyph {
        ShapedGlyph {
            id: GlyphId(0),
            position: point(px(x), px(0.)),
            index,
            is_emoji: false,
        }
    }

    fn line(glyphs: Vec<ShapedGlyph>, width: f32) -> LineLayout {
        LineLayout {
            font_size: px(10.),
            width: px(width),
            ascent: px(8.),
            descent: px(2.),
            runs: vec![ShapedRun {
                font_id: FontId(0),
                glyphs,
            }],
            len: 4,
        }
    }

    #[test]
    fn every_cluster_moves_by_the_spacing_before_it_and_the_line_grows_by_one_each() {
        let mut layout = line(
            vec![glyph(0., 0), glyph(5., 1), glyph(10., 2), glyph(15., 3)],
            20.,
        );
        apply(&mut layout, px(1.));
        let xs = layout.runs[0]
            .glyphs
            .iter()
            .map(|glyph| glyph.position.x)
            .collect::<Vec<_>>();
        assert_eq!(xs, [px(0.), px(6.), px(12.), px(18.)]);
        assert_eq!(layout.width, px(24.));
    }

    #[test]
    fn a_mark_moves_with_its_base() {
        // A combining mark shares its base's cluster.
        let mut layout = line(vec![glyph(0., 0), glyph(0., 0), glyph(5., 2)], 10.);
        apply(&mut layout, px(2.));
        let xs = layout.runs[0]
            .glyphs
            .iter()
            .map(|glyph| glyph.position.x)
            .collect::<Vec<_>>();
        assert_eq!(xs, [px(0.), px(0.), px(7.)]);
        assert_eq!(layout.width, px(14.));
    }

    #[test]
    fn no_spacing_leaves_the_line_alone() {
        let mut layout = line(vec![glyph(0., 0), glyph(5., 1)], 10.);
        apply(&mut layout, Pixels::ZERO);
        assert_eq!(layout.runs[0].glyphs[1].position.x, px(5.));
        assert_eq!(layout.width, px(10.));
    }

    #[gpui::test]
    fn tracked_text_measures_wider_by_a_spacing_per_character(cx: &mut TestAppContext) {
        struct View {
            spacing: Option<f32>,
        }
        impl crate::Render for View {
            fn render(
                &mut self,
                _: &mut crate::Window,
                _: &mut crate::Context<Self>,
            ) -> impl IntoElement {
                div().flex().child(
                    div()
                        .id("label")
                        .debug_selector(|| "label".into())
                        .text_size(px(10.))
                        .when_some(self.spacing, |this, spacing| {
                            this.letter_spacing(relative(spacing))
                        })
                        .child("CAPS"),
                )
            }
        }

        let (view, cx) = cx.add_window_view(|_, _| View { spacing: None });
        cx.run_until_parked();
        let plain = cx.debug_bounds("label").unwrap().size.width;

        view.update(cx, |view, cx| {
            view.spacing = Some(0.1);
            cx.notify();
        });
        cx.run_until_parked();
        let tracked = cx.debug_bounds("label").unwrap().size.width;
        // 0.1em of 10px after each of the four letters; the element rounds
        // its width up to a whole pixel.
        assert!(
            (tracked - plain - px(4.)).abs() <= px(1.),
            "plain {plain:?}, tracked {tracked:?}"
        );
    }
}
