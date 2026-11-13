// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/navigation.ts), with Lattice's patch (presses and wheels a view's content or a
// control owns are never the navigator's; the host decides that before calling in).

//! Camera navigation.
//!
//! Frames any node or contiguous sibling range. Supports rubber-banded zoom
//! (up to 1.35× the layout, 30% edge overshoot) that springs to the best fit
//! 180 ms after the gesture; Shift+wheel hierarchy steps; Shift+drag marquee;
//! Alt+drag zoom; pinch; maximize that restores the exact prior framing;
//! overview that toggles back; history of visits by their views; saved
//! framings that follow surviving views.
//!
//! Gestures run only with free navigation; focus navigation keeps maximize,
//! Escape and history. Floating windows are never camera targets.

use crate::model::{
    Entries, Framing, LayoutNode, MaximizeSession, Navigation, Point, Rect, StepDirection, UNIT,
    Visit, best_fit, find_stage, focus_layout, frame_leaves, hierarchy_step, leaf_ids,
    maximize_transition, nav_node, nav_parent, record_visit, rectangle_camera,
    saved_frame_destination, uid,
};

use super::engine::{Engine, Event, NavigationMode};
use super::motion::same_rect;

const MAX_HISTORY: usize = 100;
/// After a wheel or pinch zoom stops, the camera springs to the best fit.
const GESTURE_SETTLE_MS: f64 = 180.;

