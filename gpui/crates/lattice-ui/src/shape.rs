//! Corners: the radius steps, and the rule that nests one inside another.
//!
//! A surface held flush inside another's padding does not choose its own
//! corner: its curve has to run parallel to the outer one, or the inner
//! corner reads as pinched (<https://interactively.info/article/perfect-nested-rounded-corners>).
//! That is one relation, not two numbers to keep in sync by hand:
//!
//! ```text
//! inner radius = max(0, outer radius - inset - border)
//! ```
//!
//! The Tauri app writes it once, in `src/styles/surfaces.css`: a container
//! declares `--surface-radius` and `--surface-inset`, and what sits flush in
//! it takes `--nested-radius`. [`Nest`] is that pair here, and
//! [`Nest::inner`] the derived corner. It covers tight nesting (a menu's rows,
//! a panel's tabs, a segmented control's thumb, a tab's close square); a card
//! with generous padding is not nesting, and keeps its own corner.
//!
//! The app draws its nested corners as squircles where the engine can
//! (`corner-shape: squircle`), on the step scaled by `--corner-smoothing`
//! (1.84) so the squircle cuts as deep as the round corner it replaces; the
//! factor scales the outer corner and the derived inner one alike, and the
//! derivation happens before it (`outer - inset`, then the factor). GPUI
//! draws round corners only. [`Corners`] says which of the two drawings a
//! surface copies, so a nested corner and its container always take the same
//! one ([`Nest::painted`]).

use gpui::{Pixels, px};

use crate::tokens::{
    RADIUS_COMPACT, RADIUS_CONTROL, RADIUS_DIALOG, RADIUS_PANEL, SPACING_2, SPACING_3,
};

/// A design token's size at the 16px root the app lays out on.
pub const fn rem(rems: gpui::Rems) -> Pixels {
    px(rems.0 * 16.)
}

/// `--corner-smoothing` where the engine draws squircles:
/// `(1 - 2^-1/2) / (1 - 2^-1/4)`, the depth a round corner cuts on the
/// diagonal over the depth a squircle of the same radius cuts (`foundations.css`).
pub const CORNER_SMOOTHING: f32 = 1.840_896_4;

/// The radius steps (`docs/design-system.md`, Geometry): a chip, anything a
/// pointer lands on, a surface, a dialog.
pub const RADIUS_CHIP: Pixels = rem(RADIUS_COMPACT);
pub const RADIUS_TARGET: Pixels = rem(RADIUS_CONTROL);
pub const RADIUS_SURFACE: Pixels = rem(RADIUS_PANEL);
pub const RADIUS_MODAL: Pixels = rem(RADIUS_DIALOG);

/// Which drawing of a corner a surface copies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Corners {
    /// The step as it is: the round corner the app draws where `corner-shape`
    /// is unknown, and the corner the step designs.
    Round,
    /// The step scaled by [`CORNER_SMOOTHING`], as Paper's App screens (and
    /// any engine with `corner-shape`) measure a squircle's radius. The
    /// docked panels and their tab chips are drawn this way, because their
    /// parity target is Paper's Main window (18.4px panels, 11px tabs).
    Smoothed,
}

impl Corners {
    /// The radius drawn for the design radius `radius`.
    pub fn paint(self, radius: Pixels) -> Pixels {
        match self {
            Corners::Round => radius,
            Corners::Smoothed => radius * CORNER_SMOOTHING,
        }
    }
}

/// A container's corner and the inset its flush children stand at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Nest {
    /// The container's design radius (`--surface-radius`), before smoothing.
    pub radius: Pixels,
    /// The interior spacing to the child (`--surface-inset`), usually the
    /// container's padding.
    pub inset: Pixels,
    /// The container's border width; zero for a ring drawn as a shadow.
    pub border: Pixels,
    /// The smallest corner a child may take: where the rule would cut below
    /// a control's corner, the app holds it there (Trellis's tabs,
    /// `max(var(--radius-control), …)`). Zero for none.
    pub floor: Pixels,
}

impl Nest {
    pub const fn new(radius: Pixels, inset: Pixels) -> Self {
        Self {
            radius,
            inset,
            border: px(0.),
            floor: px(0.),
        }
    }

    pub const fn border(mut self, border: Pixels) -> Self {
        self.border = border;
        self
    }

