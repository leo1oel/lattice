// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/workspace.ts: open & place, close / hide / float), with Lattice's patch (a
// hidden tab's index).

//! Opening, placing, closing, hiding, restoring, floating and docking panels
//! and views.

use std::collections::HashMap;

use crate::model::{
    DockTarget, FloatingLayer, HiddenPanel, LayoutDocument, PanelNode, Params, Placement, Rect,
    RestoreTarget, ViewRecord, clamp_float, close_view, detach_view, find_node, find_stage,
    float_panel, hide_panel, insert_panel, locate_panel, panel_of_view, panels_of, raise_float,
    remove_panel, restore_panel, select_view, uid, view_ids,
};
use crate::runtime::motion::{DOCK_HIDE_MS, dock_ease};

use super::{DEFAULT_FLOAT_SIZE, Engine, Leaving, Region};

/// How `open` reuses an existing view.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Reuse {
    /// The type's `singleton` decides (`Type` when set, else `None`).
    #[default]
    Default,
    None,
    Type,
    Params,
}

#[derive(Clone, Debug, Default)]
pub struct OpenOptions {
    pub params: Option<Params>,
    pub id: Option<String>,
    pub title: Option<String>,
    pub placement: Option<Placement>,
    pub reuse: Reuse,
    /// `false` leaves the keyboard where it is.
    pub focus: Option<bool>,
    /// Animate the new panel out of this rect (workspace pixels).
    pub from: Option<Rect>,
}

impl Engine {
    pub(crate) fn cascade_rect(&mut self, layer: FloatingLayer) -> Rect {
        let c = self.float_container(layer);
        let w = DEFAULT_FLOAT_SIZE.0.min(c.w * 0.6);
        let h = DEFAULT_FLOAT_SIZE.1.min(c.h * 0.6);
        let step = (self.open_counter % 6) as f64 * 28.;
        self.open_counter += 1;
        clamp_float(Rect::new(
            (c.w * 0.5 - w / 2. + step - 70.) / c.w,
            (c.h * 0.45 - h / 2. + step - 50.) / c.h,
            w / c.w,
            h / c.h,
        ))
    }

