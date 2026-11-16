//! Backdrop blur: CSS's `backdrop-filter: blur(r)`, for the frosted popovers
//! that hover over a page and let it show through, blurred.
//!
//! `Styled::backdrop_blur(radius, fallback)` asks for it on an element, and
//! `Window::paint_backdrop_blur` paints it: before the element's shadows and
//! background, the renderer blurs what is already drawn under the element's
//! rounded rectangle, as a Gaussian whose standard deviation is `radius` (as
//! CSS's is), and draws that back clipped to the rectangle and the content
//! mask. The element's own background then goes over it, translucent.
//!
//! The scene carries a backdrop as a polychrome sprite whose texture id is
//! [`BACKDROP_TEXTURE_INDEX`], an index no atlas allocates, as it carries
//! scroll layer tiles and rounded clip groups. So everything that copies,
//! replays, translates, scales, splits or reorders a scene's primitives (a
//! retained view, a scroll layer's tiles, a rounded clip group, the window's
//! composition surfaces) carries the backdrop along with the rest, at its
//! draw order, and no primitive's layout changes. The sprite's `tile` holds
//! what a sprite has no field for: the blur's standard deviation in device
//! pixels (`padding`, as `f32` bits) and the fallback colour (`bounds`, the
//! four `Rgba` channels as `f32` bits).
//!
//! The fallback colour is what a renderer fills the rounded rectangle with
//! where it cannot read what is under it: a surface drawn over native views
//! (whose pixels are not GPUI's), a scroll layer's tile (which holds only a
//! piece of its layer), a renderer without a backdrop pass. A popover there
//! is solid rather than showing its 3% of page unblurred, which reads as
//! ghost text. Inside a `Window::paint_layer` everything shares one draw
//! order and sprites draw after quads, so a backdrop painted there would
//! cover the element it is under; the fallback is painted there instead, as
//! a quad.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AtlasTextureId, AtlasTextureKind, AtlasTile, Bounds, ContentMask, Corners, DevicePixels, Hsla,
    Pixels, PolychromeSprite, Primitive, Rgba, ScaledPixels, Style, TileId, Window, point, quad,
    size,
};

/// The texture index of a backdrop sprite. Atlases allocate indices from 0,
/// scroll layer tiles take `0xF000_0000..0xF100_0000` and rounded clip groups
/// the indices above those.
pub const BACKDROP_TEXTURE_INDEX: u32 = 0xFF00_0000;

/// An element's backdrop blur, as `Styled::backdrop_blur` sets it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackdropBlur {
    /// The Gaussian's standard deviation, CSS's `blur()` radius.
    pub radius: Pixels,
    /// What the element's rounded rectangle is filled with where the renderer
    /// cannot read what is under it, usually the element's background made
    /// opaque.
    pub fallback: Hsla,
}

/// A backdrop the scene holds, decoded from its sprite, for a renderer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Backdrop {
    /// The rectangle blurred and drawn back, in device pixels.
    pub bounds: Bounds<ScaledPixels>,
    /// Where it may draw.
    pub content_mask: ContentMask<ScaledPixels>,
    /// The rectangle's corner radii.
    pub corner_radii: Corners<ScaledPixels>,
    /// The Gaussian's standard deviation, in device pixels.
    pub sigma: ScaledPixels,
    /// What fills the rectangle where what is under it cannot be read.
    pub fallback: Rgba,
    /// The element's opacity.
    pub opacity: f32,
}

/// Whether sprites of `texture` are backdrops.
pub fn is_backdrop_texture(texture: AtlasTextureId) -> bool {
    texture.index == BACKDROP_TEXTURE_INDEX && texture.kind == AtlasTextureKind::Polychrome
}

impl Backdrop {
    /// The backdrop `sprite` stands for, if it is one.
    pub fn decode(sprite: &PolychromeSprite) -> Option<Self> {
        if !is_backdrop_texture(sprite.tile.texture_id) {
            return None;
        }
        let channels = sprite.tile.bounds;
        let channel = |bits: DevicePixels| f32::from_bits(bits.0 as u32);
        Some(Self {
            bounds: sprite.bounds,
            content_mask: sprite.content_mask,
            corner_radii: sprite.corner_radii,
            sigma: ScaledPixels(f32::from_bits(sprite.tile.padding)),
            fallback: Rgba {
                r: channel(channels.origin.x),
                g: channel(channels.origin.y),
                b: channel(channels.size.width),
                a: channel(channels.size.height),
            },
            opacity: sprite.opacity,
        })
    }