#[derive(Clone, Debug)]
pub(crate) struct Marquee {
    pub start: Point,
    pub current: Point,
    pub view: Rect,
    pub candidate: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct DragZoom {
    pub origin: Point,
    pub last_y: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct HierarchyWheel {
    pub last: f64,
    pub total: f64,
    pub stepped_at: f64,
    pub direction: f64,
}

impl Default for HierarchyWheel {
    fn default() -> Self {
        HierarchyWheel {
            last: f64::NEG_INFINITY,
            total: 0.,
            stepped_at: f64::NEG_INFINITY,
            direction: 0.,
        }
    }
}

pub(crate) struct Navigator {
    pub entries: Entries,
    pub framed: Option<String>,
    pub framed_leaves: Vec<String>,
    pub visits: Vec<Visit>,
    pub visit_index: usize,
    pub session: Option<MaximizeSession>,
    pub overview_return: Option<Vec<String>>,
    pub framings: Vec<Framing>,
    pub gesture: bool,
    /// When a wheel zoom's settle runs.
    pub wheel_timer: Option<f64>,
    pub hierarchy_wheel: HierarchyWheel,
    pub marquee: Option<Marquee>,
    pub drag_zoom: Option<DragZoom>,
    /// What releasing a gesture will frame, outlined (screen px).
    pub snap: Option<Rect>,
}

impl Default for Navigator {
    fn default() -> Self {
        Navigator {
            entries: Entries::new(),
            framed: None,
            framed_leaves: Vec::new(),
            visits: vec![Visit {
                id: String::new(),
                leaves: Vec::new(),
            }],
            visit_index: 0,
            session: None,
            overview_return: None,
            framings: Vec::new(),
            gesture: false,
            wheel_timer: None,
            hierarchy_wheel: HierarchyWheel::default(),
            marquee: None,
            drag_zoom: None,
            snap: None,
        }
    }
}

fn contains(node: &LayoutNode, id: &str) -> bool {
    crate::model::contains_node(node, id)
}

impl Engine {
    fn root_id(&self) -> String {
        self.doc
            .root
            .as_ref()
            .map(|r| r.id().to_string())
            .unwrap_or_default()
    }

    fn free(&self) -> bool {
        self.options.navigation == NavigationMode::Free
    }

    /// Recompute targets after a layout change; the framing follows its
    /// views.
    pub(crate) fn nav_sync(&mut self) {
        let entries = self.with_metrics(|m| focus_layout(self.doc.root.as_ref(), Some(m)));
        self.nav.entries = entries;
        if let Some(framed) = self.nav.framed.clone() {
            if !self.nav.entries.contains_key(&framed) {
                let surviving: Vec<String> = self
                    .nav
                    .framed_leaves
                    .iter()
                    .filter(|id| self.nav.entries.contains_key(*id))
                    .cloned()
                    .collect();
                let next = if surviving.is_empty() {
                    None
                } else {
                    frame_leaves(self.doc.root.as_ref(), &surviving)
                };
                self.nav.framed = next.filter(|n| *n != self.root_id());
                self.nav.framed_leaves = match &self.nav.framed {
                    Some(f) => leaf_ids(Some(&self.nav.entries[f].node)),
                    None => Vec::new(),
                };
            } else {
                self.nav.framed_leaves = leaf_ids(Some(&self.nav.entries[&framed].node));
            }
        }
        if self
            .nav
            .session
            .as_ref()
            .is_some_and(|s| !self.nav.entries.contains_key(&s.id))
        {
            self.nav.session = None;
        }
        self.nav_retarget();
    }

    fn rect_of(&self, id: Option<&str>) -> Rect {
        id.and_then(|id| self.nav.entries.get(id))
            .map_or(UNIT, |e| e.rect)
    }

    fn nav_retarget(&mut self) {
        let target = self.rect_of(self.nav.framed.clone().as_deref());
        if !same_rect(self.camera.target, target, 1e-9) {
            self.camera.target = target;
            if self.reduced() {
                self.camera.finish();
            }
        }
    }

    /// Frame a node or sibling range. Floats frame the desktop they belong to.
    pub(crate) fn nav_focus(&mut self, id: Option<&str>, record: bool) {
        let mut id = if self.navigation_on() {
            id.map(str::to_string)
        } else {
            None
        };
        if let Some(i) = &id
            && self.doc.floating.iter().any(|f| f.panel.id == *i)
        {
            id = find_stage(self.doc.root.as_ref()).map(|s| s.id.clone());
        }
        if id.as_ref().is_some_and(|i| !self.nav.entries.contains_key(i)) {
            id = None;
        }
        if let Some(i) = &id {
            id = Some(nav_node(&self.nav.entries, i));
        }
        if id.as_deref() == Some(self.root_id().as_str()) {
            id = None;
        }
        if self.nav.session.as_ref().is_some_and(|s| Some(&s.id) != id.as_ref()) {
            self.nav.session = None;
        }
        if record {
            let leaves = match &id {
                Some(i) => leaf_ids(Some(&self.nav.entries[i].node)),
                None => leaf_ids(self.doc.root.as_ref()),
            };
            let visit = Visit {
                id: id.clone().unwrap_or_else(|| self.root_id()),
                leaves,
            };
            let (mut visits, mut index) = record_visit(&self.nav.visits, self.nav.visit_index, visit);
            if visits.len() > MAX_HISTORY {
                visits = visits[visits.len() - MAX_HISTORY..].to_vec();
                index = visits.len() - 1;
            }
            self.nav.visits = visits;
            self.nav.visit_index = index;
        }
        self.end_gesture();
        let changed = self.nav.framed != id;
        self.nav.framed_leaves = match &id {
            Some(i) => leaf_ids(Some(&self.nav.entries[i].node)),
            None => Vec::new(),
        };
        self.nav.framed = id;
        self.nav_retarget();
        if changed {
            self.nav_changed();
        }
    }

    fn nav_changed(&mut self) {
        self.events.push(Event::Navigate(self.nav.framed.clone()));
        self.events.push(Event::Change);
    }

    fn end_gesture(&mut self) {
        self.nav.wheel_timer = None;
        self.nav.snap = None;
        if self.nav.gesture {
            self.nav.gesture = false;
            self.set_gesture(false);
        }
    }

    pub(crate) fn set_gesture(&mut self, active: bool) {
        self.gesture = active;
        self.zooming = active;
        if active {
            self.tween.stop();
        }
    }

    /// Maximize a panel, or restore the exact prior framing.
    pub(crate) fn nav_toggle(&mut self, id: &str) -> bool {
        if !self.navigation_on() {
            return false;
        }
        if self.doc.floating.iter().any(|f| f.panel.id == id) {
            return false;
        }
        if !self.nav.entries.contains_key(id) {
            return false;
        }
        let focused = self.nav.framed.clone().unwrap_or_else(|| self.root_id());
        let node = nav_node(&self.nav.entries, id);
        let (destination, session) = maximize_transition(
            &self.nav.entries,
            &self.root_id(),
            &focused,
            &node,
            self.nav.session.as_ref(),
        );
        self.nav_focus(Some(&destination), true);
        self.nav.session = session;
        true
    }

    /// Escape: frame the parent of the current framing.
    pub fn nav_step_out(&mut self) {
        let Some(framed) = self.nav.framed.clone() else {
            return;
        };
        let parent = nav_parent(&self.nav.entries, &framed);
        self.nav_focus(parent.as_deref(), true);
    }

    /// Frame the child under the centre of the viewport.
    pub fn nav_step_in(&mut self) {
        let p = self.from_screen(Point::new(self.viewport.0 / 2., self.viewport.1 / 2.));
        let focused = self.nav.framed.clone().unwrap_or_else(|| self.root_id());
        let next = hierarchy_step(&self.nav.entries, &focused, StepDirection::In, p);
        self.nav_focus(Some(&next), true);
    }

    pub(crate) fn nav_history_go(&mut self, direction: isize) {
        let next = self.nav.visit_index as isize + direction;
        if next < 0 || next as usize >= self.nav.visits.len() {
            return;
        }
        self.nav.visit_index = next as usize;
        self.nav.session = None;
        let leaves = self.nav.visits[next as usize].leaves.clone();
        let destination = saved_frame_destination(self.doc.root.as_ref(), &leaves);
        // With none of its views left, a visit falls back to the desktop.
        let destination =
            destination.or_else(|| find_stage(self.doc.root.as_ref()).map(|s| s.id.clone()));
        self.nav_focus(destination.as_deref(), false);
    }

    /// Overview, and back to the previous framing.
    pub(crate) fn nav_toggle_overview(&mut self) {
        if self.nav.framed.is_none() {
            if let Some(leaves) = self.nav.overview_return.take() {
                let destination = saved_frame_destination(self.doc.root.as_ref(), &leaves);
                self.nav_focus(destination.as_deref(), true);
            }
        } else {
            self.nav.overview_return = Some(self.nav.framed_leaves.clone());
            self.nav_focus(None, true);
        }
    }

    pub fn nav_overview(&mut self) {
        if self.nav.framed.is_some() {
            self.nav.overview_return = Some(self.nav.framed_leaves.clone());
        }
        self.nav_focus(None, true);
    }

    pub(crate) fn nav_frame_stage(&mut self) {
        let stage = find_stage(self.doc.root.as_ref()).map(|s| s.id.clone());
        self.nav_focus(stage.as_deref(), true);
    }

    /// Frame everything (`None`), or the smallest target holding these nodes
    /// or views.
    pub fn nav_frame(&mut self, targets: Option<&[String]>) {
        let Some(targets) = targets else {
            return self.nav_focus(None, true);
        };
        let ids: Vec<String> = targets
            .iter()
            .flat_map(|id| match self.nav.entries.get(id) {
                Some(e) => leaf_ids(Some(&e.node)),
                None => self.nav_panel_of(id).into_iter().collect(),
            })
            .collect();
        if ids.is_empty() {
            return;
        }
        let destination = frame_leaves(self.doc.root.as_ref(), &ids);
        self.nav_focus(destination.as_deref(), true);
    }

    fn nav_panel_of(&self, view_id: &str) -> Option<String> {
        leaf_ids(self.doc.root.as_ref()).into_iter().find(|id| {
            matches!(self.nav.entries.get(id).map(|e| &e.node),
                Some(LayoutNode::Panel(p)) if p.views.iter().any(|v| v == view_id))
        })
    }

    /// Keep a newly opened or focused docked view in frame; floats need their
    /// desktop in frame.
    pub(crate) fn nav_ensure_visible(&mut self, panel_id: &str) {
        let Some(framed) = self.nav.framed.clone() else {
            return;
        };
        let Some(node) = self.nav.entries.get(&framed).map(|e| e.node.clone()) else {
            return;
        };
        if let Some(float) = self.doc.floating.iter().find(|f| f.panel.id == panel_id) {
            if float.layer == crate::model::FloatingLayer::Overlay {
                return;
            }
            let stage = find_stage(self.doc.root.as_ref()).map(|s| s.id.clone());
            if let Some(stage) = &stage
                && (leaf_ids(Some(&node)).contains(stage) || contains(&node, stage))
            {
                return;
            }
            self.nav_focus(stage.as_deref(), true);
            return;
        }
        if contains(&node, panel_id) {
            return;
        }
        let mut leaves = self.nav.framed_leaves.clone();
        leaves.push(panel_id.to_string());
        let destination = frame_leaves(self.doc.root.as_ref(), &leaves);
        self.nav_focus(destination.as_deref(), true);
    }

    /// Widen the framing to include these nodes (after a move).
    pub(crate) fn nav_include(&mut self, ids: &[String]) {
        if self.nav.framed.is_none() {
            return;
        }
        let mut leaves: Vec<String> = self
            .nav
            .framed_leaves
            .iter()
            .filter(|id| self.nav.entries.contains_key(*id))
            .cloned()
            .collect();
        leaves.extend(ids.iter().cloned());
        let destination = frame_leaves(self.doc.root.as_ref(), &leaves);
        self.nav_focus(destination.as_deref(), true);
    }

    pub(crate) fn nav_serialize(&self) -> Navigation {
        Navigation {
            frame: self
                .nav
                .framed
                .as_ref()
                .map(|_| self.nav.framed_leaves.clone()),
            framings: (!self.nav.framings.is_empty()).then(|| self.nav.framings.clone()),
        }
    }

    pub(crate) fn nav_restore(&mut self, navigation: Option<&Navigation>) {
        self.nav.framings = navigation
            .and_then(|n| n.framings.clone())
            .unwrap_or_default();
        let leaves = navigation.and_then(|n| n.frame.clone()).unwrap_or_default();
        let destination = if leaves.is_empty() {
            None
        } else {
            saved_frame_destination(self.doc.root.as_ref(), &leaves)
        };
        self.nav.visits = vec![Visit {
            id: self.root_id(),
            leaves: leaf_ids(self.doc.root.as_ref()),
        }];
        self.nav.visit_index = 0;
        self.nav.session = None;
        self.nav.overview_return = None;
        self.nav.framed = None;
        self.nav.framed_leaves = Vec::new();
        match destination {
            Some(d) if self.navigation_on() => self.nav_focus(Some(&d), true),
            _ => self.nav_retarget(),
        }
    }

    // ------------------------------------------------------------ saved framings

    /// Save the current framing. Blank names are rejected.
    pub fn save_framing(&mut self, name: &str) -> Option<Framing> {
        if name.trim().is_empty() {
            return None;
        }
        let framing = Framing {
            id: uid("framing"),
            name: name.trim().to_string(),
            frame: if self.nav.framed.is_some() {
                self.nav.framed_leaves.clone()
            } else {
                leaf_ids(self.doc.root.as_ref())
            },
        };
        self.nav.framings.push(framing.clone());
        self.nav_changed();
        Some(framing)
    }

    pub fn go_to_framing(&mut self, id: &str) {
        if let Some(framing) = self.nav.framings.iter().find(|f| f.id == id).cloned() {
            let destination = saved_frame_destination(self.doc.root.as_ref(), &framing.frame);
            self.nav_focus(destination.as_deref(), true);
        }
    }

    pub fn remove_framing(&mut self, id: &str) {
        self.nav.framings.retain(|f| f.id != id);
        self.nav_changed();
    }

    pub fn framings(&self) -> &[Framing] {
        &self.nav.framings
    }

    // ------------------------------------------------------------ gestures

    /// Zoom the camera by `factor` around `at` (workspace px), panned by
    /// `pan` px.
    pub(crate) fn zoom(&mut self, factor: f64, at: Point, pan: Point) {
        if self.nav.marquee.is_some() || self.nav.entries.is_empty() {
            return;
        }
        if !self.nav.gesture {
            self.nav.gesture = true;
            self.set_gesture(true);
        }
        self.camera.velocity = Rect::ZERO;
        let (bw, bh) = self.viewport;
        let c = self.camera.value;
        let px = at.x / bw;
        let py = at.y / bh;
        let min = self
            .nav
            .entries
            .values()
            .map(|e| e.rect.w.min(e.rect.h))
            .fold(f64::INFINITY, f64::min)
            * 0.65;
        let factor = (min / c.w.min(c.h)).max(factor.min(1.35 / c.w.max(c.h)));
        let mut next = Rect {
            x: c.x + c.w * px * (1. - factor) - pan.x / bw * c.w,
            y: c.y + c.h * py * (1. - factor) - pan.y / bh * c.h,
            w: c.w * factor,
            h: c.h * factor,
        };
        next.x = (-next.w * 0.3).max((1. - next.w * 0.7).min(next.x));
        next.y = (-next.h * 0.3).max((1. - next.h * 0.7).min(next.y));
        self.camera.jump(next);
        let candidate = best_fit(self.camera.value, &self.nav.entries);
        self.nav.snap = self
            .nav
            .entries
            .get(&candidate)
            .map(|e| self.panel_screen(e.rect));
    }

    /// After a gesture, frame whatever fits the camera best.
    fn finish_gesture(&mut self) {
        if !self.nav.gesture {
            return;
        }
        let best = best_fit(self.camera.value, &self.nav.entries);
        self.nav_focus(Some(&best), true);
    }

    /// A wheel over the workspace's chrome (the host leaves wheels over a
    /// view's content, a scrolling tab strip or a menu with them). Returns
    /// whether the workspace took it.
    pub fn wheel(&mut self, at: Point, delta_y: f64, delta_x: f64, ctrl: bool, shift: bool) -> bool {
        if !self.free() {
            return false;
        }
        if self.hierarchy_wheel(at, delta_y, delta_x, shift) {
            return true;
        }
        if self.drag_active() || self.nav.drag_zoom.is_some() || self.nav.marquee.is_some() {
            return true;
        }
        let rate = if ctrl { 0.009 } else { 0.003 };
        self.zoom(
            (delta_y * rate).clamp(-0.3, 0.3).exp(),
            at,
            Point::default(),
        );
        self.nav.wheel_timer = Some(self.now() + GESTURE_SETTLE_MS);
        true
    }

    fn hierarchy_wheel(&mut self, at: Point, delta_y: f64, delta_x: f64, shift: bool) -> bool {
        if !shift {
            self.nav.hierarchy_wheel = HierarchyWheel::default();
            return false;
        }
        if self.drag_active() || self.nav.drag_zoom.is_some() || self.nav.marquee.is_some() {
            return true;
        }
        let now = self.now();
        // Some platforms turn Shift+wheel into horizontal deltas.
        let raw = if delta_y != 0. { delta_y } else { delta_x };
        let direction = raw.signum();
        if raw == 0. {
            return true;
        }
        let wheel = &mut self.nav.hierarchy_wheel;
        if now - wheel.last > 260. || direction != wheel.direction {
            *wheel = HierarchyWheel::default();
        }
        wheel.last = now;
        wheel.direction = direction;
        wheel.total += raw;
        if now - wheel.stepped_at >= 140. && wheel.total.abs() >= 12. {
            wheel.stepped_at = now;
            let out = wheel.total > 0.;
            wheel.total = 0.;
            let point = self.from_screen(at);
            let focused = self.nav.framed.clone().unwrap_or_else(|| self.root_id());
            let next = hierarchy_step(
                &self.nav.entries,
                &focused,
                if out {
                    StepDirection::Out
                } else {
                    StepDirection::In
                },
                point,
            );
            self.nav_focus(Some(&next), true);
        }
        true
    }

    /// A pinch: `scale` is the change since the last event (Safari's
    /// convention: >1 spreads the fingers, zooming in).
    pub fn pinch(&mut self, at: Point, scale: f64) {
        if !self.free() || self.drag_active() {
            return;
        }
        if scale > 0. {
            self.zoom(1. / scale, at, Point::default());
        }
        self.nav.wheel_timer = Some(self.now() + GESTURE_SETTLE_MS);
    }

    /// A press on the workspace's chrome with Shift (marquee) or Alt (drag
    /// zoom); presses on a view's content and on controls never reach here.
    /// Returns whether the navigator took the press.
    pub fn nav_press(&mut self, at: Point, shift: bool, alt: bool) -> bool {
        if !self.free() || self.drag_active() {
            return false;
        }
        if shift && self.nav.drag_zoom.is_none() {
            self.end_gesture();
            self.nav.marquee = Some(Marquee {
                start: at,
                current: at,
                view: self.camera.value,
                candidate: None,
            });
            self.nav_move(at);
            return true;
        }
        if alt && self.nav.marquee.is_none() {
            self.nav.drag_zoom = Some(DragZoom {
                origin: at,
                last_y: at.y,
            });
            self.zoom(1., at, Point::default());
            return true;
        }
        false
    }

    /// The pointer moved during a marquee or drag zoom.
    pub fn nav_move(&mut self, at: Point) {
        if let Some(m) = self.nav.marquee.clone() {
            let viewport = Rect::new(0., 0., self.viewport.0, self.viewport.1);
            let world = rectangle_camera(m.start, at, viewport, m.view);
            let screen = self.to_screen(world);
            let candidate = (screen.w >= 8. && screen.h >= 8.)
                .then(|| best_fit(world, &self.nav.entries));
            if let Some(m) = &mut self.nav.marquee {
                m.current = at;
                m.candidate = candidate;
            }
        } else if let Some(z) = self.nav.drag_zoom.clone() {
            self.zoom(((at.y - z.last_y) * 0.006).exp(), z.origin, Point::default());
            if let Some(z) = &mut self.nav.drag_zoom {
                z.last_y = at.y;
            }
        }
    }

    /// The pointer was released (`commit`) or lost.
    pub fn nav_release(&mut self, at: Point, commit: bool) {
        if self.nav.marquee.is_some() {
            if commit {
                self.nav_move(at);
            }
            let m = self.nav.marquee.take().expect("checked");
            self.suppress_clicks_until = self.now() + 350.;
            let target = if commit && m.candidate.is_some() {
                m.candidate
            } else {
                self.nav.framed.clone()
            };
            self.nav_focus(target.as_deref(), true);
        } else if self.nav.drag_zoom.take().is_some() {
            self.suppress_clicks_until = self.now() + 350.;
            self.finish_gesture();
        }
    }

    pub(crate) fn nav_cancel_gestures(&mut self) {
        if self.nav.marquee.is_some() {
            self.nav_release(Point::default(), false);
        }
        if self.nav.drag_zoom.is_some() {
            self.nav.drag_zoom = None;
            self.finish_gesture();
        }
        self.end_gesture();
    }

    /// Whether a marquee or drag zoom holds the pointer.
    pub fn nav_pointer_held(&self) -> bool {
        self.nav.marquee.is_some() || self.nav.drag_zoom.is_some()
    }

    /// Run the gesture timer; called each frame.
    pub(crate) fn step_navigation(&mut self, now: f64) {
        if let Some(at) = self.nav.wheel_timer
            && now >= at
        {
            self.nav.wheel_timer = None;
            self.finish_gesture();
        }
    }

    /// The node frames show for a marquee's candidate ("Release to focus
    /// {title}").
    pub(crate) fn node_title(&self, node: &LayoutNode) -> String {
        use crate::runtime::labels::{Label, label};
        match node {
            LayoutNode::Panel(p) => self.title_of(&p.selected),
            LayoutNode::Stage(_) => label(Label::TheStage),
            LayoutNode::Split(_) => label(Label::ThisGroup),
        }
    }
}
