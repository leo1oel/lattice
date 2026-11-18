// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The pen, after Excalidraw `App.tsx` @ 3a317b5
//! (`handleFreeDrawElementOnPointerDown`, the freedraw branches of the
//! pointer move / up handlers, `actionFinalize`). The mouse has no pressure:
//! `simulatePressure` is set and the outline (core `freehand.rs`) thins the
//! stroke by speed. The tool stays on after a stroke.

use super::super::BoardView;
use super::super::Hooks;
use super::super::canvas::{Gesture, Mods};
use super::super::history::CaptureUpdateAction;
use super::super::linear::{FinalizeElement, finalize_element};
use super::super::new_element::new_free_draw_element;
use super::super::types::{ElementType, StrokeOptions};
use gpui::Context;
use std::collections::BTreeSet;

pub struct FreeDrawGesture {
    pub id: String,
}

pub fn down(me: &mut BoardView, p: [f64; 2], _: Mods, cx: &mut Context<BoardView>) {
    let frame = me.top_frame_at(p, &BTreeSet::new());
    let mut o = me.current_opts(ElementType::FreeDraw, p[0], p[1]);
    o.frame_id = frame;
    let opts = StrokeOptions {
        variability: me.app.current_item_stroke_variability,
        streamline: super::super::consts::DEFAULT_STROKE_STREAMLINE,
    };
    let e = new_free_draw_element(o, vec![[0., 0.]], vec![], true, Some(opts));
    let id = e.id.clone();
    me.scene.insert_element(e);
    me.gesture = Some(Gesture::FreeDraw(FreeDrawGesture { id }));
    cx.notify();
}

pub fn drag(
    me: &mut BoardView,
    g: FreeDrawGesture,
    p: [f64; 2],
    cx: &mut Context<BoardView>,
) -> Option<Gesture> {
    if let Some(e) = me.scene.get_element(&g.id) {
        let d = [p[0] - e.x, p[1] - e.y];
        if e.points().and_then(|q| q.last()) != Some(&d) {
            me.scene.mutate_element(&g.id, true, |e| {
                if let Some(q) = e.points_mut() {
                    q.push(d)
                }
            });
        }
    }
    cx.notify();
    Some(Gesture::FreeDraw(g))
}

pub fn up(me: &mut BoardView, g: FreeDrawGesture, p: [f64; 2], cx: &mut Context<BoardView>) {
    let Some(e) = me.scene.get_element(&g.id).cloned() else {
        return;
    };
    let pts = e.points().unwrap_or(&[]);
    let mut d = [p[0] - e.x, p[1] - e.y];
    // a dot: two points apart
    if pts.first() == Some(&d) {
        d[0] += 0.0001;
        d[1] += 0.0001;
    }
    me.scene.mutate_element(&g.id, true, |e| {
        if let Some(q) = e.points_mut() {
            q.push(d)
        }
    });
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let ctx = crate::board::lctx(&me.app, &hooks, true);
    let _ = finalize_element(
        &g.id,
        None,
        &FinalizeElement::default(),
        &mut me.scene,
        &ctx,
    );
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}
