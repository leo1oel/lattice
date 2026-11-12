//! Floating panels: a panel lifted out of the dock into a card over it, as
//! Trellis floats one (its ⋯ menu's Float). GPUI Kit's dock has no floating
//! placement, so the shell keeps the floating panels itself and draws them
//! over the workspace: the panel's own card on the floating elevation with
//! its 40px strip, moved by its strip and resized from its corner. Dock (the
//! same menu item) puts it back where its kind belongs.

use std::{collections::HashMap, sync::Arc};

use gpui::{
    AnyElement, AnyView, App, AppContext as _, Bounds, Context, Empty, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, Point, Render, Size, StatefulInteractiveElement as _,
    StyleRefinement, Styled as _, Window, div, point, px, size,
};
use gpui_kit::component::{
    dock::{BasePanelView, PanelHandle, PanelId},
    menu::{DropdownMenu as _, PopupMenuItem},
};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon,
    components::{IconButton, PanelTab, Surface, TAB_RADIUS},
    dock::{PANEL_RADIUS, STRIP_HEIGHT, TabIcon, TabPresenter, tab_name},
    icons::{ICON, file_glyph},
};

use super::{
    Shell,
    layout::{FloatingView, View},
};

/// A new floating panel's size, and how far from the workspace's corner it
/// first stands.
const FLOAT_SIZE: (f32, f32) = (420., 480.);
const FLOAT_OFFSET: f32 = 72.;
const MIN_SIZE: (f32, f32) = (240., 160.);
/// The corner grip.
const GRIP: f32 = 14.;

pub(crate) struct FloatingPanel {
    pub id: PanelId,
    pub panel: Arc<dyn BasePanelView>,
    pub view: View,
    /// Within the workspace area.
    pub bounds: Bounds<Pixels>,
}

#[derive(Default)]
pub(crate) struct FloatingLayer {
    panels: Vec<FloatingPanel>,
}

impl FloatingLayer {
    pub fn contains(&self, panel: PanelId) -> bool {
        self.panels
            .iter()
            .any(|floating| floating.panel_id() == panel)
    }

    /// The floating panels as an arrangement records them.
    pub fn records(&self) -> Vec<FloatingView> {
        self.panels
            .iter()
            .map(|floating| FloatingView {
                view: floating.view.clone(),
                x: f32::from(floating.bounds.origin.x),
                y: f32::from(floating.bounds.origin.y),
                width: f32::from(floating.bounds.size.width),
                height: f32::from(floating.bounds.size.height),
            })
            .collect()
    }

    /// Float exactly the panels `records` lists, at their bounds kept
    /// within the workspace `area`, with the window's panels for their views.
    pub fn set(
        &mut self,
        records: &[FloatingView],
        panels: &HashMap<View, Arc<dyn BasePanelView>>,
        area: Size<Pixels>,
        cx: &App,
    ) {
        self.panels = records
            .iter()
            .filter_map(|record| {
                let panel = panels.get(&record.view)?.clone();
                Some(FloatingPanel {
                    id: panel.panel_id(cx),
                    panel,
                    view: record.view.clone(),
                    bounds: within(
                        Bounds {
                            origin: point(px(record.x), px(record.y)),
                            size: size(px(record.width), px(record.height)),
                        },
                        area,
                    ),
                })
            })
            .collect();
    }

    pub fn remove(&mut self, panel: PanelId) -> Option<FloatingPanel> {
        let ix = self
            .panels
            .iter()
            .position(|floating| floating.panel_id() == panel)?;
        Some(self.panels.remove(ix))
    }

    fn bring_to_front(&mut self, panel: PanelId) {
        if let Some(ix) = self.panels.iter().position(|f| f.panel_id() == panel) {
            let floating = self.panels.remove(ix);
            self.panels.push(floating);
        }
    }

    pub fn render(&self, cx: &mut Context<Shell>) -> Vec<AnyElement> {
        self.panels
            .iter()
            .map(|floating| floating.render(cx))
            .collect()
    }
}

/// `bounds` moved and shrunk as far as it takes to lie within `area`, so a
/// panel saved in a larger window can still be reached by its strip.
fn within(bounds: Bounds<Pixels>, area: Size<Pixels>) -> Bounds<Pixels> {
    let width = bounds.size.width.min(area.width);
    let height = bounds.size.height.min(area.height);
    Bounds {
        origin: point(
            bounds.origin.x.min(area.width - width).max(px(0.)),
            bounds.origin.y.min(area.height - height).max(px(0.)),
        ),
        size: size(width, height),
    }
}

