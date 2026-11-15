//! Where a hover card over the PDF stands, as floating-ui places the Tauri
//! app's PDF cards (`computePosition` with `placement: "top"`, `offset(8)`,
//! `flip()` and `shift({ padding: 8 })`): centred above what it is about,
//! below when it would cross the window's top, and kept 8px inside the
//! window's sides. Its size is last frame's, and a card drawn at another
//! size is placed again; it enters as every hover card does
//! (`.popup-motion`).

use std::{cell::Cell, rc::Rc};

use gpui::{
    Anchor as Corner, AnyElement, Bounds, IntoElement, ParentElement as _, Pixels, SharedString,
    Styled as _, anchored, canvas, deferred, point, px,
};
use lattice_ui::components::{PopFrom, pop_in};

use super::*;

/// The card's gap from what it is about, and from the window's edges.
pub(in crate::pdf) const CARD_GAP: Pixels = px(8.);

/// Where a hover card stood last frame.
pub(in crate::pdf) type CardBounds = Rc<Cell<Option<Bounds<Pixels>>>>;

impl PdfView {
    /// The window bounds of the box (`x0, y0, x1, y1`, PDF points from the
    /// top-left corner of `page`).
    pub(in crate::pdf) fn page_box_on_window(
        &self,
        page: usize,
        (x0, y0, x1, y1): (f32, f32, f32, f32),
    ) -> Option<Bounds<Pixels>> {
        let rect = self.layout.page(page)?;
        let scale = self.layout.scale;
        let (scroll_x, scroll_y) = self.scroll_offset();
        let origin = self.viewport.origin;
        Some(Bounds::from_corners(
            point(
                origin.x + px(rect.x + x0 * scale - scroll_x),
                origin.y + px(rect.y + y0 * scale - scroll_y),
            ),
            point(
                origin.x + px(rect.x + x1 * scale - scroll_x),
                origin.y + px(rect.y + y1 * scale - scroll_y),
            ),
        ))
    }

    /// `content` (the card, `width` wide before it has drawn) standing over
    /// `about`, recording where it drew in `painted`.
    #[allow(clippy::too_many_arguments)]
    pub(in crate::pdf) fn hover_card(
        &self,
        id: SharedString,
        about: Bounds<Pixels>,
        width: Pixels,
        painted: CardBounds,
        content: impl IntoElement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.popup_over(id, about, width, painted, content, false, window, cx)
    }

    /// `content` placed as [`Self::hover_card`] is, or, with `below`, as a
    /// note being written is (`usePdfAnchoredPopup`, `side: "below"`): under
    /// what it is about from its left edge, above it when there is no room.
    #[allow(clippy::too_many_arguments)]
    pub(in crate::pdf) fn popup_over(
        &self,
        id: SharedString,
        about: Bounds<Pixels>,
        width: Pixels,
        painted: CardBounds,
        content: impl IntoElement,
        below: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let last = painted.get().map(|card| card.size);
        let window_size = window.viewport_size();
        let window_width = window_size.width;
        let width = last.map_or(width, |size| size.width);
        let height = last.map_or(px(0.), |size| size.height);
        let fits_above = about.top() - CARD_GAP - height >= CARD_GAP;
        let fits_below = about.bottom() + CARD_GAP + height <= window_size.height - CARD_GAP;
        let above = if below { !fits_below && fits_above } else { fits_above };
        let start = if below {
            about.left()
        } else {
            about.center().x - width / 2.
        };
        let left = start.min(window_width - CARD_GAP - width).max(CARD_GAP);
        let (at, anchor, from) = if above {
            (
                point(left, about.top() - CARD_GAP),
                Corner::BottomLeft,
                PopFrom::Below,
            )
        } else {
            (
                point(left, about.bottom() + CARD_GAP),
                Corner::TopLeft,
                PopFrom::Above,
            )
        };
        let view = cx.entity().downgrade();
        let record = canvas(
            move |bounds, _, cx| {
                let resized = painted.get().map(|card| card.size) != Some(bounds.size);
                painted.set(Some(bounds));
                if resized {
                    cx.defer(move |cx| {
                        view.update(cx, |_, cx| cx.notify()).ok();
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        deferred(
            anchored()
                .position(at)
                .anchor(anchor)
                .snap_to_window_with_margin(CARD_GAP)
                .child(pop_in(
                    id,
                    from,
                    gpui::div().relative().child(content).child(record),
                )),
        )
        .with_priority(1)
        .into_any_element()
    }
}
