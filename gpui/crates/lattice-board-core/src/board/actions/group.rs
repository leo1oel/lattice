// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionGroup.tsx` @ 3a317b5:
//! group (Cmd+G) and ungroup (Cmd+Shift+G).

use super::ActionResult;
use crate::board::app_state::AppState;
use crate::board::fractional_index::sync_moved_indices;
use crate::board::frame::{
    frame_and_children_selected_together, get_elements_in_resizing_frame,
    remove_elements_from_frame, replace_all_elements_in_frame,
};
use crate::board::groups::*;
use crate::board::history::CaptureUpdateAction;
use crate::board::mutate::new_element_with;
use crate::board::random::random_id;
use crate::board::selection::{SelectedOpts, get_selected_elements};
use crate::board::types::Element;
use rustc_hash::FxHashSet;
use std::collections::BTreeMap;

/// `allElementsInSameGroup`: they share a group below the edited one.
fn all_elements_in_same_group(elements: &[&Element], editing_group_id: Option<&str>) -> bool {
    if elements.len() < 2 {
        return false;
    }
    let g = &elements[0].group_ids;
    let g = match editing_group_id.and_then(|ed| g.iter().position(|x| x == ed)) {
        Some(i) => &g[..i],
        None => &g[..],
    };
    g.iter()
        .any(|id| elements.iter().all(|e| is_element_in_group(e, id)))
}

/// `enableActionGroup` (the action's predicate).
pub fn can_group(elements: &[Element], a: &AppState) -> bool {
    let selected =
        get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default());
    selected.len() >= 2
        && !all_elements_in_same_group(&selected, a.editing_group_id.as_deref())
        && !frame_and_children_selected_together(&selected)
}

/// `actionGroup`: the selection (frames winning over their children) into a
/// new group below the edited one, moved up to its topmost member.
pub fn action_group(elements: &[Element], a: &AppState) -> ActionResult {
    if !can_group(elements, a) {
        return ActionResult::none();
    }
    let sel = get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            ..Default::default()
        },
    );
    // getRootElements
    let frames: FxHashSet<&str> = sel
        .iter()
        .filter(|e| e.is_frame_like())
        .map(|e| e.id.as_str())
        .collect();
    let selected: Vec<&Element> = sel
        .iter()
        .filter(|e| {
            frames.contains(e.id.as_str())
                || e.frame_id.as_deref().is_none_or(|f| !frames.contains(f))
        })
        .copied()
        .collect();
    let unchanged = || {
        ActionResult::new(
            Some(elements.to_vec()),
            Some(a.clone()),
            CaptureUpdateAction::Eventually,
        )
    };
    if selected.len() < 2 {
        return unchanged();
    }
    // everything's in the one selected group already
    if let [g] = get_selected_group_ids(&a.selected_group_ids).as_slice() {
        let in_group: FxHashSet<&str> = get_elements_in_group(elements, g)
            .iter()
            .map(|e| e.id.as_str())
            .collect();
        if selected.iter().all(|e| in_group.contains(e.id.as_str())) {
            return unchanged();
        }
    }
    let ids: FxHashSet<String> = selected.iter().map(|e| e.id.clone()).collect();
    let mut next = elements.to_vec();
    // grouping across frames takes the framed ones out of their frames
    if selected
        .iter()
        .map(|e| e.frame_id.as_deref())
        .collect::<FxHashSet<_>>()
        .len()
        > 1
    {
        let framed: Vec<String> = selected
            .iter()
            .filter(|e| e.frame_id.is_some())
            .map(|e| e.id.clone())
            .collect();
        remove_elements_from_frame(&framed, &mut next);
    }
    let new_group = random_id();
    for e in next.iter_mut().filter(|e| ids.contains(&e.id)) {
        *e = new_element_with(
            e,
            |n| n.group_ids = add_to_group(&n.group_ids, &new_group, a.editing_group_id.as_deref()),
            false,
        );
    }
    // keep the order within the group, at the topmost member's place
    let last = next
        .iter()
        .rposition(|e| is_element_in_group(e, &new_group))
        .unwrap();
    let (mut before, mut group, after) = (vec![], vec![], next.split_off(last + 1));
    for e in next {
        if is_element_in_group(&e, &new_group) {
            group.push(e)
        } else {
            before.push(e)
        }
    }
    let moved: FxHashSet<String> = group.iter().map(|e| e.id.clone()).collect();
    before.append(&mut group);
    before.extend(after);
    sync_moved_indices(&mut before, &moved);
    let mut app = a.clone();
    let s = GroupSelection {
        selected_group_ids: BTreeMap::new(),
        ..GroupSelection::of(a)
    };
    select_group(&new_group, &s, &before).apply(&mut app);
    ActionResult::new(Some(before), Some(app), CaptureUpdateAction::Immediately)
}

/// `actionUngroup`'s predicate.
pub fn can_ungroup(a: &AppState) -> bool {
    !get_selected_group_ids(&a.selected_group_ids).is_empty()
}

/// `actionUngroup`: the selected groups dissolve; frames re-take what's in
/// them. Bound text leaves the selection.
pub fn action_ungroup(elements: &[Element], a: &AppState) -> ActionResult {
    if !can_ungroup(a) {
        return ActionResult::new(
            Some(elements.to_vec()),
            Some(a.clone()),
            CaptureUpdateAction::Eventually,
        );
    }
    let mut bound_text: FxHashSet<String> = FxHashSet::default();
    let mut next: Vec<Element> = elements
        .iter()
        .map(|e| {
            if e.is_bound_to_container() {
                bound_text.insert(e.id.clone());
            }
            let g = remove_from_selected_groups(&e.group_ids, &a.selected_group_ids);
            if g.len() == e.group_ids.len() {
                e.clone()
            } else {
                new_element_with(e, |n| n.group_ids = g, false)
            }
        })
        .collect();
    let mut s = select_groups_for_selected_elements(
        &a.selected_element_ids,
        a.editing_group_id.as_deref(),
        &next,
    );
    let frame_ids: FxHashSet<String> =
        get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default())
            .iter()
            .filter_map(|e| e.frame_id.clone())
            .collect();
    let frames: Vec<Element> = elements
        .iter()
        .filter(|e| e.is_frame_like() && frame_ids.contains(&e.id))
        .cloned()
        .collect();
    let map = crate::board::utils::array_to_map(elements);
    for frame in frames {
        let inside: Vec<String> =
            get_elements_in_resizing_frame(&next, &frame, &GroupSelection::of(a), &map)
                .iter()
                .map(|e| e.id.clone())
                .collect();
        replace_all_elements_in_frame(&mut next, &inside, &frame.id);
    }
    s.selected_element_ids.retain(|id| !bound_text.contains(id));
    let mut app = a.clone();
    s.apply(&mut app);
    ActionResult::new(Some(next), Some(app), CaptureUpdateAction::Immediately)
}