    pub(crate) fn place_panel(
        &mut self,
        d: &LayoutDocument,
        panel: &PanelNode,
        placement: &Placement,
    ) -> LayoutDocument {
        let views = panel.views.clone();
        let stage = find_stage(d.root.as_ref()).cloned();
        let fl = self.floating_layer();
        let focused = self
            .focused_panel
            .clone()
            .filter(|id| locate_panel(d, id).is_some());
        let region_of_in = |id: &str| -> Region {
            if d.floating.iter().any(|f| f.panel.id == id) {
                return Region::Floating;
            }
            match &stage {
                Some(stage)
                    if find_node(Some(&crate::model::LayoutNode::Stage(stage.clone())), id)
                        .is_some() =>
                {
                    Region::Stage
                }
                _ => Region::Side,
            }
        };
        let mut tries = vec![placement.clone()];
        if *placement != Placement::Side {
            tries.push(Placement::Side);
        }
        for p in tries {
            match &p {
                Placement::Float | Placement::FloatAt { .. } => {
                    let Some(fl) = fl else { continue };
                    if !self.allowed(&views, Region::Floating) {
                        continue;
                    }
                    let (layer, rect) = match &p {
                        Placement::FloatAt { rect, layer } => (layer.unwrap_or(fl), *rect),
                        _ => (fl, self.cascade_rect(fl)),
                    };
                    return float_panel(d, panel, rect, layer);
                }
                Placement::Beside {
                    beside,
                    edge,
                    share,
                } => {
                    let target = find_node(d.root.as_ref(), beside).map(|_| beside.clone());
                    let region = match (&target, &stage) {
                        (Some(t), Some(stage))
                            if *t != stage.id
                                && find_node(
                                    Some(&crate::model::LayoutNode::Stage(stage.clone())),
                                    t,
                                )
                                .is_some() =>
                        {
                            Region::Stage
                        }
                        _ => Region::Side,
                    };
                    if !self.allowed(&views, region) {
                        continue;
                    }
                    let beside = target.unwrap_or_else(|| {
                        d.root
                            .as_ref()
                            .map(|r| r.id().to_string())
                            .unwrap_or_default()
                    });
                    return insert_panel(
                        d,
                        panel,
                        &DockTarget::Beside {
                            beside,
                            edge: *edge,
                            share: *share,
                        },
                    );
                }
                Placement::Into { into, index } => {
                    let loc = locate_panel(d, into);
                    let node = find_node(d.root.as_ref(), into);
                    let region = if node.is_some_and(|n| n.is_stage()) {
                        Region::Stage
                    } else if loc.is_some() {
                        region_of_in(into)
                    } else {
                        Region::Side
                    };
                    if !self.allowed(&views, region)
                        || (loc.is_none() && !node.is_some_and(|n| n.is_stage()))
                    {
                        continue;
                    }
                    return insert_panel(
                        d,
                        panel,
                        &DockTarget::Into {
                            into: into.clone(),
                            index: *index,
                        },
                    );
                }
                Placement::Stage => {
                    let Some(stage) = &stage else {
                        if let Some(f) = &focused
                            && self.allowed(&views, region_of_in(f))
                        {
                            return insert_panel(
                                d,
                                panel,
                                &DockTarget::Into {
                                    into: f.clone(),
                                    index: None,
                                },
                            );
                        }
                        continue;
                    };
                    if !self.allowed(&views, Region::Stage) {
                        continue;
                    }
                    let Some(child) = &stage.child else {
                        return insert_panel(
                            d,
                            panel,
                            &DockTarget::Into {
                                into: stage.id.clone(),
                                index: None,
                            },
                        );
                    };
                    let in_stage: Vec<String> = panels_of(Some(child))
                        .iter()
                        .map(|p| p.id.clone())
                        .collect();
                    let target = focused
                        .clone()
                        .filter(|f| in_stage.contains(f))
                        .or_else(|| {
                            self.last_stage_panel
                                .clone()
                                .filter(|l| in_stage.contains(l))
                        })
                        .unwrap_or_else(|| in_stage[0].clone());
                    return insert_panel(
                        d,
                        panel,
                        &DockTarget::Into {
                            into: target,
                            index: None,
                        },
                    );
                }
                Placement::Tab => {
                    if let Some(f) = &focused
                        && self.allowed(&views, region_of_in(f))
                    {
                        return insert_panel(
                            d,
                            panel,
                            &DockTarget::Into {
                                into: f.clone(),
                                index: None,
                            },
                        );
                    }
                    if stage.is_some() {
                        return self.place_panel(d, panel, &Placement::Stage);
                    }
                    continue;
                }
                Placement::Side => {
                    let Some(root) = &d.root else {
                        if self.allowed(&views, Region::Side) {
                            let mut out = d.clone();
                            out.root = Some(crate::model::LayoutNode::Panel(panel.clone()));
                            return out;
                        }
                        continue;
                    };
                    if !self.allowed(&views, Region::Side) {
                        break;
                    }
                    if let Some(stage) = &stage
                        && root.id() != stage.id
                    {
                        // Join the side area: dock beside the outermost side
                        // panel next to the stage.
                        return insert_panel(
                            d,
                            panel,
                            &DockTarget::Beside {
                                beside: stage.id.clone(),
                                edge: crate::model::Edge::Right,
                                share: Some(0.25),
                            },
                        );
                    }
                    return insert_panel(
                        d,
                        panel,
                        &DockTarget::Beside {
                            beside: root.id().to_string(),
                            edge: crate::model::Edge::Right,
                            share: Some(if stage.is_some() { 0.25 } else { 0.35 }),
                        },
                    );
                }
            }
        }
        // Nothing allowed: float if possible, else append beside root.
        if let (Some(fl), Some(_)) = (fl, &d.root) {
            let rect = self.cascade_rect(fl);
            return float_panel(d, panel, rect, fl);
        }
        match &d.root {
            Some(root) => insert_panel(
                d,
                panel,
                &DockTarget::Beside {
                    beside: root.id().to_string(),
                    edge: crate::model::Edge::Right,
                    share: None,
                },
            ),
            None => {
                let mut out = d.clone();
                out.root = Some(crate::model::LayoutNode::Panel(panel.clone()));
                out
            }
        }
    }

