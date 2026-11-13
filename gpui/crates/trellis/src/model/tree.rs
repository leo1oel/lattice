// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/model/tree.ts).

//! The layout tree: geometry (with and without pixel minimums), and the
//! structural edits every other part builds on. Edits never mutate; each
//! returns the new tree.

use indexmap::IndexMap;

use super::types::{Axis, Edge, LayoutNode, PanelNode, Rect, SplitNode, StageNode};

pub const UNIT: Rect = Rect {
    x: 0.,
    y: 0.,
    w: 1.,
    h: 1.,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub node: LayoutNode,
    pub rect: Rect,
    pub parent: Option<String>,
    /// How much this node is scaled down on screen by cramped groups around
    /// it (1 = not scaled). Only set when laid out with metrics.
    pub scale: Option<f64>,
    /// A camera-only group of contiguous siblings; not a node in the tree.
    pub virtual_range: bool,
}

/// Every node's entry by id, in the order the tree is walked.
pub type Entries = IndexMap<String, Entry>;

/// Pixel sizes for laying out with minimums. `min` is the smallest a node
/// may be along an axis, in pixels of its parent group's own layout space.
/// A group whose children's minimums don't fit lays out at its natural size
/// and is scaled down into its slot.
pub struct LayoutMetrics<'a> {
    pub width: f64,
    pub height: f64,
    pub min: &'a dyn Fn(&LayoutNode, Axis) -> f64,
}

/// World geometry of every node, as fractions of the whole layout. With
/// metrics, each group keeps its children at their minimums (in its own
/// layout space) and scales down when they can't fit.
pub fn layout_rects(node: Option<&LayoutNode>, metrics: Option<&LayoutMetrics>) -> Entries {
    let mut out = Entries::new();
    match metrics {
        None => layout_by_weights(node, UNIT, None, &mut out),
        Some(metrics) => layout_with_minimums(
            node,
            UNIT,
            (metrics.width, metrics.height),
            1.,
            None,
            metrics,
            &mut out,
        ),
    }
    out
}

fn layout_by_weights(
    node: Option<&LayoutNode>,
    rect: Rect,
    parent: Option<&str>,
    out: &mut Entries,
) {
    let Some(node) = node else { return };
    out.insert(
        node.id().to_string(),
        Entry {
            node: node.clone(),
            rect,
            parent: parent.map(str::to_string),
            scale: None,
            virtual_range: false,
        },
    );
    match node {
        LayoutNode::Stage(stage) => {
            if let Some(child) = &stage.child {
                layout_by_weights(Some(child), rect, Some(&stage.id), out);
            }
        }
        LayoutNode::Split(split) => {
            let total = sum(&split.weights);
            let mut offset = 0.;
            for (i, child) in split.children.iter().enumerate() {
                let share = split.weights[i] / total;
                layout_by_weights(
                    Some(child),
                    slice(rect, split.axis, offset, share),
                    Some(&split.id),
                    out,
                );
                offset += share;
            }
        }
        LayoutNode::Panel(_) => {}
    }
}

/// `size` is the node's slot in its own layout pixels, and `scale` how much
/// those pixels are scaled on screen. A split whose children's minimums
/// don't fit its size lays out at size ÷ s, where s is the tighter of the two
/// ratios, so the natural layout fills the slot exactly in both directions.
fn layout_with_minimums(
    node: Option<&LayoutNode>,
    rect: Rect,
    size: (f64, f64),
    scale: f64,
    parent: Option<&str>,
    metrics: &LayoutMetrics,
    out: &mut Entries,
) {
    let Some(node) = node else { return };
    let entry = |node: LayoutNode| Entry {
        node,
        rect,
        parent: parent.map(str::to_string),
        scale: Some(scale),
        virtual_range: false,
    };
    let split = match node {
        LayoutNode::Stage(stage) => {
            out.insert(stage.id.clone(), entry(node.clone()));
            if let Some(child) = &stage.child {
                layout_with_minimums(Some(child), rect, size, scale, Some(&stage.id), metrics, out);
            }
            return;
        }
        LayoutNode::Panel(panel) => {
            out.insert(panel.id.clone(), entry(node.clone()));
            return;
        }
        LayoutNode::Split(split) => split,
    };
    let along = |s: (f64, f64)| if split.axis == Axis::X { s.0 } else { s.1 };
    let across = |s: (f64, f64)| if split.axis == Axis::X { s.1 } else { s.0 };
    let cross = split.axis.cross();
    let mins: Vec<f64> = split
        .children
        .iter()
        .map(|c| (metrics.min)(c, split.axis))
        .collect();
    let need_along = sum(&mins);
    let need_across = split
        .children
        .iter()
        .map(|c| (metrics.min)(c, cross))
        .fold(0f64, f64::max);
    let s = 1f64
        .min(if need_along > 0. {
            along(size) / need_along
        } else {
            1.
        })
        .min(if need_across > 0. {
            across(size) / need_across
        } else {
            1.
        });
    let natural = (size.0 / s, size.1 / s);
    let extents = distribute(along(natural), &split.weights, &mins);
    let fractions: Vec<f64> = extents.iter().map(|e| e / along(natural)).collect();
    out.insert(
        split.id.clone(),
        entry(LayoutNode::Split(SplitNode {
            weights: fractions.clone(),
            ..split.clone()
        })),
    );
    let mut offset = 0.;
    for (i, child) in split.children.iter().enumerate() {
        let child_size = if split.axis == Axis::X {
            (extents[i], natural.1)
        } else {
            (natural.0, extents[i])
        };
        layout_with_minimums(
            Some(child),
            slice(rect, split.axis, offset, fractions[i]),
            child_size,
            scale * s,
            Some(&split.id),
            metrics,
            out,
        );
        offset += fractions[i];
    }
}

