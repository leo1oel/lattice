//! The Trellis look for GPUI Kit's dock: every tab group a rounded card on
//! the chrome, with a 40px strip of pill tabs.
//!
//! GPUI Kit's `DockArea` keeps the behaviour (the pane tree, docks, drag and
//! drop, resizing, persistence) and asks a renderer for every pixel. This
//! renderer draws what Paper's Main window measures on the running app:
//!
//! - a card per tab group: 18.4px corners, the panel's surface (the chrome
//!   for navigation panels, the sheet for stage panels), a 1px ring of the
//!   hairline at 70%, and 6px of chrome between cards (3px of padding on
//!   each group, so two neighbours add up to the gutter);
//! - a 40px strip: tabs 6px in, 2px apart, the panel's own accessories and a
//!   ⋯ menu at the trailing end, 6px from the edge;
//! - no dividers: the resize handles keep their hit area and draw nothing.
//!
//! Docks keep GPUI Kit's own resize handling, so this wraps Kit's skin and
//! forwards the dock hooks to it.

use std::{rc::Rc, sync::Arc};

use gpui::{
    Anchor, AnyElement, AnyView, App, AppContext as _, Axis, Context, Div, Empty, Entity, Global,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Stateful,
    StatefulInteractiveElement as _, StyleRefinement, Styled as _, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::base::ResizeHandleContext;
use gpui_kit::component::{
    dock::{
        BasePanelView, ClosePanel, DockArea, DockAreaRenderer, DockContext, DockPlacement,
        DockSkin, DragPanel, DropIndicator, NodeId, PanelHandle, PanelState, TabGroupContext,
        TabGroupRenderer,
    },
    menu::DropdownMenu as _,
};

use crate::{
    ActiveLattice as _, Elevation, GlyphKind, Icon, Palette,
    components::{IconButton, PanelTab, Surface, TAB_RADIUS},
    elevation::panel_ring,
    icons::{ICON, file_glyph},
    token_types::Srgb,
};

/// A panel card's corner, as the running app draws it (Paper's Main window
/// measures 18.4px; the `--radius-panel` token says 10).
pub const PANEL_RADIUS: gpui::Pixels = px(18.4);
/// Half the 6px gutter between cards: each group pads itself by this much.
pub const GROUP_INSET: gpui::Pixels = px(3.);
/// Every panel's tab strip, and the titlebar.
pub const STRIP_HEIGHT: gpui::Pixels = px(40.);

/// What a panel's tab shows besides its name.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TabIcon {
    None,
    Icon(Icon),
    Glyph(GlyphKind),
}

/// How the app presents one of its panels in the dock.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabLook {
    pub icon: TabIcon,
    pub dirty: bool,
    pub surface: Surface,
}

impl Default for TabLook {
    fn default() -> Self {
        Self {
            icon: TabIcon::None,
            dirty: false,
            surface: Surface::Sheet,
        }
    }
}

type Presenter = Rc<dyn Fn(&Arc<dyn BasePanelView>, &App) -> TabLook>;

/// The app's answer to "how does this panel's tab look". The dock sees panels
/// only as trait objects, so the app, which knows their types, registers one
/// function that recognises them.
pub struct TabPresenter(Presenter);

impl Global for TabPresenter {}

impl TabPresenter {
    pub fn set(cx: &mut App, present: impl Fn(&Arc<dyn BasePanelView>, &App) -> TabLook + 'static) {
        cx.set_global(TabPresenter(Rc::new(present)));
    }

    fn look(panel: &Arc<dyn BasePanelView>, cx: &App) -> TabLook {
        cx.try_global::<TabPresenter>()
            .map(|presenter| (presenter.0)(panel, cx))
            .unwrap_or_default()
    }
}

/// The renderer to install on a `DockArea`.
pub struct LatticeDock {
    kit: Rc<DockSkin>,
    area: WeakEntity<DockArea>,
}

impl LatticeDock {
    /// A `DockArea` wearing this look. The skin needs the area's own handle,
    /// so it is built while the area is.
    pub fn dock_area(
        id: impl Into<SharedString>,
        version: Option<usize>,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<DockArea> {
        cx.new(|cx: &mut Context<DockArea>| {
            let kit = DockSkin::new(cx);
            let this = Rc::new(LatticeDock {
                kit,
                area: cx.weak_entity(),
            });
            DockArea::new(id, version, window, cx).with_renderer(this)
        })
    }
}

impl DockAreaRenderer for LatticeDock {
    fn frame(&self, _: &mut Window, _: &mut App) -> Stateful<Div> {
        div().id("lattice-dock-area")
    }

    fn split_frame(&self, node: NodeId, _: Axis, _: &mut Window, _: &mut App) -> Stateful<Div> {
        div().id(("lattice-dock-split", node.as_u64()))
    }