    pub const fn floor(mut self, floor: Pixels) -> Self {
        self.floor = floor;
        self
    }

    /// The child's design radius: `max(floor, max(0, radius - inset - border))`.
    pub fn inner(self) -> Pixels {
        let derived = (self.radius - self.inset - self.border).max(px(0.));
        derived.max(self.floor)
    }

    /// The container's and the child's radii as drawn, both on `corners`.
    pub fn painted(self, corners: Corners) -> (Pixels, Pixels) {
        (corners.paint(self.radius), corners.paint(self.inner()))
    }

    /// The nest a child surface hands its own children: `inset` further in,
    /// on the child's corner.
    pub fn within(self, inset: Pixels) -> Nest {
        Nest::new(self.inner(), inset)
    }
}

/// A menu, select or context menu: the 10px surface corner with a 4px inset
/// (`menu-surface.ts`), so its rows keep a control's 6px.
pub const MENU: Nest = Nest::new(RADIUS_SURFACE, px(4.));

/// A docked panel and its tab strip (`trellis.css`): the surface corner, its
/// tabs `--trellis-tab-inset` in ((40 - 28) / 2 = 6px), held at a control's
/// corner. Panels draw it [`Corners::Smoothed`].
pub const PANEL_TABS: Nest = Nest::new(RADIUS_SURFACE, rem(SPACING_3)).floor(RADIUS_TARGET);

/// A segmented control's track (`chrome.css`, `.ui-segmented`): a control's
/// corner with a 2px inset, so the thumb's corner is 4px.
pub const SEGMENTED: Nest = Nest::new(RADIUS_TARGET, px(2.));

/// The quick-open list inside the command palette (`app-shell.css`,
/// `.quick-open-list`): the dialog's corner with a 6px inset.
pub const PALETTE_LIST: Nest = Nest::new(RADIUS_MODAL, rem(SPACING_3));

/// A compact menu that opens in place (`surfaces.css`, `.venue-menu`): the
/// surface corner with a 4px inset.
pub const IN_PLACE_MENU: Nest = Nest::new(RADIUS_SURFACE, rem(SPACING_2));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_menu_row_keeps_a_controls_corner() {
        // design-system.md: "A menu stands on the 10px surface corner with a
        // 4px inset, so its rows keep a control's 6px."
        assert_eq!(MENU.inner(), RADIUS_TARGET);
        assert_eq!(MENU.inner(), px(6.));
    }

    #[test]
    fn the_rule_subtracts_inset_and_border_and_never_goes_negative() {
        let nest = Nest::new(px(12.), px(4.)).border(px(1.));
        assert_eq!(nest.inner(), px(7.));
        assert_eq!(Nest::new(px(4.), px(8.)).inner(), px(0.));
    }

    #[test]
    fn a_panel_tab_is_held_at_a_controls_corner_and_smoothed_with_its_panel() {
        // trellis.css: max(--radius-control, --radius-surface - inset), then
        // the factor: 6 * 1.84 = 11.05, the 11px Paper's Main window measures.
        assert_eq!(PANEL_TABS.inset, px(6.));
        assert_eq!(PANEL_TABS.inner(), px(6.));
        let (panel, tab) = PANEL_TABS.painted(Corners::Smoothed);
        assert!((f32::from(panel) - 18.4).abs() < 0.01, "{panel:?}");
        assert!((f32::from(tab) - 11.05).abs() < 0.01, "{tab:?}");
    }

    #[test]
    fn smoothing_applies_after_the_derivation() {
        // `outer - inset` before the factor, never after: the inset holds
        // along the diagonal.
        let nest = Nest::new(px(10.), px(4.));
        let (outer, inner) = nest.painted(Corners::Smoothed);
        assert!((f32::from(outer - inner) - 4. * CORNER_SMOOTHING).abs() < 1e-3);
        assert_eq!(nest.painted(Corners::Round), (px(10.), px(6.)));
    }

    #[test]
    fn nests_chain_inward() {
        // A dialog's list, then a row's chip 4px inside the row.
        let row = PALETTE_LIST.inner();
        assert_eq!(row, px(8.));
        assert_eq!(PALETTE_LIST.within(px(4.)).inner(), px(4.));
        assert_eq!(SEGMENTED.inner(), px(4.));
        assert_eq!(IN_PLACE_MENU.inner(), px(6.));
    }
}
