//! Glyphs drawn without font smoothing, as WebKit draws them under
//! `-webkit-font-smoothing: antialiased`.
//!
//! A CoreGraphics bitmap context smooths fonts unless told not to, and on
//! macOS smoothing thickens every stem: in the alpha-only context glyphs are
//! drawn into, black text (dilation 0, which upstream leaves at the context's
//! default) came out about 15% heavier than unsmoothed text for a Latin
//! monospace and 19% heavier for PingFang SC, and white text, which upstream
//! smooths at its strongest dilation, 38% and 51% heavier. An app whose
//! WebKit pages set `antialiased` (Lattice's Tauri app does, on its root)
//! draws all its text unsmoothed, so the same text drawn here looked bold
//! beside it, Chinese most of all.
//!
//! So every glyph is drawn with smoothing turned off, and no color asks for a
//! dilation: the glyph a color draws is the same for every color, and the
//! atlas keeps one copy of it.

use core_graphics::context::CGContext;

/// Glyphs are never smoothed, whatever the user's `AppleFontSmoothing`, so
/// no color asks for a dilation.
#[cfg(target_os = "macos")]
pub(crate) const NEVER_SMOOTH: bool = true;

/// Turns font smoothing off for the glyph about to be drawn into `cx`.
pub(crate) fn turn_off(cx: &CGContext) {
    cx.set_allows_font_smoothing(false);
    cx.set_should_smooth_fonts(false);
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use core_graphics::{
        base::{CGFloat, CGGlyph},
        color_space::CGColorSpace,
        context::CGContext,
        geometry::CGPoint,
    };
    use core_text::font as ct_font;
    use gpui::{
        Bounds, DevicePixels, FontRun, PlatformTextSystem, RenderGlyphParams, font, hsla, point, px,
    };

    use crate::AppleTextSystem;

    const SIZE: f32 = 14.;

    /// Draws `glyph` of Menlo into an alpha-only context the size of
    /// `bounds`, placed as `rasterize_glyph` places it, with smoothing on or
    /// off.
    fn reference(glyph: CGGlyph, bounds: Bounds<DevicePixels>, smooth: bool) -> Vec<u8> {
        let (width, height) = (bounds.size.width.0 as usize, bounds.size.height.0 as usize);
        let mut bytes = vec![0u8; width * height];
        let cx = CGContext::create_bitmap_context(
            Some(bytes.as_mut_ptr() as *mut _),
            width,
            height,
            8,
            width,
            &CGColorSpace::create_device_gray(),
            // kCGImageAlphaOnly, which core-graphics does not export.
            7,
        );
        cx.translate(
            -bounds.origin.x.0 as CGFloat,
            (bounds.origin.y.0 + bounds.size.height.0) as CGFloat,
        );
        cx.set_allows_antialiasing(true);
        cx.set_should_antialias(true);
        cx.set_allows_font_subpixel_positioning(true);
        cx.set_should_subpixel_position_fonts(true);
        cx.set_allows_font_subpixel_quantization(false);
        cx.set_should_subpixel_quantize_fonts(false);
        cx.set_allows_font_smoothing(smooth);
        cx.set_should_smooth_fonts(smooth);
        cx.set_gray_fill_color(if smooth { 1.0 } else { 0.0 }, 1.0);
        ct_font::new_from_name("Menlo-Regular", SIZE as CGFloat)
            .unwrap()
            .draw_glyphs(&[glyph], &[CGPoint::new(0., 0.)], cx);
        bytes
    }

    #[test]
    fn glyphs_are_drawn_unsmoothed_in_every_color() {
        let fonts = AppleTextSystem::new();
        let font_id = fonts.font_id(&font("Menlo")).unwrap();
        let text = "W";
        let runs = [FontRun {
            font_id,
            len: text.len(),
        }];
        let glyph = fonts.layout_line(text, px(SIZE), &runs).runs[0].glyphs[0].id;

        for color in [hsla(0., 0., 0., 1.), hsla(0., 0., 1., 1.)] {
            assert_eq!(fonts.glyph_dilation_for_color(color), 0, "{color:?}");
        }

        let params = RenderGlyphParams {
            font_id,
            glyph_id: glyph,
            font_size: px(SIZE),
            subpixel_variant: point(0, 0),
            scale_factor: 1.,
            is_emoji: false,
            subpixel_rendering: false,
            dilation: 0,
        };
        let bounds = fonts.glyph_raster_bounds(&params).unwrap();
        let (_, drawn) = fonts.rasterize_glyph(&params, bounds).unwrap();
        let unsmoothed = reference(glyph.0 as CGGlyph, bounds, false);
        let smoothed = reference(glyph.0 as CGGlyph, bounds, true);
        assert_ne!(
            unsmoothed, smoothed,
            "smoothing changes nothing here, so this test proves nothing"
        );
        assert_eq!(drawn, unsmoothed, "the glyph was drawn smoothed");
    }
}
