// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The selection tool (and the lasso's selection half), after Excalidraw
//! `components/App.selectionTool.ts` (`handleSelectionOnPointerDown`,
//! `maybeHandleResize`, `handleSelectionDragOnPointerMove`,
//! `handleBoxSelectionOnPointerMove`, `handleSelectionDragOnPointerUp`,
//! `handleSelectionOnPointerUp`), `App.selection.ts` (select / add / remove
//! / clear), the selection branches of `App.tsx`'s pointer handlers, the
//! alt-drag of `App.duplicate.ts` and `handleCanvasDoubleClick` @ 3a317b5.

use super::super::BoardView;
use super::super::app_state::ToolType;
use super::super::bounds::get_common_bounds;
use super::super::canvas::{Gesture, Mods, css_cursor};
use super::super::drag::{DragState, drag_selected_elements};
use super::super::groups::{
    get_selected_group_id_for_element, get_selected_group_ids, select_groups_for_selected_elements,
};
use super::super::handles::{
    HandleType, PointerType, get_cursor_for_resizing_element,
    get_element_with_transform_handle_type, get_transform_handle_type_from_coords,
};
use super::super::history::CaptureUpdateAction;
use super::super::lasso::LassoTrail;
use super::super::linear::{self, DragOutcome, FinalizePointer, LinearCtx, LinearElementEditor};
use super::super::resize::{TransformOpts, get_resize_offset_xy, transform_elements};
use super::super::selection::{
    SelectedOpts, get_elements_within_selection, get_selected_elements,
    get_selection_state_adding_elements, get_selection_state_for_elements,
    get_selection_state_removing_elements,
};
use super::super::snapping::{
    SnapCache, SnapResult, is_snapping_enabled, snap_dragged_elements, snap_resizing_elements,
};
use super::super::types::Element;
use super::super::utils::get_grid_point;
use super::super::{Hooks, consts::DRAGGING_THRESHOLD, math::point_distance};
use gpui::{Context, CursorStyle, Window};
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeSet;

/// A resize or rotation in progress (`pointerDownState.resize`).
pub struct Resize {
    pub handle: HandleType,
    pub offset: [f64; 2],
    pub center: [f64; 2],
    pub started: bool,
}

/// The selection tool's `PointerDownState`.
pub struct SelectGesture {
    pub origin: [f64; 2],
    pub origin_in_grid: [f64; 2],
    /// Where a drag counts from (moved by an alt-drag duplication).
    pub drag_origin: [f64; 2],
    pub with_cmd: bool,
    pub hit: Option<String>,
    pub all_hit: Vec<String>,
    pub was_added: bool,
    pub hit_common_bbox: bool,
    pub resize: Option<Resize>,
    pub ds: DragState,
    pub dragged: bool,
    pub box_select: bool,
    /// The box selection's scene rectangle.
    pub rect: Option<[f64; 4]>,
    pub duplicated: bool,
    pub snap: SnapCache,
    /// The linear editor took the drag (points, midpoints, focus points).
    pub linear_drag: bool,
    pub block_dragging: bool,
    /// The press grabbed the selected arrow's label (`hit.arrowLabel`).
    pub arrow_label: bool,
    /// The crop editor's drag offset at the previous move (`drag.lastOffset`).
    pub crop_last: [f64; 2],
}

fn ids(v: &[&Element]) -> Vec<String> {
    v.iter().map(|e| e.id.clone()).collect()
}

/// `selection.select`: these alone (with their groups unless `deep`).
pub fn select_only(me: &mut BoardView, which: &[String], deep: bool) {
    let els = me.scene.elements_including_deleted();
    let targets: Vec<&Element> = which
        .iter()
        .filter_map(|id| me.scene.get_non_deleted_element(id))
        .filter(|e| !e.locked)
        .collect();
    let s = get_selection_state_for_elements(&targets, els, &me.app, deep);
    s.apply(&mut me.app);
    me.sync_linear();
}

/// `selection.add`.
pub fn add(me: &mut BoardView, which: &[String]) {
    let els = me.scene.elements_including_deleted();
    let targets: Vec<&Element> = which
        .iter()
        .filter_map(|id| me.scene.get_non_deleted_element(id))
        .filter(|e| !e.locked)
        .collect();
    get_selection_state_adding_elements(&targets, els, &me.app).apply(&mut me.app);
    me.sync_linear();
}

/// `selection.remove`.
pub fn remove(me: &mut BoardView, which: &[String]) {
    let els = me.scene.elements_including_deleted();
    let targets: Vec<&Element> = which
        .iter()
        .filter_map(|id| me.scene.get_non_deleted_element(id))
        .collect();
    get_selection_state_removing_elements(&targets, els, &me.app).apply(&mut me.app);
    me.sync_linear();
}

/// `isHittingCommonBoundingBoxOfSelectedElements`.
pub fn hits_selection_box(me: &BoardView, p: [f64; 2]) -> bool {
    let sel = me.selected_elements();
    if sel.len() < 2 {
        return false;
    }
    let z = me.app.zoom;
    let t = (super::super::consts::DEFAULT_COLLISION_THRESHOLD / z).max(1.);
    let pad = super::super::consts::DEFAULT_TRANSFORM_HANDLE_SPACING * 2. / z;
    let [x1, y1, x2, y2] = get_common_bounds(sel.iter().copied(), &me.scene);
    p[0] > x1 - pad - t && p[0] < x2 + pad + t && p[1] > y1 - pad - t && p[1] < y2 + pad + t
}

