// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Frame actions. Port of Excalidraw `packages/excalidraw/actions/actionFrame.ts`
//! @ 3a317b5: select all in frame, remove all from frame, toggle frame
//! rendering, wrap the selection in a frame (or unwrap). Labels and
//! predicates for menus are plain functions too.

use super::ActionResult;
use crate::board::app_state::AppState;
use crate::board::binding::fix_bindings_after_deletion;
use crate::board::bounds::{bounds_contain_bounds, get_common_bounds, get_element_bounds};
use crate::board::frame::{
    add_elements_to_frame, get_frame_children, remove_all_elements_from_frame,
};
use crate::board::history::CaptureUpdateAction;
use crate::board::new_element::{ElementOpts, new_frame_element};
use crate::board::selection::{
    SelectedOpts, get_selected_elements, get_selection_state_for_elements,
};
use crate::board::types::Element;
use crate::board::utils::{ElementsMap, array_to_map};
use std::collections::BTreeSet;

fn selected<'a>(elements: &'a [Element], a: &AppState) -> Vec<&'a Element> {
    get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default())
}

/// `isSingleFrameSelected`: predicate of the two frame-menu actions.
pub fn is_single_frame_selected(elements: &[Element], a: &AppState) -> bool {
    let s = selected(elements, a);
    s.len() == 1 && s[0].is_frame_like()
}

/// `actionSelectAllElementsInFrame`.
pub fn action_select_all_elements_in_frame(elements: &[Element], a: &AppState) -> ActionResult {
    let Some(frame) = selected(elements, a)
        .first()
        .copied()
        .filter(|e| e.is_frame_like())
    else {
        return ActionResult::none();
    };
    let ids: BTreeSet<String> = get_frame_children(elements, &frame.id)
        .into_iter()
        .filter(|e| !e.is_deleted && !(e.is_text() && e.container_id().is_some()))
        .map(|e| e.id.clone())
        .collect();
    let mut next = a.clone();
    next.selected_element_ids = ids;
    ActionResult::new(None, Some(next), CaptureUpdateAction::Immediately)
}

/// `actionRemoveAllElementsFromFrame`.
pub fn action_remove_all_elements_from_frame(elements: &[Element], a: &AppState) -> ActionResult {
    let Some(frame) = selected(elements, a)
        .first()
        .copied()
        .filter(|e| e.is_frame_like())
    else {
        return ActionResult::none();
    };
    let id = frame.id.clone();
    let mut next = elements.to_vec();
    remove_all_elements_from_frame(&mut next, &id);
    let mut s = a.clone();
    s.selected_element_ids = BTreeSet::from([id]);
    ActionResult::new(Some(next), Some(s), CaptureUpdateAction::Immediately)
}

/// `actionupdateFrameRendering`: toggles `frameRendering.enabled`.
pub fn action_update_frame_rendering(a: &AppState) -> ActionResult {
    let mut s = a.clone();
    s.frame_rendering.enabled = !s.frame_rendering.enabled;
    ActionResult::new(None, Some(s), CaptureUpdateAction::Eventually)
}

pub const FRAME_PADDING: f64 = 16.;

/// `getFrameToUnwrap`: the one frame the selection holds (with any of its
/// children), or, with no frame selected, the frame whose children are all
/// selected.
pub fn get_frame_to_unwrap<'a>(
    selected: &[&Element],
    map: &'a dyn ElementsMap,
    all: &[Element],
) -> Option<&'a Element> {
    let els: Vec<&&Element> = selected
        .iter()
        .filter(|e| !e.is_bound_to_container())
        .collect();
    let frames: Vec<&&&Element> = els.iter().filter(|e| e.is_frame_like()).collect();
    if frames.len() > 1 {
        return None;
    }
    let fid = frames
        .first()
        .map(|f| f.id.clone())
        .or_else(|| els.first().and_then(|e| e.frame_id.clone()))?;
    let frame = map
        .get_element(&fid)
        .filter(|f| !f.is_deleted && f.is_frame_like())?;
    let children = els
        .iter()
        .filter(|e| e.frame_id.as_deref() == Some(frame.id.as_str()))
        .count();
    if children + frames.len() != els.len() {
        return None;
    }
    if !frames.is_empty() {
        return Some(frame);
    }
    let all_children = get_frame_children(all, &frame.id)
        .into_iter()
        .filter(|e| !e.is_deleted && !e.is_bound_to_container())
        .count();
    (all_children == children).then_some(frame)
}

