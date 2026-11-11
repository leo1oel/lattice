//! Text fields.
//!
//! Paper's Fields and selection board: a 1px border at the ink's 12% over the
//! input surface; hover and focus deepen it to 24%; text entry draws no focus
//! ring, it answers with its border. 32px tall (28 compact) on the 6px
//! corner, 12px in, 13px text. A search field leads with a 14px glyph; an
//! invalid one takes the danger border; a disabled one fades to 45%. A select
//! (`select.rs`) and a textarea (`textarea.rs`) are drawn on the same frame.
//!
//! The text itself is GPUI Kit's input, drawn without its own chrome.

use gpui::{
    App, ElementId, Entity, Focusable as _, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, RenderOnce, Styled as _, Window, div, prelude::FluentBuilder as _,
    px,
};
use gpui_kit::component::input::{Input, InputState};

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    icons::ICON,
    interaction::{mix, track_pointer, use_interaction},
    tokens::OPACITY_FIELD_DISABLED,
};

pub(crate) fn field_height(compact: bool) -> Pixels {
    px(if compact { 28. } else { 32. })
}

#[derive(IntoElement)]
pub struct Field {
    state: Entity<InputState>,
    compact: bool,
    search: bool,
    invalid: bool,
    disabled: bool,
}

impl Field {
    pub fn new(state: &Entity<InputState>) -> Self {
        Self {
            state: state.clone(),
            compact: false,
            search: false,
            invalid: false,
            disabled: false,
        }
    }

    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    /// Lead with the search glyph.
    pub fn search(mut self) -> Self {
        self.search = true;
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

impl RenderOnce for Field {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let id = ElementId::from(("lattice-field", self.state.entity_id()));
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
        let font_size = TextRole::Body.font_size(Default::default(), cx);
        // Kit pads and sizes its input for its own frame; this frame owns
        // both, so the text sits 12px in and fills the field's height.
        let input = Input::new(&self.state)
            .appearance(false)
            .disabled(self.disabled)
            .px_0()
            .py_0()
            .h_full()
            .text_size(font_size);
        let frame = div()
            .id(id)
            .flex()
            .gap(px(6.))
            .px(px(if self.search { 10. } else { 12. }))
            .rounded(px(6.))
            .border_1()
            .border_color(border)
            .bg(palette.input)
            .text_role(TextRole::Body, cx)
            .text_color(palette.text)
            .items_center()
            .h(field_height(self.compact))
            .when(self.disabled, |this| this.opacity(OPACITY_FIELD_DISABLED));
        let frame = if self.disabled {
            frame
        } else {
            track_pointer(frame, pointer)
        };
        frame
            .when(self.search, |this| {
                this.child(Icon::SEARCH.element(ICON, palette.text_secondary))
            })
            .child(div().flex_1().min_w_0().child(input))
    }
}
