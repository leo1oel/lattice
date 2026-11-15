//! The timeline's day names stay in view over their rows
//! (`history-timeline.css`'s `.history-day-label`: `position: sticky; top: 0`).
//!
//! GPUI has no sticky positioning, so each day records where its rows and its
//! name were laid out, in the timeline's own coordinates (unmoved by
//! scrolling), as it paints; the panel then draws the day whose rows cross
//! the top of the scrolled area as a copy of its name pinned there, over the
//! rows, pushed up by the next day's name as that one arrives, as a sticky
//! element is. A day whose band moved since the panel last drew asks it to
//! draw again, so the pinned name follows a scroll the frame after.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use gpui::{
    AnyElement, App, Bounds, Entity, IntoElement, ParentElement as _, Pixels, ScrollHandle,
    SharedString, Styled as _, canvas, div, px,
};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, tokens::FONT_WEIGHT_MEDIUM};

/// One day as last painted, in the timeline's coordinates.
#[derive(Clone, Debug, PartialEq)]
struct Band {
    name: SharedString,
    /// Its name's and rows' top and bottom.
    top: Pixels,
    bottom: Pixels,
    /// Its name's height.
    label: Pixels,
}

#[derive(Default)]
pub(super) struct StickyDays {
    bands: RefCell<Vec<Option<Band>>>,
    /// The scrolled area's top, in the window, as last painted.
    viewport_top: Cell<Pixels>,
    /// The day pinned when the panel last drew, and where.
    shown: RefCell<Option<(usize, Pixels)>>,
}

impl StickyDays {
    /// Forget the days: the timeline is drawn anew with `count` of them.
    pub(super) fn reset(&self, count: usize) {
        let mut bands = self.bands.borrow_mut();
        bands.truncate(count);
        bands.resize(count, None);
    }

    /// The name pinned at the top for a scroll of `scrolled` (≥ 0), and
    /// how far up the next day's name pushes it.
    fn pinned(&self, scrolled: Pixels) -> Option<(usize, Pixels)> {
        let bands = self.bands.borrow();
        bands.iter().enumerate().find_map(|(index, band)| {
            let band = band.as_ref()?;
            (band.top < scrolled && band.bottom > scrolled)
                .then(|| (index, (band.bottom - scrolled - band.label).min(px(0.))))
        })
    }

    /// The scrolled area's top, in the window, as last painted.
    pub(super) fn viewport_top(&self) -> Pixels {
        self.viewport_top.get()
    }

    /// A probe filling the scrolled area: where its top is.
    pub(super) fn viewport_probe(self: &Rc<Self>) -> AnyElement {
        let this = self.clone();
        canvas(
            move |bounds: Bounds<Pixels>, _, _| this.viewport_top.set(bounds.origin.y),
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0()
        .into_any_element()
    }

    /// A probe filling day `index`'s band (its name and its rows), named
    /// `name`, with the name `label` tall.
    pub(super) fn day_probe<V: 'static>(
        self: &Rc<Self>,
        index: usize,
        name: SharedString,
        label: Rc<Cell<Pixels>>,
        scroll: ScrollHandle,
        view: &Entity<V>,
    ) -> AnyElement {
        let this = self.clone();
        let view = view.downgrade();
        canvas(
            move |bounds: Bounds<Pixels>, _, cx: &mut App| {
                let offset = this.viewport_top.get() + scroll.offset().y;
                let band = Band {
                    name: name.clone(),
                    top: bounds.origin.y - offset,
                    bottom: bounds.origin.y + bounds.size.height - offset,
                    label: label.get(),
                };
                let changed = {
                    let mut bands = this.bands.borrow_mut();
                    if bands.len() <= index {
                        bands.resize(index + 1, None);
                    }
                    let changed = bands[index].as_ref() != Some(&band);
                    bands[index] = Some(band);
                    changed
                };
                let scrolled = (-scroll.offset().y).max(px(0.));
                if changed || this.pinned(scrolled) != *this.shown.borrow() {
                    view.update(cx, |_, cx| cx.notify()).ok();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0()
        .into_any_element()
    }

    /// A probe filling a day's name: its height.
    pub(super) fn label_probe(label: Rc<Cell<Pixels>>) -> AnyElement {
        canvas(
            move |bounds: Bounds<Pixels>, _, _| label.set(bounds.size.height),
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0()
        .into_any_element()
    }

    /// The pinned name over the top of the scrolled area, inset as the
    /// timeline is (`inset`), or nothing while every day's name is in view.
    pub(super) fn render(&self, scroll: &ScrollHandle, inset: Pixels, cx: &App) -> Option<AnyElement> {
        let scrolled = (-scroll.offset().y).max(px(0.));
        let pinned = self.pinned(scrolled);
        *self.shown.borrow_mut() = pinned;
        let (index, shift) = pinned?;
        let name = self.bands.borrow().get(index)?.as_ref()?.name.clone();
        let palette = cx.palette();
        Some(
            div()
                .absolute()
                .top(shift)
                .left(inset)
                .right(inset)
                .py(px(6.))
                .bg(palette.input)
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text_secondary)
                .child(name)
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn days(bands: &[(f32, f32)]) -> StickyDays {
        let days = StickyDays::default();
        *days.bands.borrow_mut() = bands
            .iter()
            .enumerate()
            .map(|(index, &(top, bottom))| {
                Some(Band {
                    name: format!("day {index}").into(),
                    top: px(top),
                    bottom: px(bottom),
                    label: px(28.),
                })
            })
            .collect();
        days
    }

    #[test]
    fn the_day_crossing_the_top_is_pinned_and_pushed_up_by_the_next() {
        // Two days: 14..300 and 308..600, each name 28px tall.
        let days = days(&[(14., 300.), (308., 600.)]);
        // At rest every name is in its place: nothing is pinned.
        assert_eq!(days.pinned(px(0.)), None);
        // Scrolled into the first day's rows: its name sits at the top.
        assert_eq!(days.pinned(px(100.)), Some((0, px(0.))));
        // The rows' last 28px: the name rides up with them.
        assert_eq!(days.pinned(px(290.)), Some((0, px(-18.))));
        // Between the days nothing is pinned; in the second, its name is.
        assert_eq!(days.pinned(px(304.)), None);
        assert_eq!(days.pinned(px(400.)), Some((1, px(0.))));
    }
}
