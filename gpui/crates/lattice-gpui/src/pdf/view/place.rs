//! Where a viewer is in its document.

use super::*;

/// Where a viewer is in its document, carried from the panel to the
/// separate window and back, and kept for back and forward over link jumps.
/// The top-left corner of the view is held as a point of the page under it,
/// in PDF points, so a viewer at another width (and so another fit scale)
/// shows the same place.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewPlace {
    pub(super) page: usize,
    pub(super) scale: f32,
    pub(super) fit: Option<FitMode>,
    pub(super) top: (usize, f32, f32),
}

impl ViewPlace {
    pub(super) fn scroll(&self) -> PendingScroll {
        let (page, x, y) = self.top;
        PendingScroll::PagePoint {
            page,
            x: Some(x),
            y,
            at_y: 0.,
        }
    }
}
