// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/workspace.ts: reflowOf, placeSurface), with Lattice's patch (held layouts while a
// drag moves panels).

//! Where a view's content lays out each frame, and at what scale.

use crate::model::{PanelNode, Rect};

use super::frame::{SurfaceFrame, snap};
use super::{Engine, ViewState};

#[derive(Clone, Copy, Debug)]
pub(super) enum Reflow {
    Live,
    Keep,
    SettleAt(Rect),
    Hold { w: f64, h: f64, settle: bool },
}

impl Engine {
    /// How content is laid out this frame: live at its current size; held
    /// at the size it comes to rest at while a drag (or its landing) moves
    /// panels; once, at the size it settles at, while the camera moves; or
    /// kept at the size it has during a zoom gesture and while flying.
    pub(super) fn reflow_of(&mut self, panel_id: &str, flying: bool, bar: f64) -> Reflow {
        if flying || self.zooming {
            return Reflow::Keep;
        }
        if !self.camera.moving() && !self.gesture && (self.drag_active() || self.dropping) {
            let lifted = self.lifted().is_some_and(|l| l.id == panel_id);
            let end = if lifted {
                self.lifted_rest().map(|(w, h)| Rect::new(0., 0., w, h))
            } else {
                self.target_rect(panel_id)
            };
            if let Some(end) = end {
                return Reflow::Hold {
                    w: end.w,
                    h: (end.h - bar).max(0.),
                    settle: self.dropping || self.resting(),
                };
            }
        }
        if !self.camera.moving() || self.gesture {
            return Reflow::Live;
        }
        match self.rest_rect(panel_id) {
            Some(end) if self.in_view(end) => {
                Reflow::SettleAt(Rect::new(end.x, end.y + bar, end.w, (end.h - bar).max(0.)))
            }
            _ => Reflow::Keep,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn place_surface(
        &mut self,
        view_id: &str,
        panel: &PanelNode,
        body: Rect,
        selected: bool,
        round: bool,
        opacity: f64,
        clip: Option<Rect>,
        concealed: bool,
        reflow: Reflow,
    ) -> SurfaceFrame {
        let min = self.min_size_of(view_id);
        let (vw, vh) = self.viewport;
        let scale_at = |w: f64, h: f64| -> f64 {
            min.map_or(1., |(mw, mh)| 1f64.min(w / mw.max(1.)).min(h / mh.max(1.)))
                .max(0.05)
        };
        let safe = scale_at(body.w, body.h);
        // Content never lays out larger than twice the window: a bigger panel
        // lays out at that cap and is scaled up.
        let layout_at = |w: f64, h: f64| {
            let s = scale_at(w, h);
            let cap = 1f64.max(w / s / (2. * vw)).max(h / s / (2. * vh));
            ((w / s / cap).round(), (h / s / cap).round())
        };
        let busy = self.drag_active() || self.gesture;
        let usable = self.usable_at(view_id, safe);
        let moving = self.moving();
        let focused = self.focused_view.as_deref() == Some(view_id);
        let placement = self.placement_of(view_id);
        let surface = self.surfaces.get_mut(view_id).expect("synced");
        let (width, height, scale) = match reflow {
            Reflow::Hold { w, h, settle } => {
                // Lattice patch: while a drag moves panels, a view never lays
                // out on a frame of the motion. It keeps its size while its
                // panel shrinks (the surface clips it) and takes its panel's
                // new size once the panel is there and the pointer rests, or
                // the landing ends; a panel growing past it lays it out at the
                // size it grows to at once.
                let near = |a: f64, b: f64| (a - b).abs() < 0.5;
                let mut held = surface.held;
                if settle && near(body.w, w) && near(body.h, h) {
                    held = Some((w.round(), h.round()));
                } else if held.is_none_or(|(hw, hh)| body.w > hw + 0.5 || body.h > hh + 0.5) {
                    let (hw, hh) = held.unwrap_or((0., 0.));
                    held = Some((body.w.max(w).max(hw).round(), body.h.max(h).max(hh).round()));
                }
                surface.held = held;
                let (hw, hh) = held.expect("set");
                let s = scale_at(hw, hh);
                let cap = 1f64.max(hw / s / (2. * vw)).max(hh / s / (2. * vh));
                let (width, height) = ((hw / s / cap).round(), (hh / s / cap).round());
                surface.layout = Some((width, height));
                (width, height, s * cap)
            }
            Reflow::SettleAt(end) if end.w > 1. && end.h > 1. => {
                surface.held = None;
                let target = layout_at(end.w, end.h);
                surface.layout = Some(target);
                (
                    target.0,
                    target.1,
                    (body.w / target.0).max(body.h / target.1),
                )
            }
            Reflow::Keep if surface.layout.is_some() => {
                surface.held = None;
                let target = surface.layout.expect("checked");
                (
                    target.0,
                    target.1,
                    (body.w / target.0).max(body.h / target.1),
                )
            }
            _ => {
                surface.held = None;
                let s = safe;
                let cap = 1f64.max(body.w / s / (2. * vw)).max(body.h / s / (2. * vh));
                let mut width = body.w / s / cap;
                let mut height = body.h / s / cap;
                if round {
                    width = width.round();
                    height = height.round();
                }
                surface.layout = Some((width, height));
                (width, height, s * cap)
            }
        };
        let visible = selected && !concealed && body.w > 1. && body.h > 1.;
        surface.size = (width.round(), height.round());
        surface.scale = (safe * 1000.).round() / 1000.;
        let interactive = !busy && usable;
        surface.state = ViewState {
            visible,
            focused,
            selected,
            placement,
            interactive,
            // Size and scale settle once motion stops.
            size: if moving {
                surface.state.size
            } else {
                surface.size
            },
            scale: if moving {
                surface.state.scale
            } else {
                surface.scale
            },
            panel_id: panel.id.clone(),
        };
        SurfaceFrame {
            view_id: view_id.to_string(),
            body: snap(body, round),
            shown: selected && !concealed,
            opacity,
            clip,
            layout: (width, height),
            scale,
            interactive,
        }
    }
}
