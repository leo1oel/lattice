// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/workspace.ts: render loop, render, placeSurface, renderDividers, renderSlots,
// collapsed groups), with Lattice's patch (fitHeader, the held layouts of reflowOf/placeSurface).

//! One frame of the workspace: where every panel, tab, view, divider and
//! drag slot is drawn, as data for the host to draw.

use std::collections::HashMap;

use crate::model::{
    Axis, LayoutNode, PanelNode, Rect, TabbarMode, find_stage, panel_of_view,
    panels_of,
};
use crate::runtime::drag::{DROP_SLOT, SORT_SETTLE_MS, SOURCE_SLOT};
use crate::runtime::header::{HeaderMeasure, HeaderTools, plan_header};
use crate::runtime::motion::{APPEAR_MS, cubic_bezier};

use super::dividers::ResizeKind;
use super::{Badge, Engine, FRAME_ONLY, Region, ViewPlacement};

#[derive(Clone, Debug, PartialEq)]
pub struct TabFrame {
    pub view_id: String,
    pub title: String,
    pub selected: bool,
    pub focused: bool,
    pub closable: bool,
    pub badge: Option<Badge>,
    /// A named panel's tab (a singleton's): its whole name or only its icon,
    /// never an ellipsis.
    pub atomic: bool,
    pub icon_only: bool,
    /// Offset from its place in the strip (a tab being sorted or settling).
    pub offset: f64,
    /// The tab being sorted, following the pointer.
    pub sorting: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceFrame {
    pub view_id: String,
    /// Where the view's content is, below the tab bar.
    pub body: Rect,
    /// Selected and not concealed by the frame-only icon.
    pub shown: bool,
    pub opacity: f64,
    pub clip: Option<Rect>,
    /// The size the content lays out at, and the scale that maps it onto
    /// `body` (content scaled below its minimum, or held during motion).
    pub layout: (f64, f64),
    pub scale: f64,
    pub interactive: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HeaderFrame {
    pub tools: HeaderTools,
    /// The other tabs' minimum width while short of room.
    pub tab_min: Option<f64>,
    /// Labels ease (the selection moved them, or new room opened one).
    pub label_motion: bool,
    /// A divider's rubber band takes this much from the tabs.
    pub squeeze: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PanelFrame {
    pub id: String,
    pub rect: Rect,
    pub opacity: f64,
    pub z: f64,
    pub lifted: bool,
    pub floating: bool,
    pub region: Region,
    pub focused: bool,
    pub framed: bool,
    pub frame_only: bool,
    pub frame_icon_size: f64,
    pub compact: bool,
    pub bar: TabbarMode,
    pub bar_height: f64,
    pub clip: Option<Rect>,
    /// A new panel's entrance: 0 → 1.
    pub appear: Option<f64>,
    pub selected: String,
    pub tabs: Vec<TabFrame>,
    pub header: HeaderFrame,
    pub surfaces: Vec<SurfaceFrame>,
    /// A floating panel's eight resize handles.
    pub handles: bool,
    /// Flying out to be hidden or back from it.
    pub flying: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DividerFrame {
    pub split_id: String,
    pub index: usize,
    pub axis: Axis,
    pub rect: Rect,
    pub active: bool,
    /// Where the boundary stands, 0–100.
    pub value: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GroupFrame {
    pub id: String,
    pub rect: Rect,
    pub count: usize,
    /// Its outline's lines, in fractions of the tile: (axis, at, from, to).
    pub lines: Vec<(Axis, f64, f64, f64)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MarqueeFrame {
    pub rect: Rect,
    pub target: Option<(Rect, String)>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Frame {
    /// In paint order (lowest first).
    pub panels: Vec<PanelFrame>,
    pub dividers: Vec<DividerFrame>,
    pub groups: Vec<GroupFrame>,
    pub source_slot: Option<Rect>,
    pub drop_slot: Option<Rect>,
    pub drop_label: String,
    pub snap: Option<Rect>,
    pub marquee: Option<MarqueeFrame>,
    /// Nothing at all in the workspace.
    pub empty: bool,
    pub stage: Option<Rect>,
    pub stage_empty: bool,
    pub dragging: bool,
    pub drop_kind: Option<&'static str>,
    pub resizing: Option<ResizeKind>,
    /// A drag or gesture holds the pointer: content ignores it.
    pub busy: bool,
}

/// What the host measures a panel's header from.
pub struct HeaderInput<'a> {
    pub panel: &'a PanelNode,
    /// Each tab: its view, title, whether it is a named (atomic) tab, and
    /// whether it has a close button.
    pub tabs: Vec<(String, String, bool, bool)>,
}

/// The host's measurement of a panel's header.
pub type MeasureHeader<'a> = dyn FnMut(&HeaderInput) -> Option<HeaderMeasure> + 'a;

impl Engine {
    /// Advance every animation to `now`, then lay out one frame.
    pub fn frame(&mut self, measure: &mut MeasureHeader) -> Frame {
        let now = self.now();
        self.tick(now);
        self.render(now, measure)
    }

    fn tick(&mut self, now: f64) {
        let dt = if self.last_time > 0. {
            (now - self.last_time) / 1000.
        } else {
            0.016
        };
        self.last_time = now;
        if self.camera.moving() && !self.gesture {
            if self.reduced() {
                self.camera.finish();
            } else {
                self.camera.step(dt);
            }
        }
        if self.tween.active() {
            self.tween.step(now);
        }
        if !self.tween.active() {
            self.settling.clear();
            self.dropping = false;
        }
        let done: Vec<String> = self
            .leaving
            .iter()
            .filter(|(_, l)| now - l.start >= l.duration)
            .map(|(id, _)| id.clone())
            .collect();
        for id in done {
            self.leaving.remove(&id);
            self.panels.remove(&id);
            self.last_rects.remove(&id);
            self.sync();
        }
        self.appearing.retain(|_, start| now - *start < APPEAR_MS);
        self.tab_flips.retain(|_, f| now - f.start < SORT_SETTLE_MS);
        self.step_drag(now);
        self.step_navigation(now);
        self.step_divider_spring(now);
        if !self.moving() {
            self.last_time = 0.;
        }
    }

    fn render(&mut self, now: f64, measure: &mut MeasureHeader) -> Frame {
        self.compute_collapsed();
        let moving = self.moving();
        let round = !moving;
        let stage = find_stage(self.doc.root.as_ref()).cloned();
        // While dragging, the stage follows the preview like any docked node.
        let stage_preview = stage
            .as_ref()
            .and_then(|s| self.layout_targets().and_then(|t| t.get(&s.id)).copied());
        let s_screen = match stage_preview {
            Some(p) => Some(self.panel_screen(p)),
            None => self.stage_screen(),
        };
        let mut frame = Frame {
            empty: self.doc.root.is_none() && self.doc.floating.is_empty() && self.lifted().is_none(),
            dragging: self.drag_active(),
            drop_kind: self.drop_kind(),
            resizing: self.resizing(),
            busy: self.drag_active() || self.gesture,
            ..Default::default()
        };
        if let (Some(stage), Some(s)) = (&stage, s_screen) {
            let r = self.tween.apply(&stage.id, s);
            self.last_rects.insert(stage.id.clone(), r);
            frame.stage = Some(r);
            frame.stage_empty = stage.child.is_none();
        }

        // z ordering
        let mut z_of: HashMap<String, f64> = HashMap::new();
        for p in panels_of(self.doc.root.as_ref()) {
            z_of.insert(p.id.clone(), if self.settling.contains(&p.id) { 2900. } else { 10. });
        }
        let mut stage_floats: Vec<_> = self
            .doc
            .floating
            .iter()
            .filter(|f| f.layer == crate::model::FloatingLayer::Stage)
            .collect();
        stage_floats.sort_by(|a, b| a.z.partial_cmp(&b.z).unwrap_or(std::cmp::Ordering::Equal));
        let mut overlay_floats: Vec<_> = self
            .doc
            .floating
            .iter()
            .filter(|f| f.layer == crate::model::FloatingLayer::Overlay)
            .collect();
        overlay_floats.sort_by(|a, b| a.z.partial_cmp(&b.z).unwrap_or(std::cmp::Ordering::Equal));
        for (i, f) in stage_floats.iter().enumerate() {
            let z = if self.settling.contains(&f.panel.id) { 2900. } else { 30. + i as f64 * 3. };
            z_of.insert(f.panel.id.clone(), z);
        }
        for (i, f) in overlay_floats.iter().enumerate() {
            let z = if self.settling.contains(&f.panel.id) { 2900. } else { 1000. + i as f64 * 3. };
            z_of.insert(f.panel.id.clone(), z);
        }
        if let Some(l) = self.lifted() {
            z_of.insert(l.id.clone(), 3100.);
        }
        for id in self.leaving.keys() {
            z_of.insert(id.clone(), 2950.);
        }

        let lifted_rect = self.lifted_rect();
        let panel_ids: Vec<String> = self.panels.keys().cloned().collect();
        let mut shown_views = Vec::new();
        for panel_id in panel_ids {
            let Some(panel) = self.find_panel(&panel_id) else {
                continue;
            };
            let lifted = self.lifted().is_some_and(|l| l.id == panel_id);
            let target = if lifted {
                lifted_rect
            } else {
                self.target_rect(&panel_id)
            };
            let flying = self.flying(&panel_id, now, target);
            let (r, opacity) = match flying {
                Some(f) => f,
                None => {
                    let Some(target) = target else { continue };
                    (if lifted { target } else { self.tween.apply(&panel_id, target) }, 1.)
                }
            };
            if self.entering.get(&panel_id).is_some_and(|(_, start)| {
                now - start >= crate::runtime::motion::DOCK_RESTORE_MS
            }) {
                self.entering.remove(&panel_id);
            }
            self.last_rects.insert(panel_id.clone(), r);
            // Inside a collapsed group: the group's tile stands in for it.
            if self.collapsed_of.contains_key(&panel_id) && !self.leaving.contains_key(&panel_id) {
                continue;
            }
            let onscreen = self.in_view(r) && r.w > 2. && r.h > 2.;
            if !onscreen {
                continue;
            }
            let float = self.doc.floating.iter().find(|f| f.panel.id == panel_id).cloned();
            let clip = match (&float, s_screen) {
                (Some(f), Some(s)) if f.layer == crate::model::FloatingLayer::Stage && !lifted => {
                    clip_inset(r, s)
                }
                _ => None,
            };
            let bar_mode = self.bar_mode(Some(&panel));
            let bar = if bar_mode == TabbarMode::Always {
                self.tabbar_height()
            } else {
                0.
            };
            // Too small to use: show only the app icon; the whole frame is a
            // drag handle.
            let frame_only = !lifted
                && (r.w < FRAME_ONLY.0
                    || r.h < FRAME_ONLY.1 + if panel.views.len() > 1 { self.tabbar_height() } else { 0. });
            let compact = r.w < 140. || r.h < bar + 24.;
            let squeeze = self.squeeze_of(&panel_id);
            let loose = panel.views.iter().filter(|v| !self.rules_of(v).singleton).count();
            let header = self.fit_header(&panel, r.w, if loose > 0 { squeeze } else { 0. }, compact || frame_only, measure);
            if let Some(state) = self.panels.get_mut(&panel_id) {
                state.frame_only = frame_only;
            }
            let body = Rect::new(r.x, r.y + bar, r.w, (r.h - bar).max(0.));
            let reflow = self.reflow_of(&panel_id, flying.is_some(), bar);
            let z = z_of.get(&panel_id).copied().unwrap_or(10.);
            let mut surfaces = Vec::new();
            for view_id in &panel.views {
                if !self.surfaces.contains_key(view_id) {
                    continue;
                }
                shown_views.push(view_id.clone());
                let selected = panel.selected == *view_id;
                surfaces.push(self.place_surface(
                    view_id,
                    &panel,
                    body,
                    selected,
                    round,
                    opacity,
                    clip.and_then(|_| s_screen.and_then(|s| clip_inset(body, s))),
                    frame_only,
                    reflow,
                ));
            }
            let labels = self
                .panels
                .get(&panel_id)
                .and_then(|s| s.labels.clone());
            let sort = self.tab_sort_offsets(&panel_id).map(|(o, d)| (o.clone(), d.to_string()));
            let tabs = panel
                .views
                .iter()
                .map(|view_id| {
                    let rules = self.rules_of(view_id);
                    let offset = match &sort {
                        Some((offsets, _)) => offsets.get(view_id).copied().unwrap_or(0.),
                        None => self.tab_flips.get(view_id).map_or(0., |f| {
                            let t = ((now - f.start) / SORT_SETTLE_MS).min(1.);
                            f.from * (1. - cubic_bezier(0.2, 0.8, 0.2, 1.)(t))
                        }),
                    };
                    TabFrame {
                        view_id: view_id.clone(),
                        title: self.title_of(view_id),
                        selected: panel.selected == *view_id,
                        focused: self.focused_view.as_deref() == Some(view_id),
                        closable: rules.closable,
                        badge: self.badges.get(view_id).cloned(),
                        atomic: rules.singleton,
                        icon_only: rules.singleton
                            && labels.as_ref().is_some_and(|l| !l.contains(view_id)),
                        offset,
                        sorting: sort.as_ref().is_some_and(|(_, d)| d == view_id),
                    }
                })
                .collect();
            frame.panels.push(PanelFrame {
                id: panel_id.clone(),
                rect: snap(r, round),
                opacity,
                z,
                lifted,
                floating: float.is_some() || lifted,
                region: if float.is_some() || lifted {
                    Region::Floating
                } else {
                    self.region_of(&panel_id)
                },
                focused: self.focused_panel.as_deref() == Some(panel_id.as_str()),
                framed: self.nav.framed.as_deref() == Some(panel_id.as_str()),
                frame_only,
                frame_icon_size: 40f64.min(r.w - 12.).min(r.h - 12.).max(0.),
                compact,
                bar: bar_mode,
                bar_height: bar,
                clip,
                appear: self
                    .appearing
                    .get(&panel_id)
                    .map(|start| ((now - start) / APPEAR_MS).clamp(0., 1.)),
                selected: panel.selected.clone(),
                tabs,
                header: HeaderFrame {
                    squeeze: if loose > 0 { squeeze } else { 0. },
                    ..header
                },
                surfaces,
                handles: float.is_some() && !lifted && !frame_only,
                flying: flying.is_some(),
            });
        }
        // Views with no visible panel (hidden panels, offscreen).
        let views: Vec<String> = self.surfaces.keys().cloned().collect();
        for view_id in views {
            if shown_views.contains(&view_id) {
                continue;
            }
            let panel = panel_of_view(&self.doc, &view_id).cloned();
            let hidden = panel
                .as_ref()
                .is_some_and(|p| self.doc.hidden.iter().any(|h| h.panel.id == p.id));
            let placement = if hidden {
                ViewPlacement::Hidden
            } else {
                self.placement_of(&view_id)
            };
            let focused = self.focused_view.as_deref() == Some(view_id.as_str());
            if let Some(surface) = self.surfaces.get_mut(&view_id) {
                surface.state.visible = false;
                surface.state.selected = panel.as_ref().is_some_and(|p| p.selected == view_id);
                surface.state.placement = placement;
                surface.state.focused = focused;
                if let Some(p) = &panel {
                    surface.state.panel_id = p.id.clone();
                }
            }
        }
        frame
            .panels
            .sort_by(|a, b| a.z.partial_cmp(&b.z).unwrap_or(std::cmp::Ordering::Equal));
        frame.dividers = self.render_dividers();
        frame.groups = self.render_groups();
        self.render_slots(&mut frame);
        frame.snap = self.nav.snap;
        frame.marquee = self.nav.marquee.as_ref().map(|m| {
            let viewport = Rect::new(0., 0., self.viewport.0, self.viewport.1);
            let world = crate::model::rectangle_camera(m.start, m.current, viewport, m.view);
            MarqueeFrame {
                rect: self.to_screen(world),
                target: m.candidate.as_ref().and_then(|c| {
                    let entry = self.nav.entries.get(c)?;
                    Some((self.panel_screen(entry.rect), self.node_title(&entry.node)))
                }),
            }
        });
        frame
    }

    /// Whether any whole pixel of a screen rect is in view.
    pub(super) fn in_view(&self, r: Rect) -> bool {
        r.x < self.viewport.0 - 1. && r.y < self.viewport.1 - 1. && r.x + r.w > 1. && r.y + r.h > 1.
    }

    /// Lattice patch: fit a panel's header to the panel (see
    /// [`plan_header`]).
    fn fit_header(
        &mut self,
        panel: &PanelNode,
        width: f64,
        squeeze: f64,
        unmeasurable: bool,
        measure: &mut MeasureHeader,
    ) -> HeaderFrame {
        let roomy = HeaderFrame {
            tools: HeaderTools::Full,
            tab_min: None,
            label_motion: false,
            squeeze: 0.,
        };
        let held = self.drag_active() || self.dropping;
        let input = HeaderInput {
            panel,
            tabs: panel
                .views
                .iter()
                .map(|v| {
                    let rules = self.rules_of(v);
                    (v.clone(), self.title_of(v), rules.singleton, rules.closable)
                })
                .collect(),
        };
        let has = self.panels.get(&panel.id).is_some_and(|s| s.header.is_some());
        if !unmeasurable && !(held && has)
            && let Some(measured) = measure(&input)
            && let Some(state) = self.panels.get_mut(&panel.id)
        {
            state.header = Some(measured);
        }
        let Some(state) = self.panels.get_mut(&panel.id) else {
            return roomy;
        };
        let Some(header) = state.header.clone() else {
            return roomy;
        };
        let plan = plan_header(&header, width, squeeze, Some(&panel.selected), state.label_mode);
        state.label_mode = Some(plan.label_mode);
        // The labels follow the selected tab. They ease when another tab is
        // selected or a label opens into new room; one that gives way
        // because the panel narrowed goes at once.
        let switched = state
            .label_selected
            .as_ref()
            .is_some_and(|s| *s != panel.selected);
        state.label_selected = Some(panel.selected.clone());
        if state.labels.as_ref() != Some(&plan.labels) {
            state.label_motion =
                state.labels.is_some() && (switched || plan.labelled > state.label_count);
            state.labels = Some(plan.labels.clone());
            state.label_count = plan.labelled;
        }
        let label_motion = state.label_motion;
        let changed = state.header_min.is_none_or(|m| (plan.min - m).abs() > 0.5);
        if changed {
            state.header_min = Some(plan.min);
        }
        if changed {
            self.entries = self.layout_doc(None);
            // Header measurements redistribute panels. Keep framing on that
            // same geometry.
            self.nav_sync();
        }
        HeaderFrame {
            tools: plan.tools,
            tab_min: plan.tab_min,
            label_motion,
            squeeze,
        }
    }

    fn render_dividers(&self) -> Vec<DividerFrame> {
        let held = self.dividers.active.clone();
        let show = !self.tween.active() && !self.drag_active() && !self.gesture;
        let mut out = Vec::new();
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
            stack.extend(split.children.iter());
            for index in 0..split.children.len() - 1 {
                let active = held.as_ref().is_some_and(|(id, i)| *id == split.id && *i == index);
                let Some(effective) = self.effective_split(&split.id) else {
                    continue;
                };
                let Some(e) = self.entries.get(&split.id) else {
                    continue;
                };
                if (!show && !active) || self.hidden_splits.contains(&split.id) {
                    continue;
                }
                let r = self.to_screen(e.rect);
                let total: f64 = effective.weights.iter().sum();
                let boundary = effective.weights[..=index].iter().sum::<f64>() / total;
                let size = 8f64.max(self.gap() + 4.);
                let rect = if effective.axis == Axis::X {
                    Rect::new(r.x + r.w * boundary - size / 2., r.y + self.pad(), size, r.h - self.gap())
                } else {
                    Rect::new(r.x + self.pad(), r.y + r.h * boundary - size / 2., r.w - self.gap(), size)
                };
                let visible = rect.x < self.viewport.0
                    && rect.y < self.viewport.1
                    && rect.x + rect.w > 0.
                    && rect.y + rect.h > 0.;
                if !visible {
                    continue;
                }
                out.push(DividerFrame {
                    split_id: split.id.clone(),
                    index,
                    axis: effective.axis,
                    rect,
                    active,
                    value: (boundary * 100.).round(),
                });
            }
        }
        out
    }

    /// The drag's source and destination slots, animated with the layout.
    fn render_slots(&mut self, frame: &mut Frame) {
        let targets = self.layout_targets().cloned();
        for id in [SOURCE_SLOT, DROP_SLOT] {
            let Some(world) = targets.as_ref().and_then(|t| t.get(id)).copied() else {
                self.last_rects.remove(id);
                continue;
            };
            let r = self.tween.apply(id, self.panel_screen(world));
            self.last_rects.insert(id.to_string(), r);
            if r.w > 8. && r.h > 8. {
                if id == SOURCE_SLOT {
                    frame.source_slot = Some(r);
                } else {
                    frame.drop_slot = Some(r);
                }
            }
        }
        frame.drop_label = self.drop_label().to_string();
    }

}

fn clip_inset(r: Rect, bounds: Rect) -> Option<Rect> {
    let top = (bounds.y - r.y).max(0.);
    let left = (bounds.x - r.x).max(0.);
    let right = (r.x + r.w - (bounds.x + bounds.w)).max(0.);
    let bottom = (r.y + r.h - (bounds.y + bounds.h)).max(0.);
    if top == 0. && left == 0. && right == 0. && bottom == 0. {
        return None;
    }
    Some(Rect::new(left, top, right, bottom))
}

/// Rects are rounded so `x2 = round(x + w)`, `x = round(x)`: no sub-pixel
/// seams at rest.
pub(super) fn snap(r: Rect, round: bool) -> Rect {
    if !round {
        return r;
    }
    let x2 = (r.x + r.w).round();
    let y2 = (r.y + r.h).round();
    let x = r.x.round();
    let y = r.y.round();
    Rect::new(x, y, x2 - x, y2 - y)
}

