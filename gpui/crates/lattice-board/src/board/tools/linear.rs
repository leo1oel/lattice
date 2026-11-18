// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Drawing lines and arrows, after Excalidraw `App.tsx` @ 3a317b5:
//! `handleLinearElementOnPointerDown` (a new element, or the next click of
//! one drawn click by click, `multiElement`), the linear branch of
//! `onPointerMoveFromPointerDownHandler` (drag-create), the
//! `multiElement` branch of `handleCanvasPointerMove` (the pending point
//! follows the pointer; a point is added once the pointer leaves the last
//! committed one) and `actionFinalize` (Enter, Escape, a click on the last
//! point, binding by clicking a shape). The elbow arrow is the arrow tool
//! with `currentItemArrowType` elbow.

use super::super::BoardView;
use super::super::Hooks;
use super::super::app_state::{ArrowType, ToolType};
use super::super::binding::{
    BindOpts, BindingCtx, PointUpdate, PointsPositionUpdates, bind_or_unbind_binding_element,
    get_binding_strategy_for_dragging_binding_element_endpoints, get_snap_outline_mid_point,
};
use super::super::canvas::{Gesture, Mods};
use super::super::collision::{get_hovered_element_for_binding, is_point_in_element};
use super::super::consts::{LINE_CONFIRM_THRESHOLD, MINIMUM_ARROW_SIZE};
use super::super::history::CaptureUpdateAction;
use super::super::linear::{
    FinalizeElement, FinalizePointer, LinearElementEditor, SuggestedBinding, finalize_element,
    finalize_linear_gesture,
};
use super::super::math::point_distance;
use super::super::new_element::{new_arrow_element, new_linear_element};
use super::super::types::{BindMode, ElementType, Roundness, roundness};
use super::super::utils::{get_grid_point, is_path_a_loop};
use gpui::Context;
use std::collections::BTreeSet;

pub struct LinearGesture {
    pub id: String,
    pub origin: [f64; 2],
    pub dragged: bool,
    /// The press of a later click of an element drawn click by click.
    pub multi_click: bool,
}