/// Share `total` by weight, then raise any extent below its minimum, taking
/// the difference from the others in proportion to their weights. Assumes
/// the minimums fit.
pub fn distribute(total: f64, weights: &[f64], mins: &[f64]) -> Vec<f64> {
    let mut fixed = vec![false; weights.len()];
    loop {
        let free: Vec<usize> = (0..weights.len()).filter(|i| !fixed[*i]).collect();
        let left = total
            - (0..weights.len())
                .filter(|i| fixed[*i])
                .map(|i| mins[i])
                .sum::<f64>();
        let weight: f64 = free.iter().map(|i| weights[*i]).sum();
        let extents: Vec<f64> = weights
            .iter()
            .enumerate()
            .map(|(i, w)| {
                if fixed[i] {
                    mins[i]
                } else if weight > 0. {
                    left * w / weight
                } else {
                    left / free.len() as f64
                }
            })
            .collect();
        let under: Vec<usize> = free
            .iter()
            .copied()
            .filter(|i| extents[*i] < mins[*i] - 1e-9)
            .collect();
        if under.is_empty() {
            return extents;
        }
        for i in under {
            fixed[i] = true;
        }
    }
}

fn slice(rect: Rect, axis: Axis, offset: f64, share: f64) -> Rect {
    match axis {
        Axis::X => Rect {
            x: rect.x + offset * rect.w,
            w: rect.w * share,
            ..rect
        },
        Axis::Y => Rect {
            y: rect.y + offset * rect.h,
            h: rect.h * share,
            ..rect
        },
    }
}

pub fn sum(values: &[f64]) -> f64 {
    values.iter().sum()
}

pub fn find_node<'a>(node: Option<&'a LayoutNode>, id: &str) -> Option<&'a LayoutNode> {
    let node = node?;
    if node.id() == id {
        return Some(node);
    }
    match node {
        LayoutNode::Stage(stage) => find_node(stage.child.as_deref(), id),
        LayoutNode::Split(split) => split
            .children
            .iter()
            .find_map(|child| find_node(Some(child), id)),
        LayoutNode::Panel(_) => None,
    }
}

pub fn panels_of(node: Option<&LayoutNode>) -> Vec<&PanelNode> {
    let mut out = Vec::new();
    fn walk<'a>(node: &'a LayoutNode, out: &mut Vec<&'a PanelNode>) {
        match node {
            LayoutNode::Panel(panel) => out.push(panel),
            LayoutNode::Stage(stage) => {
                if let Some(child) = &stage.child {
                    walk(child, out);
                }
            }
            LayoutNode::Split(split) => split.children.iter().for_each(|c| walk(c, out)),
        }
    }
    if let Some(node) = node {
        walk(node, &mut out);
    }
    out
}

pub fn find_stage(node: Option<&LayoutNode>) -> Option<&StageNode> {
    match node? {
        LayoutNode::Stage(stage) => Some(stage),
        LayoutNode::Split(split) => split.children.iter().find_map(|c| find_stage(Some(c))),
        LayoutNode::Panel(_) => None,
    }
}

/// Whether `id` is `ancestor` or lies inside it.
pub fn contains(root: Option<&LayoutNode>, ancestor: &str, id: &str) -> bool {
    find_node(root, ancestor).is_some_and(|node| find_node(Some(node), id).is_some())
}

