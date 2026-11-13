//! An item in an editor's status bar: an optional 12px icon and a caption.
//!
//! Measured on the Main window: 22px tall with control corners, 6px of
//! padding, 4px from the icon to its 12/16 caption, all in secondary ink.
//! A clickable item is a tab stop with the one focus ring. As
//! `.editor-status-bar .status-item` has it, a clickable item under the
//! pointer takes the control hover fill and steps its ink up to the primary,
//! the pressed fill while held, both easing on the fast tier.

use std::rc::Rc;

use gpui::{
    AnyElement, AnyView, App, ClickEvent, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{LatticeTooltip, focus_ring},
    icons::ICON_SMALL,
    interaction::{mix, tab_stop, track_pointer, use_interaction},
    parity,
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct StatusItem {
    id: ElementId,
    icon: Option<Icon>,
    children: Vec<AnyElement>,
    /// Each caption with its place among `children`, for the parity probes.
    labels: Vec<(usize, SharedString)>,
    on_click: Option<ClickHandler>,
    tooltip: Option<SharedString>,
    /// The icon in the accent: a counter with something open.
    accent_icon: bool,
    parity: Option<SharedString>,
}

impl StatusItem {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            icon: None,
            children: Vec::new(),
            labels: Vec::new(),
            on_click: None,
            tooltip: None,
            accent_icon: false,
            parity: None,
        }
    }

    /// The item's name on hover, as its `title` gives it in the app.
    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    /// Set the icon in the accent, as an open counter's is
    /// (`.status-counter[data-active]`).
    pub fn accent_icon(mut self, accent: bool) -> Self {
        self.accent_icon = accent;
        self
    }

    /// Name this control as a parity-harness region (`crate::parity`): its
    /// bounds and its captions' text styles are recorded under `name`, each
    /// in the slot of its place among the item's children.
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A caption in secondary ink.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        let label = label.into();
        self.labels.push((self.children.len(), label.clone()));
        self.children.push(label.into_any_element());
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
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let focus = focus_ring(&palette, palette.editor);
        let clickable = self.on_click.is_some();
        let item = div().id(self.id.clone());
        let (bg, ink) = if clickable {
            let (interaction, pointer) = use_interaction(self.id, window, cx);
            let wash = interaction.wash(gpui::transparent_black(), palette.hover, palette.pressed);
            let lit = interaction.hover.max(interaction.press);
            (
                Some((wash, pointer)),
                mix(palette.text_secondary, palette.text, lit),
            )
        } else {
            (None, palette.text_secondary)
        };
        let item = match &bg {
            Some((_, pointer)) => track_pointer(tab_stop(item), pointer.clone()),
            None => item,
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
            .text_color(ink)
            .when_some(bg.map(|(wash, _)| wash), |this, wash| this.bg(wash))
            .when_some(self.icon, |this, icon| {
                let ink = if self.accent_icon {
                    palette.accent
                } else {
                    ink
                };
                this.child(icon.element(ICON_SMALL, ink))
            })
            .when_some(self.tooltip, |this, tooltip| {
                this.tooltip(move |_, cx| -> AnyView {
                    LatticeTooltip::view(tooltip.clone(), None, cx)
                })
            })
            .children(self.children)
            .children(self.parity.clone().and_then(parity::probe))
            .children(
                self.parity
                    .map(|name| {
                        self.labels.into_iter().filter_map(move |(slot, label)| {
                            parity::text_probe(name.clone(), slot, label)
                        })
                    })
                    .into_iter()
                    .flatten(),
            )
            .when_some(self.on_click, |this, on_click| {
                this.focus_visible(move |style| style.shadow(focus))
                    .on_click(move |event, window, cx| on_click(event, window, cx))
            })
    }
}
