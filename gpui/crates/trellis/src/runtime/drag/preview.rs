// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/drag.ts: settle, previews, pickup), with Lattice's patch (liftedRest).

//! The drag's preview: a candidate target settling into the target, the
//! layout reflowing around the drop slot, and the lifted panel's size.

use std::collections::HashMap;

use crate::model::{
    Edge, Entries, FloatingLayer, LayoutNode, PanelNode, Rect, apply_dock_target, drop_rects,
    find_node, find_stage, leaf_ids, remove_panel,
};

use super::super::engine::Engine;
use super::super::labels::{Label, label};
use super::{COMPACT, DROP_SLOT, DragSession, DropTarget, PICKUP_MS, SETTLE_MS, SOURCE_SLOT, same_target};

/// The world rects of the docked nodes at rest, with the source slot.
pub(super) fn resting_layout(d: &DragSession, engine: &Engine) -> HashMap<String, Rect> {
    let mut rects = d.base.clone();
    for (id, entry) in &d.drop_base {
        rects.insert(id.clone(), entry.rect);
    }
    if d.collapsed {
        rects.insert(SOURCE_SLOT.into(), collapsed_source(d, engine));
    } else if d.in_doc
        && d.from_float.is_none()
        && let Some(base) = d.base.get(&d.lifted.id)
    {
        rects.insert(SOURCE_SLOT.into(), *base);
    }
    rects
}

pub(super) fn collapsed_source(d: &DragSession, engine: &Engine) -> Rect {
    let rects = engine.layout_rects_of(d.origin.root.as_ref());
    let entry = rects.get(&d.lifted.id);
    let mut rect = d
        .base
        .get(&d.lifted.id)
        .copied()
        .or_else(|| entry.map(|e| e.rect))
        .unwrap_or_default();
    let parent = entry
        .and_then(|e| e.parent.as_ref())
        .and_then(|p| rects.get(p))
        .map(|e| &e.node);
    let Some(LayoutNode::Split(parent)) = parent else {
        rect.w = 0.;
        return rect;
    };
    let has_next = parent
        .children
        .iter()
        .position(|c| c.id() == d.lifted.id)
        .is_some_and(|i| i + 1 < parent.children.len());
    if parent.axis == crate::model::Axis::X {
        if !has_next {
            rect.x += rect.w;
        }
        rect.w = 0.;
    } else {
        if !has_next {
            rect.y += rect.h;
        }
        rect.h = 0.;
    }
    rect
}

pub(super) fn lifted_size(
    d: &DragSession,
    compact_amount: f64,
    desktop_amount: f64,
    min: (f64, f64),
    bar: f64,
    inset: f64,
) -> (f64, f64) {
    let original = d.source_screen;
    let target_scale = 1f64
        .min(COMPACT.0 / original.w.max(1.))
        .min(COMPACT.1 / original.h.max(1.));
    let scale = 1. + (target_scale - 1.) * compact_amount;
    let mut w = if d.from_frame {
        original.w + (COMPACT.0 - original.w) * compact_amount
    } else {
        original.w * scale
    };
    let mut h = if d.from_frame {
        original.h + (COMPACT.1 - original.h) * compact_amount
    } else {
        original.h * scale
    };
    w += (w.max(min.0 + inset * 2.) - w) * desktop_amount;
    h += (h.max(min.1 + bar + inset * 2.) - h) * desktop_amount;
    (w, h)
}

impl Engine {
    pub(super) fn settle(&mut self, next: Option<DropTarget>) {
        let now = self.now();
        let Some(d) = &mut self.drag else { return };
        if same_target(next.as_ref(), d.candidate.as_ref()) {
            return;
        }
        d.candidate = next.clone();
        d.target_timer = None;
        if same_target(next.as_ref(), d.target.as_ref()) {
            return;
        }
        d.target_timer = Some(now + SETTLE_MS);
    }

