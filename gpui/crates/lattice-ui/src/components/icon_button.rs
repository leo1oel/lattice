//! An icon-only button: the titlebar's actions, a panel strip's accessories
//! and ⋯ menu, a toolbar's toggles.
//!
//! Measured on the Main window: 28×28 in the titlebar and accessory hosts,
//! 24×28 for a strip's ⋯ menu and the PDF toolbar; a 14px icon in secondary
//! ink; an "on" toggle on the toolbar-active wash with the icon in the
//! accent. Corners are the control radius (6px), except in a panel's tab
//! strip, where the app rounds them like its tabs (11px).

use std::rc::Rc;

use gpui::{
    AnyElement, AnyView, App, ClickEvent, Corners, Div, ElementId, InteractiveElement,
    Interactivity, IntoElement, ParentElement as _, Pixels, RenderOnce, SharedString, Stateful,
    StatefulInteractiveElement, StyleRefinement, Styled, Window, div, prelude::FluentBuilder as _,
    px,
};
use gpui_kit::component::Selectable;

use gpui::transparent_black;

use crate::{
    ActiveLattice as _, Icon,
    components::LatticeTooltip,
    components::{Surface, focus_ring},
    icons::ICON,
    interaction::{mix, tab_stop, track_pointer, use_interaction},
    tokens::OPACITY_DISABLED,
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct IconButton {
    id: ElementId,
    base: Stateful<Div>,
    icon: Icon,
    icon_size: Pixels,
    width: Pixels,
    height: Pixels,
    radius: Pixels,
    /// Corners of their own, for a button that is half of a split pair.
    corners: Option<Corners<Pixels>>,
    /// Drawn in place of the icon (a loader while the button's work runs).
    content: Option<AnyElement>,
    /// Laid over the button's corner (a status dot).
    badge: Option<AnyElement>,
    surface: Surface,
    on: bool,
    selected: bool,
    disabled: bool,
    fluid: bool,
    tooltip: Option<SharedString>,
    on_click: Option<ClickHandler>,
}

impl IconButton {
    pub fn new(id: impl Into<ElementId>, icon: Icon) -> Self {
        let id = id.into();
        Self {
            base: div().id(id.clone()),
            id,
            icon,
            icon_size: ICON,
            width: px(28.),
            height: px(28.),
            radius: px(6.),
            corners: None,
            content: None,
            badge: None,
            surface: Surface::Sheet,
            on: false,
            selected: false,
            disabled: false,
            fluid: false,
            tooltip: None,
            on_click: None,
        }
    }

    /// Width and height of the hit area and the hover wash.
    pub fn frame(mut self, width: Pixels, height: Pixels) -> Self {
        self.width = width;
        self.height = height;
        self
    }

    pub fn icon_size(mut self, size: Pixels) -> Self {
        self.icon_size = size;
        self
    }

    pub fn radius(mut self, radius: Pixels) -> Self {
        self.radius = radius;
        self
    }

    /// Round each corner on its own: the halves of a split button keep the
    /// radius only on their outer side.
    pub fn corners(mut self, corners: Corners<Pixels>) -> Self {
        self.corners = Some(corners);
        self
    }

    /// Draw `content` in place of the icon, in the icon's place and size.
    pub fn content(mut self, content: impl IntoElement) -> Self {
        self.content = Some(content.into_any_element());
        self
    }

    /// Lay `badge` over the button, positioned by the badge itself.
    pub fn badge(mut self, badge: impl IntoElement) -> Self {
        self.badge = Some(badge.into_any_element());
        self
    }

    pub fn surface(mut self, surface: Surface) -> Self {
        self.surface = surface;
        self
    }

    /// A toggle that is on: the accent's 14% wash, the icon in the accent.
    pub fn on(mut self, on: bool) -> Self {
        self.on = on;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Leave the hover fill to the strip's fluid hover (`crate::fluid_hover`,
    /// [`crate::fluid_hover::Axis::Horizontal`]): a toolbar of equal icon
    /// buttons with no selected item lights one fill that glides between
    /// them (design call 2). The button keeps its own pressed wash and its
    /// ink's step up to the primary.
    pub fn fluid(mut self) -> Self {
        self.fluid = true;
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

impl Styled for IconButton {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for IconButton {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl StatefulInteractiveElement for IconButton {}

/// `selected` is how a dropdown menu marks its trigger while it is open: the
/// button keeps its pressed wash.
impl Selectable for IconButton {
    fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.selected
    }
}

impl RenderOnce for IconButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let ground = self.surface.ground(&palette);
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        // No slab: secondary ink at rest; under the pointer a 5% wash (6% on
        // the chrome) and the primary ink, 8% while held. An "on" toggle
        // keeps the accent's wash and ink.
        let (bg, ink) = if self.on {
            (palette.toolbar_active, palette.accent)
        } else if self.disabled {
            (transparent_black(), palette.text_secondary)
        } else {
            let (rest, hover) = if self.selected {
                (palette.pressed, palette.pressed)
            } else if self.fluid {
                (transparent_black(), transparent_black())
            } else {
                (transparent_black(), self.surface.hover(&palette))
            };
            (
                interaction.wash(rest, hover, palette.pressed),
                mix(palette.text_secondary, palette.text, interaction.hover),
            )
        };
        let focus = focus_ring(&palette, ground);
        let disabled = self.disabled;
        let base = if disabled {
            self.base
        } else {
            track_pointer(tab_stop(self.base), pointer)
        };
        let corners = self.corners;
        let icon = match self.content {
            Some(content) => content,
            None => self.icon.element(self.icon_size, ink).into_any_element(),
        };
        base.relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .w(self.width)
            .h(self.height)
            .rounded(self.radius)
            .when_some(corners, |this, corners| {
                this.rounded_tl(corners.top_left)
                    .rounded_tr(corners.top_right)
                    .rounded_br(corners.bottom_right)
                    .rounded_bl(corners.bottom_left)
            })
            .bg(bg)
            .when(disabled, |this| this.opacity(OPACITY_DISABLED))
            .when(!disabled, |this| {
                this.focus_visible(move |style| style.shadow(focus))
            })
            .child(icon)
            .children(self.badge)
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
