//! A glyph's outline, for drawing shaped text where a glyph sprite can't go.
//!
//! GPUI draws a glyph as a sprite rasterized upright at its size, so text
//! can't be rotated or drawn along any other transform. An app that needs that
//! (Lattice's whiteboard rotates text elements) shapes the text with GPUI as
//! usual and draws each glyph's outline as a path under its own transform.
//! The outline is the platform's own, in font units (y up), so it is the same
//! face the shaper picked, fallback fonts included.
//!
//! Adapted from quiet.md's patch to gpui 0.2.2 (vendor/PATCHES.md #37,
//! `WindowTextSystem::glyph_outline`), Copyright (c) 2026 s1dashu, MIT:
//! https://github.com/s1dashu/quiet-md

use crate::{FontId, GlyphId, WindowTextSystem};

/// One step of a glyph outline, in font units with y up.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GlyphOutlineCmd {
    /// Starts a contour.
    MoveTo([f32; 2]),
    /// A straight segment.
    LineTo([f32; 2]),
    /// A quadratic Bézier segment: control point, end point.
    QuadTo([f32; 2], [f32; 2]),
    /// A cubic Bézier segment: two control points, end point.
    CubicTo([f32; 2], [f32; 2], [f32; 2]),
    /// Closes the contour.
    Close,
}

impl WindowTextSystem {
    /// The outline of a glyph of a font, in font units (`units_per_em`) with
    /// y up, or `None` for a bitmap glyph (color emoji) and on platforms
    /// whose text system has no outlines (only macOS has them).
    pub fn glyph_outline(
        &self,
        font_id: FontId,
        glyph_id: GlyphId,
    ) -> Option<Vec<GlyphOutlineCmd>> {
        self.platform_text_system.glyph_outline(font_id, glyph_id)
    }
}
