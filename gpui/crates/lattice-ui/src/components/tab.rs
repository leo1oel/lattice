//! A panel tab: the 28px chip in a panel's 40px strip.
//!
//! As `src/trellis/trellis.css` lays it out: 28px tall with 11px corners, the
//! 14px icon 14px in from the left (on the panel's 20px icon gutter), 6px to
//! the 12/15.6 medium label, 6px to a 24px close square held 2px off the
//! tab's end, its corner the tab's less that inset. A tab whose panel cannot
//! close has no square, and ends 14px after its label instead. The square is
//! kept when the X is hidden, so a tab does not change width on hover.
//!
//! A selected tab is the ink at 10% laid opaque on the panel's own surface;
//! its label is primary ink while its group holds focus, secondary otherwise.
//! An unselected tab's label takes the primary ink under the pointer. The tab
//! and its X are tab stops with the one focus ring; the X shows on the
//! selected tab, under the pointer, and while it holds keyboard focus.
//!
//! Short of room the strip (`dock::strip`) asks a tab to give way: a
//! document's tab shrinks with an ellipsis down to a minimum width, and a
//! named panel's tab (Project, PDF) drops its label for its icon alone.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, InteractiveElement, Interactivity, IntoElement,
    MouseButton, ParentElement as _, Pixels, RenderOnce, SharedString, Stateful,
    StatefulInteractiveElement, StyleRefinement, Styled, Window, div, prelude::FluentBuilder as _,
    px, transparent_black,
};

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::focus_ring,
    icons::ICON,
    interaction::{mix, tab_stop, track_pointer, use_interaction},
    parity,
    token_types::Srgb,
    tokens::OPACITY_HOVER,
};

/// The tab chip's corner: `shape::PANEL_TABS` (the panel's 10px less the
/// strip's 6px inset, held at a control's 6px), smoothed with the panel
/// (`shape::CHROME`), as Paper's Main window measures it (11px).
pub const TAB_RADIUS: gpui::Pixels = px(11.);
/// The tab's leading padding, which puts its icon on the panel's icon gutter.
pub const TAB_INSET: Pixels = px(14.);
/// Between the icon, the label and the close square.
pub const TAB_GAP: Pixels = px(6.);
/// The close square, and how far it stands off the tab's end.
pub const TAB_CLOSE: Pixels = px(24.);
pub const TAB_CLOSE_INSET: Pixels = px(2.);
/// An icon-only tab's padding on either side of its icon.
pub const TAB_ICON_ONLY_INSET: Pixels = px(8.);

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// How a tab fits its strip (`dock::strip::plan`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TabFit {
    /// At its natural width.
    Full,
    /// Shrinks with the strip, its label ending in an ellipsis, down to `min`.
    Shrinks { min: Pixels },
    /// Its icon alone; the name stays in its tooltip.
    IconOnly,
}

impl TabFit {
    /// The tab's width at rest: `label` is its label's shaped width.
    pub fn natural_width(label: Pixels, closable: bool) -> Pixels {
        let end = if closable {
            TAB_GAP + TAB_CLOSE + TAB_CLOSE_INSET
        } else {
            TAB_INSET
        };
        TAB_INSET + ICON + TAB_GAP + label + end
    }

    pub fn icon_only_width() -> Pixels {
        TAB_ICON_ONLY_INSET * 2. + ICON
    }
}