pub fn down(
    me: &mut BoardView,
    p: [f64; 2],
    mods: Mods,
    window: &mut gpui::Window,
    cx: &mut Context<BoardView>,
) {
    let _ = window;
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    if let Some(id) = me.multi.clone() {
        let Some(el) = me.scene.get_non_deleted_element(&id).cloned() else {
            me.multi = None;
            return;
        };
        let pts = el.points().unwrap_or(&[]).to_vec();
        if el.is_line() && is_path_a_loop(&pts, me.app.zoom) {
            if let Some(l) = &mut me.linear {
                l.last_committed_point = pts.last().copied();
                l.initial_state.last_clicked_point = -1;
            }
            finalize(me, cx);
            return;
        }
        if el.is_elbow_arrow() && pts.len() > 1 {
            finalize_at(me, p, mods, cx);
            return;
        }
        let last_committed = me.linear.as_ref().and_then(|l| l.last_committed_point);
        let (start, end) = if el.is_binding_element(false) && me.app.is_binding_enabled {
            let n = pts.len() - 1;
            let dragging = PointsPositionUpdates::from([(n, PointUpdate::at(pts[n]))]);
            let ctx = BindingCtx {
                hooks: &hooks,
                ..BindingCtx::from_app(&me.app)
            };
            get_binding_strategy_for_dragging_binding_element_endpoints(
                &el,
                &dragging,
                p,
                &me.scene,
                me.scene.elements_including_deleted(),
                &ctx,
                &BindOpts {
                    new_arrow: true,
                    ..Default::default()
                },
            )
        } else {
            (
                super::super::binding::BindingStrategy::Keep,
                super::super::binding::BindingStrategy::Keep,
            )
        };
        let end_outside_same = start.element().is_some()
            && end.element().is_some()
            && start.element() == end.element()
            && end
                .element()
                .and_then(|id| me.scene.get_element(id))
                .is_some_and(|e| {
                    !is_point_in_element(end.focus_point().unwrap_or(p), e, &me.scene)
                });
        let start_id = el
            .linear()
            .and_then(|l| l.start_binding.as_ref())
            .map(|b| b.element_id.clone());
        let bound_from_elsewhere =
            end.mode() == Some(BindMode::Orbit) && start_id.as_deref() != end.element();
        let in_commit_zone = last_committed.is_some_and(|c| {
            point_distance([p[0] - el.x, p[1] - el.y], c) < LINE_CONFIRM_THRESHOLD
        });
        if bound_from_elsewhere || end_outside_same || (pts.len() > 1 && in_commit_zone) {
            finalize_at(me, p, mods, cx);
            return;
        }
        me.app.selected_element_ids.insert(id.clone());
        me.gesture = Some(Gesture::Linear(LinearGesture {
            id,
            origin: p,
            dragged: false,
            multi_click: true,
        }));
        return;
    }
    let [gx, gy] = get_grid_point(p[0], p[1], me.grid(mods));
    let frame = me.top_frame_at([gx, gy], &BTreeSet::new());
    let arrow = me.app.active_tool.ty == ToolType::Arrow;
    let ty = if arrow {
        ElementType::Arrow
    } else {
        ElementType::Line
    };
    let a = &me.app;
    let mut o = me.current_opts(ty, gx, gy);
    o.frame_id = frame;
    let el = if arrow {
        o.roundness = (a.current_item_arrow_type == ArrowType::Round).then_some(Roundness {
            kind: roundness::PROPORTIONAL_RADIUS,
            value: None,
        });
        let elbow = a.current_item_arrow_type == ArrowType::Elbow;
        new_arrow_element(
            o,
            vec![[0., 0.], [0., 0.]],
            a.current_item_start_arrowhead,
            a.current_item_end_arrowhead,
            elbow,
            elbow.then(Vec::new),
        )
    } else {
        o.roundness = me.current_roundness(ElementType::Line).map(|_| Roundness {
            kind: roundness::PROPORTIONAL_RADIUS,
            value: None,
        });
        new_linear_element(o, vec![[0., 0.], [0., 0.]], None)
    };
    let id = el.id.clone();
    let bound = if me.app.is_binding_enabled {
        get_hovered_element_for_binding(
            p,
            me.scene.elements_including_deleted(),
            &me.scene,
            me.app.zoom,
        )
        .map(|e| e.id.clone())
    } else {
        None
    };
    me.scene.insert_element(el.clone());
    if el.is_binding_element(false) {
        let ctx = BindingCtx {
            hooks: &hooks,
            ..BindingCtx::from_app(&me.app)
        };
        bind_or_unbind_binding_element(
            &id,
            &PointsPositionUpdates::from([(0, PointUpdate::at([0., 0.]))]),
            p,
            &mut me.scene,
            &ctx,
            &BindOpts {
                new_arrow: true,
                alt_key: mods.alt,
                initial_binding: true,
                angle_locked: mods.shift,
                ..Default::default()
            },
        );
    }
    let mut le = LinearElementEditor::new(&id, &mut me.scene, false);
    if let Some(l) = &mut le {
        l.selected_points_indices = Some(vec![1]);
        l.initial_state.arrow_start_is_inside = mods.alt;
        l.initial_state.last_clicked_point = 1;
        l.initial_state.origin = Some(p);
    }
    me.app.bind_mode = BindMode::Orbit;
    me.suggested = bound.filter(|_| el.is_binding_element(false)).map(|b| {
        let mid = me.scene.get_element(&b).and_then(|e| {
            get_snap_outline_mid_point(p, e, &me.scene, me.app.zoom, el.is_elbow_arrow())
        });
        SuggestedBinding {
            element: b,
            mid_point: mid,
        }
    });
    if !me.app.active_tool.locked {
        me.app.selected_element_ids = BTreeSet::from([id.clone()]);
        me.app.selected_group_ids.clear();
    }
    me.set_linear(le);
    me.gesture = Some(Gesture::Linear(LinearGesture {
        id,
        origin: p,
        dragged: false,
        multi_click: false,
    }));
    cx.notify();
}