    fn default_placement(&self, kind: &str) -> Placement {
        if let Some(p) = self
            .options
            .types
            .get(kind)
            .and_then(|t| t.rules.placement.clone())
        {
            return p;
        }
        if find_stage(self.doc.root.as_ref()).is_some() {
            return Placement::Stage;
        }
        if self.focused_panel.is_some() {
            return Placement::Tab;
        }
        Placement::Side
    }

    /// Open a view of `kind`, or reveal the one it reuses. Returns its id.
    pub fn open(&mut self, kind: &str, o: OpenOptions) -> String {
        let singleton = self
            .options
            .types
            .get(kind)
            .is_some_and(|t| t.rules.singleton);
        let reuse = match o.reuse.clone() {
            Reuse::Default if singleton => Reuse::Type,
            Reuse::Default => Reuse::None,
            other => other,
        };
        let focus = o.focus != Some(false);
        if let Some(existing) = self.find_existing(kind, &o, &reuse) {
            self.reveal(&existing, focus);
            return existing;
        }
        if let Some(id) = &o.id
            && self.doc.views.contains_key(id)
        {
            let id = id.clone();
            self.reveal(&id, focus);
            return id;
        }
        let id = o.id.clone().unwrap_or_else(|| uid(kind));
        let mut with_record = self.doc.clone();
        with_record.views.insert(
            id.clone(),
            ViewRecord {
                kind: kind.to_string(),
                params: o.params.clone(),
                title: o.title.clone(),
            },
        );
        let panel = PanelNode::single(uid("panel"), id.clone());
        let placement = o
            .placement
            .clone()
            .unwrap_or_else(|| self.default_placement(kind));
        let next = self.place_panel(&with_record, &panel, &placement);
        let from = o.from.map(|r| HashMap::from([(panel.id.clone(), r)]));
        let flies = from.is_some();
        self.commit(next, true, from);
        if !flies && !self.reduced() {
            let now = self.now();
            self.appearing.insert(panel.id.clone(), now);
        }
        if focus {
            if let Some(target) = panel_of_view(&self.doc, &id).map(|p| p.id.clone())
                && self.doc.floating.iter().any(|f| f.panel.id == target)
            {
                let raised = raise_float(&self.doc, &target);
                self.commit_silent(raised);
            }
            self.focus_view(&id);
            self.ensure_framed_visible(&id);
        }
        id
    }

    fn find_existing(&self, kind: &str, o: &OpenOptions, reuse: &Reuse) -> Option<String> {
        if matches!(reuse, Reuse::None | Reuse::Default) {
            return None;
        }
        view_ids(&self.doc).into_iter().find(|id| {
            let record = &self.doc.views[id];
            record.kind == kind
                && match reuse {
                    Reuse::Type => true,
                    Reuse::Params => {
                        record.params.clone().unwrap_or_default() == o.params.clone().unwrap_or_default()
                    }
                    _ => false,
                }
        })
    }

    pub(crate) fn reveal(&mut self, view_id: &str, focus: bool) {
        let Some(panel) = panel_of_view(&self.doc, view_id).cloned() else {
            return;
        };
        if self.doc.hidden.iter().any(|h| h.panel.id == panel.id) {
            self.restore(&panel.id, None);
        }
        let mut next = select_view(&self.doc, view_id);
        if next.floating.iter().any(|f| f.panel.id == panel.id) {
            next = raise_float(&next, &panel.id);
        }
        self.commit(next, false, None);
        if focus {
            self.focus_view(view_id);
        }
        self.ensure_framed_visible(view_id);
    }

    pub(crate) fn ensure_framed_visible(&mut self, view_id: &str) {
        if let Some(panel) = panel_of_view(&self.doc, view_id).map(|p| p.id.clone()) {
            self.nav_ensure_visible(&panel);
        }
    }

