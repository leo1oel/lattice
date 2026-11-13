// Part of the port of DanFessler/trellis 0.2.0 to GPUI, Copyright (c) Dan Fessler, Trellis Public License v1.0
// Non-Commercial: what Trellis's DOM left to CSS and to its `ViewTypeDefinition`s (title, icon, accessory,
// menu, content), as a trait the app implements.

//! The app's part of the workspace: each view's content, and the look of
//! every piece of chrome the workspace lays out (Trellis left those to CSS
//! and to the view types).

use std::rc::Rc;

use gpui::{AnyElement, AnyView, App, BoxShadow, Hsla, Pixels, Window};

use crate::runtime::engine::{MenuAction, MenuEntry};
use crate::runtime::engine::frame::{HeaderInput, PanelFrame, TabFrame};
use crate::runtime::header::HeaderMeasure;

/// A callback the workspace hands the skin (close a tab, open a menu).
pub type Callback = Rc<dyn Fn(&mut Window, &mut App)>;

/// A panel card's look.
#[derive(Clone, Debug)]
pub struct CardStyle {
    pub background: Hsla,
    pub radius: Pixels,
    pub shadow: Vec<BoxShadow>,
}

/// What the workspace lays out between its panels.
#[derive(Clone, Debug)]
pub struct ChromeStyle {
    /// The gap between panels and around the layout (`--trellis-gap`).
    pub gap: f32,
    /// The tab strip's height (`--trellis-tabbar-height`).
    pub tabbar_height: f32,
    /// A divider's grip (hover after a delay, while held).
    pub grip: Hsla,
    pub grip_width: Pixels,
    /// The drop slot: its wash, its inset ring, and its corner.
    pub slot_fill: Hsla,
    pub slot_ring: Hsla,
    pub slot_radius: Pixels,
    /// The panel following the pointer during a drag.
    pub lifted_shadow: Vec<BoxShadow>,
    /// A floating panel.
    pub floating_shadow: Vec<BoxShadow>,
    /// The snap preview and marquee target ring, and the marquee box.
    pub snap_ring: Hsla,
    pub marquee_fill: Hsla,
    pub marquee_border: Hsla,
    /// A collapsed group's tile and its outline.
    pub group_fill: Hsla,
    pub group_line: Hsla,
}

/// A tab's handlers, for the skin's tab element.
pub struct TabActions {
    /// The tab's close button was clicked (the workspace asks the host).
    pub close: Callback,
}

/// A panel's menu: the workspace's built-in items for it (the skin puts the
/// view's own items before them, then a separator) and how to run one.
#[derive(Clone)]
pub struct PanelMenu {
    pub panel_id: String,
    pub built_ins: Rc<dyn Fn(&App) -> Vec<MenuEntry>>,
    pub run: Rc<dyn Fn(&MenuAction, &mut Window, &mut App)>,
}

/// What the skin draws in a panel's tab strip, besides its tabs.
pub struct StripEnd {
    /// The selected view's accessories (header tools), drawn before the menu.
    pub accessories: Option<AnyElement>,
    /// The ⋯ menu button.
    pub menu: Option<AnyElement>,
}

pub trait Skin: 'static {
    /// The view's content.
    fn content(&self, view_id: &str, window: &mut Window, cx: &mut App) -> Option<AnyView>;

    /// The card a panel is drawn on (its surface follows its selected view).
    fn card(&self, panel: &PanelFrame, cx: &App) -> CardStyle;

    fn chrome(&self, cx: &App) -> ChromeStyle;

    /// One tab, as it sits in the strip at its natural width (the workspace
    /// positions it and handles presses, drags and double-clicks).
    fn tab(
        &self,
        panel: &PanelFrame,
        tab: &TabFrame,
        actions: TabActions,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement;

    /// The strip's end: the selected view's tools and the ⋯ button, which
    /// opens `menu` (the panel's full menu) through the skin's own menus.
    fn strip_end(
        &self,
        panel: &PanelFrame,
        menu: PanelMenu,
        window: &mut Window,
        cx: &mut App,
    ) -> StripEnd;

    /// Open the panel's menu at a point (a right-click on its strip),
    /// workspace-relative in window coordinates.
    fn open_menu_at(
        &self,
        menu: PanelMenu,
        position: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    );

    /// The header's measured parts (see `planHeader`); `None` before it can
    /// be measured.
    fn measure_header(
        &self,
        input: &HeaderInput,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<HeaderMeasure>;

    /// The icon a panel too small to use shows instead of its content.
    fn frame_icon(&self, panel: &PanelFrame, size: Pixels, cx: &mut App) -> AnyElement;

    /// The "Add as tab" pill over a tab drop's slot.
    fn drop_label(&self, label: &str, cx: &mut App) -> AnyElement;

    /// The snap preview's and marquee target's pill ("Release to focus").
    fn snap_label(&self, label: &str, cx: &mut App) -> AnyElement;

    /// Whether a view's content keeps pinches to itself (a PDF, a board),
    /// rather than letting them zoom the workspace.
    fn owns_gestures(&self, _view_id: &str, _cx: &App) -> bool {
        false
    }

    /// What the workspace shows when it holds nothing at all.
    fn empty(&self, window: &mut Window, cx: &mut App) -> Option<AnyElement>;
}
