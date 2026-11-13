// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/model/spatial.ts).

//! Docking and navigation geometry: focus layout, snap targets, hierarchy
//! steps, framing, drop targets and insertion.
//!
//! A stage is a transparent container. It occupies exactly its child's
//! rect, so it never adds a navigation level, and an empty stage acts as a
//! leaf (the desktop).

use std::collections::HashSet;

use super::tree::{Entries, Entry, LayoutMetrics, insert_beside, layout_rects, normalize, sum};
use super::types::{Axis, Edge, LayoutNode, Point, Rect, SplitNode, StageNode};

/// Panels and empty stages: the "leaves" a view can sit beside.
pub fn leaf_ids(node: Option<&LayoutNode>) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(node: &LayoutNode, out: &mut Vec<String>) {
        match node {
            LayoutNode::Panel(p) => out.push(p.id.clone()),
            LayoutNode::Stage(s) => match &s.child {
                Some(child) => walk(child, out),
                None => out.push(s.id.clone()),
            },
            LayoutNode::Split(s) => s.children.iter().for_each(|c| walk(c, out)),
        }
    }
    if let Some(node) = node {
        walk(node, &mut out);
    }
    out
}

/// Camera targets: every node, plus contiguous sibling ranges of splits with
/// 3+ children.
pub fn focus_layout(root: Option<&LayoutNode>, metrics: Option<&LayoutMetrics>) -> Entries {
    let mut entries = layout_rects(root, metrics);
    let splits: Vec<Entry> = entries
        .values()
        .filter(|e| matches!(&e.node, LayoutNode::Split(s) if s.children.len() >= 3))
        .cloned()
        .collect();
    for entry in splits {
        let LayoutNode::Split(node) = &entry.node else {
            continue;
        };
        let n = node.children.len();
        for start in 0..n - 1 {
            for end in start + 2..=n {
                if start == 0 && end == n {
                    continue;
                }
                let children = &node.children[start..end];
                let first = entries[children[0].id()].rect;
                let last = entries[children[children.len() - 1].id()].rect;
                let id = range_id(
                    &node.id,
                    &children.iter().map(|c| c.id().to_string()).collect::<Vec<_>>(),
                );
                let weights = &node.weights[start..end];
                let total = sum(weights);
                entries.insert(
                    id.clone(),
                    Entry {
                        node: LayoutNode::Split(SplitNode {
                            id,
                            axis: node.axis,
                            children: children.to_vec(),
                            weights: weights.iter().map(|w| w / total).collect(),
                        }),
                        rect: Rect {
                            x: first.x,
                            y: first.y,
                            w: last.x + last.w - first.x,
                            h: last.y + last.h - first.y,
                        },
                        parent: Some(node.id.clone()),
                        scale: None,
                        virtual_range: true,
                    },
                );
            }
        }
    }
    entries
}

pub fn range_id(split_id: &str, children: &[String]) -> String {
    let mut parts = vec![split_id.to_string()];
    parts.extend(children.iter().cloned());
    format!(
        "range:{}",
        serde_json::to_string(&parts).expect("strings serialize")
    )
}

/// A node's parent for navigation, skipping containers that add no visible
/// level (a stage).
pub fn nav_parent(entries: &Entries, id: &str) -> Option<String> {
    let entry = entries.get(id)?;
    let mut at = entry.parent.clone();
    while let Some(id) = at {
        let parent = entries.get(&id)?;
        if !same_rect(parent.rect, entry.rect) {
            return Some(id);
        }
        at = parent.parent.clone();
    }
    None
}

/// Collapse a stage to its child so it is never its own navigation level.
pub fn nav_node(entries: &Entries, id: &str) -> String {
    let mut node = entries.get(id).map(|e| &e.node);
    while let Some(LayoutNode::Stage(StageNode {
        child: Some(child), ..
    })) = node
    {
        node = Some(child);
    }
    node.map_or_else(|| id.to_string(), |n| n.id().to_string())
}

fn same_rect(a: Rect, b: Rect) -> bool {
    (a.x - b.x).abs() < 1e-9
        && (a.y - b.y).abs() < 1e-9
        && (a.w - b.w).abs() < 1e-9
        && (a.h - b.h).abs() < 1e-9
}

pub fn contains_node(node: &LayoutNode, id: &str) -> bool {
    if node.id() == id {
        return true;
    }
    match node {
        LayoutNode::Stage(s) => s.child.as_ref().is_some_and(|c| contains_node(c, id)),
        LayoutNode::Split(s) => s.children.iter().any(|c| contains_node(c, id)),
        LayoutNode::Panel(_) => false,
    }
}