    /// Run the drag's timers; called each frame.
    pub(crate) fn step_drag(&mut self, now: f64) {
        let due = self
            .drag
            .as_ref()
            .and_then(|d| d.target_timer)
            .is_some_and(|at| now >= at);
        if due {
            let candidate = {
                let d = self.drag.as_mut().expect("checked");
                d.target_timer = None;
                d.candidate.clone()
            };
            self.apply_target(candidate);
        }
    }

    /// A seam slot grows from the seam's current position.
    pub(super) fn seam_origin(&self, d: &DragSession, preview: &Entries, slot: Rect) -> Rect {
        let parent = preview
            .get(DROP_SLOT)
            .and_then(|e| e.parent.as_ref())
            .and_then(|p| preview.get(p))
            .map(|e| &e.node);
        let collapsed_at_center = match parent {
            Some(LayoutNode::Split(s)) if s.axis == crate::model::Axis::Y => Rect {
                y: slot.y + slot.h / 2.,
                h: 0.,
                ..slot
            },
            _ => Rect {
                x: slot.x + slot.w / 2.,
                w: 0.,
                ..slot
            },
        };
        let Some(LayoutNode::Split(parent)) = parent else {
            return collapsed_at_center;
        };
        let index = parent
            .children
            .iter()
            .position(|c| c.id() == DROP_SLOT)
            .unwrap_or(0);
        let after = parent.children.get(index + 1);
        let before = index.checked_sub(1).and_then(|i| parent.children.get(i));
        let neighbour = match (after, before) {
            (Some(a), _) => self.current_world(d, a.id()),
            (None, Some(b)) => self.current_world(d, b.id()),
            _ => None,
        };
        let Some(n) = neighbour else {
            return collapsed_at_center;
        };
        if parent.axis == crate::model::Axis::X {
            let x = if after.is_some() { n.x } else { n.x + n.w };
            Rect { x, w: 0., ..slot }
        } else {
            let y = if after.is_some() { n.y } else { n.y + n.h };
            Rect { y, h: 0., ..slot }
        }
    }

    pub(super) fn world_of(&self, id: &str) -> Option<Rect> {
        self.from_screen_rect(self.last_rects.get(id).copied())
    }

    /// Where a node is on screen right now (world units): its own rect, or
    /// the union of its panels.
    pub(super) fn current_world(&self, d: &DragSession, id: &str) -> Option<Rect> {
        if let Some(own) = self.world_of(id) {
            return Some(own);
        }
        let rects: Vec<Rect> = find_node(d.pdoc.root.as_ref(), id)
            .map(|node| leaf_ids(Some(node)))
            .unwrap_or_default()
            .iter()
            .filter_map(|leaf| self.world_of(leaf))
            .collect();
        if rects.is_empty() {
            return d.drop_base.get(id).map(|e| e.rect);
        }
        let x = rects.iter().map(|r| r.x).fold(f64::INFINITY, f64::min);
        let y = rects.iter().map(|r| r.y).fold(f64::INFINITY, f64::min);
        let r = rects.iter().map(|r| r.x + r.w).fold(f64::NEG_INFINITY, f64::max);
        let b = rects.iter().map(|r| r.y + r.h).fold(f64::NEG_INFINITY, f64::max);
        Some(Rect::new(x, y, r - x, b - y))
    }

