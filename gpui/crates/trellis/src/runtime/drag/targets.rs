// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/drag.ts: retarget, tabTarget, filter).

//! The drop target under the pointer: overlay floats, tab bars, panel edges
//! and centres, seams, the empty stage, the frame band; and the allow rules
//! that remove targets.

use crate::model::{
    Edge, FloatingLayer, LayoutNode, PanelNode, Point, Rect, contains_node, drop_edge, find_node,
    find_stage, frame_drop_target, leaf_ids, seam_target, tile_drop_target,
};

use super::super::engine::{Engine, Region};
use super::{DESKTOP_SPLIT_MAX_PX, DragSession, DropTarget, MIN_SEAM_HIT_WIDTH, OVERLAY_EDGE_BAND};

pub(super) fn overlay_edge(p: Point, r: Rect) -> Option<Edge> {
    let x = (p.x - r.x) / r.w;
    let y = (p.y - r.y) / r.h;
    crate::model::nearest_edge(x, y)
        .filter(|(_, d)| *d <= OVERLAY_EDGE_BAND)
        .map(|(e, _)| e)
}

impl Engine {
    /// Resolve the target under the pointer (frame band, seams, tab bars,
    /// edges, centres).
    pub(super) fn retarget(&self, d: &DragSession, p: Point) -> Option<DropTarget> {
        let (vw, vh) = self.viewport;
        let point = self.from_screen(p);
        let within = p.x >= 0. && p.y >= 0. && p.x <= vw && p.y <= vh;
        let layer = self.floating_layer();
        let doc = &d.pdoc;
        let stage = find_stage(doc.root.as_ref());
        let stage_is_desktop =
            stage.is_some_and(|s| s.child.is_none()) && layer == Some(FloatingLayer::Stage);
        let overlay_move = d.from_float == Some(FloatingLayer::Overlay);
        // A window floating over a filled stage moves like an overlay float
        // while it stays over the stage.
        let stage_world = stage
            .filter(|s| s.child.is_some())
            .and_then(|s| d.drop_base.get(&s.id))
            .map(|e| e.rect);
        let stage_move = d.from_float == Some(FloatingLayer::Stage)
            && !d.tab_rollback
            && stage_world.is_some_and(|w| w.contains(point));
        let float_move = overlay_move || stage_move;
        let mut next: Option<DropTarget> = None;

        // Overlay floats are on top of everything; their centres take tabs.
        if within {
            let mut overlays: Vec<_> = doc
                .floating
                .iter()
                .filter(|f| f.layer == FloatingLayer::Overlay && f.panel.id != d.lifted.id)
                .collect();
            overlays.sort_by(|a, b| b.z.partial_cmp(&a.z).unwrap_or(std::cmp::Ordering::Equal));
            for f in overlays {
                let Some(r) = self.last_rects.get(&f.panel.id).copied() else {
                    continue;
                };
                if !r.contains(p) {
                    continue;
                }
                let next = self.tab_target(&f.panel, p, r).or_else(|| {
                    if drop_edge(p, r).is_some() {
                        None
                    } else {
                        Some(DropTarget::Tab {
                            panel: f.panel.id.clone(),
                            index: None,
                        })
                    }
                });
                return self.filter_target(d, next);
            }
        }

        // Docked views under the pointer (stable pre-preview regions).
        let mut hovered: Option<String> = None;
        if within {
            for id in leaf_ids(doc.root.as_ref()) {
                if id == d.lifted.id {
                    continue;
                }
                if d.drop_base.get(&id).is_some_and(|e| e.rect.contains(point)) {
                    hovered = Some(id);
                    break;
                }
            }
        }
        let hovered_node = hovered
            .as_ref()
            .and_then(|h| find_node(doc.root.as_ref(), h));
        // A collapsed group is one tile: views can dock beside it, not into it.
        let collapsed = hovered.as_ref().and_then(|h| self.collapsed_of.get(h));
        if let Some(collapsed) = collapsed {
            let edge = d
                .drop_base
                .get(collapsed)
                .and_then(|e| drop_edge(point, e.rect));
            next =
                edge.map(|edge| DropTarget::Dock(tile_drop_target(&d.drop_base, collapsed, edge)));
        } else if let (Some(hovered), Some(LayoutNode::Panel(node))) = (&hovered, hovered_node) {
            let world = d.drop_base[hovered].rect;
            let screen = self.panel_screen(world);
            next = match self.tab_target(node, p, screen) {
                Some(bar) => Some(bar),
                None => {
                    let edge = if float_move {
                        overlay_edge(p, screen)
                    } else {
                        drop_edge(point, world)
                    };
                    Some(match edge {
                        Some(edge) => {
                            DropTarget::Dock(tile_drop_target(&d.drop_base, hovered, edge))
                        }
                        None if float_move => DropTarget::Float,
                        None => DropTarget::Tab {
                            panel: hovered.clone(),
                            index: None,
                        },
                    })
                }
            };
        }

        // Visible seam gaps override overlapping tile-edge targets; the
        // nearest seam wins.
        let radius = self.pad().max(MIN_SEAM_HIT_WIDTH / 2.);
        let mut closest = radius;
        if within {
            for entry in d.drop_base.values() {
                let LayoutNode::Split(node) = &entry.node else {
                    continue;
                };
                if self.hidden_splits.contains(&node.id) {
                    continue;
                }
                let group = self.to_screen(entry.rect);
                if !group.contains(p) {
                    continue;
                }
                for (index, child) in node.children.iter().enumerate().skip(1) {
                    let r = self.to_screen(d.drop_base[child.id()].rect);
                    let distance = if node.axis == crate::model::Axis::X {
                        (p.x - r.x).abs()
                    } else {
                        (p.y - r.y).abs()
                    };
                    if distance >= closest {
                        continue;
                    }
                    let node_leaves = leaf_ids(Some(&entry.node));
                    if !node_leaves.iter().any(|leaf| *leaf != d.lifted.id) {
                        continue;
                    }
                    closest = distance;
                    next = Some(DropTarget::Dock(seam_target(node, index)));
                }
            }
        }

        // An empty stage is the desktop: its edges dock beside it, its
        // interior floats (or takes the view).
        if within
            && let Some(stage) = stage
            && stage.child.is_none()
            && closest == radius
            && let Some(world) = d.drop_base.get(&stage.id).map(|e| e.rect)
            && world.contains(point)
        {
            let s = self.panel_screen(world);
            let mut distances = [
                (Edge::Left, p.x - s.x),
                (Edge::Right, s.x + s.w - p.x),
                (Edge::Top, p.y - s.y),
                (Edge::Bottom, s.y + s.h - p.y),
            ];
            distances.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            let (edge, distance) = distances[0];
            let dimension = if edge.axis() == crate::model::Axis::X {
                s.w
            } else {
                s.h
            };
            let near_edge = distance <= DESKTOP_SPLIT_MAX_PX.min(dimension * 0.28);
            next = Some(if near_edge {
                DropTarget::Dock(tile_drop_target(&d.drop_base, &stage.id, edge))
            } else if stage_is_desktop {
                DropTarget::Float
            } else {
                DropTarget::Stage(stage.id.clone())
            });
        }

        // Over the desktop, a floating window's interior takes the view as a
        // tab.
        if next == Some(DropTarget::Float) && stage_is_desktop {
            let mut stage_floats: Vec<_> = doc
                .floating
                .iter()
                .filter(|f| f.layer == FloatingLayer::Stage)
                .collect();
            stage_floats.sort_by(|a, b| b.z.partial_cmp(&a.z).unwrap_or(std::cmp::Ordering::Equal));
            for f in stage_floats {
                if f.panel.id == d.lifted.id {
                    continue;
                }
                let Some(r) = self.float_world(&f.panel.id) else {
                    continue;
                };
                if !r.contains(point) {
                    continue;
                }
                let screen = self.last_rects.get(&f.panel.id).copied();
                next = screen
                    .and_then(|s| self.tab_target(&f.panel, p, s))
                    .or_else(|| {
                        if drop_edge(point, r).is_some() {
                            next.clone()
                        } else {
                            Some(DropTarget::Tab {
                                panel: f.panel.id.clone(),
                                index: None,
                            })
                        }
                    });
                break;
            }
        }

        // The outer frame band inserts around the framed group and takes
        // precedence over everything.
        let framed = self
            .nav
            .framed
            .as_ref()
            .and_then(|f| self.nav.entries.get(f))
            .map(|e| e.node.clone());
        if let Some(group) = framed.as_ref().or(doc.root.as_ref())
            && let Some(frame) =
                frame_drop_target(group, p, vw, vh, (self.pad() * 2.).max(MIN_SEAM_HIT_WIDTH))
            && leaf_ids(Some(group)).iter().any(|id| *id != d.lifted.id)
        {
            next = Some(DropTarget::Dock(frame));
        }

        // A torn-out tab can't regroup with its own host; a floating host
        // falls through to the desktop.
        if let Some(DropTarget::Tab { panel, .. }) = &next
            && Some(panel) == d.excluded_host.as_ref()
        {
            let host_float = doc
                .floating
                .iter()
                .find(|f| Some(&f.panel.id) == d.excluded_host.as_ref());
            next = host_float
                .filter(|f| f.layer == FloatingLayer::Stage)
                .map(|_| DropTarget::Float);
        }
        // Moving an overlay float over empty space, or a stage float over the
        // stage, keeps it floating.
        if next.is_none() && within && (overlay_move || stage_move) {
            next = Some(DropTarget::Float);
        }
        self.filter_target(d, next)
    }