/// `getTransformHandleAt`.
fn handle_at(me: &BoardView, p: [f64; 2]) -> Option<(Option<String>, HandleType)> {
    let sel = me.selected_elements();
    let z = me.app.zoom;
    match sel.len() {
        1 => {
            let e = sel[0];
            if me
                .linear
                .as_ref()
                .is_some_and(|l| l.is_editing || l.hover_point_index != -1)
                || e.is_elbow_arrow()
                || (e.is_linear() && e.points().is_some_and(|p| p.len() == 2))
            {
                return None;
            }
            let selected = &me.app.selected_element_ids;
            let els: Vec<Element> = me
                .scene
                .non_deleted_elements()
                .filter(|x| selected.contains(&x.id))
                .cloned()
                .collect();
            get_element_with_transform_handle_type(
                &els,
                &|x| selected.contains(&x.id),
                me.app.cropping_element_id.is_some(),
                p[0],
                p[1],
                z,
                PointerType::Mouse,
                &me.scene,
                true,
            )
            .map(|(e, h)| (Some(e.id.clone()), h))
        }
        0 => None,
        _ => get_transform_handle_type_from_coords(
            get_common_bounds(sel.iter().copied(), &me.scene),
            p[0],
            p[1],
            z,
            PointerType::Mouse,
            true,
        )
        .map(|h| (None, h)),
    }
}

/// `handleSelectionOnPointerDown` and what follows it for the selection and
/// lasso tools.
pub fn down(
    me: &mut BoardView,
    p: [f64; 2],
    mods: Mods,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    let _ = window;
    let grid = me.grid(mods);
    let mut g = SelectGesture {
        origin: p,
        origin_in_grid: get_grid_point(p[0], p[1], grid),
        drag_origin: p,
        with_cmd: mods.ctrl_or_cmd(),
        hit: None,
        all_hit: vec![],
        was_added: false,
        hit_common_bbox: hits_selection_box(me, p),
        resize: None,
        ds: DragState::new(&me.scene),
        dragged: false,
        box_select: false,
        rect: None,
        duplicated: false,
        snap: SnapCache::default(),
        linear_drag: false,
        block_dragging: false,
        arrow_label: false,
        crop_last: [0., 0.],
    };
    me.app.previous_selected_element_ids = me.app.selected_element_ids.clone();
    let lasso = me.app.active_tool.ty == ToolType::Lasso;
    if let Some((_, handle)) = handle_at(me, p) {
        let sel = me.selected_elements();
        let offset = get_resize_offset_xy(Some(handle), &sel, &me.scene, p[0], p[1]);
        let b = get_common_bounds(sel.iter().copied(), &me.scene);
        g.resize = Some(Resize {
            handle,
            offset,
            center: [(b[0] + b[2]) / 2., (b[1] + b[3]) / 2.],
            started: false,
        });
        me.hover_cursor = css_cursor(&get_cursor_for_resizing_element(
            if sel.len() == 1 { Some(sel[0]) } else { None },
            Some(handle),
        ));
        me.gesture = Some(Gesture::Select(Box::new(g)));
        return;
    }
    // the line editor first: points, midpoints, the label, focus points
    if let Some(le) = me.linear.clone() {
        let m = me.m.clone();
        let hooks = Hooks(&*m);
        let ctx = LinearCtx {
            suggested_binding: None,
            hooks: &hooks,
            ..LinearCtx::from_app(&me.app, false)
        };
        let grabbable = me
            .scene
            .get_non_deleted_element(&le.element_id)
            .cloned()
            .is_some_and(|e| bound_text_grabbable(me, &e, p));
        let ret = le.handle_pointer_down(&mut me.scene, &ctx, p, &mods.linear(), grabbable);
        if ret.capture {
            me.store.schedule_capture();
        }
        g.arrow_label = ret.hit_bound_text;
        if let Some(h) = &ret.hit_element {
            g.hit = Some(h.clone());
        }
        if let Some(l) = ret.linear_element_editor {
            me.set_linear(Some(l));
        }
        if ret.did_add_point {
            me.gesture = Some(Gesture::Select(Box::new(g)));
            return;
        }
        if g.hit.is_some() {
            g.linear_drag = true;
        }
        if let Some(arrow) = me
            .scene
            .get_non_deleted_element(&le.element_id)
            .filter(|e| e.is_binding_element(false))
            .cloned()
        {
            let (focus, offset, other) = linear::handle_focus_point_pointer_down(
                &arrow,
                p,
                &me.scene,
                me.app.is_binding_enabled,
                me.app.zoom,
            );
            if let Some(f) = focus
                && let Some(l) = &mut me.linear
            {
                l.hovered_focus_point_binding = Some(f);
                l.dragged_focus_point_binding = Some(f);
                l.pointer_offset = offset;
                l.initial_state.arrow_other_endpoint_initial_binding = other;
                g.linear_drag = true;
                g.hit = Some(arrow.id.clone());
                me.gesture = Some(Gesture::Select(Box::new(g)));
                return;
            }
        }
    }
    let all = me.elements_at(p, false, true);
    let unlocked: Vec<String> = all
        .iter()
        .filter(|e| !e.locked)
        .map(|e| e.id.clone())
        .collect();
    let maybe_locked = me.pick_from(p, &all).cloned();
    if maybe_locked
        .as_ref()
        .is_none_or(|e| Some(&e.id) != me.app.active_locked_id.as_ref())
    {
        me.app.active_locked_id = None;
    }
    if maybe_locked.as_ref().is_some_and(|e| e.locked)
        && !unlocked
            .iter()
            .any(|id| me.app.selected_element_ids.contains(id))
    {
        g.hit = None;
    } else if g.hit.is_none() {
        g.hit = me.element_at(p, false, false).map(|e| e.id.clone());
    }
    g.all_hit = unlocked;
    if me.app.cropping_element_id.is_some() && g.hit != me.app.cropping_element_id {
        super::crop::finish(me, cx);
    }
    if lasso {
        let hit_selected = g
            .hit
            .as_ref()
            .is_some_and(|h| me.app.selected_element_ids.contains(h));
        let force = mods.alt && mods.ctrl_or_cmd() && g.resize.is_none();
        if force || (!g.hit_common_bbox && !hit_selected) {
            let mut t = LassoTrail::default();
            t.start_path(p[0], p[1], mods.shift);
            me.gesture = Some(Gesture::Lasso(super::lasso::LassoGesture {
                trail: t,
                from_selection: false,
            }));
            if !mods.shift {
                me.clear_selection();
                me.set_linear(None);
            }
            return;
        }
    }
    let hit = g.hit.clone();
    let some_hit_selected = g
        .all_hit
        .iter()
        .any(|id| me.app.selected_element_ids.contains(id))
        || hit
            .as_ref()
            .is_some_and(|h| me.app.selected_element_ids.contains(h));
    let editing_line = me.linear.as_ref().is_some_and(|l| l.is_editing);
    if (hit.is_none() || !some_hit_selected)
        && !mods.shift
        && !g.hit_common_bbox
        && (!editing_line
            || hit
                .as_ref()
                .is_some_and(|h| Some(h) != me.linear.as_ref().map(|l| &l.element_id)))
    {
        // `clearSelection`: keep editing the group the hit element is in
        let keep_group = me.app.editing_group_id.clone().filter(|gid| {
            hit.as_ref()
                .and_then(|h| me.scene.get_element(h))
                .is_some_and(|e| e.group_ids.contains(gid))
        });
        me.app.selected_element_ids.clear();
        me.app.selected_group_ids.clear();
        me.app.editing_group_id = keep_group;
        if !editing_line {
            me.set_linear(None);
        }
    }
    if editing_line {
        let le = me.linear.clone().unwrap();
        let still = hit.as_ref() == Some(&le.element_id);
        me.app.selected_element_ids = BTreeSet::from([le.element_id.clone()]);
        if let Some(l) = &mut me.linear {
            l.is_editing = still;
        }
        if let Some(s) = &mut me.app.selected_linear_element {
            s.is_editing = still;
        }
    } else if let Some(h) = &hit {
        if mods.ctrl_or_cmd() {
            if mods.alt {
                let mut t = LassoTrail::default();
                t.start_path(p[0], p[1], mods.shift);
                me.app.active_tool =
                    super::super::actions::update_active_tool(&me.app, ToolType::Lasso);
                me.app.active_tool.from_selection = true;
                me.gesture = Some(Gesture::Lasso(super::lasso::LassoGesture {
                    trail: t,
                    from_selection: true,
                }));
                return;
            }
            if !me.app.selected_element_ids.contains(h) {
                g.was_added = true;
            }
            select_only(me, std::slice::from_ref(h), true);
        } else if !me.app.selected_element_ids.contains(h) {
            if let Some(ed) = me.app.editing_group_id.clone()
                && !me
                    .scene
                    .get_element(h)
                    .is_some_and(|e| e.group_ids.contains(&ed))
            {
                me.clear_selection();
            }
            if !some_hit_selected && !g.hit_common_bbox {
                add(me, std::slice::from_ref(h));
                g.was_added = true;
            }
        }
    }
    me.app.previous_selected_element_ids = me.app.selected_element_ids.clone();
    // the snapshot the drag reads, after the selection settled
    g.ds = DragState::new(&me.scene);
    me.gesture = Some(Gesture::Select(Box::new(g)));
    cx.notify();
}