/// Snap score: log-size difference plus 2.5 × normalized centre distance.
pub fn best_fit(camera: Rect, entries: &Entries) -> String {
    let mut best = String::new();
    let mut score = f64::INFINITY;
    for (id, entry) in entries {
        if matches!(&entry.node, LayoutNode::Stage(s) if s.child.is_some()) {
            continue;
        }
        let r = entry.rect;
        let size = (r.w / camera.w).ln().abs() + (r.h / camera.h).ln().abs();
        let distance = ((r.x + r.w / 2. - camera.x - camera.w / 2.) / camera.w)
            .hypot((r.y + r.h / 2. - camera.y - camera.h / 2.) / camera.h);
        let next = size + distance * 2.5;
        if next < score {
            best = id.clone();
            score = next;
        }
    }
    best
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepDirection {
    In,
    Out,
}

/// One hierarchy step: outward to the parent, inward to the immediate child
/// under the pointer.
pub fn hierarchy_step(
    entries: &Entries,
    focused: &str,
    direction: StepDirection,
    point: Point,
) -> String {
    let id = nav_node(entries, focused);
    let Some(entry) = entries.get(&id) else {
        return focused.to_string();
    };
    if direction == StepDirection::Out {
        return nav_parent(entries, &id).unwrap_or(id);
    }
    let LayoutNode::Split(split) = &entry.node else {
        return id;
    };
    let coordinate = if split.axis == Axis::X { point.x } else { point.y };
    for child in &split.children[..split.children.len() - 1] {
        let r = entries[child.id()].rect;
        let end = if split.axis == Axis::X {
            r.x + r.w
        } else {
            r.y + r.h
        };
        if coordinate < end {
            return nav_node(entries, child.id());
        }
    }
    nav_node(entries, split.children[split.children.len() - 1].id())
}

/// The smallest camera target (node or sibling range) containing all of `ids`.
pub fn frame_leaves(root: Option<&LayoutNode>, ids: &[String]) -> Option<String> {
    let root = root?;
    let entries = focus_layout(Some(root), None);
    let wanted: Vec<&String> = ids.iter().filter(|id| entries.contains_key(*id)).collect();
    let mut best = &entries[root.id()];
    for entry in entries.values() {
        if matches!(&entry.node, LayoutNode::Stage(s) if s.child.is_some()) {
            continue;
        }
        if entry.rect.w * entry.rect.h < best.rect.w * best.rect.h
            && wanted.iter().all(|id| contains_node(&entry.node, id))
        {
            best = entry;
        }
    }
    Some(best.node.id().to_string())
}

/// Convert a screen-space marquee into world coordinates through the camera,
/// clipped to the layout.
pub fn rectangle_camera(a: Point, b: Point, viewport: Rect, camera: Rect) -> Rect {
    let clamp = |v: f64| v.clamp(0., 1.);
    let ax = clamp((a.x - viewport.x) / viewport.w);
    let ay = clamp((a.y - viewport.y) / viewport.h);
    let bx = clamp((b.x - viewport.x) / viewport.w);
    let by = clamp((b.y - viewport.y) / viewport.h);
    Rect {
        x: camera.x + ax.min(bx) * camera.w,
        y: camera.y + ay.min(by) * camera.h,
        w: (bx - ax).abs() * camera.w,
        h: (by - ay).abs() * camera.h,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Visit {
    pub id: String,
    pub leaves: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MaximizeSession {
    pub id: String,
    pub return_path: Vec<String>,
}

/// A new visit after going back replaces forward history; repeats are not
/// duplicated.
pub fn record_visit(visits: &[Visit], index: usize, visit: Visit) -> (Vec<Visit>, usize) {
    if let Some(previous) = visits.get(index)
        && previous.id == visit.id
        && previous.leaves == visit.leaves
    {
        return (visits.to_vec(), index);
    }
    let mut next: Vec<Visit> = visits[..(index + 1).min(visits.len())].to_vec();
    next.push(visit);
    let index = next.len() - 1;
    (next, index)
}

/// Saved framings follow surviving views; with none left, the framing is
/// unavailable.
pub fn saved_frame_destination(root: Option<&LayoutNode>, leaves: &[String]) -> Option<String> {
    let entries = layout_rects(root, None);
    let surviving: Vec<String> = leaves
        .iter()
        .filter(|id| entries.contains_key(*id))
        .cloned()
        .collect();
    if surviving.is_empty() {
        None
    } else {
        frame_leaves(root, &surviving)
    }
}

/// Maximize remembers the exact prior level, then its surviving ancestors.
pub fn maximize_transition(
    entries: &Entries,
    root_id: &str,
    focused: &str,
    id: &str,
    session: Option<&MaximizeSession>,
) -> (String, Option<MaximizeSession>) {
    if focused == id {
        let destination = match session {
            Some(session) if session.id == id => session
                .return_path
                .iter()
                .find(|key| *key != id && entries.contains_key(*key))
                .cloned()
                .unwrap_or_else(|| root_id.to_string()),
            _ => nav_parent(entries, id).unwrap_or_else(|| root_id.to_string()),
        };
        return (destination, None);
    }
    let mut return_path = Vec::new();
    let mut at = Some(focused.to_string());
    while let Some(id) = at {
        at = entries.get(&id).and_then(|e| e.parent.clone());
        return_path.push(id);
    }
    (
        id.to_string(),
        Some(MaximizeSession {
            id: id.to_string(),
            return_path,
        }),
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitSeam {
    pub axis: Axis,
    pub leaves: Vec<String>,
    pub before: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DockTargetSpec {
    pub id: String,
    pub edge: Edge,
    pub seam: Option<SplitSeam>,
    pub boundary: Option<usize>,
}

/// Nearest edge within a 28% band of the rect, else none.
pub fn drop_edge(point: Point, rect: Rect) -> Option<Edge> {
    if rect.w <= 0. || rect.h <= 0. {
        return None;
    }
    let x = (point.x - rect.x) / rect.w;
    let y = (point.y - rect.y) / rect.h;
    if !(0. ..=1.).contains(&x) || !(0. ..=1.).contains(&y) {
        return None;
    }
    nearest_edge(x, y).filter(|(_, d)| *d <= 0.28).map(|(e, _)| e)
}

/// The edge nearest a point in the unit square, and its distance; ties go
/// left, right, top, bottom, as a stable sort of that list does.
pub fn nearest_edge(x: f64, y: f64) -> Option<(Edge, f64)> {
    let mut edges = [
        (Edge::Left, x),
        (Edge::Right, 1. - x),
        (Edge::Top, y),
        (Edge::Bottom, 1. - y),
    ];
    edges.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    edges.first().copied()
}

pub struct DropRects {
    pub slot: Rect,
    pub remaining: Rect,
    pub collapsed: Rect,
}

/// The incoming slot, the remaining space, and the collapsed slot a preview
/// animates from.
pub fn drop_rects(rect: Rect, edge: Edge) -> DropRects {
    let mut slot = rect;
    let mut remaining = rect;
    let mut collapsed = rect;
    match edge {
        Edge::Left | Edge::Right => {
            slot.w = rect.w / 2.;
            remaining.w = rect.w / 2.;
            collapsed.w = 0.;
            if edge == Edge::Left {
                remaining.x += slot.w;
            } else {
                slot.x += slot.w;
                collapsed.x += rect.w;
            }
        }
        Edge::Top | Edge::Bottom => {
            slot.h = rect.h / 2.;
            remaining.h = rect.h / 2.;
            collapsed.h = 0.;
            if edge == Edge::Top {
                remaining.y += slot.h;
            } else {
                slot.y += slot.h;
                collapsed.y += rect.h;
            }
        }
    }
    DropRects {
        slot,
        remaining,
        collapsed,
    }
}

/// One canonical target for both sides of an aligned boundary and its seam.
pub fn seam_target(group: &SplitNode, boundary: usize) -> DockTargetSpec {
    let group_node = LayoutNode::Split(group.clone());
    DockTargetSpec {
        id: group.id.clone(),
        edge: if group.axis == Axis::X {
            Edge::Left
        } else {
            Edge::Top
        },
        boundary: Some(boundary),
        seam: Some(SplitSeam {
            axis: group.axis,
            leaves: leaf_ids(Some(&group_node)),
            before: group.children[..boundary]
                .iter()
                .flat_map(|c| leaf_ids(Some(c)))
                .collect(),
        }),
    }
}

/// An edge of a view whose parent runs along the same axis inserts at that
/// seam instead.
pub fn tile_drop_target(entries: &Entries, id: &str, edge: Edge) -> DockTargetSpec {
    let parent = entries
        .get(id)
        .and_then(|e| e.parent.as_ref())
        .and_then(|p| entries.get(p))
        .map(|e| &e.node);
    if let Some(LayoutNode::Split(parent)) = parent
        && parent.axis == edge.axis()
    {
        let index = parent
            .children
            .iter()
            .position(|c| c.id() == id)
            .unwrap_or(0);
        let after = matches!(edge, Edge::Right | Edge::Bottom);
        return seam_target(parent, index + after as usize);
    }
    DockTargetSpec {
        id: id.to_string(),
        edge,
        seam: None,
        boundary: None,
    }
}

/// The frame perimeter (in screen px of the viewport) inserts before or after
/// the whole group.
pub fn frame_drop_target(
    group: &LayoutNode,
    point: Point,
    width: f64,
    height: f64,
    radius: f64,
) -> Option<DockTargetSpec> {
    if point.x < 0. || point.y < 0. || point.x > width || point.y > height {
        return None;
    }
    let mut distances = [
        (Edge::Left, point.x),
        (Edge::Right, width - point.x),
        (Edge::Top, point.y),
        (Edge::Bottom, height - point.y),
    ];
    distances.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let (edge, distance) = distances[0];
    if distance > radius {
        return None;
    }
    let axis = edge.axis();
    let after = matches!(edge, Edge::Right | Edge::Bottom);
    let inner = match group {
        LayoutNode::Stage(StageNode {
            child: Some(child), ..
        }) => child.as_ref(),
        _ => group,
    };
    if let LayoutNode::Split(inner) = inner
        && inner.axis == axis
    {
        return Some(seam_target(
            inner,
            if after { inner.children.len() } else { 0 },
        ));
    }
    let leaves = leaf_ids(Some(group));
    Some(DockTargetSpec {
        id: group.id().to_string(),
        edge,
        seam: Some(SplitSeam {
            axis,
            before: if after { leaves.clone() } else { Vec::new() },
            leaves,
        }),
        boundary: None,
    })
}

/// Insert at a seam, resolving the group by its surviving leaves (removing
/// the source may have promoted it). The newcomer takes an equal 1/(n+1)
/// share of an aligned group.
pub fn insert_at_seam(
    root: &LayoutNode,
    seam: &SplitSeam,
    incoming: &LayoutNode,
    split_id: &str,
) -> LayoutNode {
    let surviving: HashSet<String> = leaf_ids(Some(root))
        .into_iter()
        .filter(|id| seam.leaves.contains(id))
        .collect();
    if surviving.is_empty() {
        return root.clone();
    }
    let holds_all = |node: &LayoutNode| {
        let ids: HashSet<String> = leaf_ids(Some(node)).into_iter().collect();
        surviving.iter().all(|id| ids.contains(id))
    };
    fn insert(
        node: &LayoutNode,
        seam: &SplitSeam,
        incoming: &LayoutNode,
        split_id: &str,
        surviving: &HashSet<String>,
        holds_all: &dyn Fn(&LayoutNode) -> bool,
    ) -> LayoutNode {
        if let LayoutNode::Stage(StageNode {
            id,
            child: Some(child),
        }) = node
            && holds_all(child)
            && !surviving.contains(id)
        {
            return LayoutNode::Stage(StageNode {
                id: id.clone(),
                child: Some(Box::new(insert(
                    child, seam, incoming, split_id, surviving, holds_all,
                ))),
            });
        }
        if let LayoutNode::Split(split) = node {
            if let Some(container) = split.children.iter().position(|c| holds_all(c)) {
                let mut children = split.children.clone();
                children[container] = insert(
                    &split.children[container],
                    seam,
                    incoming,
                    split_id,
                    surviving,
                    holds_all,
                );
                return LayoutNode::Split(SplitNode {
                    children,
                    ..split.clone()
                });
            }
            if split.axis == seam.axis {
                let index = split.children.iter().position(|child| {
                    leaf_ids(Some(child))
                        .iter()
                        .any(|id| !seam.before.contains(id))
                });
                let mut children = split.children.clone();
                let total = sum(&split.weights);
                let share = 1. / (children.len() + 1) as f64;
                let mut weights: Vec<f64> = split
                    .weights
                    .iter()
                    .map(|w| w / total * (1. - share))
                    .collect();
                let at = index.unwrap_or(split.children.len());
                children.insert(at, incoming.clone());
                weights.insert(at, share);
                return LayoutNode::Split(SplitNode {
                    children,
                    weights,
                    ..split.clone()
                });
            }
        }
        let before = !surviving.iter().any(|id| seam.before.contains(id));
        let edge = match (seam.axis, before) {
            (Axis::X, true) => Edge::Left,
            (Axis::X, false) => Edge::Right,
            (Axis::Y, true) => Edge::Top,
            (Axis::Y, false) => Edge::Bottom,
        };
        insert_beside(Some(node), node.id(), incoming, edge, split_id, None)
    }
    normalize(insert(
        root, seam, incoming, split_id, &surviving, &holds_all,
    ))
    .unwrap_or_else(|| root.clone())
}

/// Apply a dock target (edge or seam) to a tree.
pub fn apply_dock_target(
    root: Option<&LayoutNode>,
    target: &DockTargetSpec,
    incoming: &LayoutNode,
    split_id: &str,
) -> LayoutNode {
    let Some(root) = root else {
        return incoming.clone();
    };
    match &target.seam {
        Some(seam) => insert_at_seam(root, seam, incoming, split_id),
        None => insert_beside(Some(root), &target.id, incoming, target.edge, split_id, None),
    }
}
