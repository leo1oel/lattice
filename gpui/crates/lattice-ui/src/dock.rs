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
//!   ⋯ menu at the trailing end, 6px from the edge; short of room the strip
//!   gives way as the Tauri app's does (`strip`);
//! - no dividers: the resize handles keep their hit area and draw nothing;
//! - Trellis's drop slot where a dragged tab will land: the drop target's
//!   wash inside a 2px focus-coloured edge, sliding to the slot on the
//!   moderate tier, with "Add as tab" in a lifted pill over a merge.
//!
//! Docks keep GPUI Kit's own resize handling, so this wraps Kit's skin and
//! forwards the dock hooks to it.

pub mod strip;

use std::{collections::HashMap, rc::Rc, sync::Arc};

use gpui::{
    Anchor, AnimationExt as _, AnyElement, AnyView, App, AppContext as _, Axis, Context, Div,
    Empty, Entity, EntityId, Global, InteractiveElement as _, IntoElement, ParentElement as _,
    Pixels, Render, SharedString, Stateful, StatefulInteractiveElement as _, StyleRefinement,
    Styled as _, WeakEntity, Window, canvas, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::base::ResizeHandleContext;
use gpui_kit::component::{
    dock::{
        BasePanelView, ClosePanel, DockArea, DockAreaRenderer, DockContext, DockPlacement,
        DockSkin, DragPanel, DropIndicator, InsertTarget, NodeId, PaneRef, PanelHandle, PanelId,
        PanelState, TabGroupContext, TabGroupRenderer,
    },
    menu::{DropdownMenu as _, PopupMenu, PopupMenuItem},
};

use crate::{
    ActiveLattice as _, Elevation, GlyphKind, Icon, Motion, Palette, TextRole, TextRoleStyle as _,
    components::{IconButton, PanelTab, Surface, TAB_RADIUS},
    elevation::panel_ring,
    icons::{ICON, file_glyph},
    parity,
    token_types::Srgb,
    typography::shaped_width,
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
    /// A document's tab, which ellipsizes in a narrow strip; a named panel's
    /// (Project, PDF) shows its whole name or only its icon.
    pub document: bool,
}

impl Default for TabLook {
    fn default() -> Self {
        Self {
            icon: TabIcon::None,
            dirty: false,
            surface: Surface::Sheet,
            document: false,
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

    /// How `panel` presents itself, for chrome outside the dock (a floating
    /// panel's strip).
    pub fn look_of(panel: &Arc<dyn BasePanelView>, cx: &App) -> TabLook {
        Self::look(panel, cx)
    }

    fn look(panel: &Arc<dyn BasePanelView>, cx: &App) -> TabLook {
        cx.try_global::<TabPresenter>()
            .map(|presenter| (presenter.0)(panel, cx))
            .unwrap_or_default()
    }
}

/// What a panel's ⋯ menu holds, for the panel it is opened on.
pub struct PanelMenuRequest {
    pub area: WeakEntity<DockArea>,
    pub panel: PanelId,
    pub group: TabGroupContext,
}

type MenuHook = Rc<dyn Fn(PopupMenu, &PanelMenuRequest, &mut Window, &mut App) -> PopupMenu>;

/// The app's items in every panel's ⋯ menu (Float, Hide), added after the
/// panel's own and before the dock's (Maximize, Move to, Close), as the
/// Trellis panel menu orders them.
pub struct PanelMenuItems(MenuHook);

impl Global for PanelMenuItems {}

impl PanelMenuItems {
    pub fn set(
        cx: &mut App,
        items: impl Fn(PopupMenu, &PanelMenuRequest, &mut Window, &mut App) -> PopupMenu + 'static,
    ) {
        cx.set_global(PanelMenuItems(Rc::new(items)));
    }
}

type Closer = Rc<dyn Fn(PanelId, &mut Window, &mut App) -> bool>;

/// The app's say in closing a panel: a tab's X, the ⋯ menu's Close and the
/// close shortcut ask it first, and the group closes the panel itself only
/// when the app leaves it (returns false). GPUI Kit keeps a region's last
/// panel; Trellis lets it go and its neighbours take the room, which the app
/// does by arranging the window without it.
pub struct PanelCloser(Closer);

impl Global for PanelCloser {}

impl PanelCloser {
    pub fn set(cx: &mut App, close: impl Fn(PanelId, &mut Window, &mut App) -> bool + 'static) {
        cx.set_global(PanelCloser(Rc::new(close)));
    }
}

/// Close `panel`, asking the app first.
pub fn close_panel(group: &TabGroupContext, panel: PanelId, window: &mut Window, cx: &mut App) {
    if let Some(close) = cx
        .try_global::<PanelCloser>()
        .map(|closer| closer.0.clone())
        && close(panel, window, cx)
    {
        return;
    }
    group.close(panel, window, cx);
}

/// Each strip's measured width and its tools' natural width, by the area and
/// group they belong to. A strip is laid out from last frame's measurements:
/// a change is recorded after the frame and the window drawn again, so the
/// strip catches up one frame later (`measure`).
#[derive(Default)]
struct StripRoom(HashMap<(EntityId, NodeId), Measured>);

impl Global for StripRoom {}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Measured {
    strip: Option<Pixels>,
    tools: Option<Pixels>,
}

#[derive(Clone, Copy)]
enum Measure {
    Strip,
    Tools,
}

/// An invisible layer over its parent that records the parent's width.
fn measure(key: (EntityId, NodeId), what: Measure) -> impl IntoElement {
    canvas(
        move |bounds, window, cx| {
            let width = bounds.size.width;
            let known = cx
                .try_global::<StripRoom>()
                .and_then(|room| room.0.get(&key))
                .and_then(|measured| match what {
                    Measure::Strip => measured.strip,
                    Measure::Tools => measured.tools,
                });
            if known.is_none_or(|known| (known - width).abs() > px(0.5)) {
                // Recorded once this frame is done, then the window drawn
                // again; a deferred effect runs whatever paces the frames.
                let handle = window.window_handle();
                cx.defer(move |cx| {
                    let measured = cx.default_global::<StripRoom>().0.entry(key).or_default();
                    match what {
                        Measure::Strip => measured.strip = Some(width),
                        Measure::Tools => measured.tools = Some(width),
                    }
                    handle.update(cx, |_, window, _| window.refresh()).ok();
                });
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
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

    fn tab_group_renderer(&self) -> Rc<dyn gpui_kit::component::dock::TabGroupRenderer> {
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

/// A panel's name on its tab.
pub fn tab_name(panel: &Arc<dyn BasePanelView>, cx: &App) -> SharedString {
    PanelHandle::of(panel)
        .and_then(|handle| handle.tab_name(cx))
        .unwrap_or_else(|| panel.panel_name(cx).into())
}

/// The group's parity-harness name: its displayed panel's tab name.
fn group_parity_name(group: &TabGroupContext, cx: &App) -> Option<SharedString> {
    parity::enabled()
        .then(|| group.active_panel().map(|panel| tab_name(panel, cx)))
        .flatten()
}

impl TabGroupRenderer for LatticeTabs {
    fn frame(&self, group: &TabGroupContext, _: &mut Window, cx: &mut App) -> Stateful<Div> {
        let palette = cx.palette();
        let (_, surface) = group_surface(group, palette, cx);
        let close = group.clone();
        let card_probe =
            group_parity_name(group, cx).and_then(|name| parity::probe(format!("card/{name}")));
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
                    .shadow(panel_ring(palette))
                    .children(card_probe),
            )
            .when(!group.is_collapsed(), |this| {
                this.on_action(move |_: &ClosePanel, window, cx| {
                    if let Some(panel) = close.active_panel() {
                        let panel = panel.panel_id(cx);
                        close_panel(&close, panel, window, cx);
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
        let tab_count = group.panels().len();
        let key = (self.area.entity_id(), group.node());

        // What each tab needs, and how the strip fits them.
        let visible: Vec<(usize, Arc<dyn BasePanelView>, TabLook, SharedString)> = group
            .panels()
            .iter()
            .enumerate()
            .filter(|(_, panel)| panel.visible(cx))
            .map(|(ix, panel)| {
                let look = TabPresenter::look(panel, cx);
                (ix, panel.clone(), look, tab_name(panel, cx))
            })
            .collect();
        let specs: Vec<strip::TabSpec> = visible
            .iter()
            .map(|(_, panel, look, name)| strip::TabSpec {
                label: shaped_width(name, TextRole::BodyCompact, None, window, cx),
                named: !look.document,
                selected: Some(panel.panel_id(cx)) == displayed,
                closable: !collapsed && panel.closable(cx),
            })
            .collect();
        let measured = cx
            .try_global::<StripRoom>()
            .and_then(|room| room.0.get(&key).copied())
            .unwrap_or_default();
        let plan = strip::plan(
            measured.strip.unwrap_or(px(f32::MAX / 4.)),
            &specs,
            measured.tools.unwrap_or_default(),
        );
        let suffix = (plan.tools && !collapsed)
            .then(|| handle.and_then(|handle| handle.title_suffix(window, cx)))
            .flatten();

        let tabs = visible
            .into_iter()
            .zip(plan.tabs.iter().copied())
            .map(|((ix, panel, look, name), fit)| {
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
                PanelTab::new(("lattice-tab", ix), name.clone(), surface)
                    .icon(icon)
                    .selected(selected)
                    .strong(focused)
                    .dirty(look.dirty)
                    .fit(fit)
                    .when(parity::enabled(), |tab| tab.parity(format!("tab/{name}")))
                    // The X follows the panel's own permission, as the app
                    // draws it; the group may still keep its last panel.
                    .when(!collapsed && panel.closable(cx), |tab| {
                        let group = group.clone();
                        tab.on_close(move |_, window, cx| close_panel(&group, panel_id, window, cx))
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
            .min_w(px(8.))
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

        let strip_probe =
            group_parity_name(group, cx).and_then(|name| parity::probe(format!("strip/{name}")));
        let menu = (!collapsed).then(|| {
            let area = self.area.clone();
            let menu_group = group.clone();
            IconButton::new("lattice-panel-menu", Icon::DOTS)
                .frame(strip::MENU_WIDTH, px(28.))
                .radius(TAB_RADIUS)
                .surface(surface_kind)
                .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, window, cx| {
                    panel_menu(menu, &area, &menu_group, window, cx)
                })
        });

        div()
            .id("lattice-tab-strip")
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .h(STRIP_HEIGHT)
            .px(strip::STRIP_PADDING)
            .gap(strip::STRIP_GAP)
            .children(strip_probe)
            .child(measure(key, Measure::Strip))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .items_center()
                    .gap(strip::TAB_SPACING)
                    .overflow_hidden()
                    .children(tabs)
                    .child(end_drop),
            )
            .children(suffix.map(|suffix| {
                div()
                    .relative()
                    .flex()
                    .flex_none()
                    .items_center()
                    .child(suffix)
                    .child(measure(key, Measure::Tools))
            }))
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
        // Trellis's drop slot: the drop target's wash inside a 2px edge of the
        // focus colour, with the panel's corners. It slides from where it
        // was to where the drop would land, replaying when the target moves.
        let palette = cx.palette().clone();
        let (from, to) = (indicator.from(), indicator.to());
        let merge = indicator.placement().is_none();
        let label = merge.then(|| {
            div()
                .absolute()
                .top(px(12.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .px(px(12.))
                        .py(px(6.))
                        .rounded_full()
                        .bg(palette.raised)
                        .shadow(Elevation::Popover.shadows(&palette))
                        .whitespace_nowrap()
                        .text_role(TextRole::BodyCompact, cx)
                        .text_color(palette.text)
                        .child("Add as tab"),
                )
        });
        let lerp = |a: Pixels, b: Pixels, t: f32| a + (b - a) * t;
        Some(
            div()
                .absolute()
                .left(to.origin().x)
                .top(to.origin().y)
                .w(to.size().width)
                .h(to.size().height)
                .rounded(PANEL_RADIUS)
                .bg(palette.drop_target)
                .border_2()
                .border_color(palette.focus)
                .children(label)
                .with_animation(
                    ("lattice-drop-slot", indicator.epoch()),
                    Motion::Moderate.animation(),
                    move |slot, t| {
                        slot.left(lerp(from.origin().x, to.origin().x, t))
                            .top(lerp(from.origin().y, to.origin().y, t))
                            .w(lerp(from.size().width, to.size().width, t))
                            .h(lerp(from.size().height, to.size().height, t))
                    },
                )
                .into_any_element(),
        )
    }
}

/// A panel's ⋯ menu, as Trellis orders it: the panel's own items, the app's
/// (Float, Hide), then Maximize or Restore size, Move to (another group, a
/// new split right or below), Close and Close other tabs.
fn panel_menu(
    menu: PopupMenu,
    area: &WeakEntity<DockArea>,
    group: &TabGroupContext,
    window: &mut Window,
    cx: &mut gpui::Context<PopupMenu>,
) -> PopupMenu {
    let Some(panel) = group.active_panel().cloned() else {
        return menu;
    };
    let panel_id = panel.panel_id(cx);
    let name = tab_name(&panel, cx);
    let mut menu = match PanelHandle::of(&panel) {
        Some(handle) => handle.panel().dropdown_menu(menu, window, cx),
        None => menu,
    };
    if !menu.is_empty() {
        menu = menu.separator();
    }
    if let Some(items) = cx
        .try_global::<PanelMenuItems>()
        .map(|items| items.0.clone())
    {
        let request = PanelMenuRequest {
            area: area.clone(),
            panel: panel_id,
            group: group.clone(),
        };
        menu = items(menu, &request, window, cx);
    }

    let zoomed = group.is_zoomed();
    let zoom_group = group.clone();
    menu = menu.item(
        PopupMenuItem::new(if zoomed { "Restore size" } else { "Maximize" })
            .icon(
                if zoomed {
                    Icon::MINIMIZE
                } else {
                    Icon::MAXIMIZE
                }
                .kit(),
            )
            .on_click(move |_, window, cx| zoom_group.toggle_zoom(window, cx)),
    );

    // Move to: the other groups, then a new split beside this one.
    let node = group.node();
    let targets = area
        .upgrade()
        .map(|area| move_targets(&area.read(cx), node, cx))
        .unwrap_or_default();
    let move_area = area.clone();
    menu = menu.submenu_with_icon(
        Some(Icon::ARROW_RIGHT_LEFT.kit()),
        format!("Move {name} to"),
        window,
        cx,
        move |mut submenu, _, _| {
            for (target, label) in &targets {
                let (area, target) = (move_area.clone(), *target);
                submenu = submenu.item(PopupMenuItem::new(label.clone()).on_click(
                    move |_, window, cx| {
                        area.update(cx, |area, cx| {
                            area.move_panel(
                                panel_id,
                                InsertTarget::Tabs {
                                    node: target,
                                    ix: None,
                                    activate: true,
                                },
                                window,
                                cx,
                            )
                        })
                        .ok();
                    },
                ));
            }
            if !targets.is_empty() {
                submenu = submenu.separator();
            }
            for (label, icon, placement) in [
                (
                    "New split right",
                    Icon::COLUMNS_2,
                    gpui_kit::base::Placement::Right,
                ),
                (
                    "New split below",
                    Icon::ROWS_2,
                    gpui_kit::base::Placement::Bottom,
                ),
            ] {
                let area = move_area.clone();
                submenu = submenu.item(PopupMenuItem::new(label).icon(icon.kit()).on_click(
                    move |_, window, cx| {
                        area.update(cx, |area, cx| {
                            area.split_at(node, panel_id, placement, window, cx)
                        })
                        .ok();
                    },
                ));
            }
            submenu
        },
    );

    if panel.closable(cx) {
        let close = group.clone();
        menu = menu.separator().item(
            PopupMenuItem::new(format!("Close {name}"))
                .icon(Icon::X.kit())
                .on_click(move |_, window, cx| close_panel(&close, panel_id, window, cx)),
        );
        let others: Vec<PanelId> = group
            .panels()
            .iter()
            .filter(|other| other.closable(cx))
            .map(|other| other.panel_id(cx))
            .filter(|other| *other != panel_id)
            .collect();
        if !others.is_empty() {
            let close = group.clone();
            menu = menu.item(
                PopupMenuItem::new("Close other tabs")
                    .icon(Icon::CIRCLE_X.kit())
                    .on_click(move |_, window, cx| {
                        for other in &others {
                            close_panel(&close, *other, window, cx);
                        }
                    }),
            );
        }
    }
    menu
}

/// Every other tab group in the area, named by its displayed panel.
fn move_targets(area: &DockArea, from: NodeId, cx: &App) -> Vec<(NodeId, SharedString)> {
    let mut targets = Vec::new();
    for placement in [
        DockPlacement::Left,
        DockPlacement::Center,
        DockPlacement::Right,
        DockPlacement::Bottom,
    ] {
        let Some(tree) = area.layout(placement) else {
            continue;
        };
        tree.root().walk(&mut |node| {
            if let PaneRef::Tabs { panels, active_ix } = node.kind()
                && node.id() != from
                && let Some(panel) = panels
                    .get(active_ix)
                    .or(panels.first())
                    .and_then(|id| area.panel(*id))
            {
                targets.push((node.id(), tab_name(panel, cx)));
            }
        });
    }
    targets
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_named_tab_by_default() {
        assert!(!TabLook::default().document);
    }
}
