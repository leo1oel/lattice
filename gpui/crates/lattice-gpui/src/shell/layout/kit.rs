//! Arrangements to and from GPUI Kit's dock: reading the live layout off
//! the area, and describing an arrangement as Kit's layout with the window's
//! own panels.

use gpui::{App, Axis, px};
use gpui_kit::component::dock::{
    BasePanelView, DockArea, DockLayout, DockPlacement, PaneNode, PaneRef, PanelId,
};

use super::{Arrangement, Dock, Node, SplitAxis, View};

/// Read the dock's live layout as an arrangement, naming each panel through
/// `view_of`; panels it does not know (none, today) are left out.
pub fn read(area: &DockArea, view_of: &impl Fn(PanelId) -> Option<View>) -> Arrangement {
    let node_of = |placement| {
        area.layout(placement)
            .and_then(|tree| read_node(tree.root(), view_of))
    };
    let dock_of = |placement| {
        let node = node_of(placement)?;
        Some(Dock {
            node,
            size: f32::from(area.dock_size(placement)?),
            open: area.is_dock_open(placement),
        })
    };
    Arrangement {
        center: node_of(DockPlacement::Center).unwrap_or_default(),
        left: dock_of(DockPlacement::Left),
        right: dock_of(DockPlacement::Right),
        bottom: dock_of(DockPlacement::Bottom),
    }
}

fn read_node(node: &PaneNode, view_of: &impl Fn(PanelId) -> Option<View>) -> Option<Node> {
    match node.kind() {
        PaneRef::Tabs { panels, active_ix } => {
            let mut views = Vec::new();
            let mut active = 0;
            for (ix, panel) in panels.iter().enumerate() {
                if let Some(view) = view_of(*panel) {
                    if ix == active_ix {
                        active = views.len();
                    }
                    views.push(view);
                }
            }
            (!views.is_empty()).then_some(Node::Tabs { views, active })
        }
        PaneRef::Split {
            axis,
            children,
            sizes,
        } => {
            let mut nodes = Vec::new();
            let mut node_sizes = Vec::new();
            for (ix, child) in children.iter().enumerate() {
                if let Some(child) = read_node(child, view_of) {
                    nodes.push(child);
                    node_sizes.push(sizes.get(ix).copied().flatten().map(f32::from));
                }
            }
            match nodes.len() {
                0 => None,
                1 => nodes.pop(),
                _ => Some(Node::Split {
                    axis: match axis {
                        Axis::Horizontal => SplitAxis::Row,
                        Axis::Vertical => SplitAxis::Column,
                    },
                    children: nodes,
                    sizes: node_sizes,
                }),
            }
        }
    }
}

/// Kit's description of `node`, with each view's live panel from `panel_of`
/// (views without one are skipped, and groups and splits left empty).
pub fn describe(
    node: &Node,
    panel_of: &mut impl FnMut(&View) -> Option<std::sync::Arc<dyn BasePanelView>>,
    cx: &App,
) -> Option<DockLayout> {
    match node {
        Node::Tabs { views, active } => {
            let mut layout = DockLayout::tabs();
            let mut count = 0;
            let mut active_ix = 0;
            for (ix, view) in views.iter().enumerate() {
                if let Some(panel) = panel_of(view) {
                    if ix == *active {
                        active_ix = count;
                    }
                    layout = layout.panel_view(panel, cx);
                    count += 1;
                }
            }
            (count > 0).then(|| layout.active_index(active_ix))
        }
        Node::Split {
            axis,
            children,
            sizes,
        } => {
            let mut layout = match axis {
                SplitAxis::Row => DockLayout::h_split(),
                SplitAxis::Column => DockLayout::v_split(),
            };
            let mut count = 0;
            for (ix, child) in children.iter().enumerate() {
                if let Some(child) = describe(child, panel_of, cx) {
                    let size = sizes.get(ix).copied().flatten().map(px);
                    layout = layout.child(child, size);
                    count += 1;
                }
            }
            (count > 0).then_some(layout)
        }
    }
}