    fn center_frame(&self, _: &mut Window, _: &mut App) -> Stateful<Div> {
        div().id("lattice-dock-center")
    }

    fn render_split_handle(
        &self,
        _: &ResizeHandleContext,
        _: &mut Window,
        _: &mut App,
    ) -> Option<AnyElement> {
        Some(Empty.into_any_element())
    }

    fn render_dock(
        &self,
        dock: &DockContext,
        content: AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        self.kit.render_dock(dock, content, window, cx)
    }

    fn build_placeholder(
        &self,
        state: &PanelState,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Arc<dyn BasePanelView>> {
        self.kit.build_placeholder(state, window, cx)
    }

    fn tab_group_renderer(&self) -> Rc<dyn TabGroupRenderer> {
        Rc::new(LatticeTabs {
            area: self.area.clone(),
        })
    }
}

struct LatticeTabs {
    area: WeakEntity<DockArea>,
}

/// The group's card surface, from its displayed panel.
fn group_surface(group: &TabGroupContext, palette: &Palette, cx: &App) -> (Surface, Srgb) {
    let surface = group
        .active_panel()
        .map(|panel| TabPresenter::look(panel, cx).surface)
        .unwrap_or_default();
    let color = match surface {
        Surface::Chrome | Surface::Titlebar => palette.chrome_srgb,
        Surface::Sheet => palette.editor_srgb,
    };
    (surface, color)
}

impl TabGroupRenderer for LatticeTabs {
    fn frame(&self, group: &TabGroupContext, _: &mut Window, cx: &mut App) -> Stateful<Div> {
        let palette = cx.palette();
        let (_, surface) = group_surface(group, palette, cx);
        let close = group.clone();
        div()
            .id("lattice-tab-group")
            .relative()
            .p(GROUP_INSET)
            // The card, under the strip and the content base adds after it.
            .child(
                div()
                    .absolute()
                    .top(GROUP_INSET)
                    .left(GROUP_INSET)
                    .right(GROUP_INSET)
                    .bottom(GROUP_INSET)
                    .rounded(PANEL_RADIUS)
                    .bg(surface.hsla())
                    .shadow(panel_ring(palette)),
            )
            .when(!group.is_collapsed(), |this| {
                this.on_action(move |_: &ClosePanel, window, cx| {
                    if let Some(panel) = close.active_panel() {
                        let panel = panel.panel_id(cx);
                        close.close(panel, window, cx);
                    }
                })
            })
    }

    fn content_frame(&self, _: &TabGroupContext, _: &mut Window, _: &mut App) -> Stateful<Div> {
        div().id("lattice-tab-content")
    }