    pub(super) fn apply_target(&mut self, next: Option<DropTarget>) {
        let Some(mut d) = self.drag.take() else { return };
        if same_target(next.as_ref(), d.target.as_ref()) {
            self.drag = Some(d);
            return;
        }
        let mut previous = self.last_rects.clone();
        let parent = self
            .layout_rects_of(d.origin.root.as_ref())
            .get(&d.lifted.id)
            .and_then(|e| e.parent.clone());
        if next.is_some() && d.in_doc && d.from_float.is_none() && !d.collapsed && parent.is_some() {
            // Latch removal on the first target; leaving it never reopens the
            // source.
            d.collapsed = true;
            d.pdoc = remove_panel(&d.pdoc, &d.lifted.id);
            d.drop_base = self.layout_rects_of(d.pdoc.root.as_ref());
        }
        d.layout_targets = resting_layout(&d, self);
        d.drop_label = String::new();
        match &next {
            Some(DropTarget::Tab { panel, .. }) => {
                let world = d
                    .drop_base
                    .get(panel)
                    .map(|e| e.rect)
                    .or_else(|| self.float_world(panel))
                    .or_else(|| self.world_of(panel));
                match world {
                    Some(world) => {
                        d.layout_targets.insert(DROP_SLOT.into(), world);
                        previous.insert(DROP_SLOT.into(), self.panel_screen(world));
                    }
                    None => {
                        if let Some(screen) = self.last_rects.get(panel).copied() {
                            if let Some(world) = self.from_screen_rect(Some(screen)) {
                                d.layout_targets.insert(DROP_SLOT.into(), world);
                            }
                            previous.insert(DROP_SLOT.into(), screen);
                        }
                    }
                }
                d.drop_label = label(Label::AddAsTab);
            }
            Some(DropTarget::Stage(stage)) => {
                let world = d.drop_base[stage].rect;
                d.layout_targets.insert(DROP_SLOT.into(), world);
                let center = Rect::new(world.x + world.w / 2., world.y + world.h / 2., 0., 0.);
                previous.insert(DROP_SLOT.into(), self.panel_screen(center));
            }
            Some(DropTarget::Dock(spec)) => {
                let placeholder = LayoutNode::Panel(PanelNode::single(DROP_SLOT, DROP_SLOT));
                if spec.seam.is_some() || !d.drop_base.contains_key(&spec.id) {
                    let preview_root = apply_dock_target(
                        d.pdoc.root.as_ref(),
                        spec,
                        &placeholder,
                        "__trellis-seam-preview",
                    );
                    let preview = self.layout_rects_of(Some(&preview_root));
                    for (id, entry) in &preview {
                        d.layout_targets.insert(id.clone(), entry.rect);
                    }
                    if let Some(slot) = preview.get(DROP_SLOT).map(|e| e.rect) {
                        let origin = self.seam_origin(&d, &preview, slot);
                        previous.insert(DROP_SLOT.into(), self.panel_screen(origin));
                    }
                } else {
                    let r = drop_rects(d.drop_base[&spec.id].rect, spec.edge);
                    d.layout_targets.insert(spec.id.clone(), r.remaining);
                    d.layout_targets.insert(DROP_SLOT.into(), r.slot);
                    // Grow from the target's edge where it is now, even if
                    // the target is still moving.
                    let collapsed = match self.current_world(&d, &spec.id) {
                        Some(current) => drop_rects(current, spec.edge).collapsed,
                        None => r.collapsed,
                    };
                    previous.insert(DROP_SLOT.into(), self.panel_screen(collapsed));
                }
            }
            Some(DropTarget::Float) => {}
            None => {
                // Leaving a target for nowhere collapses its slot; moving onto
                // the desktop just lets it fade where it is.
                if let Some(target) = &d.target
                    && *target != DropTarget::Float
                    && let Some(world) = self.from_screen_rect(previous.get(DROP_SLOT).copied())
                {
                    let edge = match target {
                        DropTarget::Dock(spec) => spec.edge,
                        _ => Edge::Left,
                    };
                    let collapsed = if edge.axis() == crate::model::Axis::X {
                        Rect {
                            x: world.x + world.w / 2.,
                            w: 0.,
                            ..world
                        }
                    } else {
                        Rect {
                            y: world.y + world.h / 2.,
                            h: 0.,
                            ..world
                        }
                    };
                    d.layout_targets.insert(DROP_SLOT.into(), collapsed);
                }
            }
        }
        if d.collapsed
            && !previous.contains_key(SOURCE_SLOT)
            && let Some(base) = d.base.get(&d.lifted.id)
        {
            previous.insert(SOURCE_SLOT.into(), self.panel_screen(*base));
        }
        d.target = next;
        self.drag = Some(d);
        if !self.reduced() {
            let now = self.now();
            self.tween.begin(previous, now);
        }
    }