/// What a floating panel's strip carries while it is dragged.
#[derive(Clone)]
struct MoveDrag {
    panel: PanelId,
    grab: Point<Pixels>,
}

#[derive(Clone)]
struct ResizeDrag {
    panel: PanelId,
}

impl Render for MoveDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

impl Render for ResizeDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

impl FloatingPanel {
    fn panel_id(&self) -> PanelId {
        self.id
    }

    fn render(&self, cx: &mut Context<Shell>) -> AnyElement {
        let palette = cx.palette().clone();
        let look = TabPresenter::look_of(&self.panel, cx);
        let surface = match look.surface {
            Surface::Chrome | Surface::Titlebar => palette.chrome_srgb,
            Surface::Sheet => palette.editor_srgb,
        };
        let id = self.id;
        let name = tab_name(&self.panel, cx);
        let icon: AnyElement = match look.icon {
            TabIcon::None => Empty.into_any_element(),
            TabIcon::Icon(icon) => icon
                .element(ICON, palette.text_secondary)
                .into_any_element(),
            TabIcon::Glyph(kind) => file_glyph(kind, ICON, &palette),
        };
        let menu_panel = PanelHandle::of(&self.panel).map(|handle| handle.panel());
        let weak = cx.entity().downgrade();
        let bounds = self.bounds;
        let strip = div()
            .id(("floating-strip", id.as_u64()))
            .flex()
            .flex_none()
            .items_center()
            .h(STRIP_HEIGHT)
            .px(px(6.))
            .gap(px(4.))
            .cursor_grab()
            .on_drag(
                MoveDrag {
                    panel: id,
                    grab: point(px(0.), px(0.)),
                },
                move |drag, offset, _, cx| {
                    cx.new(|_| MoveDrag {
                        panel: drag.panel,
                        grab: offset,
                    })
                },
            )
            .child(
                div().flex_1().min_w_0().overflow_hidden().child(
                    PanelTab::new(("floating-tab", id.as_u64()), name, surface)
                        .icon(icon)
                        .selected(true)
                        .strong(true)
                        .dirty(look.dirty)
                        .on_close({
                            let weak = weak.clone();
                            move |_, window, cx| {
                                weak.update(cx, |shell, cx| shell.close_panel(id, window, cx))
                                    .ok();
                            }
                        }),
                ),
            )
            .child(
                IconButton::new(("floating-menu", id.as_u64()), Icon::DOTS)
                    .frame(px(24.), px(28.))
                    .radius(TAB_RADIUS)
                    .surface(look.surface)
                    .dropdown_menu_with_anchor(gpui::Anchor::TopRight, {
                        let weak = weak.clone();
                        move |menu, window, cx| {
                            let mut menu = match &menu_panel {
                                Some(panel) => panel.dropdown_menu(menu, window, cx),
                                None => menu,
                            };
                            if !menu.is_empty() {
                                menu = menu.separator();
                            }
                            let dock = weak.clone();
                            let close = weak.clone();
                            menu.item(
                                PopupMenuItem::new("Dock")
                                    .icon(Icon::MINIMIZE.kit())
                                    .on_click(move |_, window, cx| {
                                        dock.update(cx, |shell, cx| {
                                            shell.toggle_float(id, window, cx)
                                        })
                                        .ok();
                                    }),
                            )
                            .separator()
                            .item(
                                PopupMenuItem::new("Close").icon(Icon::X.kit()).on_click(
                                    move |_, window, cx| {
                                        close
                                            .update(cx, |shell, cx| {
                                                shell.close_panel(id, window, cx)
                                            })
                                            .ok();
                                    },
                                ),
                            )
                        }
                    }),
            );
        let content: AnyView = self.panel.view();
        div()
            .id(("floating-panel", id.as_u64()))
            .absolute()
            .left(bounds.origin.x)
            .top(bounds.origin.y)
            .w(bounds.size.width)
            .h(bounds.size.height)
            .flex()
            .flex_col()
            .rounded(PANEL_RADIUS)
            .bg(surface.hsla())
            .shadow(Elevation::Floating.shadows(&palette))
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, {
                let weak = weak.clone();
                move |_, _, cx| {
                    weak.update(cx, |shell, cx| {
                        shell.floating.bring_to_front(id);
                        cx.notify();
                    })
                    .ok();
                }
            })
            .on_drag_move::<MoveDrag>({
                let weak = weak.clone();
                move |event, window, cx| {
                    let drag = event.drag(cx).clone();
                    if drag.panel != id {
                        return;
                    }
                    let position = event.event.position;
                    weak.update(cx, |shell, cx| {
                        shell.move_floating(id, position, drag.grab, window);
                        shell.schedule_save(window, cx);
                        cx.notify();
                    })
                    .ok();
                }
            })
            .on_drag_move::<ResizeDrag>({
                let weak = weak.clone();
                move |event, window, cx| {
                    if event.drag(cx).panel != id {
                        return;
                    }
                    let position = event.event.position;
                    weak.update(cx, |shell, cx| {
                        shell.resize_floating(id, position, window);
                        shell.schedule_save(window, cx);
                        cx.notify();
                    })
                    .ok();
                }
            })
            .child(strip)
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .rounded_b(PANEL_RADIUS)
                    .overflow_hidden()
                    .child(content.cached(StyleRefinement::default().absolute().size_full())),
            )
            .child(
                div()
                    .id(("floating-grip", id.as_u64()))
                    .absolute()
                    .right_0()
                    .bottom_0()
                    .size(px(GRIP))
                    .cursor_nwse_resize()
                    .on_drag(ResizeDrag { panel: id }, |drag, _, _, cx| {
                        cx.new(|_| drag.clone())
                    }),
            )
            .into_any_element()
    }
}