    /// Tab-bar drops insert at an index.
    pub(super) fn tab_target(
        &self,
        panel: &PanelNode,
        p: Point,
        screen: Rect,
    ) -> Option<DropTarget> {
        let bar = self.bar_height(Some(panel));
        if bar == 0.
            || !(p.x >= screen.x
                && p.x <= screen.x + screen.w
                && p.y >= screen.y
                && p.y <= screen.y + bar)
        {
            return None;
        }
        let mut index = panel.views.len();
        if let Some(state) = self.panels.get(&panel.id) {
            for (i, view) in panel.views.iter().enumerate() {
                let Some((_, r)) = state.tabs.iter().find(|(v, _)| v == view) else {
                    continue;
                };
                if p.x < r.x + r.w / 2. {
                    index = i;
                    break;
                }
            }
        }
        Some(DropTarget::Tab {
            panel: panel.id.clone(),
            index: Some(index),
        })
    }

    pub(super) fn float_world(&self, panel_id: &str) -> Option<Rect> {
        let float = self.doc.floating.iter().find(|f| f.panel.id == panel_id)?;
        if float.layer != FloatingLayer::Stage {
            return None;
        }
        let s = self.stage_world();
        Some(Rect::new(
            s.x + float.rect.x * s.w,
            s.y + float.rect.y * s.h,
            float.rect.w * s.w,
            float.rect.h * s.h,
        ))
    }

