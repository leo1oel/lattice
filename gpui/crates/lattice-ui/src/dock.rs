//! What the Trellis skin (`lattice-gpui`'s `shell/skin.rs`) shares with the
//! rest of the app about panels: the card and strip measurements, how a
//! panel's tab looks (`TabPresenter`), its name, the strip's give-way
//! constants (`strip`) and a panel's spare tools.

mod spare_tools;
pub mod strip;

pub use spare_tools::{SpareTools, offers_spare_tools, set_spare_tools, spare_tools};

use std::{rc::Rc, sync::Arc};

use gpui::{App, Global, SharedString, px};
use gpui_kit::component::dock::{BasePanelView, PanelHandle};

use crate::{GlyphKind, Icon, components::Surface};

/// A panel card's corner: `--radius-panel` (10px) as `shape::CHROME` draws
/// it, round (a test in `shape.rs` holds it to the derivation).
pub const PANEL_RADIUS: gpui::Pixels = crate::shape::RADIUS_SURFACE;
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
    /// A navigator (Project, Papers) whose card frosts over the window's
    /// vibrancy when the window is translucent (trellis.css `data-glass`).
    pub frosted: bool,
}

impl Default for TabLook {
    fn default() -> Self {
        Self {
            icon: TabIcon::None,
            dirty: false,
            surface: Surface::Sheet,
            document: false,
            frosted: false,
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

    /// How `panel` presents itself.
    pub fn look_of(panel: &Arc<dyn BasePanelView>, cx: &App) -> TabLook {
        cx.try_global::<TabPresenter>()
            .map(|presenter| (presenter.0)(panel, cx))
            .unwrap_or_default()
    }
}

/// A panel's name on its tab.
pub fn tab_name(panel: &Arc<dyn BasePanelView>, cx: &App) -> SharedString {
    PanelHandle::of(panel)
        .and_then(|handle| handle.tab_name(cx))
        .unwrap_or_else(|| panel.panel_name(cx).into())
}