impl Shell {
    /// Float a docked panel, or dock a floating one where its kind belongs.
    pub(crate) fn toggle_float(
        &mut self,
        panel: PanelId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(floating) = self.floating.remove(panel) {
            cx.notify();
            self.show_view(floating.view, window, cx);
            return;
        }
        let Some(view) = self.view_of(panel, cx) else {
            return;
        };
        if self.dock_area.read(cx).panel(panel).is_none() {
            return;
        }
        let area = self.dock_area.read(cx).bounds();
        let width = px(FLOAT_SIZE.0)
            .min(area.size.width - px(2. * FLOAT_OFFSET))
            .max(px(MIN_SIZE.0));
        let height = px(FLOAT_SIZE.1)
            .min(area.size.height - px(FLOAT_OFFSET))
            .max(px(MIN_SIZE.1));
        let offset = px(FLOAT_OFFSET + 24. * self.floating.panels.len() as f32);
        let mut arrangement = self.current_arrangement(cx).without(&view);
        arrangement.floating.push(FloatingView {
            view,
            x: f32::from(area.size.width - width - offset),
            y: f32::from(offset),
            width: f32::from(width),
            height: f32::from(height),
        });
        self.install(&arrangement, window, cx);
    }

    /// The workspace area floating panels stay within, at the window's size.
    pub(super) fn floating_area(&self, window: &Window) -> Size<Pixels> {
        let room = self.room(window);
        size(px(room.area()), px(room.column()))
    }

    /// Follow the pointer, held where it grabbed the strip, kept on screen.
    fn move_floating(
        &mut self,
        panel: PanelId,
        pointer: Point<Pixels>,
        grab: Point<Pixels>,
        window: &Window,
    ) {
        let origin = self.workspace_origin();
        let area = self.floating_area(window);
        let Some(floating) = self.floating.panels.iter_mut().find(|f| f.id == panel) else {
            return;
        };
        let moved = Bounds {
            origin: point(pointer.x - origin.x - grab.x, pointer.y - origin.y - grab.y),
            size: floating.bounds.size,
        };
        floating.bounds = within(moved, area);
    }

    fn resize_floating(&mut self, panel: PanelId, pointer: Point<Pixels>, window: &Window) {
        let origin = self.workspace_origin();
        let area = self.floating_area(window);
        let Some(floating) = self.floating.panels.iter_mut().find(|f| f.id == panel) else {
            return;
        };
        let corner = floating.bounds.origin;
        let width = (pointer.x - origin.x - corner.x)
            .min(area.width - corner.x)
            .max(px(MIN_SIZE.0));
        let height = (pointer.y - origin.y - corner.y)
            .min(area.height - corner.y)
            .max(px(MIN_SIZE.1));
        floating.bounds = within(
            Bounds {
                origin: floating.bounds.origin,
                size: size(width, height),
            },
            area,
        );
    }

    /// The workspace area's top-left corner in the window: under the 40px
    /// titlebar.
    fn workspace_origin(&self) -> Point<Pixels> {
        point(px(0.), STRIP_HEIGHT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panel_saved_beyond_a_smaller_window_comes_back_inside_it() {
        let saved = Bounds {
            origin: point(px(1000.), px(72.)),
            size: size(px(420.), px(480.)),
        };
        let area = size(px(782.), px(428.));
        let shown = within(saved, area);
        assert_eq!(shown.size, size(px(420.), px(428.)));
        assert_eq!(shown.origin, point(px(362.), px(0.)));
        assert_eq!(within(shown, area), shown);
    }
}
