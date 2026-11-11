//! Checkbox and switch: a form's immediate choice, and a persistent setting.
//!
//! Paper's Fields and selection board: a checkbox is a 14px box with 4px
//! corners, the hairline-strong edge on the window colour at rest, a deeper
//! edge under the pointer, and the accent filled with the window colour's
//! check when on (a short bar when mixed). A switch is a 28×16 track, the
//! strong hairline off and the accent on, with a 12px thumb on the lift that
//! travels on the moderate tier (160 ms). Both fade to 42% when disabled and
//! draw the one focus ring for keyboard focus.

use std::rc::Rc;

use gpui::{
    App, ClickEvent, ElementId, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::focus_ring,
    interaction::{fade, mix, tab_stop, track_pointer, use_interaction},
    motion::Motion,
    tokens::OPACITY_DISABLED,
};

type ToggleHandler = Rc<dyn Fn(&bool, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum CheckState {
    #[default]
    Off,
    On,
    Mixed,
}

#[derive(IntoElement)]
pub struct Checkbox {
    id: ElementId,
    state: CheckState,
    label: Option<SharedString>,
    description: Option<SharedString>,
    disabled: bool,
    on_toggle: Option<ToggleHandler>,
}

impl Checkbox {
    pub fn new(id: impl Into<ElementId>, state: CheckState) -> Self {
        Self {
            id: id.into(),
            state,
            label: None,
            description: None,
            disabled: false,
            on_toggle: None,
        }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with the new value: on, unless it was on.
    pub fn on_toggle(mut self, handler: impl Fn(&bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Checkbox {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let checked = self.state != CheckState::Off;
        let (fill, edge) = if checked {
            (palette.accent, palette.accent)
        } else {
            (
                palette.window,
                mix(
                    palette.line_strong,
                    palette.control_hover_border,
                    interaction.hover,
                ),
            )
        };
        let next = self.state != CheckState::On;
        let focus = focus_ring(&palette, palette.panel);
        let disabled = self.disabled;
        // The row is the tab stop, so its label toggles it too, but the ring
        // goes round the box: the row tracks a kept focus handle and the box
        // reads it.
        let focus_handle = window
            .use_keyed_state(
                ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "focus".into()),
                cx,
                |_, cx| cx.focus_handle().tab_index(0).tab_stop(true),
            )
            .read(cx)
            .clone();
        let ring = !disabled && focus_handle.is_focused(window) && window.last_input_was_keyboard();
        let row = div()
            .id(self.id)
            .flex()
            .items_start()
            .gap(px(8.))
            .when(disabled, |this| this.opacity(OPACITY_DISABLED));
        let row = if disabled {
            row
        } else {
            track_pointer(
                row.track_focus(&focus_handle)
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default()),
                pointer,
            )
        };
        row.child(
            div().h(px(16.)).flex().items_center().child(
                div()
                    .size(px(14.))
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.))
                    .border_1()
                    .border_color(edge)
                    .bg(fill)
                    .when(ring, |this| this.shadow(focus))
                    .map(|this| match self.state {
                        CheckState::Off => this,
                        CheckState::On => {
                            this.child(Icon::CHECK_MARK.element(px(10.), palette.window))
                        }
                        CheckState::Mixed => {
                            this.child(div().w(px(7.)).h(px(1.5)).rounded_full().bg(palette.window))
                        }
                    }),
            ),
        )
        .when(self.label.is_some(), |this| {
            this.child(
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_role(TextRole::BodyCompact, cx)
                            .text_color(palette.text)
                            .children(self.label),
                    )
                    .children(self.description.map(|description| {
                        div()
                            .text_role(TextRole::Micro, cx)
                            .font_weight(crate::tokens::FONT_WEIGHT_REGULAR)
                            .text_color(palette.text_secondary)
                            .child(description)
                    })),
            )
        })
        .when_some(self.on_toggle.filter(|_| !disabled), |this, on_toggle| {
            this.cursor_pointer()
                .on_click(move |_: &ClickEvent, window, cx| on_toggle(&next, window, cx))
        })
    }
}

#[derive(IntoElement)]
pub struct Switch {
    id: ElementId,
    on: bool,
    disabled: bool,
    on_toggle: Option<ToggleHandler>,
}

impl Switch {
    pub fn new(id: impl Into<ElementId>, on: bool) -> Self {
        Self {
            id: id.into(),
            on,
            disabled: false,
            on_toggle: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_toggle(mut self, handler: impl Fn(&bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Switch {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let travel = fade(
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "thumb".into()),
            self.on,
            Motion::Moderate,
            window,
            cx,
        );
        let track = mix(palette.line_strong, palette.accent, travel.clamp(0., 1.));
        let focus = focus_ring(&palette, palette.panel);
        let next = !self.on;
        let disabled = self.disabled;
        // A 28px track with 2px of padding leaves the 12px thumb 12px to go.
        let thumb_left = px(2. + 12. * travel);
        let track_element = div().id(self.id);
        let track_element = if disabled {
            track_element
        } else {
            tab_stop(track_element)
        };
        track_element
            .relative()
            .flex_none()
            .w(px(28.))
            .h(px(16.))
            .rounded_full()
            .bg(track)
            .when(disabled, |this| this.opacity(OPACITY_DISABLED))
            .when(!disabled, |this| {
                this.focus_visible(move |style| style.shadow(focus))
            })
            .child(
                div()
                    .absolute()
                    .top(px(2.))
                    .left(thumb_left)
                    .size(px(12.))
                    .rounded_full()
                    .bg(palette.raised)
                    .shadow(
                        Elevation::Raised
                            .shadows(&palette)
                            .into_iter()
                            .skip(1)
                            .collect(),
                    ),
            )
            .when_some(self.on_toggle.filter(|_| !disabled), |this, on_toggle| {
                this.cursor_pointer()
                    .on_click(move |_: &ClickEvent, window, cx| on_toggle(&next, window, cx))
            })
    }
}
