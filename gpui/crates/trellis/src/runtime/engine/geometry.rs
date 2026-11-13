// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/workspace.ts: geometry).

//! Geometry: the camera's mapping between world units (the layout is 0–1)
//! and workspace pixels, the stage, floating layers and where each panel
//! belongs on screen.

use crate::model::{FloatingLayer, LayoutNode, Point, Rect, UNIT, find_node, find_stage};

use super::{Engine, Region};

impl Engine {
    pub(crate) fn pad(&self) -> f64 {
        self.gap() / 2.
    }

    pub(crate) fn to_screen(&self, r: Rect) -> Rect {
        let c = self.camera.value;
        let p = self.pad();
        let w = self.viewport.0 - p * 2.;
        let h = self.viewport.1 - p * 2.;
        Rect {
            x: p + (r.x - c.x) / c.w * w,
            y: p + (r.y - c.y) / c.h * h,
            w: r.w / c.w * w,
            h: r.h / c.h * h,
        }
    }

    pub(crate) fn from_screen(&self, p: Point) -> Point {
        let c = self.camera.value;
        let q = self.pad();
        Point {
            x: c.x + (p.x - q) / (self.viewport.0 - q * 2.) * c.w,
            y: c.y + (p.y - q) / (self.viewport.1 - q * 2.) * c.h,
        }
    }

    pub(crate) fn from_screen_rect(&self, screen: Option<Rect>) -> Option<Rect> {
        let screen = screen?;
        let p = self.pad();
        let a = self.from_screen(Point::new(screen.x - p, screen.y - p));
        let b = self.from_screen(Point::new(screen.x + screen.w + p, screen.y + screen.h + p));
        Some(Rect::new(a.x, a.y, b.x - a.x, b.y - a.y))
    }

    pub(crate) fn inset(r: Rect, d: f64) -> Rect {
        Rect {
            x: r.x + d,
            y: r.y + d,
            w: (r.w - d * 2.).max(0.),
            h: (r.h - d * 2.).max(0.),
        }
    }

    /// A docked node's screen rect, inset by half the gap.
    pub(crate) fn panel_screen(&self, world: Rect) -> Rect {
        Self::inset(self.to_screen(world), self.pad())
    }

    pub(crate) fn stage_world(&self) -> Rect {
        find_stage(self.doc.root.as_ref())
            .and_then(|stage| self.entries.get(&stage.id))
            .map_or(UNIT, |e| e.rect)
    }

    pub(crate) fn stage_screen(&self) -> Option<Rect> {
        let stage = find_stage(self.doc.root.as_ref())?;
        let e = self.entries.get(&stage.id)?;
        Some(self.panel_screen(e.rect))
    }

    pub(crate) fn float_container(&self, layer: FloatingLayer) -> Rect {
        match layer {
            FloatingLayer::Overlay => Rect::new(0., 0., self.viewport.0, self.viewport.1),
            FloatingLayer::Stage => self.to_screen(self.stage_world()),
        }
    }

    pub(crate) fn float_screen(&self, rect: Rect, layer: FloatingLayer) -> Rect {
        let c = self.float_container(layer);
        Rect::new(
            c.x + rect.x * c.w,
            c.y + rect.y * c.h,
            rect.w * c.w,
            rect.h * c.h,
        )
    }

    pub(crate) fn screen_to_float(&self, r: Rect, layer: FloatingLayer) -> Rect {
        let c = self.float_container(layer);
        Rect::new((r.x - c.x) / c.w, (r.y - c.y) / c.h, r.w / c.w, r.h / c.h)
    }

    /// Where a panel should be, ignoring tweens.
    pub(crate) fn target_rect(&self, panel_id: &str) -> Option<Rect> {
        if self.lifted().is_some_and(|l| l.id == panel_id) {
            return self.drag.as_ref().map(|d| d.floating);
        }
        if let Some(preview) = self.layout_targets().and_then(|t| t.get(panel_id))
            && !self.doc.floating.iter().any(|f| f.panel.id == panel_id)
        {
            return Some(self.panel_screen(*preview));
        }
        if let Some(float) = self.doc.floating.iter().find(|f| f.panel.id == panel_id) {
            return Some(self.float_screen(float.rect, float.layer));
        }
        self.entries
            .get(panel_id)
            .map(|e| self.panel_screen(e.rect))
    }

    /// Where a panel will be once the camera settles.
    pub(crate) fn rest_rect(&mut self, panel_id: &str) -> Option<Rect> {
        let value = self.camera.value;
        self.camera.value = self.camera.target;
        let rect = self.target_rect(panel_id);
        self.camera.value = value;
        rect
    }

    pub(crate) fn region_of(&self, panel_id: &str) -> Region {
        if self.doc.floating.iter().any(|f| f.panel.id == panel_id) {
            return Region::Floating;
        }
        match find_stage(self.doc.root.as_ref()) {
            Some(stage)
                if find_node(Some(&LayoutNode::Stage(stage.clone())), panel_id).is_some() =>
            {
                Region::Stage
            }
            _ => Region::Side,
        }
    }
}

impl Engine {
    /// The host's measurement of a panel's strip as last drawn: the bar, the
    /// tab list inside it and each tab's box (workspace pixels). Tab drops
    /// and tab sorting read them.
    pub fn set_tab_boxes(
        &mut self,
        panel_id: &str,
        tabbar: Rect,
        tablist: Rect,
        tabs: Vec<(String, Rect)>,
    ) {
        if let Some(state) = self.panels.get_mut(panel_id) {
            state.tabbar = Some(tabbar);
            state.tablist = Some(tablist);
            state.tabs = tabs;
        }
    }
}
