//! Lattice's look for the Trellis workspace (`src/trellis/trellis.css` and
//! the panel menu of `trellis-panel-menu.tsx`): every panel a rounded card
//! whose surface follows its selected view (the chrome for the navigators,
//! the sheet for documents, the PDF and tools), a 40px strip of 28px pill
//! tabs with the panel's own tools and a ⋯ menu at its end, the divider's
//! grip in the accent at 55%, and the drop slot's wash inside a 2px focus
//! ring with "Add as tab" in a lifted pill.
//!
//! The content is the window's own panels (`views::Registry`), drawn as
//! GPUI Kit panels: a panel's tab name, icon, unsaved dot and header tools
//! come from it, as do the items its ⋯ menu leads with. Both the ⋯ button
//! and a right click on a tab open Lattice's menu (`components::Menu`,
//! design call 4). A panel's spare
//! tools (a .tex file's Source / Visual switch) show before its own only
//! while the header has room for them (`HeaderTools::Named`), and its own
//! tools keep only their icons (the build chip its mark) while the header
//! is in `HeaderTools::Icon`, by the saving the panel registers
//! (`lattice_ui::dock::set_icon_saving`).

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use gpui::{
    Anchor, AnyElement, AnyView, App, Empty, Entity, IntoElement, ParentElement as _, Pixels,
    Point, Styled as _, Window, canvas, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::dock::PanelHandle;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, Palette, TextRole, TextRoleStyle as _,
    components::{
        ContextMenu, IconButton, Menu, MenuAction as Item, MenuPopover, PanelTab, Surface,
        TAB_RADIUS, TabFit,
    },
    dock::{PANEL_RADIUS, TabIcon, TabLook, TabPresenter, strip},
    elevation::panel_ring,
    icons::{ICON, file_glyph},
    typography::shaped_width,
};
use trellis::runtime::engine::frame::{HeaderInput, PanelFrame, TabFrame};
use trellis::runtime::engine::{MenuAction, MenuEntry};
use trellis::runtime::header::{HeaderItem, HeaderMeasure};
use trellis::{CardStyle, ChromeStyle, PanelMenu, Skin, StripEnd, TabActions};

use super::views::Registry;

/// The strip's tab list is inset 6px on each side and the strip ends 6px
/// from the card's edge; the ⋯ button is 24px, 4px after the tools.
const LIST_INSETS: f64 = 12.;
const STRIP_END: f64 = 6.;
const MENU: f64 = 24. + 4.;
const TAB_GAP: f64 = 2.;
/// A document's tab at most (trellis.css's `max-width`).
const TAB_MAX: f32 = 200.;

pub struct LatticeSkin {
    views: Registry,
    /// Each panel's header tools as last laid out.
    tools: Rc<RefCell<HashMap<String, f32>>>,
    /// The menu a right click on a tab opens, as the overlay last kept it.
    menu: Rc<RefCell<Option<Entity<ContextMenu<PanelMenu>>>>>,
}

impl LatticeSkin {
    pub fn new(views: Registry) -> Self {
        Self {
            views,
            tools: Rc::default(),
            menu: Rc::default(),
        }
    }

    fn look(&self, view_id: &str, cx: &App) -> TabLook {
        self.views
            .borrow()
            .get(view_id)
            .map(|panel| TabPresenter::look_of(panel, cx))
            .unwrap_or_default()
    }

    /// The spare tools of `view_id`'s panel, if it offers any.
    fn spare(&self, view_id: &str, cx: &App) -> Option<lattice_ui::dock::SpareTools> {
        lattice_ui::dock::spare_tools(self.panel_id(view_id, cx)?, cx)
    }

    /// The panel `view_id` shows.
    fn panel_id(&self, view_id: &str, cx: &App) -> Option<gpui_kit::component::dock::PanelId> {
        Some(self.views.borrow().get(view_id)?.panel_id(cx))
    }

