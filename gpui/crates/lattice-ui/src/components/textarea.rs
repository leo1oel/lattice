//! Textarea: a field for a few lines of prose.
//!
//! Paper's Fields and selection board ("textarea, 88 min") and the app's
//! `.ui-textarea` (form-controls.css): the field's 1px border at the ink's
//! 12% over the input surface, deepened to 24% under the pointer and while
//! it has focus, the danger border when invalid, 45% when disabled; never a
//! ring. 88px at least (`--form-control-textarea-min-height`), on the 6px
//! corner, 8px over and under and 10px in; the text is body compact's 12/16
//! at regular weight, as the app sets it, wrapping within the field.
//!
//! The text itself is GPUI Kit's multi-line input, drawn without its own
//! chrome; it scrolls once the lines outgrow the height.

use gpui::{
    App, ElementId, Entity, Focusable as _, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, RenderOnce, Styled as _, Window, div, prelude::FluentBuilder as _,
    px,
};
use gpui_kit::component::input::{Textarea as KitTextarea, TextareaState};

use crate::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    interaction::{mix, track_pointer, use_interaction},
    tokens::{FONT_WEIGHT_REGULAR, OPACITY_FIELD_DISABLED},
};

/// The app's `--form-control-textarea-min-height`.
pub const TEXTAREA_MIN_HEIGHT: Pixels = px(88.);

#[derive(IntoElement)]
pub struct Textarea {
    state: Entity<TextareaState>,
    height: Pixels,
    /// The field is as tall as its lines (the state's `auto_grow`), not fixed.
    grows: bool,
    invalid: bool,
    disabled: bool,
}

impl Textarea {
    pub fn new(state: &Entity<TextareaState>) -> Self {
        Self {
            state: state.clone(),
            height: TEXTAREA_MIN_HEIGHT,
            grows: false,
            invalid: false,
            disabled: false,
        }
    }

    /// Taller than the 88px floor, for a longer note.
    pub fn height(mut self, height: Pixels) -> Self {
        self.height = height.max(TEXTAREA_MIN_HEIGHT);
        self
    }

    /// As tall as its lines, between the rows its state's `auto_grow` sets,
    /// for a composer that starts at one line (`.chat-composer textarea`)
    /// rather than the 88px a form's field takes.
    pub fn grows(mut self) -> Self {
        self.grows = true;
        self
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

impl RenderOnce for Textarea {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let id = ElementId::from(("lattice-textarea", self.state.entity_id()));
        let (interaction, pointer) = use_interaction(id.clone(), window, cx);
        let focused = self.state.read(cx).focus_handle(cx).is_focused(window);
        let border = if self.invalid {
            palette.danger
        } else if focused {
            palette.field_border_hover
        } else {
            mix(
                palette.field_border,
                palette.field_border_hover,
                interaction.hover,
            )
        };
        let font_size = TextRole::BodyCompact.font_size(Default::default(), cx);
        let leading = TextRole::BodyCompact.leading(Default::default());
        // Kit's multi-line editor insets its text by its medium size's 8px
        // over and 10px in, which are the app's paddings, so this frame adds
        // none and the lines scroll right up to the border.
        let input = KitTextarea::new(&self.state)
            .appearance(false)
            .disabled(self.disabled)
            .when(!self.grows, |input| input.h_full())
            .text_size(font_size)
            .line_height(leading);
        let frame = div()
            .id(id)
            .flex()
            .when(!self.grows, |frame| frame.h(self.height))
            .rounded(px(6.))
            .border_1()
            .border_color(border)
            .bg(palette.input)
            .text_role(TextRole::BodyCompact, cx)
            .font_weight(FONT_WEIGHT_REGULAR)
            .text_color(palette.text)
            .when(self.disabled, |this| this.opacity(OPACITY_FIELD_DISABLED));
        let frame = if self.disabled {
            frame
        } else {
            track_pointer(frame, pointer)
        };
        frame.child(
            div()
                .flex_1()
                .min_w_0()
                .when(!self.grows, |slot| slot.h_full())
                .child(input),
        )
    }
}
