//! Every island in the app, for what concerns them all at once: dock drags,
//! the layout changes that may take one off screen, and the hibernation
//! delay the scripted checks shorten.

use std::time::Duration;

use gpui::{App, WeakEntity, Window};

use crate::island::Island;

/// Every island in the app, for what concerns them all at once.
#[derive(Default)]
pub(crate) struct Registry {
    islands: Vec<WeakEntity<Island>>,
    hibernate_after: Option<Duration>,
}

impl gpui::Global for Registry {}

impl Registry {
    pub(crate) fn add(island: WeakEntity<Island>, cx: &mut App) {
        let registry = cx.default_global::<Registry>();
        registry.islands.retain(|island| island.upgrade().is_some());
        registry.islands.push(island);
    }

    pub(crate) fn hibernate_after(cx: &App) -> Option<Duration> {
        cx.try_global::<Registry>()
            .and_then(|registry| registry.hibernate_after)
    }
}

/// While a dock panel is dragged, every island steps aside: the page would
/// cover the drop targets, which are GPUI's, under it, and swallow the drag.
pub fn set_dock_dragging(dragging: bool, cx: &mut App) {
    let islands: Vec<_> = cx
        .try_global::<Registry>()
        .map(|registry| registry.islands.clone())
        .unwrap_or_default();
    for island in islands {
        island
            .update(cx, |island, cx| island.set_stepped_aside(dragging, cx))
            .ok();
    }
}

/// After the window's next frame, have each of its islands check that it is
/// still drawn: the shell calls this after every layout change (a panel
/// maximized, a group zoomed, a workspace switched).
pub fn check_drawn_after_frame(window: &mut Window, _: &mut App) {
    let handle = window.window_handle();
    window.on_next_frame(move |window, cx| {
        let islands: Vec<_> = cx
            .try_global::<Registry>()
            .map(|registry| registry.islands.clone())
            .unwrap_or_default();
        for island in islands {
            island
                .update(cx, |island, cx| {
                    if island.window == handle {
                        island.check_drawn(window, cx);
                    }
                })
                .ok();
        }
    });
}

/// Shorten the hidden period before islands hibernate, for the scripted
/// checks (`None` restores [`crate::HIBERNATE_AFTER`]).
pub fn set_hibernate_after(after: Option<Duration>, cx: &mut App) {
    cx.default_global::<Registry>().hibernate_after = after;
}
