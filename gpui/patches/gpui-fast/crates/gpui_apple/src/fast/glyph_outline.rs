//! A glyph's outline from font-kit (CoreText), for
//! `PlatformTextSystem::glyph_outline` (`gpui::fast::glyph_outline`).
//!
//! Adapted from quiet.md's patch to gpui 0.2.2 (vendor/PATCHES.md #37),
//! Copyright (c) 2026 s1dashu, MIT: https://github.com/s1dashu/quiet-md

use font_kit::{font::Font, hinting::HintingOptions, outline::OutlineSink};
use gpui::{GlyphId, GlyphOutlineCmd};
use pathfinder_geometry::{line_segment::LineSegment2F, vector::Vector2F};

struct Sink(Vec<GlyphOutlineCmd>);

fn point(v: Vector2F) -> [f32; 2] {
    [v.x(), v.y()]
}

impl OutlineSink for Sink {
    fn move_to(&mut self, to: Vector2F) {
        self.0.push(GlyphOutlineCmd::MoveTo(point(to)));
    }
    fn line_to(&mut self, to: Vector2F) {
        self.0.push(GlyphOutlineCmd::LineTo(point(to)));
    }
    fn quadratic_curve_to(&mut self, ctrl: Vector2F, to: Vector2F) {
        self.0.push(GlyphOutlineCmd::QuadTo(point(ctrl), point(to)));
    }
    fn cubic_curve_to(&mut self, ctrl: LineSegment2F, to: Vector2F) {
        self.0.push(GlyphOutlineCmd::CubicTo(
            point(ctrl.from()),
            point(ctrl.to()),
            point(to),
        ));
    }
    fn close(&mut self) {
        self.0.push(GlyphOutlineCmd::Close);
    }
}

/// `glyph`'s outline in `font`'s units, y up; `None` when the font has no
/// outline for it.
pub(crate) fn outline(font: &Font, glyph: GlyphId) -> Option<Vec<GlyphOutlineCmd>> {
    let mut sink = Sink(Vec::new());
    font.outline(glyph.0, HintingOptions::None, &mut sink)
        .ok()?;
    Some(sink.0)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use gpui::{FontRun, GlyphOutlineCmd, PlatformTextSystem, font, px};

    use crate::AppleTextSystem;

    #[test]
    fn outlines_follow_the_shaped_glyph() {
        let fonts = AppleTextSystem::new();
        let font_id = fonts.font_id(&font("Menlo")).unwrap();
        let text = "O";
        let runs = [FontRun {
            font_id,
            len: text.len(),
        }];
        let glyph = fonts.layout_line(text, px(14.), &runs).runs[0].glyphs[0].id;
        let outline = fonts.glyph_outline(font_id, glyph).unwrap();
        let contours =
            |cmd: fn(&GlyphOutlineCmd) -> bool| outline.iter().filter(|c| cmd(c)).count();
        assert_eq!(
            contours(|c| matches!(c, GlyphOutlineCmd::MoveTo(_))),
            2,
            "{outline:?}"
        );
        assert_eq!(
            contours(|c| matches!(c, GlyphOutlineCmd::Close)),
            2,
            "{outline:?}"
        );

        let bounds = fonts.typographic_bounds(font_id, glyph).unwrap();
        for cmd in &outline {
            let (GlyphOutlineCmd::MoveTo(p)
            | GlyphOutlineCmd::LineTo(p)
            | GlyphOutlineCmd::QuadTo(_, p)
            | GlyphOutlineCmd::CubicTo(_, _, p)) = cmd
            else {
                continue;
            };
            assert!(
                p[0] >= bounds.origin.x - 1. && p[0] <= bounds.origin.x + bounds.size.width + 1.,
                "{p:?} outside {bounds:?}"
            );
            assert!(
                p[1] >= bounds.origin.y - 1. && p[1] <= bounds.origin.y + bounds.size.height + 1.,
                "{p:?} outside {bounds:?}"
            );
        }
    }
}
