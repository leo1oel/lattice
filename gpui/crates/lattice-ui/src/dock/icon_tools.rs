//! A panel's tools in the Trellis header's icon state (`data-tools="icon"`):
//! short of room for its tabs, a header keeps its tools' icons and drops
//! their text labels before it drops the tools altogether, as the Tauri app's
//! Build button keeps only its mark (`trellis.css`: `[data-tools="icon"]
//! .trellis-build-label { display: none }`).
//!
//! A panel whose tools draw narrower there says by how much (its saving),
//! which the header plan counts before it draws them so; the skin then tells
//! the panel, each frame, whether its header is in that state.

use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
};

use gpui::{App, Global, Pixels, Window, px};
use gpui_kit::component::dock::PanelId;

/// How much narrower a panel's tools draw in the icon state than in full.
pub type IconSaving = Rc<dyn Fn(&Window, &App) -> Pixels>;

#[derive(Default)]
struct IconTools {
    savings: HashMap<PanelId, IconSaving>,
    icon_only: HashSet<PanelId>,
}

impl Global for IconTools {}

/// Say how much narrower `panel`'s tools draw with their icons alone, or
/// (`None`) that they draw the same.
pub fn set_icon_saving(panel: PanelId, saving: Option<IconSaving>, cx: &mut App) {
    let registry = cx.default_global::<IconTools>();
    match saving {
        Some(saving) => {
            registry.savings.insert(panel, saving);
        }
        None => {
            registry.savings.remove(&panel);
            registry.icon_only.remove(&panel);
        }
    }
}

/// How much narrower `panel`'s tools draw with their icons alone.
pub fn icon_saving(panel: PanelId, window: &Window, cx: &App) -> Pixels {
    cx.try_global::<IconTools>()
        .and_then(|registry| registry.savings.get(&panel).cloned())
        .map_or(px(0.), |saving| saving(window, cx))
}

/// Whether `panel`'s header shows its tools as icons alone.
pub fn tools_icon_only(panel: PanelId, cx: &App) -> bool {
    cx.try_global::<IconTools>()
        .is_some_and(|registry| registry.icon_only.contains(&panel))
}

/// Tell `panel` whether its header shows its tools as icons alone; the skin
/// sets it as it lays the header out, before it draws the tools.
pub fn set_tools_icon_only(panel: PanelId, icon_only: bool, cx: &mut App) {
    if tools_icon_only(panel, cx) == icon_only {
        return;
    }
    let registry = cx.default_global::<IconTools>();
    if icon_only {
        registry.icon_only.insert(panel);
    } else {
        registry.icon_only.remove(&panel);
    }
}