    /// Bring a panel or view forward and give it the keyboard.
    pub fn focus(&mut self, id: &str) {
        let view_id = locate_panel(&self.doc, id)
            .map(|l| l.panel().selected.clone())
            .unwrap_or_else(|| id.to_string());
        if !self.doc.views.contains_key(&view_id) {
            return;
        }
        self.reveal(&view_id, true);
    }

    /// Select a view in its panel without focusing it.
    pub fn select(&mut self, view_id: &str) {
        let next = select_view(&self.doc, view_id);
        self.commit(next, false, None);
    }

    /// A tab clicked: select it and give its view the keyboard.
    pub fn select_and_focus(&mut self, view_id: &str) {
        let next = select_view(&self.doc, view_id);
        self.commit(next, false, None);
        self.focus_view(view_id);
    }

    /// Close a view. The host asks the view's close guard first (Trellis's
    /// `canClose`), unless forced.
    pub fn close(&mut self, view_id: &str) -> bool {
        if !self.doc.views.contains_key(view_id) {
            return false;
        }
        let next = close_view(&self.doc, view_id);
        self.commit(next, true, None);
        true
    }

    fn resolve_panel(&self, id: &str) -> Option<PanelNode> {
        locate_panel(&self.doc, id)
            .map(|l| l.panel().clone())
            .or_else(|| panel_of_view(&self.doc, id).cloned())
    }

    /// Hide a panel, or one view out of its panel, flying toward `toward`
    /// (workspace pixels) or, by default, down out of its own rect.
    pub fn hide(&mut self, id: &str, toward: Option<Rect>) {
        // A view that shares its panel is hidden on its own and restored into
        // the same panel, at its index (Lattice patch).
        let owner = if locate_panel(&self.doc, id).is_none() {
            panel_of_view(&self.doc, id).cloned()
        } else {
            None
        };
        if let Some(owner) = owner
            && owner.views.len() > 1
            && !self.doc.hidden.iter().any(|h| h.panel.id == owner.id)
        {
            let alone = PanelNode::single(uid("panel"), id);
            let detached = detach_view(&self.doc, id);
            if let Some(from) = self.last_rects.get(&owner.id).copied()
                && !self.reduced()
            {
                let now = self.now();
                self.leaving.insert(
                    alone.id.clone(),
                    Leaving {
                        panel: alone.clone(),
                        from,
                        to: toward_rect(toward, from),
                        start: now,
                        duration: DOCK_HIDE_MS,
                    },
                );
            }
            let index = owner.views.iter().position(|v| v == id);
            let mut next = detached;
            next.hidden.push(HiddenPanel {
                panel: alone,
                restore: RestoreTarget::Tab {
                    panel: owner.id.clone(),
                    index,
                },
            });
            self.commit(next, true, None);
            return;
        }
        let Some(panel) = self.resolve_panel(id) else {
            return;
        };
        if self.doc.hidden.iter().any(|h| h.panel.id == panel.id) {
            return;
        }
        let from = self
            .last_rects
            .get(&panel.id)
            .copied()
            .or_else(|| self.target_rect(&panel.id));
        let next = hide_panel(&self.doc, &panel.id);
        if let Some(from) = from
            && !self.reduced()
        {
            let now = self.now();
            self.leaving.insert(
                panel.id.clone(),
                Leaving {
                    panel: panel.clone(),
                    from,
                    to: toward_rect(toward, from),
                    start: now,
                    duration: DOCK_HIDE_MS,
                },
            );
        }
        self.commit(next, true, None);
    }

    /// Bring a hidden panel back where it was, flying out of `from` when
    /// given.
    pub fn restore(&mut self, panel_id: &str, from: Option<Rect>) {
        let Some(hidden) = self
            .doc
            .hidden
            .iter()
            .find(|h| h.panel.id == panel_id)
            .cloned()
        else {
            return;
        };
        self.leaving.remove(panel_id);
        let fl = self.floating_layer().unwrap_or(FloatingLayer::Overlay);
        let next = restore_panel(&self.doc, panel_id, fl);
        self.last_rects.remove(panel_id);
        if let Some(from) = from
            && !self.reduced()
        {
            let now = self.now();
            self.entering
                .insert(panel_id.to_string(), (toward_rect(Some(from), Rect::ZERO), now));
        }
        self.commit(next, true, None);
        // A panel back as itself fades in; a tab that rejoined a group just
        // shows there.
        if from.is_none() && !self.reduced() && locate_panel(&self.doc, panel_id).is_some() {
            let now = self.now();
            self.appearing.insert(panel_id.to_string(), now);
        }
        self.focus_view(&hidden.panel.selected);
    }

