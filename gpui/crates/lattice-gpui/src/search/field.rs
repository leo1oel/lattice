//! The search field the project's sheets type into (`SearchField`,
//! `src/components/ui/search-field.tsx` and `search-field.css`): 32px, the
//! field's hairline on the input surface, deeper under the pointer and while
//! typing, a 14px glyph 10px in, and a 20×22 clear button while it holds
//! text. Quick open draws the same field without its box.

use gpui::{
    AnyElement, App, ElementId, Entity, Focusable as _, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{Input, InputState};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    icons::{ICON, ICON_SMALL},
};

/// The field over `input`; `on_clear` runs when its X is pressed.
pub fn search_field(
    id: impl Into<ElementId>,
    input: &Entity<InputState>,
    window: &Window,
    cx: &App,
    on_clear: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let palette = cx.palette().clone();
    let id = id.into();
    let state = input.read(cx);
    let focused = state.focus_handle(cx).is_focused(window);
    let has_value = !state.value().is_empty();
    let hover_border = palette.field_border_hover;
    div()
        .id(id.clone())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .h(px(32.))
        .px(px(10.))
        .rounded(px(6.))
        .border_1()
        .border_color(if focused {
            palette.field_border_hover
        } else {
            palette.field_border
        })
        .bg(palette.input)
        .hover(move |style| style.border_color(hover_border))
        .child(Icon::SEARCH.element(ICON, palette.text_secondary))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_role(TextRole::BodyCompact, cx)
                .child(Input::new(input).appearance(false).bordered(false).px_0()),
        )
        .when(has_value, |field| {
            field.child(
                div()
                    .id(ElementId::NamedChild(
                        std::sync::Arc::new(id),
                        "clear".into(),
                    ))
                    .flex_none()
                    .w(px(20.))
                    .h(px(22.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|this| this.bg(cx.palette().line))
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                    .on_click(move |_, window, cx| on_clear(window, cx))
                    .child(Icon::X.element(ICON_SMALL, palette.text_secondary)),
            )
        })
        .into_any_element()
}
