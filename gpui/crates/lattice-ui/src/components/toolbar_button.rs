//! A quiet chrome button with a label: the titlebar's project switcher and
//! "Panels" menu.
//!
//! Measured on the Main window: "Panels" is 28px tall with control corners,
//! 8px in, a 14px icon 6px before its 12px label, both in secondary ink; the
//! label's line is 15px, the bar's normal line height it inherits. The
//! project switcher is the same button at 32px with the project's name in
//! 13px semibold and a 12px chevron 8px after it. It is a tab stop with the
//! one focus ring, and Enter or Space press it.
//!
//! Under the pointer it takes the chrome's hover fill, easing on the fast
//! tier as the app's buttons transition their background and colour; "Panels"
//! also steps its ink up to the primary (`.trellis-titlebar button:hover`),
//! while the switcher keeps its own (`.project-title:hover`). Neither has a
//! pressed fill of its own; a trigger whose menu is open keeps the pressed
//! wash.

use std::rc::Rc;

use gpui::{
    App, ClickEvent, Div, ElementId, FontWeight, InteractiveElement, Interactivity, IntoElement,
    ParentElement as _, Pixels, RenderOnce, SharedString, Stateful, StatefulInteractiveElement,
    StyleRefinement, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::Selectable;

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Surface, focus_ring},
    icons::{ICON, ICON_SMALL},
    interaction::{mix, tab_stop, track_pointer, use_interaction},
    parity,
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct ToolbarButton {
    id: ElementId,
    base: Stateful<Div>,
    label: SharedString,
    icon: Option<Icon>,
    chevron: bool,
    label_shown: bool,
    height: Pixels,
    role: TextRole,
    weight: Option<FontWeight>,
    surface: Surface,
    selected: bool,
    on_click: Option<ClickHandler>,
    parity: Option<SharedString>,
}

impl ToolbarButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        let id = id.into();
        Self {
            base: div().id(id.clone()),
            id,
            label: label.into(),
            icon: None,
            chevron: false,
            label_shown: true,
            height: px(28.),
            role: TextRole::Caption,
            weight: None,
            surface: Surface::Titlebar,
            selected: false,
            on_click: None,
            parity: None,
        }
    }

    /// Name this control as a parity-harness region (`crate::parity`): its
    /// bounds and its label's text style are recorded under `name`.
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
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

    /// Draw the icon alone: the titlebar's Panels menu in its least room
    /// (`.trellis-titlebar-menu > span { display: none }`).
    pub fn label_shown(mut self, shown: bool) -> Self {
        self.label_shown = shown;
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

impl RenderOnce for ToolbarButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let rest = if self.selected {
            palette.pressed
        } else {
            gpui::transparent_black()
        };
        let hover = if self.selected {
            palette.pressed
        } else {
            self.surface.hover(&palette)
        };
        let bg = mix(rest, hover, interaction.hover);
        let ink = if self.chevron {
            palette.text_secondary
        } else {
            mix(palette.text_secondary, palette.text, interaction.hover)
        };
        let focus = focus_ring(&palette, self.surface.ground(&palette));
        // Always a button: its click is its own `on_click` or the one a
        // dropdown menu gives it.
        track_pointer(tab_stop(self.base), pointer)
            .flex()
            .flex_none()
            .items_center()
            .gap(px(if self.chevron { 8. } else { 6. }))
            .h(self.height)
            .px(px(8.))
            .rounded(px(6.))
            .whitespace_nowrap()
            .text_role(self.role, cx)
            .line_height(px(if self.chevron { 16. } else { 15. }))
            .when_some(self.weight, |this, weight| this.font_weight(weight))
            .text_color(ink)
            .bg(bg)
            .focus_visible(move |style| style.shadow(focus))
            .when_some(self.icon, |this, icon| this.child(icon.element(ICON, ink)))
            .children(self.parity.clone().and_then(parity::probe))
            .when(self.label_shown, |this| {
                this.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .children(
                            self.parity
                                .and_then(|name| parity::text_probe(name, 0, self.label.clone())),
                        )
                        .child(self.label),
                )
            })
            .when(self.chevron, |this| {
                this.child(Icon::CHEVRON_DOWN.element(ICON_SMALL, ink))
            })
            .when_some(self.on_click, |this, on_click| {
                this.on_click(move |event, window, cx| on_click(event, window, cx))
            })
    }
}