    fn surface(
        &self,
        view_id: &str,
        palette: &Palette,
        cx: &App,
    ) -> (Surface, lattice_ui::token_types::Srgb) {
        let surface = self.look(view_id, cx).surface;
        let color = match surface {
            Surface::Chrome | Surface::Titlebar => palette.chrome_srgb,
            Surface::Sheet => palette.editor_srgb,
        };
        (surface, color)
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

/// An engine menu item's icon, as the Tauri panel menu gives it.
fn item_icon(id: &str, label: &str) -> Option<Icon> {
    Some(match id {
        "maximize" if label.starts_with("Restore") => Icon::MINIMIZE,
        "maximize" => Icon::MAXIMIZE,
        "float" => Icon::PICTURE_IN_PICTURE,
        "dock" => Icon::MINIMIZE,
        "move" => Icon::ARROW_RIGHT_LEFT,
        "split-right" => Icon::COLUMNS_2,
        "split-below" => Icon::ROWS_2,
        "hide" => Icon::EYE_OFF,
        "close" => Icon::X,
        "close-others" => Icon::CIRCLE_X,
        _ => return None,
    })
}

/// The engine's entries as menu items, each running its action.
fn add_entries(
    mut menu: Menu,
    entries: Vec<MenuEntry>,
    run: &Rc<dyn Fn(&MenuAction, &mut Window, &mut App)>,
) -> Menu {
    for entry in entries {
        let item = match entry {
            MenuEntry::Separator => {
                menu = menu.separator();
                continue;
            }
            MenuEntry::Item(item) => item,
        };
        let icon = item_icon(&item.id, &item.label);
        if !item.items.is_empty() {
            let run = run.clone();
            let items = item.items.clone();
            menu = menu.submenu(item.label.clone(), icon, move |submenu, _, _| {
                add_entries(submenu, items.clone(), &run)
            });
            continue;
        }
        let entry = match item.action.clone() {
            Some(action) => {
                let run = run.clone();
                Item::new(item.label.clone(), move |window, cx| {
                    run(&action, window, cx)
                })
            }
            None => Item::new(item.label.clone(), |_, _| {}).disabled(true),
        };
        menu = menu.item(match icon {
            Some(icon) => entry.icon(icon),
            None => entry,
        });
    }
    menu
}

/// The items a panel's ⋯ menu leads with, for the view it shows: the
/// editor's Build and Vim mode, the PDF's zoom, the Project tree's New file.
fn own_items(menu: Menu, view: &AnyView, cx: &App) -> Menu {
    if let Ok(tree) = view.clone().downcast::<crate::file_tree::FileTreePanel>() {
        return crate::file_tree::FileTreePanel::background_menu(&tree.downgrade(), menu, cx);
    }
    if let Ok(editor) = view.clone().downcast::<crate::editor_panel::EditorPanel>() {
        return editor.read(cx).panel_menu(menu, cx);
    }
    if let Ok(pdf) = view.clone().downcast::<crate::pdf::PdfPanel>() {
        return crate::pdf::PdfPanel::panel_menu(&pdf, menu, cx);
    }
    menu
}

impl LatticeSkin {
    /// A panel's whole menu: its selected view's own items, then the
    /// workspace's (Maximize, Float or Dock, Move to, Hide, Close).
    fn build_menu(views: &Registry, request: &PanelMenu, menu: Menu, cx: &App) -> Menu {
        let selected = (request.selected)(cx).unwrap_or_default();
        let panel = views.borrow().get(&selected).cloned();
        let menu = match panel {
            Some(panel) => own_items(menu, &panel.view(), cx),
            None => menu,
        }
        .separator();
        let built_ins = (request.built_ins)(cx);
        add_entries(menu, built_ins, &request.run)
    }
}

impl Skin for LatticeSkin {
    fn content(&self, view_id: &str, _: &mut Window, _: &mut App) -> Option<AnyView> {
        self.views.borrow().get(view_id).map(|panel| panel.view())
    }

    fn card(&self, panel: &PanelFrame, cx: &App) -> CardStyle {
        let palette = cx.palette();
        let (_, surface) = self.surface(&panel.selected, palette, cx);
        CardStyle {
            background: surface.hsla(),
            radius: PANEL_RADIUS,
            shadow: panel_ring(palette),
        }
    }

    fn chrome(&self, cx: &App) -> ChromeStyle {
        let palette = cx.palette();
        ChromeStyle {
            gap: 6.,
            tabbar_height: 40.,
            grip: palette.accent.opacity(0.55),
            grip_width: px(2.),
            slot_fill: palette.drop_target,
            slot_ring: palette.focus,
            slot_radius: PANEL_RADIUS,
            lifted_shadow: Elevation::Popover.shadows(palette),
            floating_shadow: Elevation::Popover.shadows(palette),
            snap_ring: gpui::white().opacity(0.6),
            marquee_fill: palette.accent.opacity(0.12),
            marquee_border: palette.accent,
            group_fill: palette.panel,
            group_line: palette.line_strong,
        }
    }

    fn tab(
        &self,
        panel: &PanelFrame,
        tab: &TabFrame,
        actions: TabActions,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let (_, surface) = self.surface(&panel.selected, &palette, cx);
        let look = self.look(&tab.view_id, cx);
        let label = shaped_width(&tab.title, TextRole::BodyCompact, None, window, cx);
        let natural = TabFit::natural_width(label, tab.closable);
        let fit = if tab.icon_only {
            TabFit::IconOnly
        } else if tab.atomic {
            TabFit::Full
        } else {
            // The strip holds the tab's slot to the same minimum.
            let min = tab.min_width.map_or_else(
                || {
                    let min = panel
                        .header
                        .tab_min
                        .map_or(strip::DOCUMENT_TAB_MIN, |min| px(min as f32));
                    natural.min(min)
                },
                |min| px(min as f32),
            );
            TabFit::Shrinks { min }
        };
        let close = actions.close;
        PanelTab::new(
            ("lattice-tab", crate::shell::skin::hash(&tab.view_id)),
            tab.title.clone(),
            surface,
        )
        .icon(tab_icon(look.icon, &palette))
        .selected(tab.selected)
        .strong(panel.focused)
        .dirty(look.dirty)
        .fit(fit)
        .when(!tab.atomic, |tab| tab.max_w(px(TAB_MAX)))
        .when(lattice_ui::parity::enabled(), |el| {
            el.parity(format!("tab/{}", tab.title))
        })
        .when(tab.closable, |tab| {
            tab.on_close(move |_, window, cx| close(window, cx))
        })
        .into_any_element()
    }

    fn strip_end(
        &self,
        panel: &PanelFrame,
        menu: PanelMenu,
        window: &mut Window,
        cx: &mut App,
    ) -> StripEnd {
        let palette = cx.palette().clone();
        let (surface_kind, _) = self.surface(&panel.selected, &palette, cx);
        let handle = self.views.borrow().get(&panel.selected).cloned();
        let shown = panel.header.tools != trellis::runtime::header::HeaderTools::Hidden;
        let spare = (panel.header.tools == trellis::runtime::header::HeaderTools::Named)
            .then(|| self.spare(&panel.selected, cx))
            .flatten()
            .map(|spare| (spare.render)(window, cx));
        // The selected view learns whether its tools are icons alone before
        // it draws them; measured so, they count at their full width (the
        // plan takes the saving off for the icon state itself).
        let icon_only = panel.header.tools == trellis::runtime::header::HeaderTools::Icon;
        let saving = self
            .panel_id(&panel.selected, cx)
            .map(|id| {
                lattice_ui::dock::set_tools_icon_only(id, icon_only, cx);
                if icon_only {
                    f32::from(lattice_ui::dock::icon_saving(id, window, cx))
                } else {
                    0.
                }
            })
            .unwrap_or(0.);
        let accessories = shown
            .then(|| {
                handle
                    .as_ref()
                    .and_then(PanelHandle::of)
                    .and_then(|handle| handle.title_suffix(window, cx))
            })
            .flatten()
            .map(|tools| {
                let measured = self.tools.clone();
                let id = panel.id.clone();
                // Only the panel's own tools are measured: the spare ones
                // are counted apart, for the named state alone.
                let tools = div()
                    .relative()
                    .flex()
                    .flex_none()
                    .items_center()
                    .child(tools)
                    .child(
                        canvas(
                            move |bounds, window, _| {
                                let width = f32::from(bounds.size.width) + saving;
                                let old = measured.borrow_mut().insert(id.clone(), width);
                                if old.is_none_or(|old| (old - width).abs() > 0.5) {
                                    window.refresh();
                                }
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    );
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(strip::SPARE_GAP)
                    .children(spare)
                    .child(tools)
                    .into_any_element()
            });
        if accessories.is_none() && !shown {
            // Tools hidden for room: keep the width they had for the plan.
        } else if accessories.is_none() {
            self.tools.borrow_mut().insert(panel.id.clone(), 0.);
        }
        let views = self.views.clone();
        let id = crate::shell::skin::hash(&panel.id);
        let button = MenuPopover::new(
            ("lattice-panel-menu-popover", id),
            IconButton::new(("lattice-panel-menu", id), Icon::DOTS)
                .frame(strip::MENU_WIDTH, px(28.))
                .radius(TAB_RADIUS)
                .surface(surface_kind),
            move |popup, _, cx| Self::build_menu(&views, &menu, popup, cx),
        )
        .anchor(Anchor::TopRight);
        StripEnd {
            accessories,
            menu: Some(button.into_any_element()),
        }
    }

    fn open_menu_at(
        &self,
        request: PanelMenu,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(menu) = self.menu.borrow().clone() else {
            return;
        };
        // The selected view once the right click has selected its tab: the
        // menu reads it when it builds.
        window.defer(cx, move |window, cx| {
            menu.update(cx, |menu, cx| menu.open(position, request, window, cx));
        });
    }

    fn measure_header(
        &self,
        input: &HeaderInput,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<HeaderMeasure> {
        let tools = self
            .tools
            .borrow()
            .get(&input.panel.id)
            .copied()
            .unwrap_or(0.);
        let bare = LIST_INSETS + STRIP_END + MENU;
        let full = bare + f64::from(tools);
        // The row with its tools' icons alone (`data-tools="icon"`): the
        // build chip without its label.
        let icon = full
            - self
                .panel_id(&input.panel.selected, cx)
                .filter(|_| tools > 0.)
                .map_or(0., |id| {
                    f64::from(f32::from(lattice_ui::dock::icon_saving(id, window, cx)))
                });
        // The spare tools go before the panel's own, so only with them.
        let named = full
            + self
                .spare(&input.panel.selected, cx)
                .filter(|_| tools > 0.)
                .map_or(0., |spare| {
                    f64::from(f32::from((spare.width)(window, cx) + strip::SPARE_GAP))
                });
        let items = input
            .tabs
            .iter()
            .map(|(view, title, atomic, closable)| {
                let label = shaped_width(title, TextRole::BodyCompact, None, window, cx);
                let natural = f64::from(f32::from(TabFit::natural_width(label, *closable)));
                if *atomic {
                    HeaderItem::Atomic {
                        view_id: view.clone(),
                        full: natural,
                        compact: f64::from(f32::from(TabFit::icon_only_width())),
                    }
                } else {
                    let natural = natural.min(f64::from(TAB_MAX));
                    HeaderItem::Loose {
                        view_id: view.clone(),
                        min: natural.min(f64::from(f32::from(strip::DOCUMENT_TAB_MIN))),
                        floor: natural.min(f64::from(f32::from(strip::DOCUMENT_TAB_FLOOR))),
                        natural,
                    }
                }
            })
            .collect();
        Some(HeaderMeasure {
            chrome: [named, full, icon, bare],
            gap: TAB_GAP,
            items,
        })
    }

    fn frame_icon(&self, panel: &PanelFrame, size: Pixels, cx: &mut App) -> AnyElement {
        let palette = cx.palette().clone();
        let look = self.look(&panel.selected, cx);
        match look.icon {
            TabIcon::Icon(icon) => icon
                .element(size * 0.6, palette.text_secondary)
                .into_any_element(),
            TabIcon::Glyph(kind) => file_glyph(kind, size * 0.6, &palette),
            TabIcon::None => Empty.into_any_element(),
        }
    }

    fn drop_label(&self, label: &str, cx: &mut App) -> AnyElement {
        pill(label, cx).absolute().top(px(12.)).into_any_element()
    }

    fn snap_label(&self, label: &str, cx: &mut App) -> AnyElement {
        pill(label, cx).into_any_element()
    }

    fn owns_gestures(&self, view_id: &str, _: &App) -> bool {
        // The PDF viewers zoom on a pinch themselves.
        view_id == "pdf"
            || view_id.starts_with(trellis_root_pdf())
            || self
                .views
                .borrow()
                .get(view_id)
                .is_some_and(|panel| panel.view().downcast::<crate::pdf::PdfPanel>().is_ok())
    }

    fn empty(&self, _: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        Some(
            div()
                .absolute()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_role(TextRole::Body, cx)
                .text_color(palette.text_secondary)
                .child(lattice_i18n::t!("Open a LaTeX project folder to start"))
                .into_any_element(),
        )
    }

    /// Deferred, so a docked webview island does not cover a panel floating
    /// over it (gpui-fast puts native views under the overlay surface). An
    /// island floating in one is hosted on the overlay surface in turn,
    /// above the card it floats in.
    fn raised_priority(&self) -> Option<usize> {
        Some(super::layers::FLOATING_PRIORITY)
    }

    fn card_children(&self, panel: &PanelFrame, _: &mut App) -> Vec<AnyElement> {
        parity_probe("card", panel)
    }

    fn strip_children(&self, panel: &PanelFrame, _: &mut App) -> Vec<AnyElement> {
        parity_probe("strip", panel)
    }

    fn overlay(&self, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let menu = ContextMenu::<PanelMenu>::keyed("lattice-panel-context-menu", window, cx);
        *self.menu.borrow_mut() = Some(menu.clone());
        let views = self.views.clone();
        ContextMenu::layer(&menu, window, cx, move |menu, request, _, cx| {
            Self::build_menu(&views, request, menu, cx)
        })
    }
}

fn trellis_root_pdf() -> &'static str {
    super::trellis_layout::ROOT_PDF
}

/// The parity harness's mark for a panel's card or strip, named by its
/// selected tab, as the dock's skin named them.
fn parity_probe(part: &str, panel: &PanelFrame) -> Vec<AnyElement> {
    if !lattice_ui::parity::enabled() {
        return Vec::new();
    }
    let name = panel
        .tabs
        .iter()
        .find(|tab| tab.selected)
        .map(|tab| tab.title.clone())
        .unwrap_or_default();
    lattice_ui::parity::probe(format!("{part}/{name}"))
        .map(IntoElement::into_any_element)
        .into_iter()
        .collect()
}

/// The lifted pill "Add as tab" and "Release to focus" sit in.
fn pill(label: &str, cx: &mut App) -> gpui::Div {
    let palette = cx.palette().clone();
    div().left_0().right_0().flex().justify_center().child(
        div()
            .px(px(12.))
            .py(px(6.))
            .rounded_full()
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .whitespace_nowrap()
            .text_role(TextRole::BodyCompact, cx)
            .text_color(palette.text)
            .child(label.to_string()),
    )
}

/// A stable element id from a string.
pub(crate) fn hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}