    /// The lifted window's screen rect: full size over its origin, a compact
    /// card elsewhere. Called once a frame.
    pub(crate) fn lifted_rect(&mut self) -> Option<Rect> {
        let now = self.now();
        let reduced = self.reduced();
        let desktop = {
            let d = self.drag.as_ref().filter(|d| d.active)?;
            let stage = find_stage(d.pdoc.root.as_ref());
            stage
                .filter(|s| s.child.is_none())
                .filter(|_| self.floating_layer() == Some(FloatingLayer::Stage))
                .and_then(|s| d.drop_base.get(&s.id))
                .map(|e| self.panel_screen(e.rect))
        };
        let full_viewport = Rect::new(0., 0., self.viewport.0, self.viewport.1);
        let min = {
            let d = self.drag.as_ref().expect("active");
            self.min_size_for(&d.lifted.views)
        };
        let bar = {
            let d = self.drag.as_ref().expect("active");
            self.bar_height(Some(&d.lifted))
        };
        let inset = self.pad();
        let d = self.drag.as_mut().expect("active");
        let original = d.source_screen;
        let source = if d.collapsed {
            None
        } else if let Some(origin) = d.tab_origin {
            Some(origin)
        } else if d.from_float.is_some() && !d.from_frame {
            Some(desktop.unwrap_or(if d.from_float == Some(FloatingLayer::Overlay) {
                full_viewport
            } else {
                original
            }))
        } else {
            Some(original)
        };
        let amount = if reduced {
            1.
        } else {
            1. - (-(now - d.size_tick) / 60.).exp()
        };
        d.size_tick = now;
        d.desktop_to = if desktop.is_some_and(|desk| desk.contains(d.pointer)) {
            1.
        } else {
            0.
        };
        d.desktop_amount += (d.desktop_to - d.desktop_amount) * amount;
        let compact_to = if source.is_some_and(|s| s.contains(d.pointer))
            || (!d.from_frame && desktop.is_some_and(|desk| desk.contains(d.pointer)))
        {
            0.
        } else {
            1.
        };
        if compact_to != d.compact_to {
            d.compact_from = d.compact_amount;
            d.compact_to = compact_to;
            d.pickup_at = now;
        }
        let progress = if reduced {
            1.
        } else {
            ((now - d.pickup_at) / PICKUP_MS).min(1.)
        };
        let eased = 1. - (1. - progress).powi(3);
        d.compact_amount = d.compact_from + (d.compact_to - d.compact_from) * eased;
        let (w, h) = lifted_size(d, d.compact_amount, d.desktop_amount, min, bar, inset);
        let grab_y = d.grab_y + (d.grab_y.min(18.) - d.grab_y) * d.compact_amount;
        d.floating = Rect::new(d.pointer.x - w * d.grab_x, d.pointer.y - grab_y, w, h);
        Some(d.floating)
    }

    /// The size the lifted panel is easing to, for its view to lay out at
    /// once.
    pub(crate) fn lifted_rest(&self) -> Option<(f64, f64)> {
        let d = self.drag.as_ref().filter(|d| d.active)?;
        let min = self.min_size_for(&d.lifted.views);
        let bar = self.bar_height(Some(&d.lifted));
        Some(lifted_size(d, d.compact_to, d.desktop_to, min, bar, self.pad()))
    }

    /// The content minimum a lifted window grows to over the desktop.
    pub(super) fn min_size_for(&self, views: &[String]) -> (f64, f64) {
        views.iter().fold((0., 0.), |(w, h), id| {
            let min = self.min_size_of(id).unwrap_or((0., 0.));
            (w.max(min.0), h.max(min.1))
        })
    }
}
