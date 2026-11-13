// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/workspace.ts: collapsed groups).

//! How much detail small parts of the layout show while navigating: a
//! nested split group whose parts are all too small on screen collapses into
//! one tile, outlined with its first levels of splits; double-clicking the
//! tile zooms to the part under the pointer.

use crate::model::{Axis, LayoutNode, Rect, leaf_ids};

use super::Engine;
use super::frame::GroupFrame;

impl Engine {
    /// The outermost nested split groups whose parts are all too small on
    /// screen even for an icon. A flat row or column of small panels keeps
    /// its icon tiles; only nesting collapses. The framed group never
    /// collapses.
    pub(super) fn compute_collapsed(&mut self) {
        self.collapsed_of.clear();
        self.collapsed_groups.clear();
        self.hidden_splits.clear();
        let Some((size, _)) = self.options.detail else {
            return;
        };
        if !self.navigation_on() {
            return;
        }
        let framed = self.nav.framed.clone();
        let mut groups = Vec::new();
        let mut hidden = Vec::new();
        fn hide(node: &LayoutNode, out: &mut Vec<String>) {
            match node {
                LayoutNode::Split(s) => {
                    out.push(s.id.clone());
                    s.children.iter().for_each(|c| hide(c, out));
                }
                LayoutNode::Stage(s) => {
                    if let Some(c) = &s.child {
                        hide(c, out);
                    }
                }
                LayoutNode::Panel(_) => {}
            }
        }
        let small = |id: &str| {
            self.entries.get(id).is_some_and(|e| {
                let r = self.to_screen(e.rect);
                r.w < size || r.h < size
            })
        };
        let mut stack: Vec<&LayoutNode> = self.doc.root.iter().collect();
        while let Some(node) = stack.pop() {
            let split = match node {
                LayoutNode::Stage(s) => {
                    if let Some(c) = &s.child {
                        stack.push(c);
                    }
                    continue;
                }
                LayoutNode::Panel(_) => continue,
                LayoutNode::Split(s) => s,
            };
            let nested = split.children.iter().any(|c| {
                c.is_split() || c.stage_child().is_some_and(LayoutNode::is_split)
            });
            if Some(&split.id) != framed.as_ref()
                && nested
                && (small(&split.id) || split.children.iter().all(|c| small(c.id())))
            {
                groups.push(split.id.clone());
                hide(node, &mut hidden);
                continue;
            }
            stack.extend(split.children.iter().rev());
        }
        for id in &groups {
            if let Some(node) = self.entries.get(id).map(|e| e.node.clone()) {
                for leaf in leaf_ids(Some(&node)) {
                    self.collapsed_of.insert(leaf, id.clone());
                }
            }
        }
        self.collapsed_groups = groups;
        self.hidden_splits = hidden.into_iter().collect();
    }

    pub(super) fn render_groups(&self) -> Vec<GroupFrame> {
        let outline = self.options.detail.map_or(0, |(_, o)| o);
        self.collapsed_groups
            .iter()
            .filter_map(|id| {
                let e = self.entries.get(id)?;
                e.node.as_split()?;
                let r = self.panel_screen(e.rect);
                let onscreen = r.x < self.viewport.0 && r.y < self.viewport.1 && r.x + r.w > 0. && r.y + r.h > 0.;
                if !onscreen {
                    return None;
                }
                let mut lines = Vec::new();
                self.group_outline(&e.node, e.rect, 0, outline, &mut lines);
                Some(GroupFrame {
                    id: id.clone(),
                    rect: r,
                    count: leaf_ids(Some(&e.node)).len(),
                    lines,
                })
            })
            .collect()
    }

    /// Lines for a collapsed group's splits, `depth` levels deep.
    pub(super) fn group_outline(
        &self,
        node: &LayoutNode,
        bounds: Rect,
        level: usize,
        depth: usize,
        out: &mut Vec<(Axis, f64, f64, f64)>,
    ) {
        match node {
            LayoutNode::Stage(s) => {
                if let Some(c) = &s.child {
                    self.group_outline(c, bounds, level, depth, out);
                }
            }
            LayoutNode::Panel(_) => {}
            LayoutNode::Split(split) => {
                if level >= depth {
                    return;
                }
                let Some(r) = self.entries.get(&split.id).map(|e| e.rect) else {
                    return;
                };
                for child in &split.children[1..] {
                    let Some(c) = self.entries.get(child.id()).map(|e| e.rect) else {
                        continue;
                    };
                    if split.axis == Axis::X {
                        out.push((
                            Axis::X,
                            (c.x - bounds.x) / bounds.w,
                            (r.y - bounds.y) / bounds.h,
                            (r.y + r.h - bounds.y) / bounds.h,
                        ));
                    } else {
                        out.push((
                            Axis::Y,
                            (c.y - bounds.y) / bounds.h,
                            (r.x - bounds.x) / bounds.w,
                            (r.x + r.w - bounds.x) / bounds.w,
                        ));
                    }
                }
                for child in &split.children {
                    self.group_outline(child, bounds, level + 1, depth, out);
                }
            }
        }
    }

    /// The part of a collapsed group under a point (workspace px), as deep
    /// as its outline shows: double-clicking zooms there.
    pub fn group_segment_at(&mut self, group_id: &str, at: crate::model::Point) {
        let p = self.from_screen(at);
        let outline = self.options.detail.map_or(0, |(_, o)| o).max(1);
        let mut node = self.entries.get(group_id).map(|e| e.node.clone());
        let mut target = group_id.to_string();
        for _ in 0..outline {
            if let Some(LayoutNode::Stage(s)) = &node {
                node = s.child.as_deref().cloned();
            }
            let Some(LayoutNode::Split(split)) = &node else {
                break;
            };
            let child = split.children.iter().find(|c| {
                self.entries
                    .get(c.id())
                    .is_some_and(|e| e.rect.contains(p))
            });
            let Some(child) = child.cloned() else {
                break;
            };
            target = child.id().to_string();
            node = Some(child);
        }
        self.nav_focus(Some(&target), true);
    }
}
