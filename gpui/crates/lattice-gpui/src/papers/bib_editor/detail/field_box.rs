//! A field's box in the form.

use gpui::{Entity, Focusable as _, Window};
use gpui_kit::component::input::{InputState, TextareaState};

/// A field's box: one line, or one that wraps and grows.
pub(in crate::papers::bib_editor) enum FieldBox {
    Line(Entity<InputState>),
    Long(Entity<TextareaState>),
}

impl FieldBox {
    pub(in crate::papers::bib_editor) fn value(&self, cx: &gpui::App) -> String {
        match self {
            FieldBox::Line(input) => input.read(cx).value().to_string(),
            FieldBox::Long(input) => input.read(cx).value().to_string(),
        }
    }

    pub(super) fn focused(&self, window: &Window, cx: &gpui::App) -> bool {
        match self {
            FieldBox::Line(input) => input.read(cx).focus_handle(cx).is_focused(window),
            FieldBox::Long(input) => input.read(cx).focus_handle(cx).is_focused(window),
        }
    }

    pub(super) fn focus_handle(&self, cx: &gpui::App) -> gpui::FocusHandle {
        match self {
            FieldBox::Line(input) => input.read(cx).focus_handle(cx),
            FieldBox::Long(input) => input.read(cx).focus_handle(cx),
        }
    }

    pub(super) fn set_value(&self, text: String, window: &mut Window, cx: &mut gpui::App) {
        match self {
            FieldBox::Line(input) => {
                input.update(cx, |input, cx| input.set_value(text, window, cx))
            }
            FieldBox::Long(input) => {
                input.update(cx, |input, cx| input.set_value(text, window, cx))
            }
        }
    }
}