    /// Allow rules remove targets; they never reroute a drop.
    pub(super) fn filter_target(
        &self,
        d: &DragSession,
        next: Option<DropTarget>,
    ) -> Option<DropTarget> {
        let next = next?;
        let views = &d.lifted.views;
        let doc = &d.pdoc;
        let stage = find_stage(doc.root.as_ref());
        let in_stage = |id: &str| {
            stage.is_some_and(|s| {
                s.child
                    .as_ref()
                    .is_some_and(|c| id != s.id && contains_node(c, id))
            })
        };
        let ok = match &next {
            DropTarget::Float => {
                self.floating_layer().is_some() && self.allowed(views, Region::Floating)
            }
            DropTarget::Stage(_) => self.allowed(views, Region::Stage),
            DropTarget::Tab { panel, .. } => {
                let float = doc.floating.iter().any(|f| f.panel.id == *panel);
                self.allowed(
                    views,
                    if float {
                        Region::Floating
                    } else if in_stage(panel) {
                        Region::Stage
                    } else {
                        Region::Side
                    },
                )
            }
            DropTarget::Dock(spec) => {
                let region = match &spec.seam {
                    Some(seam) => {
                        if !seam.leaves.is_empty()
                            && seam.leaves.iter().all(|id| in_stage(id))
                            && in_stage(&spec.id)
                        {
                            Region::Stage
                        } else {
                            Region::Side
                        }
                    }
                    None if in_stage(&spec.id) => Region::Stage,
                    None => Region::Side,
                };
                self.allowed(views, region)
            }
        };
        ok.then_some(next)
    }
}
