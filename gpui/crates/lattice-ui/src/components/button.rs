//! Button: a variant and a size, and nothing else.
//!
//! Paper's Buttons board: primary, tinted, secondary, ghost and danger, at
//! compact 28px (caption text, 14px icon) or default 32px (body compact,
//! 16px icon), on the 6px control radius, 12px in, 6px between icon and
//! label. States run one way, hover lighter than pressed; the focus ring is
//! the only ring; a disabled Button has one look for every variant (a faint
//! slab, its edge and stepped-back ink).
//!
//! - primary: the ink as a slab with the window's colour on it, the one
//!   answer of a dialog or sheet;
//! - tinted: the accent at 12/18/24%, every other lead action;
//! - secondary: the lift with the strong hairline, the default;
//! - ghost: no slab, secondary ink, dismissals;
//! - danger: the danger wash with danger ink, never a red slab.

use std::rc::Rc;

use gpui::{
    AnyView, App, ClickEvent, Div, ElementId, Hsla, InteractiveElement, Interactivity, IntoElement,
    ParentElement as _, Pixels, RenderOnce, SharedString, Stateful, StatefulInteractiveElement,
    StyleRefinement, Styled, Window, div, prelude::FluentBuilder as _, px, transparent_black,
};
use gpui_kit::component::Selectable;

use crate::{
    ActiveLattice as _, Icon, Palette, TextRole, TextRoleStyle as _,
    components::LatticeTooltip,
    components::focus_ring,
    icons::{ICON, ICON_LARGE},
    interaction::{mix, tab_stop, track_pointer, use_interaction},
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ButtonVariant {
    Primary,
    Tinted,
    #[default]
    Secondary,
    Ghost,
    Danger,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ButtonSize {
    /// 28px, caption text, 14px icon: panel headers, toolbars, popover forms.
    Compact,
    /// 32px, body compact, 16px icon: forms, dialogs, Settings.
    #[default]
    Default,
}

/// What a variant paints in each state.
struct Look {
    rest: Hsla,
    hover: Hsla,
    pressed: Hsla,
    border: Hsla,
    ink: Hsla,
    hover_ink: Hsla,
}

impl ButtonVariant {
    fn look(self, p: &Palette) -> Look {
        let none = transparent_black();
        match self {
            ButtonVariant::Primary => Look {
                rest: p.text,
                hover: p.primary_hover,
                pressed: p.primary_pressed,
                border: none,
                ink: p.window,
                hover_ink: p.window,
            },
            ButtonVariant::Tinted => Look {
                rest: p.tinted,
                hover: p.tinted_hover,
                pressed: p.tinted_pressed,
                border: none,
                ink: p.text,
                hover_ink: p.text,
            },
            ButtonVariant::Secondary => Look {
                rest: p.raised,
                hover: p.hover,
                pressed: p.pressed,
                border: p.line_strong,
                ink: p.text,
                hover_ink: p.text,
            },
            ButtonVariant::Ghost => Look {
                rest: none,
                hover: p.hover,
                pressed: p.pressed,
                border: none,
                ink: p.text_secondary,
                hover_ink: p.text,
            },
            ButtonVariant::Danger => Look {
                rest: p.danger_soft,
                hover: p.danger_soft_hover,
                pressed: p.danger_soft_pressed,
                border: none,
                ink: p.danger,
                hover_ink: p.danger,
            },
        }
    }
}

#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    base: Stateful<Div>,
    label: Option<SharedString>,
    icon: Option<Icon>,
    variant: ButtonVariant,
    size: ButtonSize,
    selected: bool,
    disabled: bool,
    tooltip: Option<SharedString>,
    on_click: Option<ClickHandler>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        let id = id.into();
        Self {
            base: div().id(id.clone()),
            id,
            label: Some(label.into()),
            icon: None,
            variant: ButtonVariant::default(),
            size: ButtonSize::default(),
            selected: false,
            disabled: false,
            tooltip: None,
            on_click: None,
        }
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn primary(self) -> Self {
        self.variant(ButtonVariant::Primary)
    }

    pub fn tinted(self) -> Self {
        self.variant(ButtonVariant::Tinted)
    }

    pub fn ghost(self) -> Self {
        self.variant(ButtonVariant::Ghost)
    }

    pub fn danger(self) -> Self {
        self.variant(ButtonVariant::Danger)
    }

    pub fn size(mut self, size: ButtonSize) -> Self {
        self.size = size;
        self
    }

    pub fn compact(self) -> Self {
        self.size(ButtonSize::Compact)
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl Styled for Button {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for Button {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl StatefulInteractiveElement for Button {}

impl Selectable for Button {
    fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.selected
    }
}

impl gpui_kit::component::menu::DropdownMenu for Button {}

impl RenderOnce for Button {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let look = self.variant.look(&palette);
        let (height, role, icon_size): (Pixels, TextRole, Pixels) = match self.size {
            ButtonSize::Compact => (px(28.), TextRole::Caption, ICON),
            ButtonSize::Default => (px(32.), TextRole::BodyCompact, ICON_LARGE),
        };
        let focus = focus_ring(&palette, palette.panel);
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let disabled = self.disabled;
        let (bg, border, ink) = if disabled {
            (
                palette.disabled_surface,
                palette.disabled_border,
                palette.disabled_ink,
            )
        } else {
            let (rest, hover) = if self.selected {
                (look.pressed, look.pressed)
            } else {
                (look.rest, look.hover)
            };
            let lift = interaction.hover.max(if self.selected { 1. } else { 0. });
            (
                interaction.wash(rest, hover, look.pressed),
                look.border,
                mix(look.ink, look.hover_ink, lift),
            )
        };
        let base = if disabled {
            self.base
        } else {
            track_pointer(tab_stop(self.base), pointer)
        };
        base.flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .h(height)
            .px(px(12.))
            .rounded(px(6.))
            .border_1()
            .border_color(border)
            .bg(bg)
            .whitespace_nowrap()
            .text_role(role, cx)
            .text_color(ink)
            .when(!disabled, |this| {
                this.cursor_pointer()
                    .focus_visible(move |style| style.shadow(focus))
            })
            .when_some(self.icon, |this, icon| {
                this.child(icon.element(icon_size, ink))
            })
            .children(self.label)
            .when_some(self.tooltip, |this, tooltip| {
                this.tooltip(move |_, cx| -> AnyView {
                    LatticeTooltip::view(tooltip.clone(), None, cx)
                })
            })
            .when_some(self.on_click.filter(|_| !disabled), |this, on_click| {
                this.on_click(move |event, window, cx| on_click(event, window, cx))
            })
    }
}