    /// The sprite the scene carries this backdrop as.
    pub fn sprite(&self) -> PolychromeSprite {
        let channel = |value: f32| DevicePixels(value.to_bits() as i32);
        PolychromeSprite {
            order: 0,
            pad: 0,
            tile: AtlasTile {
                texture_id: AtlasTextureId {
                    index: BACKDROP_TEXTURE_INDEX,
                    kind: AtlasTextureKind::Polychrome,
                },
                tile_id: TileId(0),
                padding: self.sigma.0.to_bits(),
                bounds: Bounds {
                    origin: point(channel(self.fallback.r), channel(self.fallback.g)),
                    size: size(channel(self.fallback.b), channel(self.fallback.a)),
                },
            },
            grayscale: false.into(),
            opacity: self.opacity,
            bounds: self.bounds,
            content_mask: self.content_mask,
            corner_radii: self.corner_radii,
        }
    }
}

/// Whether `primitive` is a backdrop: something a scroll layer must draw
/// over its composited tiles rather than into them, as it does a path.
pub(crate) fn is_backdrop(primitive: &Primitive) -> bool {
    matches!(primitive, Primitive::PolychromeSprite(sprite) if is_backdrop_texture(sprite.tile.texture_id))
}

/// Scales a backdrop's blur with the element transform that scales its
/// bounds (`fast::scale`); other sprites are left as they are.
pub(crate) fn scale_sigma(sprite: &mut PolychromeSprite, scale: f32) {
    if is_backdrop_texture(sprite.tile.texture_id) {
        let sigma = f32::from_bits(sprite.tile.padding) * scale;
        sprite.tile.padding = sigma.to_bits();
    }
}

/// Forwarded to by `Style::paint` before the element's shadows and
/// background.
pub(crate) fn paint(
    style: &Style,
    bounds: Bounds<Pixels>,
    corner_radii: Corners<Pixels>,
    window: &mut Window,
) {
    if let Some(blur) = style.backdrop_blur {
        window.paint_backdrop_blur(bounds, corner_radii, blur);
    }
}

impl Window {
    /// Blurs what is painted under `bounds` so far by `blur.radius` (CSS's
    /// `backdrop-filter: blur()`), drawn back inside its rounded corners and
    /// the current content mask. Paint the element's translucent background
    /// over it. Where the renderer cannot read what is under it, the
    /// rectangle is filled with `blur.fallback` instead.
    ///
    /// This method should only be called as part of the paint phase of
    /// element drawing.
    pub fn paint_backdrop_blur(
        &mut self,
        bounds: Bounds<Pixels>,
        corner_radii: Corners<Pixels>,
        blur: BackdropBlur,
    ) {
        self.invalidator.debug_assert_paint();
        if bounds.is_empty() {
            return;
        }
        let opacity = self.element_opacity();
        // Only Metal draws backdrops; elsewhere, and where every primitive
        // shares one draw order, the fallback is an ordinary quad.
        if !cfg!(any(target_os = "macos", target_os = "ios"))
            || self.next_frame.scene.in_layer()
            || blur.radius <= Pixels::ZERO
        {
            self.paint_quad(quad(
                bounds,
                corner_radii,
                blur.fallback,
                crate::Edges::default(),
                crate::transparent_black(),
                Default::default(),
            ));
            return;
        }
        let scale_factor = self.scale_factor();
        let backdrop = Backdrop {
            bounds: self.snap_bounds(bounds),
            content_mask: self.snapped_content_mask(),
            corner_radii: corner_radii.scale(scale_factor),
            sigma: blur.radius.scale(scale_factor),
            fallback: blur.fallback.to_rgb(),
            opacity,
        };
        self.next_frame.scene.insert_primitive(backdrop.sprite());
    }
}

#[cfg(test)]
#[path = "backdrop_tests.rs"]
mod tests;