/// Drag-create: the end point follows the pointer (`handlePointDragging`).
pub fn drag(
    me: &mut BoardView,
    mut g: LinearGesture,
    p: [f64; 2],
    mods: Mods,
    cx: &mut Context<BoardView>,
) -> Option<Gesture> {
    if g.multi_click {
        return Some(Gesture::Linear(g));
    }
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    g.dragged = true;
    let Some(mut le) = me.linear.clone().filter(|l| l.element_id == g.id) else {
        return Some(Gesture::Linear(g));
    };
    let n = me
        .scene
        .get_element(&g.id)
        .and_then(|e| e.points())
        .map_or(0, |p| p.len());
    if le.initial_state.last_clicked_point < 0 || le.initial_state.last_clicked_point as usize >= n
    {
        le.selected_points_indices = Some(vec![n - 1]);
        le.initial_state.last_clicked_point = n as isize - 1;
        le.hover_point_index = n as isize - 1;
    }
    let ctx = crate::board::lctx(&me.app, &hooks, true);
    let ctx = super::super::linear::LinearCtx {
        suggested_binding: None,
        ..ctx
    };
    let [gx, gy] = get_grid_point(p[0], p[1], me.grid(mods));
    let _ = (gx, gy);
    if let Some((l, s)) = le.handle_point_dragging(&mut me.scene, &ctx, p, &mods.linear()) {
        me.set_linear(Some(l));
        me.suggested = s;
    }
    cx.notify();
    Some(Gesture::Linear(g))
}

pub fn up(
    me: &mut BoardView,
    g: LinearGesture,
    p: [f64; 2],
    mods: Mods,
    cx: &mut Context<BoardView>,
) {
    if g.multi_click {
        // the click is committed: the next move adds a point
        if let Some(e) = me.scene.get_element(&g.id)
            && let Some(l) = &mut me.linear
        {
            l.last_committed_point = e.points().and_then(|p| p.last().copied());
        }
        cx.notify();
        return;
    }
    let dist = point_distance(p, g.origin) * me.app.zoom;
    if !g.dragged || dist < MINIMUM_ARROW_SIZE {
        // a click: go on click by click
        me.multi = Some(g.id.clone());
        cx.notify();
        return;
    }
    me.store.schedule_capture();
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    if let Some(le) = me.linear.clone() {
        let ctx = crate::board::lctx(&me.app, &hooks, true);
        let ptr = FinalizePointer {
            scene_coords: p,
            mods: mods.linear(),
            hit_bound_text: false,
        };
        let (next, deleted) = finalize_linear_gesture(&le, &mut me.scene, &ctx, &ptr, false);
        if deleted {
            me.clear_selection();
            me.set_linear(None);
        } else {
            me.set_linear(next);
        }
    }
    me.suggested = None;
    if !me.app.active_tool.locked {
        super::tool_done(me);
        if me.scene.get_non_deleted_element(&g.id).is_some() {
            me.app.selected_element_ids = BTreeSet::from([g.id.clone()]);
            {
                let l = LinearElementEditor::new(&g.id, &mut me.scene, false);
                me.set_linear(l);
            }
        }
    }
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}

