//! A quiet chrome button with a label: the titlebar's project switcher and
//! "Panels" menu.
//!
//! Measured on the Main window: "Panels" is 28px tall with control corners,
//! 8px in, a 14px icon 6px before its 12/16 label, both in secondary ink.
//! The project switcher is the same button at 32px with the project's name
//! in 13px semibold and a 12px chevron 8px after it.

use std::rc::Rc;

use gpui::{
    App, ClickEvent, Div, ElementId, FontWeight, InteractiveElement, Interactivity, IntoElement,
    ParentElement as _, Pixels, RenderOnce, SharedString, Stateful, StatefulInteractiveElement,
    StyleRefinement, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::Selectable;

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::Surface,
    icons::{ICON, ICON_SMALL},
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct ToolbarButton {
    base: Stateful<Div>,
    label: SharedString,
    icon: Option<Icon>,
    chevron: bool,
    height: Pixels,
    role: TextRole,
    weight: Option<FontWeight>,
    surface: Surface,
    selected: bool,
    on_click: Option<ClickHandler>,
}

impl ToolbarButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            base: div().id(id),
            label: label.into(),
            icon: None,
            chevron: false,
            height: px(28.),
            role: TextRole::Caption,
            weight: None,
            surface: Surface::Chrome,
            selected: false,
            on_click: None,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// The titlebar's project switcher: 32px, the name in 13px semibold,
    /// a disclosure chevron after it.
    pub fn switcher(mut self) -> Self {
        self.height = px(32.);
        self.role = TextRole::Subtitle;
        self.weight = Some(crate::tokens::FONT_WEIGHT_SEMIBOLD);
        self.chevron = true;
        self
    }

    pub fn surface(mut self, surface: Surface) -> Self {
        self.surface = surface;
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

impl Styled for ToolbarButton {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for ToolbarButton {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl StatefulInteractiveElement for ToolbarButton {}

impl Selectable for ToolbarButton {
    fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.selected
    }
}

impl gpui_kit::component::menu::DropdownMenu for ToolbarButton {}

impl RenderOnce for ToolbarButton {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let hover = self.surface.hover(&palette);
        let pressed = palette.pressed;
        let ink = palette.text_secondary;
        self.base
            .flex()
            .flex_none()
            .items_center()
            .gap(px(if self.chevron { 8. } else { 6. }))
            .h(self.height)
            .px(px(8.))
            .rounded(px(6.))
            .whitespace_nowrap()
            .text_role(self.role, cx)
            .when(self.chevron, |this| this.line_height(px(16.)))
            .when_some(self.weight, |this, weight| this.font_weight(weight))
            .text_color(ink)
            .when(self.selected, |this| this.bg(pressed))
            .hover(move |style| style.bg(hover))
            .active(move |style| style.bg(pressed))
            .when_some(self.icon, |this, icon| this.child(icon.element(ICON, ink)))
            .child(div().min_w_0().truncate().child(self.label))
            .when(self.chevron, |this| {
                this.child(Icon::CHEVRON_DOWN.element(ICON_SMALL, ink))
            })
            .when_some(self.on_click, |this, on_click| {
                this.on_click(move |event, window, cx| on_click(event, window, cx))
            })
    }
}