#[derive(IntoElement)]
pub struct PanelTab {
    id: ElementId,
    base: Stateful<Div>,
    icon: Option<AnyElement>,
    label: SharedString,
    surface: Srgb,
    /// On a frosted card: its fills lay over what shows through.
    frosted: bool,
    selected: bool,
    strong: bool,
    dirty: bool,
    closable: bool,
    fit: TabFit,
    on_close: Option<ClickHandler>,
    parity: Option<SharedString>,
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
            frosted: false,
            selected: false,
            strong: false,
            dirty: false,
            closable: false,
            fit: TabFit::Full,
            on_close: None,
            parity: None,
        }
    }

    /// Name this control as a parity-harness region (`crate::parity`): its
    /// bounds and its label's text style are recorded under `name`.
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// The tab stands on a frosted card (`Palette::with_glass`): selected,
    /// it is 10% of the ink in the card's veil; hovered, the ink at the
    /// hover's 5%, both laid over the card rather than opaque.
    pub fn frosted(mut self, frosted: bool) -> Self {
        self.frosted = frosted;
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

    /// How the tab fits its strip.
    pub fn fit(mut self, fit: TabFit) -> Self {
        self.fit = fit;
        self
    }

    /// Whether the panel can close at all, which keeps the close square in
    /// the tab's width. The X itself shows only with [`Self::on_close`].
    pub fn closable(mut self, closable: bool) -> Self {
        self.closable = closable;
        self
    }

    /// Offer the close X: on the selected tab, and on any tab under the
    /// pointer.
    pub fn on_close(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.closable = true;
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
        let (selected_bg, hover) = if self.frosted {
            (palette.tab_selected_on_glass(), palette.ink(OPACITY_HOVER))
        } else {
            (
                palette.tab_selected_on(self.surface),
                palette.ink_on(OPACITY_HOVER, self.surface),
            )
        };
        let close_hover = if self.surface == palette.chrome_srgb {
            palette.chrome_hover
        } else {
            palette.hover
        };
        let rest = if self.frosted {
            gpui::Hsla { a: 0., ..hover }
        } else {
            Srgb {
                a: 0.,
                ..self.surface
            }
            .hsla()
        };
        // A tab moving between rest and hover fades on the fast tier; the
        // selected tab's wash is its state, not a transition.
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let bg = if self.selected {
            selected_bg
        } else {
            mix(rest, hover, interaction.hover)
        };
        let label_ink = if self.selected {
            if self.strong {
                palette.text
            } else {
                palette.text_secondary
            }
        } else {
            mix(palette.text_secondary, palette.text, interaction.hover)
        };
        let focus = focus_ring(&palette, self.surface.hsla());
        let close_focus = focus.clone();
        let group: SharedString = "lattice-panel-tab".into();
        let selected = self.selected;
        let icon_only = self.fit == TabFit::IconOnly;
        let shrinks = match self.fit {
            TabFit::Shrinks { min } => Some(min),
            _ => None,
        };
        let dirty_dot = self.dirty.then(|| {
            div()
                .absolute()
                .right(px(-1.))
                .bottom(px(-1.))
                .size(px(5.))
                .rounded_full()
                .bg(palette.text_secondary)
        });
        let closable = self.closable && !icon_only;
        // The close square fades its wash in and its ink up on the fast tier
        // (`trellis.css`, `[data-trellis-part="tab-close"]:hover`).
        let close_id = ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "close".into());
        let (close_interaction, close_pointer) = use_interaction(close_id, window, cx);
        let close_bg = mix(transparent_black(), close_hover, close_interaction.hover);
        let close_ink = mix(
            palette.text_secondary,
            palette.text,
            close_interaction.hover,
        );
        let tooltip_label = self.label.clone();
        track_pointer(tab_stop(self.base), pointer)
            .focus_visible(move |style| style.shadow(focus))
            .group(group.clone())
            .flex()
            .items_center()
            .h(px(28.))
            .map(|tab| match shrinks {
                Some(min) => tab.flex_shrink_1().min_w(min),
                None => tab.flex_none(),
            })
            .map(|tab| {
                if icon_only {
                    tab.px(TAB_ICON_ONLY_INSET)
                } else if closable {
                    tab.pl(TAB_INSET).pr(TAB_CLOSE_INSET)
                } else {
                    tab.px(TAB_INSET)
                }
            })
            .rounded(TAB_RADIUS)
            .cursor_pointer()
            .bg(bg)
            .when(icon_only, |tab| {
                tab.tooltip(move |_, cx| -> gpui::AnyView {
                    crate::components::LatticeTooltip::view(tooltip_label.clone(), None, cx)
                })
            })
            .children(self.parity.clone().and_then(parity::probe))
            .child(
                div()
                    .relative()
                    .flex_none()
                    .size(ICON)
                    .children(self.icon)
                    .children(dirty_dot),
            )
            .when(!icon_only, |tab| {
                tab.child(
                    div()
                        .ml(TAB_GAP)
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .when(shrinks.is_some(), |label| {
                            label.flex_shrink_1().text_ellipsis()
                        })
                        .text_role(TextRole::BodyCompact, cx)
                        .line_height(px(15.6))
                        .text_color(label_ink)
                        .children(
                            self.parity
                                .and_then(|name| parity::text_probe(name, 0, self.label.clone())),
                        )
                        .child(self.label),
                )
            })
            .when(closable, |tab| {
                tab.child(
                    div()
                        .id("close")
                        .ml(TAB_GAP)
                        .flex_none()
                        .size(TAB_CLOSE)
                        .rounded(crate::shape::CHROME.paint(crate::shape::TAB_CLOSE.inner()))
                        .flex()
                        .items_center()
                        .justify_center()
                        .when(self.on_close.is_none() || !selected, |this| {
                            this.invisible()
                        })
                        .when_some(self.on_close, |this, on_close| {
                            track_pointer(tab_stop(this), close_pointer)
                                .group_hover(group, |style| style.visible())
                                .focus_visible(move |style| style.visible().shadow(close_focus))
                                .bg(close_bg)
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .on_click(move |event, window, cx| {
                                    cx.stop_propagation();
                                    on_close(event, window, cx);
                                })
                        })
                        .child(Icon::CLOSE.element(ICON, close_ink)),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closable_tab_is_its_label_plus_66px() {
        // 14 + 14 icon + 6 + label + 6 + 24 close + 2: the app's 107.64px
        // Project tab around a 41.64px label.
        assert_eq!(TabFit::natural_width(px(41.64), true), px(107.64));
    }

    /// A design token's size at the 16px root the Tauri app lays out on.
    fn token(rems: gpui::Rems) -> Pixels {
        px(rems.0 * 16.)
    }

    #[test]
    fn a_tab_without_a_close_square_ends_one_inset_after_its_label() {
        // trellis.css: a tab pads `--tab-inset-inline` at its start, spaces
        // its icon and title by `--space-3`, and pads `--tab-inset-inline` at
        // its end while its close square is hidden.
        let inset = token(crate::tokens::SPACING_TAB_INSET);
        let expected = inset
            + token(crate::tokens::SPACING_ICON)
            + token(crate::tokens::SPACING_3)
            + px(20.)
            + inset;
        assert_eq!(TabFit::natural_width(px(20.), false), expected);
    }

    #[test]
    fn an_icon_only_tab_is_its_icon_inside_space_4() {
        // trellis.css: `[data-icon-only]` drops the gap and pads
        // `--space-4` on each side of the icon.
        let expected = token(crate::tokens::SPACING_4) * 2. + token(crate::tokens::SPACING_ICON);
        assert_eq!(TabFit::icon_only_width(), expected);
    }
}