/// `handleCanvasPointerMove` with a `multiElement`.
pub fn hover(me: &mut BoardView, p: [f64; 2], mods: Mods, cx: &mut Context<BoardView>) {
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let Some(id) = me.multi.clone() else {
        // the arrow tool shows what a press would bind to
        if me.app.active_tool.ty == ToolType::Arrow && me.app.is_binding_enabled {
            let hit = get_hovered_element_for_binding(
                p,
                me.scene.elements_including_deleted(),
                &me.scene,
                me.app.zoom,
            )
            .cloned();
            let next = hit
                .filter(|h| !is_point_in_element(p, h, &me.scene))
                .map(|h| SuggestedBinding {
                    mid_point: get_snap_outline_mid_point(
                        p,
                        &h,
                        &me.scene,
                        me.app.zoom,
                        me.app.current_item_arrow_type == ArrowType::Elbow,
                    ),
                    element: h.id.clone(),
                });
            if next != me.suggested {
                me.suggested = next;
                cx.notify();
            }
        }
        return;
    };
    let Some(el) = me.scene.get_non_deleted_element(&id).cloned() else {
        me.multi = None;
        return;
    };
    let Some(le) = me.linear.clone().filter(|l| l.element_id == id) else {
        return;
    };
    let pts = el.points().unwrap_or(&[]).to_vec();
    let last = *pts.last().unwrap();
    let local = [p[0] - el.x, p[1] - el.y];
    if Some(last) == le.last_committed_point {
        if point_distance(local, last) >= LINE_CONFIRM_THRESHOLD {
            me.store.schedule_capture();
            let n = pts.len();
            let mut l = le.clone();
            l.last_committed_point = Some(last);
            l.selected_points_indices = Some(vec![n]);
            l.initial_state.last_clicked_point = n as isize;
            me.scene.mutate_element(&id, true, |e| {
                if let Some(q) = e.points_mut() {
                    q.push(local)
                }
            });
            me.set_linear(Some(l));
        }
    } else if pts.len() > 2
        && le
            .last_committed_point
            .is_some_and(|c| point_distance(local, c) < LINE_CONFIRM_THRESHOLD)
    {
        me.scene.mutate_element(&id, true, |e| {
            if let Some(q) = e.points_mut() {
                q.pop();
            }
        });
        let n = pts.len() - 2;
        let mut l = le.clone();
        l.selected_points_indices = l.selected_points_indices.map(|s| {
            let mut v: Vec<usize> = s.into_iter().map(|i| i.min(n)).collect();
            v.dedup();
            v
        });
        l.last_committed_point = Some(pts[n]);
        l.initial_state.last_clicked_point = n as isize;
        me.set_linear(Some(l));
    } else {
        let ctx = crate::board::lctx(&me.app, &hooks, true);
        if let Some((l, s)) = le.handle_pointer_move(&mut me.scene, &ctx, p, &mods.linear()) {
            me.set_linear(Some(l));
            me.suggested = s;
        }
    }
    cx.notify();
}

/// `actionFinalize` with the pointer (a click that ends the element).
fn finalize_at(me: &mut BoardView, p: [f64; 2], mods: Mods, cx: &mut Context<BoardView>) {
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let Some(id) = me.multi.take() else { return };
    if let Some(le) = me.linear.clone().filter(|l| l.element_id == id) {
        let ctx = crate::board::lctx(&me.app, &hooks, true);
        let ptr = FinalizePointer {
            scene_coords: p,
            mods: mods.linear(),
            hit_bound_text: false,
        };
        let (next, deleted) = finalize_linear_gesture(&le, &mut me.scene, &ctx, &ptr, false);
        if deleted {
            me.clear_selection();
            me.set_linear(None);
        } else {
            me.set_linear(next);
        }
    }
    done(me, &id, cx);
}

/// `actionFinalize` without the pointer (Enter, Escape, another tool): the
/// pending point goes, a closed loop closes.
pub fn finalize(me: &mut BoardView, cx: &mut Context<BoardView>) {
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let Some(id) = me.multi.take() else { return };
    let le = me.linear.clone().filter(|l| l.element_id == id);
    let ctx = crate::board::lctx(&me.app, &hooks, true);
    let (_, next) = finalize_element(
        &id,
        le.as_ref(),
        &FinalizeElement {
            multi_element: true,
            touch: false,
        },
        &mut me.scene,
        &ctx,
    );
    me.set_linear(next);
    done(me, &id, cx);
}

fn done(me: &mut BoardView, id: &str, cx: &mut Context<BoardView>) {
    me.suggested = None;
    let alive = me.scene.get_non_deleted_element(id).is_some();
    if alive && !me.app.active_tool.locked {
        me.app.selected_element_ids = BTreeSet::from([id.to_string()]);
        if me.linear.as_ref().is_none_or(|l| l.element_id != id) {
            {
                let l = LinearElementEditor::new(id, &mut me.scene, false);
                me.set_linear(l);
            }
        }
    } else if !alive {
        me.app.selected_element_ids.remove(id);
        me.set_linear(None);
    } else {
        me.clear_selection();
        me.set_linear(None);
    }
    super::tool_done(me);
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}
