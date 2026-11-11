//! A panel tab: the 28px chip in a panel's 40px strip.
//!
//! Measured on the Main window (Project, Agent, main.tex, PDF): 28px tall
//! with 11px corners, the icon 14px in from the left (on the panel's 20px
//! icon gutter), 6px to the 12/15.6 medium label, then a slot for the 14px
//! close X 8px after the label and 7px from the right edge. The slot is kept
//! when the X is hidden, so a tab does not change width on hover. A selected
//! tab is the ink at 10% laid opaque on the panel's own surface; its label is
//! primary ink while its group holds focus, secondary otherwise. The tab and
//! its X are tab stops with the one focus ring; the X shows while it holds
//! keyboard focus.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, InteractiveElement, Interactivity, IntoElement,
    ParentElement as _, RenderOnce, SharedString, Stateful, StatefulInteractiveElement,
    StyleRefinement, Styled, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::focus_ring,
    icons::ICON,
    interaction::{mix, tab_stop, track_pointer, use_interaction},
    token_types::Srgb,
    tokens::OPACITY_HOVER,
};

/// The tab chip's corner: the panel's 18.4px less the strip's 6px inset,
/// as the app rounds it (measured 11px on Paper's Main window).
pub const TAB_RADIUS: gpui::Pixels = px(11.);

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct PanelTab {
    id: ElementId,
    base: Stateful<Div>,
    icon: Option<AnyElement>,
    label: SharedString,
    surface: Srgb,
    selected: bool,
    strong: bool,
    dirty: bool,
    on_close: Option<ClickHandler>,
}

impl PanelTab {
    /// A tab on a panel whose surface is `surface`.
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, surface: Srgb) -> Self {
        let id = id.into();
        Self {
            base: div().id(id.clone()),
            id,
            icon: None,
            label: label.into(),
            surface,
            selected: false,
            strong: false,
            dirty: false,
            on_close: None,
        }
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// The displayed tab of its group.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// Whether the label takes the primary ink: the selected tab of the
    /// group that holds focus.
    pub fn strong(mut self, strong: bool) -> Self {
        self.strong = strong;
        self
    }

    /// Unsaved changes: a dot on the icon's corner.
    pub fn dirty(mut self, dirty: bool) -> Self {
        self.dirty = dirty;
        self
    }

    /// Offer the close X: on the selected tab, and on any tab under the
    /// pointer.
    pub fn on_close(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_close = Some(Rc::new(handler));
        self
    }
}

impl Styled for PanelTab {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for PanelTab {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl StatefulInteractiveElement for PanelTab {}

impl RenderOnce for PanelTab {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let selected_bg = palette.tab_selected_on(self.surface);
        let hover = palette.ink_on(OPACITY_HOVER, self.surface);
        let rest = Srgb {
            a: 0.,
            ..self.surface
        }
        .hsla();
        // A tab moving between rest and hover fades on the fast tier; the
        // selected tab's wash is its state, not a transition.
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let bg = if self.selected {
            selected_bg
        } else {
            mix(rest, hover, interaction.hover)
        };
        let label_ink = if self.selected && self.strong {
            palette.text
        } else {
            palette.text_secondary
        };
        let focus = focus_ring(&palette, self.surface.hsla());
        let close_focus = focus.clone();
        let group: SharedString = "lattice-panel-tab".into();
        let selected = self.selected;
        let dirty_dot = self.dirty.then(|| {
            div()
                .absolute()
                .right(px(-1.))
                .bottom(px(-1.))
                .size(px(5.))
                .rounded_full()
                .bg(palette.text_secondary)
        });
        track_pointer(tab_stop(self.base), pointer)
            .focus_visible(move |style| style.shadow(focus))
            .group(group.clone())
            .flex()
            .flex_none()
            .items_center()
            .h(px(28.))
            .pl(px(14.))
            .pr(px(7.))
            .rounded(TAB_RADIUS)
            .cursor_pointer()
            .bg(bg)
            .child(
                div()
                    .relative()
                    .flex_none()
                    .size(ICON)
                    .children(self.icon)
                    .children(dirty_dot),
            )
            .child(
                div()
                    .ml(px(6.))
                    .whitespace_nowrap()
                    .text_role(TextRole::BodyCompact, cx)
                    .line_height(px(15.6))
                    .text_color(label_ink)
                    .child(self.label),
            )
            .child(
                div()
                    .id("close")
                    .ml(px(8.))
                    .flex_none()
                    .size(ICON)
                    .rounded(px(4.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(self.on_close.is_none() || !selected, |this| {
                        this.invisible()
                    })
                    .when_some(self.on_close, |this, on_close| {
                        tab_stop(this)
                            .group_hover(group, |style| style.visible())
                            .focus_visible(move |style| style.visible().shadow(close_focus))
                            .hover(move |style| style.bg(palette.pressed))
                            .on_click(move |event, window, cx| {
                                cx.stop_propagation();
                                on_close(event, window, cx);
                            })
                    })
                    .child(Icon::CLOSE.element(ICON, palette.text_secondary)),
            )
    }
}
