// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The lasso, after Excalidraw `lasso/index.ts` and the lasso branches of
//! `App.tsx` @ 3a317b5: the trail selects what it encloses or crosses
//! (core `lasso.rs`); Shift keeps the previous selection. Started from the
//! selection tool with Alt (or ⌥⌘ on an element), it goes back on release.

use super::super::BoardView;
use super::super::app_state::ToolType;
use super::super::canvas::{Gesture, Mods};
use super::super::history::CaptureUpdateAction;
use super::super::lasso::{BoxSelectionMode, LassoTrail};
use super::super::linear::LinearElementEditor;
use super::super::types::Element;
use gpui::Context;

pub struct LassoGesture {
    pub trail: LassoTrail,
    pub from_selection: bool,
}

/// The elements the lasso looks at: visible ones, and the scene.
fn sets(me: &BoardView) -> (Vec<Element>, Vec<Element>) {
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
    (visible, all)
}

pub fn drag(
    me: &mut BoardView,
    mut g: LassoGesture,
    p: [f64; 2],
    mods: Mods,
    cx: &mut Context<BoardView>,
) -> Option<Gesture> {
    let (visible, all) = sets(me);
    let v = me.viewport();
    let prev = me.app.previous_selected_element_ids.clone();
    let s = g.trail.add_point_to_path(
        p[0],
        p[1],
        mods.shift,
        &visible,
        &all,
        (v.scroll_x, v.scroll_y, v.zoom),
        BoxSelectionMode::Contain,
        &prev,
        me.app.editing_group_id.as_deref(),
    );
    me.app.selected_element_ids = s.selected_element_ids;
    me.app.selected_group_ids = s.selected_group_ids;
    let l = s
        .selected_linear_element
        .and_then(|id| LinearElementEditor::new(&id, &mut me.scene, false));
    me.set_linear(l);
    cx.notify();
    Some(Gesture::Lasso(g))
}

pub fn up(me: &mut BoardView, mut g: LassoGesture, cx: &mut Context<BoardView>) {
    g.trail.end_path();
    if g.from_selection || me.app.active_tool.from_selection {
        me.app.active_tool =
            super::super::actions::update_active_tool(&me.app, ToolType::Selection);
    }
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}