/// The pointer moved with the button down.
pub fn drag(
    me: &mut BoardView,
    mut g: SelectGesture,
    p: [f64; 2],
    mods: Mods,
    _: &mut Window,
    cx: &mut Context<BoardView>,
) -> Option<Gesture> {
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    // the crop editor's handles crop
    if me.app.cropping_element_id.is_some()
        && let Some(r) = g.resize.take()
    {
        super::crop::drag_handle(me, &mut g, &r, p, mods);
        g.resize = Some(Resize { started: true, ..r });
        return Some(Gesture::Select(Box::new(g)));
    }
    // resizing / rotating
    if let Some(r) = &mut g.resize {
        if mods.alt
            && r.handle != HandleType::Rotation
            && !r.started
            && point_distance(g.origin, p) * me.app.zoom < DRAGGING_THRESHOLD
        {
            return Some(Gesture::Select(Box::new(g)));
        }
        r.started = true;
        let sel = me.selected_elements();
        let frames = sel.iter().any(|e| e.is_frame_like());
        if (frames && r.handle == HandleType::Rotation)
            || (sel.len() == 1 && sel[0].is_elbow_arrow())
        {
            return Some(Gesture::Select(Box::new(g)));
        }
        let grid = me.grid(mods);
        let [mut rx, mut ry] = get_grid_point(p[0] - r.offset[0], p[1] - r.offset[1], grid);
        let [gx, gy] = get_grid_point(p[0], p[1], grid);
        let drag_offset = [gx - g.origin_in_grid[0], gy - g.origin_in_grid[1]];
        let selected: Vec<&Element> = sel.clone();
        let originals: Vec<&Element> = selected
            .iter()
            .filter_map(|e| g.ds.original_elements.get(&e.id))
            .collect();
        let ctx = me.snap_ctx(false);
        let els: Vec<Element> = if g.snap.wants(&ctx, mods.snap(), &selected) {
            me.scene.non_deleted_elements().cloned().collect()
        } else {
            vec![]
        };
        g.snap.maybe_cache_reference_snap_points(
            &els,
            &selected,
            &ctx,
            &me.scene,
            mods.snap(),
            false,
        );
        let snap = snap_resizing_elements(
            &selected,
            &originals,
            &ctx,
            mods.snap(),
            drag_offset,
            Some(r.handle),
            &me.scene,
            &g.snap,
        );
        rx += snap.snap_offset[0];
        ry += snap.snap_offset[1];
        let snap_lines = snap.snap_lines;
        let proportional = selected.iter().any(|e| e.is_image())
            || (selected.len() == 1
                && selected[0].is_sticky_note()
                && r.handle.as_str().len() == 2);
        let ids = ids(&selected);
        let o = TransformOpts {
            rotate_with_discrete_angle: mods.shift,
            resize_from_center: mods.alt,
            maintain_aspect_ratio: if proportional {
                !mods.shift
            } else {
                mods.shift
            },
        };
        let (handle, center) = (r.handle, r.center);
        me.snap_lines = snap_lines;
        transform_elements(
            &g.ds.original_elements,
            handle,
            &ids,
            &mut me.scene,
            o,
            [rx, ry],
            center,
            &*m,
            &hooks,
        );
        if let Some(t) = &mut me.text {
            t.restyle = true;
        }
        return Some(Gesture::Select(Box::new(g)));
    }
    // the line editor's points
    if let Some(le) = me.linear.clone()
        && (g.linear_drag
            || le.initial_state.last_clicked_point > -1
            || le.initial_state.segment_midpoint.value.is_some()
            || le.dragged_focus_point_binding.is_some())
    {
        let ctx = crate::board::lctx(&me.app, &hooks, false);
        let ctx = LinearCtx {
            suggested_binding: None,
            ..ctx
        };
        // `arrowText.maybeDragLabel`: a grabbed label slides along its arrow
        if g.arrow_label && le.dragged_focus_point_binding.is_none() {
            if (le.is_dragging || point_distance(g.origin, p) >= DRAGGING_THRESHOLD / me.app.zoom)
                && let Some(l) = le.handle_bound_text_dragging(&mut me.scene, p)
            {
                me.set_linear(Some(l));
                g.dragged = true;
            }
            return Some(Gesture::Select(Box::new(g)));
        }
        let out = le.handle_drag(&mut me.scene, &ctx, p, &mods.linear());
        match out {
            DragOutcome::FocusPoint(l)
            | DragOutcome::Segment(l)
            | DragOutcome::MidpointAdded(l) => {
                me.set_linear(Some(l));
                g.dragged = true;
                return Some(Gesture::Select(Box::new(g)));
            }
            DragOutcome::Dragged(l, s) => {
                me.set_linear(Some(l));
                me.suggested = s;
                g.dragged = true;
                return Some(Gesture::Select(Box::new(g)));
            }
            DragOutcome::Ignored => return Some(Gesture::Select(Box::new(g))),
            DragOutcome::NotHandled => {}
        }
    }
    // dragging the selection
    let hit_selected = g
        .all_hit
        .iter()
        .any(|id| me.app.selected_element_ids.contains(id));
    let selecting_points = me.linear.as_ref().is_some_and(|l| l.is_editing)
        && mods.shift
        && g.hit.as_ref() == me.linear.as_ref().map(|l| &l.element_id);
    if (hit_selected || g.hit_common_bbox)
        && !selecting_points
        && !g.block_dragging
        && !g.box_select
    {
        let sel = me.selected_elements();
        if !sel.is_empty() && sel.iter().all(|e| e.locked) {
            return Some(Gesture::Select(Box::new(g)));
        }
        if mods.alt && !g.dragged && point_distance(g.origin, p) * me.app.zoom < DRAGGING_THRESHOLD
        {
            return Some(Gesture::Select(Box::new(g)));
        }
        let has_frame = sel.iter().any(|e| e.is_frame_like());
        let common_frame = super::super::frame::get_common_frame_id(&sel);
        let highlight = if has_frame {
            None
        } else {
            me.top_frame_at(p, &me.app.selected_element_ids)
                .filter(|f| Some(f) != common_frame.as_ref())
        };
        g.dragged = true;
        if sel.is_empty() || g.with_cmd {
            me.app.frame_to_highlight = highlight;
            return Some(Gesture::Select(Box::new(g)));
        }
        let mut off = [p[0] - g.drag_origin[0], p[1] - g.drag_origin[1]];
        if mods.shift {
            if off[0].abs() < off[1].abs() {
                off[0] = 0.;
            } else if off[0].abs() > off[1].abs() {
                off[1] = 0.;
            }
        }
        // with the selection borrowed: its ids and the snap (the crop editor
        // takes a drag on the image it crops before any snapping)
        let ids_v = ids(&sel);
        let crop = me.app.cropping_element_id.is_some() && g.hit == me.app.cropping_element_id;
        let snap = (!crop).then(|| snap_step(me, &mut g, &sel, &ids_v, off, mods));
        drop(sel);
        me.app.frame_to_highlight = highlight;
        if crop && super::crop::drag_image(me, &mut g, off) {
            return Some(Gesture::Select(Box::new(g)));
        }
        let snap = snap.unwrap_or_else(|| {
            let sel = me.selected_elements();
            snap_step(me, &mut g, &sel, &ids_v, off, mods)
        });
        me.snap_lines = snap.snap_lines;
        let grid = me.grid(mods);
        drag_selected_elements(
            &g.ds,
            &ids_v,
            off,
            &mut me.scene,
            snap.snap_offset,
            grid,
            &hooks,
        );
        if mods.alt && !g.duplicated {
            duplicate_dragged(me, &mut g, p);
        }
        return Some(Gesture::Select(Box::new(g)));
    }
    // box selection (alt: the lasso)
    if me.app.active_tool.ty == ToolType::Selection {
        if mods.alt && g.hit.is_none() {
            let mut t = LassoTrail::default();
            t.start_path(g.origin[0], g.origin[1], mods.shift);
            me.app.active_tool =
                super::super::actions::update_active_tool(&me.app, ToolType::Lasso);
            me.app.active_tool.from_selection = true;
            return Some(Gesture::Lasso(super::lasso::LassoGesture {
                trail: t,
                from_selection: true,
            }));
        }
        g.box_select = true;
        let rect = [
            g.origin[0].min(p[0]),
            g.origin[1].min(p[1]),
            g.origin[0].max(p[0]),
            g.origin[1].max(p[1]),
        ];
        g.rect = Some(rect);
        box_select(me, &g, rect, mods);
    }
    cx.notify();
    Some(Gesture::Select(Box::new(g)))
}

