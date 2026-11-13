//! A selection plate that slides to the newly selected item.
//!
//! The Tauri app's segmented controls and sliding tab strips draw the
//! selected item's plate as one element that moves (`motion.tsx`,
//! `SlidingTabs`: a `layoutId` pill on `spring.moderate`), so the eye follows
//! the selection instead of finding it again; reduced motion moves it at
//! once. A plate is a surface the size of what it marks, so it rides the
//! moderate tier, which lands without overshoot.
//!
//! ```ignore
//! let plate = SlidingPlate::new("presets", selected, window, cx);
//! div()
//!     .relative()
//!     .children(plate.plate(|plate| plate.bg(palette.panel).rounded(r)))
//!     .children(items.map(|(ix, item)| {
//!         // Until the plate has been measured, the selected item draws its
//!         // own; afterwards none does.
//!         let item = item.when(ix == selected && !plate.is_drawn(cx), |i| i.bg(..));
//!         plate.item(ix, item)
//!     }))
//! ```
//!
//! The plate is laid out from the bounds the items had in the last frame,
//! relative to the strip, so it trails a reflow by one frame; it is absent
//! until the strip has been drawn once.

use std::time::Instant;

use gpui::{
    AnyElement, App, Bounds, Div, ElementId, Entity, IntoElement, Pixels, Styled as _, Window, div,
};

use crate::{
    measure::measured,
    motion::{Motion, Tween},
};

#[derive(Debug, Default)]
pub struct PlateState {
    strip: Option<Bounds<Pixels>>,
    items: Vec<Option<Bounds<Pixels>>>,
    selected: Option<usize>,
    /// Relative to the strip.
    rect: Option<Tween<Bounds<Pixels>>>,
}

impl PlateState {
    fn relative(&self, index: usize) -> Option<Bounds<Pixels>> {
        let strip = self.strip?;
        let item = self.items.get(index).copied().flatten()?;
        Some(Bounds::new(item.origin - strip.origin, item.size))
    }

    /// The selection is `selected` at `now`.
    fn select(&mut self, selected: Option<usize>, now: Instant, reduce_motion: bool) {
        let changed = self.selected != selected;
        // The plate is not drawn until a selection changes, but the item the
        // selection leaves was measured: the first slide starts there.
        if self.rect.is_none() && changed {
            if let Some(from) = self.selected.and_then(|ix| self.relative(ix)) {
                self.rect = Some(Tween::settled(from, now));
            }
        }
        self.selected = selected;
        let Some(target) = selected.and_then(|ix| self.relative(ix)) else {
            if selected.is_none() {
                self.rect = None;
            }
            return;
        };
        match self.rect.as_mut() {
            Some(rect) if changed && !reduce_motion => rect.retarget(target, Motion::Moderate, now),
            Some(rect) if rect.target() != target && !rect.is_running(now) => {
                rect.jump(target, now)
            }
            Some(rect) if rect.target() != target => rect.retarget(target, Motion::Moderate, now),
            Some(rect) if changed => rect.jump(target, now),
            Some(_) => {}
            None => self.rect = Some(Tween::settled(target, now)),
        }
    }
}

/// One strip's plate, for one frame.
#[derive(Clone)]
pub struct SlidingPlate {
    state: Entity<PlateState>,
}

impl SlidingPlate {
    pub fn new(
        id: impl Into<ElementId>,
        selected: Option<usize>,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        let state = window.use_keyed_state(id, cx, |_, _| PlateState::default());
        let now = Instant::now();
        let reduce = cx.reduce_motion();
        let running = state.update(cx, |state, _| {
            state.select(selected, now, reduce);
            state.rect.is_some_and(|rect| rect.is_running(now))
        });
        if running {
            window.request_animation_frame();
        }
        Self { state }
    }

    /// Whether the plate is drawn: the selected item then draws none.
    pub fn is_drawn(&self, cx: &App) -> bool {
        self.state.read(cx).rect.is_some()
    }

    /// The strip, measured: wrap the positioned element holding the items.
    pub fn strip(&self, strip: impl IntoElement) -> AnyElement {
        let state = self.state.clone();
        measured(strip, move |bounds, cx| {
            state.update(cx, |state, _| state.strip = Some(bounds));
        })
    }

    /// Item `index`, measured.
    pub fn item(&self, index: usize, item: impl IntoElement) -> AnyElement {
        let state = self.state.clone();
        measured(item, move |bounds, cx| {
            state.update(cx, |state, _| {
                if state.items.len() <= index {
                    state.items.resize(index + 1, None);
                }
                state.items[index] = Some(bounds);
            });
        })
    }

    /// The plate, styled by `style`, placed where the selection is drawn now;
    /// put it in the strip before the items.
    pub fn plate(&self, style: impl FnOnce(Div) -> Div, cx: &App) -> Option<AnyElement> {
        let rect = self.state.read(cx).rect?.value(Instant::now());
        Some(
            style(
                div()
                    .absolute()
                    .left(rect.origin.x)
                    .top(rect.origin.y)
                    .w(rect.size.width)
                    .h(rect.size.height),
            )
            .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{bounds, point, px, size};

    fn strip() -> PlateState {
        let mut state = PlateState {
            strip: Some(bounds(point(px(100.), px(10.)), size(px(200.), px(28.)))),
            ..PlateState::default()
        };
        state.items = vec![
            Some(bounds(point(px(102.), px(12.)), size(px(60.), px(24.)))),
            Some(bounds(point(px(162.), px(12.)), size(px(80.), px(24.)))),
        ];
        state
    }

    #[test]
    fn the_plate_starts_on_the_selection_and_slides_on_the_moderate_tier() {
        let start = Instant::now();
        let mut state = strip();
        state.select(Some(0), start, false);
        let rect = state.rect.unwrap();
        assert_eq!(
            rect.value(start),
            bounds(point(px(2.), px(2.)), size(px(60.), px(24.)))
        );
        state.select(Some(1), start, false);
        let rect = state.rect.unwrap();
        assert!(rect.is_running(start));
        let mid = rect.value(start + crate::tokens::DURATION_MODERATE / 2);
        assert!(mid.origin.x > px(2.) && mid.origin.x < px(62.));
        assert_eq!(
            rect.value(start + crate::tokens::DURATION_MODERATE),
            bounds(point(px(62.), px(2.)), size(px(80.), px(24.)))
        );
    }

    #[test]
    fn the_first_change_slides_from_the_item_it_leaves() {
        let start = Instant::now();
        let mut state = strip();
        state.selected = Some(0);
        state.select(Some(1), start, false);
        let rect = state.rect.unwrap();
        assert_eq!(rect.value(start).origin.x, px(2.));
        assert!(rect.is_running(start));
    }

    #[test]
    fn reduced_motion_moves_the_plate_at_once() {
        let start = Instant::now();
        let mut state = strip();
        state.select(Some(0), start, true);
        state.select(Some(1), start, true);
        assert_eq!(state.rect.unwrap().value(start).origin.x, px(62.));
    }

    #[test]
    fn nothing_selected_draws_no_plate() {
        let start = Instant::now();
        let mut state = strip();
        state.select(Some(0), start, false);
        state.select(None, start, false);
        assert!(state.rect.is_none());
    }
}