    /// Dock toggle: a float docks beside the stage (along its longer side)
    /// and the frame widens to show both; a docked window floats back at its
    /// remembered size.
    pub fn toggle_dock(&mut self, id: &str) {
        let Some(panel) = self.resolve_panel(id) else {
            return;
        };
        if self.doc.hidden.iter().any(|h| h.panel.id == panel.id) {
            return;
        }
        let stage = find_stage(self.doc.root.as_ref()).cloned();
        let float = self
            .doc
            .floating
            .iter()
            .find(|f| f.panel.id == panel.id)
            .cloned();
        let mut from = HashMap::new();
        if let Some(current) = self.last_rects.get(&panel.id) {
            from.insert(panel.id.clone(), *current);
        }
        let without = remove_panel(&self.doc, &panel.id);
        if let Some(float) = float {
            if !self.allowed(&panel.views, Region::Side) {
                return;
            }
            self.settling.insert(panel.id.clone());
            self.remembered_floats.insert(panel.id.clone(), float.rect);
            let s = self.stage_screen();
            let next = match &stage {
                Some(stage) if find_node(without.root.as_ref(), &stage.id).is_some() => {
                    insert_panel(
                        &without,
                        &panel,
                        &DockTarget::Beside {
                            beside: stage.id.clone(),
                            edge: if s.is_none_or(|s| s.w >= s.h) {
                                crate::model::Edge::Right
                            } else {
                                crate::model::Edge::Bottom
                            },
                            share: None,
                        },
                    )
                }
                _ => self.place_panel(&without, &panel, &Placement::Side),
            };
            self.commit(next, true, Some(from));
            let include = match &stage {
                Some(stage) => vec![stage.id.clone(), panel.id.clone()],
                None => vec![panel.id.clone()],
            };
            self.nav_include(&include);
        } else {
            let Some(layer) = self.floating_layer() else {
                return;
            };
            if !self.allowed(&panel.views, Region::Floating) {
                return;
            }
            self.settling.insert(panel.id.clone());
            let rect = match self.remembered_floats.get(&panel.id) {
                Some(rect) => *rect,
                None => self.cascade_rect(layer),
            };
            self.commit(float_panel(&without, &panel, rect, layer), true, Some(from));
            if let Some(stage) = stage {
                self.nav_include(&[stage.id]);
            }
        }
        self.focus_view(&panel.selected);
    }

    /// Float a panel (or one view out of its panel), at `rect` (fractions of
    /// its layer) or near where it is.
    pub fn float(&mut self, id: &str, rect: Option<Rect>) {
        let Some(fl) = self.floating_layer() else {
            return;
        };
        let loc = locate_panel(&self.doc, id);
        let mut d = self.doc.clone();
        let panel = match &loc {
            Some(loc) => loc.panel().clone(),
            None => {
                let Some(owner) = panel_of_view(&self.doc, id).cloned() else {
                    return;
                };
                if owner.views.len() > 1 {
                    d = detach_view(&self.doc, id);
                    PanelNode::single(uid("panel"), id)
                } else {
                    owner
                }
            }
        };
        if !self.allowed(&panel.views, Region::Floating) {
            return;
        }
        if locate_panel(&d, &panel.id).is_some_and(|l| l.is_floating()) && rect.is_none() {
            return;
        }
        let current = self.last_rects.get(&panel.id).copied().or_else(|| {
            loc.as_ref()
                .and_then(|l| self.last_rects.get(&l.panel().id).copied())
        });
        let target = match rect {
            Some(rect) => rect,
            None => {
                let base = match current {
                    Some(c) => c,
                    None => {
                        let cascade = self.cascade_rect(fl);
                        self.float_screen(cascade, fl)
                    }
                };
                let w = base.w.min(DEFAULT_FLOAT_SIZE.0);
                let h = base.h.min(DEFAULT_FLOAT_SIZE.1);
                self.screen_to_float(
                    Rect::new(
                        base.x + (base.w - w) / 2. + 24.,
                        base.y + (base.h - h) / 2. + 24.,
                        w,
                        h,
                    ),
                    fl,
                )
            }
        };
        let mut from = HashMap::new();
        if let Some(current) = current {
            from.insert(panel.id.clone(), current);
        }
        if locate_panel(&d, &panel.id).is_some() {
            d = remove_panel(&d, &panel.id);
        }
        self.commit(float_panel(&d, &panel, target, fl), true, Some(from));
    }