/// `unwrapFrame`: deletes the frame, its children selected in its place.
pub fn unwrap_frame(elements: &[Element], a: &AppState, frame_id: &str) -> ActionResult {
    let children: Vec<String> = get_frame_children(elements, frame_id)
        .into_iter()
        .filter(|e| !e.is_deleted)
        .map(|e| e.id.clone())
        .collect();
    let mut next = elements.to_vec();
    remove_all_elements_from_frame(&mut next, frame_id);
    let Some(i) = next.iter().position(|e| e.id == frame_id) else {
        return ActionResult::none();
    };
    crate::board::mutate::mutate_element(&mut next[i], |e| e.is_deleted = true);
    let frame = next[i].clone();
    fix_bindings_after_deletion(&mut next, &[frame]);
    let live: Vec<Element> = next.iter().filter(|e| !e.is_deleted).cloned().collect();
    let kids: Vec<&Element> = children
        .iter()
        .filter_map(|id| live.iter().find(|e| &e.id == id))
        .collect();
    let mut s = a.clone();
    s.editing_group_id = None;
    let sel = get_selection_state_for_elements(&kids, &live, &s, false);
    let mut out = a.clone();
    sel.apply(&mut out);
    ActionResult::new(Some(next), Some(out), CaptureUpdateAction::Immediately)
}

/// `wrapInFrame`: a new frame around the selection (edge to edge around an
/// image holding the rest), taking it in; a partially selected edited group
/// loses the selected part.
pub fn wrap_in_frame(elements: &[Element], a: &AppState, selected_ids: &[String]) -> ActionResult {
    let map = array_to_map(elements);
    let sel: Vec<&Element> = selected_ids
        .iter()
        .filter_map(|id| map.get(id.as_str()).copied())
        .collect();
    let b = get_common_bounds(sel.iter().copied(), &map);
    let pad = if sel
        .iter()
        .any(|e| e.is_image() && bounds_contain_bounds(get_element_bounds(e, &map, false), b))
    {
        0.
    } else {
        FRAME_PADDING
    };
    let frame = new_frame_element(
        ElementOpts {
            x: b[0] - pad,
            y: b[1] - pad,
            width: b[2] - b[0] + pad * 2.,
            height: b[3] - b[1] + pad * 2.,
            ..Default::default()
        },
        None,
    );
    let fid = frame.id.clone();
    let mut next = elements.to_vec();
    if let Some(g) = &a.editing_group_id {
        for e in next.iter_mut().filter(|e| selected_ids.contains(&e.id)) {
            if let Some(i) = e.group_ids.iter().position(|x| x == g) {
                crate::board::mutate::mutate_element(e, |e| e.group_ids.truncate(i));
            }
        }
    }
    next.push(frame);
    add_elements_to_frame(&mut next, selected_ids, &fid);
    let live: Vec<Element> = next.iter().filter(|e| !e.is_deleted).cloned().collect();
    let f = live.iter().find(|e| e.id == fid).unwrap();
    let mut out = a.clone();
    get_selection_state_for_elements(&[f], &live, a, false).apply(&mut out);
    ActionResult::new(Some(next), Some(out), CaptureUpdateAction::Immediately)
}

/// `actionWrapSelectionInFrame`'s predicate: something selected, no frames.
pub fn can_wrap_selection_in_frame(elements: &[Element], a: &AppState) -> bool {
    let s = selected(elements, a);
    !s.is_empty() && !s.iter().any(|e| e.is_frame_like())
}

/// `actionWrapSelectionInFrame`: wraps the selection in a frame, or, when it
/// is all of a frame's children (or the frame), removes that frame.
pub fn action_wrap_selection_in_frame(elements: &[Element], a: &AppState) -> ActionResult {
    let s = selected(elements, a);
    let live: Vec<Element> = elements.iter().filter(|e| !e.is_deleted).cloned().collect();
    let map = array_to_map(&live);
    if let Some(f) = get_frame_to_unwrap(&s, &map, elements) {
        return unwrap_frame(elements, a, &f.id.clone());
    }
    let ids: Vec<String> = s.iter().map(|e| e.id.clone()).collect();
    wrap_in_frame(elements, a, &ids)
}