/// The drag's snap: the snap caches are built (and the scene copied for
/// them) on the first step only.
fn snap_step(
    me: &BoardView,
    g: &mut SelectGesture,
    sel: &[&Element],
    ids_v: &[String],
    off: [f64; 2],
    mods: Mods,
) -> SnapResult {
    let ctx = me.snap_ctx(true);
    if !is_snapping_enabled(&ctx, mods.snap(), sel) {
        return SnapResult::default();
    }
    let els: Vec<Element> = if g.snap.wants(&ctx, mods.snap(), sel) {
        me.scene.non_deleted_elements().cloned().collect()
    } else {
        vec![]
    };
    g.snap
        .maybe_cache_visible_gaps(&els, sel, &ctx, &me.scene, mods.snap(), false);
    g.snap
        .maybe_cache_reference_snap_points(&els, sel, &ctx, &me.scene, mods.snap(), false);
    let originals: Vec<&Element> = ids_v
        .iter()
        .filter_map(|id| g.ds.original_elements.get(id))
        .collect();
    snap_dragged_elements(&originals, off, &ctx, mods.snap(), &me.scene, &g.snap)
}

/// `handleBoxSelectionOnPointerMove`.
fn box_select(me: &mut BoardView, g: &SelectGesture, rect: [f64; 4], mods: Mods) {
    if let Some(le) = me.linear.clone().filter(|l| l.is_editing) {
        if let Some(l) = le.handle_box_selection(rect, mods.shift, &me.scene) {
            me.set_linear(Some(l));
        }
        return;
    }
    let els = me.scene.elements_including_deleted();
    let mut reuse = true;
    if !mods.shift && !me.app.selected_element_ids.is_empty() {
        if g.with_cmd
            && let Some(h) = &g.hit
        {
            select_groups_for_selected_elements(
                &BTreeSet::from([h.clone()]),
                me.app.editing_group_id.as_deref(),
                els,
            )
            .apply(&mut me.app);
        } else {
            reuse = false;
        }
    }
    let sel_el = super::super::new_element::new_element(
        super::super::types::ElementType::Selection,
        super::super::new_element::ElementOpts {
            width: rect[2] - rect[0],
            height: rect[3] - rect[1],
            ..super::super::new_element::ElementOpts::at(rect[0], rect[1])
        },
    );
    let within: Vec<String> = get_elements_within_selection(
        els,
        &sel_el,
        &me.scene,
        false,
        super::super::bounds::BBoxMode::Contain,
    )
    .iter()
    .map(|e| e.id.clone())
    .collect();
    let mut next: BTreeSet<String> = if reuse {
        me.app.selected_element_ids.clone()
    } else {
        BTreeSet::new()
    };
    next.extend(within.iter().cloned());
    if let Some(h) = &g.hit {
        if within.is_empty() {
            next.insert(h.clone());
        } else {
            next.remove(h);
        }
    }
    let editing = if reuse {
        me.app.editing_group_id.clone()
    } else {
        None
    };
    select_groups_for_selected_elements(&next, editing.as_deref(), els).apply(&mut me.app);
    let lone_linear = (within.len() == 1)
        .then(|| {
            me.scene
                .get_element(&within[0])
                .filter(|e| e.is_linear())
                .map(|e| e.id.clone())
        })
        .flatten();
    let l = lone_linear.and_then(|id| LinearElementEditor::new(&id, &mut me.scene, false));
    me.set_linear(l);
}