    fn render_tab_bar(
        &self,
        group: &TabGroupContext,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let (surface_kind, surface) = group_surface(group, &palette, cx);
        let collapsed = group.is_collapsed();
        let droppable = group.is_droppable();
        let displayed = group.active_panel().map(|panel| panel.panel_id(cx));
        let focused = group
            .active_panel()
            .is_some_and(|panel| panel.focus_handle(cx).contains_focused(window, cx));
        let handle = group.active_panel().and_then(PanelHandle::of);
        let suffix = handle.and_then(|handle| handle.title_suffix(window, cx));
        let menu_panel = handle.map(|handle| handle.panel());
        let closable = group.is_closable();
        let tab_count = group.panels().len();

        let tabs = group
            .panels()
            .iter()
            .enumerate()
            .filter(|(_, panel)| panel.visible(cx))
            .map(|(ix, panel)| {
                let look = TabPresenter::look(panel, cx);
                let name: SharedString = PanelHandle::of(panel)
                    .and_then(|handle| handle.tab_name(cx))
                    .unwrap_or_else(|| panel.panel_name(cx).into());
                let selected = !collapsed && Some(panel.panel_id(cx)) == displayed;
                let panel_id = panel.panel_id(cx);
                let drag = group
                    .is_draggable()
                    .then(|| group.drag_panel(ix, cx))
                    .flatten();
                let icon = tab_icon(look.icon, &palette);
                let preview = TabDragPreview {
                    name: name.clone(),
                    icon: look.icon,
                };
                let refocus = selected.then(|| panel.focus_handle(cx));
                PanelTab::new(("lattice-tab", ix), name, surface)
                    .icon(icon)
                    .selected(selected)
                    .strong(focused)
                    .dirty(look.dirty)
                    // The X follows the panel's own permission, as the app
                    // draws it; the group may still keep its last panel.
                    .when(!collapsed && panel.closable(cx), |tab| {
                        let group = group.clone();
                        tab.on_close(move |_, window, cx| group.close(panel_id, window, cx))
                    })
                    .on_click({
                        let group = group.clone();
                        let area = self.area.clone();
                        move |_, window, cx| {
                            group.select_tab(ix, window, cx);
                            if let Some(focus) = &refocus {
                                focus.focus(window, cx);
                            }
                            // A collapsed bottom dock's strip is how it opens.
                            if collapsed {
                                area.update(cx, |area, cx| {
                                    area.toggle_dock(DockPlacement::Bottom, window, cx)
                                })
                                .ok();
                            }
                        }
                    })
                    .when(!collapsed, |tab| {
                        tab.when_some(drag, |tab, drag| {
                            tab.on_drag(drag, move |drag, offset, _, cx| {
                                cx.stop_propagation();
                                drag.set_drag_offset(offset);
                                drag.set_preview_size(gpui::size(px(120.), px(28.)));
                                cx.new(|_| preview.clone())
                            })
                        })
                        .when(droppable, |tab| {
                            let drop_bg = palette.drop_target;
                            let group = group.clone();
                            tab.drag_over::<DragPanel>(move |style, _, _, _| style.bg(drop_bg))
                                .on_drop(move |drag: &DragPanel, window, cx| {
                                    group.drop_panel(drag.clone(), Some(ix), true, window, cx);
                                })
                        })
                    })
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        // Past the last tab: a panel dropped here joins the group at the end.
        let end_drop = div()
            .id("lattice-tab-strip-end")
            .h_full()
            .flex_1()
            .min_w(px(16.))
            .when(droppable && !collapsed, |this| {
                let group = group.clone();
                let node = group.node();
                let drop_bg = palette.drop_target;
                this.drag_over::<DragPanel>(move |style, _, _, _| style.bg(drop_bg))
                    .on_drop(move |drag: &DragPanel, window, cx| {
                        let ix = (drag.source() == node).then(|| tab_count - 1);
                        group.drop_panel(drag.clone(), ix, false, window, cx);
                    })
            });

        let menu = (!collapsed).then(|| {
            IconButton::new("lattice-panel-menu", Icon::DOTS)
                .frame(px(24.), px(28.))
                .radius(TAB_RADIUS)
                .surface(surface_kind)
                .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, window, cx| {
                    let menu = match &menu_panel {
                        Some(panel) => panel.dropdown_menu(menu, window, cx),
                        None => menu,
                    };
                    if closable {
                        menu.separator().menu("Close", Box::new(ClosePanel))
                    } else {
                        menu
                    }
                })
        });

        div()
            .id("lattice-tab-strip")
            .flex()
            .flex_none()
            .items_center()
            .h(STRIP_HEIGHT)
            .px(px(6.))
            .gap(px(4.))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .items_center()
                    .gap(px(2.))
                    .overflow_hidden()
                    .children(tabs)
                    .child(end_drop),
            )
            .children(suffix.filter(|_| !collapsed))
            .children(menu)
            .into_any_element()
    }

    fn render_active_panel(
        &self,
        panel: AnyView,
        group: &TabGroupContext,
        _: &mut Window,
        _: &mut App,
    ) -> AnyElement {
        if group.is_collapsed() {
            return Empty.into_any_element();
        }
        div()
            .id("lattice-panel-content")
            .relative()
            .flex_1()
            .min_h_0()
            .child(panel.cached(StyleRefinement::default().absolute().size_full()))
            .into_any_element()
    }

    fn render_drop_indicator(
        &self,
        indicator: DropIndicator,
        _: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        // Trellis's drop slot: a wash with the focus colour as its edge.
        let palette = cx.palette();
        let to = indicator.to();
        Some(
            div()
                .absolute()
                .left(to.origin().x)
                .top(to.origin().y)
                .w(to.size().width)
                .h(to.size().height)
                .rounded(TAB_RADIUS)
                .bg(palette.drop_target)
                .border_1()
                .border_color(palette.focus)
                .into_any_element(),
        )
    }
}

fn tab_icon(icon: TabIcon, palette: &Palette) -> AnyElement {
    match icon {
        TabIcon::None => Empty.into_any_element(),
        TabIcon::Icon(icon) => icon
            .element(ICON, palette.text_secondary)
            .into_any_element(),
        TabIcon::Glyph(kind) => file_glyph(kind, ICON, palette),
    }
}

/// The chip that follows the pointer while a tab is dragged.
#[derive(Clone)]
struct TabDragPreview {
    name: SharedString,
    icon: TabIcon,
}

impl Render for TabDragPreview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .h(px(28.))
            .pl(px(14.))
            .pr(px(14.))
            .rounded(TAB_RADIUS)
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .cursor_grab()
            .child(tab_icon(self.icon, &palette))
            .child(
                div()
                    .whitespace_nowrap()
                    .text_size(px(12.))
                    .text_color(palette.text)
                    .child(self.name.clone()),
            )
    }
}