/// Collapse single-child splits, flatten aligned splits and drop empty ones.
/// Geometry is preserved. Stages are never removed.
pub fn normalize(node: LayoutNode) -> Option<LayoutNode> {
    match node {
        LayoutNode::Panel(panel) => (!panel.views.is_empty()).then_some(LayoutNode::Panel(panel)),
        LayoutNode::Stage(stage) => {
            let child = stage.child.and_then(|child| normalize(*child));
            Some(LayoutNode::Stage(StageNode {
                id: stage.id,
                child: child.map(Box::new),
            }))
        }
        LayoutNode::Split(split) => {
            let mut children = Vec::new();
            let mut weights = Vec::new();
            for (i, child) in split.children.into_iter().enumerate() {
                let raw = split.weights.get(i).copied().unwrap_or(f64::NAN);
                let weight = if raw.is_finite() && raw > 0. { raw } else { 1e-3 };
                let Some(next) = normalize(child) else {
                    continue;
                };
                match next {
                    LayoutNode::Split(inner) if inner.axis == split.axis => {
                        let total = sum(&inner.weights);
                        for (j, grandchild) in inner.children.into_iter().enumerate() {
                            children.push(grandchild);
                            weights.push(weight * inner.weights[j] / total);
                        }
                    }
                    next => {
                        children.push(next);
                        weights.push(weight);
                    }
                }
            }
            match children.len() {
                0 => None,
                1 => children.pop(),
                _ => {
                    let total = sum(&weights);
                    Some(LayoutNode::Split(SplitNode {
                        id: split.id,
                        axis: split.axis,
                        weights: weights.iter().map(|w| w / total).collect(),
                        children,
                    }))
                }
            }
        }
    }
}

/// Remove a node. Its share goes to the next sibling (previous at the end).
pub fn remove_node(root: Option<&LayoutNode>, id: &str) -> Option<LayoutNode> {
    let root = root?;
    if root.id() == id {
        return root.is_stage().then(|| root.clone());
    }
    match root {
        LayoutNode::Panel(_) => Some(root.clone()),
        LayoutNode::Stage(stage) => {
            let Some(child) = &stage.child else {
                return Some(root.clone());
            };
            if child.id() == id {
                return Some(LayoutNode::Stage(StageNode {
                    id: stage.id.clone(),
                    child: None,
                }));
            }
            let child = remove_node(Some(child), id);
            Some(LayoutNode::Stage(StageNode {
                id: stage.id.clone(),
                child: child.map(Box::new),
            }))
        }
        LayoutNode::Split(split) => {
            if let Some(index) = split.children.iter().position(|c| c.id() == id) {
                if split.children[index].is_stage() {
                    return Some(root.clone());
                }
                let mut children = split.children.clone();
                let mut weights = split.weights.clone();
                let removed = weights[index];
                children.remove(index);
                weights.remove(index);
                if children.is_empty() {
                    return None;
                }
                let at = index.min(weights.len() - 1);
                weights[at] += removed;
                return normalize(LayoutNode::Split(SplitNode {
                    children,
                    weights,
                    ..split.clone()
                }));
            }
            let mut changed = false;
            let mut children = Vec::new();
            let mut weights: Vec<f64> = Vec::new();
            for (i, child) in split.children.iter().enumerate() {
                let next = remove_node(Some(child), id);
                if next.as_ref() != Some(child) {
                    changed = true;
                }
                match next {
                    Some(next) => {
                        children.push(next);
                        weights.push(split.weights[i]);
                    }
                    None => {
                        if let Some(last) = weights.last_mut() {
                            *last += split.weights[i];
                        }
                    }
                }
            }
            if !changed {
                return Some(root.clone());
            }
            if children.is_empty() {
                return None;
            }
            normalize(LayoutNode::Split(SplitNode {
                children,
                weights,
                ..split.clone()
            }))
        }
    }
}

/// Insert `incoming` beside `target_id`, taking `share` of the target's space.
pub fn insert_beside(
    root: Option<&LayoutNode>,
    target_id: &str,
    incoming: &LayoutNode,
    edge: Edge,
    split_id: &str,
    share: Option<f64>,
) -> LayoutNode {
    let Some(root) = root else {
        return incoming.clone();
    };
    let share = share.unwrap_or(0.5).clamp(0.1, 0.9);
    insert_beside_inner(root, target_id, incoming, edge, split_id, share)
}

fn insert_beside_inner(
    root: &LayoutNode,
    target_id: &str,
    incoming: &LayoutNode,
    edge: Edge,
    split_id: &str,
    share: f64,
) -> LayoutNode {
    if root.id() == target_id {
        let before = edge.before();
        let (weights, children) = if before {
            (vec![share, 1. - share], vec![incoming.clone(), root.clone()])
        } else {
            (vec![1. - share, share], vec![root.clone(), incoming.clone()])
        };
        return normalize(LayoutNode::Split(SplitNode {
            id: split_id.to_string(),
            axis: edge.axis(),
            weights,
            children,
        }))
        .expect("a split of two nodes is never empty");
    }
    match root {
        LayoutNode::Panel(_) => root.clone(),
        LayoutNode::Stage(stage) => match &stage.child {
            None => root.clone(),
            Some(child) => LayoutNode::Stage(StageNode {
                id: stage.id.clone(),
                child: Some(Box::new(insert_beside_inner(
                    child, target_id, incoming, edge, split_id, share,
                ))),
            }),
        },
        LayoutNode::Split(split) => {
            let mut changed = false;
            let children: Vec<LayoutNode> = split
                .children
                .iter()
                .map(|child| {
                    let next =
                        insert_beside_inner(child, target_id, incoming, edge, split_id, share);
                    if &next != child {
                        changed = true;
                    }
                    next
                })
                .collect();
            if !changed {
                return root.clone();
            }
            normalize(LayoutNode::Split(SplitNode {
                children,
                ..split.clone()
            }))
            .expect("a split that gained a node is never empty")
        }
    }
}

