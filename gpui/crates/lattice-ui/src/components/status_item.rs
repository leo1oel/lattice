//! An item in an editor's status bar: an optional 12px icon and a caption.
//!
//! Measured on the Main window: 22px tall with control corners, 6px of
//! padding, 4px from the icon to its 12/16 caption, all in secondary ink.
//! A clickable item is a tab stop with the one focus ring.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::focus_ring,
    icons::ICON_SMALL, interaction::tab_stop,
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct StatusItem {
    id: ElementId,
    icon: Option<Icon>,
    children: Vec<AnyElement>,
    on_click: Option<ClickHandler>,
}

impl StatusItem {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            icon: None,
            children: Vec::new(),
            on_click: None,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A caption in secondary ink.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.children.push(label.into().into_any_element());
        self
    }

    /// Any other content, e.g. a value set in the primary ink.
    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.children.push(child.into_any_element());
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

impl RenderOnce for StatusItem {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        let hover = palette.hover;
        let focus = focus_ring(palette, palette.editor);
        let item = div().id(self.id);
        let item = if self.on_click.is_some() {
            tab_stop(item)
        } else {
            item
        };
        item.flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .h(px(22.))
            .px(px(6.))
            .rounded(px(6.))
            .whitespace_nowrap()
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .when_some(self.icon, |this, icon| {
                this.child(icon.element(ICON_SMALL, palette.text_secondary))
            })
            .children(self.children)
            .when_some(self.on_click, |this, on_click| {
                this.hover(move |style| style.bg(hover))
                    .focus_visible(move |style| style.shadow(focus))
                    .on_click(move |event, window, cx| on_click(event, window, cx))
            })
    }
}