/// `duplicateDraggedSelection`: the originals go back where they were; the
/// duplicates, selected, carry on with the drag.
fn duplicate_dragged(me: &mut BoardView, g: &mut SelectGesture, p: [f64; 2]) {
    g.duplicated = true;
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let els = me.scene.elements_including_deleted().to_vec();
    let mut sel: Vec<String> = get_selected_elements(
        &els,
        &me.app.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            include_elements_in_frames: true,
        },
    )
    .iter()
    .map(|e| e.id.clone())
    .collect();
    if let Some(h) = &g.hit
        && g.was_added
        && !sel.contains(h)
    {
        sel.push(h.clone());
    }
    let set: FxHashSet<String> = sel.iter().cloned().collect();
    let mode = super::super::duplicate::DuplicateMode::InPlace {
        ids: &set,
        editing_group_id: me.app.editing_group_id.as_deref(),
        selected_group_ids: &me.app.selected_group_ids,
    };
    let mut over = |dup: &mut Element, orig: &Element, _: &FxHashMap<String, String>| {
        if dup.frame_id.is_none() {
            dup.frame_id = orig.frame_id.clone();
        }
        dup.seed = super::super::random::random_integer();
    };
    let d = super::super::duplicate::duplicate_elements(&els, mode, true, Some(&mut over), &hooks);
    if d.duplicated_elements.is_empty() {
        return;
    }
    let next: Vec<Element> = d
        .elements_with_duplicates
        .into_iter()
        .map(|mut e| {
            if set.contains(&e.id)
                && let Some(o) = g.ds.original_elements.get(&e.id)
            {
                (e.x, e.y) = (o.x, o.y);
            }
            e
        })
        .collect();
    let dup_ids: Vec<String> = d.duplicated_elements.iter().map(|e| e.id.clone()).collect();
    g.hit = g
        .hit
        .as_ref()
        .and_then(|h| d.orig_id_to_duplicate_id.get(h).cloned());
    g.all_hit = g
        .all_hit
        .iter()
        .filter_map(|h| d.orig_id_to_duplicate_id.get(h).cloned())
        .collect();
    g.drag_origin = p;
    me.scene.replace_all_elements(next);
    let targets: Vec<&Element> = dup_ids
        .iter()
        .filter_map(|id| me.scene.get_non_deleted_element(id))
        .collect();
    get_selection_state_for_elements(
        &targets,
        me.scene.elements_including_deleted(),
        &me.app,
        false,
    )
    .apply(&mut me.app);
    me.sync_linear();
    for e in &d.duplicated_elements {
        if let Some(x) = me.scene.get_element(&e.id) {
            g.ds.original_elements.insert(e.id.clone(), x.clone());
        }
    }
    for id in &sel {
        if me.scene.get_element(id).is_some_and(|e| {
            e.bound_elements.as_ref().is_some_and(|b| {
                b.iter()
                    .any(|b| b.kind == super::super::types::BoundType::Arrow)
            })
        }) {
            super::super::binding::update_bound_elements(
                id,
                &mut me.scene,
                &Default::default(),
                &hooks,
            );
        }
    }
    g.snap.destroy();
}

