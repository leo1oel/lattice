// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionDuplicateSelection.tsx`
//! @ 3a317b5: duplicates the selection (with bound text, frame children and
//! whole selected groups) next to the originals, offset by half a grid cell,
//! and selects the duplicates.
//!
//! Left to the app: duplicating the selected points while a line is being
//! edited (the linear editor's; this returns no change then), not acting
//! mid-drag, and advancing list markers after the commit
//! (`list_marker::advance_duplicated_list_markers`, needs the measurer).

use super::ActionResult;
use crate::board::app_state::AppState;
use crate::board::binding::BindingHooks;
use crate::board::consts::DEFAULT_GRID_SIZE;
use crate::board::duplicate::{DuplicateMode, duplicate_elements};
use crate::board::fractional_index::sync_moved_indices;
use crate::board::history::CaptureUpdateAction;
use crate::board::selection::{
    SelectedOpts, get_selected_elements, get_selection_state_for_elements,
};
use crate::board::types::Element;
use rustc_hash::FxHashSet;

/// `actionDuplicateSelection` (Cmd+D).
pub fn action_duplicate_selection(
    elements: &[Element],
    a: &AppState,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    if a.selected_linear_element
        .as_ref()
        .is_some_and(|s| s.is_editing)
    {
        return ActionResult::none();
    }
    let ids: FxHashSet<String> = get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            include_elements_in_frames: true,
        },
    )
    .into_iter()
    .map(|e| e.id.clone())
    .collect();
    let mode = DuplicateMode::InPlace {
        ids: &ids,
        editing_group_id: a.editing_group_id.as_deref(),
        selected_group_ids: &a.selected_group_ids,
    };
    let mut overrides =
        |d: &mut Element, o: &Element, o2d: &rustc_hash::FxHashMap<String, String>| {
            d.x = o.x + DEFAULT_GRID_SIZE / 2.;
            d.y = o.y + DEFAULT_GRID_SIZE / 2.;
            d.frame_id = o.frame_id.as_ref().map(|f| o2d.get(f).unwrap_or(f).clone());
        };
    let dup = duplicate_elements(elements, mode, true, Some(&mut overrides), hooks);
    let mut next = dup.elements_with_duplicates;
    let moved: FxHashSet<String> = dup
        .duplicated_elements
        .iter()
        .map(|e| e.id.clone())
        .collect();
    sync_moved_indices(&mut next, &moved);
    let targets: Vec<&Element> = next.iter().filter(|e| moved.contains(&e.id)).collect();
    // in the order they were made, as upstream passes them
    let order: Vec<&Element> = dup
        .duplicated_elements
        .iter()
        .filter_map(|d| targets.iter().find(|t| t.id == d.id).copied())
        .collect();
    let mut app = a.clone();
    get_selection_state_for_elements(&order, &next, a, false).apply(&mut app);
    ActionResult::new(Some(next), Some(app), CaptureUpdateAction::Immediately)
}
