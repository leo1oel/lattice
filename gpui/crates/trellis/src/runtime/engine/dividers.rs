// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/workspace.ts: dividers, floating resize, layout metrics), with Lattice's patch
// (contentMin, the divider's rubber band and spring, layoutDoc, elasticCut, edgeLeaves).

//! Minimum sizes, the dividers between split children, and the floating
//! panels' resize handles.

use std::collections::HashSet;

use crate::model::{
    Axis, Entries, LayoutDocument, LayoutNode, Point, Rect, SplitNode, find_node,
    replace_node, resize_boundary,
};

use super::{Engine, PANEL_MIN_W};

/// How far past its limit a divider follows the pointer, at most.
const STRETCH: f64 = 40.;

#[derive(Clone, Debug)]
pub(crate) struct Stretched {
    pub split_id: String,
    pub index: usize,
    pub px: f64,
    pub extent: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct Elastic {
    pub axis: Axis,
    pub amount: f64,
    pub leaves: HashSet<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct DividerDrag {
    pub split_id: String,
    pub index: usize,
    pub axis: Axis,
    pub origin: LayoutDocument,
    /// The split's screen rect at the press.
    pub rect: Rect,
    pub extent: f64,
    pub stretch: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct Spring {
    pub from: f64,
    pub start: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct FloatResize {
    pub panel_id: String,
    pub dir: ResizeDir,
    pub start: Rect,
    pub start_point: Point,
    pub origin: LayoutDocument,
}

/// A floating panel's resize handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ResizeDir {
    N,
    S,
    E,
    W,
    NE,
    NW,
    SE,
    SW,
}

impl ResizeDir {
    pub const ALL: [ResizeDir; 8] = [
        ResizeDir::N,
        ResizeDir::S,
        ResizeDir::E,
        ResizeDir::W,
        ResizeDir::NE,
        ResizeDir::NW,
        ResizeDir::SE,
        ResizeDir::SW,
    ];

    fn has(self, side: char) -> bool {
        let name = match self {
            ResizeDir::N => "n",
            ResizeDir::S => "s",
            ResizeDir::E => "e",
            ResizeDir::W => "w",
            ResizeDir::NE => "ne",
            ResizeDir::NW => "nw",
            ResizeDir::SE => "se",
            ResizeDir::SW => "sw",
        };
        name.contains(side)
    }
}

#[derive(Default)]
pub(crate) struct DividerState {
    pub drag: Option<DividerDrag>,
    pub spring: Option<Spring>,
    /// The boundary drawn stretched; every relayout goes through
    /// `layout_doc` so none of them draws a frame of the unstretched layout
    /// mid-spring.
    pub stretched: Option<Stretched>,
    pub elastic: Option<Elastic>,
    /// The divider being dragged or springing back stays shown.
    pub active: Option<(String, usize)>,
    pub float_resize: Option<FloatResize>,
}

impl DividerState {
    pub fn springing(&self) -> bool {
        self.spring.is_some()
    }
}

impl Engine {
    /// Lattice patch: a panel is no smaller than its views' `min_size` (plus
    /// its tab bar), and a group no smaller than its children side by side,
    /// so dividers, drops and window resizes stop where headers still fit
    /// and content still lays out at full size.
    pub(crate) fn content_min(&self, node: &LayoutNode, axis: Axis) -> f64 {
        match node {
            LayoutNode::Stage(stage) => match &stage.child {
                Some(child) => self.content_min(child, axis),
                None => 120.,
            },
            LayoutNode::Panel(panel) => {
                let rules = self.rules_of(&panel.selected);
                if axis == Axis::Y {
                    return rules.min_size.map_or(28., |s| s.height) + self.tabbar_height()
                        - self.elastic_cut(&panel.id, axis);
                }
                // The widest of the panel's views, not the selected one's:
                // selecting another tab must not resize the panel.
                let width = panel
                    .views
                    .iter()
                    .map(|v| self.rules_of(v).min_size.map_or(0., |s| s.width))
                    .fold(PANEL_MIN_W, f64::max);
                let n = panel.views.len() as f64;
                let header = self
                    .panels
                    .get(&panel.id)
                    .and_then(|p| p.header_min)
                    .unwrap_or_else(|| {
                        let kind = self
                            .doc
                            .views
                            .get(&panel.selected)
                            .map(|r| r.kind.as_str())
                            .unwrap_or("");
                        let extra = self.options.header_fallback.get(kind).copied().unwrap_or(4.);
                        480f64.min(41. + extra + 80. * n + 2. * (n - 1.).max(0.))
                    });
                width.max(header) - self.elastic_cut(&panel.id, axis)
            }
            LayoutNode::Split(split) => {
                let mins: Vec<f64> = split
                    .children
                    .iter()
                    .map(|c| self.content_min(c, axis))
                    .collect();
                if split.axis == axis {
                    mins.iter().sum::<f64>() + self.gap() * (mins.len() as f64 - 1.)
                } else {
                    mins.iter().copied().fold(0., f64::max)
                }
            }
        }
    }

    fn elastic_cut(&self, panel_id: &str, axis: Axis) -> f64 {
        match &self.dividers.elastic {
            Some(e) if e.axis == axis && e.leaves.contains(panel_id) => e.amount,
            _ => 0.,
        }
    }

    /// The document's layout, with a stretched divider's rubber band applied.
    pub(crate) fn layout_doc(&mut self, base: Option<&LayoutDocument>) -> Entries {
        let base = base.unwrap_or(&self.doc).clone();
        self.dividers.elastic = None;
        let stretched = self.dividers.stretched.clone();
        let node = stretched
            .as_ref()
            .and_then(|s| find_node(base.root.as_ref(), &s.split_id))
            .and_then(|n| n.as_split())
            .cloned();
        let (Some(stretched), Some(node)) = (stretched, node) else {
            return self.layout_rects_of(base.root.as_ref());
        };
        if stretched.px.abs() < 0.05 || stretched.extent <= 0. {
            return self.layout_rects_of(base.root.as_ref());
        }
        let Stretched {
            index, px, extent, ..
        } = stretched;
        let squeezed = if px > 0. {
            &node.children[index + 1]
        } else {
            &node.children[index]
        };
        let mut leaves = HashSet::new();
        edge_leaves(Some(squeezed), node.axis, px > 0., &mut leaves);
        self.dividers.elastic = Some(Elastic {
            axis: node.axis,
            amount: px.abs(),
            leaves,
        });
        let total: f64 = node.weights.iter().sum();
        let mut weights: Vec<f64> = node.weights.iter().map(|w| w / total).collect();
        let shift = (-weights[index] + 1e-3).max((weights[index + 1] - 1e-3).min(px / extent));
        weights[index] += shift;
        weights[index + 1] -= shift;
        let root = replace_node(
            base.root.as_ref(),
            &node.id,
            &LayoutNode::Split(SplitNode {
                weights,
                ..node.clone()
            }),
        );
        self.layout_rects_of(root.as_ref())
    }

    /// A split child's minimum as a fraction of the split's own layout size.
    pub(crate) fn min_fraction(&self, split: &SplitNode, index: usize) -> f64 {
        let e = self.entries.get(&split.id);
        let child = &split.children[index];
        let child_scale = self
            .entries
            .get(child.id())
            .and_then(|e| e.scale)
            .unwrap_or(1.);
        let (width, height) = (
            self.viewport.0 - self.pad() * 2.,
            self.viewport.1 - self.pad() * 2.,
        );
        let extent = e.map_or(0., |e| {
            if split.axis == Axis::X {
                e.rect.w * width
            } else {
                e.rect.h * height
            }
        });
        if extent > 0. {
            (self.content_min(child, split.axis) + self.gap()) * child_scale / extent
        } else {
            0.
        }
    }

    /// A split with the proportions it actually has on screen (weights with
    /// minimums applied).
    pub(crate) fn effective_split(&self, id: &str) -> Option<SplitNode> {
        self.entries.get(id).and_then(|e| e.node.as_split()).cloned()
    }

    fn stop_spring(&mut self) {
        self.dividers.spring = None;
        self.dividers.stretched = None;
        self.dividers.elastic = None;
        if !self.gesture {
            self.dividers.active = None;
        }
    }

    /// A press on the divider after child `index` of `split_id`.
    pub fn divider_down(&mut self, split_id: &str, index: usize) {
        if self.dividers.spring.is_some() {
            self.stop_spring();
            self.entries = self.layout_rects_of(self.doc.root.clone().as_ref());
        }
        let (Some(split), Some(entry)) = (
            self.effective_split(split_id),
            self.entries.get(split_id).cloned(),
        ) else {
            return;
        };
        let rect = self.to_screen(entry.rect);
        let extent = if split.axis == Axis::X { rect.w } else { rect.h };
        self.dividers.drag = Some(DividerDrag {
            split_id: split_id.to_string(),
            index,
            axis: split.axis,
            origin: self.doc.clone(),
            rect,
            extent,
            stretch: 0.,
        });
        self.dividers.active = Some((split_id.to_string(), index));
        self.gesture = true;
    }

    /// The pointer moved while a divider is held.
    pub fn divider_move(&mut self, p: Point) {
        let Some(drag) = self.dividers.drag.clone() else {
            return;
        };
        let r = drag.rect;
        let position = if drag.axis == Axis::X {
            (p.x - r.x) / r.w
        } else {
            (p.y - r.y) / r.h
        };
        self.dividers.stretched = None;
        self.entries = self.layout_doc(None);
        let Some(current) = self.effective_split(&drag.split_id) else {
            return;
        };
        let resized = resize_boundary(&current, drag.index, position, &|i| {
            self.min_fraction(&current, i)
        });
        let total: f64 = resized.weights.iter().sum();
        let actual: f64 = resized.weights[..=drag.index].iter().sum::<f64>() / total;
        let stretch = if self.reduced() {
            0.
        } else {
            STRETCH * ((position - actual) * drag.extent / (STRETCH * 4.)).tanh()
        };
        self.doc.root = replace_node(
            self.doc.root.as_ref(),
            &drag.split_id,
            &LayoutNode::Split(resized),
        );
        if let Some(d) = &mut self.dividers.drag {
            d.stretch = stretch;
        }
        self.show_stretched(&drag.split_id, drag.index, stretch, drag.extent);
    }

    fn show_stretched(&mut self, split_id: &str, index: usize, px: f64, extent: f64) {
        self.dividers.stretched = Some(Stretched {
            split_id: split_id.to_string(),
            index,
            px,
            extent,
        });
        self.entries = self.layout_doc(None);
    }

    /// The divider is released (`cancelled`: the pointer was lost).
    pub fn divider_up(&mut self, cancelled: bool) {
        let Some(drag) = self.dividers.drag.take() else {
            return;
        };
        self.gesture = false;
        let next = if cancelled {
            drag.origin.clone()
        } else {
            self.doc.clone()
        };
        self.doc = drag.origin.clone();
        let spring = !cancelled && drag.stretch != 0. && !self.reduced();
        // Keep the release frame stretched; the spring takes it from there.
        if !spring {
            self.dividers.stretched = None;
        }
        if next == drag.origin {
            self.entries = self.layout_rects_of(self.doc.root.clone().as_ref());
        } else {
            self.commit(next, false, None);
        }
        if !spring {
            self.dividers.active = None;
            return;
        }
        // A damped spring from the stretched boundary: back through the
        // limit by about a fifth of the stretch, then settled within about
        // half a second.
        self.dividers.spring = Some(Spring {
            from: drag.stretch,
            start: self.now(),
        });
    }

    /// Advance the divider's spring-back; called each frame.
    pub(crate) fn step_divider_spring(&mut self, now: f64) {
        let Some(spring) = self.dividers.spring.clone() else {
            return;
        };
        let Some(stretched) = self.dividers.stretched.clone() else {
            self.stop_spring();
            return;
        };
        let t = (now - spring.start) / 1000.;
        let px = spring.from * (-t / 0.11).exp() * (2. * std::f64::consts::PI * t / 0.36).cos();
        if t > 0.6 || (t > 0.2 && px.abs() < 0.25) {
            self.stop_spring();
            self.entries = self.layout_rects_of(self.doc.root.clone().as_ref());
            return;
        }
        self.show_stretched(&stretched.split_id, stretched.index, px, stretched.extent);
    }

    /// Double-click on a divider: the pair either side of it share their
    /// room equally.
    pub fn equalize(&mut self, split_id: &str, index: usize) {
        let Some(LayoutNode::Split(split)) = find_node(self.doc.root.as_ref(), split_id).cloned()
        else {
            return;
        };
        let mut weights = split.weights.clone();
        let pair = weights[index] + weights[index + 1];
        weights[index] = pair / 2.;
        weights[index + 1] = pair / 2.;
        let mut next = self.doc.clone();
        next.root = replace_node(
            self.doc.root.as_ref(),
            split_id,
            &LayoutNode::Split(SplitNode { weights, ..split }),
        );
        self.commit(next, true, None);
    }

    /// An arrow key on a focused divider: 2% a press, 10% with Shift.
    pub fn divider_key(&mut self, split_id: &str, index: usize, increase: bool, shift: bool) {
        let Some(split) = self.effective_split(split_id) else {
            return;
        };
        let total: f64 = split.weights.iter().sum();
        let boundary = split.weights[..=index].iter().sum::<f64>() / total;
        let step = if shift { 0.1 } else { 0.02 };
        let resized = resize_boundary(
            &split,
            index,
            boundary + if increase { step } else { -step },
            &|i| self.min_fraction(&split, i),
        );
        let mut next = self.doc.clone();
        next.root = replace_node(self.doc.root.as_ref(), &split.id, &LayoutNode::Split(resized));
        self.commit(next, false, None);
    }

    /// A press on one of a floating panel's resize handles.
    pub fn float_resize_down(&mut self, panel_id: &str, dir: ResizeDir, p: Point) {
        let Some(float) = self.doc.floating.iter().find(|f| f.panel.id == panel_id) else {
            return;
        };
        let start = self.float_screen(float.rect, float.layer);
        self.dividers.float_resize = Some(FloatResize {
            panel_id: panel_id.to_string(),
            dir,
            start,
            start_point: p,
            origin: self.doc.clone(),
        });
        self.gesture = true;
    }

    pub fn float_resize_move(&mut self, p: Point) {
        let Some(resize) = self.dividers.float_resize.clone() else {
            return;
        };
        let Some(layer) = self
            .doc
            .floating
            .iter()
            .find(|f| f.panel.id == resize.panel_id)
            .map(|f| f.layer)
        else {
            return;
        };
        let min_w: f64 = 160.;
        let min_h = self.tabbar_height() + 60.;
        let (dx, dy) = (p.x - resize.start_point.x, p.y - resize.start_point.y);
        let s = resize.start;
        let (mut x, mut y, mut w, mut h) = (s.x, s.y, s.w, s.h);
        if resize.dir.has('e') {
            w = min_w.max(s.w + dx);
        }
        if resize.dir.has('s') {
            h = min_h.max(s.h + dy);
        }
        if resize.dir.has('w') {
            w = min_w.max(s.w - dx);
            x = s.x + s.w - w;
        }
        if resize.dir.has('n') {
            h = min_h.max(s.h - dy);
            y = s.y + s.h - h;
        }
        let rect = self.screen_to_float(Rect::new(x, y, w, h), layer);
        for f in &mut self.doc.floating {
            if f.panel.id == resize.panel_id {
                f.rect = rect;
            }
        }
    }

    pub fn float_resize_up(&mut self) {
        let Some(resize) = self.dividers.float_resize.take() else {
            return;
        };
        self.gesture = false;
        let next = std::mem::replace(&mut self.doc, resize.origin);
        self.commit(next, false, None);
    }

    pub fn resizing(&self) -> Option<ResizeKind> {
        if let Some(drag) = &self.dividers.drag {
            return Some(ResizeKind::Divider(drag.axis));
        }
        self.dividers
            .float_resize
            .as_ref()
            .map(|_| ResizeKind::Float)
    }

    /// The divider drawn active (held, or springing back).
    pub fn active_divider(&self) -> Option<(&str, usize)> {
        self.dividers
            .active
            .as_ref()
            .map(|(id, i)| (id.as_str(), *i))
    }

    /// The panels a divider's rubber band squeezes, and by how much.
    pub(crate) fn squeeze_of(&self, panel_id: &str) -> f64 {
        match &self.dividers.elastic {
            Some(e) if e.leaves.contains(panel_id) => e.amount,
            _ => 0.,
        }
    }
}

/// What is being resized.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResizeKind {
    Divider(Axis),
    Float,
}

/// The panels along a node's edge on `axis` (its start or end), so nested
/// splits follow a rubber band without scaling.
fn edge_leaves(node: Option<&LayoutNode>, axis: Axis, at_start: bool, out: &mut HashSet<String>) {
    match node {
        None => {}
        Some(LayoutNode::Stage(stage)) => edge_leaves(stage.child.as_deref(), axis, at_start, out),
        Some(LayoutNode::Panel(panel)) => {
            out.insert(panel.id.clone());
        }
        Some(LayoutNode::Split(split)) => {
            if split.axis == axis {
                let child = if at_start {
                    split.children.first()
                } else {
                    split.children.last()
                };
                edge_leaves(child, axis, at_start, out);
            } else {
                for child in &split.children {
                    edge_leaves(Some(child), axis, at_start, out);
                }
            }
        }
    }
}
