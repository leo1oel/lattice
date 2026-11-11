//! The elevation ladder: page, panel, raised, popover, floating, dialog.
//!
//! A raised, popover, floating or dialog surface stands on the lift with a
//! 1px ring for its edge and its level's shadow, and never adds a border on
//! top (DESIGN.md, "Composing elevation"). A docked panel takes only a 1px
//! ring of the hairline at 70%. GPUI draws several box shadows in order, so
//! each level is the ring followed by the level's stack, as the CSS writes
//! `box-shadow: 0 0 0 1px var(--color-ring), var(--shadow-<level>)`.

use gpui::{BoxShadow, Hsla, point, px};

use crate::{Palette, token_types::ShadowToken, tokens::*};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Elevation {
    Raised,
    Popover,
    Floating,
    Dialog,
}

impl Elevation {
    fn token(self) -> ShadowToken {
        match self {
            Elevation::Raised => SHADOW_RAISED,
            Elevation::Popover => SHADOW_POPOVER,
            Elevation::Floating => SHADOW_FLOATING,
            Elevation::Dialog => SHADOW_DIALOG,
        }
    }

    /// The ring and the level's shadow, for a surface on `palette.raised`.
    pub fn shadows(self, palette: &Palette) -> Vec<BoxShadow> {
        let mut shadows = vec![ring(palette.ring)];
        shadows.extend(
            self.token()
                .get(palette.appearance)
                .iter()
                .map(|layer| layer.box_shadow()),
        );
        shadows
    }
}

/// A docked panel's edge: `0 0 0 1px` of the hairline at 70%.
pub fn panel_ring(palette: &Palette) -> Vec<BoxShadow> {
    vec![ring(palette.panel_ring)]
}

/// A compiled page on the PDF ground: paper on a desk, not interface.
pub fn pdf_page(palette: &Palette) -> Vec<BoxShadow> {
    SHADOW_PDF_PAGE
        .get(palette.appearance)
        .iter()
        .map(|layer| layer.box_shadow())
        .collect()
}

/// A 1px ring outside the element's edge, drawn as an unblurred shadow.
pub fn ring(color: Hsla) -> BoxShadow {
    BoxShadow {
        color,
        offset: point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(1.),
        inset: false,
    }
}

/// A 1px hairline along the inside of the bottom edge, as the titlebar's
/// `box-shadow: inset 0 -1px 0` draws it.
pub fn bottom_hairline(color: Hsla) -> BoxShadow {
    BoxShadow {
        color,
        offset: point(px(0.), px(-1.)),
        blur_radius: px(0.),
        spread_radius: px(0.),
        inset: true,
    }
}
