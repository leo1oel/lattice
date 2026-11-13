//! How wide each panel strip and its tools were last drawn, which the strip
//! lays out from (`strip::plan`).

use std::collections::HashMap;

use gpui::{App, EntityId, Global, IntoElement, Pixels, Styled as _, canvas, px};
use gpui_kit::component::dock::{NodeId, PanelId};

/// Each strip's measured width and its tools' natural width, by the area and
/// group they belong to. A strip is laid out from last frame's measurements:
/// a change is recorded after the frame and the window drawn again, so the
/// strip catches up one frame later (`measure`).
#[derive(Default)]
pub(super) struct StripRoom {
    groups: HashMap<(EntityId, NodeId), Measured>,
    /// The same by the panel each group displays: a group rebuilt around that
    /// panel has a new node, and starts from the width it had.
    panels: HashMap<(EntityId, PanelId), Measured>,
}

impl Global for StripRoom {}

impl StripRoom {
    pub(super) fn get(&self, key: StripKey) -> Option<Measured> {
        self.groups
            .get(&(key.area, key.node))
            .or_else(|| self.panels.get(&(key.area, key.panel?)))
            .copied()
    }
}

/// A strip: its area, its group and the panel it displays.
#[derive(Clone, Copy)]
pub(super) struct StripKey {
    pub(super) area: EntityId,
    pub(super) node: NodeId,
    pub(super) panel: Option<PanelId>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Measured {
    pub(super) strip: Option<Pixels>,
    pub(super) tools: Option<Pixels>,
}

#[derive(Clone, Copy)]
pub(super) enum Measure {
    Strip,
    Tools,
}

impl Measure {
    fn of(self, measured: &Measured) -> Option<Pixels> {
        match self {
            Measure::Strip => measured.strip,
            Measure::Tools => measured.tools,
        }
    }

    fn set(self, measured: &mut Measured, width: Pixels) {
        match self {
            Measure::Strip => measured.strip = Some(width),
            Measure::Tools => measured.tools = Some(width),
        }
    }
}

/// Drop the measurements of `area`'s groups and panels that `keep_node` and
/// `keep_panel` refuse.
pub(super) fn forget_strips(
    area: EntityId,
    keep_node: impl Fn(NodeId) -> bool,
    keep_panel: impl Fn(PanelId) -> bool,
    cx: &mut App,
) {
    if cx.has_global::<StripRoom>() {
        let room = cx.global_mut::<StripRoom>();
        room.groups
            .retain(|(owner, node), _| *owner != area || keep_node(*node));
        room.panels
            .retain(|(owner, panel), _| *owner != area || keep_panel(*panel));
    }
}

/// An invisible layer over its parent that records the parent's width.
pub(super) fn measure(key: StripKey, what: Measure) -> impl IntoElement {
    canvas(
        move |bounds, window, cx| {
            let width = bounds.size.width;
            let stale = |measured: Option<&Measured>| {
                measured
                    .and_then(|measured| what.of(measured))
                    .is_none_or(|known| (known - width).abs() > px(0.5))
            };
            let changed = cx.try_global::<StripRoom>().is_none_or(|room| {
                stale(room.groups.get(&(key.area, key.node)))
                    || key
                        .panel
                        .is_some_and(|panel| stale(room.panels.get(&(key.area, panel))))
            });
            if changed {
                // Recorded once this frame is done, then the window drawn
                // again; a deferred effect runs whatever paces the frames.
                let handle = window.window_handle();
                cx.defer(move |cx| {
                    let room = cx.default_global::<StripRoom>();
                    what.set(room.groups.entry((key.area, key.node)).or_default(), width);
                    if let Some(panel) = key.panel {
                        what.set(room.panels.entry((key.area, panel)).or_default(), width);
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