/// The pointer came up: `onPointerUpFromPointerDownHandler`'s selection
/// share.
pub fn up(
    me: &mut BoardView,
    g: SelectGesture,
    p: [f64; 2],
    mods: Mods,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let hit = g.hit.clone();
    // a press outside the image being cropped ends the crop editor
    let was_cropping = std::mem::replace(&mut me.app.is_cropping, false);
    if let Some(c) = me.app.cropping_element_id.clone() {
        let out = match &hit {
            None => !was_cropping && g.resize.is_none(),
            Some(h) => *h != c,
        };
        if out {
            super::crop::finish(me, cx);
        }
    }
    // a click on the selection, not dragged: capture a selection change
    if !g.box_select
        && g.resize.is_none()
        && !g
            .all_hit
            .iter()
            .any(|id| me.app.selected_element_ids.contains(id))
        && me.text.is_none()
    {
        me.store.schedule_capture();
    }
    // elbow arrows bound to a dragged element reroute
    if g.dragged
        && let Some(h) = &hit
        && let Some(e) = me
            .scene
            .get_element(h)
            .filter(|e| e.is_bindable(false))
            .cloned()
    {
        for b in e
            .bound_elements
            .iter()
            .flatten()
            .filter(|b| b.kind == super::super::types::BoundType::Arrow)
        {
            if me
                .scene
                .get_element(&b.id)
                .is_some_and(|a| a.is_elbow_arrow())
            {
                super::super::binding::mutate_elbow_arrow(
                    &mut me.scene,
                    &b.id,
                    &Default::default(),
                    &Default::default(),
                    &hooks,
                );
            }
        }
    }
    // the line editor
    let mut linear_done = false;
    if let Some(le) = me.linear.clone() {
        let ctx = LinearCtx {
            suggested_binding: None,
            ..crate::board::lctx(&me.app, &hooks, false)
        };
        if le.is_editing && le.dragged_focus_point_binding.is_none() {
            if !g.box_select && hit.as_ref() != Some(&le.element_id) {
                // `actionFinalize`
                let (_, next) = linear::finalize_element(
                    &le.element_id,
                    Some(&le),
                    &Default::default(),
                    &mut me.scene,
                    &ctx,
                );
                me.set_linear(next.map(|n| LinearElementEditor {
                    is_editing: false,
                    ..n
                }));
            } else {
                let ptr = FinalizePointer {
                    scene_coords: p,
                    mods: mods.linear(),
                    hit_bound_text: g.arrow_label,
                };
                let (next, deleted) =
                    linear::finalize_linear_gesture(&le, &mut me.scene, &ctx, &ptr, false);
                let keep = next.map(|n| LinearElementEditor {
                    is_editing: true,
                    selected_points_indices: le
                        .handle_pointer_up(mods.shift, me.app.zoom, &mut me.scene, &hooks)
                        .selected_points_indices,
                    ..n
                });
                if deleted {
                    me.clear_selection();
                    me.set_linear(None);
                } else {
                    me.set_linear(keep);
                }
            }
            linear_done = true;
        } else {
            if le.dragged_focus_point_binding.is_some() {
                let l = le.handle_focus_point_pointer_up(&mut me.scene);
                me.set_linear(Some(LinearElementEditor {
                    dragged_focus_point_binding: None,
                    ..l
                }));
                linear_done = true;
            } else if hit.as_ref() != Some(&le.element_id) {
                if me.selected_elements().len() > 1 {
                    me.set_linear(None);
                }
            } else if le.is_dragging {
                let ptr = FinalizePointer {
                    scene_coords: p,
                    mods: mods.linear(),
                    hit_bound_text: g.arrow_label,
                };
                let (next, deleted) = linear::finalize_linear_gesture(
                    &LinearElementEditor {
                        is_dragging: true,
                        ..le.clone()
                    },
                    &mut me.scene,
                    &ctx,
                    &ptr,
                    false,
                );
                if deleted {
                    me.clear_selection();
                    me.set_linear(None);
                } else {
                    me.set_linear(next);
                }
                linear_done = true;
            } else if g.linear_drag {
                let l = le.handle_pointer_up(mods.shift, me.app.zoom, &mut me.scene, &hooks);
                me.set_linear(Some(l));
            }
            if le.elbowed
                && let Some(_) = me.scene.get_element(&le.element_id)
            {
                super::super::binding::mutate_elbow_arrow(
                    &mut me.scene,
                    &le.element_id,
                    &Default::default(),
                    &Default::default(),
                    &hooks,
                );
            }
        }
        me.suggested = None;
    }
    // dropped into / out of frames
    if g.dragged && !g.linear_drag && !linear_done {
        let sel = me.selected_elements();
        let common = super::super::frame::get_common_frame_id(&sel);
        let exclude = me.app.selected_element_ids.clone();
        let _ = common;
        let top = me.top_frame_at(p, &exclude);
        let mut all = me.scene.elements_including_deleted().to_vec();
        let fs = super::super::frame::FrameState::new(&me.app, false);
        if super::super::frame::drop_selection_into_frame(&mut all, top.as_deref(), &fs) {
            me.scene.replace_all_elements(all);
        }
    }
    if let Some(r) = &g.resize
        && r.started
    {
        me.store.schedule_capture();
        let mut all = me.scene.elements_including_deleted().to_vec();
        let fs = super::super::frame::FrameState::new(&me.app, false);
        super::super::frame::update_frame_membership_of_selected_elements(&mut all, &fs);
        let frames: Vec<String> = me
            .selected_elements()
            .iter()
            .filter(|e| e.is_frame_like())
            .map(|e| e.id.clone())
            .collect();
        for f in frames {
            let Some(frame) = all.iter().find(|e| e.id == f).cloned() else {
                continue;
            };
            let gs = super::super::groups::GroupSelection::of(&me.app);
            let inside: Vec<String> =
                super::super::frame::get_elements_in_resizing_frame(&all, &frame, &gs, &me.scene)
                    .iter()
                    .map(|e| e.id.clone())
                    .collect();
            super::super::frame::replace_all_elements_in_frame(&mut all, &inside, &f);
        }
        me.scene.replace_all_elements(all);
    }
    // a lone line or arrow clicked gets its editor
    if let Some(h) = &hit
        && me.linear.as_ref().is_none_or(|l| &l.element_id != h)
        && me.scene.get_element(h).is_some_and(|e| e.is_linear())
        && me.selected_elements().len() == 1
        && !g.duplicated
    {
        let l = LinearElementEditor::new(h, &mut me.scene, false);
        me.set_linear(l);
    }
    // `handleSelectionOnPointerUp`
    let editing_line = me.linear.as_ref().is_some_and(|l| l.is_editing);
    if let Some(h) = &hit
        && !g.dragged
        && !g.was_added
        && (!editing_line || !g.box_select)
        && me.app.active_tool.ty != ToolType::Lasso
    {
        if mods.shift && !editing_line {
            if me.app.selected_element_ids.contains(h) {
                remove(me, std::slice::from_ref(h));
            } else if let Some(f) = me
                .scene
                .get_element(h)
                .and_then(|e| e.frame_id.clone())
                .filter(|f| me.app.selected_element_ids.contains(f))
            {
                let mut next = me.app.selected_element_ids.clone();
                next.insert(h.clone());
                next.remove(&f);
                select_groups_for_selected_elements(
                    &next,
                    me.app.editing_group_id.as_deref(),
                    me.scene.elements_including_deleted(),
                )
                .apply(&mut me.app);
            } else {
                me.app.selected_element_ids.insert(h.clone());
            }
        } else {
            select_only(me, std::slice::from_ref(h), false);
        }
    }
    let hit_el = hit.as_ref().and_then(|h| me.scene.get_element(h)).cloned();
    let box_only = |me: &BoardView, e: &Element| {
        let mut a =
            super::super::collision::HitTestArgs::new(g.origin, e, me.hit_threshold(e), &me.scene);
        a.frame_name_bound = None;
        super::super::collision::hit_element_bounding_box_only(&a)
    };
    if me.app.active_tool.ty != ToolType::Lasso
        && !hit_el.as_ref().is_some_and(|e| e.is_elbow_arrow())
        && !g.dragged
        && g.resize.as_ref().is_none_or(|r| !r.started)
        && ((hit_el.as_ref().is_some_and(|e| box_only(me, e)))
            || (hit_el.is_none() && g.hit_common_bbox))
    {
        if me.linear.as_ref().is_some_and(|l| l.is_editing) {
            if let Some(l) = me.linear.clone() {
                me.set_linear(Some(linear::toggle_linear_editor(&l)));
            }
        } else {
            me.clear_selection();
            me.set_linear(None);
        }
        me.commit(Some(CaptureUpdateAction::Immediately), cx);
        return;
    }
    // a click on a lone selected text (or a selected container's label): edit it
    if me.app.active_tool.ty == ToolType::Selection
        && me.text.is_none()
        && !g.dragged
        && !g.was_added
        && !mods.shift
        && !mods.ctrl_or_cmd()
        && !mods.alt
        && let Some(h) = &hit_el
    {
        let sel = me.selected_elements();
        let lone = sel.len() == 1 && sel[0].id == h.id;
        let container =
            if lone && !h.is_text() && super::super::text::is_valid_text_container(h.ty()) {
                let t = h
                    .bound_text_id()
                    .and_then(|id| me.scene.get_non_deleted_element(id))
                    .map(|t| t.id.clone());
                let hit_text = me
                    .element_at(p, true, false)
                    .filter(|e| e.is_text())
                    .map(|e| e.id.clone());
                (t.is_some() && t == hit_text).then(|| h.id.clone())
            } else {
                None
            };
        if (h.is_text() && lone) || container.is_some() {
            super::text::start_editing(me, p, container, true, Some(p), window, cx);
            return;
        }
    }
    let capture = me.app.active_tool.ty != ToolType::Selection
        || !me.app.selected_element_ids.is_empty()
        || me.app.previous_selected_element_ids != me.app.selected_element_ids;
    if (g.dragged || g.resize.as_ref().is_some_and(|r| r.started))
        && (me.linear.is_none() || g.resize.is_some())
    {
        {
            let arrows: Vec<String> = me
                .selected_elements()
                .iter()
                .filter(|e| e.is_arrow())
                .map(|e| e.id.clone())
                .collect();
            let ctx = super::super::binding::BindingCtx {
                hooks: &hooks,
                ..super::super::binding::BindingCtx::from_app(&me.app)
            };
            super::super::binding::bind_or_unbind_binding_elements(&arrows, &mut me.scene, &ctx);
        }
    }
    let fs = me.app.active_tool.from_selection;
    if me.app.active_tool.ty == ToolType::Lasso && fs {
        me.app.active_tool =
            super::super::actions::update_active_tool(&me.app, ToolType::Selection);
    }
    me.commit(
        Some(if capture && me.text.is_none() {
            CaptureUpdateAction::Immediately
        } else {
            CaptureUpdateAction::Eventually
        }),
        cx,
    );
}