pub fn replace_node(
    root: Option<&LayoutNode>,
    id: &str,
    replacement: &LayoutNode,
) -> Option<LayoutNode> {
    let root = root?;
    Some(replace_inner(root, id, replacement))
}

fn replace_inner(root: &LayoutNode, id: &str, replacement: &LayoutNode) -> LayoutNode {
    if root.id() == id {
        return replacement.clone();
    }
    match root {
        LayoutNode::Panel(_) => root.clone(),
        LayoutNode::Stage(stage) => match &stage.child {
            None => root.clone(),
            Some(child) => LayoutNode::Stage(StageNode {
                id: stage.id.clone(),
                child: Some(Box::new(replace_inner(child, id, replacement))),
            }),
        },
        LayoutNode::Split(split) => LayoutNode::Split(SplitNode {
            children: split
                .children
                .iter()
                .map(|child| replace_inner(child, id, replacement))
                .collect(),
            ..split.clone()
        }),
    }
}

/// Move the boundary after child `index` to `position` (fraction of the
/// split). `min` gives each child's minimum size as a fraction of the split.
pub fn resize_boundary(
    split: &SplitNode,
    index: usize,
    position: f64,
    min: &dyn Fn(usize) -> f64,
) -> SplitNode {
    let total = sum(&split.weights);
    let mut normalized: Vec<f64> = split.weights.iter().map(|w| w / total).collect();
    let start = sum(&normalized[..index]);
    let pair = normalized[index] + normalized[index + 1];
    let lo = min(index).min(pair / 2.);
    let hi = pair - min(index + 1).min(pair / 2.);
    let left = lo.max(hi.min(position - start));
    normalized[index] = left;
    normalized[index + 1] = pair - left;
    SplitNode {
        weights: normalized,
        ..split.clone()
    }
}

/// The default minimum fraction `resize_boundary` keeps each child at.
pub const DEFAULT_MIN_FRACTION: f64 = 0.04;

#[cfg(test)]
mod tests {
    use super::*;

    fn panel(id: &str) -> LayoutNode {
        LayoutNode::Panel(PanelNode::single(id, format!("{id}-view")))
    }

    fn split(id: &str, axis: Axis, children: Vec<LayoutNode>, weights: Vec<f64>) -> LayoutNode {
        LayoutNode::Split(SplitNode {
            id: id.into(),
            axis,
            weights,
            children,
        })
    }

    #[test]
    fn normalize_flattens_aligned_splits_and_keeps_geometry() {
        let tree = split(
            "a",
            Axis::X,
            vec![
                panel("p1"),
                split("b", Axis::X, vec![panel("p2"), panel("p3")], vec![1., 1.]),
            ],
            vec![1., 1.],
        );
        let LayoutNode::Split(out) = normalize(tree).unwrap() else {
            panic!()
        };
        assert_eq!(out.children.len(), 3);
        assert_eq!(out.weights, vec![0.5, 0.25, 0.25]);
    }

    #[test]
    fn removing_a_child_gives_its_share_to_the_next_sibling() {
        let tree = split(
            "a",
            Axis::X,
            vec![panel("p1"), panel("p2"), panel("p3")],
            vec![0.2, 0.3, 0.5],
        );
        let LayoutNode::Split(out) = remove_node(Some(&tree), "p1").unwrap() else {
            panic!()
        };
        assert_eq!(out.weights, vec![0.5, 0.5]);
        let LayoutNode::Split(out) = remove_node(Some(&tree), "p3").unwrap() else {
            panic!()
        };
        assert!((out.weights[1] - 0.8).abs() < 1e-12);
    }

    #[test]
    fn distribute_raises_minimums_from_the_others() {
        let extents = distribute(100., &[1., 1.], &[70., 0.]);
        assert_eq!(extents, vec![70., 30.]);
    }

    #[test]
    fn resize_boundary_clamps_to_minimums() {
        let LayoutNode::Split(s) = split("a", Axis::X, vec![panel("p1"), panel("p2")], vec![1., 1.])
        else {
            panic!()
        };
        let out = resize_boundary(&s, 0, 0.01, &|_| 0.1);
        assert!((out.weights[0] - 0.1).abs() < 1e-12);
    }
}
