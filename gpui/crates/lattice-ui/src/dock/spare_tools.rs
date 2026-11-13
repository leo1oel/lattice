//! A panel's spare tools: what its strip shows before its own tools only in
//! room to spare (`strip::room_to_spare`), as the Trellis header shows a
//! .tex file's Source / Visual switch only with `data-tools="named"`.

use std::{collections::HashMap, rc::Rc};

use gpui::{AnyElement, App, Global, Pixels, Window};
use gpui_kit::component::dock::PanelId;

/// A panel's spare tools: what it shows before its tools only in room to
/// spare (`strip::room_to_spare`), and how wide that is.
#[derive(Clone)]
pub struct SpareTools {
    pub width: Rc<dyn Fn(&Window, &App) -> Pixels>,
    pub render: Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>,
}

#[derive(Default)]
pub(super) struct SpareToolsByPanel(pub(super) HashMap<PanelId, SpareTools>);

impl Global for SpareToolsByPanel {}

/// Whether `panel` offers spare tools to its strip.
pub fn offers_spare_tools(panel: PanelId, cx: &App) -> bool {
    cx.try_global::<SpareToolsByPanel>()
        .is_some_and(|registry| registry.0.contains_key(&panel))
}

/// The spare tools `panel` offers its strip.
pub fn spare_tools(panel: PanelId, cx: &App) -> Option<SpareTools> {
    cx.try_global::<SpareToolsByPanel>()
        .and_then(|registry| registry.0.get(&panel).cloned())
}

/// Give `panel` spare tools for its strip, or (`None`) take them away.
pub fn set_spare_tools(panel: PanelId, tools: Option<SpareTools>, cx: &mut App) {
    let registry = cx.default_global::<SpareToolsByPanel>();
    match tools {
        Some(tools) => {
            registry.0.insert(panel, tools);
        }
        None => {
            registry.0.remove(&panel);
        }
    }
}
