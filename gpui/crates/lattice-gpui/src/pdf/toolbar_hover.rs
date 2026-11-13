//! The PDF toolbar's one hover fill (design call 2): its icon buttons are
//! rows of a horizontal fluid hover (`lattice_ui::fluid_hover`), so the fill
//! glides from button to button instead of each fading its own.

use gpui::{AnyElement, App, IntoElement, Window};
use lattice_ui::{
    ActiveLattice as _,
    fluid_hover::{Axis, FluidHover, FluidHoverSnapshot, ItemKind},
    shape,
};

use super::view::PdfView;

/// The toolbar's buttons as rows of its one gliding hover fill (design call
/// 2): a run of equal icon buttons with no selected item lights one 5% fill
/// that travels between them (`fluid_hover::Axis::Horizontal`), rather than
/// each button fading its own. A divider starts a new section, so the fill
/// fades across it instead of sliding through; a disabled button, or a
/// toggle that is on (it keeps its accent wash), clears the fill under the
/// pointer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Slot {
    Previous,
    Next,
    Back,
    Forward,
    Outline,
    ZoomOut,
    ZoomIn,
    Locate,
    FitWidth,
    FitHeight,
    DarkPages,
    Action,
    Save,
    Overflow,
}

impl Slot {
    /// Every slot, in the toolbar's order (each at its own index).
    const ALL: [Slot; 14] = [
        Slot::Previous,
        Slot::Next,
        Slot::Back,
        Slot::Forward,
        Slot::Outline,
        Slot::ZoomOut,
        Slot::ZoomIn,
        Slot::Locate,
        Slot::FitWidth,
        Slot::FitHeight,
        Slot::DarkPages,
        Slot::Action,
        Slot::Save,
        Slot::Overflow,
    ];

    /// The section the slot belongs to: the groups the toolbar's dividers
    /// (and its columns) separate.
    fn section(self) -> usize {
        match self {
            Slot::Previous | Slot::Next | Slot::Back | Slot::Forward => 0,
            Slot::Outline => 1,
            Slot::ZoomOut | Slot::ZoomIn => 2,
            Slot::Locate => 3,
            Slot::FitWidth
            | Slot::FitHeight
            | Slot::DarkPages
            | Slot::Action
            | Slot::Save
            | Slot::Overflow => 4,
        }
    }

    /// Record `button` as this slot of `strip`; `lands` is false for a
    /// button the fill must not promise (disabled, or a toggle that is on).
    pub(super) fn glide(
        self,
        strip: &FluidHover,
        lands: bool,
        button: impl IntoElement,
    ) -> AnyElement {
        let kind = if lands {
            ItemKind::target()
        } else {
            ItemKind::skip()
        };
        strip.item_as(self as usize, kind.section(self.section()), button)
    }
}

/// The section of the toolbar's button at `index` in its hover's rows: two
/// buttons of one section glide, across sections the fill fades.
pub fn toolbar_section(index: usize) -> Option<usize> {
    Slot::ALL.get(index).map(|slot| slot.section())
}

/// The toolbar's one hover fill: the sheet's 5% hover on a control's corner.
pub(super) fn toolbar_hover(window: &mut Window, cx: &mut App) -> FluidHover {
    let fill = cx.palette().hover;
    FluidHover::new("pdf-toolbar-hover", window, cx)
        .fill(fill)
        .radius(shape::RADIUS_TARGET)
        .axis(Axis::Horizontal)
}

impl PdfView {
    /// What the toolbar's hover fill shows now, for a scripted check.
    pub fn toolbar_hover_snapshot(&self, cx: &App) -> Option<FluidHoverSnapshot> {
        self.toolbar_hover.as_ref().map(|hover| hover.snapshot(cx))
    }
}

#[cfg(test)]
mod tests {
    use super::{Slot, toolbar_section};

    #[test]
    fn each_toolbar_slot_is_its_own_row_and_dividers_split_sections() {
        for (ix, slot) in Slot::ALL.iter().enumerate() {
            assert_eq!(*slot as usize, ix);
        }
        // Previous and Next glide; Zoom in and Reveal cursor are a divider
        // apart, so the fill fades between them.
        assert_eq!(toolbar_section(0), toolbar_section(1));
        assert_ne!(
            toolbar_section(Slot::ZoomIn as usize),
            toolbar_section(Slot::Locate as usize)
        );
        assert_eq!(
            toolbar_section(Slot::FitWidth as usize),
            toolbar_section(Slot::Save as usize)
        );
        assert_eq!(toolbar_section(Slot::ALL.len()), None);
    }
}