/// `getTextBindableContainerAtPosition`.
pub fn text_container_at(me: &BoardView, p: [f64; 2]) -> Option<String> {
    let sel = me.selected_elements();
    if sel.len() == 1 {
        return sel[0]
            .is_text_bindable_container(false)
            .then(|| sel[0].id.clone());
    }
    for e in me.scene.non_deleted_elements().rev() {
        let [x1, y1, x2, y2, ..] =
            super::super::bounds::get_element_absolute_coords(e, &me.scene, false);
        let hit = if e.is_arrow() {
            super::super::collision::hit_element_itself(&super::super::collision::HitTestArgs::new(
                p,
                e,
                me.hit_threshold(e),
                &me.scene,
            ))
        } else {
            x1 < p[0] && p[0] < x2 && y1 < p[1] && p[1] < y2
        };
        if hit {
            return e.is_text_bindable_container(false).then(|| e.id.clone());
        }
    }
    None
}

/// `arrowText.isBoundTextGrabbable`: the pointer is on the arrow's label
/// and nothing stacked above the arrow is hit there.
pub fn bound_text_grabbable(me: &BoardView, e: &Element, p: [f64; 2]) -> bool {
    if !e.is_arrow() || !super::super::collision::hit_element_bound_text(p, e, &me.scene) {
        return false;
    }
    let hits = me.elements_at(p, false, false);
    let Some(i) = hits.iter().position(|h| h.id == e.id) else {
        return false;
    };
    !hits[i + 1..].iter().any(|h| me.hit_element(p, h, false))
}