    /// Dock a panel (or one view out of its panel) beside a node, into a
    /// panel, or into the stage.
    pub fn dock(&mut self, id: &str, target: Option<DockTarget>) {
        let Some(mut panel) = self.resolve_panel(id) else {
            return;
        };
        let d = if locate_panel(&self.doc, id).is_none() && panel.views.len() > 1 {
            let d = detach_view(&self.doc, id);
            panel = PanelNode::single(uid("panel"), id);
            d
        } else {
            remove_panel(&self.doc, &panel.id)
        };
        let t = target.unwrap_or_else(|| DockTarget::Into {
            into: find_stage(d.root.as_ref())
                .map(|s| s.id.clone())
                .or_else(|| d.root.as_ref().map(|r| r.id().to_string()))
                .unwrap_or_default(),
            index: None,
        });
        let mut from = HashMap::new();
        if let Some(current) = self.last_rects.get(&panel.id) {
            from.insert(panel.id.clone(), *current);
        }
        if let DockTarget::Into { into, .. } = &t
            && find_node(d.root.as_ref(), into).is_none()
            && locate_panel(&d, into).is_none()
        {
            let next = self.place_panel(&d, &panel, &Placement::Side);
            self.commit(next, true, Some(from));
            return;
        }
        let next = if d.root.is_some() {
            insert_panel(&d, &panel, &t)
        } else {
            let mut out = d;
            out.root = Some(crate::model::LayoutNode::Panel(panel));
            out
        };
        self.commit(next, true, Some(from));
    }

    pub fn set_title(&mut self, view_id: &str, title: &str) {
        let Some(record) = self.doc.views.get_mut(view_id) else {
            return;
        };
        if record.title.as_deref() == Some(title) {
            return;
        }
        record.title = Some(title.to_string());
        self.events.push(super::Event::Change);
    }

    pub fn set_params(&mut self, view_id: &str, patch: Params) {
        let Some(record) = self.doc.views.get_mut(view_id) else {
            return;
        };
        let params = record.params.get_or_insert_with(Params::new);
        for (key, value) in patch {
            params.insert(key, value);
        }
        self.events.push(super::Event::Change);
    }

    /// The panels hidden, each with its views.
    pub fn hidden_panels(&self) -> Vec<&PanelNode> {
        self.doc.hidden.iter().map(|h| &h.panel).collect()
    }

    /// The opacity of a panel flying away or back, and its rect, at `now`.
    pub(crate) fn flying(&self, panel_id: &str, now: f64, target: Option<Rect>) -> Option<(Rect, f64)> {
        if let Some(l) = self.leaving.get(panel_id) {
            let e = dock_ease(((now - l.start) / l.duration).min(1.));
            return Some((crate::runtime::motion::lerp_rect(l.from, l.to, e), 1. - 0.9 * e));
        }
        if let Some((from, start)) = self.entering.get(panel_id) {
            let target = target?;
            let t = ((now - start) / crate::runtime::motion::DOCK_RESTORE_MS).min(1.);
            let e = dock_ease(t);
            return Some((crate::runtime::motion::lerp_rect(*from, target, e), 0.1 + 0.9 * e));
        }
        None
    }
}

/// Where a hidden panel flies: `toward`, else down out of its own rect.
pub(crate) fn toward_rect(toward: Option<Rect>, from: Rect) -> Rect {
    toward.unwrap_or(Rect::new(
        from.x + from.w * 0.25,
        from.y + from.h,
        from.w * 0.5,
        from.h * 0.1,
    ))
}
