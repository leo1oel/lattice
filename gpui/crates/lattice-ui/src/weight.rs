//! Labels that change weight without moving their neighbours.
//!
//! Fluid Functionalism's labels get heavier on state (selected, active,
//! open) without a reflow: an invisible copy at the heaviest weight sizes the
//! box, and the visible label is drawn over it (the ghost-span pattern,
//! <https://www.fluidfunctionalism.com/docs/typography>). The Tauri app uses
//! the same stack for a label whose text changes (the Build chip's sizer
//! holds the widest of its states, `trellis.css`, `.trellis-build-sizer`).
//! [`StableLabel`] is both: the box is as wide as the widest text at the
//! heaviest weight it reserves, whatever is shown.

use gpui::{
    App, FontWeight, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _,
    Window, div,
};

/// A label whose box holds still while its weight or text changes.
#[derive(IntoElement)]
pub struct StableLabel {
    text: SharedString,
    weight: FontWeight,
    /// The texts and weights the box makes room for.
    reserve: Vec<(SharedString, FontWeight)>,
}

impl StableLabel {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self {
            text: text.into(),
            weight: FontWeight::NORMAL,
            reserve: Vec::new(),
        }
    }

    /// The weight drawn now.
    pub fn weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    /// Make room for the shown text at `weight` (a selected label's semibold).
    pub fn reserve_weight(mut self, weight: FontWeight) -> Self {
        self.reserve.push((self.text.clone(), weight));
        self
    }

    /// Make room for another text the label can show, at `weight`.
    pub fn reserve(mut self, text: impl Into<SharedString>, weight: FontWeight) -> Self {
        self.reserve.push((text.into(), weight));
        self
    }
}

impl RenderOnce for StableLabel {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        // The sizers stack in the box's flow, invisible, one under the other
        // at zero height but their own width; the label is laid over them.
        div()
            .relative()
            .flex()
            .flex_col()
            .children(self.reserve.into_iter().map(|(text, weight)| {
                div()
                    .invisible()
                    .h_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .font_weight(weight)
                    .child(text)
            }))
            .child(
                div()
                    .whitespace_nowrap()
                    .font_weight(self.weight)
                    .child(self.text),
            )
    }
}