/// `handleCanvasDoubleClick`.
pub fn double_click(
    me: &mut BoardView,
    p: [f64; 2],
    mods: Mods,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    // the frame name (upstream's name element takes its own double-click)
    if me.text.is_none()
        && let Some(f) = super::super::frame_name::frame_name_at(me, me.pointer)
    {
        super::super::frame_name::begin(me, &f, window, cx);
        return;
    }
    if me.text.is_some() || (mods.alt && me.app.cropping_element_id.is_none()) || me.multi.is_some()
    {
        return;
    }
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let sel: Vec<Element> = me.selected_elements().into_iter().cloned().collect();
    if sel.len() == 1 && sel[0].is_linear() {
        let e = &sel[0];
        let editing_this = me
            .linear
            .as_ref()
            .is_some_and(|l| l.is_editing && l.element_id == e.id);
        if ((mods.ctrl_or_cmd() && e.is_simple_arrow()) || e.is_line()) && !editing_this {
            let l = me
                .linear
                .clone()
                .filter(|l| l.element_id == e.id)
                .or_else(|| LinearElementEditor::new(&e.id, &mut me.scene, false));
            me.set_linear(l.map(|l| linear::toggle_linear_editor(&l)));
            me.commit(Some(CaptureUpdateAction::Immediately), cx);
            return;
        } else if e.is_elbow_arrow()
            && let Some(le) = me.linear.clone()
        {
            let ctx = crate::board::lctx(&me.app, &hooks, false);
            if let linear::DoubleClickOutcome::SegmentReleased(l) =
                le.handle_double_click(&mut me.scene, &ctx, p, &mods.linear())
            {
                me.store.schedule_capture();
                me.set_linear(Some(l));
                me.commit(None, cx);
                return;
            }
        } else if editing_this && e.is_line() {
            return;
        }
    }
    // an image: its crop editor (a crop handle: uncrop that side)
    if sel.len() == 1 && sel[0].is_image() {
        let h = handle_at(me, p).map(|(_, h)| h);
        if !super::crop::maybe_uncrop_sides(me, &sel[0].id, h, mods.alt, cx) {
            super::crop::start(me, &sel[0].id, cx);
        }
        return;
    }
    // into a selected group
    if !get_selected_group_ids(&me.app.selected_group_ids).is_empty()
        && let Some(h) = me.element_at(p, false, false).cloned()
        && let Some(gid) =
            get_selected_group_id_for_element(&h, &me.app.selected_group_ids).map(str::to_owned)
    {
        me.store.schedule_capture();
        select_groups_for_selected_elements(
            &BTreeSet::from([h.id.clone()]),
            Some(&gid),
            me.scene.elements_including_deleted(),
        )
        .apply(&mut me.app);
        me.sync_linear();
        me.commit(None, cx);
        return;
    }
    if me.linear.as_ref().is_some_and(|l| l.is_editing) {
        return;
    }
    // text: in the container, on the text, or new at the pointer
    let container = if mods.ctrl_or_cmd() {
        None
    } else if sel.len() == 1 {
        sel[0]
            .is_text_bindable_container(false)
            .then(|| sel[0].id.clone())
    } else {
        text_container_at(me, p)
    };
    let mut at = p;
    if let Some(c) = container
        .as_ref()
        .and_then(|c| me.scene.get_element(c))
        .cloned()
    {
        let itself = super::super::collision::hit_element_itself(
            &super::super::collision::HitTestArgs::new(p, &c, me.hit_threshold(&c), &me.scene),
        );
        if c.has_bound_text() || !super::super::utils::is_transparent(&c.background_color) || itself
        {
            at = super::super::text::get_container_center(&c, &me.scene);
        }
    }
    super::text::start_editing(me, at, container, true, None, window, cx);
}

/// `handleCanvasPointerMove` for the selection tool: the line editor's hover,
/// and the cursor.
pub fn hover(
    me: &mut BoardView,
    p: [f64; 2],
    mods: Mods,
    cx: &mut Context<BoardView>,
) -> CursorStyle {
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    if let Some(le) = me.linear.clone() {
        let mut l = le.clone();
        if le.is_editing {
            let ctx = crate::board::lctx(&me.app, &hooks, false);
            if let Some(n) =
                le.handle_pointer_move_in_edit_mode(&mut me.scene, &ctx, p, &mods.linear())
            {
                l = n;
            }
        }
        if let Some(e) = me.scene.get_non_deleted_element(&le.element_id).cloned() {
            l.hover_point_index =
                linear::get_point_index_under_cursor(&e, &me.scene, me.app.zoom, p);
            l.segment_mid_point_hovered_coords =
                le.get_segment_midpoint_hit_coords(p, me.app.zoom, le.is_editing, &me.scene);
            l.hovered_focus_point_binding = if e.is_binding_element(false) {
                linear::handle_focus_point_hover(
                    &e,
                    p,
                    &me.scene,
                    me.app.is_binding_enabled,
                    me.app.zoom,
                )
            } else {
                None
            };
            let show = l.hover_point_index >= 0
                || l.segment_mid_point_hovered_coords.is_some()
                || l.hovered_focus_point_binding.is_some();
            let changed = l.hover_point_index != le.hover_point_index
                || l.segment_mid_point_hovered_coords != le.segment_mid_point_hovered_coords
                || l.hovered_focus_point_binding != le.hovered_focus_point_binding;
            me.linear = Some(l);
            if changed {
                cx.notify();
            }
            if show {
                return CursorStyle::PointingHand;
            }
            if bound_text_grabbable(me, &e, p) {
                return CursorStyle::OpenHand;
            }
        }
    }
    if let Some((el, h)) = handle_at(me, p) {
        let e = el.and_then(|id| me.scene.get_element(&id).cloned());
        if h == HandleType::Rotation {
            return CursorStyle::PointingHand;
        }
        return css_cursor(&get_cursor_for_resizing_element(e.as_ref(), Some(h)));
    }
    if hits_selection_box(me, p) {
        return CursorStyle::Arrow;
    }
    if me.element_at(p, false, false).is_some() {
        return CursorStyle::Arrow;
    }
    CursorStyle::Arrow
}
