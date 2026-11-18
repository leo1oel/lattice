// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The eraser, after Excalidraw `eraser/index.ts` and `App.tsx`'s
//! `handleEraser` / `eraseElements` @ 3a317b5: what the trail crosses fades
//! (`ELEMENT_READY_TO_ERASE_OPACITY`) and is deleted on release; Alt brings
//! crossed elements back. A click erases what's under the pointer.

use super::super::BoardView;
use super::super::canvas::{Gesture, Mods};
use super::super::consts::ELEMENT_READY_TO_ERASE_OPACITY;
use super::super::eraser::{EraserTrail, erase_elements};
use super::super::history::CaptureUpdateAction;
use super::super::types::Element;
use gpui::Context;
use rustc_hash::FxHashSet;

pub struct EraserGesture {
    pub trail: EraserTrail,
    pub origin: [f64; 2],
    visible: Vec<Element>,
    all: Vec<Element>,
}

pub fn down(me: &mut BoardView, p: [f64; 2], cx: &mut Context<BoardView>) {
    let mut trail = EraserTrail::default();
    trail.start_path(p[0], p[1]);
    let all: Vec<Element> = me.scene.non_deleted_elements().cloned().collect();
    let v = super::super::viewport::visible_scene_bounds(me.viewport(), me.canvas());
    let visible = all
        .iter()
        .filter(|e| {
            let b = super::super::bounds::get_element_bounds(e, &me.scene, false);
            b[2] >= v[0] && b[0] <= v[2] && b[3] >= v[1] && b[1] <= v[3]
        })
        .cloned()
        .collect();
    me.gesture = Some(Gesture::Eraser(EraserGesture {
        trail,
        origin: p,
        visible,
        all,
    }));
    cx.notify();
}

pub fn drag(
    me: &mut BoardView,
    mut g: EraserGesture,
    p: [f64; 2],
    mods: Mods,
    cx: &mut Context<BoardView>,
) -> Option<Gesture> {
    let ids = g
        .trail
        .add_point_to_path(p[0], p[1], mods.alt, &g.visible, &g.all, me.app.zoom);
    me.faded = ids
        .into_iter()
        .map(|id| (id, (ELEMENT_READY_TO_ERASE_OPACITY / 100.) as f32))
        .collect();
    cx.notify();
    Some(Gesture::Eraser(g))
}

pub fn up(me: &mut BoardView, mut g: EraserGesture, p: [f64; 2], cx: &mut Context<BoardView>) {
    let mut pending: FxHashSet<String> = g.trail.elements_to_erase.clone();
    if g.trail.points.len() <= 1 || g.origin == p {
        for e in me.elements_at(p, false, false) {
            pending.insert(e.id.clone());
        }
    }
    g.trail.end_path();
    me.faded.clear();
    if erase_elements(&mut me.scene, &pending) {
        me.app
            .selected_element_ids
            .retain(|id| !pending.contains(id));
        me.commit(Some(CaptureUpdateAction::Immediately), cx);
    } else {
        cx.notify();
    }
}

impl EraserGesture {
    /// The trail drawn (scene coordinates).
    pub fn points(&self) -> &[[f64; 2]] {
        &self.trail.points
    }
}
